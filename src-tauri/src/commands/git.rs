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
// P2 backend: orchestrator-owned approval commit + merge.
//
// The L3 load-bearing layer of the v5 worktree-isolation policy. The agent
// never holds merge authority — these commands are invoked by the
// orchestrator (frontend Approve UI) on the user's behalf, after the PTY
// has been killed at the awaiting-approval flip (LB1). The flow per v5 §4:
//
//   1. Frontend Approve click → invoke `git_create_approval_commit` if
//      the diff summary shows uncommitted/untracked work that needs to be
//      captured. Skipped when the agent committed everything itself.
//   2. Frontend then invokes `git_merge_worktree` with `push: false` (D12
//      default — user opts in via separate checkbox).
//   3. On success, frontend cleans up via `git_worktree_remove`. On
//      `MergeConflict`, worktree is preserved for manual resolution / Discard.
//
// LB6 structured errors: `GitError` distinguishes the failure modes the
// Approve UI needs to surface differently. `Result<T, GitError>` is the
// new shape; the existing P1 commands keep returning `Result<T, String>`
// because their callers don't need the variant discrimination.
// ---------------------------------------------------------------------------

/// LB6 structured-error variants for the P2 orchestrator commands.
/// Tagged via `#[serde(tag = "kind")]` so the TS frontend pattern-matches
/// on `error.kind === "mergeConflict"` etc.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum GitError {
    /// `git_create_approval_commit` ran `git add -A` + `git commit` but
    /// produced no commit (working tree was already clean). Caller should
    /// treat this as "no source delta" and not flag it as a real error.
    EmptyCommit { message: String },
    /// A pre-commit / pre-push / pre-merge hook failed. Worktree state is
    /// preserved; user should fix the hook output and retry.
    HookFailed { stage: String, stderr: String },
    /// `git merge` left the repo in a conflicted state. Worktree NOT
    /// removed — user resolves manually via Discard or by editing.
    /// `git_merge_worktree` runs `git merge --abort` before returning
    /// this so the parent repo is left clean for subsequent attempts.
    MergeConflict { branch: String, files: Vec<String> },
    /// The merge target's local branch could not be fast-forwarded to
    /// `origin/<target>` before merging (caller must `git pull` first or
    /// the orchestrator can't safely merge into a stale local target).
    TargetBranchStale { target: String, message: String },
    /// Pre-flight refused the merge because the parent repo's working
    /// tree has uncommitted/untracked changes. Surfaces the file list so
    /// the user knows what to commit/stash before retrying. Prevents the
    /// silent-branch-switch footgun (claude3 task-64 C4) and the dirty-
    /// switch error (claude2 task-62 Concern 1).
    ParentRepoDirty {
        repo_root: String,
        files: Vec<String>,
    },
    /// Local merge succeeded but `git push origin <target>` failed.
    /// `merged_sha` is on the local target branch already; the frontend
    /// should treat the task as merged-locally and surface the push
    /// failure separately (don't retry the merge — that would attempt
    /// to merge an already-merged branch). codex2 task-63 H1.
    PushFailedAfterMerge { merged_sha: String, stderr: String },
    /// `git_create_approval_commit` could not determine a committer
    /// identity. Should be impossible after RESID-4's explicit
    /// `-c user.name=... -c user.email=...` injection; treat as
    /// `GenericFailure` if it ever fires.
    AuthorIdentityMissing,
    /// Catch-all for git invocations that exited non-zero with a stderr
    /// the variants above don't cover. Includes the full command + stderr
    /// so the UI can surface diagnostic context.
    GenericFailure {
        command: String,
        stderr: String,
        exit_code: i32,
    },
}

impl GitError {
    fn from_command_failure(command: String, stderr: String, exit_code: i32) -> Self {
        // Classify common patterns into structured variants. Anything
        // unrecognized falls through to GenericFailure with full stderr.
        let lc = stderr.to_lowercase();
        if lc.contains("nothing to commit") || lc.contains("no changes added") {
            return GitError::EmptyCommit { message: stderr };
        }
        if lc.contains("hook") && (lc.contains("failed") || lc.contains("rejected")) {
            return GitError::HookFailed {
                stage: "unknown".to_string(),
                stderr,
            };
        }
        if lc.contains("automatic merge failed")
            || lc.contains("conflict")
            || lc.contains("merge conflict")
        {
            return GitError::MergeConflict {
                branch: String::new(),
                files: Vec::new(),
            };
        }
        if lc.contains("not possible to fast-forward")
            || lc.contains("non-fast-forward")
            || lc.contains("rejected")
        {
            return GitError::TargetBranchStale {
                target: String::new(),
                message: stderr,
            };
        }
        if lc.contains("please tell me who you are") || lc.contains("user.name") {
            return GitError::AuthorIdentityMissing;
        }
        GitError::GenericFailure {
            command,
            stderr,
            exit_code,
        }
    }
}

/// Output of `git_create_approval_commit`. Returns the commit SHA on
/// success or the structured `GitError` variant on failure.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalCommitResult {
    pub commit_sha: String,
    /// Number of files staged into the commit (informational; the UI can
    /// cross-check against the pre-commit `DiffSummary` it showed the user).
    pub staged_count: usize,
}

/// Output of `git_merge_worktree`. On success: SHA of the merge commit.
/// On `pushed: true`: the same SHA is now on `origin/<target>`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeResult {
    pub merged_sha: String,
    pub pushed: bool,
}

/// Stage all working-tree changes and create a single commit on the
/// agent's branch authored as `<agent_handle> via orchestrator`. Used
/// by the Approve flow when the agent left uncommitted/untracked work
/// behind (codex2 #1: prevents no-op merges).
///
/// RESID-4 + POLISH-5: explicit committer identity via `-c user.name=`
/// + `-c user.email=` (works on fresh worktrees with no global git config)
/// AND author attribution preserves the agent handle for traceability.
#[tauri::command]
pub fn git_create_approval_commit(
    worktree_path: String,
    message: String,
    agent_handle: String,
) -> Result<ApprovalCommitResult, GitError> {
    validate_managed_worktree_path(&worktree_path).map_err(|e| GitError::GenericFailure {
        command: "validate_managed_worktree_path".to_string(),
        stderr: e,
        exit_code: -1,
    })?;
    let wt = PathBuf::from(&worktree_path);

    // Stage everything (codex1 task-43 #5 / claude2 task-50 — D2 broadened
    // scope: tracked + staged + committed + untracked-non-ignored. Approval
    // UI shows the diff before this fires, so user has already seen what
    // will be staged.).
    run_git_with_committer_identity(&wt, &["add", "-A"])
        .map_err(|e| GitError::from_command_failure("git add -A".to_string(), e.0, e.1))?;

    // Count staged files so the caller can verify against the pre-commit diff.
    let staged_count = match git_capture_raw(Some(&wt), &["diff", "--name-only", "-z", "--cached"])
    {
        Ok(s) => s.split('\0').filter(|p| !p.is_empty()).count(),
        Err(_) => 0,
    };

    // Empty-commit short circuit: if `git add -A` staged nothing AND the
    // worktree had no committed delta either, surface EmptyCommit so the
    // caller can transition the task to `blocked` instead of trying to
    // merge an empty branch.
    if staged_count == 0 {
        // Don't attempt the commit at all — git would refuse with a
        // misleading "nothing to commit" but we already know.
        return Err(GitError::EmptyCommit {
            message: "no working-tree changes to stage".to_string(),
        });
    }

    let author = format!(
        "{} via orchestrator <noreply@canvas-terminal>",
        agent_handle
    );
    run_git_with_committer_identity(&wt, &["commit", "-m", &message, "--author", &author])
        .map_err(|e| GitError::from_command_failure("git commit".to_string(), e.0, e.1))?;

    let commit_sha =
        git_capture(Some(&wt), &["rev-parse", "HEAD"]).map_err(|e| GitError::GenericFailure {
            command: "git rev-parse HEAD".to_string(),
            stderr: e,
            exit_code: -1,
        })?;

    Ok(ApprovalCommitResult {
        commit_sha,
        staged_count,
    })
}

/// Helper: invoke `git` with `-c user.name=...` + `-c user.email=...` and
/// `GIT_COMMITTER_*` env vars. Belt-and-braces for fresh-worktree commit
/// failures (RESID-4). On failure returns `(combined_output, exit_code)`
/// where `combined_output = stderr + "\n" + stdout` — git writes some
/// failure modes (notably merge conflicts: "CONFLICT (content): ...")
/// to stdout, so the classifier needs both streams to find the right
/// `GitError` variant.
fn run_git_with_committer_identity(repo: &Path, args: &[&str]) -> Result<(), (String, i32)> {
    let path = repo
        .to_str()
        .ok_or(("non-utf8 repo path".to_string(), -1))?;
    let mut full_args: Vec<&str> = vec![
        "-C",
        path,
        "-c",
        "user.name=Canvas-Terminal Orchestrator",
        "-c",
        "user.email=noreply@canvas-terminal.local",
    ];
    full_args.extend_from_slice(args);

    let output = Command::new("git")
        .args(&full_args)
        .env("GIT_COMMITTER_NAME", "Canvas-Terminal Orchestrator")
        .env("GIT_COMMITTER_EMAIL", "noreply@canvas-terminal.local")
        .output()
        .map_err(|e| (format!("failed to spawn git: {}", e), -1))?;
    if output.status.success() {
        Ok(())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        let combined = if stderr.trim().is_empty() {
            stdout.trim().to_string()
        } else if stdout.trim().is_empty() {
            stderr.trim().to_string()
        } else {
            format!("{}\n{}", stderr.trim(), stdout.trim())
        };
        Err((combined, output.status.code().unwrap_or(-1)))
    }
}

/// Merge an agent branch into the protected target (default `dev`).
///
/// Acquires a Rust-side file lock on `<repo_root>/.canvas-terminal.merge.lock`
/// (D8) so concurrent Approve clicks don't interleave merges. Lock is
/// released on Drop.
///
/// **Pre-flight invariants (claude3 task-64 C4 + claude2 task-62 Concern 1):**
///   1. Refuse if `target_branch` is in the protected family — orchestrator
///      never lands source on `main/master/production/release` directly.
///   2. Refuse if `branch_name` is outside the `agent/` namespace.
///   3. Refuse if the parent repo has uncommitted/untracked changes
///      (`ParentRepoDirty`). Otherwise `git switch <target>` would fail
///      confusingly OR succeed silently and leave the user surprised.
///
/// **Branch-restore guarantee:** the orchestrator's `git switch <target>`
/// changes the parent repo's HEAD. We capture the original branch up
/// front and restore it before returning, regardless of merge success.
///
/// **Conflict cleanup (codex1 task-61 H1):** on conflict, run
/// `git merge --abort` BEFORE returning so the parent repo is clean
/// for subsequent merges. Worktree is preserved.
///
/// **Push partial-success (codex2 task-63 H1):** if push fails after a
/// successful local merge, return `PushFailedAfterMerge { merged_sha, stderr }`
/// so the frontend can distinguish from a failed-merge state and not
/// re-trigger a now-redundant merge.
///
/// `push=false` by default (D12).
#[tauri::command]
pub fn git_merge_worktree(
    repo_root: String,
    branch_name: String,
    target_branch: String,
    push: bool,
) -> Result<MergeResult, GitError> {
    if PROTECTED_BRANCHES.contains(&target_branch.as_str()) {
        return Err(GitError::GenericFailure {
            command: "git_merge_worktree".to_string(),
            stderr: format!(
                "refusing to merge into protected branch '{}'. The L1 invariant forbids the orchestrator from landing source on main/master/production/release directly.",
                target_branch
            ),
            exit_code: -1,
        });
    }
    validate_managed_branch_name(&branch_name).map_err(|e| GitError::GenericFailure {
        command: "validate_managed_branch_name".to_string(),
        stderr: e,
        exit_code: -1,
    })?;

    let repo_path = PathBuf::from(&repo_root);
    let _lock = MergeLock::acquire(&repo_path).map_err(|e| GitError::GenericFailure {
        command: "merge-lock acquire".to_string(),
        stderr: e,
        exit_code: -1,
    })?;

    // Pre-flight: refuse if parent has uncommitted work. Checking via
    // `--porcelain --untracked-files=normal` matches the broader D2 sense
    // (any working-tree state, including untracked files in the repo
    // root). The user must commit/stash before re-trying Approve.
    let parent_dirty = git_capture_raw(
        Some(&repo_path),
        &["status", "--porcelain", "--untracked-files=normal", "-z"],
    )
    .map_err(|e| GitError::GenericFailure {
        command: "git status --porcelain (parent preflight)".to_string(),
        stderr: e,
        exit_code: -1,
    })?;
    if !parent_dirty.is_empty() {
        let files: Vec<String> = parent_dirty
            .split('\0')
            .filter(|s| !s.is_empty())
            // Each entry is "XY <path>"; strip the 3-byte prefix when
            // present so the UI shows just the paths.
            .map(|entry| {
                if entry.len() >= 3 {
                    entry[3..].to_string()
                } else {
                    entry.to_string()
                }
            })
            .collect();
        return Err(GitError::ParentRepoDirty {
            repo_root: repo_root.clone(),
            files,
        });
    }

    // Capture the original branch so we can restore it on completion.
    // Detached-HEAD case returns an error; treat as "no branch to
    // restore" and skip the restore at the end.
    let original_branch =
        git_capture_opt(Some(&repo_path), &["symbolic-ref", "--short", "HEAD"]);

    // Switch to the target branch. May fail if dev is checked out in
    // another worktree (e.g., the agent's). In v1 we'd treat that as a
    // genuine failure surfaced as GenericFailure; bigger redesign of
    // "merge in detached HEAD via update-ref" is P5.
    if let Err(stderr) = git_capture(Some(&repo_path), &["switch", &target_branch]) {
        // Try to restore the original branch even on this early failure
        // (best-effort; ignore restore error so we don't mask the
        // original cause).
        if let Some(orig) = original_branch.as_deref() {
            let _ = git_capture(Some(&repo_path), &["switch", orig]);
        }
        return Err(GitError::from_command_failure(
            format!("git switch {}", target_branch),
            stderr,
            -1,
        ));
    }

    // Fast-forward target to its remote tip when possible. If the local
    // target is behind origin AND has divergent commits, fail-fast with
    // TargetBranchStale so the user pulls explicitly. Restore branch
    // before returning.
    if git_capture(
        Some(&repo_path),
        &["rev-parse", &format!("origin/{}", target_branch)],
    )
    .is_ok()
    {
        // Has an upstream; try fast-forward only. (claude3 task-64 C3:
        // dropped the dead-code "Already up to date" stderr check —
        // git writes that to stdout, not stderr, and exits 0, so the
        // err branch only fires on real failures.)
        if let Err(stderr) = git_capture(
            Some(&repo_path),
            &["merge", "--ff-only", &format!("origin/{}", target_branch)],
        ) {
            restore_branch_best_effort(&repo_path, original_branch.as_deref());
            return Err(GitError::TargetBranchStale {
                target: target_branch.clone(),
                message: stderr,
            });
        }
    }

    // The actual merge — `--no-ff` for an explicit merge commit so
    // approvals are visible in `git log` (per v5 §4 P2.d preference).
    let merge_msg = format!("Approve & merge {} into {}", branch_name, target_branch);
    if let Err(stderr) = run_git_with_committer_identity(
        &repo_path,
        &["merge", "--no-ff", &branch_name, "-m", &merge_msg],
    ) {
        let mut err = GitError::from_command_failure(
            format!("git merge {}", branch_name),
            stderr.0.clone(),
            stderr.1,
        );
        // Enrich MergeConflict with the actual conflicting files + branch
        // (the classifier left them empty; supply them now from `status`).
        if let GitError::MergeConflict { .. } = &err {
            let conflicted = git_capture_raw(
                Some(&repo_path),
                &["diff", "--name-only", "--diff-filter=U", "-z"],
            )
            .ok()
            .map(|s| {
                s.split('\0')
                    .filter(|p| !p.is_empty())
                    .map(String::from)
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
            err = GitError::MergeConflict {
                branch: branch_name.clone(),
                files: conflicted,
            };
            // codex1 task-61 H1: clean up the parent repo's MERGE_HEAD /
            // unmerged index so subsequent approvals don't run into a
            // contaminated state. Best-effort — if abort fails we still
            // restore the branch and surface the conflict, but a future
            // `git switch` will at least detect the dirty state via the
            // preflight guard.
            let _ = git_capture(Some(&repo_path), &["merge", "--abort"]);
        }
        restore_branch_best_effort(&repo_path, original_branch.as_deref());
        return Err(err);
    }

    let merged_sha = match git_capture(Some(&repo_path), &["rev-parse", "HEAD"]) {
        Ok(sha) => sha,
        Err(e) => {
            restore_branch_best_effort(&repo_path, original_branch.as_deref());
            return Err(GitError::GenericFailure {
                command: "git rev-parse HEAD".to_string(),
                stderr: e,
                exit_code: -1,
            });
        }
    };

    let mut pushed = false;
    if push {
        if let Err(stderr) = git_capture(
            Some(&repo_path),
            &["push", "origin", &target_branch],
        ) {
            // codex2 task-63 H1: local merge succeeded but push failed.
            // Surface as PushFailedAfterMerge so the frontend doesn't
            // retry-as-merge a now-redundant merge.
            restore_branch_best_effort(&repo_path, original_branch.as_deref());
            return Err(GitError::PushFailedAfterMerge {
                merged_sha,
                stderr,
            });
        }
        pushed = true;
    }

    restore_branch_best_effort(&repo_path, original_branch.as_deref());
    Ok(MergeResult { merged_sha, pushed })
}

/// Best-effort restore of the parent repo's HEAD to a previously-checked-
/// out branch. Called on every exit path of `git_merge_worktree` so the
/// user's working state is unchanged regardless of merge success/failure.
/// Detached-HEAD case (`original` is None) is a no-op.
///
/// Failure here doesn't cancel the caller's primary error — we already
/// have something to surface; logging would just add noise. The user can
/// `git switch` manually if the restore failed (extremely unlikely
/// because we already verified the working tree was clean in the
/// preflight, and we leave it clean on every failure path).
fn restore_branch_best_effort(repo_path: &Path, original: Option<&str>) {
    if let Some(branch) = original {
        let _ = git_capture(Some(repo_path), &["switch", branch]);
    }
}

/// File-lock guard for `git_merge_worktree`. Lock file lives **outside**
/// the repo (at `~/.cache/canvas-terminal/locks/<repo-hash>.lock`) so it
/// doesn't trip the parent-repo dirty preflight (round-5 review fix —
/// would otherwise self-poison: lock file → status --porcelain reports
/// untracked → ParentRepoDirty). Released on Drop. `acquire` blocks
/// (with a short backoff) up to ACQUIRE_TIMEOUT_MS.
struct MergeLock {
    _file: std::fs::File,
}

impl MergeLock {
    fn acquire(repo_root: &Path) -> Result<Self, String> {
        use fs2::FileExt;
        const ACQUIRE_TIMEOUT_MS: u64 = 30_000;
        const POLL_MS: u64 = 50;

        let lock_path = locks_dir_for_repo(repo_root)?;
        let file = std::fs::OpenOptions::new()
            .create(true)
            .read(true)
            .write(true)
            .truncate(false)
            .open(&lock_path)
            .map_err(|e| format!("failed to open merge lock file: {}", e))?;

        let start = std::time::Instant::now();
        loop {
            match file.try_lock_exclusive() {
                Ok(()) => return Ok(Self { _file: file }),
                Err(_) => {
                    if start.elapsed().as_millis() as u64 >= ACQUIRE_TIMEOUT_MS {
                        return Err(format!(
                            "another merge is in progress (lock at {}); try again in a moment",
                            lock_path.display()
                        ));
                    }
                    std::thread::sleep(std::time::Duration::from_millis(POLL_MS));
                }
            }
        }
    }
}

/// Compute a stable, filesystem-safe per-repo lock file path under
/// `~/.cache/canvas-terminal/locks/`. Distinct repos get distinct lock
/// files because the leaf includes a hex hash of the repo's absolute
/// path. Inside the repo would be wrong — see `MergeLock` doc.
fn locks_dir_for_repo(repo_root: &Path) -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or("Cannot determine home directory")?;
    let dir = home.join(".cache").join("canvas-terminal").join("locks");
    std::fs::create_dir_all(&dir).map_err(|e| format!("failed to create locks dir: {}", e))?;
    // Cheap stable hash — DefaultHasher is enough for path → filename
    // uniqueness; this is not a cryptographic key.
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    repo_root.hash(&mut hasher);
    let hash = hasher.finish();
    Ok(dir.join(format!("repo-{:016x}.lock", hash)))
}

impl Drop for MergeLock {
    fn drop(&mut self) {
        // fs2's lock is released automatically when the file is closed
        // (which happens when this struct is dropped). No explicit unlock
        // call needed.
    }
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
    /// exercise the same path policy as production callers. The path
    /// includes a nanosecond timestamp + a process-local counter so
    /// stale dirs from prior failed `cargo test` runs don't collide.
    fn make_managed_worktree_path(label: &str) -> String {
        let n = TEST_COUNTER.fetch_add(1, Ordering::SeqCst);
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let collab = format!("test-{}-{}-{}", label, now, n);
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

    // -------------------------------------------------------------------
    // P2 backend tests — git_create_approval_commit + git_merge_worktree
    // -------------------------------------------------------------------

    #[test]
    fn approval_commit_succeeds_with_explicit_committer_identity() {
        // RESID-4: explicit `-c user.name` + `-c user.email` injection
        // means the commit succeeds even on a worktree with no global
        // git config. We can't disable global config in CI without
        // affecting other tests, but we CAN verify the commit produces
        // an author matching the agent-handle attribution (POLISH-5).
        let repo = make_test_repo();
        let wt_str = make_managed_worktree_path("approval");
        let meta = git_worktree_create(
            repo.to_string_lossy().to_string(),
            wt_str.clone(),
            "agent/test-approval".to_string(),
            "dev".to_string(),
        )
        .unwrap();
        let wt = PathBuf::from(&wt_str);

        // Agent edits but doesn't commit (the regression case codex2 #1
        // raised — without D9 this becomes a no-op merge).
        std::fs::write(wt.join("new.ts"), "export {};\n").unwrap();
        std::fs::write(wt.join("README.md"), "modified\n").unwrap();

        let result = git_create_approval_commit(
            wt_str.clone(),
            "task-X approved by user".to_string(),
            "@claude2".to_string(),
        )
        .expect("approval commit should succeed");
        assert!(!result.commit_sha.is_empty());
        assert!(
            result.staged_count >= 2,
            "should stage both modified README and untracked .ts; got {}",
            result.staged_count
        );

        // Verify author attribution preserves the agent handle (POLISH-5).
        let author = git_capture(Some(&wt), &["log", "-1", "--pretty=%an"]).unwrap();
        assert!(
            author.starts_with("@claude2 via orchestrator"),
            "author should preserve agent handle; got: {}",
            author
        );
        // Verify committer is the orchestrator identity (RESID-4).
        let committer_email = git_capture(Some(&wt), &["log", "-1", "--pretty=%ce"]).unwrap();
        assert_eq!(committer_email, "noreply@canvas-terminal.local");

        // Cleanup
        let _ = git_worktree_remove(repo.to_string_lossy().to_string(), wt_str, meta.branch);
    }

    #[test]
    fn approval_commit_returns_empty_commit_variant_when_clean() {
        // Caller should be able to distinguish "nothing to merge" from
        // a real failure so the task can transition to `blocked` rather
        // than retrying or stranding.
        let repo = make_test_repo();
        let wt_str = make_managed_worktree_path("empty");
        let meta = git_worktree_create(
            repo.to_string_lossy().to_string(),
            wt_str.clone(),
            "agent/test-empty".to_string(),
            "dev".to_string(),
        )
        .unwrap();

        let result = git_create_approval_commit(
            wt_str.clone(),
            "no work to commit".to_string(),
            "@codex1".to_string(),
        );
        match result {
            Err(GitError::EmptyCommit { .. }) => {} // expected
            other => panic!("expected EmptyCommit; got {:?}", other),
        }

        let _ = git_worktree_remove(repo.to_string_lossy().to_string(), wt_str, meta.branch);
    }

    #[test]
    fn merge_worktree_refuses_protected_target() {
        // Cardinal invariant: orchestrator MUST NOT merge into main/master/
        // production/release directly. v5 D6 + L1 boundary depend on this.
        let repo = make_test_repo();
        for proto in ["main", "master", "production", "release"] {
            let result = git_merge_worktree(
                repo.to_string_lossy().to_string(),
                "agent/test-x".to_string(),
                proto.to_string(),
                false,
            );
            match result {
                Err(GitError::GenericFailure { stderr, .. }) => {
                    assert!(
                        stderr.contains("protected branch"),
                        "should mention protected branch; got: {}",
                        stderr
                    );
                }
                other => panic!("expected refusal for target '{}'; got {:?}", proto, other),
            }
        }
    }

    #[test]
    fn merge_worktree_refuses_unmanaged_branch() {
        // codex2 task-51 High-#2: branch namespace check must apply to
        // merge entry point too.
        let repo = make_test_repo();
        let result = git_merge_worktree(
            repo.to_string_lossy().to_string(),
            "feature/x".to_string(), // not in agent/ namespace
            "dev".to_string(),
            false,
        );
        match result {
            Err(GitError::GenericFailure { stderr, .. }) => {
                assert!(stderr.contains("agent/"), "should mention agent/ namespace");
            }
            other => panic!("expected refusal; got {:?}", other),
        }
    }

    #[test]
    fn merge_worktree_happy_path_no_push() {
        // End-to-end: provision worktree, agent commits work, orchestrator
        // merges the agent branch into dev WITHOUT pushing (D12 default).
        let repo = make_test_repo();
        let wt_str = make_managed_worktree_path("merge");
        let meta = git_worktree_create(
            repo.to_string_lossy().to_string(),
            wt_str.clone(),
            "agent/test-merge".to_string(),
            "dev".to_string(),
        )
        .unwrap();
        let wt = PathBuf::from(&wt_str);

        // Agent makes a commit.
        std::fs::write(wt.join("agent-work.ts"), "export const x = 1;\n").unwrap();
        run_git_with_committer_identity(&wt, &["add", "agent-work.ts"]).unwrap();
        run_git_with_committer_identity(&wt, &["commit", "-m", "agent commit"]).unwrap();

        // Capture dev's tip BEFORE merge so we can verify it advanced.
        let dev_tip_before = git_capture(Some(&repo), &["rev-parse", "dev"]).unwrap();

        let result = git_merge_worktree(
            repo.to_string_lossy().to_string(),
            meta.branch.clone(),
            "dev".to_string(),
            false, // push: false (D12 default)
        )
        .expect("merge should succeed");
        assert!(!result.merged_sha.is_empty());
        assert!(!result.pushed, "push should be false by default (D12)");

        // dev should have advanced beyond pre-merge tip.
        let dev_tip_after = git_capture(Some(&repo), &["rev-parse", "dev"]).unwrap();
        assert_ne!(
            dev_tip_before, dev_tip_after,
            "dev tip should advance after merge"
        );

        // The merge produced a --no-ff merge commit on dev. Since
        // git_merge_worktree restores the parent's HEAD to the original
        // branch (main) after the merge (claude3 task-64 C4 fix), query
        // `dev` directly rather than HEAD to find the merge commit.
        let parent_count = git_capture(Some(&repo), &["rev-list", "--parents", "-n", "1", "dev"])
            .unwrap()
            .split_whitespace()
            .count()
            - 1;
        assert_eq!(
            parent_count, 2,
            "--no-ff merge should produce 2-parent commit on dev"
        );

        // Cleanup the agent worktree (branch will be merged so -d works).
        let _ = git_worktree_remove(repo.to_string_lossy().to_string(), wt_str, meta.branch);
    }

    #[test]
    fn merge_worktree_surfaces_conflict_as_structured_variant() {
        // LB6: conflict classifier maps `git merge` failure with combined
        // stdout/stderr containing "CONFLICT"/"merge failed" markers into
        // GitError::MergeConflict. We exercise the classifier directly
        // by running the same `git merge` invocation `git_merge_worktree`
        // would run, then feeding the output into `from_command_failure`.
        // We don't drive `git_merge_worktree` end-to-end because it does
        // `git switch <target>` on the parent repo, and `dev` is held by
        // the agent's worktree at the merge point — that's covered by
        // the happy-path test instead.
        let repo = make_test_repo();
        // Advance dev with a "dev side" commit (parent repo currently on
        // `main`; switching to `dev` is fine because no worktree holds it).
        run_git_with_committer_identity(&repo, &["checkout", "dev"]).unwrap();
        std::fs::write(repo.join("README.md"), "dev side\n").unwrap();
        run_git_with_committer_identity(&repo, &["add", "README.md"]).unwrap();
        run_git_with_committer_identity(&repo, &["commit", "-m", "dev edit"]).unwrap();
        // Restore parent to main so the worktree can claim dev.
        run_git_with_committer_identity(&repo, &["checkout", "main"]).unwrap();

        // Provision worktree from dev (now ahead of main).
        let wt_str = make_managed_worktree_path("conflict");
        let meta = git_worktree_create(
            repo.to_string_lossy().to_string(),
            wt_str.clone(),
            "agent/test-conflict".to_string(),
            "dev".to_string(),
        )
        .unwrap();
        let wt = PathBuf::from(&wt_str);
        // Agent makes a conflicting edit on top.
        std::fs::write(wt.join("README.md"), "agent side\n").unwrap();
        run_git_with_committer_identity(&wt, &["add", "README.md"]).unwrap();
        run_git_with_committer_identity(&wt, &["commit", "-m", "agent edit"]).unwrap();

        // Advance dev AGAIN with a divergent second edit. Since dev is
        // held by the worktree, we use a detached-HEAD trick: check out
        // dev's tip as a detached HEAD on the parent repo, commit, then
        // `update-ref` dev to the new tip. The worktree's claim on dev
        // is unchanged — it still has agent's branch checked out, not
        // dev itself.
        let dev_tip = git_capture(Some(&repo), &["rev-parse", "dev"]).unwrap();
        run_git_with_committer_identity(&repo, &["checkout", &dev_tip]).unwrap();
        std::fs::write(repo.join("README.md"), "dev side v2\n").unwrap();
        run_git_with_committer_identity(&repo, &["add", "README.md"]).unwrap();
        run_git_with_committer_identity(&repo, &["commit", "-m", "dev edit 2"]).unwrap();
        let new_dev_sha = git_capture(Some(&repo), &["rev-parse", "HEAD"]).unwrap();
        run_git_with_committer_identity(
            &repo,
            &["update-ref", "refs/heads/dev", &new_dev_sha],
        )
        .unwrap();

        // Run `git merge --no-ff dev` from inside the worktree (which is
        // on agent/test-conflict). Conflict expected.
        let merge_attempt = run_git_with_committer_identity(
            &wt,
            &["merge", "--no-ff", "dev", "-m", "test-driven merge"],
        );
        match merge_attempt {
            Err((stderr, code)) => {
                let err = GitError::from_command_failure(
                    "git merge dev".to_string(),
                    stderr,
                    code,
                );
                match err {
                    GitError::MergeConflict { .. } => {} // expected
                    other => panic!("expected MergeConflict variant; got {:?}", other),
                }
            }
            Ok(_) => panic!("merge should have failed with a conflict"),
        }

        // Abort the merge so cleanup can proceed.
        let _ = git_capture(Some(&wt), &["merge", "--abort"]);
        let _ = git_worktree_remove(
            repo.to_string_lossy().to_string(),
            wt_str,
            meta.branch.clone(),
        );
        let _ = git_capture(Some(&repo), &["branch", "-D", &meta.branch]);
    }

    #[test]
    fn merge_lock_creates_lock_file() {
        // D8 smoke test: cross-process exclusivity requires a child-process
        // harness which is out of scope here. This test verifies the lock
        // file is created in the expected `~/.cache/canvas-terminal/locks/`
        // location and that the MergeLock guard structure is sound
        // (renamed from `_is_exclusive` per claude3 task-64 C1 — was
        // misleading). The lock file lives OUTSIDE the repo to avoid
        // tripping the parent-dirty preflight (round-5 review fix).
        let repo = make_test_repo();
        let _first = MergeLock::acquire(&repo).expect("first lock should succeed");
        let expected_lock = locks_dir_for_repo(&repo).unwrap();
        assert!(
            expected_lock.exists(),
            "lock file should exist at {} after acquire",
            expected_lock.display()
        );
        // Lock is OUTSIDE the repo (not in repo.join(".canvas-terminal...")).
        assert!(!repo.join(".canvas-terminal.merge.lock").exists());
        // The Drop impl releases the lock when `_first` goes out of scope.
    }

    // -------------------------------------------------------------------
    // Round-5 review fixes — codex1 task-61 H1 (parent cleanup on
    // conflict), codex2 task-63 H1 (push partial-success), claude2
    // task-62 Concern 1 + claude3 task-64 C4 (parent dirty pre-check).
    // -------------------------------------------------------------------

    #[test]
    fn merge_worktree_refuses_dirty_parent_with_structured_error() {
        // claude3 task-64 C4 + claude2 task-62 Concern 1: if the user has
        // uncommitted work on the parent repo's currently-checked-out
        // branch, `git switch <target>` would fail confusingly. Pre-flight
        // refuses with structured ParentRepoDirty so the UI can list the
        // files and tell the user to commit/stash.
        let repo = make_test_repo();
        // Provision an agent worktree so we have a real branch to merge.
        let wt_str = make_managed_worktree_path("dirty-parent");
        let meta = git_worktree_create(
            repo.to_string_lossy().to_string(),
            wt_str.clone(),
            "agent/test-dirty-parent".to_string(),
            "dev".to_string(),
        )
        .unwrap();
        // Dirty the parent repo's working tree.
        std::fs::write(repo.join("README.md"), "user uncommitted edit\n").unwrap();

        let result = git_merge_worktree(
            repo.to_string_lossy().to_string(),
            meta.branch.clone(),
            "dev".to_string(),
            false,
        );
        match result {
            Err(GitError::ParentRepoDirty { repo_root, files }) => {
                assert_eq!(repo_root, repo.to_string_lossy());
                assert!(
                    files.contains(&"README.md".to_string()),
                    "dirty file list should include README.md; got {:?}",
                    files
                );
            }
            other => panic!("expected ParentRepoDirty; got {:?}", other),
        }

        // Cleanup: revert the dirty change so subsequent tests aren't
        // affected (no-op for this test's repo because each test has its
        // own; just being defensive).
        let _ = git_capture(Some(&repo), &["checkout", "--", "README.md"]);
        let _ = git_worktree_remove(
            repo.to_string_lossy().to_string(),
            wt_str,
            meta.branch,
        );
    }

    #[test]
    fn merge_worktree_aborts_conflict_and_restores_branch_end_to_end() {
        // codex1 task-61 H1: end-to-end conflict path through
        // git_merge_worktree (not just the classifier). Asserts:
        //  - returns GitError::MergeConflict { branch, files }
        //  - .git/MERGE_HEAD is absent afterwards (--abort cleaned up)
        //  - parent repo's status --porcelain has no unmerged entries
        //  - parent repo HEAD is back on the original branch (main)
        //  - subsequent merge attempts are not poisoned (lock released)
        let repo = make_test_repo();
        // Step 1: advance dev with a "dev side" commit (parent on main).
        run_git_with_committer_identity(&repo, &["checkout", "dev"]).unwrap();
        std::fs::write(repo.join("README.md"), "dev side\n").unwrap();
        run_git_with_committer_identity(&repo, &["add", "README.md"]).unwrap();
        run_git_with_committer_identity(&repo, &["commit", "-m", "dev edit"]).unwrap();
        run_git_with_committer_identity(&repo, &["checkout", "main"]).unwrap();
        let main_tip_before = git_capture(Some(&repo), &["rev-parse", "main"]).unwrap();

        // Step 2: provision agent worktree, agent makes conflicting commit.
        let wt_str = make_managed_worktree_path("e2e-conflict");
        let meta = git_worktree_create(
            repo.to_string_lossy().to_string(),
            wt_str.clone(),
            "agent/test-e2e-conflict".to_string(),
            "dev".to_string(),
        )
        .unwrap();
        let wt = PathBuf::from(&wt_str);
        std::fs::write(wt.join("README.md"), "agent side\n").unwrap();
        run_git_with_committer_identity(&wt, &["add", "README.md"]).unwrap();
        run_git_with_committer_identity(&wt, &["commit", "-m", "agent edit"]).unwrap();

        // Step 3: advance dev AGAIN via detached-HEAD + update-ref so the
        // worktree's claim isn't disturbed.
        let dev_tip = git_capture(Some(&repo), &["rev-parse", "dev"]).unwrap();
        run_git_with_committer_identity(&repo, &["checkout", &dev_tip]).unwrap();
        std::fs::write(repo.join("README.md"), "dev side v2\n").unwrap();
        run_git_with_committer_identity(&repo, &["add", "README.md"]).unwrap();
        run_git_with_committer_identity(&repo, &["commit", "-m", "dev edit 2"]).unwrap();
        let new_dev_sha = git_capture(Some(&repo), &["rev-parse", "HEAD"]).unwrap();
        run_git_with_committer_identity(
            &repo,
            &["update-ref", "refs/heads/dev", &new_dev_sha],
        )
        .unwrap();
        // Restore parent to main for the merge.
        run_git_with_committer_identity(&repo, &["checkout", "main"]).unwrap();

        // Step 4: invoke the merge. Should hit a conflict.
        let result = git_merge_worktree(
            repo.to_string_lossy().to_string(),
            meta.branch.clone(),
            "dev".to_string(),
            false,
        );
        match result {
            Err(GitError::MergeConflict { branch, files }) => {
                assert_eq!(branch, meta.branch);
                assert!(
                    files.contains(&"README.md".to_string()),
                    "should report README.md as conflicted; got {:?}",
                    files
                );
            }
            other => panic!("expected MergeConflict; got {:?}", other),
        }

        // Step 5: invariant checks AFTER conflict.
        // (a) MERGE_HEAD must be absent (cleaned up by `git merge --abort`)
        assert!(
            !repo.join(".git/MERGE_HEAD").exists(),
            "MERGE_HEAD should be cleared after conflict (codex1 task-61 H1)"
        );
        // (b) parent repo's working tree must have no unmerged entries
        let porcelain =
            git_capture_raw(Some(&repo), &["status", "--porcelain", "-z"]).unwrap();
        assert!(
            !porcelain.contains("UU "),
            "parent repo should have no unmerged entries; got porcelain: {:?}",
            porcelain
        );
        // (c) parent repo's HEAD restored to the original branch (main)
        let head_branch = git_capture(Some(&repo), &["symbolic-ref", "--short", "HEAD"])
            .expect("HEAD should still be on a branch");
        assert_eq!(
            head_branch, "main",
            "parent should be restored to original branch after conflict"
        );
        // (d) main itself is unchanged (the conflict happened on dev)
        let main_tip_after = git_capture(Some(&repo), &["rev-parse", "main"]).unwrap();
        assert_eq!(main_tip_before, main_tip_after, "main tip should be unchanged");

        // Step 6: subsequent merge attempt is NOT poisoned. We can't
        // re-attempt the same merge (it'll conflict again), but we CAN
        // verify the lock was released by acquiring it directly.
        let _second_lock =
            MergeLock::acquire(&repo).expect("lock should be releasable after conflict");

        let _ = git_worktree_remove(
            repo.to_string_lossy().to_string(),
            wt_str,
            meta.branch.clone(),
        );
        let _ = git_capture(Some(&repo), &["branch", "-D", &meta.branch]);
    }

    #[test]
    fn merge_worktree_restores_original_branch_on_happy_path() {
        // claude3 task-64 C4: even on success, parent must end up on the
        // original branch — not silently switched to `dev`.
        let repo = make_test_repo();
        let wt_str = make_managed_worktree_path("restore");
        let meta = git_worktree_create(
            repo.to_string_lossy().to_string(),
            wt_str.clone(),
            "agent/test-restore".to_string(),
            "dev".to_string(),
        )
        .unwrap();
        let wt = PathBuf::from(&wt_str);
        std::fs::write(wt.join("x.txt"), "x\n").unwrap();
        run_git_with_committer_identity(&wt, &["add", "x.txt"]).unwrap();
        run_git_with_committer_identity(&wt, &["commit", "-m", "x"]).unwrap();

        // Parent currently on `main` (per make_test_repo).
        let result = git_merge_worktree(
            repo.to_string_lossy().to_string(),
            meta.branch.clone(),
            "dev".to_string(),
            false,
        );
        assert!(result.is_ok(), "merge should succeed: {:?}", result);
        // Verify HEAD restored to main.
        let head = git_capture(Some(&repo), &["symbolic-ref", "--short", "HEAD"]).unwrap();
        assert_eq!(head, "main", "parent HEAD should be restored to original branch");

        let _ = git_worktree_remove(
            repo.to_string_lossy().to_string(),
            wt_str,
            meta.branch,
        );
    }
}
