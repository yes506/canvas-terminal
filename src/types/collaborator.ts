export type ToolId = "claude_code" | "codex_cli" | "gemini_cli";

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
];

/** Raw spawn facts passed by AgentMiniTerminal to addAgent(). Identity fields are computed by the store. */
export interface SpawnedAgentInit {
  sessionId: string;
  tool: ToolId;
  status: "spawning" | "running" | "exited";
  /** Which collaborator pane owns this agent. */
  collabSessionId: string;
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
  /** IMMUTABLE protocol handle. Always indexed: "claude1", "codex1", "gemini2". The
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
