// Worktree subsystem — multi-process restart recovery (B12)
//
// On Tauri startup the in-memory `supervisor_registry` is empty, so any
// lease in `Working` state from a prior run has no live supervisor in
// THIS process. The agent's PTY child is also gone (PTY fds were closed
// when the prior Tauri process exited). The lease is effectively
// orphaned — the reaper's liveness check would catch it eventually,
// but there's no point waiting. We can pre-emptively transition all
// `Working` leases (with no live supervisor) to `Draining` so the
// drainer's sweep handles them on the first tick.
//
// This is fail-closed: if the registry can't be read, we skip the
// recovery (the reaper will still pick up via liveness check).

use crate::worktree::registry::Registry;
use crate::worktree::supervisor_registry;
use crate::worktree::types::{AgentState, ManagedRoot};
use std::time::{SystemTime, UNIX_EPOCH};

/// Number of leases transitioned by recovery (mostly informational).
#[derive(Debug, Default)]
pub struct RecoveryReport {
    pub adopted: usize,
    pub failures: Vec<(String, String)>,
}

/// Run startup recovery. Called once during Tauri `setup` after the
/// reaper is initialized.
///
/// **H7 fix per claude3 Issue 2**: previously only adopted
/// `Working`/`Ready` orphans. Drainer-mid-state leases
/// (`Snapshotting`/`ArtifactWritten`/`WipRefWritten`) from a crashed
/// prior process were stuck — `is_actively_managed` excludes the
/// reaper from claiming them, but no production code was rerunning
/// the drainer chain on them. Now: also transition those to
/// `Draining` so the production `Drainer::sweep_draining` loop picks
/// them up and runs the idempotent retry.
///
/// For `MergeQueued`/`Merging`/`Merged`/`Removed`/`Preserved` orphans,
/// we log via tracing but DO NOT auto-adopt. The merge worker is
/// idempotent for `MergeQueued` (user can re-approve) and for
/// `Merging`/`Merged`/`Removed`/`Preserved` the registry-tail
/// completion can be retried by re-running approve_merge or by
/// adding `Merged | Removed` to `is_actively_managed` (H1) which
/// blocks the reaper while leaving them visible.
pub fn adopt_orphan_leases(managed_root: &ManagedRoot) -> RecoveryReport {
    let mut report = RecoveryReport::default();
    let registry = Registry::new(managed_root.clone());
    let leases = match registry.list_all() {
        Ok(l) => l,
        Err(_) => return report,
    };
    let now = now_unix_secs();
    for (agent_id, lease) in leases.into_iter() {
        let should_adopt = matches!(
            lease.state,
            AgentState::Working
                | AgentState::Ready
                | AgentState::Snapshotting
                | AgentState::ArtifactWritten
                | AgentState::WipRefWritten
        );
        let should_log_only = matches!(
            lease.state,
            AgentState::MergeQueued
                | AgentState::Merging
                | AgentState::Merged
                | AgentState::Removed
                | AgentState::Preserved
        );
        if should_log_only {
            tracing::info!(
                target: "worktree::recovery",
                agent_id = %agent_id,
                state = ?lease.state,
                "lease in transient state from prior process — manual recovery may be needed (abort_merge / retry_merge / approve_merge)"
            );
            continue;
        }
        if !should_adopt {
            continue;
        }
        if supervisor_registry::contains(&agent_id) {
            // Live supervisor in this process owns the lease.
            continue;
        }
        match registry.update_state(&agent_id, AgentState::Draining, now) {
            Ok(()) => report.adopted += 1,
            Err(e) => report.failures.push((agent_id, e.to_string())),
        }
    }
    report
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
        AgentId, BranchRef, LeaseRecord, WorktreePath, REGISTRY_SCHEMA_VERSION,
    };
    use std::path::PathBuf;

    fn fresh_managed_root() -> (tempfile::TempDir, ManagedRoot) {
        let tmp = tempfile::tempdir().unwrap();
        let root = ManagedRoot::new(tmp.path()).unwrap();
        ensure_layout(&root).unwrap();
        (tmp, root)
    }

    fn insert_lease(root: &ManagedRoot, id: &str, state: AgentState) {
        let agent = AgentId::new(id).unwrap();
        let wt = WorktreePath::for_agent(root, &agent);
        let lease = LeaseRecord {
            session_id: "sess".into(),
            agent_id: id.into(),
            parent_agent_id: None,
            task_id: "task".into(),
            repo_root: PathBuf::from("/tmp/repo"),
            base_ref: "refs/heads/main".into(),
            base_commit: "deadbeef".into(),
            branch_ref: BranchRef::for_agent("sess", id).unwrap(),
            worktree_path: wt,
            owner_pid: 1,
            owner_nonce: "n".into(),
            owner_start_time: None,
            process_group_id: None,
            heartbeat_at: now_unix_secs(),
            heartbeat_timeout_secs: 30,
            liveness_quiescent_secs: 60,
            wedge_grace_secs: 30,
            state,
            artifact_path: None,
            last_error: None,
            last_reaper_id: None,
            created_at: now_unix_secs(),
            updated_at: now_unix_secs(),
            schema_version: REGISTRY_SCHEMA_VERSION,
        };
        Registry::new(root.clone()).insert(lease).unwrap();
    }

    #[test]
    #[serial_test::serial(supervisor_registry)]
    fn working_leases_with_no_supervisor_are_adopted_to_draining() {
        supervisor_registry::reset_for_test();
        let (_tmp, root) = fresh_managed_root();
        insert_lease(&root, "orphan-1", AgentState::Working);
        insert_lease(&root, "orphan-2", AgentState::Ready);

        let report = adopt_orphan_leases(&root);
        assert_eq!(report.adopted, 2);
        assert!(report.failures.is_empty());

        let registry = Registry::new(root);
        assert_eq!(
            registry.get("orphan-1").unwrap().unwrap().state,
            AgentState::Draining
        );
        assert_eq!(
            registry.get("orphan-2").unwrap().unwrap().state,
            AgentState::Draining
        );
    }

    #[test]
    #[serial_test::serial(supervisor_registry)]
    fn drainer_mid_state_orphans_are_adopted_to_draining() {
        // H7 — Snapshotting/ArtifactWritten/WipRefWritten orphans
        // from a prior crash must be picked up by recovery so the
        // production drainer sweep can retry the idempotent chain.
        supervisor_registry::reset_for_test();
        let (_tmp, root) = fresh_managed_root();
        insert_lease(&root, "snap", AgentState::Snapshotting);
        insert_lease(&root, "artifact", AgentState::ArtifactWritten);
        insert_lease(&root, "wip", AgentState::WipRefWritten);

        let report = adopt_orphan_leases(&root);
        assert_eq!(report.adopted, 3);
        assert!(report.failures.is_empty());

        let registry = Registry::new(root);
        assert_eq!(
            registry.get("snap").unwrap().unwrap().state,
            AgentState::Draining
        );
        assert_eq!(
            registry.get("artifact").unwrap().unwrap().state,
            AgentState::Draining
        );
        assert_eq!(
            registry.get("wip").unwrap().unwrap().state,
            AgentState::Draining
        );
    }

    #[test]
    #[serial_test::serial(supervisor_registry)]
    fn merge_state_orphans_are_logged_not_adopted() {
        // H7 — MergeQueued/Merging/Merged/Removed/Preserved orphans
        // are not touched by recovery; user surfaces them via UI and
        // can manually abort/retry/approve.
        supervisor_registry::reset_for_test();
        let (_tmp, root) = fresh_managed_root();
        insert_lease(&root, "queued", AgentState::MergeQueued);
        insert_lease(&root, "merging", AgentState::Merging);

        let report = adopt_orphan_leases(&root);
        assert_eq!(report.adopted, 0);

        let registry = Registry::new(root);
        assert_eq!(
            registry.get("queued").unwrap().unwrap().state,
            AgentState::MergeQueued
        );
        assert_eq!(
            registry.get("merging").unwrap().unwrap().state,
            AgentState::Merging
        );
    }

    #[test]
    #[serial_test::serial(supervisor_registry)]
    fn terminal_state_leases_are_not_touched() {
        supervisor_registry::reset_for_test();
        let (_tmp, root) = fresh_managed_root();
        insert_lease(&root, "terminal-1", AgentState::GcDone);
        insert_lease(
            &root,
            "terminal-2",
            AgentState::PreserveFailed { reason: "nope".into() },
        );

        let report = adopt_orphan_leases(&root);
        assert_eq!(report.adopted, 0);

        let registry = Registry::new(root);
        assert_eq!(
            registry.get("terminal-1").unwrap().unwrap().state,
            AgentState::GcDone
        );
        // PreserveFailed retained
        assert!(matches!(
            registry.get("terminal-2").unwrap().unwrap().state,
            AgentState::PreserveFailed { .. }
        ));
    }
}
