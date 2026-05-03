// Worktree subsystem — process group kill (Phase 4)
//
// Per spec §6.3 + S9 + Spike 4 implementation constraint C6:
//   When the reaper or supervisor needs to terminate an agent, it
//   MUST target the agent's process group (killpg), not just the
//   owner PID. Otherwise child processes spawned by the agent (or
//   the agent's shell) survive as orphans.
//
// The `process_group_id` field on `LeaseRecord` is set by the Phase 4
// supervisor at spawn time after `setsid()` puts the agent in its own
// pgid (per Spike 2 / constraint C3).

use nix::sys::signal::{killpg, Signal};
use nix::unistd::Pid;

#[derive(Debug)]
pub enum KillError {
    /// The process group does not exist (already dead).
    NotFound,
    /// We don't have permission to signal the process group.
    PermissionDenied,
    /// PGID is reserved or otherwise unsafe to signal. Per B2 verifier
    /// convergence (codex2+codex3+claude3): reject `pgid <= 1` BEFORE
    /// calling `killpg`. POSIX `pgid == 0` would target the caller's
    /// own process group; tiny positive values (1, init) are reserved.
    /// A buggy or defaulted `process_group_id == Some(0)` would
    /// SIGKILL canvas-terminal itself.
    InvalidPgid(i32),
    /// Other kernel error.
    Other(nix::errno::Errno),
}

impl std::fmt::Display for KillError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            KillError::NotFound => write!(f, "process group not found"),
            KillError::PermissionDenied => write!(f, "permission denied to signal process group"),
            KillError::InvalidPgid(pgid) => write!(
                f,
                "refused to signal pgid {pgid}: reserved/unsafe (would target caller pgrp or init)"
            ),
            KillError::Other(e) => write!(f, "killpg failed: {e}"),
        }
    }
}

impl std::error::Error for KillError {}

/// SIGKILL the entire process group rooted at `pgid`. Equivalent to
/// `kill(2)` with negative pid in shell terms. The agent's pgid is
/// recorded in `LeaseRecord.process_group_id` at provisioning time
/// (see Phase 4 supervisor).
///
/// Returns `Ok(())` on successful signal delivery. Returns
/// `KillError::NotFound` if the process group no longer exists (this
/// is treated as success in most callers — the goal was "make it
/// dead," and it's already dead).
pub fn sigkill_process_group(pgid: i32) -> Result<(), KillError> {
    signal_process_group(pgid, Signal::SIGKILL)
}

/// SIGTERM the process group. Used by Phase 5 drainer's Path B
/// (forced_close) before escalating to SIGKILL after a 5s grace.
pub fn sigterm_process_group(pgid: i32) -> Result<(), KillError> {
    signal_process_group(pgid, Signal::SIGTERM)
}

/// Send `signal` to the process group rooted at `pgid`.
///
/// Per B2 verifier convergence: reject `pgid <= 1` BEFORE calling
/// `killpg`. `0` targets caller's pgrp (would SIGKILL canvas-terminal
/// itself); `1` is init (reserved); negative values are nonsense.
/// Real agent pgids are >= 2 and assigned by setsid().
fn signal_process_group(pgid: i32, signal: Signal) -> Result<(), KillError> {
    if pgid <= 1 {
        return Err(KillError::InvalidPgid(pgid));
    }
    match killpg(Pid::from_raw(pgid), signal) {
        Ok(()) => Ok(()),
        Err(nix::errno::Errno::ESRCH) => Err(KillError::NotFound),
        Err(nix::errno::Errno::EPERM) => Err(KillError::PermissionDenied),
        Err(e) => Err(KillError::Other(e)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sigkill_nonexistent_pgid_returns_not_found() {
        // Use a high PID unlikely to be a real process group leader.
        // killpg with a non-existent pgid returns ESRCH.
        let result = sigkill_process_group(999_999_998);
        // Could be NotFound (typical) or PermissionDenied (if PID
        // happens to belong to a foreign process — extremely
        // unlikely with this value)
        assert!(matches!(
            result,
            Err(KillError::NotFound) | Err(KillError::PermissionDenied)
        ));
    }

    #[test]
    fn sigterm_nonexistent_pgid_returns_not_found() {
        let result = sigterm_process_group(999_999_997);
        assert!(matches!(
            result,
            Err(KillError::NotFound) | Err(KillError::PermissionDenied)
        ));
    }

    #[test]
    fn rejects_pgid_zero_to_avoid_killing_self() {
        // B2 fix: pgid 0 would target the caller's process group →
        // SIGKILL canvas-terminal itself. Must be rejected BEFORE
        // calling killpg.
        let result = sigkill_process_group(0);
        assert!(matches!(result, Err(KillError::InvalidPgid(0))));
    }

    #[test]
    fn rejects_pgid_one_init() {
        // pgid 1 is init; reserved. Reject.
        let result = sigterm_process_group(1);
        assert!(matches!(result, Err(KillError::InvalidPgid(1))));
    }

    #[test]
    fn rejects_negative_pgid() {
        // Negative pgid is nonsense; reject before killpg.
        let result = sigkill_process_group(-1);
        assert!(matches!(result, Err(KillError::InvalidPgid(-1))));
        let result = sigkill_process_group(i32::MIN);
        assert!(matches!(result, Err(KillError::InvalidPgid(i32::MIN))));
    }

    #[test]
    fn killpg_targets_self_test_disabled() {
        // We cannot meaningfully test sigkilling a real process group
        // here without spawning a child and then killing ourselves
        // along with it (since cargo test is in our process group).
        // The structural correctness — that we're calling killpg with
        // SIGKILL on the right PID — is covered by the type signature.
        // Spike 4 already validated the killpg-after-SIGSTOP recovery
        // path at the integration level.
    }
}
