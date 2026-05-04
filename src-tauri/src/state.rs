use portable_pty::{Child, MasterPty};
use std::collections::HashMap;
use std::io::Write;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use tokio::sync::oneshot;

pub struct PtySession {
    // Drop order matters: child first, then writer, then reader thread (join), then master last.
    // Rust drops fields in declaration order, but we use an explicit Drop impl for safety.
    pub child: Box<dyn Child + Send + Sync>,
    pub writer: Box<dyn Write + Send>,
    pub reader_thread: Option<JoinHandle<()>>,
    pub master: Box<dyn MasterPty + Send>,
    /// Initial working directory the PTY child was spawned in. Captured at
    /// `spawn_shell` / `spawn_process` time. Used by the FSD orchestrator to
    /// thread the leader's project root into headless helper invocations
    /// (Phase 2.9) — without this, helpers inherit the Tauri app's bundle
    /// path (`/Applications/.../MacOS/`) and fail to resolve relative paths
    /// in the leader's prompts. Doesn't reflect post-spawn `cd` inside the
    /// shell; for that, the live PID-based `get_pty_cwd` Tauri command is
    /// available.
    pub cwd: Option<PathBuf>,
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

/// Per-leader FSD orchestrator handle, registered while a run is active.
/// Cancellation drops the `cancel_tx` half (signaling the heartbeat task to
/// stop) AND drops every entry in `task_cancel_txs` so each in-flight
/// assistant runner sees its `cancel_rx` resolve and kills its process group.
pub struct FsdRunHandle {
    pub leader_handle: String,
    pub run_id: String,
    /// Send () to stop the heartbeat task.
    pub cancel_tx: Option<oneshot::Sender<()>>,
    /// In-flight assistant task cancellation senders, keyed by task_id.
    /// `cancel_run` drains the map and signals each — runners then call
    /// process_group::kill_process_group(pid). Completed tasks remove their
    /// own entry so /fsd-cancel doesn't try to signal already-gone tasks
    /// and `cancelled_tasks` count is accurate (closes @codex2 task-57 P2).
    pub task_cancel_txs: std::collections::HashMap<String, oneshot::Sender<()>>,
    /// Active turn — used to reject `##FSD dispatch turn=N` when N exceeds
    /// the run's recorded `max_turns` (cap-trip path).
    pub max_turns: u32,
    pub current_turn: u32,
    /// Per-run set of `cmd_id`s already processed. Per plan v5 §3.1 rule 6:
    /// a duplicate `cmd_id` (run_id, cmd_id) MUST be returned as Duplicate
    /// without side effects. Closes the round-8 P1 from @codex2/@codex3/@claude3
    /// (3/5 evaluators raised it). The seen set lives only in memory — replay
    /// after app restart starts fresh, which is acceptable because
    /// recover_runs marks interrupted runs and the leader will issue fresh
    /// cmd_ids on the new attempt.
    pub seen_cmd_ids: std::collections::HashSet<String>,
    /// Consecutive non-Accepted command count per plan v5 §4.2 strike protocol.
    /// Increments on every backend rejection (StaleNonce, Malformed, OutOfBounds,
    /// OutOfScope, Duplicate doesn't count) AND on every frontend-reported
    /// malformed line via `fsd_report_malformed`. Resets to 0 on Accepted.
    /// At STRIKES_PER_TURN (3), the orchestrator force-blocks the run.
    /// Closes round-7/8 P1 from @codex2 + @codex3 + @claude3 (3/5 evaluators).
    pub consecutive_strikes: u32,
}

pub struct AppState {
    pub sessions: Mutex<HashMap<String, PtySession>>,
    /// Cached shell environment — resolved once via login shell, reused for all PTYs.
    /// None = not yet bootstrapped. Some(map) = ready.
    pub cached_env: Mutex<Option<HashMap<String, String>>>,
    /// In-flight FSD run handles keyed by run_id. Persists ONLY for the
    /// lifetime of an active run; durable state lives in fsd-runs/ on disk.
    pub fsd_runs: Arc<Mutex<HashMap<String, FsdRunHandle>>>,
    /// Per-leader FSD activation state. Holds the active session_nonce so the
    /// orchestrator can validate incoming commands. Cleared on tier→Off.
    pub fsd_leaders: Arc<Mutex<HashMap<String, FsdLeaderRuntime>>>,
}

/// Per-leader FSD activation runtime state — backend mirror of the frontend's
/// FsdLeaderState. Lives only while the leader's tier > Off.
///
/// `leader_handle` and `tier` are populated for future Phase 2 introspection
/// (multi-leader cross-references, per-tier capacity planning). Currently the
/// orchestrator looks up by `leader_session_id` from inbound IPC and uses
/// `session_nonce` for envelope validation.
#[allow(dead_code)]
#[derive(Debug, Clone)]
pub struct FsdLeaderRuntime {
    pub leader_handle: String,
    pub leader_session_id: String,
    pub session_nonce: String,
    pub tier: u8, // 0=Off, 1=Pilot, 2=x1, 3=x2, 4=x3
}

impl AppState {
    pub fn new() -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
            cached_env: Mutex::new(None),
            fsd_runs: Arc::new(Mutex::new(HashMap::new())),
            fsd_leaders: Arc::new(Mutex::new(HashMap::new())),
        }
    }
}
