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
 *                         produced a "source delta" in its worktree.
 *                         Source delta = D2 broadened scope: any of
 *                         (a) committed changes against baseSha,
 *                         (b) staged-but-uncommitted changes,
 *                         (c) unstaged changes to tracked files,
 *                         (d) untracked-non-ignored files.
 *                         The agent's PTY is left alive at the flip so
 *                         the user can keep talking to it on the same
 *                         worktree lease. The freeze-before-snapshot
 *                         invariant (claude3 task-46 R2) moves to the
 *                         Approve / Discard handlers and to terminal-
 *                         close (cleanupWorktreedAgent), each of which
 *                         calls kill_pty before reading or removing
 *                         the worktree. User must Approve / Request
 *                         Changes / Discard.
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

/**
 * Round-28 (claude3 task-139 O3): classify a `TaskStatus` by its
 * position in the task lifecycle. Centralizing the classification
 * here means adding a new status to `TaskStatus` is a single-point
 * edit — TypeScript's exhaustiveness check on the switch below
 * forces every consumer to handle the new state.
 *
 * Phases:
 *   - "active":         agent is actively working; PTY alive; can
 *                       receive `inject_into_pty`. Currently
 *                       `pending` | `in-progress`. Used by
 *                       sendToAgent / broadcastToAll's refresh
 *                       decision.
 *   - "review-or-merge": agent has finished writing a `.done.json`;
 *                       task is in the P2 approval/merge pipeline.
 *                       The PTY may still be alive in this phase —
 *                       the freeze-before-snapshot kill moved out of
 *                       LB1 (the scanner) into the Approve / Discard
 *                       handlers and terminal-close, so the user can
 *                       keep talking to the agent while the task waits
 *                       for review. User action may be required
 *                       (`awaiting-approval`, `merge-conflict`) or
 *                       merge is in flight (`approved-merging`).
 *   - "terminal":       task is done — `completed` (success) or
 *                       `blocked` (abandoned).
 *
 * The bug fixed in round-27 (status mismatch) was rooted in
 * inconsistent status classification across consumers. The
 * predicates below replace inline `=== "completed" || === "blocked"`
 * checks at every call site so the same drift can't recur.
 */
export type TaskLifecyclePhase = "active" | "review-or-merge" | "terminal";

export function classifyTaskStatus(status: TaskStatus): TaskLifecyclePhase {
  switch (status) {
    case "pending":
    case "in-progress":
      return "active";
    case "awaiting-approval":
    case "approved-merging":
    case "merge-conflict":
      return "review-or-merge";
    case "completed":
    case "blocked":
      return "terminal";
    default: {
      // Round-29 (codex1 task-140 #4 + claude3 task-143 O1): explicit
      // `assertNever`-style exhaustiveness. TypeScript's flow analysis
      // would already flag a non-returning function under `strict`,
      // but assigning the variable to `never` produces an immediate,
      // localized type error at the unhandled case — making the
      // exhaustiveness contract visible at the switch itself rather
      // than as a "Not all code paths return" error elsewhere.
      const _exhaustive: never = status;
      return _exhaustive;
    }
  }
}

/** Convenience: true iff status is a terminal state (completed/blocked). */
export function isTerminalStatus(s: TaskStatus): boolean {
  return classifyTaskStatus(s) === "terminal";
}
/** Convenience: true iff status is active (pending/in-progress; PTY alive). */
export function isActiveStatus(s: TaskStatus): boolean {
  return classifyTaskStatus(s) === "active";
}

/** Worktree-isolation v5 §4 P2.a `pendingMerge` snapshot — captured at
 *  `awaiting-approval` flip, used by the Approve UI to render the diff
 *  and by `git_merge_worktree` to identify the agent branch. Self-
 *  contained per RESID-5: doesn't depend on a live `SpawnedAgent`, so
 *  the snapshot survives the agent's eventual PTY exit (which now
 *  happens at terminal-close / Approve / Discard, not at gate flip).
 *  The Approve handler re-snapshots `diffSummary` against a freshly
 *  killed PTY before deciding whether to issue an approval-commit, so
 *  the field captured here is a PREVIEW for the awaiting-approval UI. */
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
   * `blocked` transitions. Self-contained: doesn't depend on a live
   * `SpawnedAgent`, so the snapshot survives the agent's eventual PTY
   * exit (which now happens at terminal-close / Approve / Discard, not
   * at gate flip). null in v1 unless the agent ran in a worktree.
   */
  pendingMerge: PendingMerge | null;
}
