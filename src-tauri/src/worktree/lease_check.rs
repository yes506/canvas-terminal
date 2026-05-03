// Worktree subsystem — lease aliveness check
//
// Per spec §3.4 (post-E5 supervisor-owned nonce file):
//   A lease is `alive` iff:
//     1. owner_pid exists in OS process table
//     2. (if owner_start_time is set) running process's start time matches
//     3. owner_nonce matches the supervisor-written nonce file at
//        <worktree>/.canvas-agent-nonce
//     4. heartbeat_at is within heartbeat_timeout_secs of monotonic now
//
// Aliveness states:
//   - Alive: all 4 conditions met
//   - Quiescent: alive but heartbeat older than liveness_quiescent_secs
//                (do not reap; mark in registry)
//   - Wedged: quiescent + additional wedge_grace_secs (reaper may claim)
//   - Dead: any of conditions 1-4 fails (reaper claims)
//
// SIGSTOP does NOT change the nonce. The stale condition for App Nap
// is heartbeat expiry → quiescent → wedged (per Spike 4 result + E4).

use crate::worktree::types::LeaseRecord;
use std::path::Path;

/// Result of evaluating lease aliveness against the OS + filesystem.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AliveStatus {
    Alive,
    Quiescent,
    Wedged,
    Dead,
}

impl AliveStatus {
    /// Per spec §6.2 reaper Model B: only `Wedged` and `Dead` are
    /// claimable by the reaper. `Quiescent` leases are flagged but
    /// not yet wedged.
    pub fn reaper_can_claim(&self) -> bool {
        matches!(self, AliveStatus::Wedged | AliveStatus::Dead)
    }
}

/// Evaluate aliveness for a lease.
/// `now_unix` is the current monotonic-ish unix time in seconds (the
/// caller is responsible for picking a clock; tests inject a fixed
/// value).
pub fn evaluate(lease: &LeaseRecord, now_unix: i64) -> AliveStatus {
    // Condition 1: PID exists
    if !pid_exists(lease.owner_pid) {
        return AliveStatus::Dead;
    }

    // Condition 2: process start time matches (if recorded)
    if let Some(expected_start_time) = lease.owner_start_time {
        match read_process_start_time(lease.owner_pid) {
            Some(actual) if actual == expected_start_time => {}
            // PID exists but start time differs → PID was reused
            _ => return AliveStatus::Dead,
        }
    }

    // Condition 3: nonce file matches (supervisor-written per E5)
    let nonce_path = lease.worktree_path.as_path().join(".canvas-agent-nonce");
    if !nonce_file_matches(&nonce_path, &lease.owner_nonce) {
        return AliveStatus::Dead;
    }

    // Condition 4: heartbeat freshness ladder
    let age_secs = (now_unix - lease.heartbeat_at).max(0) as u32;
    if age_secs <= lease.heartbeat_timeout_secs {
        return AliveStatus::Alive;
    }
    if age_secs <= lease.liveness_quiescent_secs {
        return AliveStatus::Quiescent;
    }
    if age_secs <= lease.liveness_quiescent_secs + lease.wedge_grace_secs {
        return AliveStatus::Wedged;
    }
    // beyond all thresholds — definitely dead by heartbeat
    AliveStatus::Dead
}

// ----------------------------------------------------------------------
// OS shims
// ----------------------------------------------------------------------

/// Returns `true` iff the PID exists in the OS process table.
/// Uses `kill(pid, 0)` (signal 0 doesn't deliver, just probes).
pub fn pid_exists(pid: i32) -> bool {
    use nix::sys::signal::kill;
    use nix::unistd::Pid;
    kill(Pid::from_raw(pid), None).is_ok()
}

/// Read the start time of a process in arbitrary platform-specific
/// units. Returns `None` if the process cannot be inspected (does
/// not exist, no permission, unsupported platform).
///
/// The unit is opaque — callers only compare for equality. On macOS
/// uses `ps -o lstart`; on Linux uses `/proc/<pid>/stat` field 22.
pub fn read_process_start_time(pid: i32) -> Option<i64> {
    #[cfg(target_os = "linux")]
    {
        let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
        // /proc/<pid>/stat format: pid (comm) state ppid pgrp ... starttime ...
        // starttime is field 22 (1-indexed). The comm field can contain
        // spaces and parens, so we have to handle that.
        let close_paren = stat.rfind(')')?;
        let after = &stat[close_paren + 1..];
        let fields: Vec<&str> = after.split_whitespace().collect();
        // After ')' the remaining fields are: state, ppid, pgrp, ...
        // starttime is the 20th field after ')' (1-indexed).
        // 0-indexed it's index 19.
        fields.get(19)?.parse::<i64>().ok()
    }
    #[cfg(target_os = "macos")]
    {
        // macOS: use `ps -o lstart=` (epoch seconds via -o etime would
        // be relative; lstart is a long form we hash to i64).
        let out = std::process::Command::new("ps")
            .args(["-p", &pid.to_string(), "-o", "lstart="])
            .output()
            .ok()?;
        if !out.status.success() {
            return None;
        }
        let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
        if s.is_empty() {
            return None;
        }
        // Hash the string to a stable i64. The exact value is opaque;
        // only equality matters.
        Some(stable_string_hash(&s))
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    {
        let _ = pid;
        None
    }
}

#[cfg(target_os = "macos")]
fn stable_string_hash(s: &str) -> i64 {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    s.hash(&mut h);
    h.finish() as i64
}

/// Returns `true` iff the file at `path` contains exactly `expected`
/// (trimmed of trailing whitespace). Returns `false` if the file
/// does not exist or cannot be read.
pub fn nonce_file_matches(path: &Path, expected: &str) -> bool {
    match std::fs::read_to_string(path) {
        Ok(s) => s.trim() == expected,
        Err(_) => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::worktree::managed_root::ensure_layout;
    use crate::worktree::types::{
        AgentState, BranchRef, LeaseRecord, ManagedRoot, WorktreePath,
        REGISTRY_SCHEMA_VERSION,
    };
    use std::path::PathBuf;

    fn lease_with(
        root: &ManagedRoot,
        worktree: &Path,
        pid: i32,
        nonce: &str,
        heartbeat: i64,
        start_time: Option<i64>,
    ) -> LeaseRecord {
        LeaseRecord {
            session_id: "sess".into(),
            agent_id: "agent-A".into(),
            parent_agent_id: None,
            task_id: "task".into(),
            repo_root: PathBuf::from("/tmp/repo"),
            base_ref: "refs/heads/main".into(),
            base_commit: "x".into(),
            branch_ref: BranchRef::for_agent("sess", "agent-A").unwrap(),
            worktree_path: WorktreePath::new(root, worktree).unwrap(),
            owner_pid: pid,
            owner_nonce: nonce.into(),
            owner_start_time: start_time,
            process_group_id: None,
            heartbeat_at: heartbeat,
            heartbeat_timeout_secs: 30,
            liveness_quiescent_secs: 60,
            wedge_grace_secs: 30,
            state: AgentState::Working,
            artifact_path: None,
            last_error: None,
            last_reaper_id: None,
            created_at: 0,
            updated_at: heartbeat,
            schema_version: REGISTRY_SCHEMA_VERSION,
        }
    }

    fn setup_worktree(root: &ManagedRoot, agent_id: &str, nonce: &str) -> PathBuf {
        ensure_layout(root).unwrap();
        let wt = root.worktrees_dir().join(agent_id);
        std::fs::create_dir_all(&wt).unwrap();
        std::fs::write(wt.join(".canvas-agent-nonce"), nonce).unwrap();
        wt
    }

    #[test]
    fn dead_when_pid_does_not_exist() {
        let tmp = tempfile::tempdir().unwrap();
        let root = ManagedRoot::new(tmp.path()).unwrap();
        let wt = setup_worktree(&root, "agent-A", "nonce-x");
        // Use a PID that almost certainly doesn't exist
        let lease = lease_with(&root, &wt, 999_999_999, "nonce-x", 1000, None);
        assert_eq!(evaluate(&lease, 1010), AliveStatus::Dead);
    }

    #[test]
    fn dead_when_nonce_mismatches() {
        let tmp = tempfile::tempdir().unwrap();
        let root = ManagedRoot::new(tmp.path()).unwrap();
        let wt = setup_worktree(&root, "agent-A", "wrong-nonce");
        // Use our own pid (always exists)
        let pid = std::process::id() as i32;
        let lease = lease_with(&root, &wt, pid, "expected-nonce", 1000, None);
        assert_eq!(evaluate(&lease, 1010), AliveStatus::Dead);
    }

    #[test]
    fn dead_when_nonce_file_missing() {
        let tmp = tempfile::tempdir().unwrap();
        let root = ManagedRoot::new(tmp.path()).unwrap();
        ensure_layout(&root).unwrap();
        let wt = root.worktrees_dir().join("agent-A");
        std::fs::create_dir_all(&wt).unwrap();
        // No nonce file written
        let pid = std::process::id() as i32;
        let lease = lease_with(&root, &wt, pid, "any-nonce", 1000, None);
        assert_eq!(evaluate(&lease, 1010), AliveStatus::Dead);
    }

    #[test]
    fn alive_under_heartbeat_timeout() {
        let tmp = tempfile::tempdir().unwrap();
        let root = ManagedRoot::new(tmp.path()).unwrap();
        let wt = setup_worktree(&root, "agent-A", "nonce-x");
        let pid = std::process::id() as i32;
        let lease = lease_with(&root, &wt, pid, "nonce-x", 1000, None);
        // age = 10s, heartbeat_timeout = 30s → alive
        assert_eq!(evaluate(&lease, 1010), AliveStatus::Alive);
    }

    #[test]
    fn quiescent_then_wedged_then_dead_ladder() {
        let tmp = tempfile::tempdir().unwrap();
        let root = ManagedRoot::new(tmp.path()).unwrap();
        let wt = setup_worktree(&root, "agent-A", "nonce-x");
        let pid = std::process::id() as i32;
        let lease = lease_with(&root, &wt, pid, "nonce-x", 1000, None);
        // heartbeat_timeout=30, quiescent=60, wedge_grace=30
        // age 10  → Alive
        // age 45  → Quiescent (between 30 and 60)
        // age 75  → Wedged (between 60 and 90)
        // age 200 → Dead (beyond 90)
        assert_eq!(evaluate(&lease, 1010), AliveStatus::Alive);
        assert_eq!(evaluate(&lease, 1045), AliveStatus::Quiescent);
        assert_eq!(evaluate(&lease, 1075), AliveStatus::Wedged);
        assert_eq!(evaluate(&lease, 1200), AliveStatus::Dead);
    }

    #[test]
    fn reaper_only_claims_wedged_and_dead() {
        assert!(!AliveStatus::Alive.reaper_can_claim());
        assert!(!AliveStatus::Quiescent.reaper_can_claim());
        assert!(AliveStatus::Wedged.reaper_can_claim());
        assert!(AliveStatus::Dead.reaper_can_claim());
    }

    #[test]
    fn pid_reuse_detected_via_start_time_mismatch() {
        // Spec §3.4: if owner_start_time is recorded, mismatch means
        // PID was reused → Dead. We use our own PID with a fake
        // expected start_time (very unlikely to match the real one).
        let tmp = tempfile::tempdir().unwrap();
        let root = ManagedRoot::new(tmp.path()).unwrap();
        let wt = setup_worktree(&root, "agent-A", "nonce-x");
        let pid = std::process::id() as i32;
        let lease = lease_with(
            &root, &wt, pid, "nonce-x", 1000, Some(0xDEAD_BEEF), // bogus
        );
        // start_time of a real running process won't match this magic
        // number → expect Dead
        assert_eq!(evaluate(&lease, 1010), AliveStatus::Dead);
    }
}
