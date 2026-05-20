export type ToolId = "claude_code" | "codex_cli" | "gemini_cli" | "copilot_cli";

export interface ToolConfig {
  id: ToolId;
  label: string;
  command: string;
  colorClass: string;
}

export const TOOL_CONFIGS: ToolConfig[] = [
  { id: "claude_code", label: "Claude Code", command: "claude", colorClass: "text-purple-400" },
  { id: "codex_cli", label: "Codex CLI", command: "codex", colorClass: "text-orange-400" },
  { id: "gemini_cli", label: "Gemini CLI", command: "gemini", colorClass: "text-blue-400" },
  { id: "copilot_cli", label: "Copilot CLI", command: "copilot", colorClass: "text-emerald-400" },
];

/** Raw spawn facts passed by AgentMiniTerminal to addAgent(). Identity fields are computed by the store. */
export interface SpawnedAgentInit {
  sessionId: string;
  tool: ToolId;
  status: "spawning" | "running" | "exited";
  /** Which collaborator pane owns this agent. */
  collabSessionId: string;
  /**
   * Pre-minted handle to bypass the store's `nextOrdinal` mint.
   *
   * Used by the peer-context-mirror reservation lifecycle:
   * `reserveAgentHandle` (lib/peerContext.ts) mints the handle BEFORE
   * the spawn IPC so it can be injected as `CT_AGENT_ID` via
   * `extra_env`. The same handle must end up on the `SpawnedAgent`
   * record so the env-derived identity matches the store's identity.
   *
   * When present, `addAgent` skips its own `nextOrdinal` call and
   * derives `ordinal` from the trailing digits of this handle.
   * When absent, the legacy mint-now path is taken — backward
   * compatible for callers that don't use the reservation API
   * (tests, future code).
   */
  handle?: string;
  /**
   * Cross-tool agent context surfacing opt-in (peer-context-mirror feature).
   * Optional on init; `addAgent` defaults to `true` when omitted (cycle F
   * always-on). The Eye toggle in `AgentMiniTerminal.tsx` remains as a
   * per-agent opt-out via `setPublishOptedIn`. Backward-compatible for
   * pre-peer-context-mirror callers (tests, future code) that haven't
   * been migrated.
   *
   * The UI (cycle C) flips this via `setPublishOptedIn`; the watch
   * lifecycle in `AgentMiniTerminal.tsx` gates `invoke('watch_transcript')`
   * on `publishOptedIn === true && status === 'running'`.
   */
  publishOptedIn?: boolean;
}

/** One entry per name change. Append-only; index 0 is the system-set birth name. */
export interface AgentNameRecord {
  /** The nickname value at this point in history. */
  nickname: string;
  /** ISO timestamp this nickname became active. */
  setAt: string;
  /** Who renamed it: "system" (auto-generated at spawn), "user" (UI/slash command), or "@<handle>" (programmatic). */
  setBy: "system" | "user" | `@${string}`;
}

/** Fully materialized agent with stored identity. */
export interface SpawnedAgent extends SpawnedAgentInit {
  /** Monotonic per-tool ordinal within this collab session (1, 2, 3...). Always >= 1. */
  ordinal: number;
  /** IMMUTABLE protocol handle. Always indexed: "claude1", "codex1", "gemini2", "copilot1". The
   *  only string referenced by tasks (`assignee`), recent-outcome maps, conversation
   *  log tags, and `*.done.json` author fields. Never mutates. */
  handle: string;
  /** MUTABLE human-readable display label. Initial value is the system-generated
   *  "Claude Code #1"-style string. The user can rename via the inline header UI or
   *  the `/rename` slash command. Validated to 1-32 chars, must contain at least one
   *  letter or digit, must not collide with another live agent's nickname/handle/slug
   *  in the same `collabSessionId`. */
  nickname: string;
  /** MUTABLE cached `slugify(nickname)` for O(1) collision and dropdown filtering.
   *  Recomputed on `addAgent` and `renameAgent`; never read without the matching
   *  `nickname` write. */
  nicknameSlug: string;
  /** Append-only rename audit. `nameHistory[0]` is the birth name (`setBy: "system"`);
   *  the last entry is always the current nickname. */
  nameHistory: AgentNameRecord[];
  /**
   * Cross-tool agent context surfacing opt-in. `addAgent` defaults this
   * to `true` (cycle F: peer-context-mirror is always-on; Eye toggle
   * remains the per-agent opt-out) when omitted from `SpawnedAgentInit`.
   * Optional on the materialized record too so pre-peer-context-mirror
   * test fixtures (which construct `SpawnedAgent` literals directly,
   * bypassing `addAgent`) continue to compile without `publishOptedIn`
   * boilerplate. Readers MUST check `=== true` (not truthy or `!== false`)
   * so `undefined` (only produced by direct-construction test fixtures)
   * reads as "not publishing".
   */
  publishOptedIn?: boolean;
}

/** Result type returned by `renameAgent`. The store owns the human-readable message
 *  so all rename surfaces (inline UI, `/rename` slash command) share one wording. */
export type RenameResult =
  | { ok: true }
  | {
      ok: false;
      reason: "invalid" | "reserved" | "duplicate" | "not-found";
      message: string;
    };

// ---------------------------------------------------------------------------
// Structured Task
// ---------------------------------------------------------------------------

export type TaskStatus = "pending" | "in-progress" | "completed" | "blocked";

export interface CollabTask {
  /** Unique task id, e.g. "task-1-1713100000000" */
  id: string;
  /** Human-readable title */
  title: string;
  /** Detailed objective — what the agent must accomplish */
  objective: string;
  /** Background context for the agent to understand the task */
  context: string;
  /** Concrete deliverables expected */
  deliverables: string[];
  /** Assigned agent mention name (e.g. "@claude", "@codex1"), or null for unassigned */
  assignee: string | null;
  /** Dependencies — task IDs or descriptions this task depends on */
  dependencies: string[];
  /** Current status */
  status: TaskStatus;
  /** Detailed reasoning — why this approach, alternatives considered, trade-offs */
  reasoning: string | null;
  /** Conclusion — what was decided/done (1-3 sentences) */
  conclusion: string | null;
  /** Output — file paths, artifacts, or key results produced */
  output: string | null;
  /** Who actually completed this task (from .done.json author field). Distinct from assignee. */
  completedBy: string | null;
  /** ISO timestamp of creation */
  createdAt: string;
  /** ISO timestamp of last update */
  updatedAt: string;
  /**
   * ISO timestamp of the last assignment event. Initially equal to
   * `createdAt`; refreshed when `updateTask` changes `assignee`. Used by
   * the in-frame indicator's freshness gate so re-assignments (e.g. via
   * `/task <id> assign @<agent>`) correctly preempt a lingering completion
   * highlight even when the task was originally created long before.
   */
  assignedAt: string;
}
