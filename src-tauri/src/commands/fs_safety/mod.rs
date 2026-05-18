// Shared low-level filesystem-safety primitives.
//
// Per planner deltas M7 + U3: both `commands/memory.rs` (existing relative-path
// gate) and `commands/transcripts/fs_gate.rs` (new absolute-root gate) consume
// these primitives so the two hardening surfaces cannot drift.
//
// The FS-gate review-methodology memory note ("test deny lists with paths that
// canonicalize differently; defense-in-depth at every entry point") is the
// load-bearing prior art for this module.

use std::path::{Path, PathBuf};

/// Error returned by every primitive in this module.
#[derive(Debug)]
pub enum FsSafetyError {
    /// Path was a symlink or contained a symlinked component.
    Symlink(PathBuf),
    /// Canonicalize failed at the OS layer (missing path, permission, etc.).
    Canonicalize(std::io::Error),
    /// Path canonicalized outside the caller's allowed root.
    EscapedRoot { root: PathBuf, resolved: PathBuf },
}

/// Canonicalize `path` while rejecting symlinks at every component.
///
/// # Inputs
/// `path`: absolute path to verify and resolve.
///
/// # Returns
/// `Ok(PathBuf)` containing the canonicalized form on success.
///
/// # Errors
/// - `FsSafetyError::Symlink` if `path` itself or any component is a symlink
/// - `FsSafetyError::Canonicalize` if the OS canonicalize call fails
///
/// # Side effects
/// None — pure read-only metadata access (`lstat`/`readlink`).
///
/// # Invariants
/// Returned path is absolute and contains no symlink components. If the input
/// was relative, an error is returned (caller must absolutize first).
///
/// # Concurrency
/// Thread-safe. Filesystem races (TOCTOU) are inherent — callers that act on
/// the returned path must re-verify under any lock they hold.
///
/// # Lifecycle
/// Called from every gate entry point (memory.rs relative-path gate after
/// joining with the session root; transcripts/fs_gate.rs after joining with
/// each adapter's allow-list root).
///
/// # Test contract
/// `path` containing a symlinked component MUST return `Symlink(component)`,
/// not silently canonicalize through it. `..` segments are resolved before
/// the symlink check.
pub fn canonicalize_no_symlinks(_path: &Path) -> Result<PathBuf, FsSafetyError> {
    todo!()
}

/// Return raw `path` plus its `/private/`-prefixed mirror on macOS.
///
/// # Inputs
/// `path`: a canonical absolute path.
///
/// # Returns
/// `Vec<PathBuf>` containing `path` and, on macOS only, a second entry with the
/// `/private/` prefix prepended when the path starts with `/etc`, `/tmp`, or
/// `/var`. On other OSes, the vector contains only `path`.
///
/// # Errors
/// Never errors — input is treated as-is.
///
/// # Side effects
/// None.
///
/// # Invariants
/// On macOS, the mirror is added only when the input matches the documented
/// prefixes; arbitrary paths are not transformed.
///
/// # Concurrency
/// Pure function — thread-safe.
///
/// # Lifecycle
/// Called by gate constructors at startup when building the deny-prefix /
/// allow-root list. Mirrors the pattern in `commands/localfile.rs::build_deny_prefixes`.
///
/// # Test contract
/// Input `/etc/passwd` on macOS returns BOTH `/etc/passwd` and
/// `/private/etc/passwd`. Non-macOS callers see only the raw form. Input
/// `/Users/foo` returns only itself on every OS.
pub fn add_private_alias(_path: &Path) -> Vec<PathBuf> {
    todo!()
}

/// Walk `path` from root to leaf, rejecting if any component is a symlink.
///
/// # Inputs
/// `path`: absolute path to walk.
///
/// # Returns
/// `Ok(())` if every component (including the leaf) is a non-symlink.
///
/// # Errors
/// `FsSafetyError::Symlink(component)` naming the FIRST symlinked component
/// encountered. The walk stops at first symlink — does not enumerate all.
///
/// # Side effects
/// None — read-only `lstat` per component.
///
/// # Invariants
/// Walk is left-to-right; the leaf is checked last. If the input is relative,
/// it returns an error (caller must canonicalize first).
///
/// # Concurrency
/// Thread-safe but subject to filesystem TOCTOU. Callers performing a
/// rename-after-check must hold an exclusive lock or re-check post-rename.
///
/// # Lifecycle
/// Called from `canonicalize_no_symlinks` as the defense-in-depth check
/// AFTER `fs::canonicalize` succeeds — the canonical form might still
/// reach a symlinked leaf if the leaf was unlinked-and-recreated between
/// calls.
///
/// # Test contract
/// `/a/b/c` where `/a/b` is a symlink MUST return `Symlink("/a/b")`. Walk
/// must NOT follow the symlink to verify deeper. A path where every
/// component is a real directory returns `Ok(())`.
pub fn reject_symlink_in_walk(_path: &Path) -> Result<(), FsSafetyError> {
    todo!()
}
