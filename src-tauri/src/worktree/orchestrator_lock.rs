// Worktree subsystem — orchestrator-level mutual exclusion
//
// Per spec §6.1 (lazy acquisition) + §6.2 (Model B per-sweep flock,
// post-F6 erratum):
//   - The orchestrator lock is acquired ONLY when a worktree-backed
//     collab session starts. Non-worktree app instances are unaffected.
//   - Reaper sweeps acquire a SEPARATE per-sweep lock with LOCK_NB
//     (no-op if held). flock auto-releases on process death.
//
// This module exposes two RAII guards:
//   - `OrchestratorSessionLock`: held for the lifetime of a worktree-
//     backed collab session, on `<managed_root>/orchestrator.lock`
//   - `OrchestratorSweepLock`: held only for the duration of one
//     reaper sweep (per Model B in spec §6.2), on
//     `<managed_root>/sweep.lock`
//
// **F6 erratum (Phase 2 verifier round)**: the two locks now target
// SEPARATE lockfiles. Sharing a single file would cause the same
// process holding the session lock to self-block when its own reaper
// tried to sweep (Darwin per-process exclusion confirmed by Spike 1),
// preventing the most-likely-to-have-stale-children instance from
// reaping. The two locks are now orthogonal:
//   - session lock = mutual exclusion across instances
//   - sweep lock   = sweep serialization across instances

use crate::worktree::types::ManagedRoot;
use fs2::FileExt;
use std::fs::{File, OpenOptions};
use std::io;

/// RAII guard for a worktree-backed collab session. Drop releases.
pub struct OrchestratorSessionLock {
    _file: File,
}

/// RAII guard for one reaper sweep. Drop releases.
pub struct OrchestratorSweepLock {
    _file: File,
}

/// Errors from orchestrator lock acquisition.
#[derive(Debug)]
pub enum OrchestratorLockError {
    Io(io::Error),
    /// Another orchestrator instance currently holds the lock.
    /// User-facing UX should explain this per spec §6.1 + spec-todo T1.
    AlreadyHeld,
}

impl std::fmt::Display for OrchestratorLockError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            OrchestratorLockError::Io(e) => write!(f, "io: {e}"),
            OrchestratorLockError::AlreadyHeld => write!(
                f,
                "orchestrator lock already held by another instance"
            ),
        }
    }
}

impl std::error::Error for OrchestratorLockError {}

impl From<io::Error> for OrchestratorLockError {
    fn from(e: io::Error) -> Self {
        OrchestratorLockError::Io(e)
    }
}

/// Try to acquire the session-level orchestrator lock. Returns
/// `Err(AlreadyHeld)` if another instance holds it. Per spec §6.1
/// recommendation (a): single orchestrator per managed root.
pub fn try_acquire_session(root: &ManagedRoot) -> Result<OrchestratorSessionLock, OrchestratorLockError> {
    let file = open_lockfile(root)?;
    // **K1 fix per claude3 H9 incomplete**: macOS BSD `flock(2)` can
    // return spurious EWOULDBLOCK under heavy parallel I/O (same
    // pattern that caused `RegistryStore::acquire_write_lock` to add
    // a retry loop in rev-3). Retry up to 8 times with exponential
    // backoff before treating as "already held." Production hardening
    // beyond just stabilizing tests via serial_test markers.
    flock_retry(&file).map_err(|_| OrchestratorLockError::AlreadyHeld)?;
    Ok(OrchestratorSessionLock { _file: file })
}

/// Try to acquire the per-sweep lock for a reaper tick. Returns
/// `Ok(None)` if the lock is held (sweep is a no-op this tick),
/// `Ok(Some(guard))` if acquired (sweep proceeds and releases on
/// drop). Per spec §6.2 Model B.
///
/// F6 (Phase 2 verifier round): targets a SEPARATE lockfile from
/// `try_acquire_session`. Using the same file would mean the same
/// process holding the session lock could never sweep (Darwin
/// per-process exclusion), starving the most-likely-to-have-stale-
/// children instance of cleanup capability. The two locks are now
/// orthogonal: session lock is per-managed-root mutual exclusion;
/// sweep lock is per-managed-root sweep-serialization across
/// instances.
pub fn try_acquire_sweep(root: &ManagedRoot) -> io::Result<Option<OrchestratorSweepLock>> {
    let file = open_lockfile_at(&root.sweep_lock_path())?;
    match flock_retry(&file) {
        Ok(()) => Ok(Some(OrchestratorSweepLock { _file: file })),
        Err(_) => Ok(None),
    }
}

/// K1 — retry `try_lock_exclusive` with exponential backoff to
/// tolerate macOS BSD `flock(2)` spurious EWOULDBLOCK under heavy
/// parallel I/O. Same pattern as `RegistryStore::acquire_write_lock`.
/// 8 attempts × ~16ms total worst-case wait. After exhausting,
/// treat as "really held" and surface the original error.
fn flock_retry(file: &File) -> io::Result<()> {
    let mut delay_us = 100u64;
    for attempt in 0..8 {
        match file.try_lock_exclusive() {
            Ok(()) => return Ok(()),
            Err(e) => {
                if attempt == 7 {
                    return Err(e);
                }
                std::thread::sleep(std::time::Duration::from_micros(delay_us));
                delay_us = delay_us.saturating_mul(2);
            }
        }
    }
    unreachable!()
}

fn open_lockfile(root: &ManagedRoot) -> io::Result<File> {
    open_lockfile_at(&root.orchestrator_lock_path())
}

fn open_lockfile_at(path: &std::path::Path) -> io::Result<File> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(false)
        .open(path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::worktree::managed_root::ensure_layout;

    fn fresh_root() -> (tempfile::TempDir, ManagedRoot) {
        let tmp = tempfile::tempdir().unwrap();
        let root = ManagedRoot::new(tmp.path()).unwrap();
        ensure_layout(&root).unwrap();
        (tmp, root)
    }

    #[test]
    #[serial_test::serial(orchestrator_lock)]
    fn session_lock_acquires_on_fresh_root() {
        let (_tmp, root) = fresh_root();
        let _guard = try_acquire_session(&root).expect("should acquire on fresh root");
    }

    #[test]
    #[serial_test::serial(orchestrator_lock)]
    fn session_lock_excludes_second_session_in_same_process() {
        // Per Spike 1 (Darwin per-process exclusion), the same process
        // attempting to acquire twice should fail on the second.
        let (_tmp, root) = fresh_root();
        let _g1 = try_acquire_session(&root).unwrap();
        let g2 = try_acquire_session(&root);
        assert!(matches!(g2, Err(OrchestratorLockError::AlreadyHeld)));
    }

    #[test]
    #[serial_test::serial(orchestrator_lock)]
    fn session_lock_releases_on_drop() {
        let (_tmp, root) = fresh_root();
        {
            let _g = try_acquire_session(&root).unwrap();
        } // dropped → flock released
        let _g2 = try_acquire_session(&root)
            .expect("should re-acquire after first drop");
    }

    #[test]
    #[serial_test::serial(orchestrator_lock)]
    fn sweep_lock_independent_from_session_lock_after_f6() {
        // F6 (Phase 2 verifier round): session lock and sweep lock now
        // target SEPARATE files. Holding the session lock must NOT
        // block sweep acquisition in the same process, otherwise the
        // holding instance can't reap its own crashed children.
        let (_tmp, root) = fresh_root();
        let _session = try_acquire_session(&root).unwrap();

        let sweep = try_acquire_sweep(&root).unwrap();
        assert!(sweep.is_some(), "sweep MUST acquire even when session holds (F6)");
    }

    #[test]
    #[serial_test::serial(orchestrator_lock)]
    fn sweep_lock_excludes_concurrent_sweep() {
        // Two attempts at the sweep lock from the same process: second
        // fails (Darwin per-process exclusion confirmed by Spike 1).
        let (_tmp, root) = fresh_root();
        let s1 = try_acquire_sweep(&root).unwrap();
        assert!(s1.is_some());
        let s2 = try_acquire_sweep(&root).unwrap();
        assert!(s2.is_none(), "second concurrent sweep MUST be no-op");
    }

    #[test]
    #[serial_test::serial(orchestrator_lock)]
    fn sweep_lock_acquires_when_no_session_holds() {
        let (_tmp, root) = fresh_root();
        let sweep = try_acquire_sweep(&root).unwrap();
        assert!(sweep.is_some());
    }

    #[test]
    #[serial_test::serial(orchestrator_lock)]
    fn sweep_lock_is_per_sweep_not_persistent() {
        let (_tmp, root) = fresh_root();
        // First sweep acquires
        {
            let s1 = try_acquire_sweep(&root).unwrap();
            assert!(s1.is_some());
        } // s1 dropped → released
        // Second sweep also acquires (lock released between sweeps)
        let s2 = try_acquire_sweep(&root).unwrap();
        assert!(s2.is_some());
    }
}
