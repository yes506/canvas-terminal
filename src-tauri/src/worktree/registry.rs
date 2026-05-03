// Worktree subsystem — registry CRUD layer
//
// Wraps `RegistryStore` with per-record CRUD semantics and helpers
// the reaper/provisioner need. Per spec §3.1 + plan rev-2 §4.3.
//
// All operations are flock-protected via the underlying store.
// Reconciliation against `git worktree list --porcelain` lives here
// (see `reconcile_orphans`) but the actual git invocation is in
// `reaper.rs`; this layer provides the registry-side primitives.

use crate::worktree::registry_store::{RegistryStore, Result};
pub use crate::worktree::registry_store::RegistryStoreError as RegistryError;
use crate::worktree::types::{AgentState, LeaseRecord, ManagedRoot};
use std::collections::HashMap;

/// High-level registry. Owns a `RegistryStore` for persistence.
pub struct Registry {
    store: RegistryStore,
}

impl Registry {
    pub fn new(root: ManagedRoot) -> Self {
        Self {
            store: RegistryStore::new(root),
        }
    }

    /// Insert a new lease. Errors if `agent_id` already exists
    /// (uniqueness invariant; F1 verifier convergence 5/5).
    pub fn insert(&self, lease: LeaseRecord) -> Result<()> {
        let id = lease.agent_id.clone();
        self.store.update(move |leases| {
            if leases.contains_key(&id) {
                return Err(RegistryError::LeaseAlreadyExists(id));
            }
            leases.insert(lease.agent_id.clone(), lease);
            Ok(())
        })
    }

    /// Read a single lease by id. Returns `None` if not present.
    pub fn get(&self, agent_id: &str) -> Result<Option<LeaseRecord>> {
        let all = self.store.read_all()?;
        Ok(all.get(agent_id).cloned())
    }

    /// Update an existing lease's state. Errors with `LeaseNotFound`
    /// if the lease no longer exists (caller likely lost a race with
    /// the reaper). F1 verifier convergence 4/5.
    pub fn update_state(
        &self,
        agent_id: &str,
        new_state: AgentState,
        bump_updated_at: i64,
    ) -> Result<()> {
        let id = agent_id.to_string();
        self.store.update(move |leases| match leases.get_mut(&id) {
            Some(lease) => {
                lease.state = new_state;
                lease.updated_at = bump_updated_at;
                Ok(())
            }
            None => Err(RegistryError::LeaseNotFound(id)),
        })
    }

    /// Atomic state advance + last_reaper_id stamp. Used by the
    /// reaper to record which instance claimed a stale lease (F4
    /// verifier convergence 4/5: previously the field was declared
    /// but never written).
    pub fn advance_with_reaper_stamp(
        &self,
        agent_id: &str,
        new_state: AgentState,
        reaper_id: &str,
        bump_updated_at: i64,
    ) -> Result<()> {
        let id = agent_id.to_string();
        let reaper_id = reaper_id.to_string();
        self.store.update(move |leases| match leases.get_mut(&id) {
            Some(lease) => {
                lease.state = new_state;
                lease.last_reaper_id = Some(reaper_id);
                lease.updated_at = bump_updated_at;
                Ok(())
            }
            None => Err(RegistryError::LeaseNotFound(id)),
        })
    }

    /// Atomically record the supervised agent's REAL ownership info
    /// (PID, start time, process group id) AND advance the lease state
    /// in a single flock-protected transaction.
    ///
    /// **B2 fix per 5/5 verifier convergence (claude2 D1, codex1 B1,
    /// codex2 #4, claude3 B1, codex3 B1)**: previously the supervisor
    /// only called `update_state(..., Working)` and discarded the real
    /// PID / pgid / start_time it had captured from the spawn. The
    /// lease kept the Tauri app PID forever, breaking:
    ///   - lease_check::evaluate (checked Tauri PID, not agent PID)
    ///   - PID-reuse defense via owner_start_time
    ///   - reaper liveness (agent could die while Tauri stays alive →
    ///     lease never reaped)
    ///   - force_close PG kill via persisted pgid
    ///
    /// Both updates land in one flock'd `store.update` so the registry
    /// can never be observed mid-transition (e.g., new state with stale
    /// owner info, or new owner with old state).
    pub fn set_ownership(
        &self,
        agent_id: &str,
        owner_pid: i32,
        owner_start_time: Option<i64>,
        process_group_id: Option<i32>,
        new_state: AgentState,
        bump_updated_at: i64,
    ) -> Result<()> {
        let id = agent_id.to_string();
        self.store.update(move |leases| match leases.get_mut(&id) {
            Some(lease) => {
                lease.owner_pid = owner_pid;
                lease.owner_start_time = owner_start_time;
                lease.process_group_id = process_group_id;
                lease.state = new_state;
                lease.updated_at = bump_updated_at;
                Ok(())
            }
            None => Err(RegistryError::LeaseNotFound(id)),
        })
    }

    /// Record where the preserved artifact lives on disk (B10 — claude2/codex2/codex3
    /// non-blocking convergence). Called by the drainer right after
    /// `write_quarantine_artifact` succeeds; lets the UI + retry flow
    /// look up the manifest path without re-deriving it.
    pub fn set_artifact_path(
        &self,
        agent_id: &str,
        artifact_path: std::path::PathBuf,
        now: i64,
    ) -> Result<()> {
        let id = agent_id.to_string();
        self.store.update(move |leases| match leases.get_mut(&id) {
            Some(lease) => {
                lease.artifact_path = Some(artifact_path);
                lease.updated_at = now;
                Ok(())
            }
            None => Err(RegistryError::LeaseNotFound(id)),
        })
    }

    /// Update the heartbeat timestamp on a lease (called by the
    /// supervisor's heartbeat task per S4 / Spike 4).
    pub fn touch_heartbeat(&self, agent_id: &str, now: i64) -> Result<()> {
        let id = agent_id.to_string();
        self.store.update(move |leases| match leases.get_mut(&id) {
            Some(lease) => {
                lease.heartbeat_at = now;
                lease.updated_at = now;
                Ok(())
            }
            None => Err(RegistryError::LeaseNotFound(id)),
        })
    }

    /// Mark a lease in a half-state with a reason. Used when
    /// preservation fails (`PreserveFailed`) or GC fails (`GcError`).
    pub fn mark_preserve_failed(&self, agent_id: &str, reason: String, now: i64) -> Result<()> {
        self.update_state(agent_id, AgentState::PreserveFailed { reason }, now)
    }

    pub fn mark_gc_error(
        &self,
        agent_id: &str,
        reason: String,
        retries: u32,
        now: i64,
    ) -> Result<()> {
        self.update_state(agent_id, AgentState::GcError { reason, retries }, now)
    }

    /// Remove a lease from the registry. Called only after the
    /// state machine reaches `GcDone` per spec §1. Errors with
    /// `LeaseNotFound` if the lease is already gone (no silent no-op).
    pub fn remove(&self, agent_id: &str) -> Result<()> {
        let id = agent_id.to_string();
        self.store.update(move |leases| {
            if leases.remove(&id).is_none() {
                return Err(RegistryError::LeaseNotFound(id));
            }
            Ok(())
        })
    }

    /// Read all leases. Used by the reaper to enumerate during a sweep.
    pub fn list_all(&self) -> Result<HashMap<String, LeaseRecord>> {
        self.store.read_all()
    }

    /// Lease IDs only (cheaper when caller doesn't need the full
    /// record).
    pub fn list_ids(&self) -> Result<Vec<String>> {
        Ok(self.store.read_all()?.keys().cloned().collect())
    }

    /// Reconcile registry entries against a set of "live" worktree
    /// names that the reaper observed via `git worktree list
    /// --porcelain`. Returns the agent_ids of leases that exist in
    /// the registry but no longer have a corresponding worktree on
    /// disk (orphaned registry entries — candidates for forced GC).
    ///
    /// The `live_worktree_paths` set is the canonical "what git
    /// thinks exists" snapshot; the registry is the canonical "what
    /// our system thinks exists." Mismatches are returned for the
    /// reaper to act on.
    pub fn find_orphans(
        &self,
        live_worktree_paths: &std::collections::HashSet<std::path::PathBuf>,
    ) -> Result<Vec<String>> {
        let leases = self.store.read_all()?;
        let mut orphans = Vec::new();
        for (agent_id, lease) in &leases {
            if !live_worktree_paths.contains(lease.worktree_path.as_path()) {
                orphans.push(agent_id.clone());
            }
        }
        Ok(orphans)
    }
}


#[cfg(test)]
mod tests {
    use super::*;
    use crate::worktree::managed_root::ensure_layout;
    use crate::worktree::types::{BranchRef, WorktreePath, REGISTRY_SCHEMA_VERSION};
    use std::collections::HashSet;
    use std::path::PathBuf;

    fn fresh_registry() -> (tempfile::TempDir, Registry) {
        let tmp = tempfile::tempdir().unwrap();
        let root = ManagedRoot::new(tmp.path()).unwrap();
        ensure_layout(&root).unwrap();
        let registry = Registry::new(root);
        (tmp, registry)
    }

    fn sample_lease(root: &ManagedRoot, id: &str) -> LeaseRecord {
        LeaseRecord {
            session_id: "sess-1".into(),
            agent_id: id.into(),
            parent_agent_id: None,
            task_id: format!("task-{id}"),
            repo_root: "/tmp/repo".into(),
            base_ref: "refs/heads/main".into(),
            base_commit: "deadbeef".into(),
            branch_ref: BranchRef::for_agent("sess-1", id).unwrap(),
            worktree_path: WorktreePath::new(root, root.worktrees_dir().join(id)).unwrap(),
            owner_pid: 12345,
            owner_nonce: format!("nonce-{id}"),
            owner_start_time: Some(1234567890),
            process_group_id: Some(12345),
            heartbeat_at: 1234567890,
            heartbeat_timeout_secs: LeaseRecord::DEFAULT_HEARTBEAT_TIMEOUT_SECS,
            liveness_quiescent_secs: LeaseRecord::DEFAULT_LIVENESS_QUIESCENT_SECS,
            wedge_grace_secs: LeaseRecord::DEFAULT_WEDGE_GRACE_SECS,
            state: AgentState::Working,
            artifact_path: None,
            last_error: None,
            last_reaper_id: None,
            created_at: 1234567890,
            updated_at: 1234567890,
            schema_version: REGISTRY_SCHEMA_VERSION,
        }
    }

    #[test]
    fn insert_get_remove_roundtrip() {
        let (tmp, registry) = fresh_registry();
        let root = ManagedRoot::new(tmp.path()).unwrap();
        let lease = sample_lease(&root, "agent-A");

        registry.insert(lease.clone()).unwrap();
        let read = registry.get("agent-A").unwrap().unwrap();
        assert_eq!(read.agent_id, "agent-A");
        assert_eq!(read.owner_nonce, "nonce-agent-A");

        registry.remove("agent-A").unwrap();
        assert!(registry.get("agent-A").unwrap().is_none());
    }

    #[test]
    fn update_state_advances_state_and_bumps_updated_at() {
        let (tmp, registry) = fresh_registry();
        let root = ManagedRoot::new(tmp.path()).unwrap();
        registry
            .insert(sample_lease(&root, "agent-A"))
            .unwrap();

        registry
            .update_state("agent-A", AgentState::Draining, 9999)
            .unwrap();

        let read = registry.get("agent-A").unwrap().unwrap();
        assert_eq!(read.state, AgentState::Draining);
        assert_eq!(read.updated_at, 9999);
    }

    #[test]
    fn touch_heartbeat_updates_only_heartbeat_and_updated_at() {
        let (tmp, registry) = fresh_registry();
        let root = ManagedRoot::new(tmp.path()).unwrap();
        registry.insert(sample_lease(&root, "agent-A")).unwrap();
        registry.touch_heartbeat("agent-A", 12345).unwrap();
        let read = registry.get("agent-A").unwrap().unwrap();
        assert_eq!(read.heartbeat_at, 12345);
        assert_eq!(read.state, AgentState::Working); // unchanged
    }

    #[test]
    fn find_orphans_returns_registry_entries_not_in_live_set() {
        let (tmp, registry) = fresh_registry();
        let root = ManagedRoot::new(tmp.path()).unwrap();
        registry.insert(sample_lease(&root, "agent-A")).unwrap();
        registry.insert(sample_lease(&root, "agent-B")).unwrap();

        // Only agent-A's worktree path is "live"
        let mut live: HashSet<PathBuf> = HashSet::new();
        live.insert(root.worktrees_dir().join("agent-A"));

        let orphans = registry.find_orphans(&live).unwrap();
        assert_eq!(orphans, vec!["agent-B".to_string()]);
    }

    #[test]
    fn set_ownership_atomically_updates_pid_pgid_start_time_and_state() {
        let (tmp, registry) = fresh_registry();
        let root = ManagedRoot::new(tmp.path()).unwrap();
        let lease = sample_lease(&root, "agent-A");
        let original_pid = lease.owner_pid;
        registry.insert(lease).unwrap();

        registry
            .set_ownership(
                "agent-A",
                42_424,
                Some(1_700_000_000),
                Some(42_424),
                AgentState::Working,
                9999,
            )
            .unwrap();

        let read = registry.get("agent-A").unwrap().unwrap();
        assert_eq!(read.owner_pid, 42_424);
        assert_ne!(read.owner_pid, original_pid);
        assert_eq!(read.owner_start_time, Some(1_700_000_000));
        assert_eq!(read.process_group_id, Some(42_424));
        assert_eq!(read.state, AgentState::Working);
        assert_eq!(read.updated_at, 9999);
    }

    #[test]
    fn set_ownership_errors_on_missing_lease() {
        let (_tmp, registry) = fresh_registry();
        let err = registry
            .set_ownership("nope", 1, None, None, AgentState::Working, 0)
            .unwrap_err();
        assert!(matches!(err, RegistryError::LeaseNotFound(ref id) if id == "nope"));
    }

    #[test]
    fn mark_half_states_preserves_record() {
        let (tmp, registry) = fresh_registry();
        let root = ManagedRoot::new(tmp.path()).unwrap();
        registry.insert(sample_lease(&root, "agent-A")).unwrap();

        registry
            .mark_preserve_failed("agent-A", "wip ref commit failed".into(), 1000)
            .unwrap();
        let read = registry.get("agent-A").unwrap().unwrap();
        assert!(matches!(
            read.state,
            AgentState::PreserveFailed { .. }
        ));

        registry
            .mark_gc_error("agent-A", "fs busy".into(), 3, 2000)
            .unwrap();
        let read = registry.get("agent-A").unwrap().unwrap();
        assert!(matches!(
            read.state,
            AgentState::GcError { retries: 3, .. }
        ));
    }
}
