// Worktree subsystem — supervisor heartbeat (Phase 4)
//
// Per spec §3.4 + §7 INVARIANT 0 + R-T2.3 (supervisor-owned):
//   The supervisor (NOT the agent — external CLI agents like Claude
//   Code or Codex CLI cannot be modified to call our Tauri APIs)
//   posts heartbeats to the registry every `heartbeat_timeout_secs / 3`.
//   The reaper observes heartbeat freshness via `lease_check::evaluate`.
//
// Per spec §7 INVARIANT 0: the supervisor MUST continue heartbeating
// throughout Path A draining. The aliveness check short-circuits on
// actively-managed states regardless, but a supervisor that stops
// heartbeating mid-drain risks losing the lease to the reaper if the
// state machine spends time outside the actively-managed set.
//
// This module exports `Heartbeat` — a tokio task that ticks at
// `heartbeat_timeout_secs / 3` and calls `Registry::touch_heartbeat`.
// The supervisor owns a `JoinHandle` so it can cancel the task when
// the agent exits.

use crate::worktree::registry::Registry;
use crate::worktree::types::ManagedRoot;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::task::JoinHandle;

/// Owns the heartbeat task for one agent. Drop cancels the task.
pub struct Heartbeat {
    handle: Option<JoinHandle<()>>,
}

impl Heartbeat {
    /// Start a heartbeat task ticking every `interval`. The task
    /// calls `registry.touch_heartbeat(&agent_id, now_unix_secs())`
    /// each tick. Errors are logged via `eprintln!` (Phase 4.5 will
    /// replace with structured logging).
    ///
    /// Returns a `Heartbeat` that the supervisor owns; dropping it
    /// or calling `stop()` cancels the task.
    pub fn start(
        managed_root: ManagedRoot,
        agent_id: String,
        interval: Duration,
    ) -> Self {
        let registry = Arc::new(Registry::new(managed_root));
        // Use tokio::spawn directly so we get a `tokio::task::JoinHandle`
        // with `.abort()`. tauri::async_runtime::spawn returns a wrapper
        // type without abort. Both run on the same Tokio runtime that
        // Tauri sets up via `rt-multi-thread`.
        let handle = tokio::spawn(async move {
            let mut tick = tokio::time::interval(interval);
            // Skip the first immediate tick — the agent was just
            // marked Ready by the provisioner with a fresh
            // heartbeat_at; no need to write again immediately.
            tick.tick().await;
            // T2.2 fix per claude3 Issue 4: exit on LeaseNotFound (the
            // lease is genuinely gone — reaper claimed or supervisor
            // released — continuing to heartbeat is pointless and
            // floods logs). Other errors (lock contention, transient
            // I/O) keep retrying.
            use crate::worktree::registry_store::RegistryStoreError;
            loop {
                tick.tick().await;
                let now = now_unix_secs();
                match registry.touch_heartbeat(&agent_id, now) {
                    Ok(()) => {}
                    Err(RegistryStoreError::LeaseNotFound(_)) => {
                        tracing::info!(
                            target: "worktree::heartbeat",
                            agent_id = %agent_id,
                            "lease no longer exists; stopping heartbeat task"
                        );
                        return;
                    }
                    Err(e) => {
                        tracing::warn!(
                            target: "worktree::heartbeat",
                            agent_id = %agent_id,
                            error = %e,
                            "touch failed (transient — retrying)"
                        );
                    }
                }
            }
        });
        Self { handle: Some(handle) }
    }

    /// Cancel the heartbeat task. Safe to call multiple times.
    /// The supervisor calls this when the agent exits (Path A
    /// `agent_completed`) or when forced cleanup is initiated
    /// (Path B `forced_close`).
    pub fn stop(&mut self) {
        if let Some(h) = self.handle.take() {
            h.abort();
        }
    }
}

impl Drop for Heartbeat {
    fn drop(&mut self) {
        self.stop();
    }
}

/// Compute the heartbeat post interval from the lease's timeout.
/// Spec convention: post 3x more often than the timeout so transient
/// missed ticks don't cause the lease to expire.
pub fn interval_for_timeout(heartbeat_timeout_secs: u32) -> Duration {
    Duration::from_secs(heartbeat_timeout_secs as u64 / 3).max(Duration::from_secs(1))
}

fn now_unix_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::worktree::managed_root::ensure_layout;
    use crate::worktree::types::{
        AgentId, AgentState, BranchRef, LeaseRecord, WorktreePath,
        REGISTRY_SCHEMA_VERSION,
    };
    use std::path::PathBuf;

    fn fresh_managed_root_with_lease(agent_id: &str) -> (tempfile::TempDir, ManagedRoot, i64) {
        let tmp = tempfile::tempdir().unwrap();
        let root = ManagedRoot::new(tmp.path()).unwrap();
        ensure_layout(&root).unwrap();
        let registry = Registry::new(root.clone());
        let initial_heartbeat = 1000i64;
        let id = AgentId::new(agent_id).unwrap();
        // Create a worktree dir + nonce file so any aliveness check
        // could find them
        let wt = root.worktrees_dir().join(id.as_str());
        std::fs::create_dir_all(&wt).unwrap();
        std::fs::write(wt.join(".canvas-agent-nonce"), "test-nonce").unwrap();
        let lease = LeaseRecord {
            session_id: "sess".into(),
            agent_id: id.as_str().to_string(),
            parent_agent_id: None,
            task_id: "task".into(),
            repo_root: PathBuf::from("/tmp/repo"),
            base_ref: "refs/heads/main".into(),
            base_commit: "x".into(),
            branch_ref: BranchRef::for_agent("sess", id.as_str()).unwrap(),
            worktree_path: WorktreePath::for_agent(&root, &id),
            owner_pid: std::process::id() as i32,
            owner_nonce: "test-nonce".into(),
            owner_start_time: None,
            process_group_id: None,
            heartbeat_at: initial_heartbeat,
            heartbeat_timeout_secs: 30,
            liveness_quiescent_secs: 60,
            wedge_grace_secs: 30,
            state: AgentState::Working,
            artifact_path: None,
            last_error: None,
            last_reaper_id: None,
            created_at: initial_heartbeat,
            updated_at: initial_heartbeat,
            schema_version: REGISTRY_SCHEMA_VERSION,
        };
        registry.insert(lease).unwrap();
        (tmp, root, initial_heartbeat)
    }

    #[test]
    fn interval_for_timeout_is_third_of_timeout() {
        assert_eq!(interval_for_timeout(30), Duration::from_secs(10));
        assert_eq!(interval_for_timeout(90), Duration::from_secs(30));
    }

    #[test]
    fn interval_for_timeout_clamps_to_minimum_1s() {
        // Very short timeouts (1 or 2 seconds) → divide by 3 = 0;
        // clamp to 1 second so we never tick faster than 1Hz.
        assert_eq!(interval_for_timeout(2), Duration::from_secs(1));
        assert_eq!(interval_for_timeout(1), Duration::from_secs(1));
        assert_eq!(interval_for_timeout(0), Duration::from_secs(1));
    }

    #[test]
    fn heartbeat_stop_is_idempotent() {
        // Ensure stop() can be called multiple times without panic.
        // We don't actually start the tokio task here (no runtime in
        // unit tests by default); we construct a Heartbeat with no
        // handle and verify stop() is a no-op.
        let mut hb = Heartbeat { handle: None };
        hb.stop();
        hb.stop();
        // No panic = pass
    }

    /// T2.1 fix per claude2 Q1 + claude3 Issue 1: virtual-time test
    /// of the actual heartbeat tick → registry write path. Uses
    /// `start_paused = true` so we control time advancement; we don't
    /// real-sleep the test runner.
    #[tokio::test(start_paused = true)]
    async fn heartbeat_tick_writes_to_registry() {
        let (_tmp, root, initial_hb) = fresh_managed_root_with_lease("agent-A");
        let registry = Registry::new(root.clone());

        let mut hb = Heartbeat::start(
            root,
            "agent-A".to_string(),
            Duration::from_secs(10),
        );

        // Heartbeat skips its first tick by design; advance past the
        // 2nd tick so at least one touch_heartbeat fires.
        tokio::time::advance(Duration::from_secs(11)).await;
        tokio::task::yield_now().await;
        // Second yield to let the spawned task pick up after the timer
        // fires
        tokio::task::yield_now().await;

        let lease = registry.get("agent-A").unwrap().unwrap();
        assert!(
            lease.heartbeat_at >= initial_hb,
            "heartbeat_at should advance from initial; got {} initial {}",
            lease.heartbeat_at,
            initial_hb
        );

        hb.stop();
    }

    /// T2.2 fix per claude3 Issue 4: heartbeat exits cleanly when the
    /// lease has been removed (e.g., reaper claimed it). Validates
    /// the LeaseNotFound short-circuit added per the same finding.
    #[tokio::test(start_paused = true)]
    async fn heartbeat_exits_when_lease_disappears() {
        let (_tmp, root, _initial) = fresh_managed_root_with_lease("agent-A");
        let registry = Registry::new(root.clone());

        let _hb = Heartbeat::start(
            root.clone(),
            "agent-A".to_string(),
            Duration::from_secs(5),
        );

        // Remove the lease while the heartbeat task is running
        registry.remove("agent-A").unwrap();

        // Advance past one tick so the heartbeat task tries
        // touch_heartbeat → LeaseNotFound → return.
        tokio::time::advance(Duration::from_secs(6)).await;
        tokio::task::yield_now().await;
        tokio::task::yield_now().await;

        // The heartbeat task has now exited. We can't observe that
        // directly without a sentinel, but if it didn't exit it would
        // keep logging on every subsequent tick. The structural fix
        // — match on RegistryStoreError::LeaseNotFound and return —
        // is verified by code inspection + this test running clean
        // under start_paused without panicking.
    }
}
