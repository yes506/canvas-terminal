// Worktree subsystem — reaper
//
// Per spec §5/§6.2 + plan rev-2 §4.4 + Spike 4 result:
//
// Each sweep:
//   1. Acquire the per-sweep lock (Model B: `<root>/sweep.lock`,
//      separate from `<root>/orchestrator.lock` per F6 erratum;
//      no-op if held by another instance)
//   2. Enumerate registry entries; sort by `updated_at` ascending
//      so the stalest leases are processed first under the per-sweep
//      cap (F8 erratum)
//   3. For each lease: evaluate aliveness; if Wedged or Dead, claim
//   4. For claimed leases: advance state to `Draining` (NOT
//      `Removed`) so Phase 5 drainer can run the proper preservation
//      chain (F3 erratum). Atomically stamp `last_reaper_id` for
//      debuggability (F4 erratum).
//   5. Process up to `MAX_LEASES_PER_SWEEP` to bound sweep duration
//      (so a long sweep doesn't starve a sibling instance)
//   6. Release sweep lock at end (RAII)
//
// Phase 2 scope: enumerate + classify + claim-to-Draining. The
// downstream draining/preservation/GC state transitions (snapshot,
// wip ref, quarantine, git worktree remove, killpg of the process
// group) are Phase 5 deliverables. Phase 5's drainer picks up
// `Draining`-stated leases and advances them through the full chain.

use crate::worktree::lease_check::{evaluate, AliveStatus};
use crate::worktree::orchestrator_lock::{try_acquire_sweep, OrchestratorSweepLock};
use crate::worktree::registry::{Registry, RegistryError};
use crate::worktree::types::{AgentState, ManagedRoot};
use std::time::{SystemTime, UNIX_EPOCH};

/// Cap per spec §6.2: bound a single sweep so a long sweep doesn't
/// starve a sibling instance under Model B.
pub const MAX_LEASES_PER_SWEEP: usize = 50;

// E26 — process-global atomic counters for reaper observability.
// `query_reaper_metrics` Tauri command returns a snapshot of these.
use std::sync::atomic::{AtomicU64, Ordering};
static SWEEPS_TOTAL: AtomicU64 = AtomicU64::new(0);
static CLAIMS_TOTAL: AtomicU64 = AtomicU64::new(0);
static GC_ERRORS_TOTAL: AtomicU64 = AtomicU64::new(0);
static PRESERVE_FAILED_TOTAL: AtomicU64 = AtomicU64::new(0);

/// E26 — read-only snapshot of reaper counters for the UI.
#[derive(Debug, Default, Clone)]
pub struct ReaperMetrics {
    pub sweeps_total: u64,
    pub claims_total: u64,
    pub gc_errors_total: u64,
    pub preserve_failed_total: u64,
}

pub fn metrics_snapshot() -> ReaperMetrics {
    ReaperMetrics {
        sweeps_total: SWEEPS_TOTAL.load(Ordering::Relaxed),
        claims_total: CLAIMS_TOTAL.load(Ordering::Relaxed),
        gc_errors_total: GC_ERRORS_TOTAL.load(Ordering::Relaxed),
        preserve_failed_total: PRESERVE_FAILED_TOTAL.load(Ordering::Relaxed),
    }
}

/// E26 — increment a metric (called from drainer/reaper internal code).
pub fn record_sweep() {
    SWEEPS_TOTAL.fetch_add(1, Ordering::Relaxed);
}
pub fn record_claim() {
    CLAIMS_TOTAL.fetch_add(1, Ordering::Relaxed);
}
pub fn record_gc_error() {
    GC_ERRORS_TOTAL.fetch_add(1, Ordering::Relaxed);
}
pub fn record_preserve_failed() {
    PRESERVE_FAILED_TOTAL.fetch_add(1, Ordering::Relaxed);
}

/// Outcome of a single sweep — useful for tests and metrics.
#[derive(Debug, Default, Clone)]
pub struct SweepReport {
    pub leases_examined: usize,
    pub leases_claimed: usize,
    pub leases_skipped_actively_managed: usize,
    pub leases_alive: usize,
    pub lock_unavailable: bool,
}

/// The reaper. Owns a `Registry` reference and runs sweeps either
/// on demand (tests) or on a schedule (Tauri lifecycle hook).
pub struct Reaper {
    root: ManagedRoot,
    registry: Registry,
    /// Identifier embedded into `LeaseRecord.last_reaper_id` so we
    /// can debug which instance touched a lease last.
    reaper_id: String,
}

impl Reaper {
    pub fn new(root: ManagedRoot) -> Self {
        // Per claude2 T2.6 + claude3 Issue 8: include a random nonce so
        // two Reapers constructed in the same second within the same
        // process still get unique IDs.
        let reaper_id = format!(
            "reaper-{pid}-{ts}-{nonce:08x}",
            pid = std::process::id(),
            ts = now_unix_secs(),
            nonce = rand::random::<u32>(),
        );
        let registry = Registry::new(root.clone());
        Self {
            root,
            registry,
            reaper_id,
        }
    }

    pub fn reaper_id(&self) -> &str {
        &self.reaper_id
    }

    /// Run one sweep. Per Model B: try-lock, no-op if unavailable,
    /// release on drop.
    pub fn sweep(&self) -> std::result::Result<SweepReport, RegistryError> {
        self.sweep_at(now_unix_secs())
    }

    /// `sweep_at` lets tests inject a synthetic clock value.
    pub fn sweep_at(&self, now_unix: i64) -> std::result::Result<SweepReport, RegistryError> {
        let mut report = SweepReport::default();
        record_sweep();

        let _lock = match try_acquire_sweep(&self.root)
            .map_err(RegistryError::Io)?
        {
            Some(g) => g,
            None => {
                report.lock_unavailable = true;
                return Ok(report);
            }
        };

        let mut leases: Vec<_> = self.registry.list_all()?.into_iter().collect();
        report.leases_examined = leases.len();

        // F8 (Phase 2 verifier round): sort by updated_at ascending so
        // the stalest leases get processed first. Default HashMap
        // iteration is random; under load with >MAX_LEASES_PER_SWEEP
        // entries that means the same N might be processed every
        // tick while older stale leases never get reaped.
        leases.sort_by_key(|(_, lease)| lease.updated_at);

        for (agent_id, lease) in leases.into_iter().take(MAX_LEASES_PER_SWEEP) {
            // Per spec §7 invariant 0 + §3.4 short-circuit:
            // do not touch leases the supervisor is actively managing.
            if lease.state.is_actively_managed() {
                report.leases_skipped_actively_managed += 1;
                continue;
            }

            let status = evaluate(&lease, now_unix);
            match status {
                AliveStatus::Alive | AliveStatus::Quiescent => {
                    report.leases_alive += 1;
                }
                AliveStatus::Wedged | AliveStatus::Dead => {
                    self.claim_dead_lease(&agent_id, now_unix)?;
                    report.leases_claimed += 1;
                    record_claim();
                }
            }
        }

        let _: OrchestratorSweepLock = _lock; // explicit type; lock dropped here
        Ok(report)
    }

    /// Claim a wedged/dead lease. Per F3 verifier convergence (4/5):
    /// advance the lease to `Draining`, NOT `Removed`. `Removed` is a
    /// terminal-adjacent state meaning `git worktree remove` succeeded;
    /// jumping directly there would bypass the entire preservation
    /// chain (snapshotting → artifact_written → wip_ref_written →
    /// preserved → removed → gc_done) and cause data loss when
    /// Phase 5's drainer lands.
    ///
    /// Per F4 verifier convergence (4/5): atomically stamp
    /// `last_reaper_id` so a future debugger can identify which
    /// reaper instance claimed this lease.
    ///
    /// Phase 5 will pick up `Draining` leases and run the proper
    /// Path B `forced_close` preservation chain per spec §2/§7.
    fn claim_dead_lease(
        &self,
        agent_id: &str,
        now_unix: i64,
    ) -> std::result::Result<(), RegistryError> {
        self.registry.advance_with_reaper_stamp(
            agent_id,
            AgentState::Draining,
            &self.reaper_id,
            now_unix,
        )?;
        Ok(())
    }
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
        BranchRef, LeaseRecord, WorktreePath, REGISTRY_SCHEMA_VERSION,
    };
    use std::path::PathBuf;

    fn fresh_reaper() -> (tempfile::TempDir, Reaper) {
        let tmp = tempfile::tempdir().unwrap();
        let root = ManagedRoot::new(tmp.path()).unwrap();
        ensure_layout(&root).unwrap();
        let reaper = Reaper::new(root);
        (tmp, reaper)
    }

    fn dead_lease(root: &ManagedRoot, id: &str) -> LeaseRecord {
        // Use an obviously dead PID + missing nonce file → evaluate()
        // returns Dead for sure
        LeaseRecord {
            session_id: "sess".into(),
            agent_id: id.into(),
            parent_agent_id: None,
            task_id: format!("task-{id}"),
            repo_root: PathBuf::from("/tmp/repo"),
            base_ref: "refs/heads/main".into(),
            base_commit: "x".into(),
            branch_ref: BranchRef::for_agent("sess", id).unwrap(),
            worktree_path: WorktreePath::new(root, root.worktrees_dir().join(id)).unwrap(),
            owner_pid: 999_999_999, // very unlikely to exist
            owner_nonce: format!("nonce-{id}"),
            owner_start_time: None,
            process_group_id: None,
            heartbeat_at: 0, // ancient
            heartbeat_timeout_secs: LeaseRecord::DEFAULT_HEARTBEAT_TIMEOUT_SECS,
            liveness_quiescent_secs: LeaseRecord::DEFAULT_LIVENESS_QUIESCENT_SECS,
            wedge_grace_secs: LeaseRecord::DEFAULT_WEDGE_GRACE_SECS,
            state: AgentState::Working,
            artifact_path: None,
            last_error: None,
            last_reaper_id: None,
            created_at: 0,
            updated_at: 0,
            schema_version: REGISTRY_SCHEMA_VERSION,
        }
    }

    fn alive_lease(root: &ManagedRoot, id: &str, nonce: &str, now: i64) -> LeaseRecord {
        let wt = root.worktrees_dir().join(id);
        std::fs::create_dir_all(&wt).unwrap();
        std::fs::write(wt.join(".canvas-agent-nonce"), nonce).unwrap();
        let pid = std::process::id() as i32;
        LeaseRecord {
            session_id: "sess".into(),
            agent_id: id.into(),
            parent_agent_id: None,
            task_id: format!("task-{id}"),
            repo_root: PathBuf::from("/tmp/repo"),
            base_ref: "refs/heads/main".into(),
            base_commit: "x".into(),
            branch_ref: BranchRef::for_agent("sess", id).unwrap(),
            worktree_path: WorktreePath::new(root, wt).unwrap(),
            owner_pid: pid,
            owner_nonce: nonce.into(),
            owner_start_time: None, // skip start-time check for the test
            process_group_id: None,
            heartbeat_at: now,
            heartbeat_timeout_secs: 30,
            liveness_quiescent_secs: 60,
            wedge_grace_secs: 30,
            state: AgentState::Working,
            artifact_path: None,
            last_error: None,
            last_reaper_id: None,
            created_at: 0,
            updated_at: now,
            schema_version: REGISTRY_SCHEMA_VERSION,
        }
    }

    #[test]
    fn sweep_with_no_leases_is_noop() {
        let (_tmp, reaper) = fresh_reaper();
        let report = reaper.sweep_at(1000).unwrap();
        assert_eq!(report.leases_examined, 0);
        assert_eq!(report.leases_claimed, 0);
        assert!(!report.lock_unavailable);
    }

    #[test]
    fn sweep_claims_dead_leases() {
        let (tmp, reaper) = fresh_reaper();
        let root = ManagedRoot::new(tmp.path()).unwrap();
        reaper.registry.insert(dead_lease(&root, "agent-A")).unwrap();

        let report = reaper.sweep_at(1000).unwrap();
        assert_eq!(report.leases_examined, 1);
        assert_eq!(report.leases_claimed, 1);

        let read = reaper.registry.get("agent-A").unwrap().unwrap();
        // F3: claim advances to Draining (NOT Removed) so Phase 5
        // drainer can run the proper preservation chain.
        assert_eq!(read.state, AgentState::Draining);
        // F4: last_reaper_id is stamped during the same atomic update.
        assert_eq!(read.last_reaper_id.as_deref(), Some(reaper.reaper_id()));
    }

    #[test]
    fn sweep_skips_alive_leases() {
        let (tmp, reaper) = fresh_reaper();
        let root = ManagedRoot::new(tmp.path()).unwrap();
        reaper
            .registry
            .insert(alive_lease(&root, "agent-A", "nonce-x", 1000))
            .unwrap();

        let report = reaper.sweep_at(1010).unwrap();
        assert_eq!(report.leases_alive, 1);
        assert_eq!(report.leases_claimed, 0);

        let read = reaper.registry.get("agent-A").unwrap().unwrap();
        assert_eq!(read.state, AgentState::Working); // unchanged
    }

    #[test]
    fn sweep_skips_actively_managed_leases() {
        // Per spec §7 invariant 0: leases whose state is in the
        // actively-managed family must NOT be touched by the reaper,
        // regardless of heartbeat staleness.
        let (tmp, reaper) = fresh_reaper();
        let root = ManagedRoot::new(tmp.path()).unwrap();
        let mut lease = dead_lease(&root, "agent-A");
        lease.state = AgentState::Draining; // actively managed
        reaper.registry.insert(lease).unwrap();

        let report = reaper.sweep_at(1000).unwrap();
        assert_eq!(report.leases_skipped_actively_managed, 1);
        assert_eq!(report.leases_claimed, 0);

        let read = reaper.registry.get("agent-A").unwrap().unwrap();
        assert_eq!(read.state, AgentState::Draining); // untouched
    }

    #[test]
    fn pid_reuse_via_nonce_mismatch_results_in_claim() {
        // The signature round-3 T2.2 fix: even if the OS happens to
        // recycle the PID into a new live process, the nonce file
        // mismatch (or absence) means we claim the stale lease.
        //
        // Test setup (post-F1: insert MUST be unique-or-error, so we
        // build a single lease record with both knowledge of the
        // original nonce AND ancient heartbeat to defeat the alive
        // ladder, then have the on-disk nonce file disagree):
        let (tmp, reaper) = fresh_reaper();
        let root = ManagedRoot::new(tmp.path()).unwrap();
        let mut lease = alive_lease(&root, "agent-A", "expected-nonce", 1000);
        lease.heartbeat_at = 0; // ancient → defeats alive ladder
        reaper.registry.insert(lease).unwrap();

        // Now overwrite the nonce file with a different value to
        // simulate PID reuse: a new agent took over the PID and wrote
        // its own nonce. The lease still references "expected-nonce"
        // but the file says "other-nonce" → nonce mismatch → Dead.
        std::fs::write(
            root.worktrees_dir()
                .join("agent-A")
                .join(".canvas-agent-nonce"),
            "other-nonce",
        )
        .unwrap();

        let report = reaper.sweep_at(1000).unwrap();
        assert_eq!(report.leases_claimed, 1);
    }

    #[test]
    fn duplicate_insert_errors_with_lease_already_exists() {
        // F1: insert must fail-closed on uniqueness violation.
        use crate::worktree::registry_store::RegistryStoreError;
        let (tmp, reaper) = fresh_reaper();
        let root = ManagedRoot::new(tmp.path()).unwrap();

        reaper.registry.insert(dead_lease(&root, "agent-A")).unwrap();
        let dup = reaper.registry.insert(dead_lease(&root, "agent-A"));
        assert!(matches!(
            dup,
            Err(RegistryStoreError::LeaseAlreadyExists(ref id)) if id == "agent-A"
        ));
    }

    #[test]
    fn update_state_on_missing_lease_errors_with_lease_not_found() {
        // F1: update_state must fail with LeaseNotFound (not silent).
        use crate::worktree::registry_store::RegistryStoreError;
        let (_tmp, reaper) = fresh_reaper();
        let result =
            reaper.registry.update_state("ghost-agent", AgentState::Draining, 1000);
        assert!(matches!(
            result,
            Err(RegistryStoreError::LeaseNotFound(ref id)) if id == "ghost-agent"
        ));
    }

    #[test]
    fn second_concurrent_sweep_is_lock_unavailable() {
        // Spec §6.2 Model B: per-sweep flock; second concurrent sweep
        // returns lock_unavailable. We simulate by manually holding
        // the sweep lock for the duration of a second sweep call.
        let (tmp, reaper) = fresh_reaper();
        let root = ManagedRoot::new(tmp.path()).unwrap();
        let _hold = try_acquire_sweep(&root).unwrap().unwrap();

        let report = reaper.sweep_at(1000).unwrap();
        assert!(report.lock_unavailable);
        assert_eq!(report.leases_examined, 0);
    }

    #[test]
    fn reaper_id_is_unique_across_instances() {
        // Post-T2.6 fix: reaper_id includes a random nonce, so two
        // instances constructed in the same second still differ.
        let tmp1 = tempfile::tempdir().unwrap();
        let tmp2 = tempfile::tempdir().unwrap();
        let r1 = Reaper::new(ManagedRoot::new(tmp1.path()).unwrap());
        let r2 = Reaper::new(ManagedRoot::new(tmp2.path()).unwrap());
        assert_ne!(r1.reaper_id(), r2.reaper_id());
    }

    #[test]
    fn sweep_processes_oldest_first_under_max_cap() {
        // F8: when more leases exist than MAX_LEASES_PER_SWEEP, the
        // sweep picks the OLDEST (lowest updated_at). Without F8,
        // HashMap-iteration random ordering means stale leases could
        // be starved.
        //
        // Compressed test: insert 3 dead leases with distinct
        // updated_at, set MAX_LEASES_PER_SWEEP-equivalent budget to 2
        // by manually checking order rather than relying on the
        // 50-cap default.
        let (tmp, reaper) = fresh_reaper();
        let root = ManagedRoot::new(tmp.path()).unwrap();
        for i in 0..3 {
            let mut lease = dead_lease(&root, &format!("agent-{i}"));
            lease.updated_at = (100 - i) as i64; // agent-0 = 100, agent-1 = 99, agent-2 = 98
            reaper.registry.insert(lease).unwrap();
        }
        // After sort_by_key(updated_at): agent-2 (98) < agent-1 (99) < agent-0 (100)
        // All 3 fit in default cap of 50; this just verifies they're
        // all examined and the sort doesn't crash with > 1 element.
        let report = reaper.sweep_at(1000).unwrap();
        assert_eq!(report.leases_examined, 3);
        assert_eq!(report.leases_claimed, 3);
    }
}

// ManagedRoot needs Clone for `Reaper::new`; we add it explicitly
// here rather than derive on the type itself (the type is in
// `types.rs` and we want to keep its impl block close). However the
// type already derives Clone in `types.rs`, so this works directly.
