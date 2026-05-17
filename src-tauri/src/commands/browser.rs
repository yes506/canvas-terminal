//! Browser-drawer Tauri commands. Implements the 9-method `BrowserCommands`
//! IPC surface designed in Phase 3 / refined in Phase 5 Round-1.
//!
//! Cross-reference (Phase-3 Round-2 G3): if you change the ALLOW / FILTER /
//! DENY matrix in `validate_browser_url`, ALSO update
//! `src/lib/urlScheme.ts::classifyScheme`.

use tauri::webview::{PageLoadEvent, WebviewBuilder};
use tauri::{AppHandle, Emitter, Manager, WebviewUrl};

use crate::state::{BrowserWebviewState, FinalizeOutcome, Rect};

const BROWSER_LABEL: &str = "browser";
const MAIN_WINDOW_LABEL: &str = "main";

/// macOS title bar offset compensation.
///
/// With `decorations: true` + `macos-private-api` + `transparent: true`,
/// Tauri 2's `Window::add_child` and `Webview::set_bounds` interpret `y=0`
/// as the window's OUTER frame top (including title bar), while the
/// frontend's `getBoundingClientRect().top` returns 0 as the viewport top
/// (BELOW the title bar). The delta is the title bar height.
///
/// We prefer the dynamic `outer_size − inner_size` height delta because it
/// reflects the real chrome (Stage Manager, fullscreen, custom title bar
/// modes). On `macos-private-api` the content view extends to the outer
/// frame top, which collapses both that delta AND `inner_position −
/// outer_position` to zero — so on macOS we fall back to a hardcoded
/// standard title bar height (28pt) when the dynamic value is 0.
fn compute_macos_titlebar_offset<R: tauri::Runtime>(window: &tauri::Window<R>) -> f64 {
    let scale = window.scale_factor().unwrap_or(1.0);
    let outer_pos = window.outer_position().ok();
    let inner_pos = window.inner_position().ok();
    let outer_sz = window.outer_size().ok();
    let inner_sz = window.inner_size().ok();

    let pos_delta = match (outer_pos, inner_pos) {
        (Some(o), Some(i)) => ((i.y - o.y) as f64) / scale,
        _ => 0.0,
    };
    let size_delta = match (outer_sz, inner_sz) {
        (Some(o), Some(i)) => ((o.height as f64 - i.height as f64).max(0.0)) / scale,
        _ => 0.0,
    };

    // Prefer the larger of the two (more conservative — pushes the webview
    // farther down so chrome stays visible). On macos-private-api both will
    // typically be 0; fall back to the standard title bar height (28pt).
    let dynamic = pos_delta.max(size_delta);
    let resolved = if cfg!(target_os = "macos") && dynamic <= 0.5 {
        28.0
    } else {
        dynamic
    };

    eprintln!(
        "[browser] titlebar_offset: pos_delta={:.2} size_delta={:.2} scale={:.2} resolved={:.2}",
        pos_delta, size_delta, scale, resolved,
    );
    resolved
}

// ---------------------------------------------------------------------------
// URL validation (defense-in-depth mirror of src/lib/urlScheme.ts)
// ---------------------------------------------------------------------------

/// Classify a URL string per the Phase-1 Q5 policy. Returns the parsed URL on
/// ALLOW; an `Err` with a labelled reason on FILTER/DENY/parse-failure.
///
/// **Cross-reference requirement:** if you change this matrix, ALSO update
/// `src/lib/urlScheme.ts::classifyScheme`. Phase 6 validation includes a
/// manual cross-matrix check.
///
/// Asymmetry note (impl-review @claude3 J2): the TS-side `classifyScheme`
/// has a permissive scheme-less fallback that normalizes `example.com` to
/// `https://example.com` before crossing IPC. This Rust validator therefore
/// only ever sees fully-qualified URLs from the navigate path; the
/// `on_navigation` callback (where this is also called) sees URLs as the
/// engine reports them, which always have a scheme. No fallback here.
pub fn validate_browser_url(input: &str) -> Result<tauri::Url, String> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return Err("filter: empty input".to_string());
    }

    let lower = trimmed.to_lowercase();
    // Filter dangerous schemes BEFORE parse, so a parser-quirk can't smuggle them.
    for filtered in [
        "javascript:",
        "data:",
        "tauri:",
        "tauri-localhost:",
        "vbscript:",
    ] {
        if lower.starts_with(filtered) {
            return Err(format!(
                "filter: {} URLs blocked",
                filtered.trim_end_matches(':')
            ));
        }
    }
    if lower.starts_with("file:") {
        return Err("deny: file: URLs disabled in v1".to_string());
    }
    if lower == "about:blank" {
        return tauri::Url::parse("about:blank")
            .map_err(|e| format!("filter: cannot parse about:blank: {}", e));
    }

    let parsed = tauri::Url::parse(trimmed)
        .map_err(|e| format!("filter: cannot parse URL: {}", e))?;

    match parsed.scheme() {
        "http" | "https" => Ok(parsed),
        other => Err(format!("filter: scheme {:?} not allowed", other)),
    }
}

// ---------------------------------------------------------------------------
// Helper event payloads
// ---------------------------------------------------------------------------

#[derive(Clone, serde::Serialize)]
struct BrowserUrlEventPayload {
    url: String,
}

#[derive(Clone, serde::Serialize)]
struct BrowserTitleChangedPayload {
    title: String,
}

#[derive(Clone, serde::Serialize)]
struct BrowserErrorPayload {
    url: String,
    reason: String,
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// Create the singleton browser child webview overlaid on the main window's
/// DOM rect. Phase-3 node #25. Uses slot-reservation (BrowserSlot::Creating)
/// to close the create-race TOCTOU.
#[tauri::command]
pub fn create_browser_webview(
    url: String,
    rect: Rect,
    state: tauri::State<'_, BrowserWebviewState<tauri::Wry>>,
    app: AppHandle<tauri::Wry>,
) -> Result<(), String> {
    // 1. Validate URL FIRST (defense-in-depth alongside frontend classifyScheme).
    let parsed = validate_browser_url(&url)?;

    // 2. Reserve the slot (Empty → Creating). Drop-guard rolls back on failure.
    let guard = state.try_reserve_for_create()?;

    // 3. Build the webview OUTSIDE the slot lock. The `unstable` feature gate
    //    is required for `Window::add_child`; see Cargo.toml.
    let main_window = app
        .get_window(MAIN_WINDOW_LABEL)
        .ok_or_else(|| format!("main window not found (label '{}')", MAIN_WINDOW_LABEL))?;

    // Apply macOS title-bar offset compensation (codex3 R5-UX diagnosis):
    // `Window::add_child` positions relative to the outer window frame on
    // macOS with decorations + macos-private-api; the rect we got from
    // `getBoundingClientRect()` is relative to the viewport (below the
    // title bar). Add the inner-outer Y delta to align them.
    let titlebar_offset = compute_macos_titlebar_offset(&main_window);
    let adjusted_y = rect.y + titlebar_offset;

    let app_for_loaded = app.clone();
    let app_for_title = app.clone();
    let app_for_nav = app.clone();

    let builder: WebviewBuilder<tauri::Wry> =
        WebviewBuilder::new(BROWSER_LABEL, WebviewUrl::External(parsed))
            // Capability isolation layer (b): NO initialization_script call —
            // the browser child gets no preload script.
            .on_page_load(move |_webview, payload| {
                let event_name = match payload.event() {
                    PageLoadEvent::Started => "browser-loading",
                    PageLoadEvent::Finished => "browser-loaded",
                };
                let _ = app_for_loaded.emit(
                    event_name,
                    BrowserUrlEventPayload {
                        url: payload.url().to_string(),
                    },
                );
            })
            .on_document_title_changed(move |_webview, title| {
                let _ = app_for_title.emit(
                    "browser-title-changed",
                    BrowserTitleChangedPayload { title },
                );
            })
            .on_navigation(move |nav_url| {
                // Defense-in-depth: re-validate every navigation, not just the
                // initial URL. Block if Rust policy rejects.
                match validate_browser_url(nav_url.as_str()) {
                    Ok(_) => true,
                    Err(reason) => {
                        let _ = app_for_nav.emit(
                            "browser-error",
                            BrowserErrorPayload {
                                url: nav_url.to_string(),
                                reason,
                            },
                        );
                        false
                    }
                }
            });

    let webview = main_window
        .add_child(
            builder,
            tauri::LogicalPosition::new(rect.x, adjusted_y),
            tauri::LogicalSize::new(rect.width, rect.height),
        )
        .map_err(|e| format!("Window::add_child failed: {}", e))?;

    // 4. Finalize: Creating → Ready(webview) IF still our generation.
    //    If destroy or a newer create has superseded us, close the webview
    //    we just built (impl-review @codex3 high #1 fix).
    match guard.finalize(webview)? {
        FinalizeOutcome::Published => {
            // 5. Seed last_bounds so the first set_bounds dedup is honest.
            if let Ok(mut lb) = state.last_bounds.lock() {
                *lb = Some(rect);
            }
            Ok(())
        }
        FinalizeOutcome::Cancelled(orphan) => {
            let _ = orphan.close();
            // Surface as Err so the frontend can react (rapid close→open
            // path will retry).
            Err("browser webview creation cancelled by destroy".to_string())
        }
    }
}

/// Update the OS-layer webview bounds, with last_bounds dedup.
/// Phase-3 node #26. Lock-order: last_bounds BEFORE slot (no overlap).
#[tauri::command]
pub fn set_browser_webview_bounds(
    rect: Rect,
    state: tauri::State<'_, BrowserWebviewState<tauri::Wry>>,
    app: AppHandle<tauri::Wry>,
) -> Result<(), String> {
    // Dedup check (lock #1: last_bounds).
    {
        let lb = state
            .last_bounds
            .lock()
            .map_err(|e| format!("last_bounds lock poisoned: {}", e))?;
        if *lb == Some(rect) {
            return Ok(());
        }
    }

    let webview = state
        .clone_webview()
        .ok_or_else(|| "browser webview not created".to_string())?;

    // Apply the same macOS title-bar offset as create_browser_webview so
    // the webview stays under the chrome rather than drifting up.
    let main_window = app
        .get_window(MAIN_WINDOW_LABEL)
        .ok_or_else(|| format!("main window not found (label '{}')", MAIN_WINDOW_LABEL))?;
    let titlebar_offset = compute_macos_titlebar_offset(&main_window);
    let adjusted = Rect {
        x: rect.x,
        y: rect.y + titlebar_offset,
        width: rect.width,
        height: rect.height,
    };

    webview
        .set_bounds(adjusted.to_dpi_rect())
        .map_err(|e| format!("set_bounds failed: {}", e))?;

    // Update the dedup cache with the ORIGINAL (unadjusted) rect — the
    // frontend sends and compares against unadjusted coords.
    if let Ok(mut lb) = state.last_bounds.lock() {
        *lb = Some(rect);
    }
    Ok(())
}

/// Navigate the browser webview. Re-validates Rust-side (defense-in-depth).
/// Phase-3 node #27.
#[tauri::command]
pub fn navigate_browser(
    url: String,
    state: tauri::State<'_, BrowserWebviewState<tauri::Wry>>,
) -> Result<(), String> {
    let parsed = validate_browser_url(&url)?;
    let webview = state
        .clone_webview()
        .ok_or_else(|| "browser webview not created".to_string())?;
    webview
        .navigate(parsed)
        .map_err(|e| format!("navigate failed: {}", e))
}

#[tauri::command]
pub fn browser_go_back(
    state: tauri::State<'_, BrowserWebviewState<tauri::Wry>>,
) -> Result<(), String> {
    let webview = state
        .clone_webview()
        .ok_or_else(|| "browser webview not created".to_string())?;
    webview
        .eval("window.history.back()")
        .map_err(|e| format!("eval back failed: {}", e))
}

#[tauri::command]
pub fn browser_go_forward(
    state: tauri::State<'_, BrowserWebviewState<tauri::Wry>>,
) -> Result<(), String> {
    let webview = state
        .clone_webview()
        .ok_or_else(|| "browser webview not created".to_string())?;
    webview
        .eval("window.history.forward()")
        .map_err(|e| format!("eval forward failed: {}", e))
}

#[tauri::command]
pub fn browser_reload(
    state: tauri::State<'_, BrowserWebviewState<tauri::Wry>>,
) -> Result<(), String> {
    let webview = state
        .clone_webview()
        .ok_or_else(|| "browser webview not created".to_string())?;
    webview
        .reload()
        .map_err(|e| format!("reload failed: {}", e))
}

#[tauri::command]
pub fn browser_stop(
    state: tauri::State<'_, BrowserWebviewState<tauri::Wry>>,
) -> Result<(), String> {
    let webview = state
        .clone_webview()
        .ok_or_else(|| "browser webview not created".to_string())?;
    webview
        .eval("window.stop()")
        .map_err(|e| format!("eval stop failed: {}", e))
}

/// Tauri command wrapper for destroy. Delegates to the impl helper so the
/// same logic is callable from `RunEvent::Exit` per Phase-2 L3.
#[tauri::command]
pub fn destroy_browser_webview(
    state: tauri::State<'_, BrowserWebviewState<tauri::Wry>>,
) -> Result<(), String> {
    destroy_browser_webview_impl(&state)
}

/// Pure-Rust destroy helper. Called from both the IPC command (#32) and
/// `lib.rs::run()`'s `RunEvent::Exit` handler (#41). Takes the webview via
/// `take_webview` (#36b) — the slot ends `Empty`. Idempotent: calling on
/// Empty is a no-op Ok.
pub fn destroy_browser_webview_impl(
    state: &BrowserWebviewState<tauri::Wry>,
) -> Result<(), String> {
    let webview = match state.take_webview() {
        Some(w) => w,
        None => return Ok(()),
    };
    if let Ok(mut lb) = state.last_bounds.lock() {
        *lb = None;
    }
    webview
        .close()
        .map_err(|e| format!("Webview::close failed: {}", e))
}

// ---------------------------------------------------------------------------
// Unit tests for validate_browser_url
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allow_http_https_about_blank() {
        assert!(validate_browser_url("http://example.com").is_ok());
        assert!(validate_browser_url("https://example.com/path?q=1").is_ok());
        assert!(validate_browser_url("about:blank").is_ok());
        assert!(validate_browser_url("  https://example.com  ").is_ok());
        assert!(validate_browser_url("HTTPS://EXAMPLE.COM").is_ok());
    }

    #[test]
    fn filter_dangerous_schemes() {
        assert!(validate_browser_url("javascript:alert(1)")
            .unwrap_err()
            .starts_with("filter:"));
        assert!(validate_browser_url("data:text/html,hello")
            .unwrap_err()
            .starts_with("filter:"));
        assert!(validate_browser_url("tauri://internal")
            .unwrap_err()
            .starts_with("filter:"));
        assert!(validate_browser_url("tauri-localhost://x")
            .unwrap_err()
            .starts_with("filter:"));
    }

    #[test]
    fn deny_file_scheme() {
        assert!(validate_browser_url("file:///etc/passwd")
            .unwrap_err()
            .starts_with("deny:"));
    }

    #[test]
    fn reject_empty_and_unknown_schemes() {
        assert!(validate_browser_url("").unwrap_err().contains("empty"));
        assert!(validate_browser_url("   ").unwrap_err().contains("empty"));
        assert!(validate_browser_url("ftp://example.com")
            .unwrap_err()
            .starts_with("filter:"));
    }
}
