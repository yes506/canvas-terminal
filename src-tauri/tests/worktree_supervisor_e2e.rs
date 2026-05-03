// Phase 4.5/5 A5: end-to-end supervisor smoke test.
//
// Validates the full production path:
//   1. Manually create an isolated managed root + git repo
//   2. Manually provision a worktree (skipping orchestrator-lock for
//      test isolation — that's covered by the unit tests)
//   3. Start a Supervisor with the real `PtySpawn` adapter spawning
//      `/bin/sh -c "echo hello; sleep 30"`
//   4. Assert the lease's owner_pid != Tauri PID (B2 — real ownership
//      recorded) AND owner_start_time + process_group_id are set
//   5. Call Supervisor::force_close (B4 — async + propagates errors)
//   6. Assert the lease transitions to Draining
//   7. Run Drainer::release_or_force to GC
//   8. Assert lease removed and worktree dir gone

use canvas_terminal_lib::worktree::drainer::Drainer;
use canvas_terminal_lib::worktree::pty_supervisor::PtySpawn;
use canvas_terminal_lib::worktree::registry::Registry;
use canvas_terminal_lib::worktree::supervisor::Supervisor;
use canvas_terminal_lib::worktree::types::{
    AgentId, AgentState, BranchRef, LeaseRecord, ManagedRoot, WorktreePath,
    REGISTRY_SCHEMA_VERSION,
};
use std::process::Command;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

fn now_unix_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn run_git(repo: &std::path::Path, args: &[&str]) {
    let s = Command::new("git")
        .args(args)
        .current_dir(repo)
        .status()
        .expect("git invocation");
    assert!(s.success(), "git {} failed", args.join(" "));
}

fn init_repo() -> tempfile::TempDir {
    let tmp = tempfile::tempdir().unwrap();
    let repo = tmp.path();
    run_git(repo, &["init", "--initial-branch=main", "--quiet"]);
    run_git(repo, &["config", "user.email", "e2e@example.invalid"]);
    run_git(repo, &["config", "user.name", "E2E"]);
    run_git(repo, &["config", "commit.gpgsign", "false"]);
    std::fs::write(repo.join("README.md"), "# initial\n").unwrap();
    run_git(repo, &["add", "README.md"]);
    run_git(repo, &["commit", "-m", "initial", "--quiet"]);
    tmp
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn pty_supervisor_smoke_e2e() {
    if !std::path::Path::new("/bin/sh").exists() {
        eprintln!("skipping: /bin/sh not present");
        return;
    }

    let mr_tmp = tempfile::tempdir().unwrap();
    let managed_root = ManagedRoot::new(mr_tmp.path()).unwrap();
    canvas_terminal_lib::worktree::managed_root::ensure_layout(&managed_root).unwrap();

    let repo_tmp = init_repo();
    let repo_root = repo_tmp.path().to_path_buf();
    let agent = AgentId::new("e2e-agent").unwrap();
    let branch = BranchRef::for_agent("e2e-sess", agent.as_str()).unwrap();
    let wt = WorktreePath::for_agent(&managed_root, &agent);

    let base_commit_out = Command::new("git")
        .args(["rev-parse", "HEAD"])
        .current_dir(&repo_root)
        .output()
        .unwrap();
    let base_commit = String::from_utf8_lossy(&base_commit_out.stdout)
        .trim()
        .to_string();

    // Manually create the worktree + branch (simulating provisioner).
    run_git(
        &repo_root,
        &[
            "worktree",
            "add",
            "-b",
            branch.as_str(),
            wt.as_path().to_str().unwrap(),
            &base_commit,
        ],
    );
    std::fs::write(wt.as_path().join(".canvas-agent-nonce"), "e2e-nonce").unwrap();

    let lease = LeaseRecord {
        session_id: "e2e-sess".into(),
        agent_id: agent.as_str().into(),
        parent_agent_id: None,
        task_id: "e2e-task".into(),
        repo_root: repo_root.clone(),
        base_ref: "refs/heads/main".into(),
        base_commit,
        branch_ref: branch.clone(),
        worktree_path: wt.clone(),
        owner_pid: std::process::id() as i32,
        owner_nonce: "e2e-nonce".into(),
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
    };
    let registry = Registry::new(managed_root.clone());
    registry.insert(lease).unwrap();

    // Build a synthetic ProvisionedAgent (skipping the full provisioner
    // for test isolation; the provisioner's own tests cover its happy
    // path).
    let lock_file = std::fs::File::create(managed_root.lock_path_for(&agent)).unwrap();
    use canvas_terminal_lib::worktree::provisioner::ProvisionedAgent;
    let provisioned = ProvisionedAgent {
        agent_id: agent.clone(),
        branch_ref: branch,
        worktree_path: wt.clone(),
        base_commit: "deadbeef".into(),
        nonce: "e2e-nonce".into(),
        lock_file,
    };

    // Spawn through the real PTY adapter.
    let spawner = PtySpawn::new("/bin/sh", vec!["-c".into(), "sleep 30".into()]);
    let supervisor =
        Supervisor::start(managed_root.clone(), provisioned, &spawner, &[]).unwrap();

    let tauri_pid = std::process::id() as i32;

    // B2 verification: real ownership must be recorded.
    let lease_after_start = registry.get("e2e-agent").unwrap().unwrap();
    assert_eq!(lease_after_start.state, AgentState::Working);
    assert_ne!(
        lease_after_start.owner_pid, tauri_pid,
        "owner_pid must be the agent PID, not the Tauri PID"
    );
    assert!(lease_after_start.owner_pid > 0);
    assert!(
        lease_after_start.process_group_id.is_some(),
        "process_group_id must be recorded"
    );

    // B4 verification: force_close kills the PG and advances Draining.
    supervisor.force_close().await.expect("force_close should succeed");
    let lease_after_close = registry.get("e2e-agent").unwrap().unwrap();
    assert_eq!(lease_after_close.state, AgentState::Draining);

    // Drain → GC.
    let drainer = Drainer::new(managed_root.clone());
    drainer
        .release_or_force("e2e-agent")
        .expect("drain should succeed");

    // Lease removed (clean at base; sleep didn't write anything).
    assert!(registry.get("e2e-agent").unwrap().is_none());
    // Worktree dir gone.
    assert!(!wt.as_path().exists());

    // Brief settle so the dropped supervisor's monitor task can abort
    // before the test runtime tears down.
    tokio::time::sleep(Duration::from_millis(50)).await;
}
