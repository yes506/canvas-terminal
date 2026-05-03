// Tauri commands — worktree subsystem
//
// Current commands by phase:
//   Phase 2 (foundation): query_registry, query_lease_by_agent_id
//   Phase 3 (provisioning): provision_worktree (fail-closed agent
//     spawn with session-lock + per-worktree lock acquisition; the
//     lockfile RAII guard is held in `lock_holder` keyed by agent_id
//     so it survives the command return)
//   Phase 4 (working — foundation): query_agent_lease (heartbeat
//     snapshot with alive ladder)
//
// Phase 4 supervisor task (orchestrating spawn + heartbeat + agent-
// exit detection + state transition Ready → Working) is deliberately
// in a separate PR — see `phase-4-claude1.md` and verifier feedback
// for rationale (constraint C3 setsid via portable_pty integration
// is non-trivial and merits focused review).
//
// Future phases will add:
//   - Phase 4.5: supervisor task + per-agent setsid spawn + transition
//                Ready → Working with real owner_pid/process_group_id
//   - Phase 5: release_worktree, force_close_worktree, retry_preserve,
//              discard_artifact
//   - Phase 6: queue_merge, query_merge_state, approve_merge,
//              abort_merge

use crate::worktree::config::resolve_managed_root;
use crate::worktree::lease_check::{evaluate, AliveStatus};
use crate::worktree::orchestrator_lock::{
    try_acquire_session, OrchestratorLockError, OrchestratorSessionLock,
};
use crate::worktree::provisioner::{provision, ProvisionRequest};
use crate::worktree::registry::Registry;
use crate::worktree::types::{AgentState, LeaseRecord};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs::File;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

/// UI-safe summary of a registry entry. Matches `LeaseSnapshot` in
/// spirit but specialized for the read-only Phase 2 query (no PIDs,
/// no FDs, no absolute paths in the user-visible output).
#[derive(Debug, Serialize)]
pub struct RegistryEntrySummary {
    pub agent_id: String,
    pub session_id: String,
    pub state_kind: String, // "working", "draining", "preserve_failed", ...
    pub branch_short: String,
    pub heartbeat_age_secs: i64,
    pub last_error: Option<String>,
}

/// List all registry entries (read-only). Returns an empty vec if
/// the managed root is not configured or the registry is empty.
#[tauri::command]
pub fn query_registry() -> std::result::Result<Vec<RegistryEntrySummary>, String> {
    // Per codex1 finding #8: surface registry errors instead of
    // collapsing them to "no leases" — UI must distinguish "really
    // empty" from "registry corrupt / lock contention".
    let Some(root) = resolve_managed_root() else {
        // No managed root configured: empty state is correct.
        return Ok(Vec::new());
    };
    let registry = Registry::new(root);
    let leases = registry
        .list_all()
        .map_err(|e| format!("registry read failed: {e}"))?;
    let now = now_unix_secs();
    Ok(leases.into_values().map(|l| summarize(&l, now)).collect())
}

/// Read a single registry entry by agent id. Returns `Ok(None)` if no
/// such lease exists; `Err(_)` for registry errors (codex1 #8).
#[tauri::command]
pub fn query_lease_by_agent_id(
    agent_id: String,
) -> std::result::Result<Option<RegistryEntrySummary>, String> {
    let Some(root) = resolve_managed_root() else {
        return Ok(None);
    };
    let registry = Registry::new(root);
    let lease = registry
        .get(&agent_id)
        .map_err(|e| format!("registry read failed: {e}"))?;
    Ok(lease.map(|l| summarize(&l, now_unix_secs())))
}

fn summarize(lease: &LeaseRecord, now_unix: i64) -> RegistryEntrySummary {
    RegistryEntrySummary {
        agent_id: lease.agent_id.clone(),
        session_id: lease.session_id.clone(),
        state_kind: state_kind(&lease.state).to_string(),
        branch_short: lease.branch_ref.as_str().to_string(),
        heartbeat_age_secs: (now_unix - lease.heartbeat_at).max(0),
        last_error: lease.last_error.clone(),
    }
}

fn state_kind(state: &AgentState) -> &'static str {
    match state {
        AgentState::Provisioning => "provisioning",
        AgentState::Ready => "ready",
        AgentState::Working => "working",
        AgentState::Draining => "draining",
        AgentState::Snapshotting => "snapshotting",
        AgentState::ArtifactWritten => "artifact_written",
        AgentState::WipRefWritten => "wip_ref_written",
        AgentState::Preserved => "preserved",
        AgentState::MergeReady => "merge_ready",
        AgentState::MergeQueued => "merge_queued",
        AgentState::Merging => "merging",
        AgentState::Merged => "merged",
        AgentState::MergeFailed { .. } => "merge_failed",
        AgentState::MergeAborted { .. } => "merge_aborted",
        AgentState::Removed => "removed",
        AgentState::GcDone => "gc_done",
        AgentState::PreserveFailed { .. } => "preserve_failed",
        AgentState::GcError { .. } => "gc_error",
    }
}

fn now_unix_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

// ----------------------------------------------------------------------
// Phase 3: provision_worktree
// ----------------------------------------------------------------------

/// Process-wide store of per-worktree lockfile guards. Keyed by
/// agent_id so the lockfile lives at least until release_worktree
/// (Phase 5) or process exit. Phase 4 will replace this with
/// supervisor ownership (each agent's supervisor task owns its
/// LeaseRuntime, including the lock_file handle).
///
/// This is a transitional structure for Phase 3: the provisioner
/// returns a `ProvisionedAgent` containing a `lock_file: File`, but
/// the Tauri command boundary can't return file handles to JS, so we
/// stash the handle here keyed by agent_id and return only the
/// serializable summary. The lock is held for as long as the entry
/// is in this map.
fn lock_holder() -> &'static Mutex<HashMap<String, File>> {
    static HOLDER: OnceLock<Mutex<HashMap<String, File>>> = OnceLock::new();
    HOLDER.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Process-wide holder of the SESSION-level orchestrator lock.
/// Per B1 verifier convergence (codex1+codex2+codex3 — 3/5):
/// `provision_worktree` MUST acquire and retain the session lock
/// (`<managed_root>/orchestrator.lock`) on first worktree-backed
/// session start, so the spec §6.1 single-orchestrator-per-managed-
/// root invariant holds across app instances.
///
/// The lock is acquired lazily (first `provision_worktree` call)
/// and held for the process lifetime. Spec §6.1 lazy-acquisition:
/// non-worktree app instances NEVER touch this lock. A second app
/// instance attempting to spawn a worktree-backed agent gets
/// `OrchestratorLockError::AlreadyHeld` and the user-visible
/// error from spec §6.1.
fn session_lock_holder() -> &'static Mutex<Option<OrchestratorSessionLock>> {
    static HOLDER: OnceLock<Mutex<Option<OrchestratorSessionLock>>> = OnceLock::new();
    HOLDER.get_or_init(|| Mutex::new(None))
}

/// Lazily acquire the session lock if not already held by this
/// process. Returns `Ok(())` on first acquire OR if already held by
/// this process (idempotent for the holder; subsequent
/// `provision_worktree` calls don't re-acquire). Returns
/// `Err(_)` if another process holds the lock.
fn ensure_session_lock(managed_root: &crate::worktree::types::ManagedRoot) -> std::result::Result<(), String> {
    let mut holder = session_lock_holder()
        .lock()
        .map_err(|e| format!("session lock holder mutex poisoned: {e}"))?;
    if holder.is_some() {
        // Already held by this process — nothing to do.
        return Ok(());
    }
    match try_acquire_session(managed_root) {
        Ok(guard) => {
            *holder = Some(guard);
            Ok(())
        }
        Err(OrchestratorLockError::AlreadyHeld) => Err(
            "Another canvas-terminal instance is using worktree-backed \
             collaboration on this project. Close it or open this session \
             in collaborator mode without worktree provisioning."
                .to_string(),
        ),
        Err(e) => Err(format!("session lock acquisition failed: {e}")),
    }
}

#[derive(Debug, Deserialize)]
pub struct ProvisionWorktreeRequest {
    pub session_id: String,
    pub task_id: String,
    pub repo_root: String,
    pub parent_agent_id: Option<String>,
    pub base_ref: Option<String>,
    pub heartbeat_timeout_secs: Option<u32>,
}

#[derive(Debug, Serialize)]
pub struct ProvisionedSummary {
    pub agent_id: String,
    pub branch_ref: String,
    pub worktree_path: String,
    pub base_commit: String,
}

/// Provision a worktree for a new mini-agent (Phase 3).
///
/// Fail-closed: any error means no lease is registered, no worktree
/// exists on disk, no nonce file remains. The caller (handleSpawn in
/// the React frontend) MUST NOT mount AgentMiniTerminal until this
/// command returns Ok.
///
/// Returns the agent_id for the caller to use in subsequent
/// `query_lease_by_agent_id` and (Phase 4) `query_agent_lease`
/// calls. The actual agent process spawn (PTY, env, args) is done
/// by the caller via the existing `spawn_process` PTY command,
/// using the returned `worktree_path` as the cwd.
#[tauri::command]
pub fn provision_worktree(
    request: ProvisionWorktreeRequest,
) -> std::result::Result<ProvisionedSummary, String> {
    let managed_root = resolve_managed_root().ok_or_else(|| {
        "worktree managed root is not configured".to_string()
    })?;

    // B1 fix: acquire the session-level orchestrator lock BEFORE
    // any provisioning side effects. If another process holds it,
    // fail closed with the user-visible error from spec §6.1.
    ensure_session_lock(&managed_root)?;

    let internal = ProvisionRequest {
        session_id: request.session_id,
        task_id: request.task_id,
        repo_root: PathBuf::from(request.repo_root),
        parent_agent_id: request.parent_agent_id,
        base_ref: request.base_ref,
        heartbeat_timeout_secs: request.heartbeat_timeout_secs,
    };

    let provisioned = provision(&managed_root, internal).map_err(|e| e.to_string())?;

    let summary = ProvisionedSummary {
        agent_id: provisioned.agent_id.as_str().to_string(),
        branch_ref: provisioned.branch_ref.as_str().to_string(),
        worktree_path: provisioned
            .worktree_path
            .as_path()
            .to_string_lossy()
            .into_owned(),
        base_commit: provisioned.base_commit,
    };

    // T2.4 fix per verifier convergence (codex1+codex2+codex3): mutex
    // poisoning was previously silently swallowed (the lockfile File
    // would drop and release the flock without the user knowing).
    // Now we surface the error so the caller can decide.
    let mut holder = lock_holder()
        .lock()
        .map_err(|e| format!("lock holder mutex poisoned: {e}"))?;
    holder.insert(summary.agent_id.clone(), provisioned.lock_file);
    drop(holder);

    Ok(summary)
}

// ----------------------------------------------------------------------
// Phase 4: query_agent_lease
// ----------------------------------------------------------------------

/// Detailed snapshot for a single agent. Returned by `query_agent_lease`.
/// Surfaces the heartbeat-derived aliveness ladder so the UI can show
/// "Alive / Quiescent / Wedged / Dead" indicator chips.
///
/// Per spec §3.3 LeaseSnapshot semantics: never include raw PIDs,
/// FDs, or absolute paths in the user-visible output.
///
/// E20+E23 — surfaces the human-readable `state_reason` for half-states
/// (`PreserveFailed { reason }` / `GcError { reason, retries }`) so the
/// UI can render an actionable chip with retry/discard buttons.
#[derive(Debug, Serialize)]
pub struct AgentLeaseSnapshot {
    pub agent_id: String,
    pub session_id: String,
    pub state_kind: String,
    pub branch_short: String,
    pub heartbeat_age_secs: i64,
    pub alive_status: &'static str, // "alive" | "quiescent" | "wedged" | "dead" | "not_started"
    pub last_error: Option<String>,
    /// Human-readable reason for half-states. None for normal states.
    pub state_reason: Option<String>,
    /// Retry count for `GcError`. None for non-GcError states.
    pub gc_retries: Option<u32>,
}

/// Query a single agent's full lease snapshot including
/// heartbeat-derived aliveness. Used by Phase 4 frontend to show
/// per-agent indicator chips.
#[tauri::command]
pub fn query_agent_lease(
    agent_id: String,
) -> std::result::Result<Option<AgentLeaseSnapshot>, String> {
    let Some(root) = resolve_managed_root() else {
        return Ok(None);
    };
    let registry = Registry::new(root);
    let lease = registry
        .get(&agent_id)
        .map_err(|e| format!("registry read failed: {e}"))?;
    Ok(lease.map(|l| {
        let now = now_unix_secs();
        // T2.3 fix per codex3 B5 + claude3: pre-spawn leases (state =
        // Provisioning or Ready) have `owner_pid = std::process::id()`
        // (the Tauri app PID, NOT a real agent), no recorded
        // start_time, and a fresh `heartbeat_at` from provisioning.
        // `lease_check::evaluate` would return `Alive` for them
        // because the Tauri app PID exists and the nonce matches —
        // misleading the UI into showing "agent is alive" before the
        // supervisor has even spawned the agent process. Surface a
        // distinct `not_started` status until the supervisor moves
        // the lease to `Working`.
        let alive_status = match &l.state {
            AgentState::Provisioning | AgentState::Ready => "not_started",
            _ => alive_status_str(evaluate(&l, now)),
        };
        let (state_reason, gc_retries) = match &l.state {
            AgentState::PreserveFailed { reason } => (Some(reason.clone()), None),
            AgentState::GcError { reason, retries } => (Some(reason.clone()), Some(*retries)),
            AgentState::MergeFailed { reason } => (Some(reason.clone()), None),
            AgentState::MergeAborted { reason } => (Some(reason.clone()), None),
            _ => (None, None),
        };
        AgentLeaseSnapshot {
            agent_id: l.agent_id.clone(),
            session_id: l.session_id.clone(),
            state_kind: state_kind(&l.state).to_string(),
            branch_short: l.branch_ref.as_str().to_string(),
            heartbeat_age_secs: (now - l.heartbeat_at).max(0),
            alive_status,
            last_error: l.last_error.clone(),
            state_reason,
            gc_retries,
        }
    }))
}

fn alive_status_str(s: AliveStatus) -> &'static str {
    match s {
        AliveStatus::Alive => "alive",
        AliveStatus::Quiescent => "quiescent",
        AliveStatus::Wedged => "wedged",
        AliveStatus::Dead => "dead",
    }
}

// ----------------------------------------------------------------------
// Phase 5: drainer commands (release_worktree, force_close_worktree)
// ----------------------------------------------------------------------

use crate::worktree::drainer::Drainer;

/// Release a worktree-backed agent's lease via Path A `agent_completed`.
/// Caller must ensure `.done.json` is present in the worktree (typically
/// the agent wrote it before exiting). Drainer validates via S1
/// atomicity, snapshots, preserves dirty state, and GCs.
///
/// **B5 fix per claude2/codex2/codex3 convergence**: if `.done.json`
/// is malformed/partial we fall through to Path B (forced_close) per
/// spec §2 + S11 instead of returning an error and leaving the lease
/// stuck in `Draining`.
///
/// Phase 5 Tauri command. UI calls this when the agent has explicitly
/// completed its task.
#[tauri::command]
pub fn release_worktree(agent_id: String) -> std::result::Result<(), String> {
    let Some(root) = resolve_managed_root() else {
        return Err("worktree managed root is not configured".to_string());
    };
    let drainer = Drainer::new(root);
    drainer
        .release_or_force(&agent_id)
        .map_err(|e| format!("release_worktree failed: {e}"))?;

    // Per claude2 I5 (round 14): Phase 5 owns the lock_holder eviction
    // so the map doesn't grow unbounded. The lockfile File goes out of
    // scope here → flock released.
    if let Ok(mut holder) = lock_holder().lock() {
        holder.remove(&agent_id);
    }
    Ok(())
}

/// Force-close a worktree-backed agent (Path B `forced_close`).
///
/// **A4 fix per 5/5 verifier convergence**: this command now calls
/// `Supervisor::force_close` FIRST when a supervisor for this agent
/// is registered (via `supervisor_registry`). That sends SIGTERM →
/// 5s grace → SIGKILL to the agent's process group, propagating any
/// kill error EXCEPT `KillError::NotFound` (benign — agent already
/// gone). Only after the kill sequence does the drainer write
/// `.system-close.json` and run preservation. The lease is
/// guaranteed to NOT be drained while the agent is still mutating
/// the worktree.
///
/// If no supervisor is registered (the agent was started before this
/// process restarted, or via a non-supervisor path), the command
/// falls through to drainer-only — the reaper's liveness checks are
/// the safety net in that case.
///
/// Phase 5 Tauri command.
#[tauri::command]
pub async fn force_close_worktree(agent_id: String) -> std::result::Result<(), String> {
    let Some(root) = resolve_managed_root() else {
        return Err("worktree managed root is not configured".to_string());
    };

    // A4: terminate the supervised process group BEFORE draining.
    //
    // **F5 fix per codex1+claude2 N1 convergence**: previously we
    // `remove()`d the supervisor first, then awaited `force_close`.
    // If the kill failed (PermissionDenied, etc.), the removed
    // supervisor was dropped → monitor task aborted → backend lost
    // the retry handle while the agent process was potentially still
    // alive. Now we keep the supervisor in the registry until the
    // kill SUCCEEDS, then remove it.
    if crate::worktree::supervisor_registry::contains(&agent_id) {
        // Remove takes ownership so we can call async force_close.
        // On error we re-insert so a retry has a handle.
        if let Some(supervisor) = crate::worktree::supervisor_registry::remove(&agent_id) {
            match supervisor.force_close().await {
                Ok(()) => {
                    // Supervisor consumed; drop is fine — heartbeat/monitor
                    // already stopped by force_close + drop.
                }
                Err(e) => {
                    // Reinsert so the user/UI can retry. Re-insert can
                    // only fail if a parallel insert raced (impossible
                    // since we just held the only handle); surface that
                    // pathologically. H5 returns the supervisor on
                    // failure so the caller doesn't drop it implicitly.
                    if let Err((sup_back, re)) =
                        crate::worktree::supervisor_registry::insert(supervisor)
                    {
                        // Drop the orphan supervisor explicitly — at
                        // least heartbeat/monitor are aborted.
                        drop(sup_back);
                        return Err(format!(
                            "force_close_worktree: kill failed ({e}); \
                             supervisor re-insertion ALSO failed ({re}) — \
                             reaper liveness check is the recovery path"
                        ));
                    }
                    return Err(format!("force_close_worktree (supervisor): {e}"));
                }
            }
        }
    }

    let drainer = Drainer::new(root);
    drainer
        .drain_path_b(&agent_id)
        .map_err(|e| format!("force_close_worktree (drainer): {e}"))?;

    // Evict lockfile holder per claude2 I5
    if let Ok(mut holder) = lock_holder().lock() {
        holder.remove(&agent_id);
    }
    Ok(())
}

/// E21 — retry preservation on a `PreserveFailed` lease.
/// Resets state to `Draining` and re-runs the preservation chain.
/// Useful after the human resolves a quarantine path collision,
/// fixes a permission problem, or removes a flagged secret.
#[tauri::command]
pub fn retry_preserve(agent_id: String) -> std::result::Result<(), String> {
    let Some(root) = resolve_managed_root() else {
        return Err("worktree managed root is not configured".to_string());
    };
    let drainer = Drainer::new(root);
    drainer
        .retry_preserve(&agent_id)
        .map_err(|e| format!("retry_preserve failed: {e}"))?;
    Ok(())
}

/// B11 — bulk close all worktree-backed agents in a session.
/// Iterates the registry, finds leases matching `session_id`, and runs
/// `force_close_worktree` for each in sequence. Returns aggregated
/// errors so the UI can show "5 closed, 1 failed (reason)".
#[tauri::command]
pub async fn bulk_close_worktrees(
    session_id: String,
) -> std::result::Result<BulkCloseReport, String> {
    let Some(root) = resolve_managed_root() else {
        return Err("worktree managed root is not configured".to_string());
    };
    let registry = Registry::new(root.clone());
    let leases = registry
        .list_all()
        .map_err(|e| format!("registry: {e}"))?;

    let target_ids: Vec<String> = leases
        .into_iter()
        .filter_map(|(id, lease)| {
            if lease.session_id == session_id {
                Some(id)
            } else {
                None
            }
        })
        .collect();

    let mut report = BulkCloseReport::default();
    for agent_id in target_ids {
        match force_close_worktree(agent_id.clone()).await {
            Ok(()) => report.closed += 1,
            Err(e) => report.failures.push((agent_id, e)),
        }
    }
    Ok(report)
}

#[derive(Debug, Default, Serialize)]
pub struct BulkCloseReport {
    pub closed: usize,
    pub failures: Vec<(String, String)>,
}

/// E25 — query the write_audit log entries for forensics.
/// Returns up to `limit` recent entries (default 100).
#[tauri::command]
pub fn query_audit_log(
    limit: Option<usize>,
) -> std::result::Result<Vec<AuditLogEntrySummary>, String> {
    use crate::worktree::write_audit::{recent_audit_entries, AuditReason};
    let entries = recent_audit_entries(limit.unwrap_or(100));
    Ok(entries
        .into_iter()
        .map(|e| AuditLogEntrySummary {
            timestamp_unix_secs: e.when_unix_secs,
            agent_id: e.agent_id,
            allowed: matches!(e.reason, AuditReason::Allowed),
            reason: format!("{:?}", e.reason),
            requested_path: e.requested_path.to_string_lossy().into_owned(),
        })
        .collect())
}

#[derive(Debug, Serialize)]
pub struct AuditLogEntrySummary {
    pub timestamp_unix_secs: i64,
    pub agent_id: Option<String>,
    pub allowed: bool,
    pub reason: String,
    pub requested_path: String,
}

/// E26 — reaper metrics snapshot. Returns counters for sweeps,
/// claims, GcError + PreserveFailed transitions.
#[tauri::command]
pub fn query_reaper_metrics() -> std::result::Result<ReaperMetricsSnapshot, String> {
    let snap = crate::worktree::reaper::metrics_snapshot();
    Ok(ReaperMetricsSnapshot {
        sweeps_total: snap.sweeps_total,
        claims_total: snap.claims_total,
        gc_errors_total: snap.gc_errors_total,
        preserve_failed_total: snap.preserve_failed_total,
    })
}

#[derive(Debug, Serialize)]
pub struct ReaperMetricsSnapshot {
    pub sweeps_total: u64,
    pub claims_total: u64,
    pub gc_errors_total: u64,
    pub preserve_failed_total: u64,
}

/// E27 — supervisor registry observability snapshot.
#[tauri::command]
pub fn query_supervisor_registry() -> std::result::Result<SupervisorRegistrySnapshot, String> {
    let agent_ids = crate::worktree::supervisor_registry::agent_ids();
    let metrics = crate::worktree::supervisor_registry::metrics_snapshot();
    Ok(SupervisorRegistrySnapshot {
        live_agent_ids: agent_ids,
        inserts_total: metrics.inserts_total,
        removes_total: metrics.removes_total,
    })
}

#[derive(Debug, Serialize)]
pub struct SupervisorRegistrySnapshot {
    pub live_agent_ids: Vec<String>,
    pub inserts_total: u64,
    pub removes_total: u64,
}

// ----------------------------------------------------------------------
// Phase 6 — Merge queue commands (D16-D23)
// ----------------------------------------------------------------------

use crate::worktree::merge_queue::{MergeQueue, MergeStateSnapshot};

/// D17 — queue a `MergeReady` lease for merge.
#[tauri::command]
pub fn queue_merge(agent_id: String) -> std::result::Result<(), String> {
    let Some(root) = resolve_managed_root() else {
        return Err("worktree managed root is not configured".to_string());
    };
    MergeQueue::new(root)
        .queue_merge(&agent_id)
        .map_err(|e| format!("queue_merge failed: {e}"))
}

/// D18 — query the merge state for a specific agent.
#[tauri::command]
pub fn query_merge_state(
    agent_id: String,
) -> std::result::Result<Option<MergeStateSnapshot>, String> {
    let Some(root) = resolve_managed_root() else {
        return Ok(None);
    };
    MergeQueue::new(root)
        .query_state(&agent_id)
        .map_err(|e| format!("query_merge_state failed: {e}"))
}

/// D19 — user approves a queued merge; runs the merge worker.
#[tauri::command]
pub fn approve_merge(agent_id: String) -> std::result::Result<(), String> {
    let Some(root) = resolve_managed_root() else {
        return Err("worktree managed root is not configured".to_string());
    };
    MergeQueue::new(root)
        .approve_merge(&agent_id)
        .map_err(|e| format!("approve_merge failed: {e}"))
}

/// D19 — user aborts a queued or in-progress merge.
#[tauri::command]
pub fn abort_merge(agent_id: String, reason: String) -> std::result::Result<(), String> {
    let Some(root) = resolve_managed_root() else {
        return Err("worktree managed root is not configured".to_string());
    };
    MergeQueue::new(root)
        .abort_merge(&agent_id, reason)
        .map_err(|e| format!("abort_merge failed: {e}"))
}

/// D19 — retry a `MergeFailed` merge after the human resolves the
/// underlying issue (rebased, removed secret, etc.).
#[tauri::command]
pub fn retry_merge(agent_id: String) -> std::result::Result<(), String> {
    let Some(root) = resolve_managed_root() else {
        return Err("worktree managed root is not configured".to_string());
    };
    MergeQueue::new(root)
        .retry_merge(&agent_id)
        .map_err(|e| format!("retry_merge failed: {e}"))
}

/// E22 — explicitly discard the preserved artifact for an agent.
/// **Destructive**: removes the quarantine dir and runs the GC
/// sequence. Caller (UI) MUST confirm with the user before invoking.
/// The wip ref (`refs/wip/<agent>`) survives; only the quarantine
/// artifact + the agent's own branch are removed.
#[tauri::command]
pub fn discard_artifact(agent_id: String) -> std::result::Result<(), String> {
    let Some(root) = resolve_managed_root() else {
        return Err("worktree managed root is not configured".to_string());
    };
    let drainer = Drainer::new(root);
    drainer
        .discard_artifact(&agent_id)
        .map_err(|e| format!("discard_artifact failed: {e}"))?;
    if let Ok(mut holder) = lock_holder().lock() {
        holder.remove(&agent_id);
    }
    Ok(())
}

// ----------------------------------------------------------------------
// Phase 4.5 production wiring (A3): start_worktree_agent
// ----------------------------------------------------------------------

use crate::state::{AppState, PtySession};
use crate::worktree::pty_supervisor::PtySpawn;
use crate::worktree::supervisor::Supervisor;
use std::io::Read;
use tauri::{AppHandle, Emitter, State};

#[derive(Debug, Deserialize)]
pub struct StartWorktreeAgentRequest {
    pub agent_id: String,
    pub session_id: String,
    pub program: String,
    pub args: Option<Vec<String>>,
    pub cols: u16,
    pub rows: u16,
    pub env: Option<HashMap<String, String>>,
}

/// A3 — start the agent through the full worktree-backed lifecycle:
///   1. Look up the lease (must exist, in Ready state)
///   2. Spawn the PTY-backed agent via `PtySpawn` (constraint C3:
///      separate session/process group)
///   3. Hand the master/writer/reader to AppState::sessions so the
///      existing `write_to_pty`/`resize_pty`/`kill_pty` IPC commands
///      keep working unchanged
///   4. Start the Supervisor (records real owner_pid/pgid/start_time
///      atomically per B2 + advances Ready → Working + spawns the
///      monitor task that owns the heartbeat per T2.1)
///   5. Register the supervisor in `supervisor_registry` so
///      `force_close_worktree` can find it
///
/// Replaces the legacy `spawn_process` for worktree-backed agents.
/// The frontend calls `provision_worktree` first (which creates the
/// worktree + lease) and then `start_worktree_agent` (which spawns
/// the agent in that worktree).
#[tauri::command]
pub fn start_worktree_agent(
    app: AppHandle,
    state: State<'_, AppState>,
    request: StartWorktreeAgentRequest,
) -> std::result::Result<(), String> {
    let managed_root = resolve_managed_root().ok_or_else(|| {
        "worktree managed root is not configured".to_string()
    })?;

    // Look up the lease so we can resolve the worktree cwd.
    let registry = crate::worktree::registry::Registry::new(managed_root.clone());
    let lease = registry
        .get(&request.agent_id)
        .map_err(|e| format!("registry: {e}"))?
        .ok_or_else(|| format!("no lease for agent {}", request.agent_id))?;

    // Find the lockfile guard the provisioner stashed.
    let lock_file = {
        let mut holder = lock_holder()
            .lock()
            .map_err(|e| format!("lock holder mutex poisoned: {e}"))?;
        holder.remove(&request.agent_id).ok_or_else(|| {
            format!(
                "no lockfile guard for agent {} — was provision_worktree called?",
                request.agent_id
            )
        })?
    };

    // **F7 fix per codex1 M1**: build the env stack to match legacy
    // spawn_process (cached_env + baseline + extras) AND resolve the
    // program against the cached PATH. Without this, worktree-backed
    // agents have a bare environment with no PATH/HOME/lang/etc — many
    // CLI tools that work via spawn_process fail under start_worktree_agent.
    let resolved_program = crate::commands::pty::resolve_program_pub(&request.program, &state)
        .unwrap_or_else(|_| request.program.clone());

    let mut env_pairs: Vec<(String, String)> =
        crate::commands::pty::cached_env_pairs(&state);
    env_pairs.extend(crate::commands::pty::baseline_env_pairs());
    if let Some(extras) = request.env.as_ref() {
        for (k, v) in extras {
            env_pairs.push((k.clone(), v.clone()));
        }
    }

    let spawner = PtySpawn::new(&resolved_program, request.args.clone().unwrap_or_default())
        .with_size(request.cols, request.rows)
        .with_env(env_pairs);

    // Synthetic ProvisionedAgent — the provisioner-derived data we
    // actually need for Supervisor::start: agent_id, branch_ref,
    // worktree_path, base_commit, nonce, lock_file.
    use crate::worktree::provisioner::ProvisionedAgent;
    use crate::worktree::types::AgentId;
    let agent = AgentId::new(&request.agent_id)
        .ok_or_else(|| format!("invalid agent_id: {}", request.agent_id))?;
    let provisioned = ProvisionedAgent {
        agent_id: agent,
        branch_ref: lease.branch_ref.clone(),
        worktree_path: lease.worktree_path.clone(),
        base_commit: lease.base_commit.clone(),
        nonce: lease.owner_nonce.clone(),
        lock_file,
    };

    // Start the supervisor — this calls spawner.spawn() which stashes
    // the PTY handles inside the spawner.
    let supervisor = Supervisor::start(managed_root, provisioned, &spawner, &[])
        .map_err(|e| format!("Supervisor::start: {e}"))?;

    // **F4 fix per codex1+codex2+codex3 P0 convergence**: post-spawn
    // sequence (take_handles → sessions insert → supervisor_registry
    // insert) must be transactional. Any failure after `Supervisor::start`
    // leaves a real PTY child running with a Working lease, so we MUST
    // either complete the wiring or roll back by force-closing the
    // process group + transitioning the lease back to a drainable state.
    //
    // The cleanup closure runs synchronously by swapping the supervisor
    // out, signalling the agent process group via process_group_kill,
    // and dropping the supervisor (which aborts monitor/heartbeat).
    let agent_id_for_rollback = request.agent_id.clone();
    let rollback = |sup: Supervisor, reason: String| -> String {
        // Send SIGTERM to the agent's PG. We don't wait the full 5s
        // grace here (this is the error path) — best-effort kill +
        // SIGKILL so the wedged child doesn't leak.
        if let Some(pgid) = sup.process_group_id() {
            let _ = crate::worktree::process_group_kill::sigterm_process_group(pgid);
            let _ = crate::worktree::process_group_kill::sigkill_process_group(pgid);
        }
        // Best-effort transition lease to Draining so reaper sweep
        // can clean up. If the registry update fails, surface the
        // composite error.
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);
        let registry = crate::worktree::registry::Registry::new(
            resolve_managed_root().expect("managed root resolved at function entry"),
        );
        let _ = registry.update_state(
            &agent_id_for_rollback,
            crate::worktree::types::AgentState::Draining,
            now,
        );
        // Drop sup — aborts monitor + heartbeat tasks.
        drop(sup);
        format!("start_worktree_agent rollback: {reason}")
    };

    let handles = match spawner.take_handles() {
        Some(h) => h,
        None => {
            return Err(rollback(
                supervisor,
                "PtySpawn produced no handles after spawn".to_string(),
            ));
        }
    };

    let session_id = request.session_id.clone();
    let event_id = session_id.clone();
    let app_clone = app.clone();
    let reader = handles.reader;
    let reader_thread = std::thread::spawn(move || {
        pty_reader_loop(app_clone, event_id, reader);
    });

    let session = PtySession {
        child: Box::new(SupervisorChildShim::new()),
        writer: handles.writer,
        reader_thread: Some(reader_thread),
        master: handles.master,
    };

    if let Err(e) = state
        .sessions
        .lock()
        .map(|mut g| g.insert(session_id.clone(), session))
    {
        return Err(rollback(supervisor, format!("sessions mutex poisoned: {e}")));
    }

    // Register the supervisor so force_close_worktree can find it.
    //
    // **H5 fix per codex1 R1 + codex2 #3**: insert returns the
    // supervisor BACK on failure so we can run the same rollback
    // closure (SIGTERM+SIGKILL the agent PG, transition lease to
    // Draining) instead of dropping the supervisor and orphaning the
    // child. This closes the last transactional hole in the
    // start_worktree_agent post-spawn sequence.
    if let Err((sup_back, e)) = crate::worktree::supervisor_registry::insert(supervisor) {
        // Remove the session entry so we don't leave dead state.
        if let Ok(mut sessions) = state.sessions.lock() {
            sessions.remove(&session_id);
        }
        // Roll back the spawned process via the same path used for
        // earlier post-spawn failures (kills PG + advances lease to
        // Draining for reaper recovery).
        return Err(rollback(sup_back, format!("supervisor_registry insert failed: {e}")));
    }

    let _ = app; // suppress unused if cfg-gated reader changes later
    Ok(())
}

/// PTY reader-thread body — copied from `commands::pty::start_reader_thread`
/// (DRY would couple modules unnecessarily; the loop is small).
fn pty_reader_loop(app: AppHandle, event_id: String, mut reader: Box<dyn Read + Send>) {
    let mut buf = [0u8; 4096];
    let mut pending: Vec<u8> = Vec::new();
    loop {
        match reader.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                pending.extend_from_slice(&buf[..n]);
                let mut emit_buf = String::new();
                let mut pos = 0;
                while pos < pending.len() {
                    match std::str::from_utf8(&pending[pos..]) {
                        Ok(s) => {
                            emit_buf.push_str(s);
                            pos = pending.len();
                        }
                        Err(e) => {
                            let valid_end = pos + e.valid_up_to();
                            if valid_end > pos {
                                emit_buf.push_str(unsafe {
                                    std::str::from_utf8_unchecked(&pending[pos..valid_end])
                                });
                            }
                            match e.error_len() {
                                Some(len) => {
                                    emit_buf.push('\u{FFFD}');
                                    pos = valid_end + len;
                                }
                                None => {
                                    pos = valid_end;
                                    break;
                                }
                            }
                        }
                    }
                }
                if !emit_buf.is_empty() {
                    let _ = app.emit(&format!("pty-data-{}", event_id), emit_buf.as_str());
                }
                if pos < pending.len() {
                    let remaining = pending[pos..].to_vec();
                    pending = remaining;
                } else {
                    pending.clear();
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(_) => break,
        }
    }
    let _ = app.emit(&format!("pty-exit-{}", event_id), ());
}

/// Placeholder Child impl held in `PtySession` for worktree-backed
/// agents. The actual child lifetime is owned by the supervisor; the
/// kill_pty path goes through the supervisor's force_close instead.
/// PtySession::Drop calls child.kill() — for worktree agents this is
/// a no-op because the supervisor + supervisor_registry own the
/// real termination path.
#[derive(Debug)]
struct SupervisorChildShim;

impl SupervisorChildShim {
    fn new() -> Self {
        Self
    }
}

impl portable_pty::Child for SupervisorChildShim {
    fn try_wait(&mut self) -> std::io::Result<Option<portable_pty::ExitStatus>> {
        Ok(None)
    }
    fn wait(&mut self) -> std::io::Result<portable_pty::ExitStatus> {
        // Block forever — caller should use try_wait. Production code
        // never calls wait on the shim because the supervisor owns the
        // real lifecycle.
        Err(std::io::Error::other("SupervisorChildShim has no wait"))
    }
    fn process_id(&self) -> Option<u32> {
        None
    }
}

impl portable_pty::ChildKiller for SupervisorChildShim {
    fn kill(&mut self) -> std::io::Result<()> {
        // No-op — termination is owned by Supervisor::force_close via
        // process_group_kill.
        Ok(())
    }
    fn clone_killer(&self) -> Box<dyn portable_pty::ChildKiller + Send + Sync> {
        Box::new(SupervisorChildShim)
    }
}
