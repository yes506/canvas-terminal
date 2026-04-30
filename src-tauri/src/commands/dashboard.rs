//! Tauri commands for the dashboard server.
//!
//! Three surfaces:
//!  - `open_dashboard()` — ensure-start + macOS `open(1)` on the token URL.
//!    Returns ONLY no-token info (`url`, `port`) per v4 §3.3 — the token URL
//!    never crosses the IPC boundary into JS land.
//!  - `get_dashboard_info()` — non-opening helper for the footer status widget.
//!    Also no-token.
//!  - `copy_dashboard_url_with_token()` — the rare-action escape hatch for
//!    the footer's "Copy with token" hover-disclosed button. Explicitly
//!    named so a future contributor can `grep` for token-leak surfaces.

use crate::dashboard::state::{DashboardInfoNoToken, Running};
use crate::dashboard::{server, DashboardInfo};

/// Lazy-binds the dashboard server on first call. Returns the existing Running
/// on subsequent calls. The Mutex ensures concurrent "Open Dashboard" clicks
/// don't race-bind two listeners.
async fn ensure_started(info: &DashboardInfo) -> Result<Running, String> {
    let mut guard = info.running.lock().await;
    if let Some(running) = guard.clone() {
        return Ok(running);
    }
    let running = server::start(info.session_alive.clone()).await?;
    *guard = Some(running.clone());
    Ok(running)
}

/// Open the dashboard URL in the user's default browser via macOS `open(1)`.
///
/// Returns only the no-token URL/port; the token URL is constructed inside
/// this function, passed straight to `open(1)`, and never returned to JS.
///
/// macOS-only: invokes `open(1)`, mirroring `open_external_url`'s pattern.
/// Cross-platform support is a Phase 2 prerequisite if the bundle ever adds
/// Windows/Linux targets — see v3 §3.2.
#[tauri::command]
pub async fn open_dashboard(
    info: tauri::State<'_, DashboardInfo>,
) -> Result<DashboardInfoNoToken, String> {
    let running = ensure_started(&info).await?;
    let token_url = format!("http://127.0.0.1:{}/?t={}", running.port, running.token);
    std::process::Command::new("open")
        .arg(&token_url)
        .spawn()
        .map_err(|e| format!("Failed to open dashboard: {}", e))?;
    Ok(DashboardInfoNoToken {
        url: format!("http://127.0.0.1:{}/", running.port),
        port: running.port,
    })
}

/// Returns the no-token URL/port for in-app surfaces (footer status widget,
/// menu disabled-state checks). Does NOT start the server if it isn't running
/// yet — the caller wants to know "is it running" for display, not "start it".
#[tauri::command]
pub async fn get_dashboard_info(
    info: tauri::State<'_, DashboardInfo>,
) -> Result<Option<DashboardInfoNoToken>, String> {
    let guard = info.running.lock().await;
    Ok(guard.as_ref().map(|r| DashboardInfoNoToken {
        url: format!("http://127.0.0.1:{}/", r.port),
        port: r.port,
    }))
}

/// Rare-action escape hatch for the footer's "Copy with token (rare)" button.
/// Returns the token-bearing URL so the SPA can copy it to clipboard.
///
/// **Token-leak surface:** any JS in the renderer can call this command.
/// Mitigations (rate-limit, Tauri dialog confirmation) are Phase 2 polish —
/// see v4 §3.7 + §6.
#[tauri::command]
pub async fn copy_dashboard_url_with_token(
    info: tauri::State<'_, DashboardInfo>,
) -> Result<String, String> {
    let running = ensure_started(&info).await?;
    Ok(format!(
        "http://127.0.0.1:{}/?t={}",
        running.port, running.token
    ))
}
