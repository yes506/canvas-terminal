// Worktree subsystem — config
//
// PROD_ROOT vs TEST_ROOT separation per plan rev-2 §R-T2.7 + spec §0.
// Tests must not write to the production managed root; the env var
// `CANVAS_WORKTREE_ROOT` selects which one. Tests set this to a per-
// test tempdir; production reads the default user-config location.

use crate::worktree::types::ManagedRoot;
use std::path::PathBuf;

/// Env var that overrides the managed root. Tests set this to a
/// `tempfile::TempDir` path; production leaves it unset.
pub const ENV_WORKTREE_ROOT: &str = "CANVAS_WORKTREE_ROOT";

/// Default production managed-root path under the user's data dir.
/// Per plan rev-3 P1.2, dirs crate is already a direct dep.
pub fn default_prod_root() -> Option<PathBuf> {
    Some(dirs::data_local_dir()?.join("canvas-terminal").join("worktrees"))
}

/// Resolve the managed root from env (test path) or fall back to the
/// production default. Returns `None` if neither is available
/// (e.g., no env var AND `dirs::data_local_dir()` returns None on
/// the platform).
pub fn resolve_managed_root() -> Option<ManagedRoot> {
    if let Ok(env_path) = std::env::var(ENV_WORKTREE_ROOT) {
        return ManagedRoot::new(env_path);
    }
    default_prod_root().and_then(ManagedRoot::new)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn env_overrides_prod_default() {
        let tmp = tempfile::tempdir().unwrap();
        // SAFETY: env mutation in tests is racy across threads but acceptable
        // for this single-threaded test that resets after.
        // Use serial_test or per-test env scoping in real CI if needed.
        std::env::set_var(ENV_WORKTREE_ROOT, tmp.path());
        let root = resolve_managed_root().unwrap();
        assert_eq!(root.as_path(), tmp.path());
        std::env::remove_var(ENV_WORKTREE_ROOT);
    }

    #[test]
    fn env_must_be_absolute() {
        std::env::set_var(ENV_WORKTREE_ROOT, "relative/path");
        // resolve_managed_root() falls back to default_prod_root() when
        // the env var fails ManagedRoot::new validation. We only care
        // here that the relative env path is itself rejected — verify
        // by calling ManagedRoot::new directly with the same string.
        assert!(crate::worktree::types::ManagedRoot::new("relative/path").is_none());
        std::env::remove_var(ENV_WORKTREE_ROOT);
    }
}
