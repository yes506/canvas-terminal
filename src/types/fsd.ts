/**
 * FSD wire-format schemas — TypeScript mirror of `src-tauri/src/fsd/schema.rs`.
 *
 * The two validators (this and the Rust orchestrator) MUST produce identical
 * verdicts on the same input (per plan v5 §2 two-layer validation paragraph).
 */

export const SCHEMA_VERSION = 1;

export type FsdTier = "off" | "pilot" | "x1" | "x2" | "x3";

/** Phase 1 ships only `off` and `pilot`. x1/x2/x3 buttons disabled in UI. */
export const PHASE1_TIERS: FsdTier[] = ["off", "pilot"];

/**
 * Which channel the leader uses to emit commands. Chip surfaces this so the
 * user knows whether MCP is active or prompt-eng is the only path.
 */
export type EmissionMode = "prompt_lines" | "mcp_tools" | "both" | "unavailable";

export interface FsdEnvelope {
  v: number;
  cmd_id: string;
  /** 8-hex session nonce, set on `fsd_set_tier(>0)`. */
  sn: string;
  /** 8-hex run nonce, set per run by orchestrator. */
  rn: string;
  run_id: string;
}

export interface TaskSpec {
  task_id: string;
  tool: string;
  instance_idx: number;
  role_hint?: string | null;
  prompt: string;
  context_refs?: string[];
  wallclock_ms_cap?: number;
}

export type FsdCommand =
  | (FsdEnvelope & {
      type: "plan";
      goal: string;
      success_criteria?: string[];
      max_turns?: number;
    })
  | (FsdEnvelope & {
      type: "dispatch";
      turn: number;
      tasks: TaskSpec[];
    })
  | (FsdEnvelope & {
      type: "done";
      summary: string;
      evidence?: string[];
    })
  | (FsdEnvelope & {
      type: "blocked";
      reason: string;
      missing_capability?: string | null;
      needed_user_input?: string | null;
      last_cmd_id?: string | null;
    });

// ---- Storage manifests -----------------------------------------------------

export type RunStatus =
  | "running"
  | "dispatching"
  | "awaiting_leader"
  | "done"
  | "blocked"
  | "cancelled"
  | "cap_tripped"
  | "interrupted";

export interface RunManifest {
  run_id: string;
  leader_handle: string;
  owner_pid: number;
  started_at: string;
  last_heartbeat_at: string;
  status: RunStatus;
  session_nonce: string;
  run_nonce: string;
}

export interface TaskDone {
  task_id: string;
  run_id: string;
  turn: number;
  tool: string;
  exit_code: number | null;
  wallclock_ms: number;
  stdout_bytes: number;
  stderr_bytes: number;
  stdout_path: string;
  stderr_path: string;
  error: string | null;
}

// ---- Frontend-only state ---------------------------------------------------

export interface FsdLeaderState {
  leaderSessionId: string;
  leaderHandle: string;
  tier: FsdTier;
  /** Active run id, if any. */
  activeRunId: string | null;
  /** Active session nonce from `fsd_set_tier`. */
  sessionNonce: string;
  /** Active run nonce, if a run is in progress. */
  runNonce: string | null;
  /** Per-run strike counter (orchestrator-canonical; this is a UI cache). */
  strikeCount: number;
  /** Which channel the leader is currently using. */
  emissionMode: EmissionMode;
  /** Per-task chip state for the SwarmDrawer. */
  tasks: FsdTaskChipState[];
  /** Current run status from the manifest. */
  status: RunStatus | null;
  /** Current turn (1-indexed). */
  turn: number;
}

export interface FsdTaskChipState {
  taskId: string;
  tool: string;
  roleHint?: string;
  status: "pending" | "running" | "done" | "errored" | "stalled";
  lastLine: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  exitCode: number | null;
  wallclockMs: number;
}

// ---- Backend response types ------------------------------------------------

export type DispatchResult =
  | "accepted"
  | "malformed"
  | "duplicate"
  | "stale_nonce"
  | "out_of_scope"
  | "out_of_bounds"
  | "unknown_run";

export type NextAction = "ack" | "remind" | "force_blocked" | "terminal";

export interface DispatchResponse {
  result: DispatchResult;
  strike_count: number;
  next_action: NextAction;
  message: string | null;
}

export interface FsdSetTierResponse {
  session_nonce: string;
  emission_mode: EmissionMode;
}
