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

/// Outcome of `git_worktree_remove`. Distinguishes a fully-clean removal
/// from a partial cleanup so the caller (P2) can surface a "cleanup-needed"
/// state instead of treating partial success as success (codex2 #4).
///
/// Note: this stays as a small typed enum even in P1 because cleanup
/// semantics are user-visible — an orphaned branch from a partially-failed
/// Discard is exactly the kind of state-loss claude2 Gap-4 / LB6 flagged.
/// The full `GitError` enum (LB6) lands with the merge/approval commands
/// in P2.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum WorktreeRemoveOutcome {
    /// Both worktree and branch were deleted.
    FullyRemoved,
    /// Worktree was removed but the branch could not be deleted (most
    /// commonly because the branch has unmerged commits and was passed to
    /// `git_worktree_remove` which uses `branch -d`, not `-D`). Callers
    /// that want destructive deletion should use `git_branch_force_delete`
    /// after `git_worktree_remove`.
    WorktreeRemovedBranchPreserved { branch: String, reason: String },
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
    std::fs::create_dir_all(&dir).map_err(|e| format!("Failed to create worktrees root: {}", e))?;
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
fn git_with_timeout(repo: Option<&Path>, args: &[&str], timeout_secs: u64) -> Result<(), String> {
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

/// Reject `base_ref` strings that target a non-`origin` remote. v1 only
/// supports `origin` as the upstream — passing `upstream/dev` or
/// `fork/dev` would silently produce wrong fetch behavior (claude2 Gap-1).
fn validate_remote_in_base_ref(base_ref: &str) -> Result<(), String> {
    if let Some((remote, _)) = base_ref.split_once('/') {
        // Anything that looks like `<remote>/<branch>` must use `origin`.
        // Bare branch names (no `/`) and `refs/heads/...` paths are fine.
        if remote != "origin" && remote != "refs" {
            return Err(format!(
                "base ref '{}' targets remote '{}'. v1 only supports `origin/<branch>` or a bare branch name.",
                base_ref, remote
            ));
        }
    }
    Ok(())
}

/// Confirm that `worktree_path` is under the canvas-terminal-managed
/// worktree root. This is the host-side enforcement that the plan's
/// L1 guarantee depends on (codex2 High-#1) — without it, a frontend bug
/// could ask the backend to provision/clean up arbitrary paths.
///
/// Uses canonicalized paths to handle `/var → /private/var`-style symlinks
/// on macOS. The worktree path may not exist yet at provisioning time, so
/// we canonicalize the parent and append the leaf name when the path
/// itself is not yet on disk.
fn validate_managed_worktree_path(worktree_path: &str) -> Result<PathBuf, String> {
    let root = worktrees_root()?;
    let canonical_root = std::fs::canonicalize(&root)
        .map_err(|e| format!("failed to canonicalize worktree root: {}", e))?;

    let candidate = PathBuf::from(worktree_path);
    let canonical_candidate = if candidate.exists() {
        std::fs::canonicalize(&candidate)
            .map_err(|e| format!("failed to canonicalize worktree path: {}", e))?
    } else {
        // Path doesn't exist yet (provisioning case). Canonicalize the
        // existing parent and graft the leaf back on.
        let parent = candidate
            .parent()
            .ok_or_else(|| format!("worktree path has no parent: {}", worktree_path))?;
        let leaf = candidate
            .file_name()
            .ok_or_else(|| format!("worktree path has no leaf: {}", worktree_path))?;
        // Walk up until we find an existing ancestor.
        let mut cursor = parent.to_path_buf();
        while !cursor.exists() {
            cursor = cursor
                .parent()
                .ok_or_else(|| {
                    format!("no existing ancestor for worktree path: {}", worktree_path)
                })?
                .to_path_buf();
        }
        let canonical_ancestor = std::fs::canonicalize(&cursor)
            .map_err(|e| format!("failed to canonicalize ancestor: {}", e))?;
        // Reconstruct: canonical_ancestor + remaining-non-existing-segments + leaf.
        let mut rebuilt = canonical_ancestor;
        let suffix = candidate
            .strip_prefix(&cursor)
            .map_err(|e| format!("strip_prefix failed: {}", e))?;
        rebuilt.push(suffix);
        // Collapse: leaf was included in `suffix` already. Done.
        let _ = leaf;
        rebuilt
    };

    if !canonical_candidate.starts_with(&canonical_root) {
        return Err(format!(
            "worktree path '{}' is outside the managed worktree root ({}). \
             Use `compute_worktree_path` to construct managed paths.",
            worktree_path,
            canonical_root.display()
        ));
    }
    Ok(canonical_candidate)
}

/// Confirm that `branch_name` matches the canvas-terminal-managed agent
/// branch namespace (`agent/...`). Prevents a future frontend bug from
/// passing an arbitrary branch name to destructive operations
/// (codex2 High-#2).
fn validate_managed_branch_name(branch_name: &str) -> Result<(), String> {
    if !branch_name.starts_with("agent/") {
        return Err(format!(
            "branch '{}' is not under the managed agent/ namespace. \
             Destructive operations only accept branches the orchestrator created.",
            branch_name
        ));
    }
    // Defensive: still refuse any protected name even within the namespace
    // (shouldn't be possible to reach here, but cheap insurance).
    let tail = branch_name.rsplit('/').next().unwrap_or(branch_name);
    if PROTECTED_BRANCHES.contains(&tail) {
        return Err(format!(
            "branch '{}' has a protected tail name. Refusing.",
            branch_name
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
    let has_origin_dev = git_capture_opt(
        Some(&root_path),
        &["show-ref", "--verify", "refs/remotes/origin/dev"],
    )
    .is_some();
    let has_local_dev = git_capture_opt(
        Some(&root_path),
        &["show-ref", "--verify", "refs/heads/dev"],
    )
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
    validate_remote_in_base_ref(&base_ref)?;
    validate_managed_branch_name(&branch_name)?;
    // Host-enforced managed-root invariant (codex2 High-#1). The frontend's
    // call to `compute_worktree_path` is *advisory*; this check is the
    // backend gate.
    let _canonical_managed = validate_managed_worktree_path(&worktree_path)?;

    let repo_path = PathBuf::from(&repo_root);
    if !repo_path.exists() {
        return Err(format!("repo root does not exist: {}", repo_root));
    }

    // Strip the `origin/` prefix for `git fetch <remote> <ref>` — `git fetch
    // origin origin/dev` is a parse error. validate_remote_in_base_ref above
    // already rejected non-origin remotes.
    let fetch_ref: &str = match base_ref.split_once('/') {
        Some((r, b)) if r == "origin" => b,
        _ => base_ref.as_str(),
    };

    // Try to refresh the remote ref. Bounded so spawn doesn't hang.
    let base_fresh = git_with_timeout(
        Some(&repo_path),
        &["fetch", "origin", fetch_ref],
        FETCH_TIMEOUT_SECS,
    )
    .is_ok();

    // Resolve baseSHA from the EXACT ref the caller asked for. No
    // silent fallback to a different ref — codex1 C3: "Do not use local
    // `dev` as the base unless user explicitly configured that." If the
    // caller passed `origin/dev` and it doesn't exist (no origin / fetch
    // failed), we fail fast so the missing-`dev` modal can surface.
    //
    // Three-state error message (claude2 Gap-2): distinguish offline-fetch,
    // remote-lacks-ref, and bare-name-not-found so the user understands
    // what to fix.
    let base_sha =
        git_capture_opt(Some(&repo_path), &["rev-parse", &base_ref]).ok_or_else(|| {
            let context = if !base_fresh {
                "Fetch from origin failed (offline or no origin remote configured). \
                 Local copy of this ref does not exist either."
            } else if base_ref.starts_with("origin/") {
                "Fetch from origin succeeded but the remote does not have this ref. \
                 The remote may have deleted it, or it never existed."
            } else {
                "Local ref does not exist (and remote was not consulted because the \
                 base ref is a bare branch name, not `origin/<branch>`)."
            };
            format!(
                "base ref '{}' could not be resolved. {} \
                 Configure a different non-main base via the missing-dev modal.",
                base_ref, context
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
        &[
            "worktree",
            "add",
            &worktree_path,
            "-b",
            &branch_name,
            &base_sha,
        ],
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
/// Validates managed-root + branch-namespace invariants (codex2 High-#1/#2).
///
/// Returns `WorktreeRemoveOutcome::WorktreeRemovedBranchPreserved` when the
/// worktree was removed but the branch couldn't be deleted (most commonly
/// because it has unmerged commits). Caller can then surface a
/// "cleanup-needed" UI state instead of treating partial cleanup as
/// success (codex2 #4).
///
/// **NEVER auto-removes a dirty worktree.** Per D10 + LB6, callers must
/// only invoke this after (a) successful approved merge, (b) explicit user
/// discard, OR (c) explicit confirmation that the worktree is clean.
#[tauri::command]
pub fn git_worktree_remove(
    repo_root: String,
    worktree_path: String,
    branch_name: String,
) -> Result<WorktreeRemoveOutcome, String> {
    validate_managed_worktree_path(&worktree_path)?;
    validate_managed_branch_name(&branch_name)?;

    let repo_path = PathBuf::from(&repo_root);
    // `--force` because the worktree may have stale lock/index state from a
    // killed agent PTY. The caller is responsible for ensuring no live
    // process is using the worktree (D15 kills PTY first).
    git_capture(
        Some(&repo_path),
        &["worktree", "remove", "--force", &worktree_path],
    )?;
    // Best-effort branch delete. `-d` (lowercase) refuses to delete unmerged
    // branches; we preserve work if the caller invoked us erroneously. The
    // caller can pass `--force` separately via `git_branch_force_delete`
    // (the Discard path).
    match git_capture(Some(&repo_path), &["branch", "-d", &branch_name]) {
        Ok(_) => Ok(WorktreeRemoveOutcome::FullyRemoved),
        Err(reason) => Ok(WorktreeRemoveOutcome::WorktreeRemovedBranchPreserved {
            branch: branch_name,
            reason,
        }),
    }
}

/// Force-delete a branch (used by the Discard flow, which has user
/// confirmation and intentionally destroys unmerged work).
///
/// Validates managed namespace (`agent/...`) and protected-name refusal
/// (codex2 High-#2): a future frontend bug or misrouted call cannot
/// destroy an arbitrary or protected branch through this entry point.
#[tauri::command]
pub fn git_branch_force_delete(repo_root: String, branch_name: String) -> Result<(), String> {
    // validate_managed_branch_name covers BOTH the agent/ prefix invariant
    // AND the defensive protected-tail-name refusal.
    validate_managed_branch_name(&branch_name)?;
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
pub fn git_diff_summary(worktree_path: String, base_sha: String) -> Result<DiffSummary, String> {
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

    let staged_raw = git_capture_raw(Some(&wt), &["diff", "--name-only", "-z", "--cached"])?;
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
    let path = root
        .join(&collab_id)
        .join(format!("{}-{}", tool_id, session_id));
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

    /// Allocate a managed-root worktree path (passes the host-side
    /// `validate_managed_worktree_path` check). Tests use this so they
    /// exercise the same path policy as production callers.
    fn make_managed_worktree_path(label: &str) -> String {
        let n = TEST_COUNTER.fetch_add(1, Ordering::SeqCst);
        let collab = format!("test-{}-{}", label, n);
        compute_worktree_path(collab, format!("session-{}", n), "claude_code".to_string())
            .expect("compute_worktree_path should succeed for valid components")
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
            assert!(
                validate_base_ref(proto).is_err(),
                "{} should be rejected",
                proto
            );
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
            make_managed_worktree_path("fail"),
            "agent/test-fail".to_string(),
            "origin/dev".to_string(),
        );
        assert!(result.is_err(), "should fail when base ref is missing");
    }

    #[test]
    fn worktree_create_succeeds_from_local_dev() {
        let repo = make_test_repo();
        let wt_str = make_managed_worktree_path("ok");
        let meta = git_worktree_create(
            repo.to_string_lossy().to_string(),
            wt_str.clone(),
            "agent/test-ok".to_string(),
            "dev".to_string(), // local dev exists
        )
        .expect("should create worktree from local dev");
        let wt = PathBuf::from(&wt_str);
        assert!(wt.exists(), "worktree path should exist on disk");
        assert!(wt.join(".git").exists(), "should have .git pointer");
        assert!(!meta.base_sha.is_empty());
        assert_eq!(meta.base_ref, "dev");
        // Cleanup
        let _ = git_worktree_remove(
            repo.to_string_lossy().to_string(),
            wt_str,
            meta.branch.clone(),
        );
    }

    #[test]
    fn worktree_status_detects_dirty_states() {
        let repo = make_test_repo();
        let wt_str = make_managed_worktree_path("status");
        let meta = git_worktree_create(
            repo.to_string_lossy().to_string(),
            wt_str.clone(),
            "agent/test-status".to_string(),
            "dev".to_string(),
        )
        .unwrap();
        let wt = PathBuf::from(&wt_str);

        // Initially clean
        let s = git_worktree_status(wt_str.clone()).unwrap();
        assert!(s.clean, "fresh worktree should be clean");

        // Add an untracked file → not clean
        std::fs::write(wt.join("new.txt"), "hello\n").unwrap();
        let s = git_worktree_status(wt_str.clone()).unwrap();
        assert!(!s.clean, "untracked file should make worktree dirty (D2)");
        assert_eq!(s.untracked_non_ignored, vec!["new.txt".to_string()]);
        assert!(s.modified.is_empty());
        assert!(s.staged.is_empty());

        // Modify an existing tracked file
        std::fs::write(wt.join("README.md"), "modified\n").unwrap();
        let s = git_worktree_status(wt_str.clone()).unwrap();
        assert!(!s.clean);
        assert!(s.modified.contains(&"README.md".to_string()));

        // Stage a change → staged column populated (claude2 Gap-3 coverage)
        git_capture(Some(&wt), &["add", "README.md"]).unwrap();
        let s = git_worktree_status(wt_str.clone()).unwrap();
        assert!(!s.clean);
        assert!(
            s.staged.contains(&"README.md".to_string()),
            "staged column should populate after `git add`"
        );

        // Cleanup
        let _ = git_worktree_remove(repo.to_string_lossy().to_string(), wt_str, meta.branch);
    }

    #[test]
    fn diff_summary_includes_untracked() {
        let repo = make_test_repo();
        let wt_str = make_managed_worktree_path("diff");
        let meta = git_worktree_create(
            repo.to_string_lossy().to_string(),
            wt_str.clone(),
            "agent/test-diff".to_string(),
            "dev".to_string(),
        )
        .unwrap();
        let wt = PathBuf::from(&wt_str);

        // No changes yet
        let d = git_diff_summary(wt_str.clone(), meta.base_sha.clone()).unwrap();
        assert!(!d.has_changes, "fresh worktree has no diff");

        // Untracked-only — D2 says this MUST flip has_changes=true.
        std::fs::write(wt.join("new-source.ts"), "export {};\n").unwrap();
        let d = git_diff_summary(wt_str.clone(), meta.base_sha.clone()).unwrap();
        assert!(
            d.has_changes,
            "untracked-non-ignored file must register as a change (D2 regression)"
        );
        assert_eq!(d.untracked, vec!["new-source.ts".to_string()]);
        assert!(d.committed.is_empty());

        // Cleanup
        let _ = git_worktree_remove(repo.to_string_lossy().to_string(), wt_str, meta.branch);
    }

    // -------------------------------------------------------------------
    // codex2 High-#1/#2 + claude2 Gap-1/Gap-3 + codex2 #4 regression tests
    // -------------------------------------------------------------------

    #[test]
    fn worktree_create_rejects_unmanaged_path() {
        let repo = make_test_repo();
        let outside = std::env::temp_dir().join(format!(
            "ct-outside-{}",
            TEST_COUNTER.fetch_add(1, Ordering::SeqCst)
        ));
        // outside the worktrees root → backend must refuse even if the
        // frontend forgets to call compute_worktree_path (codex2 High-#1).
        let result = git_worktree_create(
            repo.to_string_lossy().to_string(),
            outside.to_string_lossy().to_string(),
            "agent/test-outside".to_string(),
            "dev".to_string(),
        );
        assert!(
            result.is_err(),
            "backend must refuse worktree paths outside ~/.cache/canvas-terminal/worktrees/"
        );
        let msg = result.unwrap_err();
        assert!(
            msg.contains("outside the managed worktree root"),
            "error should explain the managed-root invariant: got {}",
            msg
        );
    }

    #[test]
    fn worktree_create_rejects_unmanaged_branch_namespace() {
        let repo = make_test_repo();
        // Branch not in `agent/...` namespace — backend must refuse
        // (codex2 High-#2). `feature/x` is otherwise legal but isn't
        // orchestrator-minted.
        let result = git_worktree_create(
            repo.to_string_lossy().to_string(),
            make_managed_worktree_path("ns"),
            "feature/x".to_string(),
            "dev".to_string(),
        );
        assert!(result.is_err(), "non-agent/ branch must be refused");
    }

    #[test]
    fn worktree_create_rejects_non_origin_remote() {
        let repo = make_test_repo();
        // claude2 Gap-1: passing `upstream/dev` would otherwise silently
        // produce `git fetch origin upstream/dev` (wrong). Refuse upfront.
        let result = git_worktree_create(
            repo.to_string_lossy().to_string(),
            make_managed_worktree_path("upstream"),
            "agent/test-upstream".to_string(),
            "upstream/dev".to_string(),
        );
        assert!(result.is_err(), "non-origin remote must be refused");
        let msg = result.unwrap_err();
        assert!(
            msg.contains("only supports `origin/<branch>`"),
            "error should call out the v1 limitation: got {}",
            msg
        );
    }

    #[test]
    fn worktree_remove_actually_removes_dir() {
        // claude2 Gap-3 explicit regression — assert the worktree dir is
        // actually gone after removal, don't just trust git's exit code.
        let repo = make_test_repo();
        let wt_str = make_managed_worktree_path("remove");
        let meta = git_worktree_create(
            repo.to_string_lossy().to_string(),
            wt_str.clone(),
            "agent/test-remove".to_string(),
            "dev".to_string(),
        )
        .unwrap();
        let wt = PathBuf::from(&wt_str);
        assert!(wt.exists(), "precondition: worktree exists");
        let outcome =
            git_worktree_remove(repo.to_string_lossy().to_string(), wt_str, meta.branch).unwrap();
        assert!(!wt.exists(), "worktree dir must be gone after remove");
        // `git branch -d agent/test-remove` succeeds because the branch's
        // tip is the same as origin/dev's tip (no unmerged commits).
        assert!(matches!(outcome, WorktreeRemoveOutcome::FullyRemoved));
    }

    #[test]
    fn worktree_remove_preserves_branch_with_unmerged_commits() {
        // codex2 #4: when branch has unmerged work, return structured
        // outcome instead of pretending success.
        let repo = make_test_repo();
        let wt_str = make_managed_worktree_path("unmerged");
        let meta = git_worktree_create(
            repo.to_string_lossy().to_string(),
            wt_str.clone(),
            "agent/test-unmerged".to_string(),
            "dev".to_string(),
        )
        .unwrap();
        let wt = PathBuf::from(&wt_str);
        // Add an unmerged commit on the agent branch.
        std::fs::write(wt.join("new.txt"), "agent work\n").unwrap();
        git_capture(Some(&wt), &["add", "new.txt"]).unwrap();
        git_capture(Some(&wt), &["commit", "-m", "agent work"]).unwrap();

        let outcome = git_worktree_remove(
            repo.to_string_lossy().to_string(),
            wt_str,
            meta.branch.clone(),
        )
        .unwrap();
        match outcome {
            WorktreeRemoveOutcome::WorktreeRemovedBranchPreserved { branch, reason: _ } => {
                assert_eq!(branch, meta.branch);
            }
            WorktreeRemoveOutcome::FullyRemoved => {
                panic!("expected branch to be preserved due to unmerged work");
            }
        }
        // Cleanup the orphaned branch so subsequent tests aren't polluted.
        let _ = git_capture(Some(&repo), &["branch", "-D", &meta.branch]);
    }

    #[test]
    fn branch_force_delete_refuses_unmanaged_namespace() {
        // codex2 High-#2 explicit test — a future frontend bug passing
        // `main` or `feature/x` to force-delete must be refused at the
        // backend.
        let repo = make_test_repo();
        for bad in ["main", "master", "feature/foo", "production"] {
            let result =
                git_branch_force_delete(repo.to_string_lossy().to_string(), bad.to_string());
            assert!(
                result.is_err(),
                "force-delete of '{}' should be refused; got Ok",
                bad
            );
        }
    }

    #[test]
    fn branch_force_delete_works_in_agent_namespace() {
        // Happy path for the Discard flow.
        let repo = make_test_repo();
        let wt_str = make_managed_worktree_path("force");
        let meta = git_worktree_create(
            repo.to_string_lossy().to_string(),
            wt_str.clone(),
            "agent/test-force".to_string(),
            "dev".to_string(),
        )
        .unwrap();
        let wt = PathBuf::from(&wt_str);
        // Make an unmerged commit so `branch -d` would refuse, forcing
        // the test to exercise the `branch -D` path.
        std::fs::write(wt.join("x.txt"), "x\n").unwrap();
        git_capture(Some(&wt), &["add", "x.txt"]).unwrap();
        git_capture(Some(&wt), &["commit", "-m", "x"]).unwrap();
        // Remove the worktree first (it would block branch deletion).
        let _ = git_worktree_remove(
            repo.to_string_lossy().to_string(),
            wt_str,
            meta.branch.clone(),
        );
        // Now force-delete the branch.
        let result =
            git_branch_force_delete(repo.to_string_lossy().to_string(), meta.branch.clone());
        assert!(
            result.is_ok(),
            "force-delete of agent/ branch should succeed: {:?}",
            result
        );
        // Verify it's gone.
        let exists = git_capture_opt(
            Some(&repo),
            &[
                "show-ref",
                "--verify",
                &format!("refs/heads/{}", meta.branch),
            ],
        );
        assert!(exists.is_none(), "branch should be gone after force-delete");
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
        let wt_str = make_managed_worktree_path("list");
        let meta = git_worktree_create(
            repo.to_string_lossy().to_string(),
            wt_str.clone(),
            "agent/test-list".to_string(),
            "dev".to_string(),
        )
        .unwrap();
        let wt = PathBuf::from(&wt_str);
        let list = git_worktree_list(repo.to_string_lossy().to_string()).unwrap();
        // git canonicalizes paths (macOS /var → /private/var). Compare
        // canonicalized forms so the symlink resolution doesn't trip the test.
        let canonical_wt = std::fs::canonicalize(&wt).unwrap();
        assert!(
            list.iter()
                .any(|p| std::fs::canonicalize(p).ok() == Some(canonical_wt.clone())),
            "expected {:?} in {:?}",
            canonical_wt,
            list
        );
        // Cleanup
        let _ = git_worktree_remove(repo.to_string_lossy().to_string(), wt_str, meta.branch);
    }
}
