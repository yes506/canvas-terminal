//! Tauri command facade for the FSD orchestrator.
//!
//! Per plan v5 §6.1 / §6.2: four user-visible IPC entry points + one
//! query helper. None of these construct claim paths from leader JSON —
//! the orchestrator does that internally via typed `TaskPath::try_new`.

use crate::fsd::orchestrator;
use crate::fsd::orchestrator::{generate_8hex, DispatchResponse};
use crate::fsd::schema::{EmissionMode, FsdCommand};
use crate::state::{AppState, FsdLeaderRuntime};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FsdSetTierResponse {
    pub session_nonce: String,
    pub emission_mode: EmissionMode,
}

/// Activate FSD for a leader, generating a session_nonce. Tier 0 = Off
/// (deactivates and cleans up). Tier ≥ 1 = active (Phase 1: only Pilot=1
/// supported per plan v5 §5.1).
#[tauri::command]
pub fn fsd_set_tier(
    state: State<'_, AppState>,
    leader_session_id: String,
    leader_handle: String,
    tier: u8,
) -> Result<FsdSetTierResponse, String> {
    let mut leaders = state.fsd_leaders.lock().map_err(|e| e.to_string())?;
    if tier == 0 {
        leaders.remove(&leader_handle);
        return Ok(FsdSetTierResponse {
            session_nonce: String::new(),
            emission_mode: EmissionMode::Unavailable,
        });
    }
    // Phase 1 hard cap: only Pilot (tier == 1) is supported.
    if tier > 1 {
        return Err(format!(
            "tier {} not supported in Phase 1 (only Off=0 and Auto-Pilot=1; x1/x2/x3 = Phase 2+)",
            tier
        ));
    }
    let session_nonce = generate_8hex();
    leaders.insert(
        leader_handle.clone(),
        FsdLeaderRuntime {
            leader_handle: leader_handle.clone(),
            leader_session_id,
            session_nonce: session_nonce.clone(),
            tier,
        },
    );
    Ok(FsdSetTierResponse {
        session_nonce,
        // Phase 1 default: prompt-eng path. MCP coexistence path (plan v5 §4.4)
        // becomes active in Phase 1.3 once mcp_server.rs lands.
        emission_mode: EmissionMode::PromptLines,
    })
}

/// Frontend's `fsdLineTap` calls this with each parsed `##FSD` command.
/// Re-validates schema/nonce/idempotency (defense in depth per plan v5 §2)
/// then routes to the orchestrator state machine.
#[tauri::command]
pub async fn fsd_dispatch_command(
    app: AppHandle,
    state: State<'_, AppState>,
    leader_session_id: String,
    cmd: FsdCommand,
) -> Result<DispatchResponse, String> {
    orchestrator::handle_command(app, state, leader_session_id, cmd).await
}

/// UI polling: get the current state of an FSD run from the manifest.
/// Returns None if the run is unknown.
#[tauri::command]
pub fn fsd_query_run(run_id: String) -> Result<Option<serde_json::Value>, String> {
    use crate::commands::memory::get_memory_root;
    let root = get_memory_root()?;
    // Search every leader under fsd-runs/ for this run_id.
    let fsd_root = root.join("fsd-runs");
    if !fsd_root.exists() {
        return Ok(None);
    }
    if let Ok(leaders) = std::fs::read_dir(&fsd_root) {
        for leader in leaders.flatten() {
            let manifest = leader
                .path()
                .join("runs")
                .join(&run_id)
                .join("manifest.json");
            if manifest.exists() {
                let raw = std::fs::read_to_string(&manifest).map_err(|e| e.to_string())?;
                let val: serde_json::Value =
                    serde_json::from_str(&raw).map_err(|e| e.to_string())?;
                return Ok(Some(val));
            }
        }
    }
    Ok(None)
}

/// Cancel a run: SIGKILL all in-flight assistants via process-group, write
/// final.json {status: "cancelled"}, emit `fsd-run-end-{leader_handle}`.
#[tauri::command]
pub fn fsd_cancel_run(
    app: AppHandle,
    state: State<'_, AppState>,
    run_id: String,
) -> Result<bool, String> {
    orchestrator::cancel_run(&app, &state, &run_id)
}

/// Trigger recovery scan on demand (called automatically at startup; exposed
/// for manual re-scan during debugging).
#[tauri::command]
pub async fn fsd_recover_runs() -> Result<serde_json::Value, String> {
    let report = crate::fsd::recovery::recover_runs().await?;
    Ok(serde_json::json!({
        "interrupted": report.interrupted,
        "purged": report.purged,
    }))
}

/// Frontend reports a malformed `##FSD` line it parsed but couldn't promote
/// to a structured FsdCommand. Per @codex2 task-50 P1 + @codex3 task-52 P1
/// + @claude3 task-58 §5.2: malformed-line strike counting must be Rust-
/// canonical. The frontend shows an optimistic count for UI responsiveness;
/// this IPC ensures the orchestrator's count is the source of truth and can
/// trigger force-blocked at STRIKES_PER_TURN even when no structured command
/// reaches the backend.
#[tauri::command]
pub fn fsd_report_malformed(
    app: AppHandle,
    state: State<'_, AppState>,
    leader_session_id: String,
    run_id: Option<String>,
    reason: String,
) -> Result<serde_json::Value, String> {
    // Look up active leader to find any active run.
    let leader_handle = {
        let map = state.fsd_leaders.lock().map_err(|e| e.to_string())?;
        map.iter()
            .find(|(_, v)| v.leader_session_id == leader_session_id)
            .map(|(k, _)| k.clone())
    };
    let Some(leader_handle) = leader_handle else {
        return Ok(serde_json::json!({
            "result": "out_of_scope",
            "strike_count": 0,
            "message": "no active FSD leader for this session",
        }));
    };
    // Resolve run_id: if frontend supplied none, look up the leader's active run.
    let run_id = run_id.or_else(|| {
        let runs = state.fsd_runs.lock().ok()?;
        runs.values()
            .find(|r| r.leader_handle == leader_handle)
            .map(|r| r.run_id.clone())
    });
    let Some(run_id) = run_id else {
        // No active run — frontend's malformed line is pre-plan; can't strike.
        return Ok(serde_json::json!({
            "result": "out_of_scope",
            "strike_count": 0,
            "message": "no active run to attribute the strike to",
        }));
    };
    let (count, force_blocked) = crate::fsd::orchestrator::record_strike_for_test(
        &app,
        &state,
        &run_id,
        &leader_handle,
        &reason,
    );
    Ok(serde_json::json!({
        "result": if force_blocked { "force_blocked" } else { "remind" },
        "strike_count": count,
        "message": format!("strike recorded: {}", reason),
    }))
}
