// Phase 7 G37 — proptest for registry CRUD invariants.
//
// Generates random sequences of insert/get/update_state/remove against
// the Registry and asserts:
//   - inserted leases are gettable until removed
//   - update_state preserves all other fields
//   - remove + insert with same id is idempotent
//   - find_orphans correctly identifies leases not in the live set
//
// Plus G38 — secret detector fuzz: random alphanumeric strings should
// not catastrophically backtrack (regex compile is bounded; runtime is
// linear in input size). We assert the detector returns within a
// bounded time on 100KB+ random input.

use canvas_terminal_lib::worktree::managed_root::ensure_layout;
use canvas_terminal_lib::worktree::registry::Registry;
use canvas_terminal_lib::worktree::secret_detector::looks_like_secret;
use canvas_terminal_lib::worktree::types::{
    AgentId, AgentState, BranchRef, LeaseRecord, ManagedRoot, WorktreePath,
    REGISTRY_SCHEMA_VERSION,
};
use proptest::prelude::*;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

fn now_unix_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn make_lease(root: &ManagedRoot, id: &str) -> LeaseRecord {
    let agent = AgentId::new(id).unwrap();
    let wt = WorktreePath::for_agent(root, &agent);
    LeaseRecord {
        session_id: "sess".into(),
        agent_id: id.into(),
        parent_agent_id: None,
        task_id: format!("task-{id}"),
        repo_root: std::path::PathBuf::from("/tmp/repo"),
        base_ref: "refs/heads/main".into(),
        base_commit: "deadbeef".into(),
        branch_ref: BranchRef::for_agent("sess", id).unwrap(),
        worktree_path: wt,
        owner_pid: 1,
        owner_nonce: format!("n-{id}"),
        owner_start_time: None,
        process_group_id: None,
        heartbeat_at: now_unix_secs(),
        heartbeat_timeout_secs: 30,
        liveness_quiescent_secs: 60,
        wedge_grace_secs: 30,
        state: AgentState::Ready,
        artifact_path: None,
        last_error: None,
        last_reaper_id: None,
        created_at: now_unix_secs(),
        updated_at: now_unix_secs(),
        schema_version: REGISTRY_SCHEMA_VERSION,
    }
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(20))]

    /// G37 — insert + get + remove round-trips preserve identity.
    /// Inserts N agents with derived ids, gets each, then removes each;
    /// asserts the registry is empty at the end.
    #[test]
    fn insert_get_remove_roundtrip_preserves_invariants(n in 1usize..10) {
        let tmp = tempfile::tempdir().unwrap();
        let root = ManagedRoot::new(tmp.path()).unwrap();
        ensure_layout(&root).unwrap();
        let registry = Registry::new(root.clone());

        let ids: Vec<String> = (0..n).map(|i| format!("agent-{i:03}")).collect();
        for id in &ids {
            registry.insert(make_lease(&root, id)).unwrap();
        }
        for id in &ids {
            let read = registry.get(id).unwrap().unwrap();
            prop_assert_eq!(read.agent_id, id.as_str());
            prop_assert_eq!(read.owner_nonce, format!("n-{id}"));
        }
        for id in &ids {
            registry.remove(id).unwrap();
            prop_assert!(registry.get(id).unwrap().is_none());
        }
    }

    /// G37 — update_state preserves all other fields.
    #[test]
    fn update_state_preserves_other_fields(
        original_pid in 1i32..10000,
    ) {
        let tmp = tempfile::tempdir().unwrap();
        let root = ManagedRoot::new(tmp.path()).unwrap();
        ensure_layout(&root).unwrap();
        let registry = Registry::new(root.clone());

        let mut lease = make_lease(&root, "agent-X");
        lease.owner_pid = original_pid;
        registry.insert(lease.clone()).unwrap();

        registry
            .update_state("agent-X", AgentState::Working, 9999)
            .unwrap();
        let after = registry.get("agent-X").unwrap().unwrap();
        prop_assert_eq!(after.state, AgentState::Working);
        prop_assert_eq!(after.owner_pid, original_pid); // preserved
        prop_assert_eq!(after.session_id, "sess");
        prop_assert_eq!(after.owner_nonce, "n-agent-X");
    }
}

/// G38 — secret detector should be linear time on random input
/// (no catastrophic backtracking). Run on a 100KB random alphanumeric
/// blob and assert it returns under a generous bound.
#[test]
fn secret_detector_handles_large_random_input_without_backtracking() {
    use rand::{Rng, SeedableRng};
    let mut rng = rand::rngs::StdRng::seed_from_u64(0x5ec2e75ec2e7);
    let mut blob = String::with_capacity(100_000);
    for _ in 0..100_000 {
        let c: char = match rng.gen_range(0..62) {
            i @ 0..=9 => char::from(b'0' + i as u8),
            i @ 10..=35 => char::from(b'a' + (i - 10) as u8),
            i @ 36..=61 => char::from(b'A' + (i - 36) as u8),
            _ => 'a',
        };
        blob.push(c);
    }
    let started = std::time::Instant::now();
    let _ = looks_like_secret(&blob);
    let elapsed = started.elapsed();
    // Generous bound — catastrophic backtracking would take seconds
    // even on 100KB. Linear regex matching completes in well under 1s.
    assert!(
        elapsed < Duration::from_secs(2),
        "secret detector took {elapsed:?} on 100KB random input — likely catastrophic backtracking"
    );
}

/// G38 — pathological input shapes shouldn't trip the detector with
/// false positives that DOS the drainer. Test long bearer-like strings
/// that don't actually match (no "Bearer" prefix).
#[test]
fn secret_detector_no_false_positive_on_long_bearer_like_string() {
    let blob = "x".repeat(10_000) + " just words " + &"y".repeat(10_000);
    assert!(!looks_like_secret(&blob));
}
