use portable_pty::{Child, MasterPty};
use std::collections::HashMap;
use std::io::Write;
use std::sync::Mutex;
use std::thread::JoinHandle;

pub struct PtySession {
    // Drop order matters: child first, then writer, then reader thread (join), then master last.
    // Rust drops fields in declaration order, but we use an explicit Drop impl for safety.
    pub child: Box<dyn Child + Send + Sync>,
    pub writer: Box<dyn Write + Send>,
    pub reader_thread: Option<JoinHandle<()>>,
    pub master: Box<dyn MasterPty + Send>,
}

impl Drop for PtySession {
    fn drop(&mut self) {
        // 1. Kill child process — causes PTY to send EOF/EIO to reader
        let _ = self.child.kill();
        // 2. Drop writer — closes write end of PTY
        // (writer is dropped automatically after this fn, but we want ordering clarity)
        // 3. Join reader thread — wait for it to finish reading before dropping master
        if let Some(handle) = self.reader_thread.take() {
            let _ = handle.join();
        }
        // 4. master drops automatically last (declared last in struct)
    }
}

pub struct AppState {
    pub sessions: Mutex<HashMap<String, PtySession>>,
    /// Cached shell environment — resolved once via login shell, reused for all PTYs.
    /// None = not yet bootstrapped. Some(map) = ready.
    pub cached_env: Mutex<Option<HashMap<String, String>>>,
    /// Serialization lock for settings.json read-modify-write. Both
    /// `set_settings` (full struct) and `set_browser_settings` (partial)
    /// acquire this during their RMW cycle so concurrent writers can't
    /// lose updates. Phase-3 Round-2 3-way convergent fix.
    pub settings_io_lock: Mutex<()>,
}

impl AppState {
    pub fn new() -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
            cached_env: Mutex::new(None),
            settings_io_lock: Mutex::new(()),
        }
    }
}

// ---------------------------------------------------------------------------
// Browser-drawer state (Phase-3 / Phase-5 design — feature/browser-drawer)
// ---------------------------------------------------------------------------

use tauri::{LogicalPosition, LogicalSize, Position, Rect as DpiRect, Runtime, Size, Webview};

/// Singleton-webview slot states. The `Creating` middle state closes the
/// check-then-build TOCTOU race when two `create_browser_webview` commands
/// fire concurrently (Phase-3 Round-2 codex3 #1).
pub enum BrowserSlot<R: Runtime> {
    Empty,
    Creating,
    Ready(Webview<R>),
}

/// Wire-format rect used at the IPC boundary. Mirrors `src/types/browser.ts::Rect`.
#[derive(Debug, Clone, Copy, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl Rect {
    /// Translate the IPC rect into Tauri's logical-pixel rect used by
    /// `Webview::set_bounds`. Tauri 2 handles DPR internally.
    pub fn to_dpi_rect(self) -> DpiRect {
        DpiRect {
            position: Position::Logical(LogicalPosition { x: self.x, y: self.y }),
            size: Size::Logical(LogicalSize {
                width: self.width,
                height: self.height,
            }),
        }
    }
}

/// Browser-drawer Rust-side state. Two Mutexes:
/// - `slot`: BrowserSlot transitions Empty → Creating → Ready(w) → Empty.
/// - `last_bounds`: Rust-side dedup cache for #26 set_bounds (skips OS-layer
///   calls when the rect hasn't changed since the last sync).
///
/// Lock-order convention: `last_bounds` BEFORE `slot`. No node currently
/// locks both simultaneously; documented for future regression prevention.
pub struct BrowserWebviewState<R: Runtime> {
    pub slot: Mutex<BrowserSlot<R>>,
    pub last_bounds: Mutex<Option<Rect>>,
}

impl<R: Runtime> BrowserWebviewState<R> {
    pub fn new() -> Self {
        Self {
            slot: Mutex::new(BrowserSlot::Empty),
            last_bounds: Mutex::new(None),
        }
    }

    /// Non-destroy primitive (#36a): clone the `Webview<R>` handle out of
    /// the slot if it's `Ready`. Used by `set_bounds`, `navigate`, the four
    /// nav commands, and create's pre-check. Leaves the slot in `Ready`.
    pub fn clone_webview(&self) -> Option<Webview<R>> {
        match &*self.slot.lock().ok()? {
            BrowserSlot::Ready(w) => Some(w.clone()),
            _ => None,
        }
    }

    /// Destroy-only primitive (#36b): take the webview out of the slot,
    /// leaving it Empty. Used ONLY by `destroy_browser_webview_impl`.
    /// Calling this from a non-destroy command would break the singleton.
    pub fn take_webview(&self) -> Option<Webview<R>> {
        let mut guard = self.slot.lock().ok()?;
        match std::mem::replace(&mut *guard, BrowserSlot::Empty) {
            BrowserSlot::Ready(w) => Some(w),
            other => {
                // Put back Creating if we caught it mid-flight; preserve invariant.
                *guard = other;
                None
            }
        }
    }

    /// Slot-reservation primitive (#36c) for create. Atomically transitions
    /// `Empty → Creating` under one lock, returning a `CreateGuard` whose
    /// Drop rolls back to `Empty` unless `finalize(webview)` is called first.
    pub fn try_reserve_for_create(&self) -> Result<CreateGuard<'_, R>, String> {
        let mut guard = self.slot.lock().map_err(|e| format!("slot lock poisoned: {}", e))?;
        match *guard {
            BrowserSlot::Empty => {
                *guard = BrowserSlot::Creating;
                Ok(CreateGuard {
                    state: self,
                    finalized: false,
                })
            }
            BrowserSlot::Creating => Err("browser webview already being created".to_string()),
            BrowserSlot::Ready(_) => Err("browser webview already exists".to_string()),
        }
    }
}

impl<R: Runtime> Default for BrowserWebviewState<R> {
    fn default() -> Self {
        Self::new()
    }
}

/// RAII guard returned by `try_reserve_for_create`. If `finalize(webview)`
/// isn't called before drop, transitions the slot back to `Empty` so a
/// failed `create_browser_webview` doesn't leave the slot stuck in
/// `Creating`.
pub struct CreateGuard<'a, R: Runtime> {
    state: &'a BrowserWebviewState<R>,
    finalized: bool,
}

impl<'a, R: Runtime> CreateGuard<'a, R> {
    /// Transition `Creating → Ready(webview)`. The guard's Drop becomes a no-op.
    pub fn finalize(mut self, webview: Webview<R>) -> Result<(), String> {
        let mut guard = self
            .state
            .slot
            .lock()
            .map_err(|e| format!("slot lock poisoned: {}", e))?;
        *guard = BrowserSlot::Ready(webview);
        self.finalized = true;
        Ok(())
    }
}

impl<'a, R: Runtime> Drop for CreateGuard<'a, R> {
    fn drop(&mut self) {
        if !self.finalized {
            if let Ok(mut guard) = self.state.slot.lock() {
                // Only roll back if we still see Creating — defensive in case
                // finalize succeeded partially before a panic.
                if matches!(*guard, BrowserSlot::Creating) {
                    *guard = BrowserSlot::Empty;
                }
            }
        }
    }
}
