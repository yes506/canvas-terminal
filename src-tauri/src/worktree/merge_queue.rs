// Worktree subsystem — Phase 6 merge queue (D16-D23)
//
// Per spec §1 + Phase 6 design: leases that reach `MergeReady` (cat 6
// fast-path or `Preserved` with branch ahead of base) can be queued
// for merge into the base ref. The merge state machine adds:
//
//   MergeReady → MergeQueued → Merging → Merged → Removed → GcDone
//                              ↓
//                              MergeFailed { reason }   (half-state)
//                              ↓ (user)
//                              MergeAborted { reason }  (half-state)
//
// Phase 6 scope:
//   - Tauri commands: queue_merge, query_merge_state, approve_merge,
//     abort_merge, retry_merge
//   - Merge worker: fast-forward attempt, fallback to 3-way merge,
//     conflict surface as `MergeFailed`
//   - Defense-in-depth: re-run secret detector on the merged delta
//     before fast-forward (catches cases where the wip ref was created
//     before the secret was introduced)
//   - Persistence: merge state lives in the lease record itself
//     (existing AgentState enum extended); no separate queue store
//
// **Auto-approve mode**: when `WORKTREE_MERGE_AUTO_APPROVE=1`, leases
// in `MergeQueued` automatically advance to `Merging` on the next
// merge worker tick. Default off — human-in-the-loop is the safe
// default for v1.

use crate::worktree::registry::Registry;
use crate::worktree::registry_store::RegistryStoreError;
use crate::worktree::secret_detector::looks_like_secret;
use crate::worktree::types::{AgentState, LeaseRecord, ManagedRoot};
use fs2::FileExt;
use serde::{Deserialize, Serialize};
use std::fs::File;
use std::path::Path;
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

/// RAII guard for the merge worker's serialization flock.
/// Released on drop. Held for the duration of `execute_merge`.
pub struct MergeLockGuard {
    _file: File,
}

impl Drop for MergeLockGuard {
    fn drop(&mut self) {
        // fs2 unlocks on drop automatically via fs2::FileExt::unlock,
        // but we don't need to call it explicitly — close drops the fd
        // which releases the flock on POSIX.
    }
}

#[derive(Debug)]
pub enum MergeError {
    Registry(RegistryStoreError),
    Io(std::io::Error),
    /// Lease is not in a state the merge queue can act on.
    NotMergeable { state: AgentState },
    /// `git merge` reported a conflict — no auto-resolve.
    Conflict { stderr: String },
    /// Pre-merge secret rescan tripped on the merged delta.
    SecretsDetected { count: usize },
    /// `git push` (or analogous final write to base) failed.
    PushFailed(String),
}

impl std::fmt::Display for MergeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            MergeError::Registry(e) => write!(f, "registry: {e}"),
            MergeError::Io(e) => write!(f, "io: {e}"),
            MergeError::NotMergeable { state } => {
                write!(f, "lease not in a mergeable state: {state:?}")
            }
            MergeError::Conflict { stderr } => write!(f, "merge conflict: {stderr}"),
            MergeError::SecretsDetected { count } => {
                write!(f, "{count} secret(s) detected in merged delta — refusing merge")
            }
            MergeError::PushFailed(msg) => write!(f, "merge push failed: {msg}"),
        }
    }
}

impl std::error::Error for MergeError {}

impl From<RegistryStoreError> for MergeError {
    fn from(e: RegistryStoreError) -> Self {
        MergeError::Registry(e)
    }
}

impl From<std::io::Error> for MergeError {
    fn from(e: std::io::Error) -> Self {
        MergeError::Io(e)
    }
}

pub type Result<T> = std::result::Result<T, MergeError>;

/// Snapshot of a lease's merge-related state for the UI.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MergeStateSnapshot {
    pub agent_id: String,
    pub state_kind: String,
    pub branch_short: String,
    pub base_ref: String,
    pub state_reason: Option<String>,
}

pub struct MergeQueue {
    managed_root: ManagedRoot,
    registry: Registry,
}

impl MergeQueue {
    pub fn new(managed_root: ManagedRoot) -> Self {
        let registry = Registry::new(managed_root.clone());
        Self {
            managed_root,
            registry,
        }
    }

    /// D17 — queue a `MergeReady` lease for merge. Transitions
    /// `MergeReady → MergeQueued`. The merge worker (sweep_queue)
    /// picks it up next tick.
    pub fn queue_merge(&self, agent_id: &str) -> Result<()> {
        let lease = self.load_lease(agent_id)?;
        match lease.state {
            AgentState::MergeReady => {
                self.registry
                    .update_state(agent_id, AgentState::MergeQueued, now_unix_secs())?;
                Ok(())
            }
            other => Err(MergeError::NotMergeable { state: other }),
        }
    }

    /// D19 — user approves a queued merge. Transitions
    /// `MergeQueued → Merging` and runs the merge worker synchronously.
    /// On success: `Merging → Merged → Removed → GcDone`.
    /// On failure: `Merging → MergeFailed { reason }`.
    pub fn approve_merge(&self, agent_id: &str) -> Result<()> {
        let lease = self.load_lease(agent_id)?;
        match lease.state {
            AgentState::MergeQueued => {
                self.registry
                    .update_state(agent_id, AgentState::Merging, now_unix_secs())?;
                self.execute_merge(&lease)
            }
            other => Err(MergeError::NotMergeable { state: other }),
        }
    }

    /// D19 — user aborts a queued or in-progress merge. Transitions
    /// to `MergeAborted` half-state for inspection.
    pub fn abort_merge(&self, agent_id: &str, reason: String) -> Result<()> {
        let lease = self.load_lease(agent_id)?;
        match lease.state {
            AgentState::MergeQueued | AgentState::Merging | AgentState::MergeFailed { .. } => {
                self.registry.update_state(
                    agent_id,
                    AgentState::MergeAborted { reason },
                    now_unix_secs(),
                )?;
                Ok(())
            }
            other => Err(MergeError::NotMergeable { state: other }),
        }
    }

    /// D18 — query merge state for the UI.
    pub fn query_state(&self, agent_id: &str) -> Result<Option<MergeStateSnapshot>> {
        let lease = match self.registry.get(agent_id)? {
            Some(l) => l,
            None => return Ok(None),
        };
        let (state_kind, state_reason) = match &lease.state {
            AgentState::MergeReady => ("merge_ready", None),
            AgentState::MergeQueued => ("merge_queued", None),
            AgentState::Merging => ("merging", None),
            AgentState::Merged => ("merged", None),
            AgentState::MergeFailed { reason } => ("merge_failed", Some(reason.clone())),
            AgentState::MergeAborted { reason } => ("merge_aborted", Some(reason.clone())),
            other => {
                return Ok(Some(MergeStateSnapshot {
                    agent_id: lease.agent_id,
                    state_kind: format!("{other:?}"),
                    branch_short: lease.branch_ref.as_str().to_string(),
                    base_ref: lease.base_ref,
                    state_reason: None,
                }));
            }
        };
        Ok(Some(MergeStateSnapshot {
            agent_id: lease.agent_id,
            state_kind: state_kind.to_string(),
            branch_short: lease.branch_ref.as_str().to_string(),
            base_ref: lease.base_ref,
            state_reason,
        }))
    }

    /// Periodic sweep — runs the merge worker for all `MergeQueued`
    /// leases when auto-approve is on. Returns the number of leases
    /// processed.
    pub fn sweep_queue(&self) -> Result<usize> {
        let auto = std::env::var("WORKTREE_MERGE_AUTO_APPROVE")
            .ok()
            .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
            .unwrap_or(false);
        if !auto {
            return Ok(0);
        }
        let leases = self.registry.list_all()?;
        let mut processed = 0;
        for (agent_id, lease) in leases.into_iter() {
            if !matches!(lease.state, AgentState::MergeQueued) {
                continue;
            }
            // Best-effort; failures land as MergeFailed half-state
            if self.approve_merge(&agent_id).is_ok() {
                processed += 1;
            }
        }
        Ok(processed)
    }

    /// D20 + D22 — internal merge worker. Runs the actual git
    /// fast-forward (or 3-way merge fallback), with a defense-in-depth
    /// secret rescan on the merged delta.
    ///
    /// **H2 fix per codex2 #2 + codex3 P0 + claude2 I2 (3/5
    /// convergence)**: validates the source repo is checked out on
    /// `lease.base_ref` BEFORE running `git merge`. Previous behavior
    /// merged into whatever branch the user happened to have checked
    /// out at approve time — data integrity hazard.
    ///
    /// **H8 fix per claude2 I3**: serialize merge worker via
    /// `<managed_root>/merge.lock` flock so concurrent `approve_merge`
    /// calls don't race on the same source repo's `.git/index.lock`.
    fn execute_merge(&self, lease: &LeaseRecord) -> Result<()> {
        // H8: acquire merge serialization lock. Held for the duration
        // of the merge worker. Auto-released on drop.
        let _merge_lock = self.acquire_merge_lock()?;

        // H2: verify the source repo is on lease.base_ref. We compare
        // `git rev-parse --abbrev-ref HEAD` against the bare ref name
        // (strip `refs/heads/` prefix if present).
        let head_out = Command::new("git")
            .args(["rev-parse", "--abbrev-ref", "HEAD"])
            .current_dir(&lease.repo_root)
            .output()?;
        if !head_out.status.success() {
            self.mark_merge_failed(
                &lease.agent_id,
                format!(
                    "could not resolve current HEAD branch in {}",
                    lease.repo_root.display()
                ),
            )?;
            return Err(MergeError::Io(std::io::Error::other(
                "git rev-parse --abbrev-ref HEAD failed",
            )));
        }
        let current_branch = String::from_utf8_lossy(&head_out.stdout)
            .trim()
            .to_string();
        let target_branch = lease
            .base_ref
            .strip_prefix("refs/heads/")
            .unwrap_or(&lease.base_ref);
        if current_branch != target_branch {
            let reason = format!(
                "source repo is on '{current_branch}' but lease.base_ref \
                 targets '{target_branch}' — refusing merge to avoid \
                 mutating ambient checkout state. Run `git checkout \
                 {target_branch}` in {} and retry.",
                lease.repo_root.display()
            );
            self.mark_merge_failed(&lease.agent_id, reason.clone())?;
            return Err(MergeError::Conflict { stderr: reason });
        }

        // Step 1 (D22): re-run the secret detector against the diff
        // between base and the agent's branch HEAD. Catches secrets
        // introduced after the original drainer pass (e.g., the user
        // resolved a PreserveFailed and now wants to merge).
        match self.scan_branch_for_secrets(&lease.repo_root, &lease.base_ref, lease.branch_ref.as_str()) {
            Ok(0) => {}
            Ok(n) => {
                self.mark_merge_failed(
                    &lease.agent_id,
                    format!("secret rescan found {n} match(es) in merged delta"),
                )?;
                return Err(MergeError::SecretsDetected { count: n });
            }
            Err(e) => {
                self.mark_merge_failed(
                    &lease.agent_id,
                    format!("secret rescan failed: {e}"),
                )?;
                return Err(e);
            }
        }

        // Step 2 (D20): attempt fast-forward merge.
        // We perform this from the source repo (not the worktree)
        // since the agent worktree is being closed out.
        let merge_out = Command::new("git")
            .args([
                "merge",
                "--ff-only",
                "--no-stat",
                lease.branch_ref.as_str(),
            ])
            .current_dir(&lease.repo_root)
            .output()?;
        if !merge_out.status.success() {
            let stderr = String::from_utf8_lossy(&merge_out.stderr).trim().to_string();
            // Fast-forward not possible — surface as MergeFailed for
            // human resolution. We do NOT try a non-FF merge
            // automatically (spec §6.2: human-in-the-loop on conflict).
            self.mark_merge_failed(
                &lease.agent_id,
                format!("fast-forward merge failed: {stderr}"),
            )?;
            return Err(MergeError::Conflict { stderr });
        }

        // Step 3: state advance Merging → Merged → Removed → GcDone.
        // Then remove from registry.
        let now = now_unix_secs();
        self.registry
            .update_state(&lease.agent_id, AgentState::Merged, now)?;

        // **H6 fix per codex3 P1**: remove the worktree FIRST, then
        // delete the branch. The agent branch is checked out in the
        // linked worktree; `git branch -D` would fail with "branch is
        // checked out at ..." if we deleted the branch first.
        //
        // **K3 fix per codex1 B3 + codex3 R2**: cleanup failures are
        // tracked and surfaced as `GcError` half-state if non-benign.
        // Previously they were tracing::warn and the lease still
        // advanced to GcDone + registry.remove → orphan branch/worktree
        // with no registry record. Now mirror the drainer's gc_lease
        // pattern: any non-benign cleanup failure leaves the lease in
        // GcError so the reaper or human can retry.
        let mut cleanup_failures: Vec<String> = Vec::new();
        if lease.worktree_path.as_path().exists() {
            let wt_out = Command::new("git")
                .args([
                    "worktree",
                    "remove",
                    "--force",
                    lease.worktree_path.as_path().to_string_lossy().as_ref(),
                ])
                .current_dir(&lease.repo_root)
                .output()?;
            if !wt_out.status.success() {
                let stderr = String::from_utf8_lossy(&wt_out.stderr).trim().to_string();
                if !stderr.contains("is not a working tree")
                    && !stderr.contains("No such file or directory")
                {
                    cleanup_failures.push(format!("git worktree remove: {stderr}"));
                }
            }
            // rmdir fallback
            if lease.worktree_path.as_path().exists() {
                if let Err(e) = std::fs::remove_dir_all(lease.worktree_path.as_path()) {
                    if lease.worktree_path.as_path().exists() {
                        cleanup_failures.push(format!("rm -rf worktree dir: {e}"));
                    }
                }
            }
        }
        // Now branch delete (worktree no longer holds it).
        let branch_out = Command::new("git")
            .args(["branch", "-D", lease.branch_ref.as_str()])
            .current_dir(&lease.repo_root)
            .output()?;
        if !branch_out.status.success() {
            let stderr = String::from_utf8_lossy(&branch_out.stderr)
                .trim()
                .to_string();
            if !stderr.contains("not found") && !stderr.contains("No such") {
                cleanup_failures.push(format!("git branch -D: {stderr}"));
            }
        }

        // K3: surface cleanup failures as GcError half-state so the
        // reaper or human can retry. Lease stays in registry.
        if !cleanup_failures.is_empty() {
            let reason = cleanup_failures.join("; ");
            tracing::warn!(
                target: "worktree::merge_queue",
                agent_id = %lease.agent_id,
                reason = %reason,
                "merge cleanup failed; lease → GcError for retry"
            );
            // Read prev retries (rev-4 F9 pattern)
            let prev_retries = match self.registry.get(&lease.agent_id) {
                Ok(Some(l)) => match l.state {
                    AgentState::GcError { retries, .. } => retries,
                    _ => 0,
                },
                _ => 0,
            };
            self.registry.mark_gc_error(
                &lease.agent_id,
                reason,
                prev_retries.saturating_add(1),
                now_unix_secs(),
            )?;
            crate::worktree::reaper::record_gc_error();
            return Ok(()); // Lease retained for retry; not an Err
        }

        self.registry
            .update_state(&lease.agent_id, AgentState::Removed, now_unix_secs())?;
        self.registry
            .update_state(&lease.agent_id, AgentState::GcDone, now_unix_secs())?;
        self.registry.remove(&lease.agent_id)?;
        Ok(())
    }

    /// D19 — retry a `MergeFailed` merge after the human has
    /// resolved the underlying issue (e.g., rebased the branch).
    pub fn retry_merge(&self, agent_id: &str) -> Result<()> {
        let lease = self.load_lease(agent_id)?;
        match lease.state {
            AgentState::MergeFailed { .. } => {
                self.registry
                    .update_state(agent_id, AgentState::Merging, now_unix_secs())?;
                self.execute_merge(&lease)
            }
            other => Err(MergeError::NotMergeable { state: other }),
        }
    }

    /// H8 — acquire the merge serialization flock at
    /// `<managed_root>/merge.lock`. Try-lock; if another merge is in
    /// progress this errors out. Caller can retry.
    fn acquire_merge_lock(&self) -> Result<MergeLockGuard> {
        let path = self.managed_root.as_path().join("merge.lock");
        let file = File::create(&path)?;
        match file.try_lock_exclusive() {
            Ok(()) => Ok(MergeLockGuard { _file: file }),
            Err(_) => Err(MergeError::Io(std::io::Error::other(
                "another merge is already in progress (merge.lock held)",
            ))),
        }
    }

    fn mark_merge_failed(&self, agent_id: &str, reason: String) -> Result<()> {
        let now = now_unix_secs();
        self.registry
            .update_state(agent_id, AgentState::MergeFailed { reason }, now)?;
        Ok(())
    }

    /// D22 — scan the agent's branch HEAD against the base for any
    /// content that matches the secret detector. Best-effort: only
    /// scans files <1MB (matching drainer's threshold) from the
    /// `git diff base...branch` set.
    fn scan_branch_for_secrets(
        &self,
        repo_root: &Path,
        base_ref: &str,
        branch_ref: &str,
    ) -> Result<usize> {
        let diff_files = Command::new("git")
            .args([
                "diff",
                "--name-only",
                "--diff-filter=AM",
                &format!("{base_ref}...{branch_ref}"),
            ])
            .current_dir(repo_root)
            .output()?;
        if !diff_files.status.success() {
            return Ok(0);
        }
        let mut hits = 0usize;
        for path in String::from_utf8_lossy(&diff_files.stdout).lines() {
            let path = path.trim();
            if path.is_empty() {
                continue;
            }
            // git show <branch>:<path> to get content at branch HEAD
            let content_out = Command::new("git")
                .args(["show", &format!("{branch_ref}:{path}")])
                .current_dir(repo_root)
                .output()?;
            if !content_out.status.success() {
                continue;
            }
            // Limit to 1MB per file
            if content_out.stdout.len() > 1024 * 1024 {
                continue;
            }
            if let Ok(s) = std::str::from_utf8(&content_out.stdout) {
                if looks_like_secret(s) {
                    hits += 1;
                }
            }
        }
        let _ = self.managed_root; // reserved for future audit-log writes
        Ok(hits)
    }

    fn load_lease(&self, agent_id: &str) -> Result<LeaseRecord> {
        self.registry
            .get(agent_id)?
            .ok_or_else(|| MergeError::Registry(RegistryStoreError::LeaseNotFound(agent_id.to_string())))
    }
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
    use crate::worktree::types::{
        AgentId, BranchRef, WorktreePath, REGISTRY_SCHEMA_VERSION,
    };

    fn init_repo() -> tempfile::TempDir {
        let tmp = tempfile::tempdir().unwrap();
        let repo = tmp.path();
        run_git(repo, &["init", "--initial-branch=main", "--quiet"]);
        run_git(repo, &["config", "user.email", "merge@example.invalid"]);
        run_git(repo, &["config", "user.name", "Merge Test"]);
        run_git(repo, &["config", "commit.gpgsign", "false"]);
        std::fs::write(repo.join("README.md"), "# initial\n").unwrap();
        run_git(repo, &["add", "README.md"]);
        run_git(repo, &["commit", "-m", "initial", "--quiet"]);
        tmp
    }

    fn run_git(repo: &Path, args: &[&str]) {
        let s = Command::new("git").args(args).current_dir(repo).status().unwrap();
        assert!(s.success(), "git {} failed", args.join(" "));
    }

    fn provision(
        managed_root: &ManagedRoot,
        repo: &Path,
        agent_id_str: &str,
    ) -> LeaseRecord {
        ensure_layout(managed_root).unwrap();
        let agent = AgentId::new(agent_id_str).unwrap();
        let branch = BranchRef::for_agent("sess", agent.as_str()).unwrap();
        let wt = WorktreePath::for_agent(managed_root, &agent);
        let base_commit = String::from_utf8_lossy(
            &Command::new("git")
                .args(["rev-parse", "HEAD"])
                .current_dir(repo)
                .output()
                .unwrap()
                .stdout,
        )
        .trim()
        .to_string();
        run_git(
            repo,
            &[
                "worktree",
                "add",
                "-b",
                branch.as_str(),
                wt.as_path().to_str().unwrap(),
                &base_commit,
            ],
        );
        std::fs::write(wt.as_path().join(".canvas-agent-nonce"), "n").unwrap();
        let lease = LeaseRecord {
            session_id: "sess".into(),
            agent_id: agent.as_str().into(),
            parent_agent_id: None,
            task_id: "task".into(),
            repo_root: repo.to_path_buf(),
            base_ref: "main".into(),
            base_commit,
            branch_ref: branch,
            worktree_path: wt,
            owner_pid: 1,
            owner_nonce: "n".into(),
            owner_start_time: None,
            process_group_id: None,
            heartbeat_at: now_unix_secs(),
            heartbeat_timeout_secs: 30,
            liveness_quiescent_secs: 60,
            wedge_grace_secs: 30,
            state: AgentState::MergeReady,
            artifact_path: None,
            last_error: None,
            last_reaper_id: None,
            created_at: now_unix_secs(),
            updated_at: now_unix_secs(),
            schema_version: REGISTRY_SCHEMA_VERSION,
        };
        Registry::new(managed_root.clone()).insert(lease.clone()).unwrap();
        lease
    }

    fn fresh_setup() -> (tempfile::TempDir, tempfile::TempDir, ManagedRoot, MergeQueue) {
        let mr_tmp = tempfile::tempdir().unwrap();
        let managed_root = ManagedRoot::new(mr_tmp.path()).unwrap();
        let repo_tmp = init_repo();
        let queue = MergeQueue::new(managed_root.clone());
        (mr_tmp, repo_tmp, managed_root, queue)
    }

    #[test]
    fn queue_merge_advances_to_merge_queued() {
        let (_mr, repo_tmp, mr, queue) = fresh_setup();
        let _lease = provision(&mr, repo_tmp.path(), "agent-A");
        queue.queue_merge("agent-A").unwrap();
        let lease_after = Registry::new(mr).get("agent-A").unwrap().unwrap();
        assert_eq!(lease_after.state, AgentState::MergeQueued);
    }

    #[test]
    fn approve_merge_fast_forwards_clean_branch() {
        let (_mr, repo_tmp, mr, queue) = fresh_setup();
        let lease = provision(&mr, repo_tmp.path(), "agent-A");
        // Make a commit on the agent branch that fast-forwards into main
        std::fs::write(lease.worktree_path.as_path().join("agent-work.txt"), "work\n").unwrap();
        run_git(lease.worktree_path.as_path(), &["add", "agent-work.txt"]);
        run_git(
            lease.worktree_path.as_path(),
            &["commit", "-m", "agent work", "--quiet"],
        );
        queue.queue_merge("agent-A").unwrap();
        queue.approve_merge("agent-A").unwrap();

        // Lease GC'd
        let registry = Registry::new(mr);
        assert!(registry.get("agent-A").unwrap().is_none());

        // main now has agent-work.txt
        assert!(repo_tmp.path().join("agent-work.txt").exists());
    }

    #[test]
    fn approve_merge_refuses_when_repo_on_wrong_branch() {
        // K4 — codex3 R3 regression test: H2 fix asserts that
        // execute_merge refuses to mutate ambient checkout state.
        // Provision agent with base_ref=main, switch source repo to
        // 'other', attempt approve_merge, assert MergeFailed AND main
        // is unchanged AND other is unchanged.
        let (_mr, repo_tmp, mr, queue) = fresh_setup();
        let lease = provision(&mr, repo_tmp.path(), "agent-A");
        // Make a commit on the agent branch
        std::fs::write(
            lease.worktree_path.as_path().join("agent-work.txt"),
            "work\n",
        )
        .unwrap();
        run_git(lease.worktree_path.as_path(), &["add", "agent-work.txt"]);
        run_git(
            lease.worktree_path.as_path(),
            &["commit", "-m", "agent work", "--quiet"],
        );

        // Create + check out a different branch in the source repo.
        run_git(repo_tmp.path(), &["checkout", "-b", "other-branch", "--quiet"]);
        // Make sure 'main' exists pristinely (not mutated)
        let main_head_before = String::from_utf8_lossy(
            &Command::new("git")
                .args(["rev-parse", "main"])
                .current_dir(repo_tmp.path())
                .output()
                .unwrap()
                .stdout,
        )
        .trim()
        .to_string();

        queue.queue_merge("agent-A").unwrap();
        let result = queue.approve_merge("agent-A");
        assert!(
            matches!(result, Err(MergeError::Conflict { .. })),
            "expected Conflict (refusal) when source repo on wrong branch"
        );

        // Lease in MergeFailed
        let lease_after = Registry::new(mr).get("agent-A").unwrap().unwrap();
        match lease_after.state {
            AgentState::MergeFailed { reason } => {
                assert!(
                    reason.contains("source repo is on")
                        && reason.contains("other-branch"),
                    "reason should mention current branch: {reason}"
                );
            }
            other => panic!("expected MergeFailed, got {other:?}"),
        }

        // main is unchanged
        let main_head_after = String::from_utf8_lossy(
            &Command::new("git")
                .args(["rev-parse", "main"])
                .current_dir(repo_tmp.path())
                .output()
                .unwrap()
                .stdout,
        )
        .trim()
        .to_string();
        assert_eq!(
            main_head_before, main_head_after,
            "main branch must not be mutated by wrong-branch merge attempt"
        );

        // other-branch did not absorb the agent's commit either
        let other_head_out = Command::new("git")
            .args(["log", "--oneline", "other-branch", "-1"])
            .current_dir(repo_tmp.path())
            .output()
            .unwrap();
        let other_head = String::from_utf8_lossy(&other_head_out.stdout);
        assert!(
            !other_head.contains("agent work"),
            "other-branch must not absorb agent commits: {other_head}"
        );
    }

    #[test]
    fn approve_merge_with_secret_in_diff_marks_merge_failed() {
        let (_mr, repo_tmp, mr, queue) = fresh_setup();
        let lease = provision(&mr, repo_tmp.path(), "agent-A");
        // Put a secret on the agent branch
        std::fs::write(
            lease.worktree_path.as_path().join("creds.txt"),
            "ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n",
        )
        .unwrap();
        run_git(lease.worktree_path.as_path(), &["add", "creds.txt"]);
        run_git(
            lease.worktree_path.as_path(),
            &["commit", "-m", "leak", "--quiet"],
        );
        queue.queue_merge("agent-A").unwrap();
        let result = queue.approve_merge("agent-A");
        assert!(matches!(result, Err(MergeError::SecretsDetected { count: 1 })));

        let lease_after = Registry::new(mr).get("agent-A").unwrap().unwrap();
        assert!(matches!(lease_after.state, AgentState::MergeFailed { .. }));
    }

    #[test]
    fn approve_merge_conflict_marks_merge_failed() {
        let (_mr, repo_tmp, mr, queue) = fresh_setup();
        let lease = provision(&mr, repo_tmp.path(), "agent-A");
        // Create a conflict: write to README.md in agent branch
        std::fs::write(lease.worktree_path.as_path().join("README.md"), "# agent\n").unwrap();
        run_git(lease.worktree_path.as_path(), &["add", "README.md"]);
        run_git(
            lease.worktree_path.as_path(),
            &["commit", "-m", "edit readme", "--quiet"],
        );
        // Diverge main: modify README.md on main too
        std::fs::write(repo_tmp.path().join("README.md"), "# main edit\n").unwrap();
        run_git(repo_tmp.path(), &["add", "README.md"]);
        run_git(
            repo_tmp.path(),
            &["commit", "-m", "main edit", "--quiet"],
        );

        queue.queue_merge("agent-A").unwrap();
        let result = queue.approve_merge("agent-A");
        assert!(matches!(result, Err(MergeError::Conflict { .. })));

        let lease_after = Registry::new(mr).get("agent-A").unwrap().unwrap();
        assert!(matches!(lease_after.state, AgentState::MergeFailed { .. }));
    }

    #[test]
    fn abort_merge_transitions_to_merge_aborted() {
        let (_mr, repo_tmp, mr, queue) = fresh_setup();
        let _lease = provision(&mr, repo_tmp.path(), "agent-A");
        queue.queue_merge("agent-A").unwrap();
        queue.abort_merge("agent-A", "user changed mind".into()).unwrap();
        let lease_after = Registry::new(mr).get("agent-A").unwrap().unwrap();
        assert!(matches!(lease_after.state, AgentState::MergeAborted { .. }));
    }

    #[test]
    fn query_state_returns_none_for_unknown_agent() {
        let (_mr, _repo_tmp, _, queue) = fresh_setup();
        assert!(queue.query_state("ghost").unwrap().is_none());
    }
}
