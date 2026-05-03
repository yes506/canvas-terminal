// Worktree subsystem — managed root operations
//
// Bootstrap and validation of the managed-root directory layout per
// spec §6.1. The `ManagedRoot` newtype itself lives in `types.rs`;
// this module owns the disk-side bring-up (mkdir of subdirectories,
// permissions, sanity checks) and the path-validation helpers used
// throughout the worktree subsystem.

use crate::worktree::types::ManagedRoot;
use std::io;
use std::path::Path;

/// Bring the managed-root directory layout into existence on disk.
/// Idempotent: calling on an already-prepared root is a no-op.
///
/// Creates:
///   <managed_root>/
///   <managed_root>/locks/
///   <managed_root>/quarantine/
///   <managed_root>/worktrees/
///
/// Does NOT create `registry.json` or any lockfile — those are
/// created lazily by `RegistryStore` and `OrchestratorLock`.
pub fn ensure_layout(root: &ManagedRoot) -> io::Result<()> {
    std::fs::create_dir_all(root.as_path())?;
    std::fs::create_dir_all(root.locks_dir())?;
    std::fs::create_dir_all(root.quarantine_dir())?;
    std::fs::create_dir_all(root.worktrees_dir())?;
    Ok(())
}

/// Returns true iff `path` is inside the managed root by absolute-prefix.
/// Used by `write_audit` (Phase 4) and any path-accepting Tauri command
/// to enforce the C1+C2 constraints from spike 1.
pub fn contains(root: &ManagedRoot, path: &Path) -> bool {
    path.starts_with(root.as_path())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn ensure_layout_is_idempotent() {
        let tmp = tempfile::tempdir().unwrap();
        let root = ManagedRoot::new(tmp.path()).unwrap();

        ensure_layout(&root).unwrap();
        // second call should not error
        ensure_layout(&root).unwrap();

        assert!(root.locks_dir().is_dir());
        assert!(root.quarantine_dir().is_dir());
        assert!(root.worktrees_dir().is_dir());
    }

    #[test]
    fn contains_validates_absolute_prefix() {
        let tmp = tempfile::tempdir().unwrap();
        let root = ManagedRoot::new(tmp.path()).unwrap();

        let inside = root.locks_dir().join("agent-A.lock");
        let outside = PathBuf::from("/etc/passwd");

        assert!(contains(&root, &inside));
        assert!(!contains(&root, &outside));
    }
}
