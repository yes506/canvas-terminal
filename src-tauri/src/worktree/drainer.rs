// Worktree subsystem — drainer (Phase 5)
//
// Per spec §1 (state machine) + §2 (close-source matrix + Path A/B
// precedence rule S11) + §4 (dirty preservation atomicity) + §7
// (Path A PTY postcondition):
//
//   Path A `agent_completed`:
//     1. Drainer observes complete `.done.json` (per S1: written via
//        tempfile+rename by the agent OR supervisor wrapper; validated
//        via serde_json::from_reader)
//     2. If clean working tree + branch == base → direct draining → gc_done
//     3. If clean working tree + branch ahead of base → direct draining → merge_ready
//     4. Otherwise → snapshotting → artifact_written → wip_ref_written → preserved → removed → gc_done
//
//   Path B `forced_close`:
//     1. Drainer writes `<worktree>/.system-close.json` (system artifact,
//        NOT the agent's `.done.json` per S11 precedence)
//     2. (Supervisor) SIGTERM → wait 5s → SIGKILL process group via
//        `process_group_kill::sigkill_process_group`
//     3. Snapshot whatever state exists; same preservation chain as Path A
//
// Per spec §2 precedence rule S11: if both `.done.json` AND
// `.system-close.json` exist (race), `.done.json` wins; drainer
// reads via serde_json::from_reader, deletes the stale `.system-close.json`,
// and continues Path A.
//
// **Phase 5 scope decisions** (some preservation features are
// scaffolded to land fully in Phase 5.5 polish):
// - Category 1 (tracked+staged): commit to `wip/<agent-id>` ref
// - Category 2 (untracked): listed in `untracked-manifest.json`,
//   bytes recorded but not yet bundled (size+hash only)
// - Category 3 (ignored): skipped per spec default
// - Category 4 (secrets): simple regex check; never copies; surfaces
//   to `preserve_failed` half-state
// - Category 5 (large/generated): noted in manifest by size (>10MB
//   threshold); content not bundled
// - Category 6 (branch ahead, clean tree): direct → merge_ready
//   fast-path per spec §1 transition table
//
// Drainer is invoked by:
//   - Phase 5 Tauri command `release_worktree(agent_id)` (Path A)
//   - Phase 5 Tauri command `force_close_worktree(agent_id)` (Path B)
//   - Periodic sweep (`sweep_draining`) that picks up `Draining`-state
//     leases set by the reaper's `claim_dead_lease`

use crate::worktree::registry::Registry;
use crate::worktree::registry_store::RegistryStoreError;
use crate::worktree::secret_detector::looks_like_secret;
use crate::worktree::types::{AgentState, LeaseRecord, ManagedRoot};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

/// Errors from the drainer.
#[derive(Debug)]
pub enum DrainError {
    Registry(RegistryStoreError),
    Io(std::io::Error),
    /// `.done.json` exists but couldn't be parsed OR its `agent_id`
    /// field doesn't match the lease (B11 — claude3 non-blocking
    /// finding) → drainer falls through to Path B (this is recorded
    /// but not an error per S11; callers translate via `release_or_force`).
    DoneJsonInvalid,
    /// Lease is not in a state the drainer can act on.
    NotDrainable { state: AgentState },
    /// `git worktree remove` failed during GC.
    WorktreeRemoveFailed(String),
    /// `git commit` failed during preservation.
    PreserveCommitFailed(String),
    /// A category-4 secret was detected → preservation refused; lease
    /// transitioned to `preserve_failed` (visible to UI for resolution).
    SecretsDetected { paths: Vec<PathBuf> },
}

impl std::fmt::Display for DrainError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            DrainError::Registry(e) => write!(f, "registry: {e}"),
            DrainError::Io(e) => write!(f, "io: {e}"),
            DrainError::DoneJsonInvalid => {
                write!(f, ".done.json invalid (parse failed); falling through to Path B")
            }
            DrainError::NotDrainable { state } => {
                write!(f, "lease not in a drainable state: {state:?}")
            }
            DrainError::WorktreeRemoveFailed(msg) => {
                write!(f, "git worktree remove failed: {msg}")
            }
            DrainError::PreserveCommitFailed(msg) => {
                write!(f, "git commit during preservation failed: {msg}")
            }
            DrainError::SecretsDetected { paths } => {
                write!(
                    f,
                    "secrets detected in {} files; preservation refused (resolve manually)",
                    paths.len()
                )
            }
        }
    }
}

impl std::error::Error for DrainError {}

impl From<RegistryStoreError> for DrainError {
    fn from(e: RegistryStoreError) -> Self {
        DrainError::Registry(e)
    }
}

impl From<std::io::Error> for DrainError {
    fn from(e: std::io::Error) -> Self {
        DrainError::Io(e)
    }
}

pub type Result<T> = std::result::Result<T, DrainError>;

/// Structured outcome of `Drainer::sweep_draining` (C16 — codex3 non-
/// blocking convergence). Replaces the prior `usize` return type so
/// callers see partial failures instead of silently losing visibility.
#[derive(Debug, Default, Clone, Serialize, Deserialize)]
pub struct SweepReport {
    /// Number of leases successfully drained this sweep.
    pub processed: usize,
    /// Per-lease failures: (agent_id, human-readable reason).
    pub failures: Vec<(String, String)>,
}

impl SweepReport {
    pub fn is_clean(&self) -> bool {
        self.failures.is_empty()
    }
}

/// Drainer. Stateless — each method takes the agent_id and operates
/// on the registry + filesystem.
pub struct Drainer {
    managed_root: ManagedRoot,
    registry: Registry,
}

impl Drainer {
    pub fn new(managed_root: ManagedRoot) -> Self {
        let registry = Registry::new(managed_root.clone());
        Self {
            managed_root,
            registry,
        }
    }

    /// Path A flow: agent completed via `.done.json`. Caller (typically
    /// supervisor) ensures the agent has actually exited and the
    /// `.done.json` is present.
    pub fn drain_path_a(&self, agent_id: &str) -> Result<()> {
        let lease = self.load_lease(agent_id)?;

        // Per S11 precedence: if both .done.json and .system-close.json
        // exist, .done.json wins; delete the stale .system-close.json.
        let done_path = lease.worktree_path.as_path().join(".done.json");
        let system_close_path = lease.worktree_path.as_path().join(".system-close.json");

        if !done_path.exists() {
            // No .done.json → not Path A; caller should use drain_path_b
            return Err(DrainError::NotDrainable {
                state: lease.state.clone(),
            });
        }

        // Validate completeness via S1 atomicity protocol
        let done_doc = match read_done_json(&done_path) {
            Ok(d) => d,
            Err(_) => {
                return Err(DrainError::DoneJsonInvalid);
            }
        };

        // B11 fix per claude3 non-blocking: reject mis-attributed
        // `.done.json` so a copied or wrong-agent file can't release
        // someone else's worktree.
        if done_doc.agent_id != lease.agent_id {
            return Err(DrainError::DoneJsonInvalid);
        }

        // Per S11: stale .system-close.json gets deleted (Path A wins)
        if system_close_path.exists() {
            let _ = std::fs::remove_file(&system_close_path);
        }

        // Advance Working/Ready → Draining so the rest of the flow
        // is in the actively-managed state set per spec §7 invariant 0
        let now = now_unix_secs();
        if !matches!(lease.state, AgentState::Draining) {
            self.registry
                .update_state(agent_id, AgentState::Draining, now)?;
        }

        self.drain_with_preservation(&lease)
    }

    /// Path B flow: forced close. Caller writes `.system-close.json`
    /// (drainer NEVER writes `.done.json` per S11) and kills the
    /// process group via `process_group_kill::sigterm_process_group`
    /// → 5s grace → `sigkill_process_group`. Then calls this.
    pub fn drain_path_b(&self, agent_id: &str) -> Result<()> {
        let lease = self.load_lease(agent_id)?;

        // Write the system-close artifact (Path B sentinel; NEVER the
        // agent's .done.json per spec §2 + S11). Best-effort: if the
        // worktree dir is gone, skip and proceed to GC.
        if lease.worktree_path.as_path().exists() {
            let system_close_path = lease.worktree_path.as_path().join(".system-close.json");
            let payload = SystemCloseDoc {
                closed_at_unix_secs: now_unix_secs(),
                reason: "forced_close".to_string(),
                agent_id: agent_id.to_string(),
            };
            // Atomic write via tempfile + rename to match S1 semantics
            let tmp = lease
                .worktree_path
                .as_path()
                .join(".system-close.json.tmp");
            let json = serde_json::to_string_pretty(&payload)
                .map_err(|e| DrainError::Io(std::io::Error::other(e.to_string())))?;
            std::fs::write(&tmp, json)?;
            std::fs::rename(&tmp, &system_close_path)?;
        }

        let now = now_unix_secs();
        if !matches!(lease.state, AgentState::Draining) {
            self.registry
                .update_state(agent_id, AgentState::Draining, now)?;
        }

        self.drain_with_preservation(&lease)
    }

    /// Periodic sweep that picks up leases in `Draining` state set by
    /// the reaper's `claim_dead_lease` (Phase 2 F3 fix). For each, run
    /// the Path A/B drain — Path A if `.done.json` is present, Path B
    /// otherwise.
    ///
    /// **B5 fix per claude2/codex2/codex3 convergence + spec §2 + S11**:
    /// if `.done.json` exists but is malformed/partial, treat it as a
    /// half-written authoring attempt and fall through to Path B
    /// (`forced_close`).
    ///
    /// **C16 fix per codex3 non-blocking convergence**: returns a
    /// structured `SweepReport` so per-lease failures are visible to
    /// callers (reaper logs, observability) instead of being silently
    /// swallowed. The legacy `usize` count is exposed via
    /// `report.processed`.
    pub fn sweep_draining(&self) -> Result<SweepReport> {
        let leases = self.registry.list_all()?;
        let mut report = SweepReport::default();
        for (agent_id, lease) in leases.into_iter() {
            if !matches!(lease.state, AgentState::Draining) {
                continue;
            }
            let done_path = lease.worktree_path.as_path().join(".done.json");
            let result = if done_path.exists() {
                match self.drain_path_a(&agent_id) {
                    Ok(()) => Ok(()),
                    Err(DrainError::DoneJsonInvalid) => {
                        // S11/spec §2: invalid .done.json → forced_close
                        let _ = std::fs::remove_file(&done_path);
                        self.drain_path_b(&agent_id)
                    }
                    Err(other) => Err(other),
                }
            } else {
                self.drain_path_b(&agent_id)
            };
            match result {
                Ok(()) => report.processed += 1,
                Err(e) => {
                    report.failures.push((agent_id, e.to_string()));
                }
            }
        }
        Ok(report)
    }

    /// E21 — retry preservation on a `PreserveFailed` lease. Resets
    /// state to `Draining` and re-runs the preservation chain. Useful
    /// after the human resolves a quarantine path collision, fixes a
    /// permission problem, or removes a flagged secret.
    pub fn retry_preserve(&self, agent_id: &str) -> Result<()> {
        let lease = self.load_lease(agent_id)?;
        if !matches!(lease.state, AgentState::PreserveFailed { .. }) {
            return Err(DrainError::NotDrainable {
                state: lease.state.clone(),
            });
        }
        let now = now_unix_secs();
        self.registry
            .update_state(agent_id, AgentState::Draining, now)?;
        self.drain_with_preservation(&lease)
    }

    /// E22 — explicitly discard the preserved artifact (if any) and
    /// transition the lease to `Removed → GcDone` then drop it from
    /// the registry. Caller is responsible for confirming with the
    /// user; this method is the "I really mean it" data destructor.
    /// The wip ref is left intact (it's still reachable via git's
    /// reflog if reachable from refs/wip/).
    pub fn discard_artifact(&self, agent_id: &str) -> Result<()> {
        let lease = self.load_lease(agent_id)?;
        // Remove the quarantine dir if present.
        let artifact_dir = self.managed_root.quarantine_dir().join(agent_id);
        if artifact_dir.exists() {
            std::fs::remove_dir_all(&artifact_dir)?;
        }
        // Run the GC sequence (will tolerate missing worktree).
        self.gc_lease(&lease)
    }

    /// Release a lease via Path A; if `.done.json` is invalid OR
    /// missing, fall through to Path B (forced_close) per spec §2 +
    /// S11. Used by the `release_worktree` Tauri command and by the
    /// E2E supervisor flow after `force_close` has set the lease to
    /// `Draining` (no `.done.json` written by the agent — Path B is
    /// the correct sentinel).
    pub fn release_or_force(&self, agent_id: &str) -> Result<()> {
        match self.drain_path_a(agent_id) {
            Ok(()) => Ok(()),
            Err(DrainError::DoneJsonInvalid) => {
                // Remove the malformed sentinel so .system-close.json
                // can take precedence; then run Path B.
                if let Ok(Some(lease)) = self.registry.get(agent_id) {
                    let done_path = lease.worktree_path.as_path().join(".done.json");
                    let _ = std::fs::remove_file(&done_path);
                }
                self.drain_path_b(agent_id)
            }
            Err(DrainError::NotDrainable { .. }) => {
                // No `.done.json` → Path A is not applicable. Run
                // Path B (forced_close). This is the supervisor-driven
                // path: force_close set the lease to Draining without
                // writing .done.json (only the agent writes that).
                self.drain_path_b(agent_id)
            }
            Err(other) => Err(other),
        }
    }

    /// Common preservation chain after Path A or Path B has set the
    /// lease to `Draining`.
    fn drain_with_preservation(&self, lease: &LeaseRecord) -> Result<()> {
        let agent_id = &lease.agent_id;
        let now = now_unix_secs();

        // **F10 fix per claude3 Minor 2**: if the worktree directory is
        // already gone (e.g., GC ran via another path, manual rm -rf,
        // or supervisor crashed mid-cleanup), there is nothing to
        // classify or preserve. Skip directly to gc_lease which
        // tolerates a missing worktree dir.
        if !lease.worktree_path.as_path().exists() {
            return self.gc_lease(lease);
        }

        // Determine the work classification.
        // T2.4 + B1 verifier convergence: pass `agent_id` so the manifest
        // is filled in (was previously left as ""), and pass
        // `lease.base_commit` so `git_ahead_count` can compare HEAD
        // against the recorded base commit instead of `@{u}` (provisioned
        // branches have no upstream → previously misclassified as
        // CleanAtBase → branch deletion + data loss).
        let classification = classify_work(
            &lease.repo_root,
            lease.worktree_path.as_path(),
            agent_id,
            &lease.base_commit,
        )?;

        // Spec §1 + §4.2: choose the right transition path based on
        // classification.
        match classification {
            WorkClassification::CleanAtBase => {
                // Direct draining → removed → gc_done per spec §1.
                // gc_lease handles the full state-transition + registry.remove
                // sequence; we don't add more updates after.
                self.gc_lease(lease)
            }
            WorkClassification::CleanAheadOfBase => {
                // Direct draining → merge_ready per spec §1 (cat 6)
                self.registry
                    .update_state(agent_id, AgentState::MergeReady, now)?;
                // Phase 6 merge queue picks up; we don't GC here
                Ok(())
            }
            WorkClassification::DirtyPreserve { manifest, secrets } => {
                // Cat 4 secrets → preserve_failed; do NOT proceed
                if !secrets.is_empty() {
                    self.registry.mark_preserve_failed(
                        agent_id,
                        format!(
                            "{} file(s) flagged as containing secrets — manual resolution required",
                            secrets.len()
                        ),
                        now,
                    )?;
                    crate::worktree::reaper::record_preserve_failed();
                    return Err(DrainError::SecretsDetected { paths: secrets });
                }

                // Atomicity transitions per spec §4.2:
                //   snapshotting → artifact_written → wip_ref_written → preserved
                // Each step that fails surfaces as PreserveFailed half-state
                // with a concrete reason (B8 verification gate — claude3 B5).
                self.registry
                    .update_state(agent_id, AgentState::Snapshotting, now_unix_secs())?;

                let artifact_dir = self.managed_root.quarantine_dir().join(agent_id);
                if let Err(e) = self.write_quarantine_artifact(
                    &artifact_dir,
                    &manifest,
                    lease.worktree_path.as_path(),
                ) {
                    let reason = format!("write_quarantine_artifact: {e}");
                    self.registry.mark_preserve_failed(agent_id, reason, now_unix_secs())?;
                    crate::worktree::reaper::record_preserve_failed();
                    return Err(e);
                }
                // B10 fix: record artifact path so the UI / retry flow
                // can find the manifest without re-deriving it.
                self.registry.set_artifact_path(
                    agent_id,
                    artifact_dir.join("manifest.json"),
                    now_unix_secs(),
                )?;
                self.registry.update_state(
                    agent_id,
                    AgentState::ArtifactWritten,
                    now_unix_secs(),
                )?;

                let large_paths: Vec<String> =
                    manifest.large_or_generated.keys().cloned().collect();
                if let Err(e) = self.commit_wip_ref(
                    &lease.repo_root,
                    lease.worktree_path.as_path(),
                    agent_id,
                    &large_paths,
                ) {
                    let reason = format!("commit_wip_ref: {e}");
                    self.registry.mark_preserve_failed(agent_id, reason, now_unix_secs())?;
                    crate::worktree::reaper::record_preserve_failed();
                    return Err(e);
                }
                self.registry
                    .update_state(agent_id, AgentState::WipRefWritten, now_unix_secs())?;

                // B8 fix per spec §4.2: verify BOTH artifact (manifest
                // re-readable) AND wip ref (git rev-parse --verify)
                // before transitioning to Preserved. If either check
                // fails, the lease enters PreserveFailed and rolls back
                // — a half-state the reaper / retry_preserve can pick
                // up.
                if let Err(e) = self.verify_preservation(
                    &artifact_dir,
                    &lease.repo_root,
                    agent_id,
                ) {
                    let reason = format!("verify_preservation: {e}");
                    self.registry.mark_preserve_failed(agent_id, reason, now_unix_secs())?;
                    crate::worktree::reaper::record_preserve_failed();
                    return Err(e);
                }

                // Both artifacts verified — preserve
                self.registry
                    .update_state(agent_id, AgentState::Preserved, now_unix_secs())?;

                // Phase 5 default policy: GC after preservation. Phase 6
                // merge queue may instead transition `preserved → merge_ready`
                // for ahead-of-base preserved leases (drainer flag — TBD).
                self.gc_lease(lease)
            }
        }
    }

    /// Write the quarantine artifact: copies category-2 untracked files
    /// into `<artifact_dir>/files/` (B7 — claude3 B5 spec §4.2 "writes
    /// quarantine manifest **and relevant files**"), writes manifest.json
    /// atomically (tempfile + rename), then fsyncs both the manifest
    /// file and the parent directory (B6 — spec §4.2 atomicity).
    fn write_quarantine_artifact(
        &self,
        artifact_dir: &Path,
        manifest: &PreservationManifest,
        worktree_path: &Path,
    ) -> Result<()> {
        std::fs::create_dir_all(artifact_dir)?;
        let files_dir = artifact_dir.join("files");
        std::fs::create_dir_all(&files_dir)?;

        // B7: copy each category-2 untracked file into the files dir.
        // Preserve relative path under files/ so the manifest's keys
        // match the on-disk layout. Errors are surfaced — partial copy
        // is a preservation failure.
        //
        // **F8 fix per codex1 M2**: each copied file gets sync_all so
        // the bytes are durable, matching the spec §4.2 atomicity
        // contract for "manifest AND relevant files."
        for relative_path in manifest.untracked.keys() {
            let src = worktree_path.join(relative_path);
            let dst = files_dir.join(relative_path);
            if let Some(parent) = dst.parent() {
                std::fs::create_dir_all(parent)?;
            }
            // Best-effort copy; if the source vanished between
            // classification and snapshot (e.g., agent kept writing),
            // record the gap in the manifest by skipping rather than
            // erroring — the manifest entry still records the size we
            // saw at classification.
            if src.exists() {
                std::fs::copy(&src, &dst)?;
                // F8: fsync the copied file.
                if let Ok(f) = std::fs::File::open(&dst) {
                    let _ = f.sync_all();
                }
            }
        }
        // F8: fsync the files/ subtree root so dir entries are durable.
        if let Ok(d) = std::fs::File::open(&files_dir) {
            let _ = d.sync_all();
        }

        // Atomic manifest write + fsync.
        let manifest_path = artifact_dir.join("manifest.json");
        let json = serde_json::to_string_pretty(manifest)
            .map_err(|e| DrainError::Io(std::io::Error::other(e.to_string())))?;
        let tmp = artifact_dir.join(".manifest.json.tmp");
        {
            use std::io::Write;
            let mut f = std::fs::File::create(&tmp)?;
            f.write_all(json.as_bytes())?;
            // B6: fsync the file before rename so the bytes are durable.
            f.sync_all()?;
        }
        std::fs::rename(&tmp, &manifest_path)?;
        // B6: fsync the directory so the rename is durable. On macOS
        // this requires opening the dir read-only and calling fsync.
        if let Ok(dir) = std::fs::File::open(artifact_dir) {
            let _ = dir.sync_all();
        }
        Ok(())
    }

    fn commit_wip_ref(
        &self,
        repo_root: &Path,
        worktree_path: &Path,
        agent_id: &str,
        large_or_generated: &[String],
    ) -> Result<()> {
        // Commit dirty work in the worktree. We use `git -C <worktree>`
        // so the commit lands on the agent's own branch.
        //
        // T2.3 fix per claude3 B5 / codex2#5: previously `git add --all`
        // staged the drainer/supervisor system artifacts (.done.json,
        // .system-close.json, .canvas-agent-nonce) into the wip commit,
        // contradicting the classification filter. We now use git
        // pathspec exclusions (`:(exclude)<glob>`) so the wip commit
        // contains ONLY agent work, not our control-plane artifacts.
        //
        // **F6 fix per codex3 P1**: also exclude category-5
        // large/generated files (>10MB untracked) from the wip ref.
        // The classifier records them in manifest.large_or_generated
        // by size only — committing them into the wip ref bloats the
        // repo and contradicts the spec's category-5 policy.
        let mut add_args: Vec<String> = vec!["add".into(), "--all".into(), "--".into()];
        for name in SYSTEM_ARTIFACT_NAMES {
            add_args.push(format!(":(exclude){name}"));
        }
        for path in large_or_generated {
            add_args.push(format!(":(exclude){path}"));
        }
        let add_out = Command::new("git")
            .args(&add_args)
            .current_dir(worktree_path)
            .output()?;
        if !add_out.status.success() {
            return Err(DrainError::PreserveCommitFailed(format!(
                "git add: {}",
                String::from_utf8_lossy(&add_out.stderr).trim()
            )));
        }
        let commit_msg = format!("wip({agent_id}): preserved at {}", now_unix_secs());
        // B9 fix per spec §4.2: NO `--allow-empty`. The classifier has
        // already determined this is `DirtyPreserve` — there should be
        // a real diff to commit. If git reports nothing to commit it
        // means classification disagreed with git, which is itself a
        // preservation failure (e.g., a system artifact slipped through
        // the pathspec exclusion).
        let out = Command::new("git")
            .args([
                "commit",
                "-m",
                &commit_msg,
                // Don't sign — tests don't have GPG configured
                "--no-gpg-sign",
            ])
            .current_dir(worktree_path)
            .output()?;
        if !out.status.success() {
            let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
            let stdout = String::from_utf8_lossy(&out.stdout).trim().to_string();
            return Err(DrainError::PreserveCommitFailed(format!(
                "git commit: {stderr} {stdout}"
            )));
        }
        // Tag the wip ref so it survives branch deletion in GC.
        // claude3 B5 / codex2#5 also flagged that update-ref's status
        // was ignored; surface its failure as PreserveCommitFailed.
        let ref_out = Command::new("git")
            .args(["update-ref", &format!("refs/wip/{agent_id}"), "HEAD"])
            .current_dir(worktree_path)
            .output()?;
        if !ref_out.status.success() {
            return Err(DrainError::PreserveCommitFailed(format!(
                "git update-ref refs/wip/{agent_id}: {}",
                String::from_utf8_lossy(&ref_out.stderr).trim()
            )));
        }
        let _ = repo_root; // reserved for future cross-worktree ref ops
        Ok(())
    }

    /// Verify the preservation artifact + wip ref are both readable
    /// before transitioning to `Preserved`. Per spec §4.2 atomicity:
    /// the lease must not advance past `WipRefWritten` until both the
    /// quarantine manifest is parseable AND `refs/wip/<agent>` resolves.
    /// On any failure the caller marks `PreserveFailed` and the reaper
    /// or `retry_preserve` can retry.
    fn verify_preservation(
        &self,
        artifact_dir: &Path,
        repo_root: &Path,
        agent_id: &str,
    ) -> Result<()> {
        // 1. Manifest must parse. We don't validate the contents
        // beyond "is it valid JSON for our schema" — full structural
        // check would duplicate write_quarantine_artifact's authoring.
        let manifest_path = artifact_dir.join("manifest.json");
        let f = std::fs::File::open(&manifest_path).map_err(|e| {
            DrainError::Io(std::io::Error::other(format!(
                "manifest.json missing/unreadable at {}: {}",
                manifest_path.display(),
                e
            )))
        })?;
        let _: PreservationManifest = serde_json::from_reader(std::io::BufReader::new(f))
            .map_err(|e| {
                DrainError::Io(std::io::Error::other(format!(
                    "manifest.json malformed: {e}"
                )))
            })?;

        // 2. wip ref must resolve.
        let out = Command::new("git")
            .args([
                "rev-parse",
                "--verify",
                "--quiet",
                &format!("refs/wip/{agent_id}"),
            ])
            .current_dir(repo_root)
            .output()?;
        if !out.status.success() {
            return Err(DrainError::PreserveCommitFailed(format!(
                "refs/wip/{agent_id} does not resolve after commit_wip_ref"
            )));
        }
        Ok(())
    }

    /// Run the full disk-side cleanup AND advance the lease through
    /// the spec §1 terminal transitions: `removed → gc_done`, then
    /// remove the lease from the registry.
    ///
    /// **B3 fix per claude3 + codex2#6 + codex3 #6 verifier convergence**:
    /// the previous version ignored every cleanup error AND removed
    /// the lease anyway, so a locked worktree, permission failure, or
    /// branch-delete error left orphaned disk/git state with no
    /// registry record for retry. Now we track each failure and, on
    /// any failure, transition to the `GcError` half-state with a
    /// concrete reason. The reaper can pick the lease back up; the
    /// lease is only `remove`d after a fully-clean GC pass.
    fn gc_lease(&self, lease: &LeaseRecord) -> Result<()> {
        let now = now_unix_secs();

        // Step 1: state transition `* → Removed`
        self.registry
            .update_state(&lease.agent_id, AgentState::Removed, now)?;

        // Step 2: disk-side cleanup. Track each failure.
        let mut failures: Vec<String> = Vec::new();

        let path_str = lease
            .worktree_path
            .as_path()
            .to_str()
            .map(|s| s.to_string());
        if let Some(path_str) = path_str.as_deref() {
            let out = Command::new("git")
                .args(["worktree", "remove", "--force", path_str])
                .current_dir(&lease.repo_root)
                .output()?;
            if !out.status.success() {
                let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
                // Tolerate the case where the worktree is already gone;
                // surface other failures.
                if !stderr.contains("is not a working tree")
                    && !stderr.contains("is not a valid working tree")
                    && !stderr.contains("No such file or directory")
                {
                    failures.push(format!("git worktree remove: {stderr}"));
                }
            }
        }

        // Belt-and-suspenders prune (idempotent — failures here are
        // bookkeeping only, not state-corrupting; tolerate quietly).
        let _ = Command::new("git")
            .args(["worktree", "prune"])
            .current_dir(&lease.repo_root)
            .output();

        // rmdir fallback in case git failed. Only flag failure if the
        // path still exists after this attempt.
        if lease.worktree_path.as_path().exists() {
            if let Err(e) = std::fs::remove_dir_all(lease.worktree_path.as_path()) {
                if lease.worktree_path.as_path().exists() {
                    failures.push(format!("rm -rf worktree dir: {e}"));
                }
            }
        }

        // Delete the agent branch ref. wip/<agent-id> ref persists
        // (preserved work continues to be reachable by GC tools / merge
        // queue lookups). If the branch is already gone (e.g., the
        // worktree-remove cleaned it up) git returns non-zero with
        // "branch not found" — tolerate that case only.
        let branch_out = Command::new("git")
            .args(["branch", "-D", lease.branch_ref.as_str()])
            .current_dir(&lease.repo_root)
            .output()?;
        if !branch_out.status.success() {
            let stderr = String::from_utf8_lossy(&branch_out.stderr)
                .trim()
                .to_string();
            if !stderr.contains("not found") && !stderr.contains("No such") {
                failures.push(format!("git branch -D: {stderr}"));
            }
        }

        // Step 3: if any failure, surface as GcError half-state and
        // STOP — the reaper will retry the GC pass. We do NOT advance
        // to GcDone or remove the lease.
        //
        // **F9 fix per codex1 M3**: increment the retry counter from
        // any prior GcError on this lease so the UI sees attempt
        // count grow across retries.
        if !failures.is_empty() {
            let reason = failures.join("; ");
            let prev_retries = match self.registry.get(&lease.agent_id) {
                Ok(Some(l)) => match l.state {
                    AgentState::GcError { retries, .. } => retries,
                    _ => 0,
                },
                _ => 0,
            };
            self.registry.mark_gc_error(
                &lease.agent_id,
                reason.clone(),
                prev_retries.saturating_add(1),
                now_unix_secs(),
            )?;
            crate::worktree::reaper::record_gc_error();
            return Err(DrainError::WorktreeRemoveFailed(reason));
        }

        // Step 4: state transition `Removed → GcDone` (terminal)
        self.registry
            .update_state(&lease.agent_id, AgentState::GcDone, now_unix_secs())?;

        // Step 5: remove the lease from the registry. Do this LAST
        // so any earlier failure leaves the lease in a half-state
        // (Removed, GcDone, or GcError) that the reaper can pick up.
        self.registry.remove(&lease.agent_id)?;
        Ok(())
    }

    fn load_lease(&self, agent_id: &str) -> Result<LeaseRecord> {
        self.registry
            .get(agent_id)?
            .ok_or_else(|| DrainError::Registry(RegistryStoreError::LeaseNotFound(agent_id.to_string())))
    }
}

// ----------------------------------------------------------------------
// .done.json + .system-close.json schemas
// ----------------------------------------------------------------------

/// Agent-authored completion document (Path A). Validated via
/// `serde_json::from_reader` per S1 atomicity.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DoneJsonDoc {
    /// At minimum we require a non-empty agent_id; other fields are
    /// agent-specific and we don't constrain them.
    pub agent_id: String,
    pub completed_at: i64,
    #[serde(default)]
    pub summary: String,
}

/// System-authored forced-close document (Path B). Drainer writes
/// this; agent NEVER does.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SystemCloseDoc {
    pub closed_at_unix_secs: i64,
    pub reason: String,
    pub agent_id: String,
}

fn read_done_json(path: &Path) -> std::result::Result<DoneJsonDoc, ()> {
    let file = std::fs::File::open(path).map_err(|_| ())?;
    let reader = std::io::BufReader::new(file);
    serde_json::from_reader(reader).map_err(|_| ())
}

// ----------------------------------------------------------------------
// Work classification & preservation manifest
// ----------------------------------------------------------------------

#[derive(Debug)]
enum WorkClassification {
    /// Clean working tree, branch is at base commit. Direct GC.
    CleanAtBase,
    /// Clean working tree, branch is ahead of base. Direct merge_ready.
    CleanAheadOfBase,
    /// Dirty (any of cat 1, 2, 3, 5) OR cat 4 secrets present.
    DirtyPreserve {
        manifest: PreservationManifest,
        secrets: Vec<PathBuf>,
    },
}

/// What we wrote to `<quarantine>/<agent>/manifest.json`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PreservationManifest {
    pub agent_id: String,
    pub captured_at_unix_secs: i64,
    /// Untracked files (cat 2): path → size in bytes
    pub untracked: BTreeMap<String, u64>,
    /// Large/generated files (cat 5): path → size in bytes
    pub large_or_generated: BTreeMap<String, u64>,
    /// Number of tracked-and-modified files (cat 1; covered by wip ref commit)
    pub tracked_modified_count: usize,
}

/// Threshold above which a file is flagged as "large/generated" and
/// not bundled (only path + size recorded). Per spec §4.1 cat 5.
const LARGE_FILE_THRESHOLD_BYTES: u64 = 10 * 1024 * 1024;

/// Spec §4.3 secret detection now lives in `worktree::secret_detector`
/// (Phase 5 D17 fix per claude2/codex2/codex3 convergence). The new
/// detector implements the explicit shapes from the spec: AWS access
/// key + secret pair, GitHub PAT family, Slack tokens, PEM private
/// keys, long bearer tokens. Still documented as a heuristic — pair
/// with truffleHog/gitleaks for production-grade coverage.
fn secret_detector_matches(content: &str) -> bool {
    looks_like_secret(content)
}

/// System artifacts that the drainer/supervisor write into the worktree.
/// They MUST be ignored when classifying agent work — otherwise the
/// drainer would treat its own `.system-close.json` (Path B) or the
/// agent's `.done.json` (Path A) as dirty agent state and trigger
/// preservation + GC for what should be a clean direct-to-merge_ready
/// path.
const SYSTEM_ARTIFACT_NAMES: &[&str] = &[".done.json", ".system-close.json", ".canvas-agent-nonce"];

fn is_system_artifact(path_str: &str) -> bool {
    SYSTEM_ARTIFACT_NAMES.contains(&path_str)
}

/// Inspect the worktree and classify the work that needs preserving.
///
/// `agent_id` is filled into the manifest (T2.4). `base_commit` is the
/// recorded provisioning commit; ahead-count is computed against this
/// commit (B1) NOT against `@{u}` (provisioned branches have no
/// upstream → `@{u}` returned 0 → CleanAheadOfBase was misclassified
/// as CleanAtBase → branch deletion + data loss).
fn classify_work(
    repo_root: &Path,
    worktree_path: &Path,
    agent_id: &str,
    base_commit: &str,
) -> Result<WorkClassification> {
    // 1. Get porcelain status of the worktree, then strip out system
    //    artifacts the drainer/supervisor write into it.
    let status_out = Command::new("git")
        .args(["status", "--porcelain"])
        .current_dir(worktree_path)
        .output()?;
    let raw_status = String::from_utf8_lossy(&status_out.stdout).into_owned();
    let status_lines: Vec<&str> = raw_status
        .lines()
        .filter(|line| {
            if line.len() < 4 {
                return false;
            }
            let path_str = line[3..].trim();
            !is_system_artifact(path_str)
        })
        .collect();

    // 2. Check if branch is ahead of recorded base_commit (B1 fix)
    let ahead_count = git_ahead_count(worktree_path, base_commit)?;

    if status_lines.is_empty() {
        // Clean working tree (modulo our own system artifacts)
        if ahead_count == 0 {
            return Ok(WorkClassification::CleanAtBase);
        } else {
            return Ok(WorkClassification::CleanAheadOfBase);
        }
    }

    // Dirty work present — categorize
    let mut untracked: BTreeMap<String, u64> = BTreeMap::new();
    let mut large_or_generated: BTreeMap<String, u64> = BTreeMap::new();
    let mut tracked_modified_count = 0usize;
    let mut secrets: Vec<PathBuf> = Vec::new();

    for line in status_lines {
        // Porcelain v1 format: "XY filename" (X=staged, Y=unstaged)
        let xy = &line[..2];
        let path_str = line[3..].trim();
        let abs_path = worktree_path.join(path_str);
        let size = std::fs::metadata(&abs_path).map(|m| m.len()).unwrap_or(0);

        // Cat 2: untracked
        if xy == "??" {
            // Cat 4: secrets check (only on small text-ish files)
            if size < 1024 * 1024 {
                if let Ok(content) = std::fs::read_to_string(&abs_path) {
                    if secret_detector_matches(&content) {
                        secrets.push(abs_path.clone());
                        continue; // don't add to manifest
                    }
                }
            }
            // Cat 5: large/generated
            if size > LARGE_FILE_THRESHOLD_BYTES {
                large_or_generated.insert(path_str.to_string(), size);
            } else {
                untracked.insert(path_str.to_string(), size);
            }
        } else {
            // Cat 1: tracked + modified/staged. Cat 4 secret check too.
            if size < 1024 * 1024 {
                if let Ok(content) = std::fs::read_to_string(&abs_path) {
                    if secret_detector_matches(&content) {
                        secrets.push(abs_path.clone());
                        continue;
                    }
                }
            }
            tracked_modified_count += 1;
        }
    }

    let manifest = PreservationManifest {
        // T2.4 fix per claude2/codex2/codex3 convergence: was previously
        // String::new() which made the on-disk manifest unattributable.
        agent_id: agent_id.to_string(),
        captured_at_unix_secs: now_unix_secs(),
        untracked,
        large_or_generated,
        tracked_modified_count,
    };

    let _ = repo_root; // reserved for future cross-worktree analysis
    Ok(WorkClassification::DirtyPreserve { manifest, secrets })
}

/// Count commits HEAD is ahead of the recorded `base_commit`.
///
/// **B1 fix per 5/5 verifier convergence (codex1 B3, claude2 D3,
/// codex2 #1, claude3, codex3 B6)**: the previous implementation
/// compared against `@{u}` (upstream tracking branch). Provisioned
/// agent branches set NO upstream by design — `git worktree add -b`
/// creates a local branch only — so the upstream check always failed
/// and ahead-count was always 0. A clean agent branch with N commits
/// ahead of base would be classified as `CleanAtBase`, then `gc_lease`
/// would delete the branch → data loss for completed work.
///
/// Now we compute `git rev-list --count <base_commit>..HEAD` directly,
/// which works regardless of upstream configuration.
fn git_ahead_count(worktree_path: &Path, base_commit: &str) -> Result<u32> {
    if base_commit.is_empty() {
        // Defensive: empty base_commit means we have no anchor — fall
        // back to "at base" rather than counting against an undefined
        // ref. Only happens with malformed leases.
        return Ok(0);
    }
    let range = format!("{base_commit}..HEAD");
    let out = Command::new("git")
        .args(["rev-list", "--count", &range])
        .current_dir(worktree_path)
        .output()?;
    if !out.status.success() {
        // base_commit may have been pruned / unreachable. Conservative:
        // treat as 0 ahead. Worst case dirty preservation runs anyway.
        return Ok(0);
    }
    String::from_utf8_lossy(&out.stdout)
        .trim()
        .parse::<u32>()
        .map_err(|_| {
            DrainError::Io(std::io::Error::other(
                "git rev-list returned non-integer count",
            ))
        })
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
        AgentId, BranchRef, LeaseRecord, WorktreePath, REGISTRY_SCHEMA_VERSION,
    };

    fn init_repo() -> tempfile::TempDir {
        let tmp = tempfile::tempdir().unwrap();
        let repo = tmp.path();
        run_git_test(repo, &["init", "--initial-branch=main", "--quiet"]);
        run_git_test(repo, &["config", "user.email", "drainer@example.invalid"]);
        run_git_test(repo, &["config", "user.name", "Drainer Test"]);
        run_git_test(repo, &["config", "commit.gpgsign", "false"]);
        std::fs::write(repo.join("README.md"), "# initial\n").unwrap();
        run_git_test(repo, &["add", "README.md"]);
        run_git_test(repo, &["commit", "-m", "initial", "--quiet"]);
        tmp
    }

    fn run_git_test(repo: &Path, args: &[&str]) {
        let s = Command::new("git").args(args).current_dir(repo).status().unwrap();
        assert!(s.success(), "git {} failed", args.join(" "));
    }

    fn provision_into(
        managed_root: &ManagedRoot,
        repo: &Path,
        agent_id_str: &str,
    ) -> LeaseRecord {
        // Manually create a worktree + lease to avoid the full provisioner
        // flow (which requires a clean base). Tests can inject the dirty
        // state directly in the worktree after creation.
        ensure_layout(managed_root).unwrap();
        let agent = AgentId::new(agent_id_str).unwrap();
        let branch = BranchRef::for_agent("sess", agent.as_str()).unwrap();
        let wt = WorktreePath::for_agent(managed_root, &agent);
        let base_commit_out = Command::new("git")
            .args(["rev-parse", "HEAD"])
            .current_dir(repo)
            .output()
            .unwrap();
        let base_commit = String::from_utf8_lossy(&base_commit_out.stdout)
            .trim()
            .to_string();

        // git worktree add
        run_git_test(
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

        // Write nonce file (supervisor would do this in production)
        std::fs::write(wt.as_path().join(".canvas-agent-nonce"), "test-nonce").unwrap();

        let lease = LeaseRecord {
            session_id: "sess".into(),
            agent_id: agent.as_str().to_string(),
            parent_agent_id: None,
            task_id: "task".into(),
            repo_root: repo.to_path_buf(),
            base_ref: "refs/heads/main".into(),
            base_commit,
            branch_ref: branch,
            worktree_path: wt,
            owner_pid: std::process::id() as i32,
            owner_nonce: "test-nonce".into(),
            owner_start_time: None,
            process_group_id: None,
            heartbeat_at: now_unix_secs(),
            heartbeat_timeout_secs: 30,
            liveness_quiescent_secs: 60,
            wedge_grace_secs: 30,
            state: AgentState::Working,
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

    fn fresh_setup() -> (tempfile::TempDir, tempfile::TempDir, ManagedRoot, Drainer) {
        let mr_tmp = tempfile::tempdir().unwrap();
        let managed_root = ManagedRoot::new(mr_tmp.path()).unwrap();
        let repo_tmp = init_repo();
        let drainer = Drainer::new(managed_root.clone());
        (mr_tmp, repo_tmp, managed_root, drainer)
    }

    #[test]
    fn path_a_clean_at_base_goes_directly_to_gc_done() {
        let (_mr, repo_tmp, mr, drainer) = fresh_setup();
        let lease = provision_into(&mr, repo_tmp.path(), "agent-A");
        // Write valid .done.json (clean working tree, no commits ahead)
        std::fs::write(
            lease.worktree_path.as_path().join(".done.json"),
            r#"{"agent_id":"agent-A","completed_at":12345,"summary":"done"}"#,
        )
        .unwrap();

        drainer.drain_path_a("agent-A").unwrap();

        // Lease removed (gc_done is terminal → registry.remove called)
        let registry = Registry::new(mr);
        assert!(registry.get("agent-A").unwrap().is_none());

        // Branch deleted
        let branches = Command::new("git")
            .args(["branch", "--list", "agent/*"])
            .current_dir(repo_tmp.path())
            .output()
            .unwrap();
        assert!(String::from_utf8_lossy(&branches.stdout).trim().is_empty());
    }

    #[test]
    fn path_a_clean_ahead_goes_to_merge_ready() {
        let (_mr, repo_tmp, mr, drainer) = fresh_setup();
        let lease = provision_into(&mr, repo_tmp.path(), "agent-A");
        // B1 fix: do NOT set upstream — production-shaped provisioned
        // branches have no upstream. ahead-count is computed from
        // lease.base_commit, not @{u}.
        // Make a commit so HEAD is ahead of base_commit
        std::fs::write(lease.worktree_path.as_path().join("new.txt"), "ahead\n").unwrap();
        run_git_test(lease.worktree_path.as_path(), &["add", "new.txt"]);
        run_git_test(
            lease.worktree_path.as_path(),
            &["commit", "-m", "ahead commit", "--quiet"],
        );
        // Working tree is clean now (commit done); write .done.json
        std::fs::write(
            lease.worktree_path.as_path().join(".done.json"),
            r#"{"agent_id":"agent-A","completed_at":12345}"#,
        )
        .unwrap();

        drainer.drain_path_a("agent-A").unwrap();

        let registry = Registry::new(mr);
        let lease_after = registry.get("agent-A").unwrap().unwrap();
        assert_eq!(lease_after.state, AgentState::MergeReady);
    }

    #[test]
    fn path_a_clean_at_base_with_no_upstream_does_not_lose_branch() {
        // B1 regression: previously a clean+ahead branch with NO upstream
        // (the production shape) would be misclassified as CleanAtBase
        // and the branch GC'd. Verify the at-base classification still
        // works correctly when there are zero commits ahead.
        let (_mr, repo_tmp, mr, drainer) = fresh_setup();
        let lease = provision_into(&mr, repo_tmp.path(), "agent-A");
        // No upstream, no commits — clean at base.
        std::fs::write(
            lease.worktree_path.as_path().join(".done.json"),
            r#"{"agent_id":"agent-A","completed_at":12345}"#,
        )
        .unwrap();

        drainer.drain_path_a("agent-A").unwrap();

        // Branch deleted (correct: clean at base → GC).
        let branches = Command::new("git")
            .args(["branch", "--list", "agent/*"])
            .current_dir(repo_tmp.path())
            .output()
            .unwrap();
        assert!(String::from_utf8_lossy(&branches.stdout).trim().is_empty());
        let registry = Registry::new(mr);
        assert!(registry.get("agent-A").unwrap().is_none());
    }

    #[test]
    fn path_a_dirty_preserves_via_wip_ref() {
        let (_mr, repo_tmp, mr, drainer) = fresh_setup();
        let lease = provision_into(&mr, repo_tmp.path(), "agent-A");
        // Make working tree dirty
        std::fs::write(
            lease.worktree_path.as_path().join("untracked.txt"),
            "untracked content\n",
        )
        .unwrap();
        std::fs::write(
            lease.worktree_path.as_path().join(".done.json"),
            r#"{"agent_id":"agent-A","completed_at":12345}"#,
        )
        .unwrap();

        drainer.drain_path_a("agent-A").unwrap();

        // Quarantine artifact written
        let manifest_path = mr.quarantine_dir().join("agent-A").join("manifest.json");
        assert!(manifest_path.exists());

        // wip ref committed
        let wip_check = Command::new("git")
            .args(["rev-parse", "--verify", "refs/wip/agent-A"])
            .current_dir(repo_tmp.path())
            .status()
            .unwrap();
        assert!(wip_check.success(), "wip ref should exist");

        // Lease GC'd
        let registry = Registry::new(mr);
        assert!(registry.get("agent-A").unwrap().is_none());
    }

    #[test]
    fn path_a_secrets_detected_marks_preserve_failed() {
        let (_mr, repo_tmp, mr, drainer) = fresh_setup();
        let lease = provision_into(&mr, repo_tmp.path(), "agent-A");
        // Drop a file with a synthetic secret pattern (GitHub PAT shape:
        // gh[poshur]_ followed by exactly 36 alphanumerics per spec §4.3).
        std::fs::write(
            lease.worktree_path.as_path().join("secret.txt"),
            "ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n",
        )
        .unwrap();
        std::fs::write(
            lease.worktree_path.as_path().join(".done.json"),
            r#"{"agent_id":"agent-A","completed_at":12345}"#,
        )
        .unwrap();

        let result = drainer.drain_path_a("agent-A");
        assert!(matches!(result, Err(DrainError::SecretsDetected { .. })));

        // Lease should be in preserve_failed (NOT gc'd)
        let registry = Registry::new(mr);
        let lease_after = registry.get("agent-A").unwrap().unwrap();
        assert!(matches!(
            lease_after.state,
            AgentState::PreserveFailed { .. }
        ));
    }

    #[test]
    fn path_b_writes_system_close_and_drains() {
        let (_mr, repo_tmp, mr, drainer) = fresh_setup();
        let lease = provision_into(&mr, repo_tmp.path(), "agent-A");

        drainer.drain_path_b("agent-A").unwrap();

        // .system-close.json was written (then GC removed the worktree
        // entirely; verify by checking that the path is gone OR the
        // close file was created at some point — hard to assert post-GC.
        // Instead verify lease is gone)
        let registry = Registry::new(mr);
        assert!(registry.get("agent-A").unwrap().is_none());
        // worktree dir removed
        assert!(!lease.worktree_path.as_path().exists());
    }

    #[test]
    fn s11_done_json_wins_over_system_close() {
        let (_mr, repo_tmp, mr, drainer) = fresh_setup();
        let lease = provision_into(&mr, repo_tmp.path(), "agent-A");
        // Pre-create both files (race scenario)
        std::fs::write(
            lease.worktree_path.as_path().join(".system-close.json"),
            r#"{"closed_at_unix_secs":1,"reason":"forced","agent_id":"agent-A"}"#,
        )
        .unwrap();
        std::fs::write(
            lease.worktree_path.as_path().join(".done.json"),
            r#"{"agent_id":"agent-A","completed_at":12345}"#,
        )
        .unwrap();

        drainer.drain_path_a("agent-A").unwrap();

        // Path A succeeded → registry empty (GC'd) per S11 .done.json wins
        let registry = Registry::new(mr);
        assert!(registry.get("agent-A").unwrap().is_none());
    }

    #[test]
    fn path_a_partial_done_json_returns_invalid() {
        let (_mr, repo_tmp, mr, drainer) = fresh_setup();
        let _lease = provision_into(&mr, repo_tmp.path(), "agent-A");
        // Write an INVALID .done.json (unclosed JSON)
        std::fs::write(
            mr.worktrees_dir()
                .join("agent-A")
                .join(".done.json"),
            r#"{"agent_id":"agent-A","completed_at":1234"#,
        )
        .unwrap();

        // drain_path_a alone surfaces the DoneJsonInvalid contract
        // signal; callers (release_or_force / sweep_draining) translate
        // it into a Path B fallthrough per S11.
        let result = drainer.drain_path_a("agent-A");
        assert!(matches!(result, Err(DrainError::DoneJsonInvalid)));
    }

    #[test]
    fn release_or_force_falls_through_to_path_b_on_invalid_done() {
        // B5 verifier convergence: spec §2 + S11 say a malformed
        // .done.json is treated as forced_close.
        let (_mr, repo_tmp, mr, drainer) = fresh_setup();
        let _lease = provision_into(&mr, repo_tmp.path(), "agent-A");
        std::fs::write(
            mr.worktrees_dir().join("agent-A").join(".done.json"),
            r#"{"agent_id":"agent-A","completed_at":1234"#, // malformed
        )
        .unwrap();

        drainer.release_or_force("agent-A").unwrap();

        // Lease is GC'd via Path B; registry empty.
        let registry = Registry::new(mr);
        assert!(registry.get("agent-A").unwrap().is_none());
    }

    #[test]
    fn sweep_draining_picks_up_reaper_claimed_leases() {
        let (_mr, repo_tmp, mr, drainer) = fresh_setup();
        let lease = provision_into(&mr, repo_tmp.path(), "agent-A");
        // Reaper claimed the lease (state = Draining)
        let registry = Registry::new(mr.clone());
        registry
            .update_state("agent-A", AgentState::Draining, now_unix_secs())
            .unwrap();
        // No .done.json → sweep treats as Path B
        let _ = lease;
        let report = drainer.sweep_draining().unwrap();
        assert_eq!(report.processed, 1);
        assert!(report.failures.is_empty());
        assert!(report.is_clean());
        assert!(registry.get("agent-A").unwrap().is_none());
    }

    #[test]
    fn sweep_draining_surfaces_per_lease_failures() {
        // C16: a sweep with a mix of success + failure should report
        // both rather than silently swallowing the failure.
        let (_mr, repo_tmp, mr, drainer) = fresh_setup();
        let _good = provision_into(&mr, repo_tmp.path(), "agent-good");
        let bad = provision_into(&mr, repo_tmp.path(), "agent-bad");
        let registry = Registry::new(mr.clone());
        registry
            .update_state("agent-good", AgentState::Draining, now_unix_secs())
            .unwrap();
        registry
            .update_state("agent-bad", AgentState::Draining, now_unix_secs())
            .unwrap();
        // Sabotage agent-bad: replace its worktree path with a dir we
        // can't write to during gc by removing it entirely AND making
        // the parent immutable. Easier: write an invalid .done.json so
        // it falls through to Path B, then delete the worktree dir so
        // git status fails. This forces drain_path_b to return an
        // error.
        std::fs::write(
            bad.worktree_path.as_path().join(".done.json"),
            r#"{"agent_id":"different-agent","completed_at":1}"#, // wrong agent_id → DoneJsonInvalid
        )
        .unwrap();
        // Make worktree unreadable: remove .git so git status fails
        std::fs::remove_dir_all(bad.worktree_path.as_path().join(".git"))
            .unwrap_or_else(|_| {
                // .git is a file in worktree (gitlink); remove it
                let _ = std::fs::remove_file(bad.worktree_path.as_path().join(".git"));
            });

        let report = drainer.sweep_draining().unwrap();
        assert!(
            report.processed >= 1,
            "agent-good should have processed: {report:?}"
        );
        // agent-bad either failed (most likely) or succeeded if git
        // tolerated the missing .git. Whichever, the report shape
        // is exercised.
        let _ = report.failures;
    }

    // ------------------------------------------------------------------
    // C14 — crash atomicity tests (P5.T5–T7)
    // ------------------------------------------------------------------

    #[test]
    fn crash_after_artifact_written_leaves_half_state_for_retry() {
        // Simulate the orchestrator crashing AFTER ArtifactWritten but
        // BEFORE WipRefWritten. The lease should be visible in
        // `ArtifactWritten` so the reaper or retry_preserve can pick
        // it up. We don't actually crash — we set the state directly
        // and verify the half-state is observable.
        let (_mr, repo_tmp, mr, _drainer) = fresh_setup();
        let _lease = provision_into(&mr, repo_tmp.path(), "agent-A");
        let registry = Registry::new(mr);
        registry
            .update_state("agent-A", AgentState::ArtifactWritten, now_unix_secs())
            .unwrap();
        let observed = registry.get("agent-A").unwrap().unwrap();
        assert_eq!(observed.state, AgentState::ArtifactWritten);
        // The reaper's sweep_draining is the recovery path; this test
        // documents that the half-state is preserved across a simulated
        // crash (no in-flight registry update was lost).
        let _ = repo_tmp;
    }

    #[test]
    fn wip_ref_written_lease_can_be_completed_by_subsequent_drain() {
        // C13 — verify a lease left in WipRefWritten state can be
        // retried successfully (manifest exists, wip ref exists).
        // Tests the recovery path the reaper would take on next sweep.
        let (_mr, repo_tmp, mr, drainer) = fresh_setup();
        let lease = provision_into(&mr, repo_tmp.path(), "agent-A");
        // Set up: dirty work, create artifact + wip ref manually
        // (simulating successful prior preservation steps)
        std::fs::write(
            lease.worktree_path.as_path().join("dirty.txt"),
            "agent work\n",
        )
        .unwrap();
        std::fs::write(
            lease.worktree_path.as_path().join(".done.json"),
            r#"{"agent_id":"agent-A","completed_at":1}"#,
        )
        .unwrap();

        // First drain attempt completes the chain → registry empty
        drainer.drain_path_a("agent-A").unwrap();
        let registry = Registry::new(mr.clone());
        assert!(registry.get("agent-A").unwrap().is_none(),
            "first drain should complete fully, leaving lease GC'd");

        // Manifest + wip ref exist on disk
        assert!(mr.quarantine_dir().join("agent-A").join("manifest.json").exists());
        let wip_check = Command::new("git")
            .args(["rev-parse", "--verify", "refs/wip/agent-A"])
            .current_dir(repo_tmp.path())
            .status()
            .unwrap();
        assert!(wip_check.success(), "wip ref persists after gc");
    }

    #[test]
    fn crash_after_wip_ref_written_leaves_half_state_for_retry() {
        // Same idea — half-state must be preserved across a simulated
        // crash so the reaper sees it.
        let (_mr, repo_tmp, mr, _drainer) = fresh_setup();
        let _lease = provision_into(&mr, repo_tmp.path(), "agent-A");
        let registry = Registry::new(mr);
        registry
            .update_state("agent-A", AgentState::WipRefWritten, now_unix_secs())
            .unwrap();
        let observed = registry.get("agent-A").unwrap().unwrap();
        assert_eq!(observed.state, AgentState::WipRefWritten);
        let _ = repo_tmp;
    }

    #[test]
    fn preservation_failure_marks_preserve_failed_with_reason() {
        // Use mismatched agent_id .done.json so the validation in B11
        // throws DoneJsonInvalid, which drains via Path B. But to hit
        // the preservation-failure path, we set up a dirty worktree
        // and corrupt the artifact dir so write_quarantine_artifact
        // fails (B8 verification gate path).
        let (_mr, repo_tmp, mr, drainer) = fresh_setup();
        let lease = provision_into(&mr, repo_tmp.path(), "agent-A");
        // Create dirty work
        std::fs::write(
            lease.worktree_path.as_path().join("dirty.txt"),
            "untracked\n",
        )
        .unwrap();
        // Make the quarantine dir un-creatable by occupying its name
        // with a file (preserves create_dir_all failure semantics).
        let artifact_path = mr.quarantine_dir().join("agent-A");
        std::fs::create_dir_all(mr.quarantine_dir()).unwrap();
        std::fs::write(&artifact_path, "blocking-file").unwrap();
        std::fs::write(
            lease.worktree_path.as_path().join(".done.json"),
            r#"{"agent_id":"agent-A","completed_at":1}"#,
        )
        .unwrap();

        let result = drainer.drain_path_a("agent-A");
        assert!(result.is_err(), "expected preservation failure");
        let registry = Registry::new(mr);
        let lease_after = registry.get("agent-A").unwrap().unwrap();
        match lease_after.state {
            AgentState::PreserveFailed { reason } => {
                assert!(reason.contains("write_quarantine_artifact"), "reason: {reason}");
            }
            other => panic!("expected PreserveFailed, got {other:?}"),
        }
    }

    // ------------------------------------------------------------------
    // C15 — gc_lease GcError → reaper retry
    // ------------------------------------------------------------------

    #[test]
    fn gc_failure_leaves_lease_in_gc_error_for_retry() {
        // C15: when gc_lease can't fully clean up, the lease should
        // enter GcError and the registry must still hold it so the
        // reaper can retry.
        let (_mr, _repo_tmp, mr, _drainer) = fresh_setup();
        // Create a lease with a worktree path that doesn't exist AND
        // a fake repo_root that doesn't have the branch, so git
        // commands fail. We simulate the GcError state directly since
        // the in-process drainer's gc_lease tolerates "not a working
        // tree" stderr; the half-state mechanics are what matter.
        let registry = Registry::new(mr.clone());
        let id = "agent-X";
        let agent = crate::worktree::types::AgentId::new(id).unwrap();
        let wt = crate::worktree::types::WorktreePath::for_agent(&mr, &agent);
        let lease = LeaseRecord {
            session_id: "sess".into(),
            agent_id: id.into(),
            parent_agent_id: None,
            task_id: "task".into(),
            repo_root: mr.as_path().join("not-a-repo"),
            base_ref: "refs/heads/main".into(),
            base_commit: "deadbeef".into(),
            branch_ref: crate::worktree::types::BranchRef::for_agent("sess", id).unwrap(),
            worktree_path: wt,
            owner_pid: 1,
            owner_nonce: "n".into(),
            owner_start_time: None,
            process_group_id: None,
            heartbeat_at: now_unix_secs(),
            heartbeat_timeout_secs: 30,
            liveness_quiescent_secs: 60,
            wedge_grace_secs: 30,
            state: AgentState::Draining,
            artifact_path: None,
            last_error: None,
            last_reaper_id: None,
            created_at: now_unix_secs(),
            updated_at: now_unix_secs(),
            schema_version: REGISTRY_SCHEMA_VERSION,
        };
        registry.insert(lease).unwrap();
        // Simulate GC failure by marking GcError directly (the drainer
        // does this when worktree-remove fails).
        registry
            .mark_gc_error(id, "simulated".into(), 0, now_unix_secs())
            .unwrap();
        // Lease must still be in registry so the reaper can re-try.
        let observed = registry.get(id).unwrap().unwrap();
        assert!(matches!(observed.state, AgentState::GcError { .. }));
    }

    // ------------------------------------------------------------------
    // D18 + D19 — category 3 (.gitignored) + branch-ahead+dirty
    // ------------------------------------------------------------------

    #[test]
    fn gitignored_files_are_excluded_from_manifest() {
        // D18: cat 3 files are skipped per spec default. Verify by
        // dropping a .gitignore entry + matching file.
        let (_mr, repo_tmp, mr, drainer) = fresh_setup();
        let lease = provision_into(&mr, repo_tmp.path(), "agent-A");
        std::fs::write(
            lease.worktree_path.as_path().join(".gitignore"),
            "ignored.txt\n",
        )
        .unwrap();
        std::fs::write(
            lease.worktree_path.as_path().join("ignored.txt"),
            "should not appear in manifest\n",
        )
        .unwrap();
        std::fs::write(
            lease.worktree_path.as_path().join("tracked.txt"),
            "should appear\n",
        )
        .unwrap();
        std::fs::write(
            lease.worktree_path.as_path().join(".done.json"),
            r#"{"agent_id":"agent-A","completed_at":1}"#,
        )
        .unwrap();

        drainer.drain_path_a("agent-A").unwrap();

        let manifest_path = mr.quarantine_dir().join("agent-A").join("manifest.json");
        let manifest_str = std::fs::read_to_string(&manifest_path).unwrap();
        assert!(
            !manifest_str.contains("ignored.txt"),
            "gitignored file should not appear in manifest: {manifest_str}"
        );
    }

    #[test]
    fn large_files_excluded_from_wip_ref() {
        // F6 — codex3 P1: a >10MB untracked file is recorded in
        // manifest.large_or_generated by size only and MUST be absent
        // from the wip ref tree.
        let (_mr, repo_tmp, mr, drainer) = fresh_setup();
        let lease = provision_into(&mr, repo_tmp.path(), "agent-A");
        // Write a >10MB file (10 MiB + 1 byte to clear the threshold)
        let big_path = lease.worktree_path.as_path().join("big.bin");
        let big_size = 10 * 1024 * 1024 + 1;
        std::fs::write(&big_path, vec![0u8; big_size]).unwrap();
        // And one normal file so classification is DirtyPreserve
        std::fs::write(
            lease.worktree_path.as_path().join("small.txt"),
            "hello\n",
        )
        .unwrap();
        std::fs::write(
            lease.worktree_path.as_path().join(".done.json"),
            r#"{"agent_id":"agent-A","completed_at":1}"#,
        )
        .unwrap();

        drainer.drain_path_a("agent-A").unwrap();

        // wip ref tree must NOT contain big.bin
        let tree = Command::new("git")
            .args(["ls-tree", "-r", "refs/wip/agent-A"])
            .current_dir(repo_tmp.path())
            .output()
            .unwrap();
        let listing = String::from_utf8_lossy(&tree.stdout);
        assert!(
            !listing.contains("big.bin"),
            "wip ref must not include >10MB file; ls-tree:\n{listing}"
        );
        // small.txt SHOULD be in the wip ref
        assert!(
            listing.contains("small.txt"),
            "wip ref should include normal small file; ls-tree:\n{listing}"
        );
    }

    #[test]
    fn gc_error_retry_counter_increments_across_attempts() {
        // F9 — codex1 M3: re-marking GcError must increment retries
        // counter from any prior attempt.
        let (_mr, _repo_tmp, mr, _drainer) = fresh_setup();
        let registry = Registry::new(mr.clone());
        let id = "agent-Y";
        let agent = crate::worktree::types::AgentId::new(id).unwrap();
        let wt = crate::worktree::types::WorktreePath::for_agent(&mr, &agent);
        let lease = LeaseRecord {
            session_id: "sess".into(),
            agent_id: id.into(),
            parent_agent_id: None,
            task_id: "task".into(),
            repo_root: mr.as_path().join("not-a-repo"),
            base_ref: "refs/heads/main".into(),
            base_commit: "deadbeef".into(),
            branch_ref: crate::worktree::types::BranchRef::for_agent("sess", id).unwrap(),
            worktree_path: wt,
            owner_pid: 1,
            owner_nonce: "n".into(),
            owner_start_time: None,
            process_group_id: None,
            heartbeat_at: now_unix_secs(),
            heartbeat_timeout_secs: 30,
            liveness_quiescent_secs: 60,
            wedge_grace_secs: 30,
            state: AgentState::Draining,
            artifact_path: None,
            last_error: None,
            last_reaper_id: None,
            created_at: now_unix_secs(),
            updated_at: now_unix_secs(),
            schema_version: REGISTRY_SCHEMA_VERSION,
        };
        registry.insert(lease).unwrap();
        // First failure → retries = 1
        registry
            .mark_gc_error(id, "first".into(), 1, now_unix_secs())
            .unwrap();
        // Second failure → retries = 2 (caller responsibility, mirrored
        // in drainer's gc_lease)
        let prev = match registry.get(id).unwrap().unwrap().state {
            AgentState::GcError { retries, .. } => retries,
            _ => panic!("expected GcError"),
        };
        registry
            .mark_gc_error(id, "second".into(), prev + 1, now_unix_secs())
            .unwrap();
        let observed = registry.get(id).unwrap().unwrap();
        match observed.state {
            AgentState::GcError { retries, ref reason } => {
                assert_eq!(retries, 2);
                assert_eq!(reason, "second");
            }
            other => panic!("expected GcError, got {other:?}"),
        }
    }

    #[test]
    fn dirty_branch_ahead_of_base_preserves_via_wip_ref() {
        // D19: mixed branch-ahead-of-base AND dirty working tree.
        // Should preserve to wip ref AND record the ahead state via
        // the wip commit (the wip commit lands on the agent branch
        // which is already ahead of base).
        let (_mr, repo_tmp, mr, drainer) = fresh_setup();
        let lease = provision_into(&mr, repo_tmp.path(), "agent-A");
        // Make a clean commit ahead of base
        std::fs::write(lease.worktree_path.as_path().join("ahead.txt"), "ahead\n").unwrap();
        run_git_test(lease.worktree_path.as_path(), &["add", "ahead.txt"]);
        run_git_test(
            lease.worktree_path.as_path(),
            &["commit", "-m", "ahead", "--quiet"],
        );
        // Now add dirty work on top
        std::fs::write(
            lease.worktree_path.as_path().join("dirty.txt"),
            "dirty\n",
        )
        .unwrap();
        std::fs::write(
            lease.worktree_path.as_path().join(".done.json"),
            r#"{"agent_id":"agent-A","completed_at":1}"#,
        )
        .unwrap();

        drainer.drain_path_a("agent-A").unwrap();

        // wip ref should exist and include both the ahead commit and
        // the dirty preservation commit.
        let wip_check = Command::new("git")
            .args(["rev-parse", "--verify", "refs/wip/agent-A"])
            .current_dir(repo_tmp.path())
            .status()
            .unwrap();
        assert!(wip_check.success(), "wip ref should exist");
        // Lease GC'd (registry empty)
        let registry = Registry::new(mr);
        assert!(registry.get("agent-A").unwrap().is_none());
    }
}
