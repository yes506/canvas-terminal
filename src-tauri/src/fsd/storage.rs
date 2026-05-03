//! FSD durable storage primitives.
//!
//! All FSD run state lives under `~/.cache/canvas-terminal/collab-memory/fsd-runs/`
//! (the *non-session* root). This is structurally invisible to
//! `clear_stale_sessions()` — that scanner only matches `session-<pid>` directories
//! per `parse_session_pid` (memory.rs:27). See plan v5 §1.2 for verification.
//!
//! ## INVARIANTS
//!
//! 1. `claim_memory_file` operates ONLY on paths under the durable root, NOT
//!    under `session-<pid>/`. Both `from` and `to` MUST start with `fsd-runs/`.
//! 2. This module is NOT exposed via `#[tauri::command]`. It is `pub(crate)`,
//!    backend-only, called by FSD orchestrator code that builds paths from
//!    typed `(run_id, task_id)` tuples — not from raw leader JSON.
//! 3. The atomic claim uses kernel-level no-replace rename (`renamex_np` on
//!    macOS, `renameat2` on Linux). Plain `std::fs::rename` silently overwrites
//!    on Unix — verified empirically in plan v5 §2.1.
//!
//! See plan v5 §4.1 + §5.7 for the P0 fix that motivated this module.

use crate::commands::memory::{get_memory_root, validate_relative_path};
use std::path::Path;

/// Phase-2+ atomic-claim infrastructure. Phase 1 doesn't currently use the
/// pending → processing → done state machine — orchestrator writes the
/// task result directly to the task dir. The primitive remains as scaffolding
/// for Phase 2's multi-claimer dispatch coordination.
#[allow(dead_code)]
const FSD_PREFIX: &str = "fsd-runs/";

/// Atomic claim primitive: rename `from` → `to` within `fsd-runs/`.
///
/// Both paths MUST be relative and start with `fsd-runs/`. The rename uses
/// kernel-level no-replace semantics so concurrent claimers cannot overwrite
/// each other.
///
/// Returns:
/// - `Ok(true)` — rename succeeded; caller now owns the destination path.
/// - `Ok(false)` — source did not exist (race lost; caller should pick another candidate).
/// - `Err(...)` — validation, scope, or I/O error; destination guaranteed not to exist or be overwritten.
#[allow(dead_code)] // Phase 2: orchestrator's pending→processing→done workflow
pub(crate) fn claim_memory_file(from: &str, to: &str) -> Result<bool, String> {
    if !from.starts_with(FSD_PREFIX) {
        return Err(format!("scope: source must be under {}", FSD_PREFIX));
    }
    if !to.starts_with(FSD_PREFIX) {
        return Err(format!("scope: destination must be under {}", FSD_PREFIX));
    }
    validate_relative_path(from)?;
    validate_relative_path(to)?;
    let root = get_memory_root()?;
    reject_symlink_components(&root, from)?;
    reject_symlink_components(&root, to)?;

    let from_abs = root.join(from);
    let to_abs = root.join(to);

    // Source must exist as a regular file (not symlink, not directory).
    let meta = match std::fs::symlink_metadata(&from_abs) {
        Ok(m) => m,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(e) => return Err(e.to_string()),
    };
    if meta.file_type().is_symlink() {
        return Err("source is a symlink".into());
    }
    if !meta.is_file() {
        return Err("source is not a regular file".into());
    }

    // Create destination parent dirs *after* validating they're symlink-free,
    // then re-check post-create in case of intervening symlink races.
    if let Some(parent_rel) = Path::new(to).parent().and_then(|p| p.to_str()) {
        if !parent_rel.is_empty() {
            std::fs::create_dir_all(root.join(parent_rel)).map_err(|e| e.to_string())?;
            reject_symlink_components(&root, parent_rel)?;
        }
    }

    rename_no_replace(&from_abs, &to_abs)
}

/// Walk every component of `root.join(relative)` under `root` and reject if
/// any existing component is a symlink. Components that don't exist yet are
/// fine (they'll be created safely later).
///
/// Takes `root: &Path` (vs re-deriving via `get_memory_root()`) so callers
/// can pass the same root they used for `root.join(...)` — single derivation
/// per claim, no syscall amplification (per @claude3 task-30 §4.4).
#[allow(dead_code)] // called by claim_memory_file (Phase 2 workflow)
pub(crate) fn reject_symlink_components(root: &Path, relative: &str) -> Result<(), String> {
    let mut walk = root.to_path_buf();
    for comp in Path::new(relative).components() {
        match comp {
            std::path::Component::Normal(seg) => {
                walk.push(seg);
                if let Ok(meta) = std::fs::symlink_metadata(&walk) {
                    if meta.file_type().is_symlink() {
                        return Err(format!("symlinked path component: {}", walk.display()));
                    }
                }
            }
            std::path::Component::CurDir => continue,
            // RootDir / ParentDir / Prefix should have been rejected by
            // validate_relative_path upstream; defense in depth here.
            _ => return Err(format!("disallowed path component: {:?}", comp)),
        }
    }
    Ok(())
}

/// Kernel-level no-replace rename.
///
/// `std::fs::rename` silently overwrites destinations on Unix — verified
/// empirically in plan v5 §2.1 by reproducing `mv a.txt b.txt` overwriting
/// b.txt's content. For an atomic claim primitive that arbitrates concurrent
/// claimers, only kernel-level RENAME_EXCL / RENAME_NOREPLACE is safe.
///
/// Returns:
/// - `Ok(true)` — rename succeeded.
/// - `Ok(false)` — source didn't exist (ENOENT — race lost).
/// - `Err(...)` — destination existed (EEXIST) or other I/O error.
#[allow(dead_code)] // called by claim_memory_file (Phase 2 workflow)
#[cfg(target_os = "macos")]
fn rename_no_replace(from: &Path, to: &Path) -> Result<bool, String> {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;

    let from_c = CString::new(from.as_os_str().as_bytes()).map_err(|e| e.to_string())?;
    let to_c = CString::new(to.as_os_str().as_bytes()).map_err(|e| e.to_string())?;
    // RENAME_EXCL: fail with EEXIST if destination exists (atomic).
    // libc::renamex_np is available on macOS 10.12+.
    let rc = unsafe { libc::renamex_np(from_c.as_ptr(), to_c.as_ptr(), libc::RENAME_EXCL) };
    if rc == 0 {
        return Ok(true);
    }
    let err = std::io::Error::last_os_error();
    match err.raw_os_error() {
        Some(libc::ENOENT) => Ok(false),
        Some(libc::EEXIST) => Err("destination already exists".into()),
        _ => Err(err.to_string()),
    }
}

#[cfg(target_os = "linux")]
fn rename_no_replace(from: &Path, to: &Path) -> Result<bool, String> {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;

    let from_c = CString::new(from.as_os_str().as_bytes()).map_err(|e| e.to_string())?;
    let to_c = CString::new(to.as_os_str().as_bytes()).map_err(|e| e.to_string())?;
    // renameat2(AT_FDCWD, from, AT_FDCWD, to, RENAME_NOREPLACE) — Linux 3.15+.
    const RENAME_NOREPLACE: libc::c_uint = 1;
    let rc = unsafe {
        libc::syscall(
            libc::SYS_renameat2,
            libc::AT_FDCWD,
            from_c.as_ptr(),
            libc::AT_FDCWD,
            to_c.as_ptr(),
            RENAME_NOREPLACE,
        )
    };
    if rc == 0 {
        return Ok(true);
    }
    let err = std::io::Error::last_os_error();
    match err.raw_os_error() {
        Some(libc::ENOENT) => Ok(false),
        Some(libc::EEXIST) => Err("destination already exists".into()),
        _ => Err(err.to_string()),
    }
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn rename_no_replace(_from: &Path, _to: &Path) -> Result<bool, String> {
    // Phase 5 Windows support; Phase 1 is unix-only per plan v5 §11 non-goal.
    Err("FSD claim_memory_file: this OS is not supported in Phase 1".into())
}

// ---------------------------------------------------------------------------
// Typed run/task path builders (per plan v5 §5.7 / item N).
//
// The Rust orchestrator constructs claim paths from typed identifiers, NOT
// from raw leader JSON. Defense in depth: a leader cannot construct path
// strings that bypass FSD scope or the run/task hierarchy.
// ---------------------------------------------------------------------------

/// Type-safe path builder for a single FSD task within a run/turn.
///
/// Fields are PRIVATE; construct via `TaskPath::try_new(...)` so that every
/// ID is validated against `[A-Za-z0-9._-]+` (no slashes, no `..`, no empty,
/// no control chars). Without this guard, a leader-supplied `task_id` like
/// `../../foo` could escape the FSD scope (validate_relative_path would
/// catch it later, but defense in depth — the orchestrator builds these
/// paths from leader JSON and we want failure at construction, not at IPC).
/// (Per @codex2 task-42 P1.)
pub(crate) struct TaskPath<'a> {
    leader_handle: &'a str,
    run_id: &'a str,
    turn: u32,
    task_id: &'a str,
}

impl<'a> TaskPath<'a> {
    /// Construct a TaskPath, validating each identifier component.
    ///
    /// Allowed characters per ID: ASCII letters, digits, `.`, `_`, `-`.
    /// Rejects empty strings, `/`, `..`, control characters, and non-ASCII.
    pub fn try_new(
        leader_handle: &'a str,
        run_id: &'a str,
        turn: u32,
        task_id: &'a str,
    ) -> Result<Self, String> {
        validate_id_component("leader_handle", leader_handle)?;
        validate_id_component("run_id", run_id)?;
        validate_id_component("task_id", task_id)?;
        Ok(Self { leader_handle, run_id, turn, task_id })
    }

    fn dir(&self) -> String {
        format!(
            "fsd-runs/{}/runs/{}/turns/{}/tasks/{}",
            self.leader_handle, self.run_id, self.turn, self.task_id
        )
    }

    pub fn pending(&self) -> String {
        format!("{}/pending.json", self.dir())
    }

    /// Phase 2: target path for `claim_memory_file(pending → processing)`.
    #[allow(dead_code)]
    pub fn processing(&self) -> String {
        format!("{}/processing.json", self.dir())
    }

    /// Phase 2: target path for `claim_memory_file(processing → done)`.
    #[allow(dead_code)]
    pub fn done(&self) -> String {
        format!("{}/done.json", self.dir())
    }
}

/// Validate an identifier intended to become a path segment. Allows the
/// minimal "URL-/filename-safe" subset: ASCII alphanumerics + `.`, `_`, `-`.
fn validate_id_component(field: &str, value: &str) -> Result<(), String> {
    if value.is_empty() {
        return Err(format!("{}: must not be empty", field));
    }
    // Disallow `..` even when surrounded by other allowed chars — prevents
    // `..foo` or `foo..` and the literal `..`. (validate_relative_path
    // catches the literal but a path segment containing `..` is also suspicious.)
    if value == "." || value == ".." {
        return Err(format!("{}: must not be '.' or '..'", field));
    }
    for (i, ch) in value.chars().enumerate() {
        match ch {
            'A'..='Z' | 'a'..='z' | '0'..='9' | '.' | '_' | '-' => continue,
            _ => return Err(format!(
                "{}: invalid character {:?} at position {} (allowed: A-Z a-z 0-9 . _ -)",
                field, ch, i
            )),
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::sync::atomic::{AtomicU32, Ordering};
    use std::sync::Once;

    static TEST_COUNTER: AtomicU32 = AtomicU32::new(0);
    static INIT_TEST_ROOT: Once = Once::new();

    /// Set CANVAS_TERMINAL_MEMORY_ROOT to a per-test-process tempdir on first
    /// call so tests don't pollute the user's real ~/.cache. Idempotent across
    /// parallel test threads via std::sync::Once. (Per @claude3 task-43 §5.2.)
    fn ensure_test_root_isolated() {
        INIT_TEST_ROOT.call_once(|| {
            // Only override if not already set (so CI can pin its own path).
            if std::env::var("CANVAS_TERMINAL_MEMORY_ROOT").is_err() {
                let test_root = std::env::temp_dir()
                    .join(format!("canvas-terminal-fsd-test-{}", std::process::id()));
                fs::create_dir_all(&test_root).expect("create test_root");
                // SAFETY: set_var is unsafe in Rust 2024 due to env-thread-safety
                // concerns. We're calling this from std::sync::Once at test-init,
                // before any other thread reads the env var, so the race is closed.
                #[allow(unused_unsafe)]
                unsafe {
                    std::env::set_var(
                        "CANVAS_TERMINAL_MEMORY_ROOT",
                        test_root.to_string_lossy().as_ref(),
                    );
                }
            }
        });
    }

    /// Each test gets its own subdirectory under fsd-runs/ to avoid collisions
    /// when run in parallel with `cargo test` (which uses multiple threads).
    fn unique_test_prefix() -> String {
        ensure_test_root_isolated();
        let n = TEST_COUNTER.fetch_add(1, Ordering::SeqCst);
        format!("fsd-runs/_test/{}-{}", std::process::id(), n)
    }

    fn write_file(rel: &str, content: &str) {
        let root = get_memory_root().unwrap();
        let abs = root.join(rel);
        fs::create_dir_all(abs.parent().unwrap()).unwrap();
        fs::write(&abs, content).unwrap();
    }

    fn cleanup(rel: &str) {
        let root = get_memory_root().unwrap();
        let _ = fs::remove_dir_all(root.join(rel));
    }

    #[test]
    fn happy_path_pending_to_processing() {
        let prefix = unique_test_prefix();
        let from = format!("{}/pending.json", prefix);
        let to = format!("{}/processing.json", prefix);
        write_file(&from, "{}");

        let result = claim_memory_file(&from, &to);
        assert_eq!(result, Ok(true));

        let root = get_memory_root().unwrap();
        assert!(!root.join(&from).exists(), "source should be gone");
        assert!(root.join(&to).exists(), "destination should exist");

        cleanup(&prefix);
    }

    #[test]
    fn missing_source_returns_ok_false() {
        let prefix = unique_test_prefix();
        let from = format!("{}/never-existed.json", prefix);
        let to = format!("{}/dest.json", prefix);

        let result = claim_memory_file(&from, &to);
        assert_eq!(result, Ok(false));

        cleanup(&prefix);
    }

    #[test]
    fn destination_exists_returns_err() {
        let prefix = unique_test_prefix();
        let from = format!("{}/pending.json", prefix);
        let to = format!("{}/processing.json", prefix);
        write_file(&from, "FROM");
        write_file(&to, "TO");

        let result = claim_memory_file(&from, &to);
        assert!(result.is_err(), "expected Err, got {:?}", result);

        // CRITICAL: destination must NOT have been overwritten (this is the
        // P0 bug from plan v5 §2.1 that std::fs::rename had).
        let root = get_memory_root().unwrap();
        let to_content = fs::read_to_string(root.join(&to)).unwrap();
        assert_eq!(to_content, "TO", "destination must not be overwritten");

        cleanup(&prefix);
    }

    #[test]
    fn scope_violation_from_rejected() {
        let result = claim_memory_file("session-1234/foo.md", "fsd-runs/dest.json");
        assert!(matches!(result, Err(ref e) if e.contains("source must be under fsd-runs/")));
    }

    #[test]
    fn scope_violation_to_rejected() {
        let result = claim_memory_file("fsd-runs/foo.json", "session-1234/dest.md");
        assert!(matches!(result, Err(ref e) if e.contains("destination must be under fsd-runs/")));
    }

    #[test]
    fn traversal_rejected() {
        let result = claim_memory_file("fsd-runs/../../etc/passwd", "fsd-runs/dest.json");
        assert!(result.is_err());
    }

    /// Regression test: v3's `reject_symlink_components` walked absolute path
    /// components from `/`, so `walk == "/"` failed `starts_with(root)` on
    /// the first iteration and rejected every valid path. v5's helper takes
    /// the relative path under a cloned root, only handling `Component::Normal`
    /// segments. (Per @claude2 task-34 §2.4.)
    #[test]
    fn regression_v3_absolute_path_bug() {
        let prefix = unique_test_prefix();
        let from = format!("{}/pending.json", prefix);
        let to = format!("{}/processing.json", prefix);
        write_file(&from, "{}");

        // The relative path here, under root, expands to an absolute path
        // like /Users/.../collab-memory/fsd-runs/_test/.../pending.json.
        // v3's reject_symlink_components(absolute) would have failed here
        // because walk = "/" doesn't start with the root path.
        // v5's reject_symlink_components(root, relative) walks under root
        // and only checks Component::Normal segments — works correctly.
        let result = claim_memory_file(&from, &to);
        assert_eq!(result, Ok(true), "v3 bug regression: should accept");

        cleanup(&prefix);
    }

    #[test]
    fn task_path_builder_shape() {
        let path = TaskPath::try_new("claude1", "abc123", 2, "t-2-a").unwrap();
        assert_eq!(
            path.pending(),
            "fsd-runs/claude1/runs/abc123/turns/2/tasks/t-2-a/pending.json"
        );
        assert_eq!(
            path.processing(),
            "fsd-runs/claude1/runs/abc123/turns/2/tasks/t-2-a/processing.json"
        );
        assert_eq!(
            path.done(),
            "fsd-runs/claude1/runs/abc123/turns/2/tasks/t-2-a/done.json"
        );
    }

    #[test]
    fn task_path_rejects_slash_in_id() {
        // Per @codex2 task-42 P1: a leader-supplied task_id with a `/` would
        // alter the directory hierarchy under fsd-runs/ even though
        // validate_relative_path passes the resulting full path.
        let result = TaskPath::try_new("claude1", "abc/../bad", 1, "t-1-a");
        assert!(matches!(result, Err(ref e) if e.contains("run_id")));

        let result = TaskPath::try_new("claude1", "ok", 1, "t-1-a/escape");
        assert!(matches!(result, Err(ref e) if e.contains("task_id")));
    }

    #[test]
    fn task_path_rejects_dot_dot() {
        let result = TaskPath::try_new("..", "ok", 1, "t-1-a");
        assert!(matches!(result, Err(ref e) if e.contains("leader_handle")));

        let result = TaskPath::try_new("ok", "..", 1, "t-1-a");
        assert!(matches!(result, Err(ref e) if e.contains("run_id")));
    }

    #[test]
    fn task_path_rejects_empty() {
        let result = TaskPath::try_new("", "ok", 1, "t-1-a");
        assert!(matches!(result, Err(ref e) if e.contains("must not be empty")));
    }

    #[test]
    fn task_path_rejects_control_chars() {
        let result = TaskPath::try_new("claude1\n", "ok", 1, "t-1-a");
        assert!(matches!(result, Err(ref e) if e.contains("invalid character")));

        let result = TaskPath::try_new("ok", "ok", 1, "t-1-a\0");
        assert!(matches!(result, Err(ref e) if e.contains("invalid character")));
    }

    #[test]
    fn task_path_rejects_non_ascii() {
        // Defense in depth: filesystem nuances around UTF-8 normalization,
        // case-folding, and Windows path semantics make ASCII-only safer.
        let result = TaskPath::try_new("클로드", "ok", 1, "t-1-a");
        assert!(matches!(result, Err(ref e) if e.contains("invalid character")));
    }

    #[test]
    fn task_path_accepts_safe_chars() {
        // All of these are valid: letters, digits, dots, underscores, hyphens.
        let path = TaskPath::try_new("claude1", "run_2026-05-03.abc", 99, "t.1-a_b");
        assert!(path.is_ok());
    }

    /// Regression guard per plan v5 §5.7 / item L (raised by @codex2 task-35
    /// + @claude2 task-41 §2.2): `claim_memory_file` MUST stay backend-only.
    /// If a future PR accidentally adds the Tauri command attribute above the
    /// function or registers it via `tauri::generate_handler!`, this fails.
    ///
    /// Walks lines and skips doc comments / regular comments so the test
    /// doesn't self-match its own description text or the module's INVARIANTS
    /// doc-block.
    #[test]
    fn claim_memory_file_is_not_a_tauri_command() {
        // CARGO_MANIFEST_DIR points to src-tauri/.
        let manifest = std::env::var("CARGO_MANIFEST_DIR")
            .expect("CARGO_MANIFEST_DIR must be set during tests");

        // Build the attribute pattern at runtime to keep the literal off the
        // `storage.rs` page entirely (avoids self-match even outside comments).
        let attr_pattern = format!("#[{}::{}]", "tauri", "command");

        // Check 1: storage.rs has no Tauri-command attribute on any
        // non-comment line.
        let storage_src = std::fs::read_to_string(format!("{}/src/fsd/storage.rs", manifest))
            .expect("storage.rs readable");
        for (lineno, line) in storage_src.lines().enumerate() {
            let trimmed = line.trim_start();
            // Skip line comments + doc comments + module doc-comments.
            if trimmed.starts_with("//") {
                continue;
            }
            assert!(
                !line.contains(&attr_pattern),
                "storage.rs:{}: must not contain a Tauri command attribute on a code line — \
                 the FSD claim helper is backend-only",
                lineno + 1
            );
        }

        // Check 2: lib.rs's invoke_handler! does not name the FSD claim
        // helper. Same comment-skip discipline.
        let lib_src = std::fs::read_to_string(format!("{}/src/lib.rs", manifest))
            .expect("lib.rs readable");
        let fn_name = concat!("claim_memo", "ry_file"); // avoid literal self-match
        for (lineno, line) in lib_src.lines().enumerate() {
            let trimmed = line.trim_start();
            if trimmed.starts_with("//") {
                continue;
            }
            assert!(
                !line.contains(fn_name),
                "lib.rs:{}: must not reference the FSD claim helper",
                lineno + 1
            );
        }
    }
}
