import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import type {
  SpawnedAgent,
  SpawnedAgentInit,
  ToolId,
  CollabTask,
  AgentNameRecord,
  RenameResult,
} from "../types/collaborator";
import { TOOL_CONFIGS } from "../types/collaborator";
import { muteCapture } from "../lib/agentOutputCapture";
import { useTerminalStore } from "./terminalStore";

// ---------------------------------------------------------------------------
// Per-agent task outcome — drives the in-frame status light + message that
// replaces the global toast. Cleared automatically after RECENT_OUTCOME_TTL_MS
// so the highlight is transient but long enough to register visually.
// ---------------------------------------------------------------------------

export interface AgentRecentOutcome {
  /**
   * The underlying terminal-state flavor — kept so the rendered label can
   * decorate with ✓ vs ⚠. Note that the *visible state machine* collapses
   * both flavors into a single `completed` state (see AgentTaskState).
   */
  kind: "completed" | "blocked";
  taskId: string;
  taskTitle: string;
  /** Epoch ms at which this outcome was recorded. */
  at: number;
}

/**
 * Three-state machine for what an agent is doing right now:
 *
 *   idle ──(task assigned)──► in_progress ──(terminal status)──► completed
 *                                ▲                                  │
 *                                │                                  │
 *                                └────(task freshly assigned)───────┤
 *                                                                   │
 *                                          (5s elapsed, no new task)
 *                                                                   ▼
 *                                                                 idle
 *
 * `outcomeKind` is only populated when `kind === "completed"` and tells the
 * renderer whether to label the highlight ✓ (completed) or ⚠ (blocked).
 */
export interface AgentTaskState {
  kind: "idle" | "in_progress" | "completed";
  taskId?: string;
  taskTitle?: string;
  outcomeKind?: "completed" | "blocked";
}

export const RECENT_OUTCOME_TTL_MS = 5000;
/**
 * How long a `setStatus` footer message stays before auto-clearing.
 * Mirrors the cadence of the (deleted) PR-A 4 s self-clear so footer
 * acknowledgements ("Sent to …", "Broadcast sent …", etc.) don't go stale.
 * Exported so tests reference the constant rather than hard-coding 4000.
 */
export const STATUS_TTL_MS = 4000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TOOL_LABELS: Record<string, string> = Object.fromEntries(
  TOOL_CONFIGS.map((t) => [t.id, t.label]),
);

export function toolLabel(tool: string): string {
  return TOOL_LABELS[tool] ?? tool;
}

/** Short name used for @-mentions (e.g. "claude", "codex", "gemini"). */
export function toolShortName(tool: ToolId): string {
  const cfg = TOOL_CONFIGS.find((t) => t.id === tool);
  return cfg?.command ?? tool;
}

/** Return the current display label for an agent. Always reads `nickname`,
 *  which is mutable; `nameHistory[0].nickname` carries the original system-set
 *  birth name for callers that need to show "Spawned as: …". */
export function agentDisplayName(agent: SpawnedAgent): string {
  return agent.nickname;
}

/**
 * Build the list of @-mentionable names from the current agent set.
 * Derives directly from stored handles: ["claude1", "codex1", "claude2"].
 */
export function mentionableNames(agents: SpawnedAgent[]): string[] {
  return agents.map((a) => a.handle);
}

/** Return the stored @-mention handle for an agent. */
export function agentMentionName(agent: SpawnedAgent): string {
  return agent.handle;
}

// ---------------------------------------------------------------------------
// Indicator presentation — pure mapping from (lifecycle × task state) to the
// visual + a11y attributes the AgentMiniTerminal header renders. Extracted
// from the component so the precedence rules can be unit-tested without
// rendering the full xterm/PTY-spawning component (a 5-round-old request).
// ---------------------------------------------------------------------------

export type AgentLifecycle = "spawning" | "running" | "exited" | "pre-registration";

export interface IndicatorPresentation {
  /** Tailwind background class for the dot. */
  color: string;
  /** Tailwind ring class around the dot — visible even with reduced motion. */
  ringColor: string;
  /** Whether to apply `motion-safe:animate-pulse` to the dot. */
  pulse: boolean;
  /** Whether to render the `motion-safe:animate-ping` halo behind the dot. */
  ping: boolean;
  /** User-facing label rendered next to the agent name. */
  label: string;
  /** Tailwind text-color class for the label. */
  tone: string;
  /** ARIA role on the label span. `alert` for blocked-as-completed, `status` otherwise. */
  liveRole: "status" | "alert";
  /** ARIA aria-live level on the label span. */
  liveLevel: "polite" | "assertive";
}

/**
 * Map (lifecycle, task state) → indicator presentation. Lifecycle outranks
 * task state so users aren't told an agent is "idle" while it's still booting
 * or after it died. Within `completed`, `outcomeKind` decorates the label
 * (✓ emerald vs ⚠ amber) without splitting the visible state machine.
 */
export function getIndicatorPresentation(
  lifecycle: AgentLifecycle,
  taskState: AgentTaskState,
): IndicatorPresentation {
  const isBlockedOutcome =
    taskState.kind === "completed" && taskState.outcomeKind === "blocked";
  const liveRole: "status" | "alert" = isBlockedOutcome ? "alert" : "status";
  const liveLevel: "polite" | "assertive" = isBlockedOutcome ? "assertive" : "polite";

  if (lifecycle === "exited") {
    return { color: "bg-gray-500", ringColor: "ring-gray-400/40", pulse: false, ping: false, label: "exited", tone: "text-text-dim", liveRole, liveLevel };
  }
  if (lifecycle === "spawning" || lifecycle === "pre-registration") {
    return { color: "bg-yellow-400", ringColor: "ring-yellow-300/40", pulse: true, ping: false, label: "starting…", tone: "text-yellow-300", liveRole, liveLevel };
  }
  if (taskState.kind === "in_progress") {
    return {
      color: "bg-sky-400",
      ringColor: "ring-sky-300/40",
      pulse: true,
      ping: false,
      label: taskState.taskTitle ? `in progress: ${taskState.taskTitle}` : "in progress",
      tone: "text-sky-300",
      liveRole,
      liveLevel,
    };
  }
  if (taskState.kind === "completed") {
    if (isBlockedOutcome) {
      return {
        color: "bg-amber-500",
        ringColor: "ring-amber-300/70",
        pulse: true,
        ping: true,
        label: `⚠ ${taskState.taskTitle ?? "task blocked"}`,
        tone: "text-amber-300",
        liveRole,
        liveLevel,
      };
    }
    return {
      color: "bg-emerald-400",
      ringColor: "ring-emerald-300/70",
      pulse: false,
      ping: true,
      label: `✓ ${taskState.taskTitle ?? "task complete"}`,
      tone: "text-emerald-300",
      liveRole,
      liveLevel,
    };
  }
  return { color: "bg-green-400/60", ringColor: "ring-green-400/0", pulse: false, ping: false, label: "idle", tone: "text-text-dim", liveRole, liveLevel };
}

/**
 * Resolve what an agent is currently doing for the in-frame status indicator.
 *
 * Precedence (per task-16 spec, refined for "freshly-assigned" semantics):
 *
 *   1. *Freshly-assigned* active task → `in_progress`. "Freshly assigned"
 *      means a pending/in-progress task whose `assignedAt` is at-or-after
 *      the last terminal-state outcome (or any active task at all when no
 *      recent outcome exists). `assignedAt` — not `createdAt` — is the
 *      load-bearing field: it's set on creation but also refreshed on
 *      `updateTask({assignee})` (re-assignment) and on `bumpAssignedAt`
 *      (fresh send to an existing task). When multiple active tasks are
 *      assigned to the same agent, the **most recent** one wins so the
 *      header reflects the latest work, not the oldest backlog item.
 *
 *   2. Recent terminal-state outcome still within RECENT_OUTCOME_TTL_MS →
 *      `completed` (with `outcomeKind` carrying the ✓/⚠ flavor). A
 *      pre-existing backlog task that was assigned *before* the outcome
 *      does NOT preempt the highlight — that would let stale work mask
 *      the user-visible completion signal.
 *
 *   3. Otherwise → `idle`.
 *
 * Self-correcting TTL guard: `Date.now() - outcome.at < TTL`. Browsers throttle
 * timers in backgrounded tabs, so a stored outcome may outlive its setTimeout
 * cleanup; guarding inside the helper makes the rendered state self-correct
 * once the user returns to the tab.
 */
export function getAgentTaskState(
  collabSessionId: string,
  handle: string,
  tasks: CollabTask[],
  recentOutcomesBySession: Record<string, Record<string, AgentRecentOutcome>>,
): AgentTaskState {
  const mention = `@${handle}`;
  const recent = recentOutcomesBySession[collabSessionId]?.[handle];
  const recentValid = !!recent && Date.now() - recent.at < RECENT_OUTCOME_TTL_MS;

  // Delegate the "freshest active task" pick to the shared helper so the
  // selection rule lives in exactly one place. Without this, drift between
  // the indicator's display logic and `bumpAssignedAt`'s target picker is
  // exactly the bug @codex3 found in round 5 (oldest-vs-freshest). The
  // helper also returns the parsed ms so we don't re-parse `assignedAt`
  // for the freshness gate (claude1 D1 + claude3 D3 from round 7).
  const found = findFreshestActiveTaskForMention(tasks, mention);

  if (found) {
    // "Freshly assigned" = no recent outcome to honor, OR the active task
    // was assigned at-or-after the outcome was recorded. We use `>=` rather
    // than strict `>` so that a synchronous flow (e.g. sendToAgent
    // immediately after a completion landing at the same `Date.now()` ms
    // tick) still promotes the new task. Backlog stays gated because its
    // `assignedAt` is strictly less than `recent.at`.
    const freshAfterOutcome = !recentValid || found.assignedAtMs >= recent!.at;
    if (freshAfterOutcome) {
      return { kind: "in_progress", taskId: found.task.id, taskTitle: found.task.title };
    }
  }

  if (recentValid) {
    return {
      kind: "completed",
      taskId: recent!.taskId,
      taskTitle: recent!.taskTitle,
      outcomeKind: recent!.kind,
    };
  }
  return { kind: "idle" };
}

// ---------------------------------------------------------------------------
// Per-tool ordinal counter — monotonic, never reuses ordinals
// ---------------------------------------------------------------------------

const toolOrdinalCounters = new Map<string, number>();

function nextOrdinal(collabSessionId: string, tool: ToolId): number {
  const key = `${collabSessionId}:${tool}`;
  const next = (toolOrdinalCounters.get(key) ?? 0) + 1;
  toolOrdinalCounters.set(key, next);
  return next;
}

function resetOrdinalCounters(forSession: string): void {
  for (const key of toolOrdinalCounters.keys()) {
    if (key.startsWith(`${forSession}:`)) {
      toolOrdinalCounters.delete(key);
    }
  }
}

// ---------------------------------------------------------------------------
// Conversation log
// ---------------------------------------------------------------------------

interface LogEntry {
  time: string; // HH:MM:SS
  role: "user" | "system" | "agent";
  agent?: string; // e.g. "@claude2" — only set when role === "agent"
  content: string;
}

function nowTime(): string {
  return new Date().toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function formatLogEntry(e: LogEntry): string {
  let tag: string;
  if (e.role === "user") tag = "User";
  else if (e.role === "agent") tag = e.agent ?? "Agent";
  else tag = "System";
  return `## [${e.time}] ${tag}\n${e.content}\n`;
}

// Per-session conversation-log write chains. Each appendLog() call links
// onto the previous one for THAT session, so writes within a session are
// serialized but cross-session activity is independent. Splitting this
// from the prior global singleton (codex1 + claude3 round-9 finding)
// closes the cross-session blocking case where killAllAgents(A) had to
// wait on session B's pending log writes.
const conversationWriteChainsBySession = new Map<string, Promise<unknown>>();

// Per-session task-markdown write chain. Each persistTasks() call links
// onto the previous one for that session, so an earlier write always
// resolves before a later one fires. Without this, a rapid burst of
// `bumpAssignedAt(...)` calls (e.g. inside `broadcastToAll` across N
// agents in the same session) could fire N concurrent invoke() writes
// and let an older snapshot land *after* a newer one — leaving the
// markdown stale relative to in-memory state. Mirrors the cadence of
// `conversationWriteChain`.
const taskWriteChainsBySession = new Map<string, Promise<unknown>>();

// Sessions currently mid-teardown. Any chain step (task OR conversation)
// that resolves while a session is in this set MUST short-circuit and skip
// the write — otherwise a queued write fires AFTER
// `killAllAgents`/`endSession` already deleted `tasks-{sid}.md` or
// `conversation-{sid}.md`, recreating the file with stale content
// (codex1 round-7 + claude3 round-7+9 teardown races). Renamed from
// `abortedSessions` in round-10 since it now gates BOTH file-
// write paths, not just tasks.
const abortedSessions = new Set<string>();

// Per-agent in-flight first-send promise. Enforces ORDERING during the
// first-send window: while a first-send is running for a sessionId, any
// concurrent send to the same agent waits for it to settle before deciding
// header shape. Without this, a slim send could overtake the first full
// send at the PTY and the agent would receive a slim message before ever
// learning the protocol — breaking the slim-header design's correctness
// argument. The `contextSentByAgent` flag in store state remains the
// source of truth for what the next sender SHOULD do; this map enforces
// the wait-and-then-re-check loop. Cleared on resolve/reject in `finally`.
const firstSendInflight = new Map<string, Promise<void>>();

/**
 * Per-rename one-shot flag. Forces the next send (sendToAgent OR broadcastToAll)
 * for `sessionId` to use the FULL header so the agent re-learns its identity
 * after a rename. Drained on the success branch of the inject, paired with the
 * existing `contextSentByAgent[sessionId] := true` write — both writes invalidate
 * the "rename-since-last-emit" claim and must move together if either is moved.
 *
 * Orthogonal to `firstSendInflight`: that map tracks per-send PROMISES used to
 * await concurrent first-sends. This set tracks whether the agent has been
 * RENAMED since its last full-header emission. Different lifetimes, different
 * consumers, different cleanup sites. Cleared in removeAgent / killAllAgents /
 * endSession / _resetWriteStateForTests, parallel to `firstSendInflight`.
 */
const renamePendingByAgent = new Set<string>();

/**
 * NFKC-normalize, lowercase, replace any run of whitespace/punctuation/symbols
 * with `-`, trim leading/trailing `-`. Used for nickname collision checks and
 * dropdown filtering. Returns "" for inputs that contain no letters/digits;
 * `renameAgent` rejects those at validation time.
 */
export function slugify(s: string): string {
  return s
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s\p{P}\p{C}\p{S}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Test-only reset hook for module-level write state. Vitest test isolation
 * via `resetStores()` doesn't reach into module-scoped maps/sets, so a
 * teardown-race test can leave an abort marker that stomps on the next
 * test using the same SESSION ID. Tests should call this in `beforeEach`.
 *
 * Renamed from `_resetTaskWriteStateForTests` in round-11 since it now
 * resets BOTH write-chain maps plus the abort set (claude3 D4). Now also
 * clears `firstSendInflight` so a test that exercises the gating doesn't
 * leave a stale promise behind for the next SESSION ID.
 */
export function _resetWriteStateForTests(): void {
  taskWriteChainsBySession.clear();
  conversationWriteChainsBySession.clear();
  abortedSessions.clear();
  firstSendInflight.clear();
  renamePendingByAgent.clear();
}

/**
 * Test-only inspector for the module-level `renamePendingByAgent` set. The
 * production code never reads this externally — but tests need to assert state
 * directly to catch silent regressions: e.g., a future refactor that moves
 * the `.add()` above the no-op short-circuit, or drops one of the four cleanup
 * sites, would not be caught by observable-behavior tests alone (claude3 V6-3).
 */
export function _isRenamePendingForTests(sessionId: string): boolean {
  return renamePendingByAgent.has(sessionId);
}

// ---------------------------------------------------------------------------
// Task protocol — injected into every agent prompt
// ---------------------------------------------------------------------------

const TASK_PROTOCOL = `
## Agent Task Protocol

You are a participant in a multi-agent collaboration.

### Rules
1. **Read before acting**: Read the conversation log and \`context.md\` (if present) in the shared memory directory to understand prior context and other agents' work.
2. **Be self-contained**: Include enough detail that any other agent can understand what you did.
3. **Reference by task ID** (e.g. "task-1-...").
4. **Signal blockers**: State the blocking task ID and what you need.
5. **Signal completion**: When done, write a JSON file to the shared memory directory to signal task completion. The system will automatically update the task and generate a report in the conversation log.

\`\`\`bash
cat > SHARED_MEMORY_DIR/TASK_ID.done.json << 'EOF'
{
  "task_id": "TASK_ID",
  "author": "YOUR_IDENTITY",
  "status": "completed",
  "reasoning": "Why this approach, alternatives considered, trade-offs",
  "conclusion": "What was decided/done (1-3 sentences)",
  "output": "file paths, artifacts, or key results"
}
EOF
\`\`\`

Replace \`SHARED_MEMORY_DIR\` with the path shown above, \`TASK_ID\` with your assigned task ID, and \`YOUR_IDENTITY\` with your agent identity (shown in the header above, e.g. @claude1).

### File Conventions
- \`conversation-*.md\` — **Read only** for context. Do NOT write to it directly. The system appends task reports automatically when task status changes.
- Task definitions file — **READ ONLY**.
- \`context.md\` — Shared context (if present).
- Shared memory directory — Write files here to share artifacts with other agents.
`.trim();

/**
 * Format tasks array into a markdown document for shared memory.
 *
 * The optional `agents` argument lets the writer decorate `@<handle>`
 * references in `**Assignee**:` and `**Completed By**:` with the agent's
 * current nickname (e.g. `@claude2 (reviewer-2)`). When omitted — or when
 * the assigned handle no longer maps to a live agent — the bare canonical
 * `@<handle>` is rendered, preserving the existing on-disk audit format.
 */
function formatTasksMarkdown(tasks: CollabTask[], agents?: SpawnedAgent[]): string {
  if (tasks.length === 0) return "# Collaboration Tasks\n\nNo tasks defined yet.\n";

  const nickByHandle = buildNicknameIndex(agents);
  const lines = ["# Collaboration Tasks\n"];
  for (const t of tasks) {
    lines.push(`## ${t.id} — ${t.status}`);
    lines.push(`**Title**: ${t.title}`);
    lines.push(`**Assignee**: ${formatAgentRef(t.assignee, t.assignee ? nickByHandle.get(t.assignee.trim()) : null)}`);
    lines.push(`**Objective**: ${t.objective}`);
    if (t.context) lines.push(`**Context**: ${t.context}`);
    if (t.deliverables.length > 0) {
      lines.push("**Deliverables**:");
      for (const d of t.deliverables) lines.push(`  - ${d}`);
    }
    if (t.dependencies.length > 0) {
      lines.push(`**Dependencies**: ${t.dependencies.join(", ")}`);
    }
    if (t.completedBy) lines.push(`**Completed By**: ${formatAgentRef(t.completedBy, nickByHandle.get(t.completedBy.trim()))}`);
    if (t.reasoning) lines.push(`**Reasoning**: ${t.reasoning}`);
    if (t.conclusion) lines.push(`**Conclusion**: ${t.conclusion}`);
    if (t.output) lines.push(`**Output**: ${t.output}`);
    lines.push(`**Created**: ${t.createdAt}`);
    lines.push(`**Assigned**: ${t.assignedAt}`);
    lines.push(`**Updated**: ${t.updatedAt}`);
    lines.push("");
  }
  return lines.join("\n");
}

/** Maximum length of an objective string before truncation in summary. */
const OBJECTIVE_TRUNCATE_AT = 120;

/** Slim-header cap on "others" task entries. Beyond this, render an
 *  `... and N more` line. Prevents O(N) growth of the slim payload as the
 *  collaboration scales (codex2 task-10 finding). */
const SLIM_OTHERS_CAP = 5;

/**
 * Build a recipient-aware, status-filtered task summary for context-header
 * injection. Replaces the older `formatTaskSummaryForPrompt` (v0.1.6) which
 * iterated ALL tasks regardless of status — that grew the slim header
 * unboundedly as completed tasks accumulated.
 *
 * What this version does (vs. the predecessor):
 *   - Filter to active tasks only (`pending` | `in-progress`). Completed
 *     and blocked tasks become history; if an agent needs them, the tasks
 *     file path is in the header.
 *   - Split into "yours" + "others" when `recipient` is provided. Each
 *     agent only needs full detail for tasks assigned to it (or
 *     unassigned, which anyone could pick up). Other agents' tasks
 *     appear as one-line entries so the recipient still has coordination
 *     context without paying for everyone else's full objectives.
 *   - Truncate long objectives to OBJECTIVE_TRUNCATE_AT chars (full text
 *     remains in the tasks file).
 *   - Strip the 13-char `Date.now()` suffix from rendered task IDs
 *     (storage keeps the long form for uniqueness; the rendered prompt
 *     doesn't need it).
 *
 * `recipient` is the bare handle (e.g. "claude1", no "@" prefix) — same
 * value already threaded through as `mention` / `identity`.
 */
export function formatTaskSummaryForAgent(
  tasks: CollabTask[],
  recipient: string | null,
  options: { othersCap?: number } = {},
): string {
  const active = tasks.filter(
    (t) => t.status === "pending" || t.status === "in-progress",
  );
  if (active.length === 0) return "";

  const mention = recipient ? `@${recipient}` : null;
  // Unassigned tasks count as "yours" — anyone could pick them up, and
  // tucking them under "others" would hide them from every agent.
  const mine = mention
    ? active.filter((t) => t.assignee === mention || t.assignee === null)
    : active;
  const others = mention
    ? active.filter((t) => t.assignee && t.assignee !== mention)
    : [];

  const renderId = (id: string) => id.replace(/-\d{13}$/, "");
  const truncateObj = (s: string) =>
    s.length > OBJECTIVE_TRUNCATE_AT
      ? s.slice(0, OBJECTIVE_TRUNCATE_AT - 3) + "..."
      : s;

  const lines: string[] = [];
  if (mine.length > 0) {
    // When recipient is known, label the bucket as "yours". When recipient
    // is null (broadcast / unscoped context), the bucket is the entire
    // active list, so the neutral label is more accurate (claude2 task-28
    // cosmetic observation).
    lines.push(mention ? "\n## Your active tasks" : "\n## Active tasks");
    for (const t of mine) {
      lines.push(`- [${t.status}] ${renderId(t.id)}: ${t.title}`);
      // Only emit Objective if it adds info beyond the title; the chat
      // history already has the user's prompt that originated the task.
      if (t.objective && t.objective !== t.title) {
        lines.push(`  Objective: ${truncateObj(t.objective)}`);
      }
      if (t.deliverables.length > 0) {
        lines.push(`  Deliverables: ${t.deliverables.join("; ")}`);
      }
      if (t.dependencies.length > 0) {
        lines.push(`  Depends on: ${t.dependencies.join(", ")}`);
      }
    }
  }
  if (others.length > 0) {
    const cap = options.othersCap;
    const visible = cap != null && others.length > cap ? others.slice(0, cap) : others;
    const hidden = others.length - visible.length;
    lines.push(`\n## Other agents' active tasks (${others.length})`);
    for (const t of visible) {
      lines.push(`- ${renderId(t.id)} (${t.assignee}): ${t.title}`);
    }
    if (hidden > 0) {
      lines.push(`- ... and ${hidden} more`);
    }
  }
  return lines.join("\n");
}

let taskCounter = 0;

function taskFileRelativePath(collabSessionId: string): string {
  return `tasks-${collabSessionId}.md`;
}

/**
 * Pick the freshest active (pending/in-progress) task assigned to a given
 * mention — i.e., the one with the largest `assignedAt`. Returns the
 * parsed ms timestamp alongside the task so callers don't re-parse the
 * ISO string (`getAgentTaskState` needs `assignedAtMs` for the freshness
 * gate; `bumpAssignedAt` callers can ignore it). Single-pass scan, no
 * `.sort()` copy.
 */
function findFreshestActiveTaskForMention(
  tasks: CollabTask[],
  mention: string,
): { task: CollabTask; assignedAtMs: number } | null {
  let freshest: CollabTask | null = null;
  let freshestMs = -Infinity;
  for (const t of tasks) {
    if (t.assignee !== mention) continue;
    if (t.status !== "pending" && t.status !== "in-progress") continue;
    const ms = new Date(t.assignedAt).getTime();
    if (ms > freshestMs) {
      freshest = t;
      freshestMs = ms;
    }
  }
  return freshest ? { task: freshest, assignedAtMs: freshestMs } : null;
}

/**
 * Internal helper: refresh `assignedAt` on a still-active task without
 * changing assignee/status/updatedAt. Used by sendToAgent / broadcastToAll
 * when reusing an existing pending task — the message itself is a fresh
 * act of assignment from the user's perspective, so the freshness gate
 * should classify the task as fresh post-bump.
 *
 * Notes:
 * - Does NOT bump `updatedAt`. That field tracks "last meaningful field
 *   change" (status, assignee, content); a send-without-task-change
 *   shouldn't move it.
 * - Persists the task list to the markdown file so the on-disk audit
 *   record matches the in-memory state. (`addTask` and `updateTask` both
 *   persist; this helper now matches that contract.)
 */
/**
 * Resolve the human-readable author of a task — `completedBy` if present
 * (the agent that actually wrote the .done.json), otherwise `assignee`,
 * otherwise null. Both inputs are trimmed so an empty-string or whitespace-
 * only value falls through (the agent-protocol JSON could legally deliver
 * `"author": ""`). Used by both the structured Task Report header and the
 * outcome-routing path so the two stay consistent — the prior duplication
 * of this expression at two sites was exactly the drift bait that
 * motivated extracting `findFreshestActiveTaskForMention` last round.
 */
function resolveTaskAuthor(task: CollabTask): string | null {
  return task.completedBy?.trim() || task.assignee?.trim() || null;
}

/**
 * Render an agent reference with both its canonical handle (the immutable
 * `@<handle>` identity used for handle-keyed lookups and protocol strings)
 * AND, when known, its current human-readable nickname in parentheses.
 *
 * The handle is preserved verbatim so downstream readers (regex filters,
 * task-mention parsers) keep matching; the nickname is appended only as a
 * trailing `(label)` decoration. When the nickname is unknown — e.g. an
 * agent that has been removed from the session, or a task created before
 * the matching agent spawned — the function returns the bare handle.
 *
 * Used by:
 *  - `formatTasksMarkdown` (Assignee / Completed By lines on disk)
 *  - the conversation-log Task Report `**Agent**:` header
 *  - the conversation-log `Task created:` line
 *  - the `[Your identity: …]` and `[You are …]` context-header lines
 *    injected into every agent prompt
 *
 * Format: `@claude2 (reviewer-2)` — paren style. Mirrors the rename log's
 * pre-existing convention of writing nicknames inside double quotes/parens.
 */
function formatAgentRef(
  mention: string | null | undefined,
  nickname: string | null | undefined,
): string {
  if (!mention) return "unassigned";
  const trimmedMention = mention.trim();
  if (!trimmedMention) return "unassigned";
  const handle = trimmedMention.startsWith("@") ? trimmedMention : `@${trimmedMention}`;
  const nick = nickname?.trim();
  return nick ? `${handle} (${nick})` : handle;
}

/**
 * Build a handle→nickname index from a list of currently-spawned agents.
 *
 * Skips `status === "exited"` agents so dead agents don't keep contributing
 * presentational decorations to persisted task/report formatting after the
 * PTY closes. (codex1 task-7 + codex2 task-9 cross-validated finding —
 * `setAgentStatus(sessionId, "exited")` leaves the agent in `store.agents`
 * until `removeAgent` runs, so without this filter the documented
 * "fall back to bare @handle when the agent has exited" invariant
 * was not actually enforced.)
 */
function buildNicknameIndex(agents: SpawnedAgent[] | undefined): Map<string, string> {
  const idx = new Map<string, string>();
  if (!agents) return idx;
  for (const a of agents) {
    if (a.status === "exited") continue;
    if (a.nickname) idx.set(`@${a.handle}`, a.nickname);
  }
  return idx;
}

function bumpAssignedAt(
  taskId: string,
  forSession: string,
  set: (updater: (s: CollaboratorState) => Partial<CollaboratorState>) => void,
): void {
  const nowIso = new Date().toISOString();
  set((s) => ({
    tasksBySession: {
      ...s.tasksBySession,
      [forSession]: (s.tasksBySession[forSession] ?? []).map((t) =>
        t.id === taskId ? { ...t, assignedAt: nowIso } : t,
      ),
    },
  }));
  // Fire-and-forget persist (matches addTask/updateTask cadence).
  useCollaboratorStore.getState().persistTasks(forSession);
}

function ensureSessionMemoryFiles(collabSessionId: string): void {
  const conversationPath = `conversation-${collabSessionId}.md`;
  invoke<string | null>("read_memory_file", {
    relativePath: conversationPath,
  })
    .then((existing) => {
      if (existing === null) {
        return invoke("write_memory_file", {
          relativePath: conversationPath,
          content: "# Collaborator Conversation Log\n",
        });
      }
      return null;
    })
    .catch(() => {});

  const tasksPath = taskFileRelativePath(collabSessionId);
  invoke<string | null>("read_memory_file", {
    relativePath: tasksPath,
  })
    .then((existing) => {
      if (existing === null) {
        return invoke("write_memory_file", {
          relativePath: tasksPath,
          content: formatTasksMarkdown([]),
        });
      }
      return null;
    })
    .catch(() => {});
}

// ---------------------------------------------------------------------------
// Shared memory helpers
// ---------------------------------------------------------------------------

let memoryDirCache: string | null = null;

async function getMemoryDir(): Promise<string> {
  if (!memoryDirCache) {
    memoryDirCache = await invoke<string>("init_memory_dir");
  }
  return memoryDirCache;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

interface CollaboratorState {
  agents: SpawnedAgent[];
  statusMessages: Record<string, string>;
  /** Input history per collaborator session. */
  inputHistoryBySession: Record<string, string[]>;
  /** Current history navigation index per session (-1 = not navigating). */
  historyIndexBySession: Record<string, number>;
  /** Saves the in-progress input when the user starts navigating history, per session. */
  draftInputBySession: Record<string, string>;
  /** In-memory conversation log entries, keyed by collaborator session. */
  logEntriesBySession: Record<string, LogEntry[]>;
  /** Structured tasks for multi-agent collaboration, keyed by collaborator session. */
  tasksBySession: Record<string, CollabTask[]>;
  /** Prefilled input value set externally (e.g. canvas toolbar), keyed by collabSessionId. */
  pendingInputs: Record<string, string>;
  /** Messages queued while an agent is still spawning (keyed by agent sessionId). */
  pendingMessagesByAgent: Record<string, string[]>;
  /**
   * Per-collab-session map of `handle -> recent task outcome`. Drives the
   * status light and state message rendered on each agent's mini-terminal
   * frame. Entries are auto-cleared after RECENT_OUTCOME_TTL_MS.
   */
  recentOutcomesBySession: Record<string, Record<string, AgentRecentOutcome>>;
  /**
   * Per-agent flag tracking whether the full context header (paths +
   * identity + TASK_PROTOCOL + active-task summary) has been successfully
   * injected at least once.
   *   absent     → next send is the first; uses full header
   *   "inflight" → first full-header send is mid-flight; concurrent sends
   *                MUST await `firstSendInflight.get(sessionId)` first so
   *                the first PTY-arrival is always the full-header message
   *   true       → first send confirmed; subsequent sends use slim header
   * Cleared in removeAgent / endSession / killAllAgents. The slim header
   * stays implementable because the agent's CLI tool retains the protocol
   * from message #1 (with a 1-line breadcrumb fallback for very long
   * conversations whose context summarized away the original).
   */
  contextSentByAgent: Record<string, true | "inflight">;

  // Session lifecycle
  startSession: (id: string) => void;
  /**
   * In-memory-only teardown for a collab session: drops zustand state
   * and per-session chain entries, marks the session aborted so any
   * queued chain step short-circuits. Does NOT delete files on disk
   * and does NOT await in-flight writes — for on-disk teardown
   * (file deletion + in-flight drain ordering), use `killAllAgents`
   * instead. Calling `endSession` followed by an out-of-band
   * `delete_memory_file` could race with an in-flight write
   * (claude3 round-10 D3).
   */
  endSession: (forSession: string) => void;

  // Agent lifecycle
  addAgent: (agent: SpawnedAgentInit) => void;
  /**
   * Rename an agent's nickname. Returns `RenameResult`; the store owns the
   * human-readable failure messages so all rename surfaces (inline UI, /rename
   * slash command) share one wording. The handle is IMMUTABLE — only `nickname`,
   * `nicknameSlug`, and `nameHistory` mutate. On success, sets a one-shot flag
   * (`renamePendingByAgent`) that forces the next send (per-agent or broadcast)
   * to use the FULL header so the agent re-learns its identity.
   *
   * Validation rules (in order):
   *   - trim → length must be 1..32 chars
   *   - lowercase must not equal "all" or "all agents" (reserved for broadcast)
   *   - `slugify(nickname)` must be non-empty (rejects pure-emoji / pure-punct)
   *   - must not equal another LIVE agent's `nickname`/`handle`/`nicknameSlug`
   *     (case-insensitive) within the same `collabSessionId`. Exited agents
   *     do not reserve names — see v5 §4 "Live agents own the namespace".
   *   - exited agents themselves CAN be renamed (audit clarity post-mortem).
   *
   * No-op short-circuit: if `target.nickname === trimmed`, returns `{ ok: true }`
   * WITHOUT adding to `renamePendingByAgent`, since the next send doesn't need
   * a redundant full-header re-emit.
   */
  renameAgent: (sessionId: string, rawNickname: string) => RenameResult;
  removeAgent: (sessionId: string) => void;
  setAgentStatus: (
    sessionId: string,
    status: SpawnedAgent["status"],
  ) => void;
  /** Flush queued messages for an agent that has become ready. */
  flushPendingMessages: (sessionId: string) => Promise<void>;
  killAllAgents: (forSession?: string) => Promise<void>;
  /** Return agents belonging to a specific collaborator session. */
  getSessionAgents: (forSession: string) => SpawnedAgent[];

  // Messaging
  sendToAgent: (sessionId: string, content: string) => Promise<void>;
  broadcastToAll: (content: string, forSession?: string) => Promise<void>;
  /**
   * Write a footer-status message scoped to a collab session.
   * - `kind: "transient"` (default) auto-clears after STATUS_TTL_MS via the
   *   equality-guarded timer. Right for acknowledgements like "Sent to …".
   * - `kind: "persistent"` keeps the message until it's overwritten or
   *   cleared with `null`. Right for errors that the user might miss if
   *   the footer auto-cleared in 4 s.
   * - `msg: null` clears the slot regardless.
   */
  setStatus: (
    msg: string | null,
    forSession?: string,
    kind?: "transient" | "persistent",
  ) => void;
  getStatus: (forSession: string) => string | null;
  appendLog: (
    role: LogEntry["role"],
    content: string,
    forSession: string,
    agentName?: string,
  ) => void;

  // Input prefill (scoped per collaborator session)
  setPendingInput: (collabSessionId: string, input: string | null) => void;

  // Task management
  addTask: (opts: {
    title: string;
    objective: string;
    context?: string;
    deliverables?: string[];
    assignee?: string | null;
    dependencies?: string[];
  }, forSession: string) => CollabTask;
  updateTask: (
    taskId: string,
    updates: Partial<Pick<CollabTask, "status" | "assignee" | "reasoning" | "conclusion" | "output" | "completedBy">>,
    forSession: string,
  ) => void;
  getTasks: (forSession: string) => CollabTask[];
  persistTasks: (forSession: string) => Promise<void>;

  // Input history
  pushHistory: (input: string, forSession: string) => void;
  navigateHistory: (direction: "up" | "down", forSession: string, currentInput?: string) => string | null;
}

/**
 * Orphan `.done.json` cleanup grace period.
 *
 * On app cold boot, `tasksBySession` is empty until each `CollaboratorPane`
 * mounts and `startSession` populates it. If a scan fires before all
 * sessions hydrate, the cross-session check sees "no task in any loaded
 * session" for files that legitimately belong to those still-loading
 * sessions. The 24-hour grace makes recent files untouchable by orphan
 * cleanup — completions younger than 24h are always preserved, which is
 * far longer than any plausible cold-boot hydration latency.
 */
const ORPHAN_GRACE_MS = 24 * 60 * 60 * 1000;

/**
 * Scan shared memory for task completion signal files (*.done.json).
 * Agents write these files to signal task completion with structured data.
 *
 * Expected format:
 * ```json
 * {
 *   "task_id": "task-1-...",
 *   "status": "completed",
 *   "reasoning": "...",
 *   "conclusion": "...",
 *   "output": "..."
 * }
 * ```
 *
 * Files whose `task_id` doesn't match any task in any loaded session are
 * treated as orphans and deleted after `ORPHAN_GRACE_MS`. The matching
 * predicate is prefix-tolerant — agents sometimes write a truncated
 * `task_id` like `"task-1"` when the stored id is `"task-1-1234"` — so
 * the orphan check uses the SAME predicate as the in-loop `find` to
 * avoid silently classifying prefix-matching files as orphans.
 */
export async function scanForTaskCompletions(forSession: string): Promise<void> {
  try {
    const files = await invoke<string[]>("list_memory_files");
    const doneFiles = files.filter((f) => f.endsWith(".done.json"));
    if (doneFiles.length === 0) return;

    const store = useCollaboratorStore.getState();
    // NOTE: the previous `if (store.getTasks(forSession).length === 0) return;`
    // early-return blocked empty-session panes from running orphan cleanup.
    // Removed so the loop below can walk `doneFiles` even when this session
    // has no tasks — orphans by definition aren't in any session's list.

    for (const relPath of doneFiles) {
      try {
        const raw = await invoke<string | null>("read_memory_file", { relativePath: relPath });
        if (!raw) continue;
        const data = JSON.parse(raw) as {
          task_id?: string;
          status?: string;
          author?: string;
          agent?: string;
          reasoning?: string;
          conclusion?: string;
          output?: string;
        };
        if (!data.task_id) continue;

        // Prefix-tolerant matcher — agents sometimes drop the
        // `-${Date.now()}` suffix from `task_id` in their `.done.json`
        // payloads (e.g. `"task-1"` vs stored `"task-1-1234"`). The
        // orphan check below MUST use this same predicate so prefix
        // matches aren't classified as orphan.
        const matches = (t: CollabTask) =>
          t.id === data.task_id || t.id.startsWith(data.task_id!);

        // Re-read the current task list inside the loop (codex2's recurring
        // race finding). Using a snapshot taken before the loop lets two
        // concurrent scans both see a non-terminal task and double-fire
        // updateTask + delete_memory_file. By reading fresh state per
        // iteration, the second scan sees the already-terminal task and
        // bails instead of producing duplicate "Task updated:" log lines.
        const tasksNow = store.getTasks(forSession);
        const task = tasksNow.find(matches);

        if (!task) {
          // Cross-session orphan check — per-iteration re-read of
          // `tasksBySession` mirrors the in-loop pattern above so a
          // mid-scan `addTask` (e.g. from `sendToAgent` auto-creating a
          // task) is seen by later iterations.
          const allBySession = useCollaboratorStore.getState().tasksBySession;
          const foundInAnySession = Object.values(allBySession).some((ts) =>
            ts.some(matches),
          );
          if (!foundInAnySession) {
            let mtimeMs: number | null;
            try {
              mtimeMs = await invoke<number>("get_memory_file_mtime", { relativePath: relPath });
            } catch {
              // File gone or stat failed (e.g. mtime-unsupported FS).
              // Skip — preserves pre-cleanup behavior on such filesystems.
              mtimeMs = null;
            }
            // `Math.max(0, …)` clamps backward clock skew (NTP correction,
            // VM resume, manual clock change) so a recent file isn't
            // false-deleted. Forward jumps >24h would still false-delete,
            // but that's a rare scenario and the 24h grace bounds the risk.
            if (mtimeMs !== null && Math.max(0, Date.now() - mtimeMs) > ORPHAN_GRACE_MS) {
              await invoke("delete_memory_file", { relativePath: relPath }).catch(() => {});
            }
          }
          continue;
        }

        if (task.status === "completed" || task.status === "blocked") {
          // The race winner already terminalized this task. Best-effort
          // delete so the file doesn't accumulate; ignore if it's gone.
          await invoke("delete_memory_file", { relativePath: relPath }).catch(() => {});
          continue;
        }

        const status = data.status === "blocked" ? "blocked" : "completed";
        store.updateTask(task.id, {
          status: status as CollabTask["status"],
          reasoning: data.reasoning ?? null,
          conclusion: data.conclusion ?? null,
          output: data.output ?? null,
          completedBy: data.author ?? data.agent ?? null,
        }, forSession);

        // Delete the signal file after processing
        await invoke("delete_memory_file", { relativePath: relPath });
      } catch {
        // Skip malformed files
      }
    }
  } catch {
    // Non-critical
  }
}

/** Build context header prepended to every message sent to agents. */
async function prependContextHeader(
  text: string,
  collabSessionId: string | null,
  tasks: CollabTask[],
  agentIdentity?: string | null,
  agentNickname?: string | null,
): Promise<string> {
  const dir = await getMemoryDir();
  const parts: string[] = [];

  parts.push(`[Collaborator shared memory: ${dir}]`);

  if (collabSessionId) {
    parts.push(
      `[Conversation log: ${dir}/conversation-${collabSessionId}.md]`,
    );
    parts.push(`[Task definitions: ${dir}/${taskFileRelativePath(collabSessionId)}]`);
  } else {
    parts.push(`[Task definitions: ${dir}/tasks.md]`);
  }

  try {
    const content = await invoke<string | null>("read_memory_file", {
      relativePath: "context.md",
    });
    if (content) {
      parts.push(`[Shared context: ${dir}/context.md]`);
    }
  } catch {
    // No context file
  }

  parts.push(
    "[To share notes with other agents, write files to the shared memory directory above.]",
  );

  // Inject agent identity so each agent knows who it is. We surface BOTH
  // the canonical immutable handle (`@claudeN`/`@codexN`) AND the current
  // human-readable nickname when known, then explicitly tell the agent to
  // use the @-handle in protocol artifacts (.done.json author, mentions,
  // log lines). The handle remains the single string referenced by
  // handle-keyed lookups (findFreshestActiveTaskForMention,
  // recentOutcomesBySession), so writing the nickname in the prompt only
  // is presentational — it never lands on disk under a non-canonical key.
  if (agentIdentity) {
    const nick = agentNickname?.trim();
    const idLabel = nick ? `@${agentIdentity} (${nick})` : `@${agentIdentity}`;
    parts.push(`[Your identity: You are ${idLabel}. Use the @${agentIdentity} handle when authoring files or referencing yourself in logs.]`);
  }

  // Inject task protocol and active task summary
  parts.push(TASK_PROTOCOL);
  const taskSummary = formatTaskSummaryForAgent(tasks, agentIdentity ?? null);
  if (taskSummary) parts.push(taskSummary);

  parts.push(text);
  return parts.join("\n");
}

/**
 * Slim context header used for every send AFTER the first. Drops the static
 * `TASK_PROTOCOL` block (the agent learned it from message #1) but still
 * probes for a current `[Shared context]` so a `/context` set after the
 * first send remains visible. Keeps:
 *   - shared memory dir (paths agents may need to write artifacts)
 *   - tasks file path + active-task summary (so the agent sees newly
 *     assigned tasks WITHOUT a separate Read tool call per turn)
 *   - conversation log path (for context recovery)
 *   - shared-context breadcrumb (only when context.md exists)
 *   - agent identity
 *   - 1-line protocol-reminder breadcrumb (in case the agent's own CLI
 *     context summarized away message #1, the breadcrumb gives just enough
 *     for the agent to write a valid done.json from memory)
 *   - read-discipline hint, placed after the active-task summary so the
 *     "task list above" wording is literally accurate
 *
 * Net footprint: ~5-15 lines vs. ~40-80 for `prependContextHeader`. This is
 * the S1 fix from the bug report — without it, the user sees the full
 * protocol echoed in the agent's TUI input area on every turn.
 */
async function buildSlimHeader(
  text: string,
  collabSessionId: string | null,
  tasks: CollabTask[],
  agentIdentity?: string | null,
  agentNickname?: string | null,
): Promise<string> {
  const dir = await getMemoryDir();
  const parts: string[] = [`[Collaborator shared memory: ${dir}]`];
  if (collabSessionId) {
    parts.push(`[Tasks file: ${dir}/${taskFileRelativePath(collabSessionId)}]`);
    parts.push(`[Conversation log: ${dir}/conversation-${collabSessionId}.md]`);
  }
  // Re-surface the [Shared context] breadcrumb when context.md exists.
  // The full header probes for this in `prependContextHeader`; the slim
  // path used to skip it, so a `/context` set AFTER message #1 was
  // invisible to all subsequent slim sends. (codex2 task-4, codex3 task-6.)
  try {
    const content = await invoke<string | null>("read_memory_file", {
      relativePath: "context.md",
    });
    if (content) {
      parts.push(`[Shared context: ${dir}/context.md]`);
    }
  } catch {
    // No context file
  }
  if (agentIdentity) {
    // Slim variant of the full header's identity line — same handle-first,
    // nickname-in-parens convention, no usage hint (the agent learned the
    // "use @handle in protocol writes" rule from message #1's full header).
    const nick = agentNickname?.trim();
    parts.push(nick ? `[You are @${agentIdentity} (${nick})]` : `[You are @${agentIdentity}]`);
  }
  parts.push(
    `[Protocol reminder: signal completion via ${dir}/{TASK_ID}.done.json — ` +
    `full protocol was sent in this session's first message]`,
  );
  // Active-task summary first, then the read-discipline hint that refers
  // to it as "above". Earlier ordering pushed the hint before the summary,
  // making the wording literally wrong (codex3 task-6). The hint is also
  // skipped when the summary is empty (no active tasks) so it doesn't
  // refer to a non-existent list (4-way concurrent finding from
  // claude2/claude3/codex3/claude1 in task-15..20 verification round).
  // The slim path also caps the "others" bucket — full path remains uncapped
  // so the message-1 send still has the complete picture (codex2 task-10).
  const summary = formatTaskSummaryForAgent(tasks, agentIdentity ?? null, {
    othersCap: SLIM_OTHERS_CAP,
  });
  if (summary) {
    parts.push(summary);
    parts.push(
      `[Read-discipline: trust the task list above — prefer targeted Grep ` +
      `over full Read of shared tasks/conversation files]`,
    );
  }
  parts.push(text);
  return parts.join("\n");
}

export const useCollaboratorStore = create<CollaboratorState>((set, get) => ({
  agents: [],
  statusMessages: {},
  inputHistoryBySession: {},
  historyIndexBySession: {},
  draftInputBySession: {},
  logEntriesBySession: {},
  tasksBySession: {},
  pendingInputs: {},
  pendingMessagesByAgent: {},
  recentOutcomesBySession: {},
  contextSentByAgent: {},

  // -- Session lifecycle --------------------------------------------------

  startSession: (id) => {
    // Clear any prior abort marker — if the same session ID is reused
    // (rare with fresh generateSessionId() but possible in tests), we
    // want fresh persistTasks calls to fire normally instead of being
    // short-circuited by a leftover abort flag.
    abortedSessions.delete(id);
    set((s) => ({
      logEntriesBySession: s.logEntriesBySession[id]
        ? s.logEntriesBySession
        : { ...s.logEntriesBySession, [id]: [] },
      tasksBySession: s.tasksBySession[id]
        ? s.tasksBySession
        : { ...s.tasksBySession, [id]: [] },
      statusMessages: s.statusMessages[id]
        ? s.statusMessages
        : s.statusMessages,
      agents: s.agents.filter((a) => a.collabSessionId !== id),
    }));
    ensureSessionMemoryFiles(id);
  },

  endSession: (forSession) => {
    resetOrdinalCounters(forSession);
    // Drop any lingering unread counter so closed sessions don't accumulate in unreadByCollabSession.
    useTerminalStore.getState().clearUnread(forSession);
    // Mark the session aborted and drop the per-session task-write chain
    // so any queued persistTasks step short-circuits instead of recreating
    // a deleted file (matches the killAllAgents teardown contract).
    abortedSessions.add(forSession);
    // Drop both per-session chain entries — endSession itself doesn't
    // delete files (that's killAllAgents), but symmetry with the
    // killAllAgents contract avoids surprising future callers
    // (claude3 round-9 D1). Any in-flight writes still resolve
    // benignly into the existing files.
    taskWriteChainsBySession.delete(forSession);
    conversationWriteChainsBySession.delete(forSession);
    set((s) => {
      // Compute sessionIds to drop while we still have the unfiltered agents
      // list — used both to filter contextSentByAgent and to drop
      // firstSendInflight entries (belt & suspenders cleanup).
      const sessionIdsToDrop = new Set(
        s.agents.filter((a) => a.collabSessionId === forSession).map((a) => a.sessionId),
      );
      for (const sid of sessionIdsToDrop) {
        firstSendInflight.delete(sid);
        renamePendingByAgent.delete(sid);
      }
      const contextSentByAgent = Object.fromEntries(
        Object.entries(s.contextSentByAgent).filter(([sid]) => !sessionIdsToDrop.has(sid)),
      );
      const { [forSession]: _status, ...statusMessages } = s.statusMessages;
      const { [forSession]: _logs, ...logEntriesBySession } = s.logEntriesBySession;
      const { [forSession]: _tasks, ...tasksBySession } = s.tasksBySession;
      const { [forSession]: _pending, ...pendingInputs } = s.pendingInputs;
      const { [forSession]: _hist, ...inputHistoryBySession } = s.inputHistoryBySession;
      const { [forSession]: _idx, ...historyIndexBySession } = s.historyIndexBySession;
      const { [forSession]: _draft, ...draftInputBySession } = s.draftInputBySession;
      const { [forSession]: _outcomes, ...recentOutcomesBySession } = s.recentOutcomesBySession;
      return {
        statusMessages,
        logEntriesBySession,
        tasksBySession,
        pendingInputs,
        inputHistoryBySession,
        historyIndexBySession,
        draftInputBySession,
        recentOutcomesBySession,
        contextSentByAgent,
        agents: s.agents.filter((a) => a.collabSessionId !== forSession),
      };
    });
  },

  // -- Agent lifecycle ----------------------------------------------------

  addAgent: (raw) => {
    const ordinal = nextOrdinal(raw.collabSessionId, raw.tool);
    const short = toolShortName(raw.tool);
    const initialNickname = `${toolLabel(raw.tool)} #${ordinal}`;
    const setAt = new Date().toISOString();
    const agent: SpawnedAgent = {
      ...raw,
      ordinal,
      handle: `${short}${ordinal}`,
      nickname: initialNickname,
      nicknameSlug: slugify(initialNickname),
      nameHistory: [{ nickname: initialNickname, setAt, setBy: "system" }],
    };
    set((s) => ({ agents: [...s.agents, agent] }));
  },

  renameAgent: (sessionId, rawNickname) => {
    const trimmed = rawNickname.trim();
    if (trimmed.length === 0 || trimmed.length > 32) {
      return {
        ok: false,
        reason: "invalid",
        message: "Nickname must be 1–32 characters.",
      };
    }
    const lower = trimmed.toLowerCase();
    if (lower === "all" || lower === "all agents") {
      return {
        ok: false,
        reason: "reserved",
        message: '"all" and "all agents" are reserved for broadcast.',
      };
    }
    const newSlug = slugify(trimmed);
    if (newSlug.length === 0) {
      return {
        ok: false,
        reason: "invalid",
        message: "Nickname must contain at least one letter or number.",
      };
    }
    const state = get();
    const target = state.agents.find((a) => a.sessionId === sessionId);
    if (!target) {
      return { ok: false, reason: "not-found", message: "Agent not found." };
    }
    // No-op short-circuit. The check is BEFORE the dupe scan so that a rename
    // back to the current value never even risks tripping a "duplicate" against
    // self (the dupe scan filters self by sessionId, but this is clearer intent).
    // Critically: returning here SKIPS the renamePendingByAgent.add() below, so
    // a no-op rename does not trigger a wasteful full-header re-emit.
    if (target.nickname === trimmed) return { ok: true };

    // Liveness filter on collision check: live agents own the namespace.
    // Exited agents' nicknames are historical labels, not active reservations.
    // (codex1 C2-2 from synthesis v5 §4.)
    const dupe = state.agents.some(
      (a) =>
        a.sessionId !== sessionId &&
        a.collabSessionId === target.collabSessionId &&
        a.status !== "exited" &&
        (a.nickname.toLowerCase() === lower ||
          a.handle.toLowerCase() === lower ||
          a.nicknameSlug === newSlug),
    );
    if (dupe) {
      return {
        ok: false,
        reason: "duplicate",
        message: "Name already in use by another agent.",
      };
    }

    const setAt = new Date().toISOString();
    const oldNickname = target.nickname;
    const record: AgentNameRecord = {
      nickname: trimmed,
      setAt,
      setBy: "user",
    };
    set((s) => {
      // Clear contextSentByAgent[sessionId] via destructure-omit so the next
      // send for this agent treats it as "never seen full header." Matches the
      // removeAgent destructure pattern. (claude2 P1 + codex1 C2-1.)
      const { [sessionId]: _omit, ...contextSentByAgent } = s.contextSentByAgent;
      return {
        agents: s.agents.map((a) =>
          a.sessionId === sessionId
            ? {
                ...a,
                nickname: trimmed,
                nicknameSlug: newSlug,
                nameHistory: [...a.nameHistory, record],
              }
            : a,
        ),
        contextSentByAgent,
      };
    });
    // Belt-and-suspenders against the in-flight first-send race: if a send
    // is mid-flight when the rename fires, the post-resolve `[sessionId]: true`
    // write at the success branch would otherwise stomp the rename's clear.
    // The set survives that write because it lives outside store state.
    // (claude2 P2 from synthesis v5 §3.)
    renamePendingByAgent.add(sessionId);
    get().appendLog(
      "system",
      `Agent @${target.handle} renamed: "${oldNickname}" → "${trimmed}"`,
      target.collabSessionId,
    );
    return { ok: true };
  },

  removeAgent: (sessionId) => {
    // Belt & suspenders: clear any in-flight first-send promise for this
    // sessionId (the `finally` in sendToAgent normally handles this, but if
    // the component is yanked mid-flight we don't want a dangling promise).
    firstSendInflight.delete(sessionId);
    // Same belt-and-suspenders for the rename-pending flag — if the agent
    // is removed mid-rename window, drain so the slot doesn't outlive the
    // sessionId (matters if a future agent recycles this id, though current
    // generateSessionId() avoids reuse).
    renamePendingByAgent.delete(sessionId);
    set((s) => {
      const { [sessionId]: _pm, ...pendingMessagesByAgent } = s.pendingMessagesByAgent;
      const { [sessionId]: _ctx, ...contextSentByAgent } = s.contextSentByAgent;
      return {
        agents: s.agents.filter((a) => a.sessionId !== sessionId),
        pendingMessagesByAgent,
        contextSentByAgent,
      };
    });
  },

  setAgentStatus: (sessionId, status) => {
    set((s) => ({
      agents: s.agents.map((a) =>
        a.sessionId === sessionId ? { ...a, status } : a,
      ),
    }));
  },

  flushPendingMessages: async (sessionId) => {
    const queue = get().pendingMessagesByAgent[sessionId];
    if (!queue || queue.length === 0) return;

    // Clear the queue first to avoid double-flushing
    set((s) => {
      const { [sessionId]: _, ...rest } = s.pendingMessagesByAgent;
      return { pendingMessagesByAgent: rest };
    });

    // Send each queued message
    for (const content of queue) {
      await get().sendToAgent(sessionId, content);
    }
  },

  killAllAgents: async (forSession) => {
    const { agents } = get();
    const sid = forSession;
    const toKill = sid ? agents.filter((a) => a.collabSessionId === sid) : agents;
    for (const agent of toKill) {
      try {
        await invoke("kill_pty", { sessionId: agent.sessionId });
      } catch {
        // Already dead
      }
    }
    // TODO(future): taskCounter is module-global; resetting it here when
    // scoped to one session can cause task-id collisions in another live
    // session. Pre-existing — tracked separately. (@claude2 task-16 Note 3)
    taskCounter = 0;
    // Belt & suspenders: clear firstSendInflight for the killed sessions
    // (the per-call `finally` normally handles this, but if a kill races
    // an in-flight inject we don't want a dangling promise).
    const killedIds = new Set(toKill.map((a) => a.sessionId));
    for (const id of killedIds) {
      firstSendInflight.delete(id);
      renamePendingByAgent.delete(id);
    }
    if (sid) {
      resetOrdinalCounters(sid);
      set((s) => ({
        agents: s.agents.filter((a) => a.collabSessionId !== sid),
        contextSentByAgent: Object.fromEntries(
          Object.entries(s.contextSentByAgent).filter(([id]) => !killedIds.has(id)),
        ),
      }));
    } else {
      toolOrdinalCounters.clear();
      set({ agents: [], contextSentByAgent: {} });
    }
    if (sid) {
      // Mark the session aborted BEFORE deleting the file so any chain-
      // queued persistTasks step short-circuits instead of recreating
      // tasks-{sid}.md after the delete (codex1 + claude3 round-7).
      abortedSessions.add(sid);
      const pendingTaskWrite = taskWriteChainsBySession.get(sid);
      const pendingConversationWrite = conversationWriteChainsBySession.get(sid);
      taskWriteChainsBySession.delete(sid);
      conversationWriteChainsBySession.delete(sid);
      // Drain any in-flight write so the IPC settles BEFORE the delete
      // fires. The abort flag covers QUEUED writes (which short-circuit),
      // but a write that already passed the abort check and is awaiting
      // the Tauri response can't be cancelled by the flag — and Tauri
      // doesn't guarantee IPC ordering between independent commands, so
      // without this await the write could land *after* the delete and
      // recreate the file (claude3 round-8 D1). Drain both chains in
      // parallel via allSettled so an unrelated chain failure doesn't
      // block the other; the per-session split (round-9) means we no
      // longer block on OTHER sessions' log writes.
      await Promise.allSettled([pendingTaskWrite, pendingConversationWrite]);
      try {
        await invoke("delete_memory_file", {
          relativePath: `conversation-${sid}.md`,
        });
      } catch {
        // Non-critical — file may not exist
      }
      try {
        await invoke("delete_memory_file", {
          relativePath: taskFileRelativePath(sid),
        });
      } catch {
        // Non-critical — file may not exist
      }
    }
  },

  getSessionAgents: (forSession) => {
    return get().agents.filter((a) => a.collabSessionId === forSession);
  },

  // -- Messaging ----------------------------------------------------------

  sendToAgent: async (sessionId, content) => {
    try {
      const { agents, tasksBySession } = get();
      const agent = agents.find((a) => a.sessionId === sessionId);
      const tool = agent?.tool ?? null;
      const agentCollabId = agent?.collabSessionId ?? null;
      const mention = agent ? agent.handle : "?";
      // The current display nickname, if any. Threaded into header builders
      // so the `[Your identity: …]` / `[You are @<handle> (<nickname>)]`
      // line carries the agent's mutable label alongside the canonical
      // handle. Mirrors `broadcastToAll`'s identity threading.
      const nickname = agent?.nickname ?? null;

      // Queue message if agent is still starting up
      if (agent?.status === "spawning") {
        set((s) => ({
          pendingMessagesByAgent: {
            ...s.pendingMessagesByAgent,
            [sessionId]: [...(s.pendingMessagesByAgent[sessionId] ?? []), content],
          },
        }));
        if (agentCollabId) {
          get().setStatus("Agent starting up, message queued...", agentCollabId);
        }
        return;
      }

      // Auto-create a task if none exist for this session, OR refresh the
      // assignedAt of the existing active task. The refresh closes the
      // claude2/claude3/codex3 cross-validated freshness gap: from the
      // user's POV, sending a message to an agent IS a fresh act of
      // assignment. Without the bump, a backlog task that pre-dates a
      // recent completion would stay gated by the highlight even though
      // the user just engaged it.
      if (agentCollabId) {
        const existing = tasksBySession[agentCollabId] ?? [];
        // Pick the freshest active task (largest assignedAt) so the bump
        // matches the task the indicator will surface as "in progress".
        // Picking the first array match (oldest) here would mis-attribute
        // the send to a backlog item, contradicting the indicator label.
        const found = findFreshestActiveTaskForMention(existing, `@${mention}`);
        if (!found) {
          const title = content.length > 60 ? content.substring(0, 57) + "..." : content;
          get().addTask({
            title,
            objective: content,
            assignee: `@${mention}`,
          }, agentCollabId);
        } else {
          bumpAssignedAt(found.task.id, agentCollabId, set);
        }
      }
      const sessionTasks = agentCollabId ? (get().tasksBySession[agentCollabId] ?? []) : [];

      // ── Order-safe + race-safe first-send gating ──────────────────
      // S1 fix: only the FIRST send to an agent carries the full
      // ~40-line TASK_PROTOCOL. Subsequent sends carry a slim ~5-15-line
      // header (paths + identity + active-task summary + breadcrumb).
      //
      // The while-loop is load-bearing: it ensures we only proceed when
      // no first-send is in-flight for this agent. A simple "if inflight
      // await" wouldn't catch the case where a previous first-send fails
      // and the next sender becomes the new first sender between our
      // await and our flag read — re-checking the map closes that gap.
      while (firstSendInflight.has(sessionId)) {
        await firstSendInflight.get(sessionId)!.catch(() => {});
      }
      // OR-in `renamePendingByAgent.has` so a rename that landed during an
      // in-flight first-send still forces the next send into the full header.
      // The bare `flagState === undefined` check would miss it because the
      // post-resolve `[sessionId]: true` write at the success branch (below)
      // overwrites the rename's `delete` of contextSentByAgent. The set itself
      // is module-level so the zustand `set((s) => ...)` write to
      // contextSentByAgent doesn't reach it; the set IS drained explicitly on
      // success — see the PAIRED INVARIANT block below. The OR-in here protects
      // the rename intent across the await window before the success branch
      // fires (i.e., during the firstSendInflight wait loop above, where a
      // rename can arrive and add to the set).
      // Read-only here; the consume happens on inject SUCCESS so a failed
      // send preserves the rename intent for the next attempt.
      const flagState = get().contextSentByAgent[sessionId];
      const renamePending = renamePendingByAgent.has(sessionId);
      const useFullHeader = renamePending || flagState === undefined;

      if (useFullHeader) {
        // Become the first sender. Mark inflight in BOTH state (for the
        // next sender's sync flagState read) AND firstSendInflight (for
        // the next sender's await before deciding header shape).
        set((s) => ({
          contextSentByAgent: { ...s.contextSentByAgent, [sessionId]: "inflight" },
        }));
        const work = (async () => {
          try {
            const text = await prependContextHeader(content, agentCollabId, sessionTasks, mention, nickname);
            muteCapture(sessionId, 1500);
            await invoke("inject_into_pty", { sessionId, text, tool });
            // PAIRED INVARIANT: contextSentByAgent[sessionId] := true AND
            // renamePendingByAgent.delete(sessionId) must happen together.
            // Both writes invalidate the "rename-since-last-emit" claim. If you
            // move one, move the other — splitting them silently regresses the
            // slim-header design (the leak forces every subsequent send into
            // the full header for no reason).
            set((s) => ({
              contextSentByAgent: { ...s.contextSentByAgent, [sessionId]: true },
            }));
            renamePendingByAgent.delete(sessionId);
          } catch (err) {
            // Roll back so the next sender retries with a full header.
            set((s) => {
              const { [sessionId]: _, ...rest } = s.contextSentByAgent;
              return { contextSentByAgent: rest };
            });
            throw err;
          }
        })();
        firstSendInflight.set(sessionId, work);
        try {
          await work;
        } finally {
          firstSendInflight.delete(sessionId);
        }
      } else {
        // flagState === true (we waited above; "inflight" cannot occur here
        // because the `while` loop drained it).
        const text = await buildSlimHeader(content, agentCollabId, sessionTasks, mention, nickname);
        muteCapture(sessionId, 1500);
        await invoke("inject_into_pty", { sessionId, text, tool });
      }
      // ── End first-send gating ─────────────────────────────────────

      const label = agent ? toolLabel(agent.tool) : sessionId;
      if (agentCollabId) {
        get().setStatus(`Sent to ${label}`, agentCollabId);
      }
    } catch (err) {
      const { agents } = get();
      const agent = agents.find((a) => a.sessionId === sessionId);
      if (agent?.collabSessionId) {
        // Persistent: errors often describe conditions the user missed at
        // the moment they fired (e.g. backgrounded tab). Stay until the
        // next setStatus overwrites the slot.
        get().setStatus(`Error: ${err}`, agent.collabSessionId, "persistent");
      }
    }
  },

  broadcastToAll: async (content, forSession) => {
    const { agents, tasksBySession } = get();
    const sid = forSession ?? null;
    const targetAgents = sid ? agents.filter((a) => a.collabSessionId === sid) : agents;
    if (targetAgents.length === 0) {
      if (sid) get().setStatus("No agents running. Launch a tool first.", sid);
      return;
    }
    // Auto-create tasks for each agent if none exist; otherwise refresh
    // the assignedAt of the existing active task so the indicator promotes
    // back to in_progress (see sendToAgent comment for rationale).
    if (sid) {
      for (const agent of targetAgents) {
        const existing = tasksBySession[sid] ?? [];
        const mention = `@${agent.handle}`;
        // Same freshest-active rule as sendToAgent (see comment there).
        const found = findFreshestActiveTaskForMention(existing, mention);
        if (!found) {
          const title = content.length > 60 ? content.substring(0, 57) + "..." : content;
          get().addTask({
            title,
            objective: content,
            assignee: mention,
          }, sid);
        } else {
          bumpAssignedAt(found.task.id, sid, set);
        }
      }
    }
    const sessionTasks = sid ? (get().tasksBySession[sid] ?? []) : [];
    let sent = 0;
    for (const agent of targetAgents) {
      // Queue for agents that are still starting up
      if (agent.status === "spawning") {
        set((s) => ({
          pendingMessagesByAgent: {
            ...s.pendingMessagesByAgent,
            [agent.sessionId]: [...(s.pendingMessagesByAgent[agent.sessionId] ?? []), content],
          },
        }));
        sent++;
        continue;
      }
      try {
        // Each agent gets its own identity injected into the context header.
        const identity = agent.handle;
        // …along with its current nickname so the slim/full header renders
        // `@claude2 (reviewer-2)` instead of just `@claude2`. See
        // `sendToAgent` for the matching threading.
        const identityNickname = agent.nickname ?? null;
        const aSid = agent.sessionId;

        // ── Per-agent first-send gating (mirrors sendToAgent) ───────
        // Each agent's gating is independent — broadcasting to N agents
        // can have N first-sends running in parallel, but for any one
        // agent the ordering and dedup guarantees still hold.
        while (firstSendInflight.has(aSid)) {
          await firstSendInflight.get(aSid)!.catch(() => {});
        }
        // Symmetric with sendToAgent: OR-in renamePendingByAgent so a rename
        // followed by a broadcast still re-emits the full header. Without this,
        // rename + broadcast would silently lose the rename's full-header
        // intent if the per-agent flagState had already been written to true.
        const flagState = get().contextSentByAgent[aSid];
        const renamePending = renamePendingByAgent.has(aSid);
        const useFullHeader = renamePending || flagState === undefined;

        if (useFullHeader) {
          set((s) => ({
            contextSentByAgent: { ...s.contextSentByAgent, [aSid]: "inflight" },
          }));
          const work = (async () => {
            try {
              const text = await prependContextHeader(content, sid, sessionTasks, identity, identityNickname);
              muteCapture(aSid, 1500);
              await invoke("inject_into_pty", { sessionId: aSid, text, tool: agent.tool });
              // PAIRED INVARIANT: see sendToAgent's matching comment. Both
              // writes invalidate the "rename-since-last-emit" claim and must
              // move together if either is moved.
              set((s) => ({
                contextSentByAgent: { ...s.contextSentByAgent, [aSid]: true },
              }));
              renamePendingByAgent.delete(aSid);
            } catch (err) {
              set((s) => {
                const { [aSid]: _, ...rest } = s.contextSentByAgent;
                return { contextSentByAgent: rest };
              });
              throw err;
            }
          })();
          firstSendInflight.set(aSid, work);
          try {
            await work;
          } finally {
            firstSendInflight.delete(aSid);
          }
        } else {
          const text = await buildSlimHeader(content, sid, sessionTasks, identity, identityNickname);
          muteCapture(aSid, 1500);
          await invoke("inject_into_pty", { sessionId: aSid, text, tool: agent.tool });
        }
        sent++;
      } catch {
        // Skip failed
      }
    }
    if (sid) {
      get().setStatus(`Broadcast sent to ${sent} agent${sent !== 1 ? "s" : ""}`, sid);
    }
  },

  setStatus: (msg, forSession, kind = "transient") => {
    if (!forSession) return;
    set((s) => {
      if (msg === null) {
        const { [forSession]: _, ...rest } = s.statusMessages;
        return { statusMessages: rest };
      }
      return { statusMessages: { ...s.statusMessages, [forSession]: msg } };
    });
    // Transient messages auto-clear after STATUS_TTL_MS so acknowledgements
    // ("Sent to …", "Broadcast sent …") don't go stale. Persistent messages
    // (errors) stay until overwritten — they often surface conditions the
    // user missed at the moment they were generated, and 4 s is too short
    // to read & react. Equality guard prevents stomping a fresher message.
    if (msg !== null && kind === "transient") {
      const captured = msg;
      setTimeout(() => {
        if (get().statusMessages[forSession] === captured) {
          get().setStatus(null, forSession);
        }
      }, STATUS_TTL_MS);
    }
  },

  getStatus: (forSession) => get().statusMessages[forSession] ?? null,

  appendLog: (role, content, forSession, agentName) => {
    const entry: LogEntry = { time: nowTime(), role, content, agent: agentName };
    set((s) => ({
      logEntriesBySession: {
        ...s.logEntriesBySession,
        [forSession]: [...(s.logEntriesBySession[forSession] ?? []), entry],
      },
    }));

    // Persist by reading existing file first, then appending.
    // This preserves any content agents wrote directly to the file
    // (e.g. task reports appended via their own tools).
    // Writes are serialized PER SESSION via conversationWriteChainsBySession
    // (round-9 finding: a global chain blocked cross-session teardown).
    const relPath = `conversation-${forSession}.md`;
    const newBlock = formatLogEntry(entry);
    const prev = conversationWriteChainsBySession.get(forSession) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(() => {
      // Abort guard: same shape as the task-write chain (round-7 fix).
      // If the session was torn down while this step sat in the chain,
      // skip the read+write so we don't recreate `conversation-{sid}.md`
      // after killAllAgents/endSession deleted it (claude1 round-8 D3).
      if (abortedSessions.has(forSession)) return;
      return invoke<string | null>("read_memory_file", { relativePath: relPath })
        .then((existing) => {
          // Re-check post-read: the abort could have landed during the
          // I/O-bound read. Without this, a slow read followed by a
          // teardown would still write back the (just-read) content.
          if (abortedSessions.has(forSession)) return;
          const base = existing ?? "# Collaborator Conversation Log\n";
          return invoke("write_memory_file", {
            relativePath: relPath,
            content: base + "\n" + newBlock,
          });
        })
        .catch(() => {});
    });
    conversationWriteChainsBySession.set(forSession, next);
  },

  // -- Input prefill -------------------------------------------------------

  setPendingInput: (collabSessionId, input) => {
    set((s) => {
      if (input === null) {
        const { [collabSessionId]: _, ...rest } = s.pendingInputs;
        return { pendingInputs: rest };
      }
      return { pendingInputs: { ...s.pendingInputs, [collabSessionId]: input } };
    });
  },

  // -- Task management ----------------------------------------------------

  addTask: (opts, forSession) => {
    taskCounter++;
    const now = new Date().toISOString();
    const task: CollabTask = {
      id: `task-${taskCounter}-${Date.now()}`,
      title: opts.title,
      objective: opts.objective,
      context: opts.context ?? "",
      deliverables: opts.deliverables ?? [],
      assignee: opts.assignee ?? null,
      dependencies: opts.dependencies ?? [],
      status: "pending",
      reasoning: null,
      conclusion: null,
      output: null,
      completedBy: null,
      createdAt: now,
      updatedAt: now,
      // Initial assignment time = creation time. Re-assignment via
      // updateTask({ assignee }) refreshes this so the in-frame freshness
      // gate sees the re-assignment as fresh work.
      assignedAt: now,
    };
    set((s) => ({
      tasksBySession: {
        ...s.tasksBySession,
        [forSession]: [...(s.tasksBySession[forSession] ?? []), task],
      },
    }));
    // Append assignee with nickname-decorated handle so the conversation
    // log surfaces both the canonical mention and the human-readable name
    // at task-creation time. Lookup uses the live session roster — same
    // index `formatTasksMarkdown` builds — so the two writers stay in sync.
    let assigneeSuffix = "";
    if (task.assignee) {
      const sessionAgents = get().agents.filter((a) => a.collabSessionId === forSession);
      const nick = buildNicknameIndex(sessionAgents).get(task.assignee.trim());
      assigneeSuffix = ` → ${formatAgentRef(task.assignee, nick)}`;
    }
    get().appendLog("system", `Task created: ${task.id} — ${task.title}${assigneeSuffix}`, forSession);
    get().persistTasks(forSession);
    return task;
  },

  updateTask: (taskId, updates, forSession) => {
    const prevTask = (get().tasksBySession[forSession] ?? []).find((t) => t.id === taskId);
    const prevStatus = prevTask?.status;
    // Detect a real assignee change so we can refresh `assignedAt`.
    // Re-assignment is what the in-frame freshness gate keys off; if the
    // caller passes the same `assignee` we already have, do NOT bump
    // (otherwise a no-op update could spuriously preempt a completion
    // highlight). Three guards work together:
    //   1. `Object.prototype.hasOwnProperty` distinguishes "key not provided"
    //      from "key provided as null" inside the Partial<...> updates.
    //   2. `updates.assignee !== undefined` skips explicit-undefined payloads
    //      — `undefined` isn't a valid assignee value (the field is
    //      `string | null`) and bumping for it would be a wasted refresh.
    //   3. The diff against `prevTask.assignee` skips no-op same-assignee
    //      writes that share the partial with other field updates.
    const assigneeProvided = Object.prototype.hasOwnProperty.call(updates, "assignee");
    const reassigned =
      assigneeProvided
      && updates.assignee !== undefined
      && prevTask !== undefined
      && updates.assignee !== prevTask.assignee;
    const nowIso = new Date().toISOString();
    // Strip undefined values from the partial before spreading: the type
    // declares `assignee: string | null` etc., but `Partial<...>` allows
    // `undefined` at runtime. Spreading `{ assignee: undefined }` would
    // overwrite a valid `task.assignee` with `undefined`, violating the
    // declared shape. Filtering keeps the spread idempotent for absent
    // keys vs explicit-undefined keys (both result in no field overwrite).
    // NOTE: explicit `null` IS preserved — that's how callers intentionally
    // unassign (assignee: null) or clear other nullable fields. We strip
    // *only* `undefined`.
    const cleanUpdates = Object.fromEntries(
      Object.entries(updates).filter(([, v]) => v !== undefined),
    ) as typeof updates;

    set((s) => ({
      tasksBySession: {
        ...s.tasksBySession,
        [forSession]: (s.tasksBySession[forSession] ?? []).map((t) =>
          t.id === taskId
            ? {
                ...t,
                ...cleanUpdates,
                updatedAt: nowIso,
                ...(reassigned ? { assignedAt: nowIso } : {}),
              }
            : t,
        ),
      },
    }));
    const task = (get().tasksBySession[forSession] ?? []).find((t) => t.id === taskId);
    if (task) {
      // Append a structured task report when status changes to a terminal state
      const isTerminal = task.status === "completed" || task.status === "blocked";
      const statusChanged = task.status !== prevStatus;
      if (isTerminal && statusChanged) {
        // Decorate the resolved author handle with its current nickname,
        // when the agent is still in the session roster. Falls back to the
        // bare handle (existing behavior) for assignees whose agent has
        // since exited or was never in this session — this preserves the
        // codex3 round-6 invariant that an empty `completedBy` falls
        // through to `assignee` and never produces an empty Agent line.
        const author = resolveTaskAuthor(task);
        const sessionAgents = get().agents.filter((a) => a.collabSessionId === forSession);
        const authorNick = author ? buildNicknameIndex(sessionAgents).get(author.trim()) : null;
        const report = [
          `# ${task.id} — ${task.status}`,
          // Use the shared resolveTaskAuthor helper so this header and
          // the outcome-routing fallback below can't drift (claude3
          // round-7 D6 — both sites previously open-coded the same
          // trim()+|| pattern).
          `**Agent**: ${formatAgentRef(author, authorNick)}`,
          `**Subject**: ${task.title}`,
          task.reasoning ? `**Reasoning**: ${task.reasoning}` : null,
          task.conclusion ? `**Conclusion**: ${task.conclusion}` : null,
          task.output ? `**Output**: ${task.output}` : null,
        ].filter(Boolean).join("\n");
        get().appendLog("system", `Task Report\n${report}`, forSession);

        // (PR-A's 4 s footer status was removed in task-16: it duplicated the
        // new per-agent in-frame indicator on every terminal-state transition.)

        // Per-agent in-frame outcome — replaces the previous global toast.
        // Keyed by handle (e.g. "claude1") within the collab session, so the
        // mini-terminal for the responsible agent can light up + show a state
        // message. Uses the shared resolveTaskAuthor helper (DRY with the
        // Task Report header above).
        const mention = resolveTaskAuthor(task);
        const handle = mention ? mention.replace(/^@/, "") : null;
        if (handle) {
          const outcome: AgentRecentOutcome = {
            kind: task.status === "blocked" ? "blocked" : "completed",
            taskId: task.id,
            taskTitle: task.title,
            at: Date.now(),
          };
          set((s) => ({
            recentOutcomesBySession: {
              ...s.recentOutcomesBySession,
              [forSession]: {
                ...(s.recentOutcomesBySession[forSession] ?? {}),
                [handle]: outcome,
              },
            },
          }));
          setTimeout(() => {
            const cur = get().recentOutcomesBySession[forSession]?.[handle];
            if (cur && cur.taskId === outcome.taskId && cur.at === outcome.at) {
              set((s) => {
                const sessionMap = s.recentOutcomesBySession[forSession];
                if (!sessionMap) return s;
                const { [handle]: _, ...rest } = sessionMap;
                const nextSession =
                  Object.keys(rest).length === 0
                    ? (() => {
                        const { [forSession]: _drop, ...others } = s.recentOutcomesBySession;
                        return others;
                      })()
                    : { ...s.recentOutcomesBySession, [forSession]: rest };
                return { recentOutcomesBySession: nextSession };
              });
            }
          }, RECENT_OUTCOME_TTL_MS);
        }
        // Per-tab unread badge stays — it surfaces completions for sessions
        // the user isn't currently viewing, which is orthogonal to the
        // in-frame light.
        useTerminalStore.getState().incrementUnread(forSession);
      } else {
        get().appendLog("system", `Task updated: ${taskId} → ${task.status}`, forSession);
      }
    }
    get().persistTasks(forSession);
  },

  getTasks: (forSession) => get().tasksBySession[forSession] ?? [],

  persistTasks: async (forSession) => {
    // Snapshot tasks at call time, but write under a per-session chain
    // so a rapid burst of persistTasks invocations resolves in order
    // (codex1 round-6 race finding). Without serialization, two
    // concurrent invoke("write_memory_file", ...) calls could land
    // out-of-order and leave an older snapshot on disk.
    const tasks = get().tasksBySession[forSession] ?? [];
    // Thread the live agent roster so `**Assignee**:` / `**Completed By**:`
    // lines render with the canonical handle AND current nickname, e.g.
    // `@claude2 (reviewer-2)`. Filtered to this collab session — handles are
    // unique within a session and we don't want a same-handle agent from a
    // sibling pane to leak its nickname into the wrong tasks file.
    const sessionAgents = get().agents.filter((a) => a.collabSessionId === forSession);
    const content = formatTasksMarkdown(tasks, sessionAgents);
    const prev = taskWriteChainsBySession.get(forSession) ?? Promise.resolve();
    const next = prev
      .catch(() => {}) // a previous failure must not block the next write
      .then(() => {
        // Teardown guard: if the session was aborted while this write
        // sat in the chain, skip the invoke — otherwise we'd recreate
        // the just-deleted tasks-{sid}.md with stale content
        // (codex1 round-7 / claude3 round-7 teardown race).
        if (abortedSessions.has(forSession)) return;
        return invoke("write_memory_file", {
          relativePath: taskFileRelativePath(forSession),
          content,
        }).catch(() => {
          // Non-critical write failure (disk full, IPC error, etc.).
        });
      });
    taskWriteChainsBySession.set(forSession, next);
    await next;
  },

  // -- Input history ------------------------------------------------------

  pushHistory: (input, forSession) => {
    set((s) => ({
      inputHistoryBySession: {
        ...s.inputHistoryBySession,
        [forSession]: [...(s.inputHistoryBySession[forSession] ?? []), input],
      },
      historyIndexBySession: { ...s.historyIndexBySession, [forSession]: -1 },
      draftInputBySession: { ...s.draftInputBySession, [forSession]: "" },
    }));
  },

  navigateHistory: (direction, forSession, currentInput) => {
    const s = get();
    const inputHistory = s.inputHistoryBySession[forSession] ?? [];
    const historyIndex = s.historyIndexBySession[forSession] ?? -1;
    if (inputHistory.length === 0) return null;

    let newIndex: number;
    if (direction === "up") {
      // Save the current input as draft when first entering history
      if (historyIndex === -1) {
        set((prev) => ({
          draftInputBySession: { ...prev.draftInputBySession, [forSession]: currentInput ?? "" },
        }));
        newIndex = inputHistory.length - 1;
      } else {
        newIndex = Math.max(0, historyIndex - 1);
      }
    } else {
      if (historyIndex === -1) return null;
      newIndex = historyIndex + 1;
      if (newIndex >= inputHistory.length) {
        // Navigated past the end — restore the draft
        const draftInput = get().draftInputBySession[forSession] ?? "";
        set((prev) => ({
          historyIndexBySession: { ...prev.historyIndexBySession, [forSession]: -1 },
          draftInputBySession: { ...prev.draftInputBySession, [forSession]: "" },
        }));
        return draftInput;
      }
    }

    set((prev) => ({
      historyIndexBySession: { ...prev.historyIndexBySession, [forSession]: newIndex },
    }));
    return inputHistory[newIndex] ?? null;
  },
}));
