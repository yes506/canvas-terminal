//! Shared dashboard state — registered into Tauri via `app.manage(DashboardInfo)`.
//!
//! The destroy handler in `lib.rs` reads this via `try_state::<DashboardInfo>()`
//! to flip `SESSION_ALIVE` as the first statement, before any cleanup runs.

use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use tokio::sync::Mutex;

/// Per-launch handle that lets Tauri commands and the destroy hook reach
/// into the dashboard server's state. Registered via `app.manage()`.
pub struct DashboardInfo {
    /// `Mutex<Option<...>>` (not `OnceCell`) so a failed bind on first attempt
    /// doesn't permanently poison subsequent retries — see v4 §3.2.
    pub running: Mutex<Option<Running>>,
    /// Flipped to `false` as the FIRST statement of `WindowEvent::Destroyed`.
    /// Threaded as `Arc<AtomicBool>` (not a module-private static) for test
    /// isolation — see v4 §3.4 / v5 §3.6.
    pub session_alive: Arc<AtomicBool>,
}

#[derive(Clone)]
pub struct Running {
    pub port: u16,
    pub token: String,
    pub shutdown: Arc<tokio::sync::Notify>,
}

impl DashboardInfo {
    pub fn new() -> Self {
        Self {
            running: Mutex::new(None),
            session_alive: Arc::new(AtomicBool::new(true)),
        }
    }
}

impl Default for DashboardInfo {
    fn default() -> Self {
        Self::new()
    }
}

/// Returned across the Tauri IPC boundary. Token-less by construction —
/// see v4 §3.3 / v5 §3.4.
#[derive(serde::Serialize)]
pub struct DashboardInfoNoToken {
    /// Token-less URL: `http://127.0.0.1:PORT/`.
    pub url: String,
    pub port: u16,
}
