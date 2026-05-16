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
///
/// `Creating` and `Ready` carry a `generation: u64` so that an in-flight
/// `finalize(webview)` can detect cancellation: if `destroy` ran while the
/// slot was `Creating(gen=N)`, destroy transitions to `Empty` and the
/// finalize that follows sees the generation no longer matches → closes
/// the just-built webview and leaves Empty. Closes the close-during-create
/// ghost-webview bug (impl-review @codex3 high #1).
pub enum BrowserSlot<R: Runtime> {
    Empty,
    Creating {
        generation: u64,
    },
    Ready {
        // Generation is stored for observability + future "destroy if gen
        // matches" semantics; read by the variant-pattern match in
        // `take_webview` / `clone_webview` even though the field itself
        // is destructured with `..`.
        #[allow(dead_code)]
        generation: u64,
        webview: Webview<R>,
    },
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
    /// Monotonically-increasing generation counter. Each
    /// `try_reserve_for_create` bumps this; the resulting `CreateGuard`
    /// captures the new value so `finalize` can detect cancellation
    /// (impl-review @codex3 high #1).
    pub generation: std::sync::atomic::AtomicU64,
}

impl<R: Runtime> BrowserWebviewState<R> {
    pub fn new() -> Self {
        Self {
            slot: Mutex::new(BrowserSlot::Empty),
            last_bounds: Mutex::new(None),
            generation: std::sync::atomic::AtomicU64::new(0),
        }
    }

    /// Non-destroy primitive (#36a): clone the `Webview<R>` handle out of
    /// the slot if it's `Ready`. Used by `set_bounds`, `navigate`, the four
    /// nav commands. Leaves the slot in `Ready`.
    pub fn clone_webview(&self) -> Option<Webview<R>> {
        match &*self.slot.lock().ok()? {
            BrowserSlot::Ready { webview, .. } => Some(webview.clone()),
            _ => None,
        }
    }

    /// Destroy-only primitive (#36b). NEW BEHAVIOR (impl-review @codex3 #1):
    /// always transition to `Empty`, regardless of current state.
    /// - `Ready { webview, .. }` → return Some(webview), slot becomes Empty.
    /// - `Creating { gen }` → slot becomes Empty; an in-flight `finalize`
    ///   with that gen will see the mismatch and close-and-discard the
    ///   webview it was about to publish.
    /// - `Empty` → no-op.
    pub fn take_webview(&self) -> Option<Webview<R>> {
        let mut guard = self.slot.lock().ok()?;
        match std::mem::replace(&mut *guard, BrowserSlot::Empty) {
            BrowserSlot::Ready { webview, .. } => Some(webview),
            BrowserSlot::Creating { .. } | BrowserSlot::Empty => None,
        }
    }

    /// Slot-reservation primitive (#36c) for create. Atomically:
    /// 1. Rejects if the slot is `Creating` OR `Ready` (impl-review R2
    ///    @codex3 medium #2: keep the singleton-reservation guarantee.
    ///    Allowing `Creating` to be superseded let two concurrent creates
    ///    both call `Window::add_child("browser", ...)` simultaneously,
    ///    which Tauri rejects on duplicate labels. The cancellation path
    ///    is handled by `destroy_browser_webview_impl` transitioning
    ///    `Creating → Empty`; the in-flight guard's `finalize` then sees
    ///    the mismatch via the generation check and closes its orphan.)
    /// 2. On `Empty`: bumps `generation`, transitions to `Creating { gen }`,
    ///    returns a `CreateGuard` carrying that generation.
    pub fn try_reserve_for_create(&self) -> Result<CreateGuard<'_, R>, String> {
        use std::sync::atomic::Ordering;
        let mut guard = self
            .slot
            .lock()
            .map_err(|e| format!("slot lock poisoned: {}", e))?;
        match &*guard {
            BrowserSlot::Ready { .. } => {
                return Err("browser webview already exists".to_string());
            }
            BrowserSlot::Creating { .. } => {
                return Err("browser webview already being created".to_string());
            }
            BrowserSlot::Empty => {}
        }
        let gen = self.generation.fetch_add(1, Ordering::SeqCst) + 1;
        *guard = BrowserSlot::Creating { generation: gen };
        Ok(CreateGuard {
            state: self,
            generation: gen,
            finalized: false,
        })
    }
}

impl<R: Runtime> Default for BrowserWebviewState<R> {
    fn default() -> Self {
        Self::new()
    }
}

/// RAII guard returned by `try_reserve_for_create`. Carries the
/// `generation` captured at reservation time so `finalize` can detect
/// cancellation by destroy or by a newer create reservation.
pub struct CreateGuard<'a, R: Runtime> {
    state: &'a BrowserWebviewState<R>,
    generation: u64,
    finalized: bool,
}

/// Result of `CreateGuard::finalize` — tells the caller whether the new
/// webview was published or whether it was cancelled (in which case the
/// caller must close it to avoid leaking an OS-layer webview).
pub enum FinalizeOutcome<R: Runtime> {
    /// Slot transitioned `Creating(gen) → Ready(gen, webview)`. Webview is
    /// now owned by the slot.
    Published,
    /// Destroy ran during create OR a newer create reservation superseded
    /// this one. Slot is not modified; caller MUST close the webview to
    /// avoid leaking the OS-layer surface.
    Cancelled(Webview<R>),
}

impl<'a, R: Runtime> CreateGuard<'a, R> {
    /// Try to publish `webview` into the slot. Detects cancellation:
    /// - If slot is still `Creating { generation }` matching ours →
    ///   transition to `Ready { generation, webview }`, return Published.
    /// - Otherwise (slot is Empty after destroy, or Creating with a newer
    ///   generation, or Ready from a sibling create) → return
    ///   Cancelled(webview). Caller closes it.
    pub fn finalize(mut self, webview: Webview<R>) -> Result<FinalizeOutcome<R>, String> {
        let mut guard = self
            .state
            .slot
            .lock()
            .map_err(|e| format!("slot lock poisoned: {}", e))?;
        let still_ours = matches!(
            *guard,
            BrowserSlot::Creating { generation } if generation == self.generation
        );
        self.finalized = true;
        if still_ours {
            *guard = BrowserSlot::Ready {
                generation: self.generation,
                webview,
            };
            Ok(FinalizeOutcome::Published)
        } else {
            // Slot has moved on (destroyed or superseded). Don't store;
            // hand the webview back to the caller for close.
            Ok(FinalizeOutcome::Cancelled(webview))
        }
    }
}

impl<'a, R: Runtime> Drop for CreateGuard<'a, R> {
    fn drop(&mut self) {
        if !self.finalized {
            // Build failed before finalize. Roll back ONLY if slot still
            // matches our generation — otherwise a newer create reservation
            // has already taken the slot and we mustn't disturb it.
            if let Ok(mut guard) = self.state.slot.lock() {
                if matches!(
                    *guard,
                    BrowserSlot::Creating { generation } if generation == self.generation
                ) {
                    *guard = BrowserSlot::Empty;
                }
            }
        }
    }
}
