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

// ---------------------------------------------------------------------------
// Worktree-isolation policy types (P1 backend mirrors).
// Match `commands::git::*` Rust outputs (serde camelCase). The frontend
// treats these as opaque metadata; the backend owns the validation.
// ---------------------------------------------------------------------------

/** Output of `git_detect_repo` — local-refs-only repo snapshot. */
export interface RepoInfo {
  root: string;
  currentBranch: string | null;
  hasOriginDev: boolean;
  hasLocalDev: boolean;
}

/** Output of `git_worktree_create`. Stored on `SpawnedAgent` so approval
 *  works even after the agent is killed (kill-PTY-at-flip in P2). */
export interface WorktreeMetadata {
  repoRoot: string;
  path: string;
  branch: string;
  baseRef: string;
  baseSha: string;
  /** false signals offline fallback; the approval UI surfaces this as
   *  a "stale base" warning (codex2 #2). */
  baseFresh: boolean;
  createdAtMs: number;
}

/** Raw spawn facts passed by AgentMiniTerminal to addAgent(). Identity fields are computed by the store. */
export interface SpawnedAgentInit {
  sessionId: string;
  tool: ToolId;
  status: "spawning" | "running" | "exited";
  /** Which collaborator pane owns this agent. */
  collabSessionId: string;
  /** Worktree metadata if the agent was spawned in a git repo (P1).
   *  null means either the spawn cwd was not a git repo, or worktree
   *  provisioning failed. P2's awaiting-approval gate is keyed on this
   *  field being non-null. */
  worktree?: WorktreeMetadata | null;
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

/**
 * Task lifecycle states. The five non-terminal states (`pending`,
 * `in-progress`, `awaiting-approval`, `approved-merging`, `merge-conflict`)
 * carry distinct semantics:
 *
 *   pending             — created, may or may not be assigned
 *   in-progress         — agent is actively working
 *   awaiting-approval   — P2 gate: agent wrote .done.json AND the task
 *                         touched git-tracked files in a worktree.
 *                         The agent's PTY is killed at the flip
 *                         (LB1, claude3 task-46 R2 ordering: kill BEFORE
 *                         snapshot). User must Approve / Request Changes
 *                         / Discard.
 *   approved-merging    — orchestrator is mid-merge (transient state
 *                         visible only briefly between Approve click and
 *                         git_merge_worktree completion).
 *   merge-conflict      — orchestrator's merge surfaced a git conflict
 *                         (LB6 GitError::MergeConflict). Worktree is
 *                         preserved; user resolves manually or Discards.
 *
 * Two terminal states:
 *   completed           — task done (either no git delta + auto-completed,
 *                         OR Approved & merged successfully)
 *   blocked             — explicit Discard or unrecoverable failure
 *                         (P2 gate didn't engage and won't auto-retry)
 */
export type TaskStatus =
  | "pending"
  | "in-progress"
  | "awaiting-approval"
  | "approved-merging"
  | "merge-conflict"
  | "completed"
  | "blocked";

/** Worktree-isolation v5 §4 P2.a `pendingMerge` snapshot — captured at
 *  `awaiting-approval` flip, used by the Approve UI to render the diff
 *  and by `git_merge_worktree` to identify the agent branch. Self-
 *  contained per RESID-5: doesn't depend on a live `SpawnedAgent`,
 *  because the agent's PTY is killed at flip (LB1). */
export interface PendingMerge {
  /** Branch name (e.g. `agent/claude_code-session-9-…`). */
  branch: string;
  /** Absolute path to the agent's worktree. */
  worktreePath: string;
  /** Repo root the worktree belongs to (needed by `git_merge_worktree`
   *  even after the SpawnedAgent record is gone). */
  repoRoot: string;
  /** Base ref the worktree was created from (always `origin/dev` in v1). */
  baseRef: string;
  /** Base SHA — the commit the worktree branched from. */
  baseSha: string;
  /** False signals offline fallback at provisioning time; surfaced as a
   *  "stale base" warning in the Approve UI (codex2 #2). */
  baseFresh: boolean;
  /** Diff summary captured at flip time. Tracks all four classes per D2
   *  broadened scope: tracked-modified, staged, unstaged, untracked-non-
   *  ignored. Approve UI renders the diff from this. */
  diffSummary: {
    committed: string[];
    staged: string[];
    unstaged: string[];
    untracked: string[];
  };
  /** Agent handle preserved for traceability after the agent's
   *  SpawnedAgent record is gone (POLISH-5). */
  agentHandle: string;
}

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
  /**
   * P2 awaiting-approval snapshot. Set when `status === "awaiting-approval"
   * | "approved-merging" | "merge-conflict"`. Cleared on `completed` /
   * `blocked` transitions. Self-contained: works after the agent's PTY
   * has been killed at flip (LB1). null in v1 unless the agent ran in a
   * worktree.
   */
  pendingMerge: PendingMerge | null;
}
