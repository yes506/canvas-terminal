//! Browser-drawer Tauri commands — per-tab IPC surface for the
//! browser-tabs cycle. Implements the 9 per-tab commands from plan.md.
//!
//! Cross-reference (Phase-3 Round-2 G3): if you change the ALLOW / FILTER /
//! DENY matrix in `validate_browser_url`, ALSO update
//! `src/lib/urlScheme.ts::classifyScheme`.
//!
//! Per-tab event surface (replaces the prior singleton events):
//! - `browser-tab-loading`        { tabId, url }
//! - `browser-tab-loaded`         { tabId, url }
//! - `browser-tab-title-changed`  { tabId, title }
//! - `browser-tab-error`          { tabId, url, reason }

use tauri::webview::{PageLoadEvent, WebviewBuilder};
use tauri::{AppHandle, Emitter, Manager, WebviewUrl};

use crate::state::{BrowserTabsState, FinalizeOutcome, Rect, TabId};

const MAIN_WINDOW_LABEL: &str = "main";

/// Off-screen y-coordinate used when `set_browser_tab_bounds` is called
/// with `visible: false`. Far enough out that the webview is invisible
/// without WebKit pausing the page (zero-sized bounds can throttle the
/// render loop). Inactive tabs keep running so users don't lose page
/// state on tab switch (Chrome-like behaviour).
const HIDDEN_TAB_Y: f64 = -99999.0;

/// B1 fix — route `target="_blank"` / `window.open` / `form target="_blank"`
/// requests to the SAME webview's navigation instead of letting WebKit
/// emit a new-window request that no handler is subscribed to (silent
/// no-op on sites like NAVER that wrap every link in `target="_blank"`).
///
/// Capability isolation note: this script does NOT touch `__TAURI__`
/// or any IPC bridge — it's a pure DOM behavior patch. The prior cycle's
/// "no initialization_script" stance was about avoiding IPC injection
/// into the browser child; this script preserves that property.
///
/// Per the plan.md B1 scope clarification, routing new-window requests
/// to the active tab's navigate is in-scope; spawning a fresh in-app
/// tab from `target="_blank"` is out of scope.
const NEW_WINDOW_INTERCEPTOR: &str = r#"
(function () {
  // Route any new-window request to the SAME webview by mutating
  // window.location.href. Try/catch guards against pages that have
  // already locked window.location with a getter.
  var route = function (url) {
    if (typeof url !== 'string' || !url) return;
    try { window.location.href = url; } catch (e) {}
  };

  // 1. window.open(url, ...) — always route, return null so caller code
  //    that checks the return value doesn't proceed with a phantom window.
  try {
    Object.defineProperty(window, 'open', {
      configurable: true,
      writable: true,
      value: function (url) { route(url); return null; }
    });
  } catch (e) {}

  // 2. <a target="_blank"> — intercept at the capture phase so site
  //    handlers don't preventDefault before us.
  document.addEventListener('click', function (e) {
    var t = e.target;
    if (!t || !t.closest) return;
    var a = t.closest('a[target="_blank"], a[target="_new"]');
    if (a && a.href) {
      e.preventDefault();
      e.stopPropagation();
      route(a.href);
    }
  }, true);

  // 3. <form target="_blank"> — strip the target so the form submits
  //    in the same webview.
  document.addEventListener('submit', function (e) {
    var f = e.target;
    if (f && (f.target === '_blank' || f.target === '_new')) {
      f.target = '_self';
    }
  }, true);
})();
"#;

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

    let dynamic = pos_delta.max(size_delta);
    let resolved = if cfg!(target_os = "macos") && dynamic <= 0.5 {
        28.0
    } else {
        dynamic
    };

    resolved
}

// ---------------------------------------------------------------------------
// URL validation (defense-in-depth mirror of src/lib/urlScheme.ts)
// ---------------------------------------------------------------------------

/// Classify a URL string per the Phase-1 Q5 policy. Returns the parsed URL on
/// ALLOW; an `Err` with a labelled reason on FILTER/DENY/parse-failure.
pub fn validate_browser_url(input: &str) -> Result<tauri::Url, String> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return Err("filter: empty input".to_string());
    }

    let lower = trimmed.to_lowercase();
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
// Event payloads — every per-tab event carries `tabId` so frontend
// subscribers can route to the matching Tab in the BrowserStore tabs slice.
// ---------------------------------------------------------------------------

#[derive(Clone, serde::Serialize)]
struct BrowserTabUrlPayload {
    #[serde(rename = "tabId")]
    tab_id: String,
    url: String,
}

#[derive(Clone, serde::Serialize)]
struct BrowserTabTitlePayload {
    #[serde(rename = "tabId")]
    tab_id: String,
    title: String,
}

#[derive(Clone, serde::Serialize)]
struct BrowserTabErrorPayload {
    #[serde(rename = "tabId")]
    tab_id: String,
    url: String,
    reason: String,
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// Create a child webview for `tab_id` overlaid at `rect`. The webview's
/// label is `browser-tab-<tab_id>` (deterministic from `BrowserTabsState::label_for`).
/// Slot reservation closes the create-race TOCTOU; an in-flight destroy
/// supersedes via generation tracking.
#[tauri::command]
pub fn create_browser_tab(
    #[allow(non_snake_case)] tabId: TabId,
    url: String,
    rect: Rect,
    state: tauri::State<'_, BrowserTabsState<tauri::Wry>>,
    app: AppHandle<tauri::Wry>,
) -> Result<(), String> {
    let tab_id = tabId;

    // 1. Validate URL FIRST (defense-in-depth alongside frontend classifyScheme).
    let parsed = validate_browser_url(&url)?;

    // 2. Reserve the slot (Empty → Creating). Drop-guard rolls back on failure.
    let guard = state.try_reserve_for_create(&tab_id)?;

    // 3. Build the webview OUTSIDE the slot lock. The `unstable` feature gate
    //    is required for `Window::add_child`; see Cargo.toml.
    let main_window = app
        .get_window(MAIN_WINDOW_LABEL)
        .ok_or_else(|| format!("main window not found (label '{}')", MAIN_WINDOW_LABEL))?;

    let titlebar_offset = compute_macos_titlebar_offset(&main_window);
    let adjusted_y = rect.y + titlebar_offset;

    let label = BrowserTabsState::<tauri::Wry>::label_for(&tab_id);

    // Capture tab_id for each closure so events carry it through.
    let tab_id_for_page = tab_id.clone();
    let tab_id_for_title = tab_id.clone();
    let tab_id_for_nav = tab_id.clone();
    let app_for_loaded = app.clone();
    let app_for_title = app.clone();
    let app_for_nav = app.clone();

    let builder: WebviewBuilder<tauri::Wry> =
        WebviewBuilder::new(&label, WebviewUrl::External(parsed))
            // B1 fix — DOM-only new-window interceptor. Does NOT touch
            // `__TAURI__` / IPC, so the prior cycle's capability isolation
            // intent (no Tauri bridge in the browser child) holds. See
            // NEW_WINDOW_INTERCEPTOR for rationale + the plan.md B1
            // scope clarification.
            .initialization_script(NEW_WINDOW_INTERCEPTOR)
            .on_page_load(move |_webview, payload| {
                let event_name = match payload.event() {
                    PageLoadEvent::Started => "browser-tab-loading",
                    PageLoadEvent::Finished => "browser-tab-loaded",
                };
                let _ = app_for_loaded.emit(
                    event_name,
                    BrowserTabUrlPayload {
                        tab_id: tab_id_for_page.clone(),
                        url: payload.url().to_string(),
                    },
                );
            })
            .on_document_title_changed(move |_webview, title| {
                let _ = app_for_title.emit(
                    "browser-tab-title-changed",
                    BrowserTabTitlePayload {
                        tab_id: tab_id_for_title.clone(),
                        title,
                    },
                );
            })
            .on_navigation(move |nav_url| {
                // B1 diagnostic logging — gated behind debug_assertions so it
                // doesn't leak into release. Per plan.md, B1 root cause is
                // TBD until user reproduction with Wikipedia + GitHub targets;
                // this log surfaces every nav_url WebKit/WRY delivers so the
                // first repro identifies which hypothesis applies.
                #[cfg(debug_assertions)]
                eprintln!(
                    "[browser-tab {}] on_navigation: nav_url='{}'",
                    tab_id_for_nav, nav_url
                );

                match validate_browser_url(nav_url.as_str()) {
                    Ok(_) => true,
                    Err(reason) => {
                        #[cfg(debug_assertions)]
                        eprintln!(
                            "[browser-tab {}] on_navigation REJECTED: {} reason='{}'",
                            tab_id_for_nav, nav_url, reason
                        );
                        let _ = app_for_nav.emit(
                            "browser-tab-error",
                            BrowserTabErrorPayload {
                                tab_id: tab_id_for_nav.clone(),
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
    match guard.finalize(webview)? {
        FinalizeOutcome::Published => {
            // 5. Seed last_bounds so the first set_bounds dedup is honest.
            if let Ok(mut lb) = state.last_bounds.lock() {
                lb.insert(tab_id.clone(), rect);
            }
            Ok(())
        }
        FinalizeOutcome::Cancelled(orphan) => {
            let _ = orphan.close();
            Err(format!(
                "browser tab '{}' creation cancelled by destroy",
                tab_id
            ))
        }
    }
}

/// Update an existing tab's OS-layer webview bounds, with per-tab dedup.
/// When `visible` is `false`, the webview is positioned off-screen via
/// `HIDDEN_TAB_Y` (page keeps running — inactive tabs preserve state).
#[tauri::command]
pub fn set_browser_tab_bounds(
    #[allow(non_snake_case)] tabId: TabId,
    rect: Rect,
    visible: bool,
    state: tauri::State<'_, BrowserTabsState<tauri::Wry>>,
    app: AppHandle<tauri::Wry>,
) -> Result<(), String> {
    let tab_id = tabId;

    // The "effective" rect we send to the OS layer: same width/height,
    // but y is replaced with HIDDEN_TAB_Y when visible=false.
    let effective = if visible {
        rect
    } else {
        Rect {
            x: rect.x,
            y: HIDDEN_TAB_Y,
            width: rect.width,
            height: rect.height,
        }
    };

    // Per-tab dedup (lock #1: last_bounds).
    {
        let lb = state
            .last_bounds
            .lock()
            .map_err(|e| format!("last_bounds lock poisoned: {}", e))?;
        if lb.get(&tab_id) == Some(&effective) {
            return Ok(());
        }
    }

    let webview = state
        .clone_tab(&tab_id)
        .ok_or_else(|| format!("browser tab '{}' not created", tab_id))?;

    let main_window = app
        .get_window(MAIN_WINDOW_LABEL)
        .ok_or_else(|| format!("main window not found (label '{}')", MAIN_WINDOW_LABEL))?;
    let titlebar_offset = compute_macos_titlebar_offset(&main_window);

    let positioned = Rect {
        x: effective.x,
        y: effective.y + titlebar_offset,
        width: effective.width,
        height: effective.height,
    };

    webview
        .set_bounds(positioned.to_dpi_rect())
        .map_err(|e| format!("set_bounds failed: {}", e))?;

    // Lock-error asymmetry note (claude3 C): the read-side dedup lock
    // above propagates poison via `?` so callers see a hard error; the
    // write-side lock below is intentionally lenient with `if let Ok`.
    // Rationale: the OS-level `set_bounds` already succeeded; failing to
    // update the dedup cache only costs one redundant IPC on the next
    // tick. Propagating a write-side Err here would surface a phantom
    // failure for an operation that actually completed.
    if let Ok(mut lb) = state.last_bounds.lock() {
        lb.insert(tab_id, effective);
    }
    Ok(())
}

#[tauri::command]
pub fn navigate_browser_tab(
    #[allow(non_snake_case)] tabId: TabId,
    url: String,
    state: tauri::State<'_, BrowserTabsState<tauri::Wry>>,
) -> Result<(), String> {
    let parsed = validate_browser_url(&url)?;
    let webview = state
        .clone_tab(&tabId)
        .ok_or_else(|| format!("browser tab '{}' not created", tabId))?;
    webview
        .navigate(parsed)
        .map_err(|e| format!("navigate failed: {}", e))
}

#[tauri::command]
pub fn browser_tab_go_back(
    #[allow(non_snake_case)] tabId: TabId,
    state: tauri::State<'_, BrowserTabsState<tauri::Wry>>,
) -> Result<(), String> {
    let webview = state
        .clone_tab(&tabId)
        .ok_or_else(|| format!("browser tab '{}' not created", tabId))?;
    webview
        .eval("window.history.back()")
        .map_err(|e| format!("eval back failed: {}", e))
}

#[tauri::command]
pub fn browser_tab_go_forward(
    #[allow(non_snake_case)] tabId: TabId,
    state: tauri::State<'_, BrowserTabsState<tauri::Wry>>,
) -> Result<(), String> {
    let webview = state
        .clone_tab(&tabId)
        .ok_or_else(|| format!("browser tab '{}' not created", tabId))?;
    webview
        .eval("window.history.forward()")
        .map_err(|e| format!("eval forward failed: {}", e))
}

#[tauri::command]
pub fn browser_tab_reload(
    #[allow(non_snake_case)] tabId: TabId,
    state: tauri::State<'_, BrowserTabsState<tauri::Wry>>,
) -> Result<(), String> {
    let webview = state
        .clone_tab(&tabId)
        .ok_or_else(|| format!("browser tab '{}' not created", tabId))?;
    webview
        .reload()
        .map_err(|e| format!("reload failed: {}", e))
}

#[tauri::command]
pub fn browser_tab_stop(
    #[allow(non_snake_case)] tabId: TabId,
    state: tauri::State<'_, BrowserTabsState<tauri::Wry>>,
) -> Result<(), String> {
    let webview = state
        .clone_tab(&tabId)
        .ok_or_else(|| format!("browser tab '{}' not created", tabId))?;
    webview
        .eval("window.stop()")
        .map_err(|e| format!("eval stop failed: {}", e))
}

#[tauri::command]
pub fn destroy_browser_tab(
    #[allow(non_snake_case)] tabId: TabId,
    state: tauri::State<'_, BrowserTabsState<tauri::Wry>>,
) -> Result<(), String> {
    destroy_browser_tab_impl(&tabId, &state)
}

/// Pure-Rust destroy helper for a single tab. Idempotent: calling on a
/// missing/Empty slot is a no-op `Ok`.
pub fn destroy_browser_tab_impl(
    tab_id: &str,
    state: &BrowserTabsState<tauri::Wry>,
) -> Result<(), String> {
    let webview = match state.take_tab(tab_id) {
        Some(w) => w,
        None => return Ok(()),
    };
    if let Ok(mut lb) = state.last_bounds.lock() {
        lb.remove(tab_id);
    }
    webview
        .close()
        .map_err(|e| format!("Webview::close failed: {}", e))
}

#[tauri::command]
pub fn destroy_all_browser_tabs(
    state: tauri::State<'_, BrowserTabsState<tauri::Wry>>,
) -> Result<(), String> {
    destroy_all_browser_tabs_impl(&state)
}

/// Pure-Rust destroy-all helper. Called from the IPC command and from
/// `lib.rs::run()`'s `RunEvent::Exit` handler.
pub fn destroy_all_browser_tabs_impl(
    state: &BrowserTabsState<tauri::Wry>,
) -> Result<(), String> {
    for webview in state.take_all_tabs() {
        let _ = webview.close();
    }
    Ok(())
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
