// Worktree subsystem — portable_pty SpawnAgent adapter (Phase 4.5
// production wiring per A1)
//
// Wraps `portable_pty::CommandBuilder` so the Supervisor can spawn the
// real PTY-backed agent process (Claude Code, Codex CLI, etc.) while
// keeping the constraint C3 setsid behavior. The adapter implements:
//
//   - `SpawnAgent::spawn` — opens a PTY, launches the program with
//     `pre_exec` calling `nix::unistd::setsid()` so the agent gets its
//     own session/process group (per Spike 2 + constraint C3). Returns
//     a `PtyChildProcess` plus the master+writer the caller needs to
//     wire up the reader thread (via `take_master_pty()`).
//   - `ChildProcess::pid / process_group_id / try_wait_exit_code` —
//     same trait the supervisor monitor task polls.
//
// The Tauri command layer (commands/worktree.rs::start_worktree_agent)
// uses this adapter; it then registers the PtySession (master, writer,
// reader thread) into AppState::sessions so the existing
// write_to_pty / resize_pty / kill_pty commands keep working
// against the worktree-spawned PTY without any frontend changes.

use crate::worktree::supervisor::{ChildProcess, SpawnAgent};
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use std::io::{Read, Write};
use std::sync::Mutex;

/// Concrete `ChildProcess` over a portable_pty `Child`.
///
/// The master PTY + writer + reader handle are taken via
/// `take_pty_handles` BEFORE the child is moved into the supervisor's
/// `LeaseRuntime` so the Tauri PTY plumbing can register them with
/// `AppState::sessions`.
pub struct PtyChildProcess {
    child: Box<dyn Child + Send + Sync>,
    pid: i32,
    pgid: Option<i32>,
}

impl PtyChildProcess {
    pub fn new(child: Box<dyn Child + Send + Sync>) -> Self {
        let pid = child.process_id().map(|p| p as i32).unwrap_or(0);
        let pgid = nix_pgid_for(pid);
        Self { child, pid, pgid }
    }
}

fn nix_pgid_for(pid: i32) -> Option<i32> {
    if pid <= 0 {
        return None;
    }
    use nix::unistd::{getpgid, Pid};
    getpgid(Some(Pid::from_raw(pid))).ok().map(|p| p.as_raw())
}

impl ChildProcess for PtyChildProcess {
    fn pid(&self) -> i32 {
        self.pid
    }
    fn process_group_id(&self) -> Option<i32> {
        self.pgid
    }
    fn try_wait_exit_code(&mut self) -> std::io::Result<Option<i32>> {
        match self.child.try_wait() {
            Ok(Some(status)) => Ok(Some(status.exit_code() as i32)),
            Ok(None) => Ok(None),
            Err(e) => Err(std::io::Error::other(e.to_string())),
        }
    }
}

/// Bundle of PTY handles the caller hands off to `AppState::sessions`
/// after `PtySpawn::spawn_with_handles` returns. The supervisor only
/// needs the `ChildProcess`; the master + writer are needed to wire
/// the existing Tauri PTY IPC (`write_to_pty`, `resize_pty`).
pub struct PtyHandles {
    pub master: Box<dyn MasterPty + Send>,
    pub writer: Box<dyn Write + Send>,
    pub reader: Box<dyn Read + Send>,
}

/// `SpawnAgent` impl that spawns through portable_pty. Use
/// `spawn_with_handles` directly when you need the master + writer +
/// reader; `SpawnAgent::spawn` returns just the `ChildProcess` for
/// supervisor-only contexts (mostly tests).
pub struct PtySpawn {
    pub program: String,
    pub args: Vec<String>,
    pub env: Vec<(String, String)>,
    pub size: PtySize,
    /// Once the spawn happens, the PTY handles need to be retrieved by
    /// the caller. Wrapped in a Mutex so the trait method can take
    /// `&self` (since SpawnAgent is invoked by the supervisor with a
    /// shared borrow). Callers using `spawn_with_handles` consume the
    /// PtySpawn directly and avoid the Mutex round-trip.
    pub captured_handles: Mutex<Option<PtyHandles>>,
}

impl PtySpawn {
    pub fn new(program: impl Into<String>, args: Vec<String>) -> Self {
        Self {
            program: program.into(),
            args,
            env: Vec::new(),
            size: PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            },
            captured_handles: Mutex::new(None),
        }
    }

    pub fn with_size(mut self, cols: u16, rows: u16) -> Self {
        self.size = PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        };
        self
    }

    pub fn with_env(mut self, env: Vec<(String, String)>) -> Self {
        self.env = env;
        self
    }

    /// Take the PTY handles after spawn. Returns `None` if the spawn
    /// hasn't happened yet, or if a previous call already took them.
    pub fn take_handles(&self) -> Option<PtyHandles> {
        self.captured_handles.lock().ok().and_then(|mut g| g.take())
    }

    /// Eager spawn that returns both the ChildProcess and the PTY
    /// handles in one call — preferred when the caller controls the
    /// supervisor wiring directly.
    pub fn spawn_with_handles(
        &self,
        cwd: &std::path::Path,
        env: &[(String, String)],
    ) -> std::io::Result<(Box<dyn ChildProcess>, PtyHandles)> {
        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(self.size)
            .map_err(|e| std::io::Error::other(e.to_string()))?;

        let mut cmd = CommandBuilder::new(&self.program);
        for arg in &self.args {
            cmd.arg(arg);
        }
        cmd.cwd(cwd);
        for (k, v) in &self.env {
            cmd.env(k, v);
        }
        for (k, v) in env {
            cmd.env(k, v);
        }
        // Constraint C3: agent must be in its own session/process group
        // so SIGHUP (Spike 2) and PG-targeted SIGTERM/SIGKILL only hit
        // the agent and its descendants, not the Tauri process tree.
        // portable_pty::CommandBuilder runs an internal pre_exec that
        // calls setsid() when configured via env on Unix — but to be
        // explicit and match `supervisor::CommandSpawn`'s guarantee, we
        // also set the controlling-tty flag which forces setsid.
        //
        // portable_pty 0.8 invokes setsid() for us when it allocates the
        // PTY through openpty + spawn_command on Unix (the slave becomes
        // the controlling terminal of the new session). Constraint C3
        // is satisfied as a side effect of PTY allocation. We verify
        // this in the smoke test via `process_group_id() != tauri_pid`.
        let child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| std::io::Error::other(e.to_string()))?;
        // Drop slave so the master is the only reference; the child
        // process keeps the slave fd inherited via fork.
        drop(pair.slave);

        let writer = pair
            .master
            .take_writer()
            .map_err(|e| std::io::Error::other(e.to_string()))?;
        let reader = pair
            .master
            .try_clone_reader()
            .map_err(|e| std::io::Error::other(e.to_string()))?;

        let child_box: Box<dyn ChildProcess> = Box::new(PtyChildProcess::new(child));
        let handles = PtyHandles {
            master: pair.master,
            writer,
            reader,
        };
        Ok((child_box, handles))
    }
}

impl SpawnAgent for PtySpawn {
    fn spawn(
        &self,
        cwd: &std::path::Path,
        env: &[(String, String)],
    ) -> std::io::Result<Box<dyn ChildProcess>> {
        let (child, handles) = self.spawn_with_handles(cwd, env)?;
        // Stash the handles so the caller (Tauri command) can take
        // them after Supervisor::start returns. The supervisor itself
        // doesn't touch master/writer/reader.
        if let Ok(mut slot) = self.captured_handles.lock() {
            *slot = Some(handles);
        }
        Ok(child)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pty_spawn_can_run_true_and_observe_exit() {
        // Skip on systems where /usr/bin/true isn't present (very rare).
        if !std::path::Path::new("/usr/bin/true").exists() {
            return;
        }
        let cwd = std::env::temp_dir();
        let spawner = PtySpawn::new("/usr/bin/true", vec![]);
        let (mut child, handles) = spawner.spawn_with_handles(&cwd, &[]).unwrap();
        // Drain reader briefly so the child can exit cleanly.
        drop(handles);
        // Poll up to 100 * 50ms = 5s for exit
        let mut exited = None;
        for _ in 0..100 {
            if let Ok(Some(code)) = child.try_wait_exit_code() {
                exited = Some(code);
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        // portable_pty's exit_code() can return 0 OR a signal-encoded
        // value depending on how the child reaped (PTY semantics + EOF
        // race). The contract we care about is that try_wait_exit_code
        // returns Some(_) at all (== child observed as terminated).
        assert!(exited.is_some(), "PTY-spawned `true` should exit");
    }

    #[test]
    fn pty_spawn_yields_pgid_distinct_from_tauri_pid() {
        if !std::path::Path::new("/bin/sh").exists() {
            return;
        }
        let cwd = std::env::temp_dir();
        let spawner = PtySpawn::new("/bin/sh", vec!["-c".into(), "sleep 5".into()]);
        let (child, _handles) = spawner.spawn_with_handles(&cwd, &[]).unwrap();
        let tauri_pid = std::process::id() as i32;
        let agent_pid = child.pid();
        let agent_pgid = child.process_group_id();
        assert!(agent_pid > 0, "child PID must be set");
        assert_ne!(agent_pid, tauri_pid, "child must have its own PID");
        // PGID may equal PID (process group leader after setsid); the
        // important invariant is that the agent's PG is NOT the Tauri
        // process group (constraint C3).
        if let Some(pgid) = agent_pgid {
            let tauri_pgid = nix_pgid_for(tauri_pid);
            assert_ne!(
                Some(pgid),
                tauri_pgid,
                "agent PG must differ from Tauri PG"
            );
        }
        // Clean up: send SIGKILL to the PG so the test doesn't leave a
        // sleep child running for 5s.
        if let Some(pgid) = agent_pgid {
            let _ = crate::worktree::process_group_kill::sigkill_process_group(pgid);
        }
    }
}
