//! Native window capture for the "Capture Full Window" button.
//!
//! Replaces the prior html2canvas DOM-clone path, which could not see
//! Tauri's native child webviews (the browser drawer captured as a black
//! rectangle) and exposed HTML that the OS compositor normally occludes
//! (the "tab strip collision" the user reported). Both symptoms share
//! one root cause: html2canvas walks the DOM, but the webview's pixels
//! live in the compositor — not in the DOM — so a Quartz framebuffer
//! capture is the only path that sees what's actually on screen.
//!
//! macOS-only in v1. Non-macOS platforms get a stub that returns an
//! informative error so the crate stays compilable on Linux/Windows CI.

use serde::Serialize;

// Local duplicate of `browser.rs::MAIN_WINDOW_LABEL` (which is module-private
// at the time of writing). Promoting that constant to `pub(crate)` and
// `use`-importing here would touch a file this fix doesn't otherwise need
// to edit; we duplicate the one-line constant instead and leave the
// centralization for a separate cleanup once a third caller appears (the
// rule-of-three threshold).
const MAIN_WINDOW_LABEL: &str = "main";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CapturePayload {
    /// PNG bytes, base64-encoded for IPC transit. The frontend forms
    /// `data:image/png;base64,<...>` and hands it to Fabric.
    pub png_base64: String,
    /// Device-pixels-per-CSS-pixel **at capture time** (not at click
    /// time). Returned with the PNG so the frontend's
    /// `addCapturedScreenshotToCanvas` helper can recover the source's
    /// CSS width (`cssWidth = pngWidth / sourceScale`) even if the
    /// user dragged the window between displays with different DPRs
    /// between clicking the button and the framebuffer read.
    pub source_scale: f64,
}

#[tauri::command]
pub fn capture_main_window_png(
    app: tauri::AppHandle,
) -> Result<CapturePayload, String> {
    // The previous signature took `tauri::WebviewWindow` directly. Tauri 2's
    // command-argument injector populates `WebviewWindow` only when the
    // caller's "current webview" satisfies `Window::is_webview_window()`,
    // which is `webviews().iter().all(|w| w.label() == self.label())`. This
    // app attaches browser-drawer child webviews (labels `browser-tab-<id>`)
    // to the main window, so once any tab is open the predicate flips false
    // and the injector errors with "current webview is not a WebviewWindow".
    //
    // The fix is to take `AppHandle` (always injectable) and resolve the
    // main window by label. We deliberately use `get_window` rather than
    // `get_webview_window` — the latter applies the same `is_webview_window`
    // predicate internally and would return `None` under the same
    // multi-webview condition that broke the original injector, just with a
    // different error string. This mirrors the canonical pattern already in
    // commands/browser.rs at the two `get_window(MAIN_WINDOW_LABEL)` sites.
    #[cfg(target_os = "macos")]
    {
        use tauri::Manager;
        let window = app
            .get_window(MAIN_WINDOW_LABEL)
            .ok_or_else(|| format!("main window not found (label '{}')", MAIN_WINDOW_LABEL))?;
        capture_macos(window)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        Err("native window capture is only supported on macOS in v1".into())
    }
}

/// Surfaced to the frontend on permission denial. The prefix is the
/// contract — `DrawingBoard.tsx` matches on `PERMISSION_DENIED:` to
/// route this string into the toast UI instead of the generic error
/// path.
#[cfg(target_os = "macos")]
const PERMISSION_DENIED_MSG: &str = "PERMISSION_DENIED: Screen Recording not granted. \
     Enable in System Settings → Privacy & Security → Screen Recording → Canvas Terminal, \
     then fully quit (Cmd+Q) and relaunch the app.";

// Receives a `tauri::Window` (not `WebviewWindow`). Both expose the
// `.ns_window()` and `.scale_factor()` macOS methods the body needs;
// taking the broader type avoids the `is_webview_window` predicate that
// gates `WebviewWindow` and which fails on this app's multi-webview
// layout (see the explanation on `capture_main_window_png` above).
#[cfg(target_os = "macos")]
fn capture_macos(window: tauri::Window) -> Result<CapturePayload, String> {
    use base64::Engine;
    use core_graphics::access::ScreenCaptureAccess;
    use core_graphics::display::CGRectNull;
    use core_graphics::window::{
        create_image, kCGWindowImageBoundsIgnoreFraming,
        kCGWindowListOptionIncludingWindow,
    };
    use image::{codecs::png::PngEncoder, ExtendedColorType, ImageEncoder};

    // Matches the export_snapshot precedent in commands::canvas. Applied
    // to the *decoded* PNG bytes, not the base64 string (base64 is ~33%
    // larger than the underlying bytes).
    const MAX_BINARY_SIZE: usize = 50 * 1024 * 1024;

    // 1. Permission flow. preflight() returns the current TCC state
    //    without prompting. If false, request() triggers the system
    //    prompt on a user-initiated call; its return value is the
    //    state AFTER any in-process resolution. On macOS the TCC
    //    grant typically doesn't become readable until next process
    //    launch, so a request() that ends false here is the realistic
    //    first-deny outcome.
    let access = ScreenCaptureAccess::default();
    if !access.preflight() && !access.request() {
        return Err(PERMISSION_DENIED_MSG.into());
    }

    // 2. Tauri's NSWindow* → CGWindowID via [NSWindow windowNumber].
    //    The pointer comes from Wry's macOS backend; cast to objc2-app-kit's
    //    NSWindow type. The Cargo.toml pins objc2-app-kit to the same
    //    0.3.x major as the transitive copy Wry pulls in (Cargo.lock
    //    has 0.3.2 already), so the wrapper types interoperate.
    let ns_window_ptr = window
        .ns_window()
        .map_err(|e| format!("ns_window failed: {e}"))?;
    if ns_window_ptr.is_null() {
        return Err("ns_window returned null".into());
    }
    let win_id: u32 = unsafe {
        let ns_window: &objc2_app_kit::NSWindow =
            &*(ns_window_ptr as *const objc2_app_kit::NSWindow);
        ns_window.windowNumber() as u32
    };

    // 3. Capture scale BEFORE the framebuffer read, so a mid-action
    //    multi-display drag is at least reported consistently with
    //    whichever side the window settled on. (Same Tauri API browser.rs
    //    line 108 uses for webview-bounds sync.)
    let source_scale = window.scale_factor().unwrap_or(1.0);

    // 4. Compositor read via the safe wrapper. CGRectNull means "use the
    //    window's actual bounds" (not screen-relative). Including the
    //    window in kCGWindowListOptionIncludingWindow restricts the
    //    composite to just this window. kCGWindowImageBoundsIgnoreFraming
    //    excludes the OS drop shadow.
    //
    //    Implementer note: with `transparent: true` set in tauri.conf.json
    //    the captured rect can be non-obvious; if the resulting screenshot
    //    clips the titlebar, try `kCGWindowImageDefault` instead. This is
    //    the v3 review's R9 / v4 E8 spike point — visible only at
    //    validate-time.
    let cg_image = create_image(
        unsafe { CGRectNull },
        kCGWindowListOptionIncludingWindow,
        win_id,
        kCGWindowImageBoundsIgnoreFraming,
    )
    .ok_or_else(|| "CGWindowListCreateImage returned NULL".to_string())?;

    // 5. CGImage bytes → RGBA. CGWindowListCreateImage on macOS returns
    //    BGRA premultiplied on little-endian (kCGImageAlphaPremultipliedFirst |
    //    kCGBitmapByteOrder32Little). Silently treating those bytes as
    //    RGBA would ship a PNG with red and blue channels swapped — the
    //    image looks plausible until you notice a red logo rendered blue.
    //    We do a manual channel swap rather than trusting an `image`
    //    crate auto-conversion.
    let width = cg_image.width();
    let height = cg_image.height();
    let bytes_per_row = cg_image.bytes_per_row();
    let raw = cg_image.data();
    let raw_bytes: &[u8] = raw.bytes();

    let required = bytes_per_row
        .checked_mul(height)
        .ok_or_else(|| "image stride overflow".to_string())?;
    if raw_bytes.len() < required {
        return Err(format!(
            "CGImage data shorter than expected: {} bytes, expected at least {} for {}×{} (stride={})",
            raw_bytes.len(),
            required,
            width,
            height,
            bytes_per_row
        ));
    }

    let pixel_count = width
        .checked_mul(height)
        .ok_or_else(|| "image dimensions overflow".to_string())?;
    let rgba_len = pixel_count
        .checked_mul(4)
        .ok_or_else(|| "rgba buffer overflow".to_string())?;
    let mut rgba: Vec<u8> = Vec::with_capacity(rgba_len);

    for y in 0..height {
        let row_start = y * bytes_per_row;
        for x in 0..width {
            let p = row_start + x * 4;
            // BGRA → RGBA. Alpha is left as-is (CGWindowListCreateImage
            // typically returns opaque alpha for the captured window).
            let b = raw_bytes[p];
            let g = raw_bytes[p + 1];
            let r = raw_bytes[p + 2];
            let a = raw_bytes[p + 3];
            rgba.push(r);
            rgba.push(g);
            rgba.push(b);
            rgba.push(a);
        }
    }

    // 6. Encode → PNG via the image crate. PngEncoder + ImageEncoder
    //    trait is the standard 0.25 path.
    let mut png_bytes: Vec<u8> = Vec::new();
    PngEncoder::new(&mut png_bytes)
        .write_image(
            &rgba,
            width as u32,
            height as u32,
            ExtendedColorType::Rgba8,
        )
        .map_err(|e| format!("PNG encode failed: {e}"))?;

    // 7. Bound check (mirrors export_snapshot semantics — applied to the
    //    decoded PNG bytes, not the base64).
    if png_bytes.len() > MAX_BINARY_SIZE {
        return Err(format!(
            "Capture too large: {} bytes exceeds {} byte limit",
            png_bytes.len(),
            MAX_BINARY_SIZE
        ));
    }

    // 8. Base64 for IPC.
    let png_base64 = base64::engine::general_purpose::STANDARD.encode(&png_bytes);

    Ok(CapturePayload {
        png_base64,
        source_scale,
    })
}
