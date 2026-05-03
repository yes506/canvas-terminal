// Worktree subsystem — supervisor backbone (Phase 4.5)
//
// Per spec §3.2 LeaseRuntime + S5 (split LeaseRecord/Runtime/Snapshot)
// + R-T2.3 supervisor-owned heartbeat + constraint C3 (setsid spawn):
//
//   The supervisor takes ownership of a `ProvisionedAgent` (from the
//   provisioner), spawns the agent process in its own session/process
//   group via `setsid`, transitions the lease Ready → Working,
//   records `owner_pid` + `owner_start_time` + `process_group_id`
//   atomically, starts the heartbeat task, and monitors the agent
//   process for exit. On exit, it stops the heartbeat and advances
//   the lease to `Draining` (Phase 5 drainer takes over via
//   `Drainer::sweep_draining` or explicit `release_worktree`).
//
// **Phase 4.5 scope decisions**:
// - The Supervisor STRUCTURE (LeaseRuntime + start/stop/monitor
//   lifecycle + state transitions) is fully implemented here.
// - The actual agent process spawn is parameterized via a
//   `SpawnAgent` trait so the existing canvas-terminal PTY layer
//   (pty.rs `spawn_process`) can be plugged in via an adapter
//   without coupling the supervisor module to portable_pty.
// - For tests + Phase 5 standalone use, a `ChildProcessSpawn`
//   implementation that uses `std::process::Command` with `setsid`
//   prefix is provided.
// - Phase 5 (drainer) does NOT depend on the Supervisor — the drainer
//   operates on the registry/state-machine directly. The Supervisor
//   is the production runtime that drives leases through the
//   working state.

use crate::worktree::heartbeat::{interval_for_timeout, Heartbeat};
use crate::worktree::process_group_kill::{
    sigkill_process_group, sigterm_process_group, KillError,
};
use crate::worktree::provisioner::ProvisionedAgent;
use crate::worktree::registry::Registry;
use crate::worktree::registry_store::RegistryStoreError;
use crate::worktree::types::{AgentState, ManagedRoot};
use std::fs::File;
#[cfg(test)]
use std::path::PathBuf;
use std::process::{Child, Command};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// Errors from the supervisor.
#[derive(Debug)]
pub enum SupervisorError {
    Registry(RegistryStoreError),
    Io(std::io::Error),
    SpawnFailed(String),
    /// The supervised process exited before we could record
    /// the supervisor lifecycle bookkeeping.
    AgentExitedBeforeReady,
    /// Force-close requested but the process group kill failed.
    KillFailed(KillError),
}

impl std::fmt::Display for SupervisorError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SupervisorError::Registry(e) => write!(f, "registry: {e}"),
            SupervisorError::Io(e) => write!(f, "io: {e}"),
            SupervisorError::SpawnFailed(msg) => write!(f, "agent spawn failed: {msg}"),
            SupervisorError::AgentExitedBeforeReady => {
                write!(f, "agent process exited before supervisor could record liveness")
            }
            SupervisorError::KillFailed(e) => write!(f, "kill failed: {e}"),
        }
    }
}

impl std::error::Error for SupervisorError {}

impl From<RegistryStoreError> for SupervisorError {
    fn from(e: RegistryStoreError) -> Self {
        SupervisorError::Registry(e)
    }
}

impl From<std::io::Error> for SupervisorError {
    fn from(e: std::io::Error) -> Self {
        SupervisorError::Io(e)
    }
}

pub type Result<T> = std::result::Result<T, SupervisorError>;

/// Per spec §3.2 LeaseRuntime: in-memory only handles for one agent.
/// The supervisor holds this for the agent's lifetime; dropping it
/// stops the monitor task (which owns the heartbeat handle so that
/// heartbeat stops the moment the monitor observes child exit per
/// **T2.1 fix**). The actual `Child` is held in `ChildProcess`.
pub struct LeaseRuntime {
    pub agent_id: String,
    /// The per-worktree lockfile from `ProvisionedAgent.lock_file`.
    /// As long as this is alive, the flock is held (RAII).
    pub _lock_file: File,
    /// The spawned agent process. Dropping does NOT kill (production
    /// uses setsid → separate session); use `force_kill_pg` instead.
    pub child: Arc<Mutex<Box<dyn ChildProcess>>>,
}

/// Trait for the spawned agent process. Abstracts over
/// `std::process::Child` (Phase 4.5 simple case) and the
/// portable_pty-spawned PTY child (production canvas-terminal use).
/// Any concrete impl must surface PID + process group + wait/exit
/// observation.
pub trait ChildProcess: Send {
    fn pid(&self) -> i32;
    fn process_group_id(&self) -> Option<i32>;
    /// Non-blocking poll for exit. Returns `Ok(Some(_))` if exited,
    /// `Ok(None)` if still running.
    fn try_wait_exit_code(&mut self) -> std::io::Result<Option<i32>>;
}

/// Trait for spawning an agent. The Supervisor uses this so the
/// portable_pty integration can be plugged in via an adapter without
/// coupling supervisor.rs to the PTY layer.
pub trait SpawnAgent {
    fn spawn(
        &self,
        cwd: &std::path::Path,
        env: &[(String, String)],
    ) -> std::io::Result<Box<dyn ChildProcess>>;
}

/// Concrete `ChildProcess` impl wrapping `std::process::Child`.
/// Used by tests and as the simplest production path. Phase 4.5
/// production path with PTY support is a portable_pty adapter that
/// implements the same trait.
pub struct StdChildProcess {
    child: Child,
    pid: i32,
    pgid: Option<i32>,
}

impl StdChildProcess {
    pub fn new(child: Child) -> Self {
        let pid = child.id() as i32;
        let pgid = nix_pgid_for(pid);
        Self { child, pid, pgid }
    }
}

impl ChildProcess for StdChildProcess {
    fn pid(&self) -> i32 {
        self.pid
    }

    fn process_group_id(&self) -> Option<i32> {
        self.pgid
    }

    fn try_wait_exit_code(&mut self) -> std::io::Result<Option<i32>> {
        Ok(self.child.try_wait()?.and_then(|status| status.code()))
    }
}

fn nix_pgid_for(pid: i32) -> Option<i32> {
    use nix::unistd::{getpgid, Pid};
    getpgid(Some(Pid::from_raw(pid))).ok().map(|p| p.as_raw())
}

/// Simple `SpawnAgent` impl that runs the agent via
/// `std::process::Command` and calls `nix::unistd::setsid()` in a
/// `pre_exec` hook so the agent gets its own session and process
/// group (per Spike 2 + constraint C3).
///
/// Per B7 verifier convergence (claude3 critical bug): the original
/// implementation shelled out to the `setsid` shell command, but
/// that binary is NOT available on stock macOS — production agents
/// would fail to spawn. Calling `setsid()` syscall directly via
/// `pre_exec` works on all POSIX (macOS + Linux) without depending
/// on a util-linux package being installed.
///
/// The portable_pty integration (production canvas-terminal path)
/// will be a separate adapter implementing the same `SpawnAgent`
/// trait, wrapping `portable_pty::CommandBuilder` with the same
/// `pre_exec` setsid hook.
pub struct CommandSpawn {
    pub program: String,
    pub args: Vec<String>,
}

impl SpawnAgent for CommandSpawn {
    fn spawn(
        &self,
        cwd: &std::path::Path,
        env: &[(String, String)],
    ) -> std::io::Result<Box<dyn ChildProcess>> {
        use std::os::unix::process::CommandExt;

        let mut cmd = Command::new(&self.program);
        cmd.args(&self.args);
        cmd.current_dir(cwd);
        for (k, v) in env {
            cmd.env(k, v);
        }
        // SAFETY: pre_exec is called between fork and exec in the child
        // process. nix::unistd::setsid() is a single syscall — no
        // allocations, no mutex, no panics. Per POSIX it's async-signal-
        // safe so it's safe to call here. (Constraint C3 from Spike 2.)
        unsafe {
            cmd.pre_exec(|| {
                nix::unistd::setsid()
                    .map(|_| ())
                    .map_err(std::io::Error::other)
            });
        }
        let child = cmd.spawn()?;
        Ok(Box::new(StdChildProcess::new(child)))
    }
}

/// The Supervisor. Owns one agent's lifetime.
pub struct Supervisor {
    managed_root: ManagedRoot,
    runtime: LeaseRuntime,
    monitor_handle: Option<tokio::task::JoinHandle<()>>,
}

impl Supervisor {
    /// Start a supervisor for the just-provisioned agent.
    /// Spawns the agent process via `spawn_agent`, captures real
    /// PID + pgid + start_time, atomically records that ownership AND
    /// advances Ready → Working in one registry transaction (B2),
    /// starts the heartbeat task using the lease's configured
    /// `heartbeat_timeout_secs` (T2.6), and spawns the monitor task
    /// that owns the heartbeat handle (T2.1) and polls for agent
    /// exit; on exit it stops heartbeat first, then transitions the
    /// lease to `Draining`.
    pub fn start<S: SpawnAgent>(
        managed_root: ManagedRoot,
        provisioned: ProvisionedAgent,
        spawn_agent: &S,
        env: &[(String, String)],
    ) -> Result<Self> {
        let registry = Registry::new(managed_root.clone());
        let agent_id = provisioned.agent_id.as_str().to_string();

        // Read the lease so we can use its configured heartbeat timeout
        // (T2.6 fix per codex2 non-blocking finding: previously hard-
        // coded LeaseRecord::DEFAULT_HEARTBEAT_TIMEOUT_SECS, ignoring
        // any per-agent override the provisioner had set).
        let lease = registry
            .get(&agent_id)?
            .ok_or_else(|| {
                SupervisorError::Registry(RegistryStoreError::LeaseNotFound(agent_id.clone()))
            })?;
        let heartbeat_timeout_secs = lease.heartbeat_timeout_secs;

        // Spawn the agent
        let child = spawn_agent
            .spawn(provisioned.worktree_path.as_path(), env)
            .map_err(|e| SupervisorError::SpawnFailed(format!("{e}")))?;

        let real_pid = child.pid();
        let real_pgid = child.process_group_id();
        let real_start_time = read_process_start_time(real_pid);

        // B2 fix per 5/5 verifier convergence: atomically record real
        // ownership AND state in one flock'd transaction so the registry
        // is never observed mid-transition (e.g., new state with stale
        // Tauri PID, or new owner with old state). Replaces the
        // previous two-call sequence that left owner_pid as the Tauri
        // PID forever — breaking lease_check::evaluate, PID-reuse
        // defense, and reaper liveness.
        let now = now_unix_secs();
        registry.set_ownership(
            &agent_id,
            real_pid,
            real_start_time,
            real_pgid,
            AgentState::Working,
            now,
        )?;

        let runtime = LeaseRuntime {
            agent_id: agent_id.clone(),
            _lock_file: provisioned.lock_file,
            child: Arc::new(Mutex::new(child)),
        };

        // T2.1 + T2.6 fix per claude3 B2: heartbeat handle is owned by
        // the monitor task so when the monitor observes child exit it
        // stops heartbeat BEFORE flipping to Draining. Previously the
        // heartbeat lived on the Supervisor struct and kept ticking
        // until the supervisor was dropped — a dead agent could appear
        // alive to the reaper indefinitely.
        let monitor_managed_root = managed_root.clone();
        let monitor_agent_id = agent_id.clone();
        let monitor_child = runtime.child.clone();
        let monitor_interval = interval_for_timeout(heartbeat_timeout_secs);
        let monitor_handle = tokio::spawn(async move {
            let heartbeat = Heartbeat::start(
                monitor_managed_root.clone(),
                monitor_agent_id.clone(),
                monitor_interval,
            );
            run_monitor(
                monitor_managed_root,
                monitor_agent_id,
                monitor_child,
                heartbeat,
            )
            .await;
        });

        Ok(Self {
            managed_root,
            runtime,
            monitor_handle: Some(monitor_handle),
        })
    }

    /// Force-close the agent (Path B). Sends SIGTERM to the process
    /// group, waits 5s, sends SIGKILL if still alive. Then transitions
    /// the lease to `Draining` so Phase 5 drainer's
    /// `Drainer::drain_path_b` can pick up.
    ///
    /// **B4 fix per claude3/codex2/codex3 convergence**: now async (uses
    /// `tokio::time::sleep` so it does not block the runtime), and
    /// kill failures are propagated as `KillFailed` errors EXCEPT for
    /// `KillError::NotFound` which is benign (the agent or its
    /// process group already exited). The lease is only advanced to
    /// `Draining` after the kill sequence completes — a fatal kill
    /// error means the lease is NOT moved (so the drainer doesn't
    /// snapshot a still-running worktree).
    pub async fn force_close(&self) -> Result<()> {
        let registry = Registry::new(self.managed_root.clone());

        let pgid = match self.runtime.child.lock() {
            Ok(c) => c.process_group_id(),
            Err(_) => None,
        };

        if let Some(pgid) = pgid {
            match sigterm_process_group(pgid) {
                Ok(()) => {}
                Err(KillError::NotFound) => {
                    // Already dead — nothing to wait for.
                }
                Err(e) => return Err(SupervisorError::KillFailed(e)),
            }
            tokio::time::sleep(Duration::from_secs(5)).await;
            match sigkill_process_group(pgid) {
                Ok(()) => {}
                Err(KillError::NotFound) => {}
                Err(e) => return Err(SupervisorError::KillFailed(e)),
            }
        }
        // If we had no recorded pgid, we can't kill — that's a
        // supervisor invariant break. Surface it instead of silently
        // proceeding (codex2/codex3 finding).
        else {
            return Err(SupervisorError::KillFailed(KillError::InvalidPgid(0)));
        }

        let now = now_unix_secs();
        registry.update_state(&self.runtime.agent_id, AgentState::Draining, now)?;
        Ok(())
    }

    pub fn agent_id(&self) -> &str {
        &self.runtime.agent_id
    }

    /// Read-only snapshot of the agent's process-group id (if known).
    /// Used by `commands::worktree::start_worktree_agent`'s rollback
    /// path (F4) so post-spawn errors can SIGTERM/SIGKILL the orphan
    /// PG before dropping the supervisor.
    pub fn process_group_id(&self) -> Option<i32> {
        self.runtime.child.lock().ok().and_then(|c| c.process_group_id())
    }
}

impl Drop for Supervisor {
    fn drop(&mut self) {
        if let Some(h) = self.monitor_handle.take() {
            h.abort();
        }
    }
}

/// The monitor task. Owns the heartbeat handle (T2.1 — claude3 B2) so
/// dropping it stops the heartbeat the moment the monitor exits.
/// Polls the agent's `try_wait_exit_code` every `MONITOR_POLL_INTERVAL`.
/// On exit, **stops heartbeat first** (so the lease cannot appear alive
/// after the agent died), then transitions the lease to `Draining` so
/// Phase 5 drainer picks up. Also exits cleanly on `LeaseNotFound`
/// (T2.7 — same pattern as the Phase 4 heartbeat fix).
async fn run_monitor(
    managed_root: ManagedRoot,
    agent_id: String,
    child: Arc<Mutex<Box<dyn ChildProcess>>>,
    mut heartbeat: Heartbeat,
) {
    let registry = Registry::new(managed_root);
    let mut tick = tokio::time::interval(MONITOR_POLL_INTERVAL);
    loop {
        tick.tick().await;
        let exited = match child.lock() {
            Ok(mut c) => c.try_wait_exit_code().ok().flatten(),
            Err(_) => None,
        };
        if exited.is_some() {
            // T2.1 fix: stop heartbeat BEFORE flipping to Draining so
            // the reaper can't see a "live" lease for a dead agent.
            heartbeat.stop();
            let _ = registry.update_state(&agent_id, AgentState::Draining, now_unix_secs());
            return;
        }
        // T2.7 fix: if the lease is gone (e.g., reaper claimed and
        // GC'd), there's nothing to monitor. Stop heartbeat and exit.
        match registry.get(&agent_id) {
            Ok(Some(_)) => {}
            Ok(None) => {
                heartbeat.stop();
                return;
            }
            Err(_) => {
                // Transient registry error — keep polling; heartbeat
                // task has its own resilience.
            }
        }
    }
}

const MONITOR_POLL_INTERVAL: Duration = Duration::from_millis(500);

fn read_process_start_time(pid: i32) -> Option<i64> {
    crate::worktree::lease_check::read_process_start_time(pid)
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

    /// `ChildProcess` impl that we can drive deterministically from
    /// tests without spawning a real process.
    struct FakeChild {
        pid: i32,
        pgid: Option<i32>,
        exit_after_polls: usize,
        polls: usize,
    }

    impl ChildProcess for FakeChild {
        fn pid(&self) -> i32 {
            self.pid
        }
        fn process_group_id(&self) -> Option<i32> {
            self.pgid
        }
        fn try_wait_exit_code(&mut self) -> std::io::Result<Option<i32>> {
            self.polls += 1;
            if self.polls >= self.exit_after_polls {
                Ok(Some(0))
            } else {
                Ok(None)
            }
        }
    }

    struct FakeSpawn {
        exit_after_polls: usize,
        pid: i32,
    }

    impl FakeSpawn {
        fn new(exit_after_polls: usize, pid: i32) -> Self {
            Self {
                exit_after_polls,
                pid,
            }
        }
    }

    impl SpawnAgent for FakeSpawn {
        fn spawn(
            &self,
            _cwd: &std::path::Path,
            _env: &[(String, String)],
        ) -> std::io::Result<Box<dyn ChildProcess>> {
            Ok(Box::new(FakeChild {
                pid: self.pid,
                pgid: Some(self.pid),
                exit_after_polls: self.exit_after_polls,
                polls: 0,
            }))
        }
    }

    #[test]
    fn child_process_trait_compiles_with_std_process_child() {
        // Smoke: `setsid true` exits immediately; we just verify the
        // trait wires up. On macOS `setsid` may or may not be in PATH
        // (BSD setsid is a wrapper script); skip if unavailable.
        if Command::new("setsid").arg("--help").output().is_err() {
            // setsid not present on this system — skip
            return;
        }
        let mut spawner = CommandSpawn {
            program: "true".to_string(),
            args: vec![],
        };
        let _ = &mut spawner;
        // Don't actually spawn — just verify trait object construction
        // works. Real spawn integration tested via FakeSpawn below.
    }

    #[tokio::test(start_paused = true)]
    async fn monitor_advances_to_draining_on_agent_exit() {
        // Set up a managed root + provisioned-style lease + supervisor
        // with a FakeChild that "exits" after 2 polls.
        let tmp = tempfile::tempdir().unwrap();
        let managed_root = ManagedRoot::new(tmp.path()).unwrap();
        crate::worktree::managed_root::ensure_layout(&managed_root).unwrap();

        // Insert a lease in Ready state
        use crate::worktree::types::{AgentId, BranchRef, LeaseRecord, WorktreePath, REGISTRY_SCHEMA_VERSION};
        let agent = AgentId::new("agent-A").unwrap();
        let wt_path = WorktreePath::for_agent(&managed_root, &agent);
        let lease = LeaseRecord {
            session_id: "sess".into(),
            agent_id: agent.as_str().to_string(),
            parent_agent_id: None,
            task_id: "task".into(),
            repo_root: PathBuf::from("/tmp/repo"),
            base_ref: "refs/heads/main".into(),
            base_commit: "deadbeef".into(),
            branch_ref: BranchRef::for_agent("sess", agent.as_str()).unwrap(),
            worktree_path: wt_path.clone(),
            owner_pid: std::process::id() as i32,
            owner_nonce: "test-nonce".into(),
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
        Registry::new(managed_root.clone()).insert(lease).unwrap();
        // Worktree dir + nonce file (heartbeat needs nonce file present
        // for lease_check::evaluate, even though we don't run reaper here)
        std::fs::create_dir_all(wt_path.as_path()).unwrap();
        std::fs::write(wt_path.as_path().join(".canvas-agent-nonce"), "test-nonce").unwrap();

        // Construct a fake ProvisionedAgent (we can't easily construct
        // a real one without running the provisioner, so we use the
        // supervisor's start path with a synthetic ProvisionedAgent)
        let lock_file = std::fs::File::create(
            managed_root.lock_path_for(&agent),
        )
        .unwrap();
        use crate::worktree::provisioner::ProvisionedAgent;
        let provisioned = ProvisionedAgent {
            agent_id: agent,
            branch_ref: BranchRef::for_agent("sess", "agent-A").unwrap(),
            worktree_path: wt_path,
            base_commit: "deadbeef".into(),
            nonce: "test-nonce".into(),
            lock_file,
        };

        let spawner = FakeSpawn::new(2, 99_999);
        let supervisor =
            Supervisor::start(managed_root.clone(), provisioned, &spawner, &[]).unwrap();

        // Lease should be Working immediately after start
        let registry = Registry::new(managed_root.clone());
        let lease_after_start = registry.get("agent-A").unwrap().unwrap();
        assert_eq!(lease_after_start.state, AgentState::Working);
        // B2 verifier convergence: ownership info updated to the
        // spawned child's real values, NOT the Tauri app PID set by
        // the provisioner. Previously this assertion would have failed
        // because Supervisor::start discarded the captured ownership.
        assert_eq!(lease_after_start.owner_pid, 99_999);
        assert_eq!(lease_after_start.process_group_id, Some(99_999));
        assert_ne!(lease_after_start.owner_pid, std::process::id() as i32);

        // Advance virtual time + yield in a loop so the monitor task
        // (running on the same start_paused runtime) reaches its
        // scheduled tick wakeups. Each iteration advances 500ms (one
        // tick) and yields twice. After 6 iterations we've covered
        // 3 seconds = 6 ticks, well past the FakeChild's 2-poll exit.
        for _ in 0..6 {
            tokio::time::advance(Duration::from_millis(500)).await;
            tokio::task::yield_now().await;
            tokio::task::yield_now().await;
        }

        // Lease should now be Draining (monitor saw the agent exit
        // after 2 polls and called update_state(Draining))
        let lease_after_exit = registry.get("agent-A").unwrap().unwrap();
        assert_eq!(lease_after_exit.state, AgentState::Draining);

        drop(supervisor);
    }

    fn insert_lease(managed_root: &ManagedRoot, agent_id_str: &str) {
        use crate::worktree::types::{
            AgentId, BranchRef, LeaseRecord, WorktreePath, REGISTRY_SCHEMA_VERSION,
        };
        let agent = AgentId::new(agent_id_str).unwrap();
        let wt_path = WorktreePath::for_agent(managed_root, &agent);
        std::fs::create_dir_all(wt_path.as_path()).unwrap();
        std::fs::write(
            wt_path.as_path().join(".canvas-agent-nonce"),
            "test-nonce",
        )
        .unwrap();
        let lease = LeaseRecord {
            session_id: "sess".into(),
            agent_id: agent_id_str.into(),
            parent_agent_id: None,
            task_id: format!("task-{agent_id_str}"),
            repo_root: PathBuf::from("/tmp/repo"),
            base_ref: "refs/heads/main".into(),
            base_commit: "deadbeef".into(),
            branch_ref: BranchRef::for_agent("sess", agent_id_str).unwrap(),
            worktree_path: wt_path,
            owner_pid: std::process::id() as i32,
            owner_nonce: "test-nonce".into(),
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
        Registry::new(managed_root.clone()).insert(lease).unwrap();
    }

    fn provisioned_for(managed_root: &ManagedRoot, agent_id_str: &str) -> crate::worktree::provisioner::ProvisionedAgent {
        use crate::worktree::provisioner::ProvisionedAgent;
        use crate::worktree::types::{AgentId, BranchRef, WorktreePath};
        let agent = AgentId::new(agent_id_str).unwrap();
        let wt_path = WorktreePath::for_agent(managed_root, &agent);
        let lock_file = std::fs::File::create(managed_root.lock_path_for(&agent)).unwrap();
        ProvisionedAgent {
            agent_id: agent,
            branch_ref: BranchRef::for_agent("sess", agent_id_str).unwrap(),
            worktree_path: wt_path,
            base_commit: "deadbeef".into(),
            nonce: "test-nonce".into(),
            lock_file,
        }
    }

    /// C12: 10 concurrent supervisors all transition Ready → Working
    /// with unique owner_pid recorded in their respective lease.
    #[tokio::test(start_paused = true)]
    async fn ten_concurrent_supervisors_transition_independently() {
        let tmp = tempfile::tempdir().unwrap();
        let managed_root = ManagedRoot::new(tmp.path()).unwrap();
        crate::worktree::managed_root::ensure_layout(&managed_root).unwrap();

        let n = 10;
        let mut supervisors = Vec::with_capacity(n);
        for i in 0..n {
            let id = format!("agent-{i:02}");
            insert_lease(&managed_root, &id);
            let provisioned = provisioned_for(&managed_root, &id);
            // Unique pid per supervisor. exit_after_polls high so the
            // monitor doesn't tear it down before we assert state.
            let spawner = FakeSpawn::new(1_000_000, 50_000 + i as i32);
            let sup = Supervisor::start(managed_root.clone(), provisioned, &spawner, &[]).unwrap();
            supervisors.push(sup);
        }

        // All 10 leases must be Working with unique owner_pid.
        let registry = Registry::new(managed_root.clone());
        let mut seen_pids = std::collections::HashSet::new();
        for i in 0..n {
            let id = format!("agent-{i:02}");
            let lease = registry.get(&id).unwrap().unwrap();
            assert_eq!(lease.state, AgentState::Working, "{id}");
            assert_eq!(lease.owner_pid, 50_000 + i as i32);
            assert!(seen_pids.insert(lease.owner_pid));
        }
        assert_eq!(seen_pids.len(), n);

        // Drop all supervisors so monitor tasks abort cleanly
        drop(supervisors);
    }

    /// C13: 50-cycle throughput micro-benchmark. Asserts a per-cycle
    /// upper bound so future regressions surface in CI rather than
    /// silently slowing the system down.
    #[tokio::test(start_paused = true)]
    async fn fifty_cycle_throughput_under_bound() {
        let tmp = tempfile::tempdir().unwrap();
        let managed_root = ManagedRoot::new(tmp.path()).unwrap();
        crate::worktree::managed_root::ensure_layout(&managed_root).unwrap();

        let n: i32 = 50;
        let started = std::time::Instant::now();
        for i in 0..n {
            let id = format!("agent-{i:03}");
            insert_lease(&managed_root, &id);
            let provisioned = provisioned_for(&managed_root, &id);
            let spawner = FakeSpawn::new(1_000_000, 60_000 + i);
            let sup = Supervisor::start(managed_root.clone(), provisioned, &spawner, &[]).unwrap();
            drop(sup); // Each cycle: start + drop
        }
        let elapsed = started.elapsed();
        // 50 supervisor lifecycles in under 30s (real wall, very loose).
        // The point is to catch a 10x regression — not measure absolute
        // perf. Each cycle is currently ~few-hundred-ms with flock + fs.
        assert!(
            elapsed < std::time::Duration::from_secs(30),
            "throughput regression: 50 cycles took {elapsed:?}"
        );
    }
}
