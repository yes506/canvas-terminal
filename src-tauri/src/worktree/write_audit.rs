// Worktree subsystem — write audit (Phase 4)
//
// Per spec §0 non-goal "shell-mediated write confinement" + plan
// rev-3 P1.3 (audit, NOT enforcement):
//   This module provides APP-MEDIATED path validation only. Tauri
//   commands that take a path parameter consult `audit_path` to
//   verify the path is in the allowed set (worktree ∪ collab-memory
//   ∪ tmp). Refused attempts are recorded in an audit log.
//
// **Critical scope honesty**: this module does NOT prevent shell-
// mediated writes. An agent that has Bash access (Claude Code,
// Codex CLI) can write anywhere it has filesystem permissions for —
// `cd /etc && echo` works. Worktrees give git working-tree isolation,
// not OS sandboxing. UI copy MUST reflect this honestly per claude2's
// task-61 N4 / codex3 task-49 #4.
//
// Future Phase 6+: an OS-sandbox (macOS sandbox-exec, Linux
// namespaces) could provide real confinement. That's out of v1 scope
// per synthesis B.13 + spec §0.

use crate::worktree::types::{ManagedRoot, WorktreePath};
use std::path::{Component, Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

/// One audit log entry. Bounded by `AUDIT_LOG_CAPACITY`; oldest
/// entries drop when full. Production code should query via
/// `recent_audit_entries()`; tests can introspect by clearing first.
#[derive(Debug, Clone)]
pub struct AuditEntry {
    pub when_unix_secs: i64,
    pub agent_id: Option<String>,
    pub requested_path: PathBuf,
    pub reason: AuditReason,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AuditReason {
    /// Path validated against allowlist; request proceeds.
    Allowed,
    /// Path rejected because it's outside the allowed roots
    /// (worktree ∪ quarantine ∪ tmp\\managed_root).
    OutOfBounds,
    /// Path contains `..` or other traversal shapes.
    PathTraversal,
    /// Path canonicalization failed (symlink resolution error,
    /// permission denied, missing parent dir). Per B4 verifier
    /// convergence: fail-closed on canonicalize errors so a symlink
    /// pointing outside the allowed roots cannot bypass the check.
    SymlinkResolutionFailed,
}

/// Capacity of the in-memory audit log. Older entries roll off when
/// full; this is a debug aid, not a security log.
const AUDIT_LOG_CAPACITY: usize = 256;

fn audit_log() -> &'static Mutex<std::collections::VecDeque<AuditEntry>> {
    static LOG: OnceLock<Mutex<std::collections::VecDeque<AuditEntry>>> = OnceLock::new();
    LOG.get_or_init(|| Mutex::new(std::collections::VecDeque::with_capacity(AUDIT_LOG_CAPACITY)))
}

/// Return the most recent N audit entries (cloned).
pub fn recent_audit_entries(n: usize) -> Vec<AuditEntry> {
    let log = match audit_log().lock() {
        Ok(g) => g,
        Err(_) => return Vec::new(),
    };
    log.iter().rev().take(n).cloned().collect()
}

/// Clear the audit log (test helper).
#[cfg(test)]
pub fn clear_audit_log() {
    if let Ok(mut log) = audit_log().lock() {
        log.clear();
    }
}

fn record(entry: AuditEntry) {
    if let Ok(mut log) = audit_log().lock() {
        if log.len() >= AUDIT_LOG_CAPACITY {
            log.pop_front();
        }
        log.push_back(entry);
    }
}

/// Validate a Tauri-command-mediated path against the allowlist for
/// the given agent. Returns `Ok(canonical_path)` if allowed; returns
/// `Err(reason)` if rejected (and records an audit entry).
///
/// Allowed roots:
///   - The agent's `WorktreePath` (the agent owns this dir)
///   - `<managed_root>/quarantine/<agent_id>/` (preservation artifacts)
///   - The system tmpdir (writes here are agent-internal scratch)
///
/// Rejection reasons:
///   - `PathTraversal`: requested path contains `..` components
///   - `OutOfBounds`: requested path is not under any allowed root
///
/// Honesty constraint per spec §0 + plan rev-3 P1.3: this only
/// validates paths passed THROUGH Tauri commands. The agent's shell
/// can still write anywhere; we don't catch that.
pub fn audit_path(
    managed_root: &ManagedRoot,
    worktree: &WorktreePath,
    agent_id: Option<&crate::worktree::types::AgentId>,
    requested: &Path,
) -> Result<PathBuf, AuditReason> {
    // T2.4 fix per codex1 M1: agent_id is now `&AgentId` (validated
    // newtype) instead of raw `&str`, so callers can't pass a
    // traversal-shaped string that bypasses the quarantine prefix.

    let agent_id_str = agent_id.map(|a| a.as_str().to_string());

    // Reject `..` components first (defense-in-depth; AgentId
    // validation already prevents traversal in path construction,
    // but Tauri commands might receive raw paths from the frontend).
    if requested.components().any(|c| matches!(c, Component::ParentDir)) {
        record(AuditEntry {
            when_unix_secs: now_unix_secs(),
            agent_id: agent_id_str.clone(),
            requested_path: requested.to_path_buf(),
            reason: AuditReason::PathTraversal,
        });
        return Err(AuditReason::PathTraversal);
    }

    // B4 fix per verifier convergence (codex2+claude3+codex3):
    // canonicalize BEFORE prefix checks so a symlink inside an allowed
    // root that points OUTSIDE the allowed root is correctly rejected.
    // Without this, `<worktree>/escape -> /etc` would pass the prefix
    // check for `<worktree>/escape/passwd` while actually targeting
    // `/etc/passwd`.
    //
    // For paths that don't exist yet (write of new file), canonicalize
    // the deepest existing parent and append the unresolved tail. If
    // even the parent can't be canonicalized, fail-closed.
    let canonical = match canonicalize_with_unresolved_tail(requested) {
        Ok(p) => p,
        Err(_) => {
            record(AuditEntry {
                when_unix_secs: now_unix_secs(),
                agent_id: agent_id_str.clone(),
                requested_path: requested.to_path_buf(),
                reason: AuditReason::SymlinkResolutionFailed,
            });
            return Err(AuditReason::SymlinkResolutionFailed);
        }
    };

    // Allowed prefixes — checked against the CANONICAL path so symlink
    // bypass is impossible.
    //
    // On macOS, `/var/folders/...` canonicalizes to `/private/var/...`
    // (and `/tmp` to `/private/tmp`); on Linux those are usually the
    // same. We canonicalize each ROOT prefix too so the comparison is
    // canonical-to-canonical. Roots may not exist yet (e.g.,
    // quarantine before any preservation has happened); use the
    // unresolved-tail helper for them too.
    let canon_worktree = canonicalize_with_unresolved_tail(worktree.as_path())
        .unwrap_or_else(|_| worktree.as_path().to_path_buf());
    let canon_managed_root = canonicalize_with_unresolved_tail(managed_root.as_path())
        .unwrap_or_else(|_| managed_root.as_path().to_path_buf());
    let canon_tmp = canonicalize_with_unresolved_tail(&std::env::temp_dir())
        .unwrap_or_else(|_| std::env::temp_dir());

    let in_worktree = canonical.starts_with(&canon_worktree);
    let in_quarantine = match agent_id {
        Some(a) => {
            let q = canonicalize_with_unresolved_tail(&managed_root.quarantine_dir_for(a))
                .unwrap_or_else(|_| managed_root.quarantine_dir_for(a));
            canonical.starts_with(&q)
        }
        None => false,
    };
    // System tmp dir is allowed for agent-internal scratch, BUT only
    // when the path is NOT also under the managed root. Without this
    // exclusion, a deployment with `managed_root` under the system
    // tmpdir (notably tests, where `tempfile::tempdir()` lives under
    // `/var/folders/.../T/`) would allow any agent to access any
    // other agent's quarantine because everything is "under tmp."
    let in_tmp = canonical.starts_with(&canon_tmp)
        && !canonical.starts_with(&canon_managed_root);

    if in_worktree || in_quarantine || in_tmp {
        record(AuditEntry {
            when_unix_secs: now_unix_secs(),
            agent_id: agent_id_str,
            requested_path: requested.to_path_buf(),
            reason: AuditReason::Allowed,
        });
        Ok(canonical)
    } else {
        record(AuditEntry {
            when_unix_secs: now_unix_secs(),
            agent_id: agent_id_str,
            requested_path: requested.to_path_buf(),
            reason: AuditReason::OutOfBounds,
        });
        Err(AuditReason::OutOfBounds)
    }
}

/// Canonicalize a path that may not exist yet. Resolves symlinks for
/// the deepest existing prefix; appends the unresolved tail components
/// verbatim. Returns Err if the deepest existing prefix can't be
/// canonicalized (permission denied, missing root, broken symlink).
fn canonicalize_with_unresolved_tail(p: &Path) -> std::io::Result<PathBuf> {
    if let Ok(canon) = p.canonicalize() {
        return Ok(canon);
    }
    // Walk up to find the deepest existing parent
    let mut existing: PathBuf = p.to_path_buf();
    let mut tail: Vec<std::ffi::OsString> = Vec::new();
    while !existing.exists() {
        match (existing.parent(), existing.file_name()) {
            (Some(parent), Some(name)) => {
                tail.push(name.to_os_string());
                existing = parent.to_path_buf();
            }
            _ => {
                return Err(std::io::Error::other(
                    "no existing parent directory could be canonicalized",
                ));
            }
        }
    }
    let mut canonical = existing.canonicalize()?;
    for segment in tail.iter().rev() {
        canonical.push(segment);
    }
    Ok(canonical)
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
    use crate::worktree::types::AgentId;

    fn fresh_root_and_worktree() -> (tempfile::TempDir, ManagedRoot, WorktreePath) {
        let tmp = tempfile::tempdir().unwrap();
        let root = ManagedRoot::new(tmp.path()).unwrap();
        ensure_layout(&root).unwrap();
        let agent = AgentId::new("agent-A").unwrap();
        let wt = WorktreePath::for_agent(&root, &agent);
        (tmp, root, wt)
    }

    #[test]
    #[serial_test::serial(audit_log)]
    fn allows_path_inside_worktree() {
        let (_tmp, root, wt) = fresh_root_and_worktree();
        std::fs::create_dir_all(wt.as_path()).unwrap();
        let agent = AgentId::new("agent-A").unwrap();
        let inside = wt.as_path().join("file.txt");
        let result = audit_path(&root, &wt, Some(&agent), &inside);
        assert!(result.is_ok(), "got {result:?}");
    }

    #[test]
    #[serial_test::serial(audit_log)]
    fn allows_path_inside_quarantine_for_agent() {
        let (_tmp, root, wt) = fresh_root_and_worktree();
        let agent = AgentId::new("agent-A").unwrap();
        std::fs::create_dir_all(root.quarantine_dir_for(&agent)).unwrap();
        let q = root.quarantine_dir_for(&agent).join("manifest.json");
        let result = audit_path(&root, &wt, Some(&agent), &q);
        assert!(result.is_ok(), "got {result:?}");
    }

    #[test]
    #[serial_test::serial(audit_log)]
    fn allows_path_inside_tmp() {
        let (_tmp, root, wt) = fresh_root_and_worktree();
        let agent = AgentId::new("agent-A").unwrap();
        // Pre-create the tmp scratch file's parent so canonicalize succeeds
        std::fs::create_dir_all(std::env::temp_dir()).ok();
        let tmppath = std::env::temp_dir().join("audit-test-scratch.txt");
        let result = audit_path(&root, &wt, Some(&agent), &tmppath);
        // tmp dir exists; canonicalize should succeed; path is in tmp
        // and NOT under managed_root → Allowed
        assert!(result.is_ok(), "got {result:?}");
    }

    #[test]
    #[serial_test::serial(audit_log)]
    fn rejects_path_outside_all_allowed_roots() {
        let (_tmp, root, wt) = fresh_root_and_worktree();
        let agent = AgentId::new("agent-A").unwrap();
        let outside = std::path::PathBuf::from("/etc/passwd");
        let result = audit_path(&root, &wt, Some(&agent), &outside);
        assert_eq!(result, Err(AuditReason::OutOfBounds));
    }

    #[test]
    #[serial_test::serial(audit_log)]
    fn rejects_path_with_parent_dir_component() {
        let (_tmp, root, wt) = fresh_root_and_worktree();
        let agent = AgentId::new("agent-A").unwrap();
        // Even a path that lexically starts with worktree but contains
        // `..` is rejected before canonicalization
        let traversal = wt.as_path().join("..").join("escape");
        let result = audit_path(&root, &wt, Some(&agent), &traversal);
        assert_eq!(result, Err(AuditReason::PathTraversal));
    }

    #[test]
    #[serial_test::serial(audit_log)]
    fn rejects_quarantine_for_other_agent_id() {
        let (_tmp, root, wt) = fresh_root_and_worktree();
        let agent_a = AgentId::new("agent-A").unwrap();
        let agent_b = AgentId::new("agent-B").unwrap();
        std::fs::create_dir_all(root.quarantine_dir_for(&agent_b)).unwrap();
        let q = root.quarantine_dir_for(&agent_b).join("file.json");
        // Audit context says this is agent-A; agent-B's quarantine
        // is not allowed for agent-A
        let result = audit_path(&root, &wt, Some(&agent_a), &q);
        assert_eq!(result, Err(AuditReason::OutOfBounds));
    }

    #[test]
    #[serial_test::serial(audit_log)]
    fn b4_rejects_symlink_pointing_outside_allowed_roots() {
        // B4 fix: a symlink inside the worktree pointing to /etc would
        // pass a lexical prefix check; canonicalize() resolves the
        // symlink and the result is correctly rejected.
        #[cfg(unix)]
        {
            let (_tmp, root, wt) = fresh_root_and_worktree();
            std::fs::create_dir_all(wt.as_path()).unwrap();
            let agent = AgentId::new("agent-A").unwrap();
            // Create a symlink: <wt>/escape -> /etc
            let symlink = wt.as_path().join("escape");
            std::os::unix::fs::symlink("/etc", &symlink).unwrap();
            // Try to access <wt>/escape/passwd — lexically inside wt,
            // but resolves to /etc/passwd which is outside.
            let target = symlink.join("passwd");
            let result = audit_path(&root, &wt, Some(&agent), &target);
            assert_eq!(
                result,
                Err(AuditReason::OutOfBounds),
                "symlink to /etc must be rejected after canonicalization"
            );
        }
    }

    #[test]
    #[serial_test::serial(audit_log)]
    fn b4_canonicalize_unresolved_tail_works_for_new_files() {
        // canonicalize_with_unresolved_tail handles paths that don't
        // exist yet — important for write-of-new-file commands.
        let (_tmp, root, wt) = fresh_root_and_worktree();
        std::fs::create_dir_all(wt.as_path()).unwrap();
        let agent = AgentId::new("agent-A").unwrap();
        // File doesn't exist yet
        let new_file = wt.as_path().join("not-yet-created.txt");
        let result = audit_path(&root, &wt, Some(&agent), &new_file);
        assert!(result.is_ok(), "got {result:?}");
    }

    #[test]
    #[serial_test::serial(audit_log)]
    fn audit_log_records_recent_entries() {
        clear_audit_log();
        let (_tmp, root, wt) = fresh_root_and_worktree();
        std::fs::create_dir_all(wt.as_path()).unwrap();
        let agent = AgentId::new("agent-A").unwrap();
        let inside = wt.as_path().join("ok.txt");
        let _ = audit_path(&root, &wt, Some(&agent), &inside);
        let outside = std::path::PathBuf::from("/etc/passwd");
        let _ = audit_path(&root, &wt, Some(&agent), &outside);

        let entries = recent_audit_entries(10);
        assert!(entries.len() >= 2);
        // Most recent first (rejected /etc/passwd)
        assert_eq!(entries[0].reason, AuditReason::OutOfBounds);
        assert_eq!(entries[1].reason, AuditReason::Allowed);
    }
}
