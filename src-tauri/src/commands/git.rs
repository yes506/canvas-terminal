//! Worktree-isolation policy P1 backend.
//!
//! Tauri commands that provision per-agent git worktrees from `origin/dev`
//! (or a configured non-`main` base) and report worktree status. Used by the
//! collaborator pane to isolate every git-write agent into its own worktree
//! so the orchestrator (P2) can gate merges into protected branches.
//!
//! Design decisions encoded here (see task-42 / task-47 plans):
//! - **D1** always-isolated per-agent worktree at spawn (path includes agent
//!   tool id + sessionId; a future per-task variant lives in P5c).
//! - **D7** missing-`dev` is fail-fast — never silent fallback to `main`.
//!   The frontend handles the user-facing modal; this module just returns an
//!   error if the configured base ref does not resolve.
//! - **D2** "shared source" includes tracked + staged + committed +
//!   untracked-non-ignored. `git_worktree_status` and `git_diff_summary`
//!   surface all four classes so P2's `awaiting-approval` gate fires
//!   correctly when an agent only creates new files.
//! - **codex2 #9** local refs first to avoid network in the spawn critical
//!   path. `git_detect_repo` checks `refs/remotes/origin/dev` locally before
//!   considering `origin` reachability; an explicit `git fetch` is run only
//!   from `git_worktree_create`, with a short timeout.
//!
//! All shelling out goes through `std::process::Command::new("git")` to keep
//! the dependency surface minimal (no libgit2). Every command returns
//! `Result<T, String>` matching the existing `commands::memory` pattern.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::process::Command;

/// Branches the policy treats as protected for the purposes of base-ref
/// validation. The L2 wrapper denylist (P3) uses the same set via the
/// `COLLAB_PROTECTED_BRANCHES` env var.
const PROTECTED_BRANCHES: &[&str] = &["main", "master", "production", "release"];

/// Timeout for the `git fetch` we run during worktree creation. Spawn
/// shouldn't hang on a slow remote — if fetch overruns, fall back to local
/// `origin/dev` and mark `baseFresh: false` so the approval UI can warn.
const FETCH_TIMEOUT_SECS: u64 = 5;

// ---------------------------------------------------------------------------
// Types exposed to the frontend
// ---------------------------------------------------------------------------

/// Snapshot of a git repo at the time of `git_detect_repo`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoInfo {
    /// Absolute path to the repo root (`git rev-parse --show-toplevel`).
    pub root: String,
    /// Currently checked-out branch, or `null` if HEAD is detached.
    pub current_branch: Option<String>,
    /// Whether `refs/remotes/origin/dev` exists locally (no network).
    pub has_origin_dev: bool,
    /// Whether `refs/heads/dev` exists locally.
    pub has_local_dev: bool,
}

/// Returned by `git_worktree_create` and stored on `SpawnedAgent` /
/// `pendingMerge` so approval works after the agent is killed (RESID-5).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeMetadata {
    pub repo_root: String,
    pub path: String,
    pub branch: String,
    pub base_ref: String,
    pub base_sha: String,
    /// `true` if `git fetch` succeeded before resolving baseSHA. `false`
    /// signals offline fallback so the approval UI can show a "stale base"
    /// warning (codex2 #2).
    pub base_fresh: bool,
    /// Unix-millis timestamp when the worktree was created.
    pub created_at_ms: u128,
}

/// Combines `git status --porcelain` with `git ls-files --others
/// --exclude-standard` so callers can treat the worktree as "dirty" if any
/// of the four classes is non-empty (D2 broadened scope).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeStatus {
    pub clean: bool,
    pub modified: Vec<String>,
    pub staged: Vec<String>,
    pub untracked_non_ignored: Vec<String>,
}

/// Diff summary used by P2 to drive the `awaiting-approval` gate.
/// Kept separate from `WorktreeStatus` because the gate requires the
/// committed delta against `baseSHA`, which `git status` doesn't compute.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffSummary {
    pub has_changes: bool,
    pub committed: Vec<String>,
    pub staged: Vec<String>,
    pub unstaged: Vec<String>,
    pub untracked: Vec<String>,
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Root for all canvas-terminal-managed worktrees:
/// `~/.cache/canvas-terminal/worktrees/`. Hardcoded by design — claude2 N2
/// notes that future custom-root support requires regenerating the wrapper.
/// A regression test (P9) locks this prefix.
pub(crate) fn worktrees_root() -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or("Cannot determine home directory")?;
    let dir = home
        .join(".cache")
        .join("canvas-terminal")
        .join("worktrees");
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("Failed to create worktrees root: {}", e))?;
    Ok(dir)
}

/// Run a git subcommand and return stdout as a trimmed string.
/// On non-zero exit, returns `Err("git <cmd> failed: <stderr>")`.
///
/// For commands whose output's leading whitespace is significant (e.g.
/// `git status --porcelain` where `' M file'` distinguishes index-clean +
/// worktree-modified from `'M  file'` index-modified + worktree-clean), use
/// `git_capture_raw` instead. Trimming porcelain output silently corrupts
/// the X/Y status columns.
fn git_capture(repo: Option<&Path>, args: &[&str]) -> Result<String, String> {
    git_capture_raw(repo, args).map(|s| s.trim().to_string())
}

/// Like `git_capture` but does NOT trim. Use for porcelain/diff outputs
/// where leading/trailing whitespace and NULs carry meaning.
fn git_capture_raw(repo: Option<&Path>, args: &[&str]) -> Result<String, String> {
    let mut cmd = Command::new("git");
    if let Some(path) = repo {
        cmd.args(["-C", path.to_str().ok_or("non-utf8 repo path")?]);
    }
    cmd.args(args);
    let output = cmd
        .output()
        .map_err(|e| format!("failed to spawn git: {}", e))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let argv = args.join(" ");
        return Err(format!("git {} failed: {}", argv, stderr));
    }
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

/// Like `git_capture` but returns `Ok(None)` on non-zero exit instead of
/// `Err`. Useful for "does this ref exist?" probes.
fn git_capture_opt(repo: Option<&Path>, args: &[&str]) -> Option<String> {
    git_capture(repo, args).ok().filter(|s| !s.is_empty())
}

/// Run a git subcommand with a wall-clock timeout. Returns `Err("timeout")`
/// if the timeout elapses; the child is killed.
///
/// Stdio is silenced — this helper is used for `git fetch` whose failure is
/// intentionally a soft fallback (offline / no-remote case). Surfacing
/// stderr would be noise.
fn git_with_timeout(
    repo: Option<&Path>,
    args: &[&str],
    timeout_secs: u64,
) -> Result<(), String> {
    let mut cmd = Command::new("git");
    if let Some(path) = repo {
        cmd.args(["-C", path.to_str().ok_or("non-utf8 repo path")?]);
    }
    cmd.args(args);
    cmd.stdout(std::process::Stdio::null());
    cmd.stderr(std::process::Stdio::null());
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("failed to spawn git: {}", e))?;
    let start = std::time::Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) if status.success() => return Ok(()),
            Ok(Some(status)) => {
                return Err(format!("git {} exited {}", args.join(" "), status));
            }
            Ok(None) => {
                if start.elapsed().as_secs() >= timeout_secs {
                    let _ = child.kill();
                    return Err("timeout".to_string());
                }
                std::thread::sleep(std::time::Duration::from_millis(50));
            }
            Err(e) => return Err(format!("git wait error: {}", e)),
        }
    }
}

fn now_unix_ms() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

/// Refuse base refs that point at protected branches. Catches the user
/// trying to override D7 with `origin/main` directly.
fn validate_base_ref(base_ref: &str) -> Result<(), String> {
    let tail = base_ref.rsplit('/').next().unwrap_or(base_ref);
    if PROTECTED_BRANCHES.contains(&tail) {
        return Err(format!(
            "base ref '{}' resolves to a protected branch ({}). Pick a non-main base.",
            base_ref, tail
        ));
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

/// Detect whether the given cwd is inside a git repo. Local refs only —
/// does NOT contact the network (codex2 #9 keeps spawn fast). Returns
/// `Ok(None)` if cwd is not a git repo at all.
#[tauri::command]
pub fn git_detect_repo(cwd: String) -> Result<Option<RepoInfo>, String> {
    let cwd_path = PathBuf::from(&cwd);
    if !cwd_path.exists() {
        return Ok(None);
    }
    let root = match git_capture_opt(Some(&cwd_path), &["rev-parse", "--show-toplevel"]) {
        Some(s) => s,
        None => return Ok(None),
    };
    let root_path = PathBuf::from(&root);
    let current_branch = git_capture_opt(Some(&root_path), &["symbolic-ref", "--short", "HEAD"]);
    let has_origin_dev =
        git_capture_opt(Some(&root_path), &["show-ref", "--verify", "refs/remotes/origin/dev"])
            .is_some();
    let has_local_dev =
        git_capture_opt(Some(&root_path), &["show-ref", "--verify", "refs/heads/dev"])
            .is_some();
    Ok(Some(RepoInfo {
        root,
        current_branch,
        has_origin_dev,
        has_local_dev,
    }))
}

/// Provision a per-agent worktree from `base_ref` (default `origin/dev`).
///
/// Sequence:
/// 1. Validate base ref is not a protected branch (rejects user-override
///    attempts to base from `main`).
/// 2. Try `git fetch origin <base>` with a 5s timeout. On success,
///    `base_fresh = true`. On failure, fall back to local ref and mark
///    `base_fresh = false` so the approval UI can warn.
/// 3. Resolve `baseSHA` from the (possibly stale) ref.
/// 4. `git worktree add <path> -b <branch> <baseSHA>`.
///
/// Fails fast if the base ref does not exist locally and fetch failed —
/// per D7, we never silently fall back to `main`.
#[tauri::command]
pub fn git_worktree_create(
    repo_root: String,
    worktree_path: String,
    branch_name: String,
    base_ref: String,
) -> Result<WorktreeMetadata, String> {
    validate_base_ref(&base_ref)?;

    let repo_path = PathBuf::from(&repo_root);
    if !repo_path.exists() {
        return Err(format!("repo root does not exist: {}", repo_root));
    }

    // Strip the `origin/` prefix for `git fetch <remote> <ref>` — `git fetch
    // origin origin/dev` is a parse error. Accept either form from the caller.
    let (remote, fetch_ref) = match base_ref.split_once('/') {
        Some((r, b)) if r == "origin" => ("origin", b),
        _ => ("origin", base_ref.as_str()),
    };

    // Try to refresh the remote ref. Bounded so spawn doesn't hang.
    let base_fresh = git_with_timeout(
        Some(&repo_path),
        &["fetch", remote, fetch_ref],
        FETCH_TIMEOUT_SECS,
    )
    .is_ok();

    // Resolve baseSHA from the EXACT ref the caller asked for. No
    // silent fallback to a different ref — codex1 C3: "Do not use local
    // `dev` as the base unless user explicitly configured that." If the
    // caller passed `origin/dev` and it doesn't exist (no origin / fetch
    // failed), we fail fast so the missing-`dev` modal can surface.
    let base_sha = git_capture_opt(Some(&repo_path), &["rev-parse", &base_ref])
        .ok_or_else(|| {
            format!(
                "base ref '{}' does not exist locally{}. \
                 Configure a different non-main base via the missing-dev modal.",
                base_ref,
                if base_fresh { "" } else { " and fetch did not produce it" }
            )
        })?;

    // Ensure parent dir exists (worktree path is `<root>/<collabId>/<...>`,
    // not directly at root).
    let wt_path = PathBuf::from(&worktree_path);
    if let Some(parent) = wt_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("failed to create worktree parent dir: {}", e))?;
    }

    // git worktree add. Use the resolved SHA, not the symbolic ref, so the
    // worktree's branch is anchored to a specific commit even if the
    // symbolic ref moves later.
    git_capture(
        Some(&repo_path),
        &["worktree", "add", &worktree_path, "-b", &branch_name, &base_sha],
    )?;

    Ok(WorktreeMetadata {
        repo_root,
        path: worktree_path,
        branch: branch_name,
        base_ref,
        base_sha,
        base_fresh,
        created_at_ms: now_unix_ms(),
    })
}

/// Remove a worktree and (if no unmerged commits) delete its branch.
///
/// Takes parent metadata explicitly per codex1 C5 — don't infer the parent
/// repo from a possibly-deleted-or-corrupt worktree.
///
/// **NEVER auto-removes a dirty worktree.** Per D10 + LB6, callers must
/// only invoke this after (a) successful approved merge, (b) explicit user
/// discard, OR (c) explicit confirmation that the worktree is clean.
#[tauri::command]
pub fn git_worktree_remove(
    repo_root: String,
    worktree_path: String,
    branch_name: String,
) -> Result<(), String> {
    let repo_path = PathBuf::from(&repo_root);
    // `--force` because the worktree may have stale lock/index state from a
    // killed agent PTY. The caller is responsible for ensuring no live
    // process is using the worktree (D15 kills PTY first).
    git_capture(
        Some(&repo_path),
        &["worktree", "remove", "--force", &worktree_path],
    )?;
    // Best-effort branch delete. `-d` (lowercase) refuses to delete unmerged
    // branches; use that so we preserve work if the caller invoked us
    // erroneously. The caller can pass `--force` separately via
    // `git_branch_force_delete` (P2 implements that for the Discard path).
    let _ = git_capture(Some(&repo_path), &["branch", "-d", &branch_name]);
    Ok(())
}

/// Force-delete a branch (used by the Discard flow, which has user
/// confirmation and intentionally destroys unmerged work).
#[tauri::command]
pub fn git_branch_force_delete(
    repo_root: String,
    branch_name: String,
) -> Result<(), String> {
    if PROTECTED_BRANCHES.contains(&branch_name.as_str()) {
        return Err(format!(
            "refusing to force-delete protected branch '{}'",
            branch_name
        ));
    }
    let repo_path = PathBuf::from(&repo_root);
    git_capture(Some(&repo_path), &["branch", "-D", &branch_name])?;
    Ok(())
}

/// List all worktrees for a repo (used by the startup janitor — D10).
#[tauri::command]
pub fn git_worktree_list(repo_root: String) -> Result<Vec<String>, String> {
    let repo_path = PathBuf::from(&repo_root);
    let porcelain = git_capture(Some(&repo_path), &["worktree", "list", "--porcelain"])?;
    let mut paths = Vec::new();
    for line in porcelain.lines() {
        if let Some(rest) = line.strip_prefix("worktree ") {
            paths.push(rest.to_string());
        }
    }
    Ok(paths)
}

/// Report worktree dirtiness for D10 (dirty-aware cleanup) and the
/// approval gate (D2 broadened scope).
///
/// `clean = true` iff: no modified, no staged, no untracked-non-ignored.
#[tauri::command]
pub fn git_worktree_status(worktree_path: String) -> Result<WorktreeStatus, String> {
    let wt = PathBuf::from(&worktree_path);
    // Use raw (non-trimming) capture: leading SPACE in `' M file'` is
    // significant — it's the X (index) status column.
    let porcelain = git_capture_raw(Some(&wt), &["status", "--porcelain=v1", "-z"])?;
    let mut modified = Vec::new();
    let mut staged = Vec::new();

    // `--porcelain -z` separates entries with NUL. Each entry: XY <space>
    // path<NUL> (rename adds a second NUL-separated path; we record only the
    // current path).
    let mut iter = porcelain.split('\0').filter(|s| !s.is_empty());
    while let Some(entry) = iter.next() {
        if entry.len() < 3 {
            continue;
        }
        let bytes = entry.as_bytes();
        let x = bytes[0] as char;
        let y = bytes[1] as char;
        let path = entry[3..].to_string();
        // For rename/copy, skip the source path (next entry).
        if x == 'R' || x == 'C' {
            let _ = iter.next();
        }
        // Index column = staged (anything other than space or '?')
        if x != ' ' && x != '?' {
            staged.push(path.clone());
        }
        // Worktree column = unstaged modifications
        if y != ' ' && y != '?' {
            modified.push(path);
        }
    }

    let untracked_raw = git_capture_raw(
        Some(&wt),
        &["ls-files", "--others", "--exclude-standard", "-z"],
    )?;
    let untracked_non_ignored: Vec<String> = untracked_raw
        .split('\0')
        .filter(|s| !s.is_empty())
        .map(String::from)
        .collect();

    let clean = modified.is_empty() && staged.is_empty() && untracked_non_ignored.is_empty();
    Ok(WorktreeStatus {
        clean,
        modified,
        staged,
        untracked_non_ignored,
    })
}

/// Compute the diff summary used by P2 to drive the `awaiting-approval`
/// gate. Combines committed delta (`baseSHA...HEAD`), staged + unstaged
/// (`git status`), and untracked-non-ignored (`ls-files --others`).
///
/// Per D2, the gate fires if **any** of the four classes is non-empty.
#[tauri::command]
pub fn git_diff_summary(
    worktree_path: String,
    base_sha: String,
) -> Result<DiffSummary, String> {
    let wt = PathBuf::from(&worktree_path);

    // All `-z` outputs use NUL separators where leading whitespace can be
    // significant — use raw (non-trimming) capture throughout.
    let committed_raw = git_capture_raw(
        Some(&wt),
        &["diff", "--name-only", "-z", &format!("{}..HEAD", base_sha)],
    )?;
    let committed: Vec<String> = committed_raw
        .split('\0')
        .filter(|s| !s.is_empty())
        .map(String::from)
        .collect();

    let staged_raw = git_capture_raw(
        Some(&wt),
        &["diff", "--name-only", "-z", "--cached"],
    )?;
    let staged: Vec<String> = staged_raw
        .split('\0')
        .filter(|s| !s.is_empty())
        .map(String::from)
        .collect();

    let unstaged_raw = git_capture_raw(Some(&wt), &["diff", "--name-only", "-z"])?;
    let unstaged: Vec<String> = unstaged_raw
        .split('\0')
        .filter(|s| !s.is_empty())
        .map(String::from)
        .collect();

    let untracked_raw = git_capture_raw(
        Some(&wt),
        &["ls-files", "--others", "--exclude-standard", "-z"],
    )?;
    let untracked: Vec<String> = untracked_raw
        .split('\0')
        .filter(|s| !s.is_empty())
        .map(String::from)
        .collect();

    let has_changes = !committed.is_empty()
        || !staged.is_empty()
        || !unstaged.is_empty()
        || !untracked.is_empty();
    Ok(DiffSummary {
        has_changes,
        committed,
        staged,
        unstaged,
        untracked,
    })
}

/// Compute the absolute path the orchestrator will provision a worktree at.
/// Frontend calls this so the same path-construction logic lives in one
/// place (Rust). Format: `<worktrees_root>/<collab_id>/<tool_id>-<session_id>`.
#[tauri::command]
pub fn compute_worktree_path(
    collab_id: String,
    session_id: String,
    tool_id: String,
) -> Result<String, String> {
    if collab_id.is_empty() || session_id.is_empty() || tool_id.is_empty() {
        return Err("collab_id, session_id, and tool_id must all be non-empty".to_string());
    }
    // Validate against path traversal — these come from the frontend but
    // are derived from store state. Defensive.
    for part in [&collab_id, &session_id, &tool_id] {
        if part.contains('/') || part.contains('\\') || part.contains("..") {
            return Err(format!("invalid path component: {}", part));
        }
    }
    let root = worktrees_root()?;
    let path = root.join(&collab_id).join(format!("{}-{}", tool_id, session_id));
    Ok(path.to_string_lossy().to_string())
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    static TEST_COUNTER: AtomicU64 = AtomicU64::new(0);

    /// Create a fresh temp dir + initialize a git repo with one commit on
    /// `main` and a `dev` branch. Returns the repo root.
    fn make_test_repo() -> PathBuf {
        let n = TEST_COUNTER.fetch_add(1, Ordering::SeqCst);
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let repo = std::env::temp_dir().join(format!("ct-git-test-{}-{}", now, n));
        std::fs::create_dir_all(&repo).unwrap();
        // init with explicit user identity so commits succeed in CI envs
        // where global git config is missing (RESID-4 test surface).
        git_capture(Some(&repo), &["init", "-b", "main"]).unwrap();
        git_capture(Some(&repo), &["config", "user.name", "test"]).unwrap();
        git_capture(Some(&repo), &["config", "user.email", "test@example.com"]).unwrap();
        std::fs::write(repo.join("README.md"), "test\n").unwrap();
        git_capture(Some(&repo), &["add", "README.md"]).unwrap();
        git_capture(Some(&repo), &["commit", "-m", "init"]).unwrap();
        // Create a `dev` branch at the same SHA so `git_worktree_create`
        // can use it as the base.
        git_capture(Some(&repo), &["branch", "dev"]).unwrap();
        repo
    }

    #[test]
    fn detect_repo_returns_none_for_non_repo() {
        let dir = std::env::temp_dir().join(format!(
            "ct-non-repo-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let info = git_detect_repo(dir.to_string_lossy().to_string()).unwrap();
        assert!(info.is_none());
    }

    #[test]
    fn detect_repo_finds_local_dev() {
        let repo = make_test_repo();
        let info = git_detect_repo(repo.to_string_lossy().to_string())
            .unwrap()
            .expect("should detect repo");
        assert!(info.has_local_dev, "local dev branch should be detected");
        assert_eq!(info.has_origin_dev, false, "no origin in test repo");
        assert_eq!(info.current_branch.as_deref(), Some("main"));
    }

    #[test]
    fn validate_base_ref_rejects_main_family() {
        for proto in ["main", "master", "production", "release"] {
            assert!(validate_base_ref(proto).is_err(), "{} should be rejected", proto);
            assert!(
                validate_base_ref(&format!("origin/{}", proto)).is_err(),
                "origin/{} should be rejected",
                proto
            );
        }
        // Non-protected names pass.
        assert!(validate_base_ref("dev").is_ok());
        assert!(validate_base_ref("origin/dev").is_ok());
        assert!(validate_base_ref("origin/staging").is_ok());
    }

    #[test]
    fn worktree_create_fails_fast_on_missing_base() {
        let repo = make_test_repo();
        // No `origin` remote, no fetch possible. Asking for `origin/dev`
        // must fail because the local ref doesn't exist either.
        let result = git_worktree_create(
            repo.to_string_lossy().to_string(),
            std::env::temp_dir()
                .join("ct-wt-fail")
                .to_string_lossy()
                .to_string(),
            "agent/test-1".to_string(),
            "origin/dev".to_string(),
        );
        assert!(result.is_err(), "should fail when base ref is missing");
    }

    #[test]
    fn worktree_create_succeeds_from_local_dev() {
        let repo = make_test_repo();
        let n = TEST_COUNTER.fetch_add(1, Ordering::SeqCst);
        let wt = std::env::temp_dir().join(format!("ct-wt-ok-{}", n));
        let meta = git_worktree_create(
            repo.to_string_lossy().to_string(),
            wt.to_string_lossy().to_string(),
            format!("agent/test-{}", n),
            "dev".to_string(), // local dev exists
        )
        .expect("should create worktree from local dev");
        assert!(wt.exists(), "worktree path should exist on disk");
        assert!(wt.join(".git").exists(), "should have .git pointer");
        assert!(!meta.base_sha.is_empty());
        assert_eq!(meta.base_ref, "dev");
        // Cleanup
        let _ = git_worktree_remove(
            repo.to_string_lossy().to_string(),
            wt.to_string_lossy().to_string(),
            meta.branch.clone(),
        );
    }

    #[test]
    fn worktree_status_detects_dirty_states() {
        let repo = make_test_repo();
        let n = TEST_COUNTER.fetch_add(1, Ordering::SeqCst);
        let wt = std::env::temp_dir().join(format!("ct-wt-status-{}", n));
        let meta = git_worktree_create(
            repo.to_string_lossy().to_string(),
            wt.to_string_lossy().to_string(),
            format!("agent/test-status-{}", n),
            "dev".to_string(),
        )
        .unwrap();

        // Initially clean
        let s = git_worktree_status(wt.to_string_lossy().to_string()).unwrap();
        assert!(s.clean, "fresh worktree should be clean");

        // Add an untracked file → not clean
        std::fs::write(wt.join("new.txt"), "hello\n").unwrap();
        let s = git_worktree_status(wt.to_string_lossy().to_string()).unwrap();
        assert!(!s.clean, "untracked file should make worktree dirty (D2)");
        assert_eq!(s.untracked_non_ignored, vec!["new.txt".to_string()]);
        assert!(s.modified.is_empty());
        assert!(s.staged.is_empty());

        // Modify an existing tracked file
        std::fs::write(wt.join("README.md"), "modified\n").unwrap();
        let s = git_worktree_status(wt.to_string_lossy().to_string()).unwrap();
        assert!(!s.clean);
        assert!(s.modified.contains(&"README.md".to_string()));

        // Cleanup
        let _ = git_worktree_remove(
            repo.to_string_lossy().to_string(),
            wt.to_string_lossy().to_string(),
            meta.branch,
        );
    }

    #[test]
    fn diff_summary_includes_untracked() {
        let repo = make_test_repo();
        let n = TEST_COUNTER.fetch_add(1, Ordering::SeqCst);
        let wt = std::env::temp_dir().join(format!("ct-wt-diff-{}", n));
        let meta = git_worktree_create(
            repo.to_string_lossy().to_string(),
            wt.to_string_lossy().to_string(),
            format!("agent/test-diff-{}", n),
            "dev".to_string(),
        )
        .unwrap();

        // No changes yet
        let d = git_diff_summary(wt.to_string_lossy().to_string(), meta.base_sha.clone()).unwrap();
        assert!(!d.has_changes, "fresh worktree has no diff");

        // Untracked-only — D2 says this MUST flip has_changes=true.
        std::fs::write(wt.join("new-source.ts"), "export {};\n").unwrap();
        let d = git_diff_summary(wt.to_string_lossy().to_string(), meta.base_sha.clone()).unwrap();
        assert!(
            d.has_changes,
            "untracked-non-ignored file must register as a change (D2 regression)"
        );
        assert_eq!(d.untracked, vec!["new-source.ts".to_string()]);
        assert!(d.committed.is_empty());

        // Cleanup
        let _ = git_worktree_remove(
            repo.to_string_lossy().to_string(),
            wt.to_string_lossy().to_string(),
            meta.branch,
        );
    }

    #[test]
    fn compute_worktree_path_rejects_traversal() {
        assert!(compute_worktree_path("..".into(), "s".into(), "claude_code".into()).is_err());
        assert!(compute_worktree_path("a/b".into(), "s".into(), "claude_code".into()).is_err());
        assert!(compute_worktree_path("ok".into(), "s".into(), "x..y".into()).is_err());
        // Happy path
        let p = compute_worktree_path(
            "session-9-abc".into(),
            "session-1-xyz".into(),
            "claude_code".into(),
        )
        .unwrap();
        assert!(p.contains("session-9-abc"));
        assert!(p.contains("claude_code-session-1-xyz"));
    }

    #[test]
    fn worktree_list_returns_paths() {
        let repo = make_test_repo();
        let n = TEST_COUNTER.fetch_add(1, Ordering::SeqCst);
        let wt = std::env::temp_dir().join(format!("ct-wt-list-{}", n));
        let meta = git_worktree_create(
            repo.to_string_lossy().to_string(),
            wt.to_string_lossy().to_string(),
            format!("agent/test-list-{}", n),
            "dev".to_string(),
        )
        .unwrap();
        let list = git_worktree_list(repo.to_string_lossy().to_string()).unwrap();
        // git canonicalizes paths (macOS /var → /private/var). Compare
        // canonicalized forms so the symlink resolution doesn't trip the test.
        let canonical_wt = std::fs::canonicalize(&wt).unwrap();
        assert!(
            list.iter().any(|p| std::fs::canonicalize(p).ok() == Some(canonical_wt.clone())),
            "expected {:?} in {:?}",
            canonical_wt,
            list
        );
        // Cleanup
        let _ = git_worktree_remove(
            repo.to_string_lossy().to_string(),
            wt.to_string_lossy().to_string(),
            meta.branch,
        );
    }
}
