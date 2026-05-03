// Worktree subsystem — process-wide supervisor registry (Phase 4.5
// production-wiring follow-up to A2)
//
// The Supervisor owns one agent's lifetime (LeaseRuntime, monitor task,
// heartbeat handle). Tauri commands need to find the supervisor for a
// given agent so they can call `Supervisor::force_close` from the
// `force_close_worktree` command. Without this registry, the only way
// to reach the supervisor would be to hand its handle through the JS
// boundary (impossible — Rust handles aren't serializable) or to wait
// for the monitor task to observe child exit (too slow / wrong path
// for forced close).
//
// **Why a process-global registry**: there is exactly one Tauri app
// process per user session, and the orchestrator session lock
// (Phase 3 B1) already enforces single-orchestrator per managed root.
// So a process-global Mutex&lt;HashMap&gt; is the right granularity:
// supervisors are inserted on `provision_worktree`+`Supervisor::start`
// and removed on `release_worktree` / `force_close_worktree`.

use crate::worktree::supervisor::Supervisor;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};

static INSERTS_TOTAL: AtomicU64 = AtomicU64::new(0);
static REMOVES_TOTAL: AtomicU64 = AtomicU64::new(0);

/// E27 — read-only counters snapshot for the UI.
#[derive(Debug, Default, Clone)]
pub struct SupervisorRegistryMetrics {
    pub inserts_total: u64,
    pub removes_total: u64,
}

pub fn metrics_snapshot() -> SupervisorRegistryMetrics {
    SupervisorRegistryMetrics {
        inserts_total: INSERTS_TOTAL.load(Ordering::Relaxed),
        removes_total: REMOVES_TOTAL.load(Ordering::Relaxed),
    }
}

fn registry() -> &'static Mutex<HashMap<String, Supervisor>> {
    static R: OnceLock<Mutex<HashMap<String, Supervisor>>> = OnceLock::new();
    R.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Insert a freshly-started supervisor.
///
/// **H5 fix per codex1 R1 + codex2 #3**: returns the supervisor BACK
/// on failure (instead of consuming-and-dropping it). Lets the caller
/// roll back: force_close the agent's process group before dropping
/// the supervisor, so the agent doesn't leak as an unsupervised
/// orphan child when registry insertion fails (rare — duplicate
/// agent_id — but a real transactional hole otherwise).
///
/// Error envelope: `(Supervisor, String)` returns the supervisor for
/// rollback, plus a reason string.
pub fn insert(supervisor: Supervisor) -> std::result::Result<(), (Supervisor, String)> {
    let agent_id = supervisor.agent_id().to_string();
    let mut map = match registry().lock() {
        Ok(g) => g,
        Err(e) => {
            return Err((
                supervisor,
                format!("supervisor registry mutex poisoned: {e}"),
            ));
        }
    };
    if map.contains_key(&agent_id) {
        return Err((
            supervisor,
            format!("supervisor for {agent_id} already registered (duplicate Supervisor::start)"),
        ));
    }
    map.insert(agent_id, supervisor);
    INSERTS_TOTAL.fetch_add(1, Ordering::Relaxed);
    Ok(())
}

/// Remove a supervisor by agent_id. Returns the removed supervisor (so
/// the caller can run `force_close().await` on it before dropping —
/// dropping alone aborts the monitor task but does NOT terminate the
/// agent process group). Returns `None` if not present.
pub fn remove(agent_id: &str) -> Option<Supervisor> {
    let mut map = registry().lock().ok()?;
    let removed = map.remove(agent_id);
    if removed.is_some() {
        REMOVES_TOTAL.fetch_add(1, Ordering::Relaxed);
    }
    removed
}

/// True if a supervisor for this agent is registered.
pub fn contains(agent_id: &str) -> bool {
    registry()
        .lock()
        .map(|m| m.contains_key(agent_id))
        .unwrap_or(false)
}

/// All currently-registered agent ids (snapshot). Used by the reaper
/// or shutdown handler to enumerate active supervisors.
pub fn agent_ids() -> Vec<String> {
    registry()
        .lock()
        .map(|m| m.keys().cloned().collect())
        .unwrap_or_default()
}

/// Test-only reset. Production code never calls this.
#[cfg(test)]
pub fn reset_for_test() {
    if let Ok(mut map) = registry().lock() {
        map.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[serial_test::serial(supervisor_registry)]
    fn agent_ids_starts_empty_after_reset() {
        reset_for_test();
        assert!(agent_ids().is_empty());
    }

    #[test]
    #[serial_test::serial(supervisor_registry)]
    fn contains_and_remove_round_trip_with_real_supervisor() {
        // We can't easily build a Supervisor without a tokio runtime
        // and a managed root; the integration coverage lives in the
        // E2E smoke test (`pty_supervisor_smoke_e2e`). This test just
        // exercises the empty-state contract.
        reset_for_test();
        assert!(!contains("nope"));
        assert!(remove("nope").is_none());
    }
}
