//! Integration smoke test for the production worktree-root path-jail policy.
//!
//! ## Why an integration test, not a unit test
//!
//! Unit tests in `src/commands/git.rs` run with `#[cfg(test)]` applied to
//! the lib crate, which makes `worktrees_root()` redirect to a process-wide
//! `OnceLock<TempDir>` (PR-A V1). That's what we want for unit-test isolation
//! — `cargo test` produces zero entries under `~/.cache/canvas-terminal/`.
//!
//! But it also means *no* same-binary unit test can exercise the production
//! `~/.cache/canvas-terminal/worktrees/` path. To prevent the test override
//! from masking a production-path regression, this integration test lives
//! in `tests/`. Integration test crates link the lib without `#[cfg(test)]`
//! applied to the lib, so calls into the lib see the real production root.
//!
//! The lib exposes a narrow `test_support::worktrees_root_for_policy_smoke`
//! wrapper (lib.rs F4 seam) that calls the production-path
//! `worktrees_root_production` — bypassing the test override even if a
//! future refactor accidentally enables it here too.
//!
//! ## What this test asserts
//!
//! 1. `worktrees_root_for_policy_smoke()` returns a path under
//!    `$HOME/.cache/canvas-terminal/worktrees/`.
//! 2. The directory exists (or is created) on disk.
//! 3. We can create a uniquely-named smoke entry under it.
//! 4. Drop cleanup removes that entry — leaving zero net delta in the
//!    production root after the test runs (CI gate E8).
//!
//! Future contributors: do NOT add tests here that exercise full git
//! command flows. Those belong in unit tests under the TempDir override.
//! This file is purely the path-jail policy smoke.

use canvas_terminal_lib::test_support::worktrees_root_for_policy_smoke;
use std::path::PathBuf;

/// Drop guard that removes a uniquely-named smoke entry from the production
/// worktrees root on test exit (success OR panic). Invariant E9.
struct SmokeEntryGuard {
    path: PathBuf,
}

impl Drop for SmokeEntryGuard {
    fn drop(&mut self) {
        // Best-effort: a leftover entry will be caught by the CI path-set
        // delta gate (E8), but we try to leave a clean trail anyway.
        let _ = std::fs::remove_dir_all(&self.path);
    }
}

#[test]
fn worktrees_root_resolves_to_production_path() {
    let root = worktrees_root_for_policy_smoke()
        .expect("worktrees_root_for_policy_smoke must succeed in a normal HOME-bearing environment");

    let home = dirs::home_dir().expect("HOME must be set for this smoke test");
    let expected = home
        .join(".cache")
        .join("canvas-terminal")
        .join("worktrees");

    assert_eq!(
        root, expected,
        "production worktrees_root must resolve to ~/.cache/canvas-terminal/worktrees/, \
         got {}",
        root.display()
    );

    assert!(
        root.exists(),
        "production root must exist on disk after the call (worktrees_root_production \
         calls create_dir_all): {}",
        root.display()
    );
}

#[test]
fn smoke_entry_under_production_root_creates_and_cleans() {
    let root = worktrees_root_for_policy_smoke().expect("worktrees_root_for_policy_smoke");

    // Unique smoke prefix: distinct from the fenced fixture pattern so the
    // safety-fenced debris cleanup script never touches it, and distinct
    // from any production session-* / agent dir.
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let pid = std::process::id();
    let entry = root.join(format!(".policy-jail-smoke-{}-{}", pid, nanos));

    let _guard = SmokeEntryGuard {
        path: entry.clone(),
    };

    std::fs::create_dir_all(&entry).expect("smoke entry create_dir_all must succeed");
    assert!(
        entry.exists(),
        "smoke entry must exist after create_dir_all: {}",
        entry.display()
    );

    // Path-jail policy invariant: smoke entry must canonicalize to a path
    // strictly under the production root. (We can't call
    // validate_managed_worktree_path directly from an integration test —
    // that's pub(crate) — but the equivalent check lives here.)
    let canonical_root = root
        .canonicalize()
        .expect("production root canonicalize must succeed");
    let canonical_entry = entry
        .canonicalize()
        .expect("smoke entry canonicalize must succeed");
    assert!(
        canonical_entry.starts_with(&canonical_root),
        "smoke entry canonical path ({}) must be under canonical production root ({})",
        canonical_entry.display(),
        canonical_root.display()
    );

    // Drop guard cleans up on scope exit; CI gate E8 verifies zero net
    // delta on the production root after the full test binary completes.
}
