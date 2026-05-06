use portable_pty::{Child, MasterPty};
use std::collections::HashMap;
use std::io::Write;
use std::path::PathBuf;
use std::sync::atomic::AtomicU64;
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
    /// Inbox-subsystem monotonic sequence counter (plan v6 §2.1 + §2.4).
    /// Holds "next free" — readers call `fetch_add(1)` and use the returned
    /// value as the issued seq. Initialized fresh in `new()`; recovered from
    /// disk via `init_seq_global_from_disk()` at app start (called from
    /// `lib.rs::run` setup, before any inbox writers).
    ///
    /// Wrapped in `Arc` (round-7 reflection per claude4 task-78 §3.2) so
    /// the Phase C response broker can own a clone across async-spawned
    /// task boundaries while preserving the writer-monopoly invariant
    /// (single global counter, not ephemeral per-broker).
    pub seq_global: Arc<AtomicU64>,
    /// Per-leader inbox-poller handles (Phase B). Each entry stores the
    /// poller's `JoinHandle` for abort-on-tier-off PLUS its `Notify` for
    /// in-process wake on inbox-write. Stored on `AppState` (not on
    /// `FsdLeaderRuntime`) because `JoinHandle` is not `Clone` and the
    /// runtime struct is — see plan v6 §2.5.
    pub leader_inbox_pollers: Arc<Mutex<HashMap<String, LeaderPollerEntry>>>,

    /// PR-PreC: per-(run_id, turn) registry of agent_ids spawned by the
    /// leader's `dispatch` verb. Used by Phase C's authorization check
    /// for `to_agent_id` — a leader may only address agents that the
    /// orchestrator spawned in the current turn. Plan v6 §2.8 + §2.10.
    ///
    /// Keyed: `run_id → turn → set<agent_id>`. Populated in
    /// `handle_dispatch`; cleared on `handle_done`/`handle_blocked`.
    /// Empty map = pre-Phase-C semantics (no inter-agent messaging).
    pub current_dispatch_groups:
        Arc<Mutex<HashMap<String, HashMap<u32, std::collections::HashSet<String>>>>>,
}

/// Per-leader poller registration. Plan v6 Phase B.
pub struct LeaderPollerEntry {
    pub join: tokio::task::JoinHandle<()>,
    pub notify: std::sync::Arc<tokio::sync::Notify>,
}

impl Drop for LeaderPollerEntry {
    fn drop(&mut self) {
        // When the entry is dropped (e.g. removed from the HashMap on
        // FSD-tier-off), abort the spawned task so its loop terminates.
        self.join.abort();
    }
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
            seq_global: Arc::new(AtomicU64::new(0)),
            leader_inbox_pollers: Arc::new(Mutex::new(HashMap::new())),
            current_dispatch_groups: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// Recover `seq_global` from disk on app start. Plan v6 §2.4.
    ///
    /// Computes `max(persisted, scanned) + 1` so the counter holds "next free"
    /// after init. Recovery is safe under both crash-recovery scenarios:
    /// - If `inbox/.meta/seq_global.json` is fresher than disk files: use
    ///   the persisted value.
    /// - If a crash between persistence checkpoints left files with higher
    ///   seq than persisted: use the scan max so we don't reissue in-use seqs.
    ///
    /// **Infallible at the API level** — internal errors are logged and the
    /// recovery falls back to 0. Plan v6 §2.4 chose Option (b) split-init
    /// to keep `AppState::new()` infallible.
    pub fn init_seq_global_from_disk(&self) {
        let recovered = crate::fsd::storage::recover_seq_global();
        // Counter holds "next free" — first issued seq will be `recovered + 1`.
        // If recovered=0 (cold first boot), first seq is 1. If recovered=42
        // (max seen on disk), first seq is 43. No off-by-one (plan v6 §2.1).
        self.seq_global
            .store(recovered + 1, std::sync::atomic::Ordering::SeqCst);
    }

    /// Run startup-only inbox reapers. Plan v6 §2.6 retention table.
    ///
    /// Phase A scope:
    /// - `.audit/` files older than 7 days are deleted (`reap_old_audit`).
    /// - `.processed/` files older than 24 hours are deleted (`reap_old_processed`).
    /// - `.processing/` files older than 30 seconds (stale claims) are renamed
    ///   back to `.pending/` (`reap_stale_inbox_claims`).
    ///
    /// All reaping is best-effort: errors are logged and skipped, never
    /// propagated. Phase B will add a tokio interval task that re-runs these
    /// periodically; Phase A relies on the once-at-startup pass.
    ///
    /// MUST be called AFTER `init_seq_global_from_disk()` so the reaper
    /// doesn't delete `.audit/` files that the seq scan would otherwise read
    /// (plan v6 §2.14 #21 startup ordering).
    pub fn init_inbox_reapers(&self) {
        const AUDIT_TTL_SECS: u64 = 7 * 24 * 60 * 60; // 7 days
        const PROCESSED_TTL_SECS: u64 = 24 * 60 * 60; // 24 hours
        const STALE_CLAIM_TTL_SECS: u64 = 30; // 30s — see plan v6 §2.6

        // Discover all per-leader inbox scopes by listing `inbox/*/` dirs.
        // For each, run all three reapers. Plus the global inbox.
        let memory_root = match crate::commands::memory::get_memory_root() {
            Ok(p) => p,
            Err(e) => {
                eprintln!("fsd: init_inbox_reapers: get_memory_root failed: {}", e);
                return;
            }
        };
        let inbox_root = memory_root.join("inbox");
        if !inbox_root.exists() {
            return; // cold first boot — nothing to reap
        }

        let mut scopes: Vec<crate::fsd::inbox::InboxScope> = Vec::new();
        scopes.push(crate::fsd::inbox::InboxScope::Global);
        if let Ok(entries) = std::fs::read_dir(&inbox_root) {
            for entry in entries.flatten() {
                let name = match entry.file_name().into_string() {
                    Ok(n) => n,
                    Err(_) => continue,
                };
                // Skip the `.meta/` singleton and the `global/` (already added).
                if name == ".meta" || name == "global" || name.starts_with('.') {
                    continue;
                }
                // SECURITY: per codex3 task-52 §1 — `Path::is_dir()` FOLLOWS
                // symlinks. A planted symlink at e.g. `inbox/leader-evil ->
                // /etc` would cause subsequent reaper calls to operate on
                // files outside the memory root. Use `symlink_metadata` and
                // skip any non-real-directory entry.
                let meta = match entry.metadata() {
                    Ok(m) => m,
                    Err(_) => continue,
                };
                // entry.metadata() follows symlinks; use file_type from
                // symlink_metadata for the no-follow check.
                let no_follow_type = match std::fs::symlink_metadata(entry.path()) {
                    Ok(m) => m.file_type(),
                    Err(_) => continue,
                };
                if no_follow_type.is_symlink() || !meta.is_dir() {
                    eprintln!(
                        "fsd: init_inbox_reapers: skipping non-real-dir entry inbox/{}",
                        name
                    );
                    continue;
                }
                // Empty-handle filter (claude4 task-53 §3.3): `leader-` with
                // nothing after would yield an invalid `Handle{ handle: "" }`
                // which validate() rejects — skip silently to avoid log noise.
                if let Some(handle) = name.strip_prefix("leader-") {
                    if handle.is_empty() {
                        continue;
                    }
                    scopes.push(crate::fsd::inbox::InboxScope::Leader {
                        handle: handle.to_string(),
                    });
                } else if let Some(agent_id) = name.strip_prefix("agent-") {
                    if agent_id.is_empty() {
                        continue;
                    }
                    scopes.push(crate::fsd::inbox::InboxScope::Agent {
                        agent_id: agent_id.to_string(),
                    });
                }
            }
        }

        for scope in &scopes {
            if let Err(e) = crate::fsd::storage::reap_old_audit(scope, AUDIT_TTL_SECS) {
                eprintln!(
                    "fsd: reap_old_audit({:?}) failed at startup: {}",
                    scope, e
                );
            }
            if let Err(e) = crate::fsd::storage::reap_old_processed(scope, PROCESSED_TTL_SECS) {
                eprintln!(
                    "fsd: reap_old_processed({:?}) failed at startup: {}",
                    scope, e
                );
            }
            if let Err(e) =
                crate::fsd::storage::reap_stale_inbox_claims(scope, STALE_CLAIM_TTL_SECS)
            {
                eprintln!(
                    "fsd: reap_stale_inbox_claims({:?}) failed at startup: {}",
                    scope, e
                );
            }
        }
    }
}
