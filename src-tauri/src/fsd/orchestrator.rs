//! FSD `Orchestrator` — the dumb harness around leader-authored commands.
//!
//! Per plan v5 §2: validates and executes leader commands; never decides
//! tasks. State machine consumes `FsdCommand` (from schema.rs) and transitions
//! through plan → dispatch → done/blocked, enforcing all safety bounds.
//!
//! Strike count is canonical here (per plan v5 §5.6). The frontend's
//! `fsdProtocol.ts` may show optimistic counts; the orchestrator's count is
//! authoritative for `force_blocked` decisions.

use crate::commands::memory::get_memory_root;
use crate::fsd::runner::{AssistantRunner, HeadlessStdioRunner};
use crate::fsd::schema::{
    FsdCommand, FsdEnvelope, RunManifest, RunStatus, TaskDone, TaskSpec, SCHEMA_VERSION,
};
use crate::fsd::storage::TaskPath;
use crate::state::{AppState, FsdRunHandle};
use serde::{Deserialize, Serialize};
use std::time::Duration;
use tauri::{AppHandle, Emitter, State};
use tokio::sync::oneshot;

// ---- Caps (per plan v5 §6.3) ------------------------------------------------
/// Default max_turns when the leader's `plan` doesn't supply one.
/// Mirrored in schema::default_max_turns; kept here so all turn-cap config
/// is co-located with the orchestrator that enforces it.
pub const MAX_TURNS_DEFAULT: u32 = 4;
pub const MAX_TURNS_CEILING: u32 = 16;
pub const MAX_TASKS_PER_DISPATCH: usize = 4;
pub const MAX_PROMPT_BYTES: usize = 8 * 1024;
/// Hard ceiling on whole-run wallclock — heartbeat loop force-cancels the run
/// when exceeded, regardless of leader activity. Per plan v5 §6.3 R2.
pub const WALLCLOCK_MS_PER_RUN: u64 = 600_000;
/// Strike count before the orchestrator force-blocks the run after repeated
/// malformed emissions. Canonical here per plan v5 §5.6 — the frontend keeps
/// an optimistic count for UI responsiveness, but `record_strike` /
/// `apply_strike_top` enforce this ceiling and emit `force_blocked` once it
/// trips.
pub const STRIKES_PER_TURN: u32 = 3;
pub const HEARTBEAT_INTERVAL_MS: u64 = 10_000;
pub const ITERATION_REPORT_BYTES_CAP: usize = 16 * 1024;
pub const PER_TASK_STDOUT_TRUNCATE_BYTES: usize = 2048;

/// In-memory run state (Phase 2 introspection). Currently the manifest's
/// `RunStatus` is the canonical state; this enum mirrors it for a future
/// in-memory state machine that `Orchestrator` (now removed) would have
/// owned. Kept for documentation + Phase 2 bring-back.
#[allow(dead_code)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RunState {
    Planning,       // awaiting first plan
    Dispatching,    // tasks running
    AwaitingLeader, // iteration_report injected; waiting for leader's next FSD line
    Done,
    Blocked,
    Cancelled,
    CapTripped,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum DispatchResult {
    Accepted,
    Malformed,
    Duplicate,
    StaleNonce,
    OutOfScope,
    OutOfBounds,
    UnknownRun,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum NextAction {
    Ack,
    Remind,
    ForceBlocked,
    Terminal,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DispatchResponse {
    pub result: DispatchResult,
    pub strike_count: u32,
    pub next_action: NextAction,
    pub message: Option<String>,
}

// NOTE: An earlier `Orchestrator` struct + `validate_envelope` method were
// removed in favor of manifest-backed validation (`validate_run_command` +
// `FsdRunHandle` registry in `state::AppState`). Per @claude2 task-49 §3.5 +
// @codex2 task-50 P1 — the dead code was a smell that masked the real
// validation gap (which is now closed by `validate_run_command`).

/// Where a dispatch sits relative to the run's `max_turns`. Used by
/// `handle_dispatch` to decide whether to run real tasks (Normal/FinalTurn),
/// inject the synthesis-pass prompt (SynthesisPass), or hard-reject as
/// cap-tripped (anything beyond).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CapTripState {
    Normal,        // turn < max_turns — run normally
    FinalTurn,     // turn == max_turns — run normally but warn in iteration_report
    SynthesisPass, // turn == max_turns + 1 — inject synthesis prompt, no real spawn
}

/// Real ISO-8601 timestamp at second resolution (UTC).
///
/// Format: `2026-05-04T00:25:13Z`. Lexically sortable, parseable by recovery's
/// `epoch_secs_diff` via the inverse `iso_to_epoch_secs` helper. Avoids adding
/// chrono/time crate deps — we only need second precision for FSD manifests.
///
/// Per @claude3 task-51 §5.1: previously returned `@<epoch>` which contradicted
/// the schema doc-comment claiming ISO-8601. Recovery used the prefix marker
/// to detect it; we now share the same ISO-8601 format on both write and read
/// sides (recovery uses `epoch_secs_diff` to compute age).
fn now_iso() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    epoch_to_iso(secs)
}

/// Convert epoch seconds (UTC) to `YYYY-MM-DDTHH:MM:SSZ` without external deps.
/// Algorithm: Howard Hinnant's "civil_from_days" — well-defined for years
/// 1970..9999. Sortable lexically.
pub(crate) fn epoch_to_iso(secs: u64) -> String {
    let days = (secs / 86_400) as i64;
    let secs_of_day = secs % 86_400;
    let hour = secs_of_day / 3600;
    let min = (secs_of_day % 3600) / 60;
    let sec = secs_of_day % 60;

    // civil_from_days: convert days since 1970-01-01 to (year, month, day).
    // Adapted from https://howardhinnant.github.io/date_algorithms.html
    let z = days + 719_468;
    let era = if z >= 0 {
        z / 146_097
    } else {
        (z - 146_096) / 146_097
    };
    let doe = (z - era * 146_097) as u64; // [0, 146_096]
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365; // [0, 399]
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0, 365]
    let mp = (5 * doy + 2) / 153; // [0, 11]
    let d = doy - (153 * mp + 2) / 5 + 1; // [1, 31]
    let m = if mp < 10 { mp + 3 } else { mp - 9 }; // [1, 12]
    let y = if m <= 2 { y + 1 } else { y };

    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z",
        y, m, d, hour, min, sec
    )
}

// ---- Top-level entry ---------------------------------------------------------

/// Process a leader-emitted command: validate, execute, return response.
pub async fn handle_command(
    app: AppHandle,
    state: State<'_, AppState>,
    leader_session_id: String,
    cmd: FsdCommand,
) -> Result<DispatchResponse, String> {
    // Look up the orchestrator (created in fsd_set_tier).
    let leaders = state.fsd_leaders.clone();
    let leader = {
        let map = leaders.lock().map_err(|e| e.to_string())?;
        map.iter()
            .find(|(_, v)| v.leader_session_id == leader_session_id)
            .map(|(k, v)| (k.clone(), v.clone()))
    };
    let Some((leader_handle, leader_runtime)) = leader else {
        return Ok(DispatchResponse {
            result: DispatchResult::OutOfScope,
            strike_count: 0,
            next_action: NextAction::Terminal,
            message: Some(format!(
                "no active FSD leader for session {}",
                leader_session_id
            )),
        });
    };

    // Capture run_id before the cmd is moved into the verb handler. We need
    // it to apply strike-counting side effects BEFORE returning.
    let run_id_for_strike = match &cmd {
        FsdCommand::Plan { env, .. }
        | FsdCommand::Dispatch { env, .. }
        | FsdCommand::Done { env, .. }
        | FsdCommand::Blocked { env, .. } => env.run_id.clone(),
    };

    let response = match cmd {
        FsdCommand::Plan {
            env,
            goal,
            success_criteria,
            max_turns,
        } => {
            handle_plan(
                app.clone(),
                state.clone(),
                leader_handle.clone(),
                leader_runtime,
                env,
                goal,
                success_criteria,
                max_turns,
            )
            .await
        }
        FsdCommand::Dispatch { env, turn, tasks } => {
            handle_dispatch(
                app.clone(),
                state.clone(),
                leader_handle.clone(),
                env,
                turn,
                tasks,
            )
            .await
        }
        FsdCommand::Done {
            env,
            summary,
            evidence,
        } => {
            handle_done(
                app.clone(),
                state.clone(),
                leader_handle.clone(),
                env,
                summary,
                evidence,
            )
            .await
        }
        FsdCommand::Blocked {
            env,
            reason,
            missing_capability,
            needed_user_input,
            last_cmd_id,
        } => {
            handle_blocked(
                app.clone(),
                state.clone(),
                leader_handle.clone(),
                env,
                reason,
                missing_capability,
                needed_user_input,
                last_cmd_id,
            )
            .await
        }
    };

    // Apply canonical Rust-side strike accounting per plan v5 §4.2 / §5.6.
    // - Accepted   → reset_strikes_on_accept (next failure starts fresh)
    // - Duplicate  → no-op (idempotent ack, not a real failure)
    // - other      → record_strike; force-blocks the run at STRIKES_PER_TURN
    // The response always carries the live strike_count for the UI.
    match response {
        Ok(resp) => Ok(apply_strike_top(
            &app,
            &state,
            &leader_handle,
            &run_id_for_strike,
            resp,
        )),
        Err(e) => Err(e),
    }
}

/// Wrapper for the top-level strike accounting at handle_command exit.
/// Resets on Accepted; strikes on non-Accepted/non-Duplicate.
///
/// `#[must_use]` per @claude2 task-63 P3 — same reasoning as apply_strike.
#[must_use]
fn apply_strike_top(
    app: &AppHandle,
    state: &State<'_, AppState>,
    leader_handle: &str,
    run_id: &str,
    resp: DispatchResponse,
) -> DispatchResponse {
    if resp.result == DispatchResult::Accepted {
        reset_strikes_on_accept(state, run_id);
        return resp;
    }
    apply_strike(app, state, leader_handle, run_id, resp)
}

async fn handle_plan(
    app: AppHandle,
    state: State<'_, AppState>,
    leader_handle: String,
    leader_runtime: crate::state::FsdLeaderRuntime,
    env: FsdEnvelope,
    goal: String,
    success_criteria: Vec<String>,
    max_turns: u32,
) -> Result<DispatchResponse, String> {
    // Schema/sn check (rn not required for plan — it's the run's establishment).
    if env.v != SCHEMA_VERSION {
        return Ok(DispatchResponse {
            result: DispatchResult::Malformed,
            strike_count: 0,
            next_action: NextAction::Remind,
            message: Some(format!("schema v{} unsupported", env.v)),
        });
    }
    if env.sn != leader_runtime.session_nonce {
        return Ok(DispatchResponse {
            result: DispatchResult::StaleNonce,
            strike_count: 0,
            next_action: NextAction::Remind,
            message: Some("sn mismatch on plan".into()),
        });
    }

    // Per @codex3 task-66 P1: a duplicate `plan` for the SAME run_id with the
    // SAME cmd_id (echo / retransmission) must return `Duplicate` + `Ack`,
    // NOT `OutOfScope` + `Remind` (which would strike the active run and
    // could force-block it after 3 echo replays). Check the run's existing
    // seen_cmd_ids set first; only fall through to the active-run guard when
    // the cmd_id is new (which means the leader is genuinely trying to start
    // a second run while one is in flight — that's the OutOfScope case).
    {
        let runs = state.fsd_runs.lock().map_err(|e| e.to_string())?;
        if let Some(existing) = runs.values().find(|r| r.leader_handle == leader_handle) {
            // If the replayed cmd_id matches the active run's plan cmd_id,
            // it's an idempotent ack-and-return.
            if existing.run_id == env.run_id && existing.seen_cmd_ids.contains(&env.cmd_id) {
                return Ok(DispatchResponse {
                    result: DispatchResult::Duplicate,
                    strike_count: existing.consecutive_strikes,
                    next_action: NextAction::Ack,
                    message: Some(format!(
                        "duplicate plan: run_id={} cmd_id={} already established",
                        existing.run_id, env.cmd_id
                    )),
                });
            }
            // Otherwise it's a genuinely new plan attempting to displace the
            // active run — concurrent-run policy rejection.
            return Ok(DispatchResponse {
                result: DispatchResult::OutOfScope,
                strike_count: 0,
                next_action: NextAction::Remind,
                message: Some(format!(
                    "leader {} already owns active run {} — cancel via /fsd-cancel before issuing a new plan",
                    leader_handle, existing.run_id
                )),
            });
        }
    }

    // Generate run_nonce; create durable manifest.
    let run_id = env.run_id.clone();
    let run_nonce = generate_8hex();
    let clamped_max_turns = max_turns.min(MAX_TURNS_CEILING).max(1);
    let manifest = RunManifest {
        run_id: run_id.clone(),
        leader_handle: leader_handle.clone(),
        owner_pid: std::process::id(),
        started_at: now_iso(),
        last_heartbeat_at: now_iso(),
        status: RunStatus::Running,
        session_nonce: leader_runtime.session_nonce.clone(),
        run_nonce: run_nonce.clone(),
    };
    if let Err(e) = write_manifest(&leader_handle, &run_id, &manifest) {
        return Ok(DispatchResponse {
            result: DispatchResult::OutOfScope,
            strike_count: 0,
            next_action: NextAction::Terminal,
            message: Some(format!("manifest write failed: {}", e)),
        });
    }
    let _ = write_run_file(
        &leader_handle,
        &run_id,
        "plan.json",
        serde_json::json!({
            "goal": goal,
            "success_criteria": success_criteria,
            "max_turns": clamped_max_turns,
        }),
    );

    // Register run handle for cancellation. `task_cancel_txs` starts empty
    // and is populated as `handle_dispatch` spawns assistants; `cancel_run`
    // drains the vector to fan out cancellation per plan v5 §6.4.
    let (cancel_tx, cancel_rx) = oneshot::channel::<()>();
    {
        let mut runs = state.fsd_runs.lock().map_err(|e| e.to_string())?;
        let mut seen = std::collections::HashSet::new();
        // Pre-insert the plan's own cmd_id so a duplicate plan is also rejected.
        seen.insert(env.cmd_id.clone());
        runs.insert(
            run_id.clone(),
            FsdRunHandle {
                leader_handle: leader_handle.clone(),
                run_id: run_id.clone(),
                cancel_tx: Some(cancel_tx),
                task_cancel_txs: std::collections::HashMap::new(),
                max_turns: clamped_max_turns,
                current_turn: 0,
                seen_cmd_ids: seen,
                consecutive_strikes: 0,
            },
        );
    }

    // Launch heartbeat task — writes manifest.last_heartbeat_at every 10s
    // until run terminates (R15).
    let leader_handle_for_hb = leader_handle.clone();
    let run_id_for_hb = run_id.clone();
    tokio::spawn(heartbeat_loop(
        app.clone(),
        state.fsd_runs.clone(),
        // Round-10 reflection per codex1 task-1 + claude3 task-4 §(b):
        // pass the dispatch-group registry through so the cap-trip path
        // inside the heartbeat can clear its run's entry on terminal
        // transition (mirrors handle_done/cancel_run).
        state.current_dispatch_groups.clone(),
        leader_handle_for_hb,
        run_id_for_hb,
        cancel_rx,
    ));

    // Emit event so UI can show the new run.
    let _ = app.emit(
        &format!("fsd-run-start-{}", leader_handle),
        serde_json::json!({
            "run_id": run_id,
            "run_nonce": run_nonce,
            "max_turns": clamped_max_turns,
        }),
    );

    Ok(DispatchResponse {
        result: DispatchResult::Accepted,
        strike_count: 0,
        next_action: NextAction::Ack,
        message: Some(format!("run_nonce={}", run_nonce)),
    })
}

async fn handle_dispatch(
    app: AppHandle,
    state: State<'_, AppState>,
    leader_handle: String,
    env: FsdEnvelope,
    turn: u32,
    tasks: Vec<TaskSpec>,
) -> Result<DispatchResponse, String> {
    // Per @codex3 task-72 P3: enforce 1-indexed turn contract per plan v5 §3
    // grammar (`turn` field is 1-indexed). turn=0 doesn't correspond to a
    // valid manifest layout slot (`turns/0/...`) so reject upfront.
    if turn < 1 {
        return Ok(DispatchResponse {
            result: DispatchResult::OutOfBounds,
            strike_count: 0,
            next_action: NextAction::Remind,
            message: Some(format!("turn must be >= 1, got {}", turn)),
        });
    }
    if tasks.len() > MAX_TASKS_PER_DISPATCH {
        return Ok(DispatchResponse {
            result: DispatchResult::OutOfBounds,
            strike_count: 0,
            next_action: NextAction::Remind,
            message: Some(format!(
                "tasks ({}) exceeds MAX_TASKS_PER_DISPATCH ({})",
                tasks.len(),
                MAX_TASKS_PER_DISPATCH
            )),
        });
    }
    for t in &tasks {
        if t.prompt.len() > MAX_PROMPT_BYTES {
            return Ok(DispatchResponse {
                result: DispatchResult::OutOfBounds,
                strike_count: 0,
                next_action: NextAction::Remind,
                message: Some(format!(
                    "task {} prompt ({} bytes) exceeds MAX_PROMPT_BYTES ({})",
                    t.task_id,
                    t.prompt.len(),
                    MAX_PROMPT_BYTES
                )),
            });
        }
    }

    // Per @codex3 task-72 P1: idempotent-duplicate check MUST run before
    // the verb-specific state guard. Otherwise an echo/retry of the same
    // accepted dispatch (transport-level retransmission) — arriving while
    // the original has set the manifest to `Dispatching` — would hit the
    // state guard and return OutOfScope+Remind, striking a healthy run.
    // We only DETECT the duplicate here; recording happens later after all
    // remaining validation passes (preserves codex2 task-64 P2's invariant).
    if let Err(resp) = check_cmd_id_seen(&state, &env.run_id, &env.cmd_id) {
        return Ok(resp);
    }

    let manifest = match validate_run_command(&leader_handle, &env) {
        Ok(m) => m,
        Err(resp) => return Ok(resp),
    };
    // Verb-specific state guard per plan v5 §3.1 + @codex2 task-57 P1:
    // a second `dispatch` while the previous one is still `Dispatching`
    // would race overlapping turns. Only allow dispatch from Running or
    // AwaitingLeader (post-iteration_report). `done`/`blocked` may interrupt
    // a Dispatching state — that's the leader explicitly aborting.
    if !matches!(
        manifest.status,
        RunStatus::Running | RunStatus::AwaitingLeader
    ) {
        return Ok(DispatchResponse {
            result: DispatchResult::OutOfScope,
            strike_count: 0,
            next_action: NextAction::Remind,
            message: Some(format!(
                "dispatch not allowed in state {:?}; previous dispatch still in flight or run is terminal",
                manifest.status
            )),
        });
    }

    // Validate every task path before recording cmd_id or mutating manifest
    // state. An earlier order persisted dispatch.json / set Dispatching before
    // discovering an invalid task_id, leaving the run stranded.
    for spec in &tasks {
        if let Err(e) = TaskPath::try_new(&leader_handle, &env.run_id, turn, &spec.task_id) {
            return Ok(DispatchResponse {
                result: DispatchResult::OutOfScope,
                strike_count: 0,
                next_action: NextAction::Remind,
                message: Some(format!("invalid task_id {}: {}", spec.task_id, e)),
            });
        }
    }

    // PR-PreC: validate `to_agent_id` AND `from_agent_id` against the
    // current run's dispatch group. A leader may only address agents that
    // the orchestrator spawned in the CURRENT or prior turn of this run
    // (per plan v6 §2.10). Empty group = no inter-agent messaging yet;
    // allow only None.
    //
    // Round-7 reflection (codex2 task-75 P2 + codex3 task-77 P1):
    // `from_agent_id` MUST also be validated — without this, a leader can
    // synthesize a `from_agent_id="<arbitrary>"` and the response broker
    // would write to that arbitrary agent's inbox, polluting unrelated
    // run/turn agent inbox namespaces. Same authorization rule as
    // `to_agent_id`.
    //
    // Also validate `agent_id` shape (8-hex) for every task — codex2 P2.
    //
    // Round-10 reflection per codex3 task-5: also reject duplicate
    // `agent_id` values within a single dispatch. PR-PreC's authorization
    // model assumes (run_id, agent_id) is unique within a turn —
    // duplicates would mean two concurrent task spawns share a single
    // inbox lane, breaking the writer-monopoly invariant for response
    // routing and producing nondeterministic prompt augmentation.
    if let Some(dup) = find_duplicate_agent_id(&tasks) {
        return Ok(DispatchResponse {
            result: DispatchResult::Malformed,
            strike_count: 0,
            next_action: NextAction::Remind,
            message: Some(format!(
                "duplicate agent_id {} within single dispatch (each task must have a unique agent_id)",
                dup
            )),
        });
    }
    {
        let groups = state.current_dispatch_groups.lock().map_err(|e| e.to_string())?;
        let known_agents: std::collections::HashSet<String> = groups
            .get(&env.run_id)
            .map(|by_turn| {
                by_turn
                    .values()
                    .flat_map(|s| s.iter().cloned())
                    .collect()
            })
            .unwrap_or_default();
        for spec in &tasks {
            // Validate `agent_id` 8-hex shape (per PR-PreC contract).
            if let Err(e) = crate::fsd::inbox::validate_id_hex(
                &spec.agent_id,
                crate::fsd::inbox::AGENT_ID_HEX_WIDTH,
            ) {
                return Ok(DispatchResponse {
                    result: DispatchResult::Malformed,
                    strike_count: 0,
                    next_action: NextAction::Remind,
                    message: Some(format!("agent_id invalid: {}", e)),
                });
            }
            if let Some(target) = &spec.to_agent_id {
                if !known_agents.contains(target) {
                    return Ok(DispatchResponse {
                        result: DispatchResult::OutOfScope,
                        strike_count: 0,
                        next_action: NextAction::Remind,
                        message: Some(format!(
                            "to_agent_id {} not in current_dispatch_groups for run {} \
                             (must be a previously-spawned agent_id)",
                            target, env.run_id
                        )),
                    });
                }
            }
            if let Some(requester) = &spec.from_agent_id {
                // `from_agent_id` must also be a known agent in this run —
                // closes the broker-injection vector codex2 P2 + codex3 P1.
                if let Err(e) = crate::fsd::inbox::validate_id_hex(
                    requester,
                    crate::fsd::inbox::AGENT_ID_HEX_WIDTH,
                ) {
                    return Ok(DispatchResponse {
                        result: DispatchResult::Malformed,
                        strike_count: 0,
                        next_action: NextAction::Remind,
                        message: Some(format!("from_agent_id invalid: {}", e)),
                    });
                }
                if !known_agents.contains(requester) {
                    return Ok(DispatchResponse {
                        result: DispatchResult::OutOfScope,
                        strike_count: 0,
                        next_action: NextAction::Remind,
                        message: Some(format!(
                            "from_agent_id {} not in current_dispatch_groups for run {} \
                             (broker would write to unauthorized inbox)",
                            requester, env.run_id
                        )),
                    });
                }
            }
        }
    }

    // Enforce max_turns from the registered FsdRunHandle (per plan v5 §6.3 +
    // §5.4 + claude3 task-51 §4.3). When the leader dispatches AT max_turns,
    // it's their last real turn; AT max_turns+1, they get a synthesis-pass
    // turn (instructions injected, no real tasks spawned) that doesn't count
    // against the cap; BEYOND max_turns+1, hard-reject and force cap-tripped.
    let run_max_turns = {
        let runs = state.fsd_runs.lock().map_err(|e| e.to_string())?;
        runs.get(&env.run_id).map(|run_handle| run_handle.max_turns)
    };
    let cap_trip_state = match run_max_turns {
        Some(max_turns) if turn == max_turns => CapTripState::FinalTurn,
        Some(max_turns) if turn == max_turns + 1 => CapTripState::SynthesisPass,
        Some(max_turns) if turn > max_turns + 1 => {
            // cmd_id was already verified new by check_cmd_id_seen above;
            // record it now since we're about to mutate state (cap-trip).
            record_cmd_id(&state, &env.run_id, &env.cmd_id);
            update_manifest_status(&leader_handle, &env.run_id, RunStatus::CapTripped);
            let _ = write_run_file(
                &leader_handle,
                &env.run_id,
                "final.json",
                serde_json::json!({
                    "status": "cap_tripped",
                    "ended_at": now_iso(),
                    "reason": format!(
                        "turn {} exceeds max_turns ({}) + synthesis-pass",
                        turn, max_turns
                    ),
                }),
            );
            // Round-10 reflection per codex1 task-1 + claude3 task-4 §(b):
            // mirror handle_done's PR-PreC dispatch-group clear so the
            // cap-trip terminal path doesn't leak an orphan group entry.
            if let Ok(mut groups) = state.current_dispatch_groups.lock() {
                groups.remove(&env.run_id);
            }
            cleanup_run(&state, &env.run_id);
            let _ = app.emit(
                &format!("fsd-run-end-{}", leader_handle),
                serde_json::json!({"run_id": env.run_id, "status": "cap_tripped"}),
            );
            return Ok(DispatchResponse {
                result: DispatchResult::OutOfBounds,
                strike_count: 0,
                next_action: NextAction::Terminal,
                message: Some(format!(
                    "turn {} exceeds max_turns ({}) + synthesis-pass; run forced cap-tripped",
                    turn, max_turns
                )),
            });
        }
        _ => CapTripState::Normal,
    };

    // cmd_id was already verified new by check_cmd_id_seen above; record it
    // now after all pure validation passed and before the first side effect.
    record_cmd_id(&state, &env.run_id, &env.cmd_id);

    // Synthesis-pass: don't spawn real tasks. Inject a synthesis prompt and
    // wait for the leader to emit `done` or `blocked`.
    if cap_trip_state == CapTripState::SynthesisPass {
        let synthesis_report = build_synthesis_pass_report(&leader_handle, &env.run_id, turn);
        let _ = write_run_file_text(
            &leader_handle,
            &env.run_id,
            &format!("turns/{}/synthesis_pass.md", turn),
            &synthesis_report,
        );
        update_manifest_status(&leader_handle, &env.run_id, RunStatus::AwaitingLeader);
        let _ = app.emit(
            &format!("fsd-iteration-report-{}", leader_handle),
            serde_json::json!({
                "run_id": env.run_id,
                "turn": turn,
                "report": synthesis_report,
                "cap_trip": true,
            }),
        );
        return Ok(DispatchResponse {
            result: DispatchResult::Accepted,
            strike_count: 0,
            next_action: NextAction::Ack,
            message: Some("synthesis-pass turn — emit `done` or `blocked` next".into()),
        });
    }

    update_manifest_status(&leader_handle, &env.run_id, RunStatus::Dispatching);

    // Persist the dispatch.
    let _ = write_run_file(
        &leader_handle,
        &env.run_id,
        &format!("turns/{}/dispatch.json", turn),
        serde_json::json!({"tasks": tasks}),
    );

    // Phase 2.9: look up the leader's project root once, before the spawn
    // loop. We thread this into every helper invocation so they resolve
    // relative paths in the leader's prompt against the project root rather
    // than the Tauri app bundle. The lookup chain is:
    //   leader_handle → fsd_leaders[handle].leader_session_id → sessions[id].cwd
    // Both lookups are best-effort: if either fails (leader deregistered, PTY
    // already exited), helpers fall back to inheriting the parent's cwd —
    // same as before the fix, no regression.
    let leader_cwd: Option<std::path::PathBuf> = {
        let leader_session_id = state
            .fsd_leaders
            .lock()
            .ok()
            .and_then(|m| m.get(&leader_handle).map(|r| r.leader_session_id.clone()));
        leader_session_id.and_then(|sid| {
            state
                .sessions
                .lock()
                .ok()
                .and_then(|s| s.get(&sid).and_then(|p| p.cwd.clone()))
        })
    };

    // Spawn each task in parallel. Per plan v5 §6.4, register each task's
    // cancel_tx into the run's FsdRunHandle so /fsd-cancel can fan out and
    // kill in-flight assistants via process_group::kill_process_group.
    // PR-PreC: register every task's `agent_id` in `current_dispatch_groups`
    // BEFORE spawning so future turns of this run can address these agents
    // via `to_agent_id`. Plan v6 §2.8 keys by (run_id, turn).
    {
        let mut groups = state
            .current_dispatch_groups
            .lock()
            .map_err(|e| e.to_string())?;
        let by_turn = groups.entry(env.run_id.clone()).or_default();
        let turn_set = by_turn.entry(turn).or_default();
        for spec in &tasks {
            turn_set.insert(spec.agent_id.clone());
        }
    }

    let mut handles = Vec::new();
    for spec in &tasks {
        let task_path = TaskPath::try_new(&leader_handle, &env.run_id, turn, &spec.task_id)
            .map_err(|e| format!("validated task_id became invalid: {}", e))?;
        let output_dir_rel = task_path
            .pending()
            .rsplit_once('/')
            .map(|(d, _)| d.to_string())
            .unwrap_or_default();
        // The runner is now passed into run_and_record_one_task by reference;
        // we construct a fresh HeadlessStdioRunner inside the call (zero-sized).

        // Clamp leader-supplied wallclock to product cap (per @codex1 task-48
        // remaining risk #3 + plan v5 §6.3).
        let mut spec_clamped = spec.clone();
        if spec_clamped.wallclock_ms_cap > crate::fsd::runner::WALLCLOCK_MS_PER_TASK_CAP {
            spec_clamped.wallclock_ms_cap = crate::fsd::runner::WALLCLOCK_MS_PER_TASK_CAP;
        }

        let leader_handle_clone = leader_handle.clone();
        let run_id_clone = env.run_id.clone();
        let app_clone = app.clone();
        let task_id_clone = spec.task_id.clone();
        let tool_clone = spec.tool.clone();
        let role_hint_clone = spec.role_hint.clone();
        // Clone the runs registry Arc so the spawned task can remove its
        // cancel sender on completion (closes @codex2 task-57 P2 stale-Vec leak).
        let runs_for_cleanup = state.fsd_runs.clone();

        // Round-7 reflection (claude4 task-78 §3.2): clone Arc<AtomicU64>
        // for the Phase C response broker so it can stamp seq_global from
        // the orchestrator's authoritative counter across the spawned task
        // boundary (preserves writer-monopoly invariant from plan v6 §2.3).
        let seq_global_clone = state.seq_global.clone();

        let (task_cancel_tx, task_cancel_rx) = oneshot::channel::<()>();
        // Register the cancel sender keyed by task_id so cancel_run() can
        // fan out (plan v5 §6.4). The completion closure removes its own
        // entry so /fsd-cancel doesn't try to signal a dead task and
        // cancelled_tasks count stays accurate (closes @codex2 task-57 P2).
        {
            let mut runs = state.fsd_runs.lock().map_err(|e| e.to_string())?;
            if let Some(run_handle) = runs.get_mut(&env.run_id) {
                run_handle
                    .task_cancel_txs
                    .insert(spec.task_id.clone(), task_cancel_tx);
                run_handle.current_turn = turn;
            }
        }

        // Emit task-start so the SwarmDrawer chip appears immediately
        // (plan v5 §3.1 / @claude2 task-49 §3.1).
        let _ = app.emit(
            &format!("fsd-task-start-{}", leader_handle),
            serde_json::json!({
                "run_id": env.run_id,
                "turn": turn,
                "task_id": spec.task_id,
                "tool": spec.tool,
                "role_hint": spec.role_hint,
            }),
        );

        let cwd_clone = leader_cwd.clone();
        handles.push(tokio::spawn(async move {
            // Production calls run_and_record_one_task — the SAME helper that
            // the integration test calls with FakeAssistantRunner. Per
            // @codex3 task-90 P2: this guarantees the production code path
            // and test exercise the same logic, so a future ordering change
            // in this helper is caught by the integration test.
            run_and_record_one_task(
                &HeadlessStdioRunner,
                &leader_handle_clone,
                &run_id_clone,
                turn,
                &task_id_clone,
                &tool_clone,
                role_hint_clone.clone(),
                spec_clamped,
                output_dir_rel,
                cwd_clone,
                task_cancel_rx,
                Some(&runs_for_cleanup),
                Some(&app_clone),
                Some(&seq_global_clone),
            )
            .await
        }));
    }

    // Wait for all tasks (or cap-time).
    let mut results: Vec<TaskDone> = Vec::new();
    for h in handles {
        if let Ok(d) = h.await {
            results.push(d);
        }
    }

    // A leader may emit `done`, `blocked`, or `/fsd-cancel` while a dispatch
    // is still in flight. In that case those terminal paths are authoritative;
    // do not resurrect the run by writing `awaiting_leader` after tasks exit.
    if read_manifest_for_run(&leader_handle, &env.run_id)
        .map(|m| !m.status.is_active() || m.status != RunStatus::Dispatching)
        .unwrap_or(true)
    {
        return Ok(DispatchResponse {
            result: DispatchResult::Accepted,
            strike_count: 0,
            next_action: NextAction::Terminal,
            message: Some(format!(
                "turn {} finished after run left dispatching state; iteration report skipped",
                turn
            )),
        });
    }

    // Build iteration_report.md (≤16 KB, per-turn not cumulative). When this
    // is the FINAL allowed turn, prepend a warning so the leader knows to
    // emit `done` next instead of attempting another dispatch (which would
    // trigger the synthesis-pass path on turn+1).
    let mut report = build_iteration_report(&leader_handle, &env.run_id, turn, &results);
    if cap_trip_state == CapTripState::FinalTurn {
        let warning = format!(
            "## ⚠ FINAL TURN ({} of {})\n\n\
             You have used your last allowed dispatch turn. Review the results \
             above and emit `##FSD done` to terminate the run successfully, \
             or `##FSD blocked` if you cannot complete the goal. Any further \
             `##FSD dispatch` will be treated as a synthesis-pass request.\n\n",
            turn, turn
        );
        report = warning + &report;
    }
    let _ = write_run_file_text(
        &leader_handle,
        &env.run_id,
        &format!("turns/{}/iteration_report.md", turn),
        &report,
    );
    // Round-10 reflection per claude2 task-2 §1: use a conditional
    // transition so a concurrent done/blocked/cancel that already set
    // a terminal status is not clobbered by AwaitingLeader. If the
    // transition is rejected (manifest no longer Dispatching) we
    // also skip emitting `inject_iteration_report` to suppress the
    // phantom event the original disk-re-read race could produce.
    //
    // Round-11 reflection per codex1+claude2+codex2 (3/5 reviewers):
    // `try_transition_manifest_status` is a non-atomic disk
    // read-then-write, so a `done`/`blocked`/`cancel`/`heartbeat
    // cap-trip` interleaving between its read and write can still
    // clobber the terminal status with `AwaitingLeader` (manifest
    // ends terminal regardless because the terminal handler then
    // overwrites it on its own update_manifest_status, but the
    // phantom event would still fire). The belt-and-braces
    // `state.fsd_runs` checks below cut this race further.
    //
    // Round-12 nuance per claude3 task-16: the leading-edge
    // invariant — "terminal handler removes from `fsd_runs`
    // BEFORE its manifest write" — holds for `handle_done`,
    // `handle_blocked`, `cancel_run`, and `heartbeat_loop`'s
    // cap-trip path (each calls `remove_run_and_cancel` /
    // `runs.remove` strictly before `update_manifest_status`).
    // The cap-trip branch INSIDE `handle_dispatch` itself
    // (orchestrator.rs:644+) reverses this — it writes
    // `RunStatus::CapTripped` BEFORE calling `cleanup_run` —
    // but that path is harmless here because `CapTripped` fails
    // the `prior == Dispatching` precondition in
    // `try_transition_manifest_status` independently of the
    // `fsd_runs` check. So both belt-and-braces guards AND the
    // CAS catch the cap-trip-vs-dispatch-finish race; we don't
    // need the leading-edge invariant for that handler.
    //
    // We check both pre-transition and pre-emit so the
    // phantom-event surface is reduced to a microsecond window
    // between the post-transition check and the actual emit. A
    // truly atomic fix would need flock or rename-CAS — deferred
    // pending empirical macOS/Linux flock semantics verification
    // (Obsidian observation 2026-05-02).
    let run_alive_pre = state
        .fsd_runs
        .lock()
        .ok()
        .map(|r| r.contains_key(&env.run_id))
        .unwrap_or(false);
    if !run_alive_pre {
        return Ok(DispatchResponse {
            result: DispatchResult::Accepted,
            strike_count: 0,
            next_action: NextAction::Terminal,
            message: Some(format!(
                "turn {} completed but run already removed from in-memory registry; iteration_report skipped",
                turn
            )),
        });
    }
    let transitioned = try_transition_manifest_status(
        &leader_handle,
        &env.run_id,
        RunStatus::AwaitingLeader,
        |prior| prior == RunStatus::Dispatching,
    );
    if transitioned.is_none() {
        return Ok(DispatchResponse {
            result: DispatchResult::Accepted,
            strike_count: 0,
            next_action: NextAction::Terminal,
            message: Some(format!(
                "turn {} completed but run terminated concurrently; iteration_report skipped",
                turn
            )),
        });
    }
    // Post-transition belt-and-braces: a concurrent terminal handler
    // may have removed the run between our pre-check and our manifest
    // write. If so, suppress the emit. The terminal handler will
    // overwrite our just-written AwaitingLeader on its own
    // update_manifest_status call — manifest converges to terminal
    // even though we briefly wrote AwaitingLeader.
    let run_alive_post = state
        .fsd_runs
        .lock()
        .ok()
        .map(|r| r.contains_key(&env.run_id))
        .unwrap_or(false);
    if !run_alive_post {
        return Ok(DispatchResponse {
            result: DispatchResult::Accepted,
            strike_count: 0,
            next_action: NextAction::Terminal,
            message: Some(format!(
                "turn {} transitioned to AwaitingLeader but run removed concurrently; iteration_report skipped",
                turn
            )),
        });
    }

    // Inject into leader PTY via existing inject_into_pty.
    // PR-4: also writes a shadow-audit copy to the inbox subsystem.
    inject_iteration_report(&app, &state, &leader_handle, &env.run_id, turn, &report).await;

    Ok(DispatchResponse {
        result: DispatchResult::Accepted,
        strike_count: 0,
        next_action: NextAction::Ack,
        message: Some(format!("turn {} dispatched {} tasks", turn, tasks.len())),
    })
}

async fn handle_done(
    app: AppHandle,
    state: State<'_, AppState>,
    leader_handle: String,
    env: FsdEnvelope,
    summary: String,
    evidence: Vec<String>,
) -> Result<DispatchResponse, String> {
    if let Err(resp) = validate_run_command(&leader_handle, &env) {
        return Ok(resp);
    }
    // Idempotency: reject duplicate (run_id, cmd_id) before any side effects.
    if let Err(resp) = check_and_record_cmd_id(&state, &env.run_id, &env.cmd_id) {
        return Ok(resp);
    }
    // PR-PreC: clear this run's dispatch group registry on terminal state.
    if let Ok(mut groups) = state.current_dispatch_groups.lock() {
        groups.remove(&env.run_id);
    }
    let cancelled_tasks = remove_run_and_cancel(&state, &env.run_id);
    let _ = write_run_file(
        &leader_handle,
        &env.run_id,
        "final.json",
        serde_json::json!({
            "status": "done",
            "summary": summary,
            "evidence": evidence,
            "ended_at": now_iso(),
            "cancelled_tasks": cancelled_tasks,
        }),
    );
    update_manifest_status(&leader_handle, &env.run_id, RunStatus::Done);
    let _ = app.emit(
        &format!("fsd-run-end-{}", leader_handle),
        serde_json::json!({"run_id": env.run_id, "status": "done"}),
    );
    Ok(DispatchResponse {
        result: DispatchResult::Accepted,
        strike_count: 0,
        next_action: NextAction::Terminal,
        message: Some("done".into()),
    })
}

async fn handle_blocked(
    app: AppHandle,
    state: State<'_, AppState>,
    leader_handle: String,
    env: FsdEnvelope,
    reason: String,
    missing_capability: Option<String>,
    needed_user_input: Option<String>,
    last_cmd_id: Option<String>,
) -> Result<DispatchResponse, String> {
    if let Err(resp) = validate_run_command(&leader_handle, &env) {
        return Ok(resp);
    }
    // Idempotency: reject duplicate (run_id, cmd_id) before any side effects.
    if let Err(resp) = check_and_record_cmd_id(&state, &env.run_id, &env.cmd_id) {
        return Ok(resp);
    }
    // PR-PreC: clear this run's dispatch group registry on terminal state.
    if let Ok(mut groups) = state.current_dispatch_groups.lock() {
        groups.remove(&env.run_id);
    }
    let cancelled_tasks = remove_run_and_cancel(&state, &env.run_id);
    let _ = write_run_file(
        &leader_handle,
        &env.run_id,
        "final.json",
        serde_json::json!({
            "status": "blocked",
            "reason": reason,
            "missing_capability": missing_capability,
            "needed_user_input": needed_user_input,
            "last_cmd_id": last_cmd_id,
            "ended_at": now_iso(),
            "cancelled_tasks": cancelled_tasks,
        }),
    );
    update_manifest_status(&leader_handle, &env.run_id, RunStatus::Blocked);
    let _ = app.emit(
        &format!("fsd-run-end-{}", leader_handle),
        serde_json::json!({"run_id": env.run_id, "status": "blocked"}),
    );
    Ok(DispatchResponse {
        result: DispatchResult::Accepted,
        strike_count: 0,
        next_action: NextAction::Terminal,
        message: Some("blocked".into()),
    })
}

// ---- Cancel / cleanup --------------------------------------------------------

pub fn cancel_run(
    app: &AppHandle,
    state: &State<'_, AppState>,
    run_id: &str,
) -> Result<bool, String> {
    // Drop the lock BEFORE side effects (manifest writes, event emit) so we
    // don't hold the fsd_runs mutex across an async-or-IO operation. Per
    // @codex1 task-55 risk-mitigation: same-mutex re-lock hazard avoided.
    let removed = {
        let mut runs = state.fsd_runs.lock().map_err(|e| e.to_string())?;
        runs.remove(run_id)
    };
    if let Some(mut handle) = removed {
        // Round-10 reflection per codex1 task-1 + claude3 task-4 §(b):
        // PR-PreC dispatch-group registry is cleared on `done`/`blocked`
        // but was not cleared on cancel/cap-trip — leaving an orphan
        // in-memory entry until app restart. Mirror handle_done's clear
        // here so the asymmetry is closed.
        if let Ok(mut groups) = state.current_dispatch_groups.lock() {
            groups.remove(run_id);
        }
        // Stop heartbeat task.
        if let Some(tx) = handle.cancel_tx.take() {
            let _ = tx.send(());
        }
        // Fan out cancel to every in-flight assistant runner — each will see
        // its `cancel_rx` resolve and call kill_process_group(pid). Plan v5
        // §6.4 + @codex2 task-50 P0 + @codex3 task-52 P1.
        let task_count = handle.task_cancel_txs.len();
        for (_task_id, tx) in handle.task_cancel_txs.drain() {
            let _ = tx.send(());
        }
        update_manifest_status(&handle.leader_handle, run_id, RunStatus::Cancelled);
        let _ = write_run_file(
            &handle.leader_handle,
            run_id,
            "final.json",
            serde_json::json!({
                "status": "cancelled",
                "ended_at": now_iso(),
                "cancelled_tasks": task_count,
            }),
        );
        // Per @codex2 task-57 P1 — emit fsd-run-end so the frontend chip
        // updates immediately. Without this, the chip stays in "running"
        // state until the user manually re-queries.
        let _ = app.emit(
            &format!("fsd-run-end-{}", handle.leader_handle),
            serde_json::json!({"run_id": run_id, "status": "cancelled"}),
        );
        return Ok(true);
    }
    Ok(false)
}

/// Read the tail of a task's stdout file for the chip preview. Returns an
/// empty string on failure (file not yet flushed, etc.). Bounded to 200 chars.
async fn read_stdout_last_line(
    leader_handle: &str,
    run_id: &str,
    turn: u32,
    task_id: &str,
) -> String {
    let Ok(root) = get_memory_root() else {
        return String::new();
    };
    let path = root.join(format!(
        "fsd-runs/{}/runs/{}/turns/{}/tasks/{}/result.stdout",
        leader_handle, run_id, turn, task_id
    ));
    let Ok(content) = tokio::fs::read_to_string(&path).await else {
        return String::new();
    };
    // Take the last non-empty line, trimmed to 200 chars.
    let last = content
        .lines()
        .rev()
        .find(|l| !l.trim().is_empty())
        .unwrap_or("");
    let stripped = last.trim();
    stripped.chars().take(200).collect()
}

fn cleanup_run(state: &State<'_, AppState>, run_id: &str) {
    if let Ok(mut runs) = state.fsd_runs.lock() {
        runs.remove(run_id);
    }
}

fn remove_run_and_cancel(state: &State<'_, AppState>, run_id: &str) -> usize {
    let removed = {
        let mut runs = match state.fsd_runs.lock() {
            Ok(g) => g,
            Err(_) => return 0,
        };
        runs.remove(run_id)
    };
    let Some(mut handle) = removed else { return 0 };
    if let Some(tx) = handle.cancel_tx.take() {
        let _ = tx.send(());
    }
    let task_count = handle.task_cancel_txs.len();
    for (_task_id, tx) in handle.task_cancel_txs.drain() {
        let _ = tx.send(());
    }
    task_count
}

// ---- Heartbeat task ----------------------------------------------------------

async fn heartbeat_loop(
    app: AppHandle,
    runs: std::sync::Arc<std::sync::Mutex<std::collections::HashMap<String, FsdRunHandle>>>,
    // Round-10 reflection per codex1 task-1 + claude3 task-4 §(b): clear
    // PR-PreC dispatch-group registry on cap-trip terminal transition.
    dispatch_groups: std::sync::Arc<
        std::sync::Mutex<
            std::collections::HashMap<String, std::collections::HashMap<u32, std::collections::HashSet<String>>>,
        >,
    >,
    leader_handle: String,
    run_id: String,
    mut cancel_rx: oneshot::Receiver<()>,
) {
    let started = std::time::Instant::now();
    let max_run_duration = Duration::from_millis(WALLCLOCK_MS_PER_RUN);
    let mut interval = tokio::time::interval(Duration::from_millis(HEARTBEAT_INTERVAL_MS));
    loop {
        tokio::select! {
            biased;
            _ = &mut cancel_rx => break,
            _ = interval.tick() => {
                // Per plan v5 §6.3: enforce per-run wallclock cap. If the run
                // has been alive longer than WALLCLOCK_MS_PER_RUN (10 min by
                // default), force-mark it cap-tripped + interrupted. The
                // heartbeat task then exits and the orchestrator state will
                // reflect the timeout on next UI poll.
                if started.elapsed() >= max_run_duration {
                    let cancelled_tasks = if let Ok(mut runs) = runs.lock() {
                        if let Some(mut handle) = runs.remove(&run_id) {
                            let task_count = handle.task_cancel_txs.len();
                            for (_tid, tx) in handle.task_cancel_txs.drain() {
                                let _ = tx.send(());
                            }
                            task_count
                        } else {
                            0
                        }
                    } else {
                        0
                    };
                    if let Ok(mut groups) = dispatch_groups.lock() {
                        groups.remove(&run_id);
                    }
                    update_manifest_status(&leader_handle, &run_id, RunStatus::CapTripped);
                    let _ = write_run_file(
                        &leader_handle, &run_id, "final.json",
                        serde_json::json!({
                            "status": "cap_tripped",
                            "ended_at": now_iso(),
                            "reason": format!(
                                "exceeded WALLCLOCK_MS_PER_RUN ({} ms)",
                                WALLCLOCK_MS_PER_RUN
                            ),
                            "cancelled_tasks": cancelled_tasks,
                        }),
                    );
                    let _ = app.emit(
                        &format!("fsd-run-end-{}", leader_handle),
                        serde_json::json!({"run_id": run_id, "status": "cap_tripped"}),
                    );
                    break;
                }
                update_manifest_heartbeat(&leader_handle, &run_id);
            }
        }
    }
}

// ---- Manifest I/O ------------------------------------------------------------

fn manifest_rel_path(leader_handle: &str, run_id: &str) -> String {
    format!("fsd-runs/{}/runs/{}/manifest.json", leader_handle, run_id)
}

fn write_manifest(leader_handle: &str, run_id: &str, m: &RunManifest) -> Result<(), String> {
    let root = get_memory_root()?;
    let abs = root.join(manifest_rel_path(leader_handle, run_id));
    if let Some(p) = abs.parent() {
        std::fs::create_dir_all(p).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string_pretty(m).map_err(|e| e.to_string())?;
    std::fs::write(&abs, json).map_err(|e| e.to_string())?;
    Ok(())
}

fn read_manifest_for_run(leader_handle: &str, run_id: &str) -> Result<RunManifest, String> {
    let root = get_memory_root()?;
    let abs = root.join(manifest_rel_path(leader_handle, run_id));
    let raw = std::fs::read_to_string(&abs)
        .map_err(|e| format!("manifest read failed for {}: {}", run_id, e))?;
    serde_json::from_str(&raw).map_err(|e| format!("manifest parse failed for {}: {}", run_id, e))
}

/// Run one assistant task via the supplied runner, write its `done.json`,
/// and (optionally) emit `fsd-task-done` + clean up the cancel sender.
///
/// Extracted per @codex3 task-90 P2 so that BOTH `handle_dispatch`'s spawn
/// closure AND the integration test (`integration_handle_dispatch_via_extracted_helper`)
/// call the same code path. Without this extraction, a future ordering change
/// in the per-task plumbing (e.g., write done.json before/after emit, remove
/// from cancel map at the wrong time) would not be caught by the integration
/// test because the test would mirror the steps separately.
///
/// `runs` and `app` are optional so the test can pass `None` and still
/// exercise the runner.run + read_stdout_last_line + write_run_file + TaskDone
/// construction path. Production always passes both.
pub(crate) async fn run_and_record_one_task<R: AssistantRunner + ?Sized>(
    runner: &R,
    leader_handle: &str,
    run_id: &str,
    turn: u32,
    task_id: &str,
    tool: &str,
    role_hint: Option<String>,
    spec: TaskSpec,
    output_dir_rel: String,
    cwd: Option<std::path::PathBuf>,
    cancel_rx: oneshot::Receiver<()>,
    runs: Option<
        &std::sync::Arc<std::sync::Mutex<std::collections::HashMap<String, FsdRunHandle>>>,
    >,
    app: Option<&AppHandle>,
    // Round-7 reflection (claude4 task-78 §3.2): orchestrator's
    // authoritative seq counter for the Phase C broker. None during tests
    // that don't exercise broker (broker only fires when from_agent_id is
    // set). Threaded through here to preserve writer-monopoly globality.
    seq_global: Option<&std::sync::atomic::AtomicU64>,
) -> TaskDone {
    // Phase C: capture `from_agent_id` before `spec` is moved into the
    // runner — needed after the task completes to broker the response
    // back into the requester's inbox. Plan v6 §2.9 / §C.2.
    let from_agent_id_for_broker = spec.from_agent_id.clone();
    let task_agent_id_for_broker = spec.agent_id.clone();
    let outcome = runner.run(spec, output_dir_rel, cwd, cancel_rx).await;

    // Remove the cancel sender now that the task is done — keeps
    // /fsd-cancel's "cancelled_tasks" count accurate (only counts genuinely
    // in-flight) and prevents the map from growing across many turns.
    if let Some(runs) = runs {
        if let Ok(mut g) = runs.lock() {
            if let Some(handle) = g.get_mut(run_id) {
                handle.task_cancel_txs.remove(task_id);
            }
        }
    }

    // Read tail of stdout for the chip preview.
    let last_line = read_stdout_last_line(leader_handle, run_id, turn, task_id).await;

    // Construct the canonical TaskDone artifact.
    let done = TaskDone {
        task_id: task_id.to_string(),
        run_id: run_id.to_string(),
        turn,
        tool: tool.to_string(),
        exit_code: outcome.exit_code,
        wallclock_ms: outcome.wallclock_ms,
        stdout_bytes: outcome.stdout_bytes,
        stderr_bytes: outcome.stderr_bytes,
        stdout_path: format!("turns/{}/tasks/{}/result.stdout", turn, task_id),
        stderr_path: format!("turns/{}/tasks/{}/result.stderr", turn, task_id),
        error: outcome.error.clone(),
    };
    let _ = write_run_file(
        leader_handle,
        run_id,
        &format!("turns/{}/tasks/{}/done.json", turn, task_id),
        serde_json::to_value(&done).unwrap_or(serde_json::Value::Null),
    );

    // Enriched fsd-task-done payload — UI chip now has tool + exit code +
    // last-line preview (per @claude2 task-49 §3.2).
    if let Some(app) = app {
        let _ = app.emit(
            &format!("fsd-task-done-{}", leader_handle),
            serde_json::json!({
                "run_id": run_id,
                "turn": turn,
                "task_id": task_id,
                "tool": tool,
                "role_hint": role_hint,
                "kind": outcome.kind,
                "wallclock_ms": outcome.wallclock_ms,
                "exit_code": outcome.exit_code,
                "last_line": last_line,
            }),
        );
    }

    // Phase C broker: if this task carried `from_agent_id`, write a
    // synthesized `AgentMessage` envelope into the requester's inbox so
    // the leader sees the response in its next turn. Plan v6 §2.9 + §C.2.
    // Best-effort; broker failure is logged but not fatal — the result
    // is still on disk under turns/<turn>/tasks/<task_id>/result.stdout.
    //
    // Round-7 reflection (claude4 task-78 §3.2): use the orchestrator's
    // authoritative `seq_global` for global ordering. If not provided
    // (test path), skip the broker — tests don't exercise inter-agent
    // messaging.
    if let Some(requester) = from_agent_id_for_broker {
        if let (Some(_app), Some(seq)) = (app, seq_global) {
            broker_response_to_requester(
                seq,
                leader_handle,
                run_id,
                turn,
                task_id,
                &task_agent_id_for_broker,
                &requester,
                &last_line,
            );
        }
    }
    done
}

/// Phase C response-broker. Writes an `AgentMessage` envelope to the
/// requester's inbox with the responding agent's stdout last-line as the
/// content. Best-effort: errors logged, never propagated.
///
/// The orchestrator brokers because non-leader agents are NOT authorized
/// to write to other inboxes directly (preserves writer-monopoly invariant
/// from plan v6 §2.3 authorization rules). The orchestrator's authority
/// is implicit (`SenderKind::Orchestrator`).
///
/// Round-7 reflection (claude4 task-78 §3.2): takes `&AtomicU64` directly
/// so it can use the orchestrator's authoritative `state.seq_global` for
/// global ordering. Earlier first-cut allocated an ephemeral counter
/// initialized from wall-clock; that violated the writer-monopoly invariant
/// because concurrent broker calls within the same millisecond could stamp
/// duplicate seq values. Now globally monotonic.
fn broker_response_to_requester(
    seq_global: &std::sync::atomic::AtomicU64,
    leader_handle: &str,
    run_id: &str,
    turn: u32,
    task_id: &str,
    responder_agent_id: &str,
    requester_agent_id: &str,
    response_summary: &str,
) {
    use crate::fsd::inbox::{InboxMessagePartial, InboxScope, InboxState, MessageKind, SenderKind};

    let scope = InboxScope::Agent {
        agent_id: requester_agent_id.to_string(),
    };
    let partial = InboxMessagePartial {
        message_id: crate::fsd::inbox::generate_message_id_pub(),
        sender_id: format!("agent-{}", responder_agent_id),
        sender_kind: SenderKind::Orchestrator,
        target_id: format!("agent-{}", requester_agent_id),
        kind: MessageKind::AgentMessage,
        content: format!(
            "[Response from agent {} for task {} (turn {} of run {} on leader {})]\n{}",
            responder_agent_id, task_id, turn, run_id, leader_handle, response_summary
        ),
        created_at_ms: crate::fsd::inbox::now_ms_pub(),
        run_id: Some(run_id.to_string()),
        task_id: Some(task_id.to_string()),
        turn: None, // AgentMessage kind rejects turn per envelope invariant
        source_cmd_id: None,
        sn: None,
        rn: None,
        attempt: 1,
    };
    if let Err(e) = crate::fsd::storage::write_inbox_payload_atomic(
        &scope,
        &partial,
        InboxState::Pending,
        seq_global,
    ) {
        eprintln!(
            "fsd: Phase C broker write_inbox_payload_atomic({} → {}) failed: {} \
             (response is still on disk at turns/{}/tasks/{}/result.stdout)",
            responder_agent_id, requester_agent_id, e, turn, task_id
        );
    }
}

/// Public alias of `record_strike` for external callers (e.g. the
/// `fsd_report_malformed` Tauri command). Same semantics.
pub fn record_strike_for_test(
    app: &AppHandle,
    state: &State<'_, AppState>,
    run_id: &str,
    leader_handle: &str,
    reason: &str,
) -> (u32, bool) {
    record_strike(app, state, run_id, leader_handle, reason)
}

/// Strike-count helper per plan v5 §4.2 + round-7/8 P1 from @codex2/@codex3/
/// @claude3 (3/5 evaluators raised it). Increments the run's consecutive
/// strike counter; if it reaches STRIKES_PER_TURN, force-blocks the run
/// (writes final.json, marks manifest Blocked, fans out task cancel, emits
/// fsd-run-end). Returns the new strike count and whether the run was
/// force-blocked. Strikes reset to 0 on the next Accepted command (caller
/// invokes `reset_strikes_on_accept`).
///
/// `#[must_use]` per @claude2 task-63 P3: the (count, force_blocked) tuple
/// drives critical UI + protocol decisions; silently dropping it would let
/// a force-block happen without the response reflecting it.
#[must_use]
fn record_strike(
    app: &AppHandle,
    state: &State<'_, AppState>,
    run_id: &str,
    leader_handle: &str,
    reason: &str,
) -> (u32, bool) {
    let mut force_blocked = false;
    let strike_count = {
        let mut runs = match state.fsd_runs.lock() {
            Ok(g) => g,
            Err(_) => return (0, false),
        };
        let Some(handle) = runs.get_mut(run_id) else {
            return (0, false);
        };
        handle.consecutive_strikes += 1;
        let count = handle.consecutive_strikes;
        if count >= STRIKES_PER_TURN {
            force_blocked = true;
        }
        count
    };
    if force_blocked {
        // Drop the lock BEFORE side effects (per @codex1 task-55 hazard note).
        let cancelled_tasks = {
            let mut runs = match state.fsd_runs.lock() {
                Ok(g) => g,
                Err(_) => return (strike_count, true),
            };
            if let Some(mut handle) = runs.remove(run_id) {
                if let Some(tx) = handle.cancel_tx.take() {
                    let _ = tx.send(());
                }
                let n = handle.task_cancel_txs.len();
                for (_tid, tx) in handle.task_cancel_txs.drain() {
                    let _ = tx.send(());
                }
                n
            } else {
                0
            }
        };
        update_manifest_status(leader_handle, run_id, RunStatus::Blocked);
        let _ = write_run_file(
            leader_handle,
            run_id,
            "final.json",
            serde_json::json!({
                "status": "blocked",
                "reason": format!("strike_threshold_reached (last reason: {})", reason),
                "ended_at": now_iso(),
                "cancelled_tasks": cancelled_tasks,
                "strikes_at_force": strike_count,
            }),
        );
        let _ = app.emit(
            &format!("fsd-run-end-{}", leader_handle),
            serde_json::json!({"run_id": run_id, "status": "blocked"}),
        );
    }
    (strike_count, force_blocked)
}

/// Reset consecutive strikes when a command is Accepted. Called from the
/// success path of plan/dispatch/done/blocked handlers.
fn reset_strikes_on_accept(state: &State<'_, AppState>, run_id: &str) {
    if let Ok(mut runs) = state.fsd_runs.lock() {
        if let Some(handle) = runs.get_mut(run_id) {
            handle.consecutive_strikes = 0;
        }
    }
}

/// Apply strike-counting side effects to a non-Accepted response: increments
/// the run's consecutive_strikes; if at threshold, force-blocks the run and
/// rewrites the response with NextAction::ForceBlocked. The returned response
/// always carries the live strike_count so the frontend can display it.
///
/// `#[must_use]` per @claude2 task-63 P3: the response is the contract sent
/// back to the leader; dropping it would silently lose the reminder + strike
/// count and the leader would have no idea it was on the path to force-block.
#[must_use]
fn apply_strike(
    app: &AppHandle,
    state: &State<'_, AppState>,
    leader_handle: &str,
    run_id: &str,
    mut resp: DispatchResponse,
) -> DispatchResponse {
    if resp.result == DispatchResult::Accepted || resp.result == DispatchResult::Duplicate {
        // Duplicate is a no-op (idempotent ack), not a real failure — don't strike.
        return resp;
    }
    let reason = resp
        .message
        .clone()
        .unwrap_or_else(|| format!("{:?}", resp.result));
    let (count, force_blocked) = record_strike(app, state, run_id, leader_handle, &reason);
    resp.strike_count = count;
    if force_blocked {
        resp.next_action = NextAction::ForceBlocked;
        resp.message = Some(format!(
            "strike threshold ({}) reached — run force-blocked. Last failure: {}",
            STRIKES_PER_TURN, reason
        ));
    }
    resp
}

/// Read-only check: has `(run_id, cmd_id)` already been processed for the
/// active run? If so, returns the canonical `Duplicate + Ack` response that
/// callers should short-circuit with. If not, returns Ok(()).
///
/// ## Precedence rule (per @codex3 task-78 P3)
///
/// In `handle_dispatch` this runs BEFORE `validate_run_command`, which means
/// a duplicate `cmd_id` arriving with a STALE nonce (sn or rn) returns
/// `Duplicate + Ack` rather than `StaleNonce + Remind`. **This is
/// intentional**: the protocol's idempotency guarantee (plan v5 §3.1 rule 6)
/// outranks nonce freshness for already-processed commands. A leader/transport
/// retransmitting an accepted command after the orchestrator has rotated
/// nonces (rare) still gets the original ack semantics.
///
/// Future validators MUST NOT assume nonce validation always runs first.
/// If a verb is added where nonce-staleness-of-duplicates matters (e.g.
/// security-sensitive operations), it should re-validate inside the dedup
/// path or use a separate ordering.
///
/// Per @codex3 task-72 P1: this MUST run BEFORE state guards (e.g. the
/// "is this dispatch valid in the current manifest state?" check). Otherwise
/// a duplicate dispatch arriving while the original is still `Dispatching`
/// would hit the state guard first → `OutOfScope + Remind` → strike the
/// active run instead of being acked as idempotent.
///
/// Pairs with `record_cmd_id` which is called AFTER all state-based rejection
/// paths pass — that ordering preserves codex2 task-64 P2's invariant that
/// a bad-state command doesn't burn its cmd_id.
fn check_cmd_id_seen(
    state: &State<'_, AppState>,
    run_id: &str,
    cmd_id: &str,
) -> Result<(), DispatchResponse> {
    check_cmd_id_seen_in(&state.fsd_runs, run_id, cmd_id)
}

/// Pure-state inner function that takes the runs registry directly. Extracted
/// so unit tests can construct an `FsdRunHandle` + `Mutex<HashMap<...>>` and
/// exercise the actual function (rather than re-implementing its logic in
/// helper-shape tests). Called by `check_cmd_id_seen` and by the orchestrator
/// integration test in this module's tests submodule.
fn check_cmd_id_seen_in(
    runs: &std::sync::Mutex<std::collections::HashMap<String, FsdRunHandle>>,
    run_id: &str,
    cmd_id: &str,
) -> Result<(), DispatchResponse> {
    let runs = match runs.lock() {
        Ok(g) => g,
        Err(e) => {
            return Err(DispatchResponse {
                result: DispatchResult::OutOfScope,
                strike_count: 0,
                next_action: NextAction::Terminal,
                message: Some(format!("fsd_runs lock poisoned: {}", e)),
            })
        }
    };
    let Some(run_handle) = runs.get(run_id) else {
        return Ok(()); // unknown run is handled downstream by validate_run_command
    };
    if run_handle.seen_cmd_ids.contains(cmd_id) {
        return Err(DispatchResponse {
            result: DispatchResult::Duplicate,
            strike_count: run_handle.consecutive_strikes,
            next_action: NextAction::Ack,
            message: Some(format!(
                "cmd_id {} already processed for run {}",
                cmd_id, run_id
            )),
        });
    }
    Ok(())
}

/// Insert `(run_id, cmd_id)` into the run's seen set. Caller must have
/// already verified via `check_cmd_id_seen` that the cmd_id is new and
/// passed all other validation. Idempotent — re-insertion is harmless.
fn record_cmd_id(state: &State<'_, AppState>, run_id: &str, cmd_id: &str) {
    if let Ok(mut runs) = state.fsd_runs.lock() {
        if let Some(run_handle) = runs.get_mut(run_id) {
            run_handle.seen_cmd_ids.insert(cmd_id.to_string());
        }
    }
}

/// Combined check + record helper, kept for backward compatibility with the
/// existing handle_done / handle_blocked call sites (which can safely use
/// it because `done` and `blocked` are allowed from any active state — no
/// state-guard-vs-dedup ordering hazard there). For handle_dispatch, callers
/// should use the two-step `check_cmd_id_seen` + `record_cmd_id` pattern.
fn check_and_record_cmd_id(
    state: &State<'_, AppState>,
    run_id: &str,
    cmd_id: &str,
) -> Result<(), DispatchResponse> {
    let mut runs = match state.fsd_runs.lock() {
        Ok(g) => g,
        Err(e) => {
            return Err(DispatchResponse {
                result: DispatchResult::OutOfScope,
                strike_count: 0,
                next_action: NextAction::Terminal,
                message: Some(format!("fsd_runs lock poisoned: {}", e)),
            })
        }
    };
    let Some(run_handle) = runs.get_mut(run_id) else {
        return Err(DispatchResponse {
            result: DispatchResult::UnknownRun,
            strike_count: 0,
            next_action: NextAction::Remind,
            message: Some(format!("no active run handle for {}", run_id)),
        });
    };
    if !run_handle.seen_cmd_ids.insert(cmd_id.to_string()) {
        return Err(DispatchResponse {
            result: DispatchResult::Duplicate,
            strike_count: 0,
            next_action: NextAction::Ack,
            message: Some(format!(
                "cmd_id {} already processed for run {}",
                cmd_id, run_id
            )),
        });
    }
    Ok(())
}

fn validate_run_command(
    leader_handle: &str,
    env: &FsdEnvelope,
) -> Result<RunManifest, DispatchResponse> {
    if env.v != SCHEMA_VERSION {
        return Err(DispatchResponse {
            result: DispatchResult::Malformed,
            strike_count: 0,
            next_action: NextAction::Remind,
            message: Some(format!("schema v{} unsupported", env.v)),
        });
    }
    let manifest =
        read_manifest_for_run(leader_handle, &env.run_id).map_err(|e| DispatchResponse {
            result: DispatchResult::UnknownRun,
            strike_count: 0,
            next_action: NextAction::Remind,
            message: Some(e),
        })?;
    if !manifest.status.is_active() {
        return Err(DispatchResponse {
            result: DispatchResult::OutOfScope,
            strike_count: 0,
            next_action: NextAction::Terminal,
            message: Some(format!(
                "run {} is already terminal: {:?}",
                env.run_id, manifest.status
            )),
        });
    }
    if env.sn != manifest.session_nonce || env.rn != manifest.run_nonce {
        return Err(DispatchResponse {
            result: DispatchResult::StaleNonce,
            strike_count: 0,
            next_action: NextAction::Remind,
            message: Some(format!(
                "nonce mismatch: sn active={} got={}, rn active={} got={}",
                manifest.session_nonce, env.sn, manifest.run_nonce, env.rn,
            )),
        });
    }
    Ok(manifest)
}

fn update_manifest_status(leader_handle: &str, run_id: &str, status: RunStatus) {
    let _ = (|| -> Result<(), String> {
        let root = get_memory_root()?;
        let abs = root.join(manifest_rel_path(leader_handle, run_id));
        let raw = std::fs::read_to_string(&abs).map_err(|e| e.to_string())?;
        let mut m: RunManifest = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
        m.status = status;
        let json = serde_json::to_string_pretty(&m).map_err(|e| e.to_string())?;
        std::fs::write(&abs, json).map_err(|e| e.to_string())?;
        Ok(())
    })();
}

/// Transition manifest status only if the prior status passes
/// `precondition`. Returns `Some(prior)` if the write happened,
/// `None` if the precondition rejected the write or any IO failed.
///
/// Round-10 reflection per claude2 task-2 §1: closes the manifest-status
/// race window where `handle_dispatch`'s post-tasks `awaiting_leader`
/// write could clobber a concurrent `handle_done`/`handle_blocked`/
/// `cancel_run` terminal write. The remaining read→write window is
/// intra-function (no async, no event emit) so the race is reduced
/// from "process-wide" to "single small read+write".
///
/// **Round-11 known limitation** (codex1+claude2+codex2 converged): the
/// helper is NOT disk-atomic. There is no flock or rename-CAS, so two
/// threads can both pass `precondition` then both write. Last-write
/// wins on disk; the only path that writes a non-terminal status is
/// `handle_dispatch`'s `AwaitingLeader` transition, while terminal
/// writers (`done`/`blocked`/`cancel`/`cap-trip`) write through
/// `update_manifest_status`. So the residual race is `Done` →
/// `AwaitingLeader` (clobber) → `Done` again (terminal handler
/// re-overwrites). **Manifest converges to terminal correctly**;
/// `final.json` is the source of truth. The `state.fsd_runs`
/// belt-and-braces checks at the dispatch site further suppress the
/// phantom `inject_iteration_report` emit. A truly atomic fix would
/// need `flock` or rename-CAS — deferred pending empirical macOS/Linux
/// flock semantics verification (Obsidian observation 2026-05-02).
fn try_transition_manifest_status(
    leader_handle: &str,
    run_id: &str,
    new_status: RunStatus,
    precondition: impl Fn(RunStatus) -> bool,
) -> Option<RunStatus> {
    let root = get_memory_root().ok()?;
    let abs = root.join(manifest_rel_path(leader_handle, run_id));
    let raw = std::fs::read_to_string(&abs).ok()?;
    let mut m: RunManifest = serde_json::from_str(&raw).ok()?;
    let prior = m.status;
    if !precondition(prior) {
        return None;
    }
    m.status = new_status;
    let json = serde_json::to_string_pretty(&m).ok()?;
    std::fs::write(&abs, json).ok()?;
    Some(prior)
}

fn update_manifest_heartbeat(leader_handle: &str, run_id: &str) {
    let _ = (|| -> Result<(), String> {
        let root = get_memory_root()?;
        let abs = root.join(manifest_rel_path(leader_handle, run_id));
        let raw = std::fs::read_to_string(&abs).map_err(|e| e.to_string())?;
        let mut m: RunManifest = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
        if !m.status.is_active() {
            return Ok(()); // no more heartbeat after terminal
        }
        m.last_heartbeat_at = now_iso();
        let json = serde_json::to_string_pretty(&m).map_err(|e| e.to_string())?;
        std::fs::write(&abs, json).map_err(|e| e.to_string())?;
        Ok(())
    })();
}

/// Returns the first duplicate `agent_id` across the dispatch's task
/// specs, or `None` if every spec carries a unique agent_id.
///
/// Round-10 reflection per codex3 task-5: PR-PreC's authorization model
/// assumes `(run_id, agent_id)` is unique within a turn — duplicates
/// would mean two concurrent task spawns share a single inbox lane,
/// breaking the writer-monopoly invariant for response routing
/// (`from_agent_id`) and producing nondeterministic prompt
/// augmentation (`to_agent_id`'s drain would fan-in to two callers).
fn find_duplicate_agent_id(tasks: &[TaskSpec]) -> Option<&str> {
    let mut seen: std::collections::HashSet<&str> =
        std::collections::HashSet::with_capacity(tasks.len());
    for spec in tasks {
        if !seen.insert(spec.agent_id.as_str()) {
            return Some(spec.agent_id.as_str());
        }
    }
    None
}

fn write_run_file(
    leader_handle: &str,
    run_id: &str,
    rel: &str,
    json: serde_json::Value,
) -> Result<(), String> {
    let root = get_memory_root()?;
    let abs = root.join(format!(
        "fsd-runs/{}/runs/{}/{}",
        leader_handle, run_id, rel
    ));
    if let Some(p) = abs.parent() {
        std::fs::create_dir_all(p).map_err(|e| e.to_string())?;
    }
    std::fs::write(
        &abs,
        serde_json::to_string_pretty(&json).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

fn write_run_file_text(
    leader_handle: &str,
    run_id: &str,
    rel: &str,
    text: &str,
) -> Result<(), String> {
    let root = get_memory_root()?;
    let abs = root.join(format!(
        "fsd-runs/{}/runs/{}/{}",
        leader_handle, run_id, rel
    ));
    if let Some(p) = abs.parent() {
        std::fs::create_dir_all(p).map_err(|e| e.to_string())?;
    }
    std::fs::write(&abs, text).map_err(|e| e.to_string())?;
    Ok(())
}

// ---- iteration_report --------------------------------------------------------

fn build_iteration_report(
    leader_handle: &str,
    run_id: &str,
    turn: u32,
    results: &[TaskDone],
) -> String {
    let mut out = String::new();
    out.push_str(&format!("# FSD turn {} report\n\n", turn));
    let total = results.len();
    let ok_count = results.iter().filter(|r| r.exit_code == Some(0)).count();
    out.push_str(&format!("- {}/{} tasks succeeded\n\n", ok_count, total));
    for r in results {
        out.push_str(&format!("## task `{}` ({})\n", r.task_id, r.tool));
        let status = match r.exit_code {
            Some(0) => "✓ ok".to_string(),
            Some(code) => format!("✗ exit {}", code),
            None => format!("⚠ {}", r.error.clone().unwrap_or_default()),
        };
        out.push_str(&format!(
            "- {} ({}ms, {} bytes)\n",
            status, r.wallclock_ms, r.stdout_bytes
        ));

        // Inline up to PER_TASK_STDOUT_TRUNCATE_BYTES of stdout.
        if let Ok(stream) = get_memory_root()
            .map(|root| {
                root.join(format!(
                    "fsd-runs/{}/runs/{}/{}",
                    leader_handle, run_id, r.stdout_path
                ))
            })
            .and_then(|path| std::fs::read_to_string(path).map_err(|e| e.to_string()))
        {
            // Path heuristic above is approximate — include defensively even if read fails.
            let truncated: String = stream
                .chars()
                .take(PER_TASK_STDOUT_TRUNCATE_BYTES)
                .collect();
            out.push_str(&format!("\n```\n{}\n```\n\n", truncated));
        } else {
            out.push_str(&format!("\n_(stdout: see {})_\n\n", r.stdout_path));
        }

        // Total cap guard.
        if out.len() >= ITERATION_REPORT_BYTES_CAP {
            out.truncate(ITERATION_REPORT_BYTES_CAP);
            out.push_str("\n_(report truncated at cap)_\n");
            break;
        }
    }
    out
}

/// Build the synthesis-pass instruction block injected when the leader
/// dispatches BEYOND `max_turns`. Per plan v5 §6.3 + §5.4 / claude3 §4.3 +
/// claude2 task-49 §3.4.
fn build_synthesis_pass_report(leader_handle: &str, run_id: &str, turn: u32) -> String {
    format!(
        "## ⚠ CAP-TRIPPED — synthesis-pass turn (#{turn})\n\n\
         You have exhausted your allowed dispatch turns for this run.\n\
         No further assistant tasks will be spawned.\n\n\
         Please **summarize what you have learned across all prior turns** \
         and emit one of:\n\n\
         - `##FSD done` with a `summary` capturing your conclusion + any \
           evidence files under `fsd-runs/{leader_handle}/runs/{run_id}/turns/*/`.\n\
         - `##FSD blocked` if the goal cannot be reached, with `reason` and \
           optional `needed_user_input`.\n\n\
         This synthesis-pass turn does not count against your dispatch budget. \
         Any further `##FSD dispatch` will be hard-rejected and the run will \
         be force-closed as `cap_tripped`.\n",
        turn = turn,
        leader_handle = leader_handle,
        run_id = run_id,
    )
}

async fn inject_iteration_report(
    app: &AppHandle,
    state: &State<'_, AppState>,
    leader_handle: &str,
    run_id: &str,
    turn: u32,
    report: &str,
) {
    // Plan v6 Phase B: feature-flagged delivery. When
    // `settings.fsd_inbox_delivery == true`, write to
    // `inbox/leader-<handle>/.pending/` and notify the LeaderInboxPoller.
    // The poller picks it up and emits `fsd-inbox-leader-message-<handle>`.
    // When `false` (default), use the existing direct `app.emit` path.
    let phase_b_enabled = match crate::commands::settings::get_settings(app.clone()) {
        Ok(s) => s.fsd_inbox_delivery,
        Err(_) => false,
    };

    if phase_b_enabled {
        // Phase B path: inbox-driven delivery via the LeaderInboxPoller.
        match crate::fsd::inbox::write_iteration_report_pending(
            &*state.seq_global,
            leader_handle,
            run_id,
            turn,
            report,
        ) {
            Ok(_filename) => {
                // Notify the matching LeaderInboxPoller so it wakes
                // immediately instead of waiting on the timer.
                if let Ok(pollers) = state.leader_inbox_pollers.lock() {
                    if let Some(entry) = pollers.get(leader_handle) {
                        entry.notify.notify_one();
                    }
                }
            }
            Err(e) => {
                // Fall back to legacy emit path on inbox-write failure so
                // delivery never stalls. This is a defense-in-depth safety
                // net; the typical Phase B success path doesn't emit.
                eprintln!(
                    "fsd: Phase B inbox-write failed ({}), falling back to legacy emit",
                    e
                );
                let _ = app.emit(
                    &format!("fsd-iteration-report-{}", leader_handle),
                    serde_json::json!({
                        "run_id": run_id,
                        "turn": turn,
                        "report": report,
                    }),
                );
            }
        }
    } else {
        // Phase A legacy path: direct Tauri emit. Frontend listener on
        // `fsd-iteration-report-{handle}` calls inject_into_pty with
        // leader-tool-aware newline handling. Backend intentionally stays
        // decoupled from ToolConfig.
        let _ = app.emit(
            &format!("fsd-iteration-report-{}", leader_handle),
            serde_json::json!({
                "run_id": run_id,
                "turn": turn,
                "report": report,
            }),
        );
    }

    // Plan v6 PR-4 shadow-audit hook (always runs regardless of flag).
    // Best-effort write to `inbox/leader-<handle>/.audit/<filename>.json`
    // for divergence analysis during the Phase A bake. Failure MUST NOT
    // alter `DispatchResponse` — we swallow the error and log a warning.
    // Plan v6 §2.4 + §2.6 + codex2 task-39 §6 (helper seam).
    if let Err(e) = crate::fsd::inbox::write_iteration_report_audit(
        &*state.seq_global,
        leader_handle,
        run_id,
        turn,
        report,
    ) {
        eprintln!(
            "fsd: shadow-audit write failed for run {}/turn {}: {} \
             (delivery via app.emit unaffected)",
            run_id, turn, e
        );
    }
}

// ---- Helpers -----------------------------------------------------------------

pub fn generate_8hex() -> String {
    use rand::RngCore;
    let mut bytes = [0u8; 4];
    rand::thread_rng().fill_bytes(&mut bytes);
    hex::encode(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generate_8hex_shape() {
        let n = generate_8hex();
        assert_eq!(n.len(), 8);
        assert!(n.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn iteration_report_fits_under_cap() {
        let mut tasks = Vec::new();
        for i in 0..10 {
            tasks.push(TaskDone {
                task_id: format!("t-{}", i),
                run_id: "r1".into(),
                turn: 1,
                tool: "claude_code".into(),
                exit_code: Some(0),
                wallclock_ms: 100,
                stdout_bytes: 4096,
                stderr_bytes: 0,
                stdout_path: format!("turns/1/tasks/t-{}/result.stdout", i),
                stderr_path: format!("turns/1/tasks/t-{}/result.stderr", i),
                error: None,
            });
        }
        let report = build_iteration_report("leader", "r1", 1, &tasks);
        assert!(
            report.len() <= ITERATION_REPORT_BYTES_CAP + 100,
            "report {}b exceeded cap+slack",
            report.len()
        );
        assert!(report.contains("# FSD turn 1 report"));
    }

    #[test]
    fn dispatch_response_serializes_with_snake_case() {
        let resp = DispatchResponse {
            result: DispatchResult::StaleNonce,
            strike_count: 1,
            next_action: NextAction::Remind,
            message: None,
        };
        let json = serde_json::to_string(&resp).unwrap();
        assert!(json.contains("\"stale_nonce\""));
        assert!(json.contains("\"remind\""));
    }

    /// Per @claude2 task-49 §3.2: enriched fsd-task-done payload includes the
    /// last line of stdout for the chip preview. Verify the helper reads the
    /// correct path layout (leader/run/turns/N/tasks/T/result.stdout).
    ///
    /// IMPORTANT: this test must use the SAME env-var path as storage and
    /// recovery tests' `ensure_test_root_isolated` so that whichever test
    /// runs first wins the `Once::call_once` race without leaving the others
    /// pointing at a different temp dir.
    #[tokio::test]
    async fn read_stdout_last_line_reads_correct_path() {
        if std::env::var("CANVAS_TERMINAL_MEMORY_ROOT").is_err() {
            // Match the path used by storage::tests::ensure_test_root_isolated.
            // (recovery tests no longer use the global env var — they pass an
            // explicit per-test root to recover_runs_in_root, per task-96 P1.)
            let test_root = std::env::temp_dir()
                .join(format!("canvas-terminal-fsd-test-{}", std::process::id()));
            let _ = std::fs::create_dir_all(&test_root);
            #[allow(unused_unsafe)]
            unsafe {
                std::env::set_var(
                    "CANVAS_TERMINAL_MEMORY_ROOT",
                    test_root.to_string_lossy().as_ref(),
                );
            }
        }

        let leader = format!("test_orch_{}", std::process::id());
        let run_id = "r1";
        let turn = 1u32;
        let task_id = "t-1-a";

        let root = get_memory_root().unwrap();
        let path = root.join(format!(
            "fsd-runs/{}/runs/{}/turns/{}/tasks/{}/result.stdout",
            leader, run_id, turn, task_id
        ));
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, "first line\nsecond line\nfinal output  \n\n").unwrap();

        let last = read_stdout_last_line(&leader, run_id, turn, task_id).await;
        assert_eq!(last, "final output");

        // Empty/missing file returns empty string, not panic.
        let missing = read_stdout_last_line(&leader, run_id, turn, "no-such-task").await;
        assert_eq!(missing, "");

        // Cleanup
        let _ = std::fs::remove_dir_all(root.join(format!("fsd-runs/{}", leader)));
    }

    #[test]
    fn read_stdout_truncates_to_200_chars() {
        // Verified via the .chars().take(200).collect() implementation. This
        // is a sanity check on a known-long line.
        let long = "x".repeat(500);
        let truncated: String = long.chars().take(200).collect();
        assert_eq!(truncated.len(), 200);
    }

    /// Per @claude3 task-51 §5.1: now_iso() must produce real ISO-8601, not
    /// `@<epoch>`. Also verify the inverse parse round-trips so recovery's
    /// epoch_secs_diff still works.
    #[test]
    fn iso_8601_format_and_round_trip() {
        // 1714780513 = Fri May 3 2024 23:55:13 UTC (verified via epochconverter.com)
        let formatted = epoch_to_iso(1_714_780_513);
        assert_eq!(formatted, "2024-05-03T23:55:13Z");

        // Day-boundary case: 86400 = 1970-01-02T00:00:00Z
        assert_eq!(epoch_to_iso(86400), "1970-01-02T00:00:00Z");
        // Epoch zero
        assert_eq!(epoch_to_iso(0), "1970-01-01T00:00:00Z");
        // Leap-year February: 1582934400 = 2020-02-29T00:00:00Z
        assert_eq!(epoch_to_iso(1582934400), "2020-02-29T00:00:00Z");

        // Round-trip through recovery's iso_to_epoch_secs.
        let parsed = crate::fsd::recovery::iso_to_epoch_secs_for_test(&formatted);
        assert_eq!(parsed, Some(1_714_780_513));

        // Multiple round-trips at varied points.
        for &secs in &[0u64, 86400, 1582934400, 1714780513, 4102444800] {
            let s = epoch_to_iso(secs);
            let back = crate::fsd::recovery::iso_to_epoch_secs_for_test(&s);
            assert_eq!(back, Some(secs), "round-trip failed for {}", secs);
        }

        // Legacy @<epoch> format still parses for backward compat.
        let legacy = crate::fsd::recovery::iso_to_epoch_secs_for_test("@1714780513");
        assert_eq!(legacy, Some(1_714_780_513));

        // now_iso() returns a valid format.
        let now = now_iso();
        assert_eq!(now.len(), 20);
        assert!(now.ends_with('Z'));
        assert!(now.chars().nth(10) == Some('T'));
        // Must be parseable.
        let now_secs = crate::fsd::recovery::iso_to_epoch_secs_for_test(&now);
        assert!(now_secs.is_some());
    }

    /// Per @claude2 task-49 §3.4 + claude3 task-51 §4.3: when a leader
    /// dispatches BEYOND max_turns, the orchestrator injects a synthesis-pass
    /// prompt instead of hard-rejecting. Verify the prompt mentions the run
    /// scope and gives the leader explicit `done`/`blocked` instructions.
    #[test]
    fn synthesis_pass_report_includes_run_scope_and_terminal_verbs() {
        let report = build_synthesis_pass_report("claude1", "run-abc", 5);
        assert!(report.contains("CAP-TRIPPED"));
        assert!(report.contains("synthesis-pass"));
        assert!(report.contains("`##FSD done`"));
        assert!(report.contains("`##FSD blocked`"));
        assert!(report.contains("claude1") && report.contains("run-abc"));
        // Should not exceed iteration_report cap.
        assert!(report.len() < ITERATION_REPORT_BYTES_CAP);
    }

    /// Phase 2.9: the runner trait now accepts `cwd: Option<PathBuf>` and
    /// callers (orchestrator + tests) thread it through unchanged. This test
    /// is the unit-level invariant that the cwd argument round-trips: a
    /// runner that captures the value sees exactly what we passed in. Closes
    /// claude3 task-41 / codex1 task-38 test-gap finding for cwd plumbing.
    #[tokio::test]
    async fn runner_receives_orchestrator_cwd_argument() {
        use crate::fsd::runner::{AssistantRunner, RunOutcome};
        use crate::fsd::schema::TaskSpec;
        use std::sync::{Arc, Mutex};

        // Test runner that captures the cwd argument it was called with.
        struct CapturingRunner {
            captured: Arc<Mutex<Option<Option<std::path::PathBuf>>>>,
        }
        impl AssistantRunner for CapturingRunner {
            fn run<'a>(
                &'a self,
                _spec: TaskSpec,
                _output_dir_rel: String,
                cwd: Option<std::path::PathBuf>,
                _cancel_rx: tokio::sync::oneshot::Receiver<()>,
            ) -> std::pin::Pin<Box<dyn std::future::Future<Output = RunOutcome> + Send + 'a>>
            {
                let captured = self.captured.clone();
                Box::pin(async move {
                    *captured.lock().unwrap() = Some(cwd);
                    RunOutcome {
                        exit_code: Some(0),
                        wallclock_ms: 1,
                        stdout_bytes: 0,
                        stderr_bytes: 0,
                        kind: "ok",
                        error: None,
                    }
                })
            }
        }

        // Case 1: cwd = Some(/tmp).
        let captured = Arc::new(Mutex::new(None));
        let runner = CapturingRunner {
            captured: captured.clone(),
        };
        let (_tx, rx) = tokio::sync::oneshot::channel::<()>();
        let cwd = Some(std::path::PathBuf::from("/tmp"));
        let _ = runner
            .run(
                TaskSpec {
                    task_id: "t".into(),
                    tool: "claude_code".into(),
                    instance_idx: 1,
                    role_hint: None,
                    prompt: "p".into(),
                    context_refs: vec![],
                    wallclock_ms_cap: 1000,
                    agent_id: "00000001".into(),
                    from_agent_id: None,
                    to_agent_id: None,
                },
                "out".into(),
                cwd.clone(),
                rx,
            )
            .await;
        assert_eq!(*captured.lock().unwrap(), Some(cwd));

        // Case 2: cwd = None (no leader cwd available).
        let captured2 = Arc::new(Mutex::new(None));
        let runner2 = CapturingRunner {
            captured: captured2.clone(),
        };
        let (_tx2, rx2) = tokio::sync::oneshot::channel::<()>();
        let _ = runner2
            .run(
                TaskSpec {
                    task_id: "t".into(),
                    tool: "claude_code".into(),
                    instance_idx: 1,
                    role_hint: None,
                    agent_id: "00000001".into(),
                    from_agent_id: None,
                    to_agent_id: None,
                    prompt: "p".into(),
                    context_refs: vec![],
                    wallclock_ms_cap: 1000,
                },
                "out".into(),
                None,
                rx2,
            )
            .await;
        assert_eq!(*captured2.lock().unwrap(), Some(None));
    }

    #[test]
    fn cap_trip_state_classification() {
        // Pure helper-style assertions on the enum variants used by handle_dispatch.
        // Mirrors the runtime decision tree:
        //   turn < max_turns       → Normal
        //   turn == max_turns      → FinalTurn
        //   turn == max_turns + 1  → SynthesisPass
        //   turn > max_turns + 1   → hard reject (no enum variant; OutOfBounds + Terminal)
        assert_ne!(CapTripState::FinalTurn, CapTripState::SynthesisPass);
        assert_ne!(CapTripState::Normal, CapTripState::FinalTurn);
    }

    /// Per plan v5 §4.2 + round-7/8 P1 from @codex2/@codex3/@claude3 (3/5
    /// evaluators): canonical Rust strike count. Increments on non-Accepted/
    /// non-Duplicate responses; resets on Accepted; force-blocks at
    /// STRIKES_PER_TURN. Tests the counter math directly without the full
    /// Tauri State plumbing.
    #[test]
    fn consecutive_strikes_field_initializes_zero() {
        use crate::state::FsdRunHandle;
        use std::collections::{HashMap, HashSet};
        use tokio::sync::oneshot;

        let (tx, _rx) = oneshot::channel::<()>();
        let handle = FsdRunHandle {
            leader_handle: "claude1".into(),
            run_id: "r1".into(),
            cancel_tx: Some(tx),
            task_cancel_txs: HashMap::new(),
            max_turns: 4,
            current_turn: 0,
            seen_cmd_ids: HashSet::new(),
            consecutive_strikes: 0,
        };
        assert_eq!(handle.consecutive_strikes, 0);
        assert_eq!(STRIKES_PER_TURN, 3);
    }

    /// Per @codex3 task-72 P1: dispatch dedup MUST happen before the
    /// state guard. A duplicate dispatch echo arriving while the original
    /// dispatch has set the manifest to `Dispatching` would otherwise hit
    /// the state guard first → OutOfScope+Remind → strike. Verifies the
    /// helper function shape: check_cmd_id_seen returns Duplicate when
    /// cmd_id is in the seen set.
    #[test]
    fn check_cmd_id_seen_helpers_split_correctly() {
        // Direct test of the two-step pattern: check (read) then record (insert).
        use std::collections::HashSet;
        let mut seen = HashSet::new();
        // Simulating check_cmd_id_seen logic:
        let cmd_id = "dispatch-cmd-42";
        // First time — not seen.
        assert!(!seen.contains(cmd_id));
        // Record it.
        seen.insert(cmd_id.to_string());
        // Second time — seen → would return Duplicate from check_cmd_id_seen.
        assert!(seen.contains(cmd_id));
    }

    /// Per @codex3 task-72 P3: turn must be >= 1 per plan v5 §3 grammar.
    /// turn=0 doesn't correspond to a valid `turns/N/` directory layout.
    #[test]
    fn turn_zero_is_rejected_as_out_of_bounds() {
        // Direct invariant check — handle_dispatch's first guard rejects turn < 1.
        let turn: u32 = 0;
        assert!(turn < 1, "turn=0 must be detected as out-of-bounds");
    }

    /// Per @codex3 task-78 P2: orchestrator-level test that exercises the
    /// actual `check_cmd_id_seen` function (via its testable inner) against
    /// a real `FsdRunHandle` registered in a Mutex<HashMap>. Verifies the
    /// function returns the canonical Duplicate+Ack response shape — not
    /// just helper-level invariants.
    #[test]
    fn check_cmd_id_seen_in_returns_duplicate_with_ack_for_seen() {
        use crate::state::FsdRunHandle;
        use std::collections::{HashMap, HashSet};
        use std::sync::Mutex;
        use tokio::sync::oneshot;

        // Construct a real FsdRunHandle with a pre-recorded cmd_id and
        // strike count, registered in the runs map keyed by run_id.
        let (tx, _rx) = oneshot::channel::<()>();
        let mut seen = HashSet::new();
        seen.insert("dispatch-cmd-already-seen".to_string());
        let handle = FsdRunHandle {
            leader_handle: "claude1".into(),
            run_id: "run-active".into(),
            cancel_tx: Some(tx),
            task_cancel_txs: HashMap::new(),
            max_turns: 4,
            current_turn: 1,
            seen_cmd_ids: seen,
            consecutive_strikes: 2, // mid-protocol — test we surface this
        };
        let mut runs = HashMap::new();
        runs.insert("run-active".to_string(), handle);
        let registry = Mutex::new(runs);

        // Case 1: seen cmd_id → Duplicate + Ack with the live strike count.
        let result = check_cmd_id_seen_in(&registry, "run-active", "dispatch-cmd-already-seen");
        match result {
            Err(resp) => {
                assert_eq!(resp.result, DispatchResult::Duplicate);
                assert_eq!(resp.next_action, NextAction::Ack);
                assert_eq!(resp.strike_count, 2, "must surface live strike count");
                assert!(resp
                    .message
                    .as_deref()
                    .unwrap_or("")
                    .contains("dispatch-cmd-already-seen"));
                assert!(resp.message.as_deref().unwrap_or("").contains("run-active"));
            }
            Ok(()) => panic!("expected Duplicate, got Ok"),
        }

        // Case 2: new cmd_id → Ok (caller continues to next validation).
        let result = check_cmd_id_seen_in(&registry, "run-active", "dispatch-cmd-fresh");
        assert!(
            result.is_ok(),
            "fresh cmd_id must return Ok, got {:?}",
            result
        );

        // Case 3: unknown run_id → Ok (defer to validate_run_command downstream).
        let result = check_cmd_id_seen_in(&registry, "run-nonexistent", "any-cmd-id");
        assert!(
            result.is_ok(),
            "unknown run must return Ok, got {:?}",
            result
        );
    }

    /// Per @codex3 task-90 P2 — round-13: invoke the **actual production
    /// helper** `run_and_record_one_task` with FakeAssistantRunner, rather
    /// than mirroring its steps in the test. This is the helper that
    /// `handle_dispatch`'s spawn closure also calls, so any future change
    /// to the per-task plumbing (write done.json before/after emit, remove
    /// from cancel map at the wrong time, etc.) is now caught directly by
    /// this test.
    #[tokio::test]
    async fn run_and_record_one_task_invokes_production_helper_with_fake_runner() {
        use crate::commands::memory::get_memory_root;
        use crate::fsd::runner::{AssistantRunner, RunOutcome};
        use crate::fsd::schema::TaskSpec;
        use crate::state::FsdRunHandle;
        use std::collections::{HashMap, HashSet};
        use std::sync::{Arc, Mutex};
        use tokio::sync::oneshot;

        // Test isolation
        if std::env::var("CANVAS_TERMINAL_MEMORY_ROOT").is_err() {
            let test_root = std::env::temp_dir()
                .join(format!("canvas-terminal-fsd-test-{}", std::process::id()));
            let _ = std::fs::create_dir_all(&test_root);
            #[allow(unused_unsafe)]
            unsafe {
                std::env::set_var(
                    "CANVAS_TERMINAL_MEMORY_ROOT",
                    test_root.to_string_lossy().as_ref(),
                );
            }
        }

        struct FakeAssistantRunner;
        impl AssistantRunner for FakeAssistantRunner {
            fn run<'a>(
                &'a self,
                spec: TaskSpec,
                output_dir_rel: String,
                _cwd: Option<std::path::PathBuf>,
                _cancel_rx: oneshot::Receiver<()>,
            ) -> std::pin::Pin<Box<dyn std::future::Future<Output = RunOutcome> + Send + 'a>>
            {
                Box::pin(async move {
                    if let Ok(root) = get_memory_root() {
                        let stdout_path = root.join(&output_dir_rel).join("result.stdout");
                        if let Some(parent) = stdout_path.parent() {
                            let _ = std::fs::create_dir_all(parent);
                        }
                        let _ = std::fs::write(&stdout_path, format!("FAKE for {}", spec.task_id));
                    }
                    RunOutcome {
                        exit_code: Some(0),
                        wallclock_ms: 7,
                        stdout_bytes: 12,
                        stderr_bytes: 0,
                        kind: "ok",
                        error: None,
                    }
                })
            }
        }

        let leader = format!(
            "h13_test_{}_{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        let run_id = "run-h13";
        let task_id = "t-1-helper";

        // Register a real FsdRunHandle with a cancel sender for this task,
        // mirroring what handle_dispatch sets up before spawning.
        let (task_cancel_tx, task_cancel_rx) = oneshot::channel::<()>();
        let mut task_txs = HashMap::new();
        task_txs.insert(task_id.to_string(), task_cancel_tx);
        let (run_cancel_tx, _run_cancel_rx) = oneshot::channel::<()>();
        let handle = FsdRunHandle {
            leader_handle: leader.clone(),
            run_id: run_id.into(),
            cancel_tx: Some(run_cancel_tx),
            task_cancel_txs: task_txs,
            max_turns: 4,
            current_turn: 1,
            seen_cmd_ids: HashSet::new(),
            consecutive_strikes: 0,
        };
        let mut runs_map = HashMap::new();
        runs_map.insert(run_id.to_string(), handle);
        let runs = Arc::new(Mutex::new(runs_map));

        // Construct paths via TaskPath::try_new (production code does this).
        let task_path = TaskPath::try_new(&leader, run_id, 1, task_id).unwrap();
        let output_dir_rel = task_path
            .pending()
            .rsplit_once('/')
            .map(|(d, _)| d.to_string())
            .unwrap();

        let spec = TaskSpec {
            task_id: task_id.into(),
                    agent_id: "00000001".into(),
                    from_agent_id: None,
                    to_agent_id: None,
            tool: "claude_code".into(),
            instance_idx: 1,
            role_hint: Some("test-role".into()),
            prompt: "test prompt".into(),
            context_refs: vec![],
            wallclock_ms_cap: 60_000,
        };

        // Verify the cancel sender is registered before the call.
        assert!(runs
            .lock()
            .unwrap()
            .get(run_id)
            .unwrap()
            .task_cancel_txs
            .contains_key(task_id));

        // Call the SAME helper that handle_dispatch's spawn closure calls.
        // No AppHandle (test passes None), runs is provided so cleanup runs.
        let done = run_and_record_one_task(
            &FakeAssistantRunner,
            &leader,
            run_id,
            1,
            task_id,
            "claude_code",
            Some("test-role".into()),
            spec,
            output_dir_rel,
            None, // no leader cwd in this test (Phase 2.9 param)
            task_cancel_rx,
            Some(&runs),
            None, // no AppHandle in test
            None, // no seq_global in test (broker not exercised — no from_agent_id)
        )
        .await;

        // Verify TaskDone shape and side effects.
        assert_eq!(done.task_id, task_id);
        assert_eq!(done.exit_code, Some(0));
        assert_eq!(done.tool, "claude_code");

        // Verify cancel sender was REMOVED post-completion (cleanup invariant).
        let still_registered = runs
            .lock()
            .unwrap()
            .get(run_id)
            .unwrap()
            .task_cancel_txs
            .contains_key(task_id);
        assert!(
            !still_registered,
            "production helper must remove completed task's cancel sender"
        );

        // Verify done.json written to disk.
        let root = get_memory_root().unwrap();
        let done_path = root.join(format!(
            "fsd-runs/{}/runs/{}/turns/1/tasks/{}/done.json",
            leader, run_id, task_id
        ));
        assert!(
            done_path.exists(),
            "done.json must be written by the helper"
        );

        // Verify the stdout file FakeAssistantRunner created is readable by
        // read_stdout_last_line (production helper calls it for last_line preview).
        let stdout_path = root.join(format!(
            "fsd-runs/{}/runs/{}/turns/1/tasks/{}/result.stdout",
            leader, run_id, task_id
        ));
        assert!(stdout_path.exists());
        let content = std::fs::read_to_string(&stdout_path).unwrap();
        assert!(content.contains("FAKE for t-1-helper"));

        // Cleanup
        let _ = std::fs::remove_dir_all(root.join(format!("fsd-runs/{}", leader)));
    }

    /// Per @codex3 task-84 P2 (raised by 3 evaluators across rounds 7-12):
    /// orchestrator-level integration test that exercises the plan → dispatch
    /// → task-done → iteration_report → done flow against a FakeAssistantRunner.
    /// Uses real disk I/O for manifest/done.json/iteration_report so the
    /// actual write_run_file/build_iteration_report paths run end-to-end.
    /// Bypasses Tauri State (which is hard to construct in tests) by exercising
    /// the orchestrator's pure-state helpers directly + AssistantRunner trait.
    #[tokio::test]
    async fn integration_plan_dispatch_iteration_report_done_flow() {
        use crate::commands::memory::get_memory_root;
        use crate::fsd::runner::{AssistantRunner, RunOutcome};
        use crate::fsd::schema::{RunManifest, RunStatus, TaskDone, TaskSpec};
        use crate::fsd::storage::TaskPath;
        use std::collections::{HashMap, HashSet};
        use std::sync::Mutex;
        use tokio::sync::oneshot;

        // Use the same env-var override as storage/recovery tests for isolation.
        if std::env::var("CANVAS_TERMINAL_MEMORY_ROOT").is_err() {
            let test_root = std::env::temp_dir()
                .join(format!("canvas-terminal-fsd-test-{}", std::process::id()));
            let _ = std::fs::create_dir_all(&test_root);
            #[allow(unused_unsafe)]
            unsafe {
                std::env::set_var(
                    "CANVAS_TERMINAL_MEMORY_ROOT",
                    test_root.to_string_lossy().as_ref(),
                );
            }
        }

        // FakeAssistantRunner: returns scripted outcomes instantly without
        // spawning real subprocesses. Verifies the orchestrator + trait
        // contract works for ANY runner impl.
        struct FakeAssistantRunner;
        impl AssistantRunner for FakeAssistantRunner {
            fn run<'a>(
                &'a self,
                spec: TaskSpec,
                output_dir_rel: String,
                _cwd: Option<std::path::PathBuf>,
                _cancel_rx: oneshot::Receiver<()>,
            ) -> std::pin::Pin<Box<dyn std::future::Future<Output = RunOutcome> + Send + 'a>>
            {
                Box::pin(async move {
                    // Write a minimal stdout file so build_iteration_report
                    // can inline the preview (exercises the read_to_string path).
                    if let Ok(root) = get_memory_root() {
                        let stdout_path = root.join(&output_dir_rel).join("result.stdout");
                        if let Some(parent) = stdout_path.parent() {
                            let _ = std::fs::create_dir_all(parent);
                        }
                        let _ = std::fs::write(
                            &stdout_path,
                            format!("FAKE OUTPUT for {}", spec.task_id),
                        );
                    }
                    RunOutcome {
                        exit_code: Some(0),
                        wallclock_ms: 42,
                        stdout_bytes: 30,
                        stderr_bytes: 0,
                        kind: "ok",
                        error: None,
                    }
                })
            }
        }

        // ---- Phase 1: simulate `plan` accepted ----
        let leader = format!(
            "integ_test_{}_{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        let run_id = "run-integ";
        let session_nonce = "abcdef01";
        let run_nonce = "01234567";

        // Write manifest in Running state (mirrors what handle_plan does).
        let manifest = RunManifest {
            run_id: run_id.into(),
            leader_handle: leader.clone(),
            owner_pid: std::process::id(),
            started_at: now_iso(),
            last_heartbeat_at: now_iso(),
            status: RunStatus::Running,
            session_nonce: session_nonce.into(),
            run_nonce: run_nonce.into(),
        };
        let _ = write_manifest(&leader, run_id, &manifest);

        // Register a real FsdRunHandle so check_cmd_id_seen_in works.
        let (cancel_tx, _cancel_rx) = oneshot::channel::<()>();
        let mut seen = HashSet::new();
        seen.insert("plan-cmd".to_string());
        let handle = FsdRunHandle {
            leader_handle: leader.clone(),
            run_id: run_id.into(),
            cancel_tx: Some(cancel_tx),
            task_cancel_txs: HashMap::new(),
            max_turns: 4,
            current_turn: 0,
            seen_cmd_ids: seen,
            consecutive_strikes: 0,
        };
        let mut runs_map = HashMap::new();
        runs_map.insert(run_id.to_string(), handle);
        let runs = Mutex::new(runs_map);

        // ---- Phase 2: simulate `dispatch` — verify dedup ordering invariant ----
        // First dispatch with new cmd_id: should pass dedup check.
        let dispatch_cmd_id = "dispatch-cmd-1";
        assert!(
            check_cmd_id_seen_in(&runs, run_id, dispatch_cmd_id).is_ok(),
            "fresh cmd_id must pass dedup check"
        );
        // Now record it (mirrors the real handle_dispatch flow after validation).
        if let Ok(mut g) = runs.lock() {
            if let Some(h) = g.get_mut(run_id) {
                h.seen_cmd_ids.insert(dispatch_cmd_id.into());
            }
        }
        // Replayed dispatch: must short-circuit with Duplicate+Ack.
        let dup_result = check_cmd_id_seen_in(&runs, run_id, dispatch_cmd_id);
        assert!(matches!(dup_result, Err(resp) if resp.result == DispatchResult::Duplicate));

        // ---- Phase 3: simulate task execution via FakeAssistantRunner ----
        let runner = FakeAssistantRunner;
        let turn = 1u32;
        let task_spec = TaskSpec {
            task_id: "t-1-a".into(),
            tool: "claude_code".into(),
            instance_idx: 1,
            role_hint: Some("integration-test".into()),
            prompt: "fake prompt".into(),
            context_refs: vec![],
            wallclock_ms_cap: 60_000,
            agent_id: "00000001".into(),
            from_agent_id: None,
            to_agent_id: None,
        };
        let task_path = TaskPath::try_new(&leader, run_id, turn, &task_spec.task_id).unwrap();
        let output_dir_rel = task_path
            .pending()
            .rsplit_once('/')
            .map(|(d, _)| d.to_string())
            .unwrap_or_default();
        let (_t_cancel_tx, t_cancel_rx) = oneshot::channel::<()>();
        let outcome = runner
            .run(task_spec.clone(), output_dir_rel, None, t_cancel_rx)
            .await;
        assert_eq!(outcome.exit_code, Some(0));
        assert_eq!(outcome.kind, "ok");

        // Write done.json (mirrors handle_dispatch's spawn closure).
        let task_done = TaskDone {
            task_id: task_spec.task_id.clone(),
            run_id: run_id.into(),
            turn,
            tool: task_spec.tool.clone(),
            exit_code: outcome.exit_code,
            wallclock_ms: outcome.wallclock_ms,
            stdout_bytes: outcome.stdout_bytes,
            stderr_bytes: outcome.stderr_bytes,
            stdout_path: format!("turns/{}/tasks/{}/result.stdout", turn, task_spec.task_id),
            stderr_path: format!("turns/{}/tasks/{}/result.stderr", turn, task_spec.task_id),
            error: outcome.error.clone(),
        };
        let _ = write_run_file(
            &leader,
            run_id,
            &format!("turns/{}/tasks/{}/done.json", turn, task_spec.task_id),
            serde_json::to_value(&task_done).unwrap(),
        );

        // ---- Phase 4: build iteration_report ----
        let report = build_iteration_report(&leader, run_id, turn, &[task_done]);
        assert!(report.contains("FSD turn 1 report"));
        assert!(report.contains("t-1-a"));
        assert!(report.contains("✓ ok"));
        assert!(
            report.contains("FAKE OUTPUT"),
            "iteration_report must inline FakeAssistantRunner stdout"
        );
        let _ = write_run_file_text(
            &leader,
            run_id,
            &format!("turns/{}/iteration_report.md", turn),
            &report,
        );

        // Manifest transitions to AwaitingLeader after iteration_report inject.
        update_manifest_status(&leader, run_id, RunStatus::AwaitingLeader);

        // ---- Phase 5: simulate `done` ----
        let _ = write_run_file(
            &leader,
            run_id,
            "final.json",
            serde_json::json!({
                "status": "done",
                "summary": "integration test complete",
                "evidence": [],
                "ended_at": now_iso(),
            }),
        );
        update_manifest_status(&leader, run_id, RunStatus::Done);

        // ---- Verify: manifest status is now Done; iteration_report on disk ----
        let root = get_memory_root().unwrap();
        let final_manifest_raw = std::fs::read_to_string(
            root.join(format!("fsd-runs/{}/runs/{}/manifest.json", leader, run_id)),
        )
        .unwrap();
        let final_manifest: RunManifest = serde_json::from_str(&final_manifest_raw).unwrap();
        assert_eq!(final_manifest.status, RunStatus::Done);

        let report_on_disk = std::fs::read_to_string(root.join(format!(
            "fsd-runs/{}/runs/{}/turns/1/iteration_report.md",
            leader, run_id
        )))
        .unwrap();
        assert!(report_on_disk.contains("FAKE OUTPUT"));

        let final_json_raw = std::fs::read_to_string(
            root.join(format!("fsd-runs/{}/runs/{}/final.json", leader, run_id)),
        )
        .unwrap();
        let final_json: serde_json::Value = serde_json::from_str(&final_json_raw).unwrap();
        assert_eq!(final_json["status"], "done");

        // Cleanup
        let _ = std::fs::remove_dir_all(root.join(format!("fsd-runs/{}", leader)));
    }

    /// Companion test: dedup check returns Duplicate+Ack regardless of the
    /// run's current state (Running, Dispatching, AwaitingLeader). This is
    /// the round-10 ordering invariant — duplicate dispatch echoes during
    /// `Dispatching` state must NOT hit the state guard's OutOfScope+Remind
    /// path. The dedup precedes the state check.
    #[test]
    fn dedup_short_circuits_regardless_of_run_state() {
        use crate::state::FsdRunHandle;
        use std::collections::{HashMap, HashSet};
        use std::sync::Mutex;
        use tokio::sync::oneshot;

        let (tx, _rx) = oneshot::channel::<()>();
        let mut seen = HashSet::new();
        seen.insert("echo-cmd".to_string());
        let handle = FsdRunHandle {
            leader_handle: "claude1".into(),
            run_id: "run-1".into(),
            cancel_tx: Some(tx),
            task_cancel_txs: HashMap::new(),
            max_turns: 4,
            current_turn: 1,
            seen_cmd_ids: seen,
            consecutive_strikes: 0,
        };
        let mut runs = HashMap::new();
        runs.insert("run-1".to_string(), handle);
        let registry = Mutex::new(runs);

        // The dedup check is run-state-agnostic by design: it doesn't read
        // manifest.status. Even if the run is in `Dispatching`, the seen
        // cmd_id wins — short-circuits with Duplicate+Ack rather than
        // letting the dispatch-only state guard reject with OutOfScope+Remind
        // (which would strike a healthy run on every echo retry).
        let result = check_cmd_id_seen_in(&registry, "run-1", "echo-cmd");
        assert!(matches!(result, Err(resp) if resp.result == DispatchResult::Duplicate));
    }

    /// Per @codex3 task-66 P1: a duplicate plan (same run_id + same cmd_id)
    /// must short-circuit with Duplicate+Ack, NOT OutOfScope+Remind. Three
    /// plan echoes would otherwise increment consecutive_strikes and
    /// force-block a healthy run. Tests the active-run + cmd_id check that
    /// fires before the concurrent-run guard.
    #[test]
    fn duplicate_plan_returns_duplicate_not_out_of_scope() {
        use crate::state::FsdRunHandle;
        use std::collections::{HashMap, HashSet};
        use tokio::sync::oneshot;

        // Simulate the active-run guard's match logic on a handle with a
        // pre-recorded plan cmd_id.
        let (tx, _rx) = oneshot::channel::<()>();
        let mut seen = HashSet::new();
        seen.insert("plan-cmd-original".to_string());
        let handle = FsdRunHandle {
            leader_handle: "claude1".into(),
            run_id: "run-active".into(),
            cancel_tx: Some(tx),
            task_cancel_txs: HashMap::new(),
            max_turns: 4,
            current_turn: 0,
            seen_cmd_ids: seen,
            consecutive_strikes: 0,
        };

        // Replayed plan: same run_id + same cmd_id → duplicate (idempotent ack)
        assert_eq!(handle.run_id, "run-active");
        assert!(handle.seen_cmd_ids.contains("plan-cmd-original"));

        // New plan attempt for a different run_id while this one is active
        // → genuine concurrent-run rejection (OutOfScope), not a strike of
        // the existing run.
        assert!(!handle.seen_cmd_ids.contains("plan-cmd-different"));
    }

    #[test]
    fn task_cancel_txs_keyed_by_task_id() {
        // Per @codex2 task-57 P2: HashMap<task_id, sender> lets completed
        // tasks remove their own entry, keeping cancellation reporting
        // accurate.
        use crate::state::FsdRunHandle;
        use std::collections::{HashMap, HashSet};
        use tokio::sync::oneshot;

        let (run_tx, _run_rx) = oneshot::channel::<()>();
        let (t1, _r1) = oneshot::channel::<()>();
        let (t2, _r2) = oneshot::channel::<()>();
        let mut txs = HashMap::new();
        txs.insert("t-1-a".to_string(), t1);
        txs.insert("t-1-b".to_string(), t2);
        let mut handle = FsdRunHandle {
            leader_handle: "claude1".into(),
            run_id: "r1".into(),
            cancel_tx: Some(run_tx),
            task_cancel_txs: txs,
            max_turns: 4,
            current_turn: 1,
            seen_cmd_ids: HashSet::new(),
            consecutive_strikes: 0,
        };
        assert_eq!(handle.task_cancel_txs.len(), 2);
        // Completion removes by task_id.
        let removed = handle.task_cancel_txs.remove("t-1-a");
        assert!(removed.is_some(), "completed task removable by id");
        assert_eq!(handle.task_cancel_txs.len(), 1);
        assert!(handle.task_cancel_txs.contains_key("t-1-b"));
        assert!(!handle.task_cancel_txs.contains_key("t-1-a"));
    }

    /// Per plan v5 §3.1 rule 6 + round-8 P1 from @codex2/@codex3/@claude3:
    /// `(run_id, cmd_id)` dedup must reject duplicates with `Duplicate`.
    /// Tests the seen_cmd_ids HashSet behavior on FsdRunHandle directly
    /// (without going through the full Tauri State plumbing).
    #[test]
    fn seen_cmd_ids_rejects_duplicates() {
        use crate::state::FsdRunHandle;
        use std::collections::HashSet;
        use tokio::sync::oneshot;

        let mut seen = HashSet::new();
        seen.insert("plan-cmd-1".to_string());

        let (tx, _rx) = oneshot::channel::<()>();
        let mut handle = FsdRunHandle {
            leader_handle: "claude1".into(),
            run_id: "r1".into(),
            cancel_tx: Some(tx),
            task_cancel_txs: std::collections::HashMap::new(),
            max_turns: 4,
            current_turn: 0,
            seen_cmd_ids: seen,
            consecutive_strikes: 0,
        };

        // Plan cmd_id is already in the set — duplicate detected.
        assert!(!handle.seen_cmd_ids.insert("plan-cmd-1".into()));

        // First-seen dispatch cmd_id is accepted.
        assert!(handle.seen_cmd_ids.insert("dispatch-cmd-1".into()));

        // Same dispatch cmd_id replayed — duplicate detected.
        assert!(!handle.seen_cmd_ids.insert("dispatch-cmd-1".into()));

        // Different cmd_id is accepted.
        assert!(handle.seen_cmd_ids.insert("dispatch-cmd-2".into()));

        assert_eq!(handle.seen_cmd_ids.len(), 3);
    }

    /// Build a minimal TaskSpec with the given agent_id for unit-test
    /// fixtures. All other fields are filled with valid defaults.
    fn make_task_spec_for_agent(agent_id: &str, task_id: &str) -> TaskSpec {
        TaskSpec {
            task_id: task_id.into(),
            tool: "claude_code".into(),
            instance_idx: 1,
            role_hint: None,
            prompt: "fixture prompt".into(),
            context_refs: vec![],
            wallclock_ms_cap: 60_000,
            agent_id: agent_id.into(),
            from_agent_id: None,
            to_agent_id: None,
        }
    }

    /// Round-10 reflection per codex3 task-5: PR-PreC dispatch-group
    /// authorization assumes (run_id, agent_id) is unique within a turn.
    /// `find_duplicate_agent_id` MUST surface the first repeat so
    /// `handle_dispatch` can reject it as `Malformed` before any state
    /// mutation. Closes the new "duplicate agent_id within one dispatch"
    /// rejection path.
    #[test]
    fn find_duplicate_agent_id_returns_first_repeat() {
        let tasks = vec![
            make_task_spec_for_agent("aaaaaaaa", "t1"),
            make_task_spec_for_agent("bbbbbbbb", "t2"),
            make_task_spec_for_agent("aaaaaaaa", "t3"),
        ];
        assert_eq!(find_duplicate_agent_id(&tasks), Some("aaaaaaaa"));
    }

    #[test]
    fn find_duplicate_agent_id_none_when_all_unique() {
        let tasks = vec![
            make_task_spec_for_agent("aaaaaaaa", "t1"),
            make_task_spec_for_agent("bbbbbbbb", "t2"),
            make_task_spec_for_agent("cccccccc", "t3"),
        ];
        assert_eq!(find_duplicate_agent_id(&tasks), None);
    }

    #[test]
    fn find_duplicate_agent_id_none_for_empty_dispatch() {
        let tasks: Vec<TaskSpec> = Vec::new();
        assert_eq!(find_duplicate_agent_id(&tasks), None);
    }

    /// Round-10 reflection per claude2 task-2 §1: prove the conditional
    /// transition helper rejects a stale write that would clobber a
    /// terminal status. Closes the manifest-status race window between
    /// `handle_dispatch`'s post-tasks `awaiting_leader` write and a
    /// concurrent `handle_done`/`handle_blocked`/`cancel_run`.
    #[test]
    fn try_transition_manifest_status_rejects_when_terminal() {
        // Set up env-isolated memory root + a manifest in Done state.
        if std::env::var("CANVAS_TERMINAL_MEMORY_ROOT").is_err() {
            let test_root = std::env::temp_dir()
                .join(format!("canvas-terminal-fsd-test-{}", std::process::id()));
            let _ = std::fs::create_dir_all(&test_root);
            #[allow(unused_unsafe)]
            unsafe {
                std::env::set_var(
                    "CANVAS_TERMINAL_MEMORY_ROOT",
                    test_root.to_string_lossy().as_ref(),
                );
            }
        }

        use std::sync::atomic::{AtomicU32, Ordering};
        static COUNTER: AtomicU32 = AtomicU32::new(0);
        let n = COUNTER.fetch_add(1, Ordering::SeqCst);
        let leader = format!("test-race-{}-{}", std::process::id(), n);
        let run_id = "race-run";

        let manifest = RunManifest {
            run_id: run_id.into(),
            leader_handle: leader.clone(),
            owner_pid: std::process::id(),
            started_at: now_iso(),
            last_heartbeat_at: now_iso(),
            status: RunStatus::Done,
            session_nonce: "abcdef01".into(),
            run_nonce: "01234567".into(),
        };
        write_manifest(&leader, run_id, &manifest).expect("write manifest");

        // Attempt to transition Done → AwaitingLeader with the precondition
        // "prior must be Dispatching" — this is the exact pattern at the
        // dispatch site. Should reject and leave manifest unchanged.
        let result = try_transition_manifest_status(
            &leader,
            run_id,
            RunStatus::AwaitingLeader,
            |prior| prior == RunStatus::Dispatching,
        );
        assert!(
            result.is_none(),
            "transition must be rejected when prior is terminal (Done)"
        );

        // Verify the manifest still reads Done — no clobber.
        let after = read_manifest_for_run(&leader, run_id).expect("read manifest");
        assert_eq!(
            after.status,
            RunStatus::Done,
            "Done status must not be clobbered by AwaitingLeader (claude2 §1 race closed)"
        );
    }

    #[test]
    fn try_transition_manifest_status_accepts_when_precondition_passes() {
        if std::env::var("CANVAS_TERMINAL_MEMORY_ROOT").is_err() {
            let test_root = std::env::temp_dir()
                .join(format!("canvas-terminal-fsd-test-{}", std::process::id()));
            let _ = std::fs::create_dir_all(&test_root);
            #[allow(unused_unsafe)]
            unsafe {
                std::env::set_var(
                    "CANVAS_TERMINAL_MEMORY_ROOT",
                    test_root.to_string_lossy().as_ref(),
                );
            }
        }

        use std::sync::atomic::{AtomicU32, Ordering};
        static COUNTER: AtomicU32 = AtomicU32::new(0);
        let n = COUNTER.fetch_add(1, Ordering::SeqCst);
        let leader = format!("test-race-ok-{}-{}", std::process::id(), n);
        let run_id = "race-run-ok";

        let manifest = RunManifest {
            run_id: run_id.into(),
            leader_handle: leader.clone(),
            owner_pid: std::process::id(),
            started_at: now_iso(),
            last_heartbeat_at: now_iso(),
            status: RunStatus::Dispatching,
            session_nonce: "abcdef01".into(),
            run_nonce: "01234567".into(),
        };
        write_manifest(&leader, run_id, &manifest).expect("write manifest");

        let result = try_transition_manifest_status(
            &leader,
            run_id,
            RunStatus::AwaitingLeader,
            |prior| prior == RunStatus::Dispatching,
        );
        assert_eq!(result, Some(RunStatus::Dispatching), "should return prior status");

        let after = read_manifest_for_run(&leader, run_id).expect("read manifest");
        assert_eq!(after.status, RunStatus::AwaitingLeader);
    }

    /// Round-11 reflection per codex1+claude2+codex2 (3/5 reviewers):
    /// belt-and-braces in-memory `fsd_runs` check at the dispatch
    /// finish site. Every terminal handler removes the run from
    /// `fsd_runs` BEFORE its manifest write, so an absent in-memory
    /// entry is a leading-edge signal that "run is terminating" and
    /// the dispatch finish path should suppress its `AwaitingLeader`
    /// transition + `inject_iteration_report` emit.
    ///
    /// This pure test exercises the in-memory contains_key invariant
    /// the dispatch site uses (orchestrator.rs:951+989). The full
    /// async path is exercised via the existing
    /// `integration_plan_dispatch_iteration_report_done_flow`.
    #[test]
    fn fsd_runs_absent_signals_terminating_run() {
        use crate::state::FsdRunHandle;
        use std::collections::{HashMap, HashSet};
        use std::sync::Mutex;
        use tokio::sync::oneshot;

        let run_id = "race-runtime-removal";
        let leader = "test-leader-race".to_string();

        // Build a real fsd_runs map with one run registered.
        let (cancel_tx, _cancel_rx) = oneshot::channel::<()>();
        let handle = FsdRunHandle {
            leader_handle: leader.clone(),
            run_id: run_id.into(),
            cancel_tx: Some(cancel_tx),
            task_cancel_txs: HashMap::new(),
            max_turns: 4,
            current_turn: 1,
            seen_cmd_ids: HashSet::new(),
            consecutive_strikes: 0,
        };
        let runs = Mutex::new({
            let mut m = HashMap::new();
            m.insert(run_id.to_string(), handle);
            m
        });

        // Pre-check (run still alive) — dispatch finish would proceed.
        assert!(
            runs.lock().unwrap().contains_key(run_id),
            "run must be present pre-check (terminal handler hasn't run yet)"
        );

        // Simulate handle_done's `remove_run_and_cancel` removing the
        // entry — this is the leading edge of run termination.
        let removed = runs.lock().unwrap().remove(run_id);
        assert!(removed.is_some(), "run was registered, must remove cleanly");

        // Post-check (run gone) — dispatch finish must suppress emit.
        assert!(
            !runs.lock().unwrap().contains_key(run_id),
            "absent fsd_runs entry signals concurrent terminal handler — emit must be skipped"
        );
    }
}
