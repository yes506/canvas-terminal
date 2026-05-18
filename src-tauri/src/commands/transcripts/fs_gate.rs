// External-root FS gate for transcript adapters.
//
// Per C3 / X1 / X2: `memory.rs` is the gate for relative paths INSIDE
// `collab-memory`; THIS module is the gate for absolute paths in user-home
// transcript roots (`~/.claude`, `~/.codex`, `~/.gemini`). Same low-level
// primitives (`fs_safety`), different policy layer.

use std::path::{Path, PathBuf};

use super::super::fs_safety::{self, FsSafetyError};

/// Errors during transcript-root validation.
#[derive(Debug)]
pub enum GateError {
    /// `adapter_id` is not present in the compiled-in allow-list.
    UnknownAdapter(String),
    /// Candidate path resolves outside the adapter's allowed root.
    OutsideRoot { adapter_id: &'static str, candidate: PathBuf },
    /// Underlying fs_safety primitive rejected the path.
    FsSafety(FsSafetyError),
}

impl From<FsSafetyError> for GateError {
    fn from(e: FsSafetyError) -> Self { GateError::FsSafety(e) }
}

/// Verify that `candidate` is a legitimate transcript path for the given
/// `adapter_id` and return its canonicalized form.
///
/// # Inputs
/// - `adapter_id`: the adapter's `tool_id()` (e.g. `"claude_code"`).
/// - `candidate`: absolute path to a `.jsonl` claimed to be a transcript.
///
/// # Returns
/// `Ok(PathBuf)` containing the canonicalized form. Caller uses this for
/// open/read; the raw candidate is discarded.
///
/// # Errors
/// - `GateError::UnknownAdapter` if `adapter_id` has no allow-root entry.
/// - `GateError::OutsideRoot` if the canonicalized candidate is not a
///   descendant of the adapter's allowed root (after applying
///   `fs_safety::add_private_alias`).
/// - `GateError::FsSafety` for symlink rejection or canonicalize failures.
///
/// # Side effects
/// Read-only: canonicalize + per-component lstat.
///
/// # Invariants
/// The returned path is absolute, canonical, contains no symlink component,
/// and starts with the adapter's allowed root prefix (raw or `/private/`
/// canonicalized form on macOS).
///
/// # Concurrency
/// Thread-safe; TOCTOU exists between this check and any subsequent
/// `open()` — callers MUST `O_NOFOLLOW`-open OR re-check after read.
///
/// # Lifecycle
/// Called from `TranscriptAdapter::discover_session` (binding-time, one
/// time per agent), and from `TranscriptWatcher::watch` (re-verification
/// before subscribing FSEvents).
///
/// # Test contract
/// Adversarial corpus per R5 MUST pass:
/// - Traversal: `~/.claude/projects/<slug>/../../../etc/passwd` → DENY
/// - Symlink-out: symlink under transcript root → DENY
/// - macOS `/private/` aliasing parity: raw + canonicalized forms ACCEPT
/// - Slug containing env-var-looking text → strict-treat-as-literal
/// - NUL byte in slug → DENY
/// - Wrong-root paths (`~/.bash_history`, `~/.ssh/id_rsa`) → DENY
/// - Case-folded paths on APFS (`~/.CLAUDE/PROJECTS/...`) → DENY (raw
///   prefix match is case-sensitive even though APFS resolves them).
pub fn check_transcript_root(
    adapter_id: &str,
    candidate: &Path,
) -> Result<PathBuf, GateError> {
    let _ = (adapter_id, candidate);
    let _ = fs_safety::canonicalize_no_symlinks; // silence unused-import on todo build
    todo!()
}

/// Allowed-root descriptor compiled-in per adapter.
pub struct AllowedRoot {
    pub adapter_id: &'static str,
    /// Path under `~` (joined at runtime); e.g. `".claude/projects"`.
    pub home_relative: &'static str,
}

/// The compiled allow-list. Adding a new adapter for an existing registered
/// tool requires zero changes outside `adapters/<tool>.rs` UNLESS the new
/// adapter's root is genuinely new — in which case a new entry here is
/// allowed. Production adapter set per K3: claude_code, codex, gemini.
pub const ALLOWED_ROOTS: &[AllowedRoot] = &[
    AllowedRoot { adapter_id: "claude_code", home_relative: ".claude/projects" },
    AllowedRoot { adapter_id: "codex",       home_relative: ".codex/sessions" },
    AllowedRoot { adapter_id: "gemini",      home_relative: ".gemini/tmp" },
];
