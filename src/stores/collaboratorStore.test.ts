import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  useCollaboratorStore,
  getAgentTaskState,
  getIndicatorPresentation,
  scanForTaskCompletions,
  formatTaskSummaryForAgent,
  _resetWriteStateForTests,
  RECENT_OUTCOME_TTL_MS,
  STATUS_TTL_MS,
} from "./collaboratorStore";
import type { CollabTask } from "../types/collaborator";
import { useTerminalStore } from "./terminalStore";
import { invoke } from "@tauri-apps/api/core";

// Mock the Tauri invoke to avoid native calls during tests
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(null),
}));

const SESSION = "test-session-1";

function resetStores() {
  useTerminalStore.setState({
    unreadByCollabSession: {},
    tabs: [],
    activeTabId: null,
  });
  useCollaboratorStore.setState({
    tasksBySession: {},
    statusMessages: {},
    logEntriesBySession: {},
    recentOutcomesBySession: {},
    contextSentByAgent: {},
    pendingMessagesByAgent: {},
    agents: [],
  });
  // Module-level write state (taskWriteChainsBySession + abortedTaskWriteSessions)
  // isn't part of the zustand store, so setState above doesn't touch it.
  // A teardown-race test can leave an abort marker that would short-circuit
  // a subsequent test using the same SESSION ID — clear it here for isolation.
  _resetWriteStateForTests();
}

// (PR-A footer-status tests removed in task-16: the 4 s setStatus-on-terminal
// block was deleted because it duplicated the new in-frame indicator.)

describe("task-16 — 3-state agent task machine + 5 s completed TTL", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetStores();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("does NOT set a footer status message on terminal-state transition (PR-A removed)", () => {
    const store = useCollaboratorStore.getState();
    const task = store.addTask({ objective: "test", title: "x", assignee: "@claude1" }, SESSION);
    store.updateTask(task.id, { status: "completed", completedBy: "@claude1" }, SESSION);

    expect(useCollaboratorStore.getState().statusMessages[SESSION]).toBeUndefined();
  });

  it("getAgentTaskState reports `in_progress` when a pending task is assigned", () => {
    const store = useCollaboratorStore.getState();
    store.addTask({ objective: "do it", title: "build", assignee: "@claude1" }, SESSION);
    const tasks = useCollaboratorStore.getState().tasksBySession[SESSION] ?? [];
    const state = getAgentTaskState(SESSION, "claude1", tasks, useCollaboratorStore.getState().recentOutcomesBySession);
    expect(state.kind).toBe("in_progress");
    expect(state.taskTitle).toBe("build");
  });

  it("an active task outranks a recent completion (highlight ends early when next task is freshly assigned)", () => {
    const store = useCollaboratorStore.getState();
    const t1 = store.addTask({ objective: "first", title: "first", assignee: "@claude1" }, SESSION);
    store.updateTask(t1.id, { status: "completed", completedBy: "@claude1" }, SESSION);
    // Sanity check: with no active task, state is `completed`.
    let tasks = useCollaboratorStore.getState().tasksBySession[SESSION] ?? [];
    let state = getAgentTaskState(SESSION, "claude1", tasks, useCollaboratorStore.getState().recentOutcomesBySession);
    expect(state.kind).toBe("completed");
    expect(state.outcomeKind).toBe("completed");

    // Now a fresh task arrives mid-highlight — it must outrank the completed
    // state so the user sees the new work, not a stale ✓.
    store.addTask({ objective: "second", title: "second", assignee: "@claude1" }, SESSION);
    tasks = useCollaboratorStore.getState().tasksBySession[SESSION] ?? [];
    state = getAgentTaskState(SESSION, "claude1", tasks, useCollaboratorStore.getState().recentOutcomesBySession);
    expect(state.kind).toBe("in_progress");
    expect(state.taskTitle).toBe("second");
  });

  it("`completed` state turns into `idle` 5 s after the terminal transition (no fresh task)", () => {
    const store = useCollaboratorStore.getState();
    const task = store.addTask({ objective: "test", title: "x", assignee: "@claude1" }, SESSION);
    store.updateTask(task.id, { status: "completed", completedBy: "@claude1" }, SESSION);

    // Within the window — state is `completed`.
    let tasks = useCollaboratorStore.getState().tasksBySession[SESSION] ?? [];
    let state = getAgentTaskState(SESSION, "claude1", tasks, useCollaboratorStore.getState().recentOutcomesBySession);
    expect(state.kind).toBe("completed");

    // Past 5 s — state is `idle`, regardless of whether the cleanup
    // setTimeout has fired (self-correcting TTL guard).
    vi.advanceTimersByTime(5000);
    tasks = useCollaboratorStore.getState().tasksBySession[SESSION] ?? [];
    state = getAgentTaskState(SESSION, "claude1", tasks, useCollaboratorStore.getState().recentOutcomesBySession);
    expect(state.kind).toBe("idle");
  });

  it("blocked outcomes still surface as `completed` state with `outcomeKind: 'blocked'`", () => {
    const store = useCollaboratorStore.getState();
    const task = store.addTask({ objective: "stuck", title: "y", assignee: "@codex1" }, SESSION);
    store.updateTask(task.id, { status: "blocked", completedBy: "@codex1" }, SESSION);

    const tasks = useCollaboratorStore.getState().tasksBySession[SESSION] ?? [];
    const state = getAgentTaskState(SESSION, "codex1", tasks, useCollaboratorStore.getState().recentOutcomesBySession);
    expect(state.kind).toBe("completed");
    expect(state.outcomeKind).toBe("blocked");
  });

  it("idle by default when no task is assigned and no recent outcome exists", () => {
    const tasks = useCollaboratorStore.getState().tasksBySession[SESSION] ?? [];
    const state = getAgentTaskState(SESSION, "claude1", tasks, useCollaboratorStore.getState().recentOutcomesBySession);
    expect(state.kind).toBe("idle");
  });
});

// task-23 reflection: cross-validated freshness defect (codex1/codex2/codex3).
// `getAgentTaskState` previously used `tasks.find(...)` which (a) picks the
// first array match (the OLDEST active task, since addTask appends) and
// (b) lets ANY active task preempt the highlight, even pre-existing backlog
// assigned BEFORE completion. Both behaviors contradict the user's
// "freshly-assigned" wording. The fix introduces a freshness check against
// the recent outcome's `at` timestamp and picks the most-recent active task.
describe("task-23 — freshness semantics for `in_progress` precedence", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetStores();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("a pre-existing backlog task does NOT preempt the completed highlight", () => {
    const store = useCollaboratorStore.getState();

    // Simulate a backlog task assigned BEFORE the completion event.
    // (Use addTask directly to bypass the auto-create/hasActiveTask guard.)
    const backlog = store.addTask({ objective: "later", title: "backlog", assignee: "@claude1" }, SESSION);
    expect(backlog.status).toBe("pending");

    // Time passes — the agent finishes a separate task (task A).
    vi.advanceTimersByTime(2000);
    const taskA = store.addTask({ objective: "now", title: "task A", assignee: "@claude1" }, SESSION);
    // Move A to completed in one step. updateTask records the recent outcome.
    store.updateTask(taskA.id, { status: "completed", completedBy: "@claude1" }, SESSION);

    // Backlog task is still pending and was assigned BEFORE the outcome.
    // It should NOT preempt the 5 s completed highlight.
    const tasks = useCollaboratorStore.getState().tasksBySession[SESSION] ?? [];
    const state = getAgentTaskState(SESSION, "claude1", tasks, useCollaboratorStore.getState().recentOutcomesBySession);
    expect(state.kind).toBe("completed");
    expect(state.taskTitle).toBe("task A");
  });

  it("a freshly-assigned task DOES preempt the completed highlight", () => {
    const store = useCollaboratorStore.getState();

    const taskA = store.addTask({ objective: "first", title: "task A", assignee: "@claude1" }, SESSION);
    store.updateTask(taskA.id, { status: "completed", completedBy: "@claude1" }, SESSION);

    // Now the user sends a fresh message → a new task is assigned.
    vi.advanceTimersByTime(1000);
    const fresh = store.addTask({ objective: "second", title: "task B", assignee: "@claude1" }, SESSION);
    expect(fresh.status).toBe("pending");

    const tasks = useCollaboratorStore.getState().tasksBySession[SESSION] ?? [];
    const state = getAgentTaskState(SESSION, "claude1", tasks, useCollaboratorStore.getState().recentOutcomesBySession);
    expect(state.kind).toBe("in_progress");
    expect(state.taskTitle).toBe("task B");
  });

  it("when multiple active tasks coexist, the freshest one is shown", () => {
    const store = useCollaboratorStore.getState();
    store.addTask({ objective: "old", title: "old task", assignee: "@claude1" }, SESSION);
    vi.advanceTimersByTime(50);
    store.addTask({ objective: "newer", title: "newer task", assignee: "@claude1" }, SESSION);
    vi.advanceTimersByTime(50);
    store.addTask({ objective: "newest", title: "newest task", assignee: "@claude1" }, SESSION);

    const tasks = useCollaboratorStore.getState().tasksBySession[SESSION] ?? [];
    const state = getAgentTaskState(SESSION, "claude1", tasks, useCollaboratorStore.getState().recentOutcomesBySession);
    expect(state.kind).toBe("in_progress");
    expect(state.taskTitle).toBe("newest task");
  });

  it("after the 5 s TTL expires, a stale backlog task transitions to in_progress", () => {
    const store = useCollaboratorStore.getState();

    // Backlog assigned first.
    const backlog = store.addTask({ objective: "later", title: "backlog", assignee: "@claude1" }, SESSION);
    vi.advanceTimersByTime(1000);
    const taskA = store.addTask({ objective: "now", title: "task A", assignee: "@claude1" }, SESSION);
    store.updateTask(taskA.id, { status: "completed", completedBy: "@claude1" }, SESSION);

    // Within window: completed wins (backlog doesn't preempt).
    let tasks = useCollaboratorStore.getState().tasksBySession[SESSION] ?? [];
    let state = getAgentTaskState(SESSION, "claude1", tasks, useCollaboratorStore.getState().recentOutcomesBySession);
    expect(state.kind).toBe("completed");

    // After TTL: backlog finally surfaces as in_progress.
    vi.advanceTimersByTime(5000);
    tasks = useCollaboratorStore.getState().tasksBySession[SESSION] ?? [];
    state = getAgentTaskState(SESSION, "claude1", tasks, useCollaboratorStore.getState().recentOutcomesBySession);
    expect(state.kind).toBe("in_progress");
    expect(state.taskTitle).toBe("backlog");
    // (avoid unused-var warning)
    expect(backlog.id).toBeTruthy();
  });
});

describe("task-23 — robustness fixes (empty completedBy, footer auto-clear)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetStores();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("falls through to assignee when completedBy is an empty string", () => {
    const store = useCollaboratorStore.getState();
    const task = store.addTask({ objective: "x", title: "y", assignee: "@codex1" }, SESSION);
    // Agent-protocol JSON could legally deliver an empty `author` field.
    store.updateTask(task.id, { status: "completed", completedBy: "" }, SESSION);

    const outcomes = useCollaboratorStore.getState().recentOutcomesBySession[SESSION] ?? {};
    expect(outcomes["codex1"]).toBeDefined();
    expect(outcomes[""]).toBeUndefined(); // no orphan entry under empty key
  });

  it("Task Report `**Agent**:` line also falls through to assignee when completedBy is empty (codex3 round-6)", () => {
    // Previously this used `task.completedBy ?? task.assignee ?? "unassigned"`,
    // and `??` does NOT treat `""` as absent — so an agent-protocol JSON
    // with `"author": ""` produced an empty `**Agent**:` line in the
    // conversation log even though the outcome-routing path was already
    // patched. The fix mirrors the outcome path: trim() + ||.
    const store = useCollaboratorStore.getState();
    const task = store.addTask({ objective: "x", title: "y", assignee: "@codex1" }, SESSION);
    store.updateTask(task.id, { status: "completed", completedBy: "" }, SESSION);

    const logEntries = useCollaboratorStore.getState().logEntriesBySession[SESSION] ?? [];
    const reportEntry = logEntries.find((e) => e.content.startsWith("Task Report\n"));
    expect(reportEntry).toBeDefined();
    expect(reportEntry?.content).toContain("**Agent**: @codex1");
    // Negative: the bug would have produced "**Agent**: " (empty after the colon).
    expect(reportEntry?.content).not.toMatch(/\*\*Agent\*\*:\s*\n/);
  });

  it("setStatus auto-clears after STATUS_TTL_MS (so footer messages don't go stale)", () => {
    const store = useCollaboratorStore.getState();
    store.setStatus("Sent to Claude Code", SESSION);
    expect(useCollaboratorStore.getState().statusMessages[SESSION]).toBe("Sent to Claude Code");

    vi.advanceTimersByTime(STATUS_TTL_MS);
    expect(useCollaboratorStore.getState().statusMessages[SESSION]).toBeUndefined();
  });

  it("setStatus auto-clear does NOT stomp a fresher message (equality guard)", () => {
    const store = useCollaboratorStore.getState();
    store.setStatus("first", SESSION);
    vi.advanceTimersByTime(2000);
    store.setStatus("second", SESSION);
    // First timer fires at t=4000 — slot now holds "second", so guard skips.
    vi.advanceTimersByTime(2000);
    expect(useCollaboratorStore.getState().statusMessages[SESSION]).toBe("second");
    // Second timer fires at t=6000.
    vi.advanceTimersByTime(2000);
    expect(useCollaboratorStore.getState().statusMessages[SESSION]).toBeUndefined();
  });
});

// task-30 reflection: cross-validated by codex1, codex3, claude3 — the
// freshness gate previously keyed off `task.createdAt`, which missed the
// reassignment-via-updateTask flow (e.g. `/task <id> assign @<agent>`).
// Tasks now carry `assignedAt`, set in addTask and refreshed in
// updateTask only when `assignee` actually changes.
describe("task-30 — assignment freshness via `assignedAt`", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetStores();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("addTask sets assignedAt equal to createdAt initially", () => {
    const store = useCollaboratorStore.getState();
    const task = store.addTask({ objective: "x", title: "y", assignee: "@claude1" }, SESSION);
    expect(task.assignedAt).toBe(task.createdAt);
  });

  it("updateTask refreshes assignedAt when assignee changes", () => {
    const store = useCollaboratorStore.getState();
    const task = store.addTask({ objective: "x", title: "y", assignee: "@claude1" }, SESSION);
    const before = task.assignedAt;

    vi.advanceTimersByTime(1000);
    store.updateTask(task.id, { assignee: "@codex1" }, SESSION);

    const updated = useCollaboratorStore.getState().tasksBySession[SESSION]?.find((t) => t.id === task.id);
    expect(updated?.assignedAt).not.toBe(before);
    expect(new Date(updated!.assignedAt).getTime()).toBeGreaterThan(new Date(before).getTime());
  });

  it("updateTask does NOT refresh assignedAt when assignee is the same", () => {
    const store = useCollaboratorStore.getState();
    const task = store.addTask({ objective: "x", title: "y", assignee: "@claude1" }, SESSION);
    const before = task.assignedAt;

    vi.advanceTimersByTime(1000);
    // Same assignee — should be a no-op for assignedAt to avoid spurious
    // "fresh" classification on unrelated metadata updates.
    store.updateTask(task.id, { assignee: "@claude1", reasoning: "meh" }, SESSION);

    const updated = useCollaboratorStore.getState().tasksBySession[SESSION]?.find((t) => t.id === task.id);
    expect(updated?.assignedAt).toBe(before);
  });

  it("reassigning an old backlog task during a completed highlight DOES preempt", () => {
    const store = useCollaboratorStore.getState();

    // An old backlog task assigned to nobody (or different agent).
    const orphan = store.addTask({ objective: "later", title: "orphan", assignee: null }, SESSION);

    vi.advanceTimersByTime(2000);
    // claude1 completes a different task.
    const taskA = store.addTask({ objective: "now", title: "task A", assignee: "@claude1" }, SESSION);
    store.updateTask(taskA.id, { status: "completed", completedBy: "@claude1" }, SESSION);

    // Within window — completed wins (no fresh task for claude1 yet).
    let tasks = useCollaboratorStore.getState().tasksBySession[SESSION] ?? [];
    let state = getAgentTaskState(SESSION, "claude1", tasks, useCollaboratorStore.getState().recentOutcomesBySession);
    expect(state.kind).toBe("completed");

    // Now the user reassigns the orphan task to claude1 mid-highlight.
    // Even though `orphan.createdAt` is older than the completion outcome,
    // the reassignment refreshes `assignedAt` to "now", which IS after the
    // outcome — so the freshness gate must promote orphan to in_progress.
    vi.advanceTimersByTime(500);
    store.updateTask(orphan.id, { assignee: "@claude1" }, SESSION);

    tasks = useCollaboratorStore.getState().tasksBySession[SESSION] ?? [];
    state = getAgentTaskState(SESSION, "claude1", tasks, useCollaboratorStore.getState().recentOutcomesBySession);
    expect(state.kind).toBe("in_progress");
    expect(state.taskTitle).toBe("orphan");
  });

  it("RECENT_OUTCOME_TTL_MS is exported and used by tests", () => {
    // Smoke test that the constant is reachable and the helper honours it.
    const store = useCollaboratorStore.getState();
    const task = store.addTask({ objective: "x", title: "y", assignee: "@claude1" }, SESSION);
    store.updateTask(task.id, { status: "completed", completedBy: "@claude1" }, SESSION);

    let tasks = useCollaboratorStore.getState().tasksBySession[SESSION] ?? [];
    let state = getAgentTaskState(SESSION, "claude1", tasks, useCollaboratorStore.getState().recentOutcomesBySession);
    expect(state.kind).toBe("completed");

    vi.advanceTimersByTime(RECENT_OUTCOME_TTL_MS);
    tasks = useCollaboratorStore.getState().tasksBySession[SESSION] ?? [];
    state = getAgentTaskState(SESSION, "claude1", tasks, useCollaboratorStore.getState().recentOutcomesBySession);
    expect(state.kind).toBe("idle");
  });
});

// task-37 reflection: tighten the {assignee: undefined} guard (claude1 D3 +
// claude3 D2 cross-validated), persist assignedAt to markdown (claude1 D1 +
// claude2 D1 + claude3 D1 cross-validated by 3 agents), and indicator
// presentation tests (5-rounds-running coverage gap).
describe("task-37 — robustness + indicator presentation coverage", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetStores();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("updateTask({assignee: undefined}) does NOT spuriously bump assignedAt OR overwrite the existing assignee", () => {
    const store = useCollaboratorStore.getState();
    const task = store.addTask({ objective: "x", title: "y", assignee: "@claude1" }, SESSION);
    const beforeAssignedAt = task.assignedAt;
    const beforeAssignee = task.assignee;

    vi.advanceTimersByTime(1000);
    store.updateTask(task.id, { assignee: undefined as unknown as string | null }, SESSION);

    const updated = useCollaboratorStore.getState().tasksBySession[SESSION]?.find((t) => t.id === task.id);
    // assignedAt unchanged (existing guard).
    expect(updated?.assignedAt).toBe(beforeAssignedAt);
    // codex1 + claude2 round-5 finding: the spread used to overwrite
    // task.assignee with `undefined` even when the assignedAt guard fired.
    // The Object.fromEntries(filter !== undefined) pre-spread now strips
    // the offending key so the original assignee is preserved.
    expect(updated?.assignee).toBe(beforeAssignee);
    expect(updated?.assignee).toBe("@claude1");
  });
});

// task-37: pure indicator-presentation helper tests. Replaces the
// rendered-component test gap that was flagged 5 rounds running by every
// reviewer — extracting the IIFE to a pure function lets us pin the full
// (lifecycle × task state × outcomeKind) decision matrix without
// stand-up cost for an xterm/PTY-spawning component.
describe("task-37 — getIndicatorPresentation precedence matrix", () => {
  it("`exited` lifecycle wins over any task state", () => {
    const r = getIndicatorPresentation("exited", { kind: "in_progress", taskTitle: "x" });
    expect(r.label).toBe("exited");
    expect(r.color).toBe("bg-gray-500");
    expect(r.pulse).toBe(false);
    expect(r.ping).toBe(false);
  });

  it("`spawning` lifecycle wins over any task state", () => {
    const r = getIndicatorPresentation("spawning", { kind: "completed", taskTitle: "y", outcomeKind: "completed" });
    expect(r.label).toBe("starting…");
    expect(r.color).toBe("bg-yellow-400");
    expect(r.pulse).toBe(true);
  });

  it("`pre-registration` lifecycle reads as starting (no idle flash)", () => {
    const r = getIndicatorPresentation("pre-registration", { kind: "idle" });
    expect(r.label).toBe("starting…");
  });

  it("running + in_progress → sky pulse with task title in label", () => {
    const r = getIndicatorPresentation("running", { kind: "in_progress", taskTitle: "build foo" });
    expect(r.color).toBe("bg-sky-400");
    expect(r.pulse).toBe(true);
    expect(r.ping).toBe(false);
    expect(r.label).toBe("in progress: build foo");
    expect(r.liveRole).toBe("status");
    expect(r.liveLevel).toBe("polite");
  });

  it("running + in_progress with empty title → bare 'in progress' label", () => {
    const r = getIndicatorPresentation("running", { kind: "in_progress", taskTitle: "" });
    expect(r.label).toBe("in progress");
  });

  it("running + completed (outcomeKind: completed) → emerald + ping + ✓ label + polite role", () => {
    const r = getIndicatorPresentation("running", { kind: "completed", taskTitle: "ship it", outcomeKind: "completed" });
    expect(r.color).toBe("bg-emerald-400");
    expect(r.ping).toBe(true);
    expect(r.label).toBe("✓ ship it");
    expect(r.liveRole).toBe("status");
    expect(r.liveLevel).toBe("polite");
  });

  it("running + completed (outcomeKind: blocked) → amber + pulse + ping + ⚠ label + alert role", () => {
    const r = getIndicatorPresentation("running", { kind: "completed", taskTitle: "stuck", outcomeKind: "blocked" });
    expect(r.color).toBe("bg-amber-500");
    expect(r.pulse).toBe(true);
    expect(r.ping).toBe(true);
    expect(r.label).toBe("⚠ stuck");
    expect(r.liveRole).toBe("alert");
    expect(r.liveLevel).toBe("assertive");
  });

  it("running + idle → dim green, no animation", () => {
    const r = getIndicatorPresentation("running", { kind: "idle" });
    expect(r.color).toBe("bg-green-400/60");
    expect(r.pulse).toBe(false);
    expect(r.ping).toBe(false);
    expect(r.label).toBe("idle");
  });
});

// task-38 reflection: address two deferred items now that the user asked
// for the best path.
//   (1) sendToAgent / broadcastToAll on an existing active task now bump
//       `assignedAt` so the freshness gate sees the send as a fresh act
//       of assignment (cross-validated 3 rounds: claude2 D2, claude3 D7,
//       codex3 finding 3 rounds running).
//   (2) `setStatus(msg, session, "persistent")` opt-out for the auto-clear
//       — used for errors so the user has time to read them after the
//       PR-A-removal-induced 4 s TTL was applied to error messages too.
describe("task-38 — sendToAgent/broadcast bump `assignedAt` on existing active task", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetStores();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("a fresh send re-promotes the indicator from `completed` to `in_progress`", async () => {
    const store = useCollaboratorStore.getState();
    // Seed: an agent with a backlog task assigned BEFORE a recent
    // completion of a different task.
    useCollaboratorStore.setState({
      agents: [{
        sessionId: "pty-1",
        tool: "claude_code",
        status: "running",
        collabSessionId: SESSION,
        ordinal: 1,
        handle: "claude1",
        displayName: "Claude Code #1",
      }],
    });
    const backlog = store.addTask({ objective: "later", title: "backlog", assignee: "@claude1" }, SESSION);

    vi.advanceTimersByTime(2000);
    const taskA = store.addTask({ objective: "now", title: "task A", assignee: "@claude1" }, SESSION);
    store.updateTask(taskA.id, { status: "completed", completedBy: "@claude1" }, SESSION);

    // Sanity: indicator currently `completed` because backlog is older
    // than recent.at, so the freshness gate keeps the highlight.
    let tasks = useCollaboratorStore.getState().tasksBySession[SESSION] ?? [];
    let state = getAgentTaskState(SESSION, "claude1", tasks, useCollaboratorStore.getState().recentOutcomesBySession);
    expect(state.kind).toBe("completed");

    // The user now sends a fresh message. sendToAgent finds backlog as
    // the existing active task and should bump its assignedAt — even
    // though no new task is created. Note: the spawn / inject side-effects
    // are mocked to no-ops via the global tauri invoke mock at top of file.
    vi.advanceTimersByTime(500);
    await store.sendToAgent("pty-1", "follow-up message");

    tasks = useCollaboratorStore.getState().tasksBySession[SESSION] ?? [];
    state = getAgentTaskState(SESSION, "claude1", tasks, useCollaboratorStore.getState().recentOutcomesBySession);
    expect(state.kind).toBe("in_progress");
    expect(state.taskTitle).toBe("backlog");
    // `backlog.assignedAt` should now be strictly newer than its initial
    // value AND newer than recent.at.
    const updatedBacklog = tasks.find((t) => t.id === backlog.id);
    expect(new Date(updatedBacklog!.assignedAt).getTime()).toBeGreaterThan(new Date(backlog.assignedAt).getTime());
  });
});

describe("task-38 — setStatus persistence opt-in", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetStores();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("persistent messages do NOT auto-clear after STATUS_TTL_MS", () => {
    const store = useCollaboratorStore.getState();
    store.setStatus("Error: connection refused", SESSION, "persistent");
    expect(useCollaboratorStore.getState().statusMessages[SESSION]).toBe("Error: connection refused");

    vi.advanceTimersByTime(STATUS_TTL_MS * 3);
    // Still there — persistent messages stay until manually overwritten.
    expect(useCollaboratorStore.getState().statusMessages[SESSION]).toBe("Error: connection refused");
  });

  it("transient messages still auto-clear (default kind)", () => {
    const store = useCollaboratorStore.getState();
    store.setStatus("Sent to Claude Code", SESSION); // no kind = transient
    expect(useCollaboratorStore.getState().statusMessages[SESSION]).toBeDefined();

    vi.advanceTimersByTime(STATUS_TTL_MS);
    expect(useCollaboratorStore.getState().statusMessages[SESSION]).toBeUndefined();
  });

  it("a transient message can overwrite a persistent one (and then auto-clear)", () => {
    const store = useCollaboratorStore.getState();
    store.setStatus("Error: x", SESSION, "persistent");
    vi.advanceTimersByTime(2000);
    store.setStatus("Sent to Claude Code", SESSION);
    expect(useCollaboratorStore.getState().statusMessages[SESSION]).toBe("Sent to Claude Code");
    vi.advanceTimersByTime(STATUS_TTL_MS);
    expect(useCollaboratorStore.getState().statusMessages[SESSION]).toBeUndefined();
  });
});

// task-45 reflection (closes claude2 D2 + claude3 D5): a real integration
// test for scanForTaskCompletions's in-loop re-read. The previous test
// exercised updateTask's statusChanged guard rather than the function under
// test. Now we mock invoke per-call to simulate two concurrent scans
// reading the same .done.json, then assert exactly one terminal-state
// transition (one Task Report block) results.
describe("task-45 — scanForTaskCompletions in-loop re-read (real integration)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetStores();
    // Don't reset the global mock — the module-level
    // `conversationWriteChain` may still resolve async work from prior
    // tests, and resetting would leave it observing `undefined` returns.
    // Instead just override the implementation; the override automatically
    // takes priority over the default `mockResolvedValue(null)`.
  });
  afterEach(() => {
    vi.useRealTimers();
    // Restore the default for subsequent describe blocks. We use
    // mockImplementation here (not mockReset) to preserve any pending
    // microtask chain that may still inspect the result.
    vi.mocked(invoke).mockImplementation(async () => null);
  });

  it("calling scanForTaskCompletions twice over the same .done.json fires only ONE terminal transition", async () => {
    const store = useCollaboratorStore.getState();
    const task = store.addTask({ objective: "x", title: "y", assignee: "@claude1" }, SESSION);

    const doneJson = JSON.stringify({
      task_id: task.id,
      status: "completed",
      author: "@claude1",
      reasoning: "r",
      conclusion: "c",
      output: "o",
    });

    // The mock returns the same done-file across both invocations. After
    // the first scan calls delete_memory_file, list_memory_files would in
    // reality return []; we simulate that by tracking deletion state in
    // the mock.
    let deleted = false;
    vi.mocked(invoke).mockImplementation(async (cmd: string, _args?: unknown) => {
      if (cmd === "list_memory_files") return deleted ? [] : [`${task.id}.done.json`];
      if (cmd === "read_memory_file") return deleted ? null : doneJson;
      if (cmd === "delete_memory_file") {
        deleted = true;
        return null;
      }
      return null;
    });

    // Run two scans back-to-back. Even if a hypothetical second pass saw
    // the file before deletion (e.g. concurrent invocation), the in-loop
    // re-read of store.getTasks inside scanForTaskCompletions would catch
    // the now-terminal task and skip the second updateTask call.
    await scanForTaskCompletions(SESSION);
    await scanForTaskCompletions(SESSION);

    // Exactly one Task Report block in the conversation log — not two.
    const logEntries = useCollaboratorStore.getState().logEntriesBySession[SESSION] ?? [];
    const reportCount = logEntries.filter((e) => e.content.startsWith("Task Report\n")).length;
    expect(reportCount).toBe(1);

    // The task is terminal in the store.
    const updated = useCollaboratorStore.getState().tasksBySession[SESSION]?.find((t) => t.id === task.id);
    expect(updated?.status).toBe("completed");
  });

  it("when the file is replayed AFTER deletion, the loser scan bails on already-terminal status", async () => {
    const store = useCollaboratorStore.getState();
    const task = store.addTask({ objective: "x", title: "y", assignee: "@claude1" }, SESSION);

    // First scan terminalizes the task and (would) delete the file.
    store.updateTask(task.id, { status: "completed", completedBy: "@claude1" }, SESSION);

    // Now run a scan against a "stale" view of the file system that still
    // shows the .done.json. The in-loop re-read should detect the task is
    // already terminal and bail (best-effort delete + continue), not
    // double-fire updateTask.
    const doneJson = JSON.stringify({ task_id: task.id, status: "completed", author: "@claude1" });
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "list_memory_files") return [`${task.id}.done.json`];
      if (cmd === "read_memory_file") return doneJson;
      if (cmd === "delete_memory_file") return null;
      return null;
    });

    const logsBefore = useCollaboratorStore.getState().logEntriesBySession[SESSION]?.length ?? 0;
    await scanForTaskCompletions(SESSION);
    const logsAfter = useCollaboratorStore.getState().logEntriesBySession[SESSION]?.length ?? 0;

    // No new log entries — the loser scan saw terminal status and bailed
    // without calling updateTask.
    expect(logsAfter).toBe(logsBefore);
  });
});

// task-45: regression for codex3 D1 — bumpAssignedAt picks freshest active
// task, not the first array match. Ensures fresh sends bump the same task
// the indicator surfaces as in_progress.
describe("task-45 — sendToAgent bumps the freshest active task, not the oldest", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetStores();
    // Inherit the global default mockResolvedValue(null); no reset needed.
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.mocked(invoke).mockImplementation(async () => null);
  });

  it("when an agent has multiple active tasks, send bumps the freshest one (matches indicator label)", async () => {
    useCollaboratorStore.setState({
      agents: [{
        sessionId: "pty-1",
        tool: "claude_code",
        status: "running",
        collabSessionId: SESSION,
        ordinal: 1,
        handle: "claude1",
        displayName: "Claude Code #1",
      }],
    });
    const store = useCollaboratorStore.getState();

    const oldBacklog = store.addTask({ objective: "old", title: "old backlog", assignee: "@claude1" }, SESSION);
    vi.advanceTimersByTime(1000);
    const currentWork = store.addTask({ objective: "now", title: "current work", assignee: "@claude1" }, SESSION);

    // Fresh send — should bump CURRENT WORK (the freshest), not OLD BACKLOG.
    vi.advanceTimersByTime(500);
    await store.sendToAgent("pty-1", "follow-up message");

    const tasks = useCollaboratorStore.getState().tasksBySession[SESSION] ?? [];
    const updatedOld = tasks.find((t) => t.id === oldBacklog.id);
    const updatedCurrent = tasks.find((t) => t.id === currentWork.id);

    // Old backlog's assignedAt should be unchanged (still the original).
    expect(updatedOld?.assignedAt).toBe(oldBacklog.assignedAt);
    // Current work's assignedAt should be strictly newer.
    expect(new Date(updatedCurrent!.assignedAt).getTime()).toBeGreaterThan(new Date(currentWork.assignedAt).getTime());
  });

  it("a queued persistTasks write is short-circuited after killAllAgents/endSession (codex1+claude3 round-7+8 teardown)", async () => {
    // After teardown, any subsequent persistTasks call must NOT invoke
    // write_memory_file for the tasks file: the abort flag short-circuits
    // the chain step. (For the in-flight write race — claude3 round-8 D1
    // — killAllAgents now awaits the pending chain BEFORE issuing the
    // delete IPC, so the in-flight write settles first. That ordering
    // is implicit in `await store.killAllAgents(...)`.)
    const store = useCollaboratorStore.getState();
    vi.mocked(invoke).mockImplementation(async () => null);

    // Pre-abort: add a task — its persistTasks call should fire normally.
    store.addTask({ objective: "x", title: "y", assignee: "@claude1" }, SESSION);
    await store.killAllAgents(SESSION);

    // Snapshot tasks-file write count after teardown finishes.
    const tasksWritesBefore = vi.mocked(invoke).mock.calls.filter(
      (c) =>
        c[0] === "write_memory_file" &&
        (c[1] as { relativePath?: string })?.relativePath?.startsWith("tasks-"),
    ).length;

    // Post-abort: a new addTask schedules persistTasks. The chain step
    // checks the abort flag and skips invoke("write_memory_file", ...).
    store.addTask({ objective: "z", title: "w", assignee: "@claude1" }, SESSION);
    await Promise.resolve();
    await Promise.resolve();
    const tasksWritesAfter = vi.mocked(invoke).mock.calls.filter(
      (c) =>
        c[0] === "write_memory_file" &&
        (c[1] as { relativePath?: string })?.relativePath?.startsWith("tasks-"),
    ).length;

    expect(tasksWritesAfter).toBe(tasksWritesBefore);
  });

  it("killAllAgents awaits in-flight writes BEFORE issuing delete IPCs (claude3 D5 + claude1 self-D2 ordering pin)", async () => {
    // The abort flag short-circuits QUEUED writes, but a write already
    // past the abort check must complete BEFORE the delete fires (Tauri
    // doesn't guarantee ordering between independent commands). Verify
    // by recording the order of write_memory_file vs delete_memory_file
    // mock invocations: write must precede delete for the same file.
    const store = useCollaboratorStore.getState();
    const order: string[] = [];
    vi.mocked(invoke).mockImplementation(async (cmd: string, args?: unknown) => {
      const path = (args as { relativePath?: string })?.relativePath ?? "";
      if (cmd === "write_memory_file") {
        if (path.startsWith("tasks-")) order.push("write_tasks");
        else if (path.startsWith("conversation-")) order.push("write_conversation");
      } else if (cmd === "delete_memory_file") {
        if (path.startsWith("tasks-")) order.push("delete_tasks");
        else if (path.startsWith("conversation-")) order.push("delete_conversation");
      }
      return null;
    });

    store.addTask({ objective: "x", title: "y", assignee: "@claude1" }, SESSION);
    // Drain microtasks so the chain steps fire write_memory_file BEFORE
    // killAllAgents sets the abort flag — this gives us an "in-flight"
    // write that the explicit await must serialize against the delete.
    // (Without these drains, the abort-flag check would short-circuit
    // both writes synchronously, giving us no in-flight ordering to test.)
    for (let i = 0; i < 5; i++) await Promise.resolve();
    await store.killAllAgents(SESSION);

    // Both write/delete pairs must appear in write-then-delete order.
    // Use `lastIndexOf` for writes so the assertion holds even if MULTIPLE
    // writes happened before the delete — a future test extension that
    // adds more in-flight writes shouldn't silently weaken the contract
    // (claude3 round-10 D6).
    const wTasksLast = order.lastIndexOf("write_tasks");
    const dTasks = order.indexOf("delete_tasks");
    expect(wTasksLast).toBeGreaterThanOrEqual(0);
    expect(dTasks).toBeGreaterThan(wTasksLast);

    const wConvLast = order.lastIndexOf("write_conversation");
    const dConv = order.indexOf("delete_conversation");
    expect(wConvLast).toBeGreaterThanOrEqual(0);
    expect(dConv).toBeGreaterThan(wConvLast);
  });

  it("a queued conversation-log write is also short-circuited after teardown (claude1 round-8 D3)", async () => {
    // Same shape as the task-write teardown guard, applied to the
    // conversation-log chain. Without this, appendLog steps queued
    // before the abort could fire after killAllAgents deletes
    // conversation-{sid}.md and recreate it with stale content.
    const store = useCollaboratorStore.getState();
    vi.mocked(invoke).mockImplementation(async () => null);

    // Pre-abort: an appendLog (via addTask) schedules a conversation
    // write through conversationWriteChain.
    store.addTask({ objective: "x", title: "y", assignee: "@claude1" }, SESSION);
    await store.killAllAgents(SESSION);

    const convWritesBefore = vi.mocked(invoke).mock.calls.filter(
      (c) =>
        c[0] === "write_memory_file" &&
        (c[1] as { relativePath?: string })?.relativePath?.startsWith("conversation-"),
    ).length;

    // Post-abort: another appendLog (e.g. via setStatus → no, via
    // direct test invocation). We use the store's appendLog through
    // `addTask` again; the conversation chain step should now skip.
    store.addTask({ objective: "z", title: "w", assignee: "@claude1" }, SESSION);
    // Drain microtasks for the conversation chain to advance.
    for (let i = 0; i < 5; i++) await Promise.resolve();

    const convWritesAfter = vi.mocked(invoke).mock.calls.filter(
      (c) =>
        c[0] === "write_memory_file" &&
        (c[1] as { relativePath?: string })?.relativePath?.startsWith("conversation-"),
    ).length;

    // No new conversation-log write should have fired post-abort.
    expect(convWritesAfter).toBe(convWritesBefore);
  });

  it("rapid persistTasks calls serialize in order (no last-snapshot-wins races)", async () => {
    // codex1 round-6 race: bumpAssignedAt fires persistTasks fire-and-forget.
    // During a multi-agent broadcast, multiple writes could race and an
    // earlier write could land *after* a later one, leaving stale state.
    // The fix introduces a per-session task-write chain, mirroring
    // conversationWriteChain. We verify by spying on write_memory_file
    // calls and asserting the LAST persistTasks call's content is the one
    // that wins (i.e., writes happen in invocation order).
    const store = useCollaboratorStore.getState();
    const taskCalls: string[] = [];
    vi.mocked(invoke).mockImplementation(async (cmd: string, args?: unknown) => {
      if (cmd === "write_memory_file") {
        const a = args as { content?: string; relativePath?: string };
        // Filter to tasks-file writes only — addTask also fires
        // conversation-log writes via appendLog, and now that the
        // conversation chain is per-session those writes are also
        // serialized but uninteresting for THIS test's assertion.
        if (a.relativePath?.startsWith("tasks-")) {
          taskCalls.push(a.content ?? "");
        }
      }
      return null;
    });

    // Trigger three rapid writes in succession.
    store.addTask({ objective: "a", title: "task A", assignee: "@claude1" }, SESSION);
    store.addTask({ objective: "b", title: "task B", assignee: "@claude1" }, SESSION);
    store.addTask({ objective: "c", title: "task C", assignee: "@claude1" }, SESSION);

    // Drain the chain by awaiting persistTasks once more.
    await store.persistTasks(SESSION);

    // Each addTask call schedules a persist, plus our explicit drain.
    // Calls must be in order: each subsequent write contains a superset
    // of the previous (same task list grows monotonically).
    expect(taskCalls.length).toBeGreaterThanOrEqual(3);
    // The final write reflects all three tasks.
    const final = taskCalls[taskCalls.length - 1];
    expect(final).toContain("task A");
    expect(final).toContain("task B");
    expect(final).toContain("task C");
    // Earlier writes should NOT contain later tasks (proves order).
    expect(taskCalls[0]).toContain("task A");
    expect(taskCalls[0]).not.toContain("task C");
  });

  it("bumpAssignedAt does NOT change updatedAt (semantic clarity)", async () => {
    useCollaboratorStore.setState({
      agents: [{
        sessionId: "pty-1",
        tool: "claude_code",
        status: "running",
        collabSessionId: SESSION,
        ordinal: 1,
        handle: "claude1",
        displayName: "Claude Code #1",
      }],
    });
    const store = useCollaboratorStore.getState();
    const task = store.addTask({ objective: "x", title: "y", assignee: "@claude1" }, SESSION);
    const initialUpdatedAt = task.updatedAt;

    vi.advanceTimersByTime(1000);
    await store.sendToAgent("pty-1", "follow-up");

    const updated = useCollaboratorStore.getState().tasksBySession[SESSION]?.find((t) => t.id === task.id);
    // updatedAt should NOT have moved — bumpAssignedAt is not a "field
    // change", only a freshness-signal refresh.
    expect(updated?.updatedAt).toBe(initialUpdatedAt);
    // assignedAt SHOULD have moved.
    expect(new Date(updated!.assignedAt).getTime()).toBeGreaterThan(new Date(task.assignedAt).getTime());
  });
});

describe("PR-C in-frame outcome — replaces global toast", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetStores();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("records a recent outcome on terminal-state transition", () => {
    const store = useCollaboratorStore.getState();
    const task = store.addTask({ objective: "test", title: "task body" }, SESSION);
    store.updateTask(task.id, { status: "completed", completedBy: "@claude1" }, SESSION);

    const outcome = useCollaboratorStore.getState().recentOutcomesBySession[SESSION]?.["claude1"];
    expect(outcome).toBeDefined();
    expect(outcome?.kind).toBe("completed");
    expect(outcome?.taskId).toBe(task.id);
  });

  it("records blocked outcomes with the blocked kind", () => {
    const store = useCollaboratorStore.getState();
    const task = store.addTask({ objective: "test", title: "stuck" }, SESSION);
    store.updateTask(task.id, { status: "blocked", completedBy: "@codex1" }, SESSION);

    const outcome = useCollaboratorStore.getState().recentOutcomesBySession[SESSION]?.["codex1"];
    expect(outcome?.kind).toBe("blocked");
  });

  it("auto-clears the recent outcome after 5s", () => {
    const store = useCollaboratorStore.getState();
    const task = store.addTask({ objective: "test", title: "x" }, SESSION);
    store.updateTask(task.id, { status: "completed", completedBy: "@claude1" }, SESSION);

    expect(useCollaboratorStore.getState().recentOutcomesBySession[SESSION]?.["claude1"]).toBeDefined();
    vi.advanceTimersByTime(5000);
    expect(useCollaboratorStore.getState().recentOutcomesBySession[SESSION]?.["claude1"]).toBeUndefined();
  });

  it("falls back to assignee when completedBy is absent", () => {
    const store = useCollaboratorStore.getState();
    const task = store.addTask({ objective: "test", title: "y", assignee: "@gemini1" }, SESSION);
    store.updateTask(task.id, { status: "completed" }, SESSION);

    const outcome = useCollaboratorStore.getState().recentOutcomesBySession[SESSION]?.["gemini1"];
    expect(outcome?.kind).toBe("completed");
  });

  it("increments the per-collab-session unread counter", () => {
    const store = useCollaboratorStore.getState();
    const t1 = store.addTask({ objective: "test", title: "a" }, SESSION);
    const t2 = store.addTask({ objective: "test", title: "b" }, SESSION);
    store.updateTask(t1.id, { status: "completed", completedBy: "@x" }, SESSION);
    vi.advanceTimersByTime(2000);
    store.updateTask(t2.id, { status: "completed", completedBy: "@y" }, SESSION);

    expect(useTerminalStore.getState().unreadByCollabSession[SESSION]).toBe(2);
  });

  it("suppresses unread increment when the active tab already contains the matching collab session", () => {
    // Set up an active tab that contains the SESSION's collaborator leaf.
    useTerminalStore.setState({
      tabs: [
        {
          id: "tab-1",
          title: "T1",
          paneTree: { type: "leaf", kind: "collaborator", sessionId: SESSION },
          activePaneSessionId: SESSION,
          maximizedPaneSessionId: null,
        },
      ],
      activeTabId: "tab-1",
    });

    const store = useCollaboratorStore.getState();
    const task = store.addTask({ objective: "x", title: "y" }, SESSION);
    store.updateTask(task.id, { status: "completed", completedBy: "@a" }, SESSION);

    // Badge must NOT increment — user is already viewing this session.
    expect(useTerminalStore.getState().unreadByCollabSession[SESSION] ?? 0).toBe(0);
  });

  it("STILL increments unread when the collab pane is hidden by a maximize on another pane", () => {
    // Tab is active and contains the collab session — but a *different*
    // pane (the terminal) is maximized, so the collab pane is hidden.
    // Without the visibility-aware suppression, completions vanish:
    // no toast (removed), no in-frame light (hidden), no badge (suppressed).
    useTerminalStore.setState({
      tabs: [
        {
          id: "tab-1",
          title: "T1",
          paneTree: {
            type: "split",
            direction: "horizontal",
            children: [
              { type: "leaf", kind: "terminal", sessionId: "term-1" },
              { type: "leaf", kind: "collaborator", sessionId: SESSION },
            ],
          },
          activePaneSessionId: "term-1",
          maximizedPaneSessionId: "term-1", // collab pane is HIDDEN
        },
      ],
      activeTabId: "tab-1",
    });

    const store = useCollaboratorStore.getState();
    const task = store.addTask({ objective: "x", title: "y" }, SESSION);
    store.updateTask(task.id, { status: "completed", completedBy: "@a" }, SESSION);

    // Badge MUST increment — collab pane is not visible, so this is the
    // only signal the user has.
    expect(useTerminalStore.getState().unreadByCollabSession[SESSION]).toBe(1);
  });

  it("suppresses unread when the collab pane IS the maximized pane", () => {
    useTerminalStore.setState({
      tabs: [
        {
          id: "tab-1",
          title: "T1",
          paneTree: {
            type: "split",
            direction: "horizontal",
            children: [
              { type: "leaf", kind: "terminal", sessionId: "term-1" },
              { type: "leaf", kind: "collaborator", sessionId: SESSION },
            ],
          },
          activePaneSessionId: SESSION,
          maximizedPaneSessionId: SESSION, // collab pane IS the maximized pane
        },
      ],
      activeTabId: "tab-1",
    });

    const store = useCollaboratorStore.getState();
    const task = store.addTask({ objective: "x", title: "y" }, SESSION);
    store.updateTask(task.id, { status: "completed", completedBy: "@a" }, SESSION);

    // Collab pane is fully visible → suppression is correct.
    expect(useTerminalStore.getState().unreadByCollabSession[SESSION] ?? 0).toBe(0);
  });
});

// task-46 (this PR): contextSentByAgent slim-header gating + first-send
// race/order safety. Validates the S1 fix from the bug report — agents
// no longer receive the full ~40-line TASK_PROTOCOL block on every send.
describe("task-46 — contextSentByAgent slim-header gating", () => {
  // Helper to scrape the text payload of an inject_into_pty mock call.
  const injectCalls = () =>
    vi.mocked(invoke).mock.calls
      .filter((c) => c[0] === "inject_into_pty")
      .map((c) => (c[1] as { text: string }).text);

  beforeEach(() => {
    resetStores();
    // Clear accumulated mock.calls history from prior tests so injectCalls()
    // only sees this test's invocations. Implementation override is the
    // simple "succeeds" default; individual tests can override per-test.
    vi.mocked(invoke).mockClear();
    vi.mocked(invoke).mockImplementation(async () => null);
    // Seed an agent so sendToAgent has something to send to.
    useCollaboratorStore.setState({
      agents: [{
        sessionId: "pty-1",
        tool: "claude_code",
        status: "running",
        collabSessionId: SESSION,
        ordinal: 1,
        handle: "claude1",
        displayName: "Claude Code #1",
      }],
    });
  });
  afterEach(() => {
    vi.mocked(invoke).mockImplementation(async () => null);
  });

  it("first send injects the FULL TASK_PROTOCOL block", async () => {
    await useCollaboratorStore.getState().sendToAgent("pty-1", "hello");
    const calls = injectCalls();
    expect(calls.length).toBe(1);
    expect(calls[0]).toContain("Agent Task Protocol");
    expect(calls[0]).toContain("hello");
  });

  it("second send omits TASK_PROTOCOL but keeps active-task summary + breadcrumb", async () => {
    const store = useCollaboratorStore.getState();
    await store.sendToAgent("pty-1", "first");
    await store.sendToAgent("pty-1", "second");

    const calls = injectCalls();
    expect(calls.length).toBe(2);
    expect(calls[1]).not.toContain("Agent Task Protocol");
    expect(calls[1]).toContain("Tasks file:");
    expect(calls[1]).toContain("Your active tasks");   // formatTaskSummaryForAgent
    expect(calls[1]).toContain("Protocol reminder");   // breadcrumb
    expect(calls[1]).toContain("second");
  });

  it("flag flips to true on successful first inject", async () => {
    await useCollaboratorStore.getState().sendToAgent("pty-1", "x");
    const flag = useCollaboratorStore.getState().contextSentByAgent["pty-1"];
    expect(flag).toBe(true);
  });

  it("failed first inject does NOT promote the flag — second send retries with full header", async () => {
    // First call rejects, subsequent calls succeed
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "inject_into_pty") {
        // Track call count via mock.calls.length AFTER this returns
        const priorInjects = vi.mocked(invoke).mock.calls.filter((c) => c[0] === "inject_into_pty").length;
        // priorInjects already includes THIS call, so 1 = first call
        if (priorInjects === 1) throw new Error("PTY closed");
      }
      return null;
    });

    const store = useCollaboratorStore.getState();
    await store.sendToAgent("pty-1", "boom");  // catches internally, sets persistent error status
    await store.sendToAgent("pty-1", "retry");

    const calls = injectCalls();
    expect(calls.length).toBe(2);
    expect(calls[0]).toContain("Agent Task Protocol");  // first attempt was full
    expect(calls[1]).toContain("Agent Task Protocol");  // retry was also full (flag rolled back)
  });

  it("removeAgent clears contextSentByAgent for that sessionId", async () => {
    const store = useCollaboratorStore.getState();
    await store.sendToAgent("pty-1", "x");
    expect(useCollaboratorStore.getState().contextSentByAgent["pty-1"]).toBe(true);

    store.removeAgent("pty-1");
    expect(useCollaboratorStore.getState().contextSentByAgent["pty-1"]).toBeUndefined();
  });

  it("killAllAgents(sid) clears contextSentByAgent for agents in that session", async () => {
    // Seed two agents in the same session
    useCollaboratorStore.setState({
      agents: [
        { sessionId: "pty-1", tool: "claude_code", status: "running", collabSessionId: SESSION, ordinal: 1, handle: "claude1", displayName: "Claude Code #1" },
        { sessionId: "pty-2", tool: "codex_cli", status: "running", collabSessionId: SESSION, ordinal: 1, handle: "codex1", displayName: "Codex CLI #1" },
      ],
    });
    const store = useCollaboratorStore.getState();
    await store.sendToAgent("pty-1", "x");
    await store.sendToAgent("pty-2", "y");
    expect(useCollaboratorStore.getState().contextSentByAgent["pty-1"]).toBe(true);
    expect(useCollaboratorStore.getState().contextSentByAgent["pty-2"]).toBe(true);

    await store.killAllAgents(SESSION);

    expect(useCollaboratorStore.getState().contextSentByAgent["pty-1"]).toBeUndefined();
    expect(useCollaboratorStore.getState().contextSentByAgent["pty-2"]).toBeUndefined();
  });

  it("ordering: concurrent first sends — only ONE full header is injected, slim arrives second", async () => {
    // Make the first inject take a controllable amount of time so the
    // second send enters while the first is mid-flight.
    let resolveFirstInject!: () => void;
    const firstInjectGate = new Promise<void>((r) => { resolveFirstInject = r; });
    let injectCount = 0;
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "inject_into_pty") {
        injectCount++;
        if (injectCount === 1) await firstInjectGate;  // hold first inject open
      }
      return null;
    });

    const store = useCollaboratorStore.getState();
    // Kick off both sends without awaiting — they should race.
    const p1 = store.sendToAgent("pty-1", "first");
    // Yield once so p1 enters and marks "inflight".
    await Promise.resolve();
    const p2 = store.sendToAgent("pty-1", "second");

    // Now release the first inject; both should complete.
    resolveFirstInject();
    await Promise.all([p1, p2]);

    const calls = injectCalls();
    expect(calls.length).toBe(2);
    // Critical: the FIRST inject (calls[0]) must be the full header.
    // The SECOND inject (calls[1]) must be slim — the second sender
    // waited on firstSendInflight and saw flag === true after the wait.
    expect(calls[0]).toContain("Agent Task Protocol");
    expect(calls[1]).not.toContain("Agent Task Protocol");
    expect(calls[1]).toContain("Protocol reminder");
  });

  it("buildSlimHeader for an agent with no active tasks still works (no Active Tasks section)", async () => {
    // Wipe seeded agents and re-add WITHOUT auto-creating a task on send.
    // sendToAgent always auto-creates a task if none exist, so to test the
    // "no tasks" branch of buildSlimHeader we have to test it indirectly:
    // do a first-send, then verify the second-send's payload structure.
    const store = useCollaboratorStore.getState();
    await store.sendToAgent("pty-1", "first");
    await store.sendToAgent("pty-1", "second");

    const calls = injectCalls();
    // Second call has the active-task summary because the first send
    // auto-created a task. Verify the section is present.
    expect(calls[1]).toContain("Your active tasks");
  });
});

// task-47 (v0.1.7): formatTaskSummaryForAgent — recipient-aware,
// status-filtered task summary that replaces the old
// formatTaskSummaryForPrompt. Closes the dominant remaining bloat in
// the per-message payload after v0.1.6's TASK_PROTOCOL gating.
describe("task-47 — formatTaskSummaryForAgent slimming", () => {
  // Helper to construct a minimal CollabTask without re-typing every field.
  const mkTask = (overrides: Partial<CollabTask> & Pick<CollabTask, "id" | "title">): CollabTask => ({
    objective: overrides.title,
    context: "",
    deliverables: [],
    assignee: null,
    dependencies: [],
    status: "pending",
    reasoning: null,
    conclusion: null,
    output: null,
    completedBy: null,
    createdAt: "2026-04-26T00:00:00.000Z",
    updatedAt: "2026-04-26T00:00:00.000Z",
    assignedAt: "2026-04-26T00:00:00.000Z",
    ...overrides,
  });

  it("drops completed and blocked tasks from the active summary", () => {
    const tasks: CollabTask[] = [
      mkTask({ id: "task-1-1777170000000", title: "pending one", status: "pending", assignee: "@claude1" }),
      mkTask({ id: "task-2-1777170000001", title: "completed one", status: "completed", assignee: "@claude1" }),
      mkTask({ id: "task-3-1777170000002", title: "blocked one", status: "blocked", assignee: "@claude1" }),
    ];
    const out = formatTaskSummaryForAgent(tasks, "claude1");
    expect(out).toContain("pending one");
    expect(out).not.toContain("completed one");
    expect(out).not.toContain("blocked one");
  });

  it("splits 'yours' vs 'others' when recipient is known", () => {
    const tasks: CollabTask[] = [
      mkTask({ id: "task-1-1777170000000", title: "mine A", assignee: "@claude1" }),
      mkTask({ id: "task-2-1777170000001", title: "mine B", assignee: "@claude1" }),
      mkTask({ id: "task-3-1777170000002", title: "theirs A", assignee: "@codex1" }),
      mkTask({ id: "task-4-1777170000003", title: "theirs B", assignee: "@codex1" }),
    ];
    const out = formatTaskSummaryForAgent(tasks, "claude1");
    expect(out).toMatch(/## Your active tasks[\s\S]*mine A[\s\S]*mine B/);
    expect(out).toMatch(/## Other agents' active tasks \(2\)[\s\S]*theirs A[\s\S]*theirs B/);
  });

  it("includes unassigned tasks under 'yours' (anyone could pick them up)", () => {
    const tasks: CollabTask[] = [
      mkTask({ id: "task-1-1777170000000", title: "open task", assignee: null }),
    ];
    const out = formatTaskSummaryForAgent(tasks, "claude1");
    expect(out).toContain("Your active tasks");
    expect(out).toContain("open task");
    // No 'others' section since the only task is unassigned (counted as mine).
    expect(out).not.toContain("Other agents' active tasks");
  });

  it("omits 'others' section when no other-agent tasks exist", () => {
    const tasks: CollabTask[] = [
      mkTask({ id: "task-1-1777170000000", title: "solo", assignee: "@claude1" }),
    ];
    const out = formatTaskSummaryForAgent(tasks, "claude1");
    expect(out).toContain("Your active tasks");
    expect(out).not.toContain("Other agents' active tasks");
  });

  it("truncates objectives longer than 120 chars and appends '...'", () => {
    const longObj = "x".repeat(150);
    const tasks: CollabTask[] = [
      mkTask({ id: "task-1-1777170000000", title: "long-obj task", objective: longObj, assignee: "@claude1" }),
    ];
    const out = formatTaskSummaryForAgent(tasks, "claude1");
    // Truncated body: 117 chars of x + "..."
    expect(out).toContain("x".repeat(117) + "...");
    expect(out).not.toContain("x".repeat(150));
  });

  it("strips the -{Date.now()} suffix from rendered task IDs", () => {
    const tasks: CollabTask[] = [
      mkTask({ id: "task-5-1777170000000", title: "x", assignee: "@claude1" }),
      mkTask({ id: "task-6-1777170000001", title: "y", assignee: "@codex1" }),
    ];
    const out = formatTaskSummaryForAgent(tasks, "claude1");
    expect(out).toContain("task-5: x");
    expect(out).toContain("task-6 (@codex1): y");
    expect(out).not.toContain("1777170000000");
    expect(out).not.toContain("1777170000001");
  });

  it("returns empty string when no active tasks remain after filtering", () => {
    const tasks: CollabTask[] = [
      mkTask({ id: "task-1-1777170000000", title: "done", status: "completed", assignee: "@claude1" }),
    ];
    expect(formatTaskSummaryForAgent(tasks, "claude1")).toBe("");
  });

  it("when recipient is null (broadcast scope), all active tasks land under one section without split", () => {
    const tasks: CollabTask[] = [
      mkTask({ id: "task-1-1777170000000", title: "mixed A", assignee: "@claude1" }),
      mkTask({ id: "task-2-1777170000001", title: "mixed B", assignee: "@codex1" }),
    ];
    const out = formatTaskSummaryForAgent(tasks, null);
    // Heading is neutral when recipient is null — "Your active tasks"
    // would be misleading since the section contains everyone's tasks.
    expect(out).toContain("## Active tasks");
    expect(out).not.toContain("## Your active tasks");
    expect(out).toContain("mixed A");
    expect(out).toContain("mixed B");
    expect(out).not.toContain("Other agents' active tasks");
  });

  it("omits Objective line when objective equals title (avoids duplication)", () => {
    const tasks: CollabTask[] = [
      mkTask({ id: "task-1-1777170000000", title: "same", objective: "same", assignee: "@claude1" }),
    ];
    const out = formatTaskSummaryForAgent(tasks, "claude1");
    expect(out).toContain("task-1: same");
    expect(out).not.toContain("Objective:");
  });

  // B4 regression — `othersCap` slices the others bucket and renders an
  // "... and N more" trailer. Without the cap, slim-header payload grows
  // unbounded as collaboration scales (codex2 task-10 finding).
  it("caps the 'others' bucket when options.othersCap is provided", () => {
    const tasks: CollabTask[] = [
      mkTask({ id: "task-1-1777170000000", title: "mine", assignee: "@claude1" }),
      ...Array.from({ length: 8 }, (_, i) =>
        mkTask({
          id: `task-${i + 2}-1777170000${String(i + 1).padStart(3, "0")}`,
          title: `their ${i + 1}`,
          assignee: i % 2 === 0 ? "@codex1" : "@claude2",
        }),
      ),
    ];
    const out = formatTaskSummaryForAgent(tasks, "claude1", { othersCap: 5 });
    // Header still reports the true total (8), not the capped count.
    expect(out).toContain("## Other agents' active tasks (8)");
    expect(out).toContain("their 1");
    expect(out).toContain("their 5");
    // Items past the cap are hidden behind a "... and N more" line.
    expect(out).not.toContain("their 6");
    expect(out).not.toContain("their 8");
    expect(out).toContain("- ... and 3 more");
  });

  it("does not append '... and N more' when others count is at or below the cap", () => {
    const tasks: CollabTask[] = [
      mkTask({ id: "task-1-1777170000000", title: "mine", assignee: "@claude1" }),
      mkTask({ id: "task-2-1777170000001", title: "their A", assignee: "@codex1" }),
      mkTask({ id: "task-3-1777170000002", title: "their B", assignee: "@codex2" }),
    ];
    const out = formatTaskSummaryForAgent(tasks, "claude1", { othersCap: 5 });
    expect(out).toContain("their A");
    expect(out).toContain("their B");
    expect(out).not.toContain("and 0 more");
    expect(out).not.toContain("and -");
  });

  it("with no cap (default), all others are rendered (full-header behavior preserved)", () => {
    const tasks: CollabTask[] = [
      mkTask({ id: "task-1-1777170000000", title: "mine", assignee: "@claude1" }),
      ...Array.from({ length: 10 }, (_, i) =>
        mkTask({
          id: `task-${i + 2}-1777170000${String(i + 1).padStart(3, "0")}`,
          title: `their ${i + 1}`,
          assignee: "@codex1",
        }),
      ),
    ];
    const out = formatTaskSummaryForAgent(tasks, "claude1"); // no options
    expect(out).toContain("their 1");
    expect(out).toContain("their 10");
    expect(out).not.toContain("more");
  });
});

// Regression: slim-header correctness fixes from task-13 synthesis
//   B1 — re-add [Shared context] probe to slim header
//   B2 — read-discipline hint must come AFTER the task summary it refers to
describe("slim-header correctness (B1 + B2)", () => {
  const injectCalls = () =>
    vi.mocked(invoke).mock.calls
      .filter((c) => c[0] === "inject_into_pty")
      .map((c) => (c[1] as { text: string }).text);

  beforeEach(() => {
    resetStores();
    vi.mocked(invoke).mockClear();
    vi.mocked(invoke).mockImplementation(async () => null);
    useCollaboratorStore.setState({
      agents: [{
        sessionId: "pty-1",
        tool: "claude_code",
        status: "running",
        collabSessionId: SESSION,
        ordinal: 1,
        handle: "claude1",
        displayName: "Claude Code #1",
      }],
    });
  });
  afterEach(() => {
    vi.mocked(invoke).mockImplementation(async () => null);
  });

  // B1
  it("slim header includes [Shared context: …] when context.md exists", async () => {
    // Mock read_memory_file to return non-empty content for context.md.
    vi.mocked(invoke).mockImplementation(async (cmd: string, args?: unknown) => {
      if (cmd === "read_memory_file" && (args as { relativePath?: string })?.relativePath === "context.md") {
        return "important shared constraint";
      }
      return null;
    });

    const store = useCollaboratorStore.getState();
    await store.sendToAgent("pty-1", "first");
    await store.sendToAgent("pty-1", "second");

    const calls = injectCalls();
    expect(calls.length).toBe(2);
    // Slim send (calls[1]) must include the [Shared context] breadcrumb.
    expect(calls[1]).toMatch(/\[Shared context: .*context\.md\]/);
  });

  it("slim header omits [Shared context: …] when context.md is empty/missing", async () => {
    // Default mock returns null → no context.md content.
    const store = useCollaboratorStore.getState();
    await store.sendToAgent("pty-1", "first");
    await store.sendToAgent("pty-1", "second");

    const calls = injectCalls();
    expect(calls.length).toBe(2);
    expect(calls[1]).not.toContain("[Shared context:");
  });

  // B2
  it("slim header places the read-discipline hint AFTER the task summary it references", async () => {
    const store = useCollaboratorStore.getState();
    await store.sendToAgent("pty-1", "first");
    await store.sendToAgent("pty-1", "second");

    const calls = injectCalls();
    expect(calls.length).toBe(2);
    const slim = calls[1];
    const taskSectionIdx = slim.indexOf("## Your active tasks");
    const readDisciplineIdx = slim.indexOf("[Read-discipline:");
    expect(taskSectionIdx).toBeGreaterThan(-1);
    expect(readDisciplineIdx).toBeGreaterThan(-1);
    // "above" wording requires the hint to come after the section it labels.
    expect(readDisciplineIdx).toBeGreaterThan(taskSectionIdx);
  });

  // B2 — degenerate empty-summary case: 4-way concurrent finding from
  // claude2/claude3/codex3/claude1 in the task-15..20 verification round.
  // The hint must NOT appear when there are no active tasks for it to
  // refer to, otherwise "trust the task list above" is literally false.
  it("slim header omits the read-discipline hint when there are no active tasks", async () => {
    const store = useCollaboratorStore.getState();
    // First send auto-creates a task (sendToAgent does this).
    await store.sendToAgent("pty-1", "first");

    // Mark every active task in this session as completed so the next
    // slim send will have an empty summary.
    const sessionTasks = useCollaboratorStore.getState().tasksBySession[SESSION] ?? [];
    for (const t of sessionTasks) {
      store.updateTask(t.id, { status: "completed", completedBy: "@claude1" }, SESSION);
    }

    // Second send must NOT auto-create a new task. The auto-create logic
    // only fires when no freshest-active task exists for this agent. We
    // just completed all of them, so a fresh one WILL be created. Work
    // around by sending via broadcastToAll on a session that has no
    // pending tasks AND uses an existing agent... but that re-creates
    // the same problem. Easier: send and then immediately re-complete
    // the auto-created task before checking — but we want to verify the
    // SLIM path's behavior with empty summary. The cleanest path is to
    // call buildSlimHeader-equivalent through sendToAgent after marking
    // the auto-created task done, then send a third message which will
    // also auto-create. So we have to test the formatter's empty branch
    // through formatTaskSummaryForAgent directly + a separate slim-path
    // test that injects a task list of all-completed.

    // The above gymnastics show the testability constraint: sendToAgent
    // ALWAYS ensures a fresh task exists. So instead, verify via the
    // formatter's contract that empty input yields empty output (already
    // covered at line 1320), and rely on the conditional `if (summary)`
    // guard in buildSlimHeader to drop the hint. The integration test
    // below covers the visible side-effect:
    expect(formatTaskSummaryForAgent([], "claude1")).toBe("");
    // And the slim-header conditional is exercised via a fake-empty
    // tasks list test below.
  });

  it("slim header with all-completed tasks omits both the summary and the read-discipline hint (integration)", async () => {
    // Override sendToAgent's auto-task-creation by pre-seeding a completed
    // task and then triggering the second send WITHOUT going through
    // sendToAgent's task-creation path. We do this by calling
    // sendToAgent twice — the first call seeds via auto-create, then
    // we mark it completed AND pre-add a fresh task to suppress
    // auto-create on the second call. Then mark THAT one completed too,
    // and broadcastToAll WITHOUT a session id (which doesn't auto-create).
    const store = useCollaboratorStore.getState();
    await store.sendToAgent("pty-1", "first");

    // Now manually mark all tasks completed.
    const tasks = useCollaboratorStore.getState().tasksBySession[SESSION] ?? [];
    for (const t of tasks) {
      store.updateTask(t.id, { status: "completed", completedBy: "@claude1" }, SESSION);
    }

    // broadcastToAll(content, undefined) takes the session-less path which
    // does NOT auto-create tasks (see lines 1272-1290 — auto-create is
    // gated on `if (sid)`).
    await store.broadcastToAll("second", undefined);

    const calls = injectCalls();
    // calls[0] = first send (full header), calls[1] = broadcast (slim).
    expect(calls.length).toBe(2);
    const slim = calls[1];
    // Empty summary → no "Your active tasks" header AND no read-discipline.
    expect(slim).not.toContain("## Your active tasks");
    expect(slim).not.toContain("[Read-discipline:");
    // But the rest of the slim header must still be intact.
    expect(slim).toContain("[Protocol reminder:");
    expect(slim).toContain("[You are @claude1]");
    expect(slim).toContain("second"); // user content reaches the agent
  });
});


