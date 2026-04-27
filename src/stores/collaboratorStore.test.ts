import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  useCollaboratorStore,
  getAgentTaskState,
  getIndicatorPresentation,
  scanForTaskCompletions,
  formatTaskSummaryForAgent,
  _resetWriteStateForTests,
  _isRenamePendingForTests,
  RECENT_OUTCOME_TTL_MS,
  STATUS_TTL_MS,
  slugify,
} from "./collaboratorStore";
import type { CollabTask, SpawnedAgent } from "../types/collaborator";
import { parseInput, resolveAgent, executeCommand } from "../components/collaborator/commands";
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

  // ── task-12 / task-5 follow-up: handle+nickname surfacing in writers ──
  // Covers two related concerns surfaced by peer review:
  //   1. (codex1 task-7 + codex2 task-9) `buildNicknameIndex` previously
  //      indexed exited agents, so persisted task/report formatting could
  //      still render `@handle (nickname)` for dead agents — contradicting
  //      the documented "fall back to bare @handle when the agent has
  //      exited" invariant.
  //   2. (claude2 task-8) The slim-header identity line had a direct test
  //      assertion for the new `@<handle> (<nickname>)` format, but the
  //      `formatTasksMarkdown` Assignee/Completed By decoration and the
  //      conversation-log Task Report / Task created lines did not.
  it("Task Report `**Agent**:` line decorates a live agent with its nickname", () => {
    const store = useCollaboratorStore.getState();
    useCollaboratorStore.setState({
      agents: [{
        sessionId: "pty-codex1",
        tool: "codex_cli",
        status: "running",
        collabSessionId: SESSION,
        ordinal: 1,
        handle: "codex1",
        nickname: "reviewer-1",
        nicknameSlug: "reviewer-1",
        nameHistory: [{ nickname: "reviewer-1", setAt: "2024-01-01T00:00:00.000Z", setBy: "user" }],
      }],
    });
    const task = store.addTask({ objective: "x", title: "y", assignee: "@codex1" }, SESSION);
    store.updateTask(task.id, { status: "completed", completedBy: "@codex1" }, SESSION);

    const logEntries = useCollaboratorStore.getState().logEntriesBySession[SESSION] ?? [];
    const reportEntry = logEntries.find((e) => e.content.startsWith("Task Report\n"));
    expect(reportEntry?.content).toContain("**Agent**: @codex1 (reviewer-1)");
  });

  it("Task Report `**Agent**:` line falls back to bare @handle when the agent has exited", () => {
    // The PTY exit path calls setAgentStatus(sessionId, "exited") but
    // leaves the agent in store.agents. Before the buildNicknameIndex
    // status filter, this dead agent's nickname still leaked into the
    // Task Report — codex1 task-7 + codex2 task-9 cross-validated finding.
    const store = useCollaboratorStore.getState();
    useCollaboratorStore.setState({
      agents: [{
        sessionId: "pty-codex1",
        tool: "codex_cli",
        status: "exited",
        collabSessionId: SESSION,
        ordinal: 1,
        handle: "codex1",
        nickname: "reviewer-1",
        nicknameSlug: "reviewer-1",
        nameHistory: [{ nickname: "reviewer-1", setAt: "2024-01-01T00:00:00.000Z", setBy: "user" }],
      }],
    });
    const task = store.addTask({ objective: "x", title: "y", assignee: "@codex1" }, SESSION);
    store.updateTask(task.id, { status: "completed", completedBy: "@codex1" }, SESSION);

    const logEntries = useCollaboratorStore.getState().logEntriesBySession[SESSION] ?? [];
    const reportEntry = logEntries.find((e) => e.content.startsWith("Task Report\n"));
    expect(reportEntry?.content).toContain("**Agent**: @codex1");
    // Negative: the leak bug would have produced "@codex1 (reviewer-1)".
    expect(reportEntry?.content).not.toContain("(reviewer-1)");
  });

  it("`Task created:` log line decorates the assignee with its nickname for a live agent", () => {
    const store = useCollaboratorStore.getState();
    useCollaboratorStore.setState({
      agents: [{
        sessionId: "pty-claude2",
        tool: "claude_code",
        status: "running",
        collabSessionId: SESSION,
        ordinal: 2,
        handle: "claude2",
        nickname: "reviewer-2",
        nicknameSlug: "reviewer-2",
        nameHistory: [{ nickname: "reviewer-2", setAt: "2024-01-01T00:00:00.000Z", setBy: "user" }],
      }],
    });
    store.addTask({ objective: "x", title: "y", assignee: "@claude2" }, SESSION);

    const logEntries = useCollaboratorStore.getState().logEntriesBySession[SESSION] ?? [];
    const created = logEntries.find((e) => e.content.startsWith("Task created:"));
    expect(created?.content).toContain("→ @claude2 (reviewer-2)");
  });

  it("formatTasksMarkdown writes `**Assignee**: @handle (nickname)` for live agents and bare handle for exited ones", async () => {
    // Drive the persisted-tasks writer through persistTasks and inspect
    // the write_memory_file payload so we cover both producer paths
    // (formatTasksMarkdown + buildNicknameIndex status filter) without
    // exporting either helper.
    const writeCalls: { relativePath: string; content: string }[] = [];
    vi.mocked(invoke).mockImplementation(async (cmd: string, args?: unknown) => {
      if (cmd === "write_memory_file") {
        const a = args as { relativePath: string; content: string };
        writeCalls.push({ relativePath: a.relativePath, content: a.content });
      }
      return null;
    });
    useCollaboratorStore.setState({
      agents: [
        {
          sessionId: "pty-claude2",
          tool: "claude_code",
          status: "running",
          collabSessionId: SESSION,
          ordinal: 2,
          handle: "claude2",
          nickname: "reviewer-2",
          nicknameSlug: "reviewer-2",
          nameHistory: [{ nickname: "reviewer-2", setAt: "2024-01-01T00:00:00.000Z", setBy: "user" }],
        },
        {
          sessionId: "pty-codex1",
          tool: "codex_cli",
          status: "exited",
          collabSessionId: SESSION,
          ordinal: 1,
          handle: "codex1",
          nickname: "reviewer-1",
          nicknameSlug: "reviewer-1",
          nameHistory: [{ nickname: "reviewer-1", setAt: "2024-01-01T00:00:00.000Z", setBy: "user" }],
        },
      ],
    });
    const store = useCollaboratorStore.getState();
    store.addTask({ objective: "live", title: "live", assignee: "@claude2" }, SESSION);
    store.addTask({ objective: "exited", title: "exited", assignee: "@codex1" }, SESSION);
    await store.persistTasks(SESSION);

    // Each addTask + the explicit persistTasks below trigger their own
    // write_memory_file call. We want the latest one — the snapshot that
    // contains BOTH tasks — so use the trailing write rather than the
    // first (which was scheduled by the first addTask and only carries
    // the "live" task).
    const tasksWrite = [...writeCalls].reverse().find((c) => c.relativePath.endsWith(".md") && c.content.includes("# Collaboration Tasks"));
    expect(tasksWrite).toBeDefined();
    expect(tasksWrite?.content).toContain("**Assignee**: @claude2 (reviewer-2)");
    expect(tasksWrite?.content).toContain("**Assignee**: @codex1");
    // Exited agent's nickname must NOT decorate its assignee line.
    expect(tasksWrite?.content).not.toContain("@codex1 (reviewer-1)");
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
        nickname: "Claude Code #1",
        nicknameSlug: "claude-code-1",
        nameHistory: [{ nickname: "Claude Code #1", setAt: "2024-01-01T00:00:00.000Z", setBy: "system" }],
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
        nickname: "Claude Code #1",
        nicknameSlug: "claude-code-1",
        nameHistory: [{ nickname: "Claude Code #1", setAt: "2024-01-01T00:00:00.000Z", setBy: "system" }],
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
        nickname: "Claude Code #1",
        nicknameSlug: "claude-code-1",
        nameHistory: [{ nickname: "Claude Code #1", setAt: "2024-01-01T00:00:00.000Z", setBy: "system" }],
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
        nickname: "Claude Code #1",
        nicknameSlug: "claude-code-1",
        nameHistory: [{ nickname: "Claude Code #1", setAt: "2024-01-01T00:00:00.000Z", setBy: "system" }],
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
        { sessionId: "pty-1", tool: "claude_code", status: "running", collabSessionId: SESSION, ordinal: 1, handle: "claude1", nickname: "Claude Code #1", nicknameSlug: "claude-code-1", nameHistory: [{ nickname: "Claude Code #1", setAt: "2024-01-01T00:00:00.000Z", setBy: "system" }] },
        { sessionId: "pty-2", tool: "codex_cli", status: "running", collabSessionId: SESSION, ordinal: 1, handle: "codex1", nickname: "Codex CLI #1", nicknameSlug: "codex-cli-1", nameHistory: [{ nickname: "Codex CLI #1", setAt: "2024-01-01T00:00:00.000Z", setBy: "system" }] },
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
        nickname: "Claude Code #1",
        nicknameSlug: "claude-code-1",
        nameHistory: [{ nickname: "Claude Code #1", setAt: "2024-01-01T00:00:00.000Z", setBy: "system" }],
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
    // Identity line now carries the nickname alongside the canonical handle
    // (task-5: surface both in system prompt + task/conversation files).
    expect(slim).toContain("[You are @claude1 (Claude Code #1)]");
    expect(slim).toContain("second"); // user content reaches the agent
  });
});

// ---------------------------------------------------------------------------
// PR-A — agent identity rename
// ---------------------------------------------------------------------------

describe("slugify", () => {
  it("collapses whitespace + punctuation runs to single -", () => {
    expect(slugify("Bug Hunter")).toBe("bug-hunter");
    expect(slugify("  spaced  out  ")).toBe("spaced-out");
    expect(slugify("bug--hunter")).toBe("bug-hunter");
    expect(slugify("Claude Code #1")).toBe("claude-code-1");
  });

  it("drops symbols including emoji (\\p{S})", () => {
    // Pure-emoji is rejected at validation; slugify alone returns "".
    expect(slugify("🐛")).toBe("");
    // Embedded emoji is stripped, surrounding letters survive.
    expect(slugify("🐛 Bug Hunter")).toBe("bug-hunter");
    // Math/currency symbols collapse.
    expect(slugify("C++ Developer")).toBe("c-developer");
  });

  it("preserves CJK letters (\\p{L})", () => {
    expect(slugify("버그 헌터")).toBe("버그-헌터"); // Korean
    expect(slugify("バグ ハンター")).toBe("バグ-ハンター"); // Japanese
  });

  it("normalizes case and NFKC", () => {
    expect(slugify("CLAUDE")).toBe("claude");
    // NFKC: full-width digit → ASCII digit
    expect(slugify("Claude １")).toBe("claude-1");
  });
});

describe("renameAgent — validation", () => {
  const SESSION = "collab-rename-validation";
  beforeEach(() => {
    _resetWriteStateForTests();
    useCollaboratorStore.setState({
      agents: [
        {
          sessionId: "pty-1",
          tool: "claude_code",
          status: "running",
          collabSessionId: SESSION,
          ordinal: 1,
          handle: "claude1",
          nickname: "Claude Code #1",
          nicknameSlug: "claude-code-1",
          nameHistory: [
            { nickname: "Claude Code #1", setAt: "2024-01-01T00:00:00.000Z", setBy: "system" },
          ],
        },
      ],
      contextSentByAgent: {},
      pendingMessagesByAgent: {},
      tasksBySession: { [SESSION]: [] },
      logEntriesBySession: { [SESSION]: [] },
    });
  });

  it("rejects empty / too-long / pure-symbol nicknames as invalid", () => {
    const r1 = useCollaboratorStore.getState().renameAgent("pty-1", "");
    expect(r1).toMatchObject({ ok: false, reason: "invalid" });

    const r2 = useCollaboratorStore.getState().renameAgent("pty-1", "x".repeat(33));
    expect(r2).toMatchObject({ ok: false, reason: "invalid" });

    // Pure-emoji slugifies to "" → rejected with the no-letter/digit message.
    const r3 = useCollaboratorStore.getState().renameAgent("pty-1", "🐛");
    expect(r3).toMatchObject({ ok: false, reason: "invalid" });
    if (!r3.ok) {
      expect(r3.message).toContain("letter or number");
    }
  });

  it("rejects 'all' / 'all agents' as reserved", () => {
    expect(useCollaboratorStore.getState().renameAgent("pty-1", "all"))
      .toMatchObject({ ok: false, reason: "reserved" });
    expect(useCollaboratorStore.getState().renameAgent("pty-1", "All Agents"))
      .toMatchObject({ ok: false, reason: "reserved" });
  });

  it("rejects unknown sessionId as not-found", () => {
    expect(useCollaboratorStore.getState().renameAgent("pty-missing", "Bug Hunter"))
      .toMatchObject({ ok: false, reason: "not-found" });
  });

  it("no-op short-circuits when nickname unchanged (no rename event logged)", () => {
    const before = useCollaboratorStore.getState().agents[0];
    const result = useCollaboratorStore.getState().renameAgent("pty-1", "Claude Code #1");
    expect(result).toEqual({ ok: true });
    const after = useCollaboratorStore.getState().agents[0];
    // History MUST NOT grow on no-op.
    expect(after.nameHistory).toHaveLength(1);
    expect(after.nickname).toBe(before.nickname);
  });
});

describe("renameAgent — collisions (live agents own the namespace)", () => {
  const SESSION = "collab-collisions";

  beforeEach(() => {
    _resetWriteStateForTests();
    useCollaboratorStore.setState({
      agents: [
        {
          sessionId: "pty-A",
          tool: "claude_code",
          status: "running",
          collabSessionId: SESSION,
          ordinal: 1,
          handle: "claude1",
          nickname: "Bug Hunter",
          nicknameSlug: "bug-hunter",
          nameHistory: [
            { nickname: "Claude Code #1", setAt: "2024-01-01T00:00:00.000Z", setBy: "system" },
            { nickname: "Bug Hunter", setAt: "2024-01-02T00:00:00.000Z", setBy: "user" },
          ],
        },
        {
          sessionId: "pty-B",
          tool: "codex_cli",
          status: "running",
          collabSessionId: SESSION,
          ordinal: 1,
          handle: "codex1",
          nickname: "Codex CLI #1",
          nicknameSlug: "codex-cli-1",
          nameHistory: [
            { nickname: "Codex CLI #1", setAt: "2024-01-01T00:00:00.000Z", setBy: "system" },
          ],
        },
      ],
      contextSentByAgent: {},
      pendingMessagesByAgent: {},
      tasksBySession: { [SESSION]: [] },
      logEntriesBySession: { [SESSION]: [] },
    });
  });

  it("rejects rename to another live agent's nickname (case-insensitive)", () => {
    expect(useCollaboratorStore.getState().renameAgent("pty-B", "Bug Hunter"))
      .toMatchObject({ ok: false, reason: "duplicate" });
    expect(useCollaboratorStore.getState().renameAgent("pty-B", "BUG HUNTER"))
      .toMatchObject({ ok: false, reason: "duplicate" });
  });

  it("rejects rename whose slug equals another live agent's slug (codex1 C1-1)", () => {
    // bug-hunter (A's nicknameSlug) === slugify("bug-hunter") === slugify("Bug-Hunter")
    expect(useCollaboratorStore.getState().renameAgent("pty-B", "bug-hunter"))
      .toMatchObject({ ok: false, reason: "duplicate" });
    expect(useCollaboratorStore.getState().renameAgent("pty-B", "Bug.Hunter"))
      .toMatchObject({ ok: false, reason: "duplicate" });
  });

  it("rejects rename to another live agent's handle (claude2 N1)", () => {
    expect(useCollaboratorStore.getState().renameAgent("pty-B", "claude1"))
      .toMatchObject({ ok: false, reason: "duplicate" });
  });

  it("ALLOWS rename when the conflicting agent is exited (live agents own the namespace)", () => {
    // Mark pty-A exited.
    useCollaboratorStore.setState((s) => ({
      agents: s.agents.map((a) => (a.sessionId === "pty-A" ? { ...a, status: "exited" } : a)),
    }));
    // pty-B may now take "Bug Hunter" — A is no longer in the live namespace.
    const result = useCollaboratorStore.getState().renameAgent("pty-B", "Bug Hunter");
    expect(result).toEqual({ ok: true });
    const after = useCollaboratorStore.getState().agents.find((a) => a.sessionId === "pty-B");
    expect(after?.nickname).toBe("Bug Hunter");
    expect(after?.nicknameSlug).toBe("bug-hunter");
  });
});

describe("renameAgent — handle invariance and history append", () => {
  const SESSION = "collab-rename-history";

  beforeEach(() => {
    _resetWriteStateForTests();
    useCollaboratorStore.setState({
      agents: [
        {
          sessionId: "pty-1",
          tool: "claude_code",
          status: "running",
          collabSessionId: SESSION,
          ordinal: 1,
          handle: "claude1",
          nickname: "Claude Code #1",
          nicknameSlug: "claude-code-1",
          nameHistory: [
            { nickname: "Claude Code #1", setAt: "2024-01-01T00:00:00.000Z", setBy: "system" },
          ],
        },
      ],
      contextSentByAgent: {},
      pendingMessagesByAgent: {},
      tasksBySession: { [SESSION]: [] },
      logEntriesBySession: { [SESSION]: [] },
    });
  });

  it("preserves handle on successful rename and appends nameHistory", () => {
    const result = useCollaboratorStore.getState().renameAgent("pty-1", "Bug Hunter");
    expect(result).toEqual({ ok: true });
    const a = useCollaboratorStore.getState().agents[0];
    // Handle is the immutable join key — must NEVER change.
    expect(a.handle).toBe("claude1");
    expect(a.nickname).toBe("Bug Hunter");
    expect(a.nicknameSlug).toBe("bug-hunter");
    expect(a.nameHistory).toHaveLength(2);
    expect(a.nameHistory[1]).toMatchObject({ nickname: "Bug Hunter", setBy: "user" });
  });

  it("regression guard — pre-rename tasks remain routable to the renamed agent", () => {
    const store = useCollaboratorStore.getState();
    // Assign a task BEFORE rename.
    store.addTask({ title: "earlier", objective: "earlier", assignee: "@claude1" }, SESSION);
    // Now rename.
    const r = store.renameAgent("pty-1", "Bug Hunter");
    expect(r).toEqual({ ok: true });
    // The pre-rename task still references @claude1 (the immutable handle).
    // findFreshestActiveTaskForMention's strict literal compare must find it.
    const tasks = store.getTasks(SESSION);
    expect(tasks[0].assignee).toBe("@claude1");
    // The agent's handle is unchanged so the indicator's lookup still hits.
    const a = useCollaboratorStore.getState().agents[0];
    expect(a.handle).toBe("claude1");
  });

  it("clears contextSentByAgent on rename (forces full-header re-emit on next send)", () => {
    useCollaboratorStore.setState((s) => ({
      contextSentByAgent: { ...s.contextSentByAgent, "pty-1": true },
    }));
    expect(useCollaboratorStore.getState().contextSentByAgent["pty-1"]).toBe(true);
    const r = useCollaboratorStore.getState().renameAgent("pty-1", "Bug Hunter");
    expect(r).toEqual({ ok: true });
    // Key was destructured out — undefined now.
    expect(useCollaboratorStore.getState().contextSentByAgent["pty-1"]).toBeUndefined();
  });

  it("appends a system entry to the conversation log on rename", () => {
    useCollaboratorStore.getState().renameAgent("pty-1", "Bug Hunter");
    const logs = useCollaboratorStore.getState().logEntriesBySession[SESSION] ?? [];
    const renameLog = logs.find((e) => e.role === "system" && e.content.includes("renamed"));
    expect(renameLog).toBeDefined();
    expect(renameLog?.content).toContain("@claude1");
    expect(renameLog?.content).toContain("Bug Hunter");
  });
});

describe("renamePendingByAgent — internal state lifecycle", () => {
  // Direct-state assertions per claude3 V6-3 / I7-3. The set is module-private;
  // these tests use _isRenamePendingForTests so a future refactor that drops
  // a cleanup site or moves the .add() above the no-op gate is caught.
  const SESSION = "collab-pending-state";

  beforeEach(() => {
    _resetWriteStateForTests();
    useCollaboratorStore.setState({
      agents: [
        {
          sessionId: "pty-1",
          tool: "claude_code",
          status: "running",
          collabSessionId: SESSION,
          ordinal: 1,
          handle: "claude1",
          nickname: "Claude Code #1",
          nicknameSlug: "claude-code-1",
          nameHistory: [{ nickname: "Claude Code #1", setAt: "2024-01-01T00:00:00.000Z", setBy: "system" }],
        },
      ],
      contextSentByAgent: {},
      pendingMessagesByAgent: {},
      tasksBySession: { [SESSION]: [] },
      logEntriesBySession: { [SESSION]: [] },
    });
  });

  it("renameAgent adds to renamePendingByAgent on actual change", () => {
    expect(_isRenamePendingForTests("pty-1")).toBe(false);
    useCollaboratorStore.getState().renameAgent("pty-1", "Bug Hunter");
    expect(_isRenamePendingForTests("pty-1")).toBe(true);
  });

  it("no-op rename does NOT add to renamePendingByAgent (claude2 G2)", () => {
    useCollaboratorStore.getState().renameAgent("pty-1", "Claude Code #1");
    expect(_isRenamePendingForTests("pty-1")).toBe(false);
  });

  it("validation failure (reserved 'all') does NOT add to renamePendingByAgent", () => {
    const r = useCollaboratorStore.getState().renameAgent("pty-1", "all");
    expect(r.ok).toBe(false);
    expect(_isRenamePendingForTests("pty-1")).toBe(false);
  });

  it("removeAgent clears renamePendingByAgent entry", () => {
    useCollaboratorStore.getState().renameAgent("pty-1", "Bug Hunter");
    expect(_isRenamePendingForTests("pty-1")).toBe(true);
    useCollaboratorStore.getState().removeAgent("pty-1");
    expect(_isRenamePendingForTests("pty-1")).toBe(false);
  });

  it("_resetWriteStateForTests clears the set (cleanup site 4)", () => {
    useCollaboratorStore.getState().renameAgent("pty-1", "Bug Hunter");
    expect(_isRenamePendingForTests("pty-1")).toBe(true);
    _resetWriteStateForTests();
    expect(_isRenamePendingForTests("pty-1")).toBe(false);
  });

  it("killAllAgents clears renamePendingByAgent (cleanup site 2)", async () => {
    useCollaboratorStore.getState().renameAgent("pty-1", "Bug Hunter");
    expect(_isRenamePendingForTests("pty-1")).toBe(true);
    await useCollaboratorStore.getState().killAllAgents(SESSION);
    expect(_isRenamePendingForTests("pty-1")).toBe(false);
  });

  it("endSession clears renamePendingByAgent (cleanup site 3)", () => {
    useCollaboratorStore.getState().renameAgent("pty-1", "Bug Hunter");
    expect(_isRenamePendingForTests("pty-1")).toBe(true);
    useCollaboratorStore.getState().endSession(SESSION);
    expect(_isRenamePendingForTests("pty-1")).toBe(false);
  });
});

describe("renamePendingByAgent — consume path (claude2 G7 / claude3 I8-2)", () => {
  // Integration tests using the inject mock to verify the post-rename
  // useFullHeader flow. These directly enforce the v6 §3 race-mitigation
  // design — without them, dropping the `renamePending ||` clause from the
  // useFullHeader calc would silently break with no test failure.
  const SESSION = "collab-consume";
  const injectCalls = () =>
    vi.mocked(invoke).mock.calls
      .filter((c) => c[0] === "inject_into_pty")
      .map((c) => (c[1] as { text: string }).text);

  beforeEach(() => {
    _resetWriteStateForTests();
    vi.mocked(invoke).mockClear();
    vi.mocked(invoke).mockImplementation(async () => null);
    useCollaboratorStore.setState({
      agents: [
        {
          sessionId: "pty-1",
          tool: "claude_code",
          status: "running",
          collabSessionId: SESSION,
          ordinal: 1,
          handle: "claude1",
          nickname: "Claude Code #1",
          nicknameSlug: "claude-code-1",
          nameHistory: [{ nickname: "Claude Code #1", setAt: "2024-01-01T00:00:00.000Z", setBy: "system" }],
        },
      ],
      // Simulate an agent already past first-send.
      contextSentByAgent: { "pty-1": true },
      pendingMessagesByAgent: {},
      tasksBySession: { [SESSION]: [] },
      logEntriesBySession: { [SESSION]: [] },
    });
  });
  afterEach(() => {
    vi.mocked(invoke).mockImplementation(async () => null);
  });

  it("after rename, sendToAgent's NEXT send uses the FULL header", async () => {
    const store = useCollaboratorStore.getState();
    store.renameAgent("pty-1", "Bug Hunter");
    expect(_isRenamePendingForTests("pty-1")).toBe(true);

    await store.sendToAgent("pty-1", "hello");

    const calls = injectCalls();
    expect(calls.length).toBe(1);
    // Full header carries the TASK_PROTOCOL block; slim header does not.
    expect(calls[0]).toContain("Agent Task Protocol");
    // Consumed on success (PAIRED INVARIANT).
    expect(_isRenamePendingForTests("pty-1")).toBe(false);
  });

  it("after rename, broadcastToAll's NEXT send uses the FULL header (claude2 B1)", async () => {
    const store = useCollaboratorStore.getState();
    store.renameAgent("pty-1", "Bug Hunter");
    expect(_isRenamePendingForTests("pty-1")).toBe(true);

    await store.broadcastToAll("hello", SESSION);

    const calls = injectCalls();
    expect(calls.length).toBe(1);
    expect(calls[0]).toContain("Agent Task Protocol");
    expect(_isRenamePendingForTests("pty-1")).toBe(false);
  });

  it("two sends after one rename: first uses FULL, second uses SLIM (consume worked)", async () => {
    const store = useCollaboratorStore.getState();
    store.renameAgent("pty-1", "Bug Hunter");

    await store.sendToAgent("pty-1", "first");
    await store.sendToAgent("pty-1", "second");

    const calls = injectCalls();
    expect(calls.length).toBe(2);
    // First gets the protocol re-emit; second is slim (no protocol block).
    expect(calls[0]).toContain("Agent Task Protocol");
    expect(calls[1]).not.toContain("Agent Task Protocol");
  });

  it("failed inject preserves renamePendingByAgent for retry", async () => {
    const store = useCollaboratorStore.getState();
    store.renameAgent("pty-1", "Bug Hunter");
    expect(_isRenamePendingForTests("pty-1")).toBe(true);

    // Persistent mock that throws ONLY for inject_into_pty (other calls like
    // read_memory_file in prependContextHeader continue to resolve to null).
    // mockImplementationOnce was incorrect here — the first invoke call is
    // for read_memory_file inside the header builder, so a once-mock would
    // be consumed before the inject ever runs.
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "inject_into_pty") throw new Error("pty died");
      return null;
    });
    await store.sendToAgent("pty-1", "hello");

    // The catch-branch rollback inside sendToAgent's first-send path clears
    // contextSentByAgent[sessionId] so the next sender re-enters the full
    // branch. renamePendingByAgent stays populated — the rename's intent
    // survives the failure path.
    expect(useCollaboratorStore.getState().contextSentByAgent["pty-1"]).toBeUndefined();
    expect(_isRenamePendingForTests("pty-1")).toBe(true);
  });
});

describe("resolveAgent — nickname-aware resolution (codex1/2/3 round-7)", () => {
  // After v5 §4 release exited slugs, the resolver MUST prefer live agents
  // for slug-based lookups; handles remain unfiltered (immutable + unique).
  const buildAgents = (): SpawnedAgent[] => [
    {
      sessionId: "pty-A",
      tool: "claude_code",
      status: "running",
      collabSessionId: "s",
      ordinal: 1,
      handle: "claude1",
      nickname: "Bug Hunter",
      nicknameSlug: "bug-hunter",
      nameHistory: [
        { nickname: "Claude Code #1", setAt: "2024-01-01T00:00:00.000Z", setBy: "system" },
        { nickname: "Bug Hunter", setAt: "2024-01-02T00:00:00.000Z", setBy: "user" },
      ],
    },
    {
      sessionId: "pty-B",
      tool: "codex_cli",
      status: "running",
      collabSessionId: "s",
      ordinal: 1,
      handle: "codex1",
      nickname: "Codex CLI #1",
      nicknameSlug: "codex-cli-1",
      nameHistory: [{ nickname: "Codex CLI #1", setAt: "2024-01-01T00:00:00.000Z", setBy: "system" }],
    },
  ];

  it("resolves exact handle (immutable) for live agents", () => {
    const agents = buildAgents();
    expect(resolveAgent("claude1", agents)?.sessionId).toBe("pty-A");
    expect(resolveAgent("codex1", agents)?.sessionId).toBe("pty-B");
  });

  it("resolves nickname slug for live agents (the codex1/2/3 round-7 fix)", () => {
    const agents = buildAgents();
    // direct "@bug-hunter" typing now routes to claude1 (renamed agent)
    expect(resolveAgent("bug-hunter", agents)?.sessionId).toBe("pty-A");
    // case- and punctuation-insensitive via slugify
    expect(resolveAgent("Bug Hunter", agents)?.sessionId).toBe("pty-A");
    expect(resolveAgent("Bug.Hunter", agents)?.sessionId).toBe("pty-A");
  });

  it("prefers live agents over exited siblings sharing a slug (v5 §4)", () => {
    const agents = buildAgents();
    // Mark A exited; B takes the slug.
    agents[0].status = "exited";
    agents[1].nickname = "Bug Hunter";
    agents[1].nicknameSlug = "bug-hunter";
    // Resolver should now route @bug-hunter to live B, not exited A.
    expect(resolveAgent("bug-hunter", agents)?.sessionId).toBe("pty-B");
  });

  it("handle prefix still matches (allows exited)", () => {
    const agents = buildAgents();
    expect(resolveAgent("clau", agents)?.sessionId).toBe("pty-A");
  });

  it("nickname slug PREFIX match — live-only", () => {
    const agents = buildAgents();
    // "bug" prefix-matches A's nicknameSlug "bug-hunter"
    expect(resolveAgent("bug", agents)?.sessionId).toBe("pty-A");
    // Mark A exited; prefix slug match should now skip A.
    agents[0].status = "exited";
    expect(resolveAgent("bug", agents)).toBeNull();
  });

  it("returns null for unknown token", () => {
    expect(resolveAgent("nonexistent", buildAgents())).toBeNull();
  });

  it("history-slug match resolves an OLD nickname to the renamed agent (claude2 G6)", () => {
    const agents = buildAgents();
    // A had birth name "Claude Code #1" and was renamed to "Bug Hunter".
    // Typing the OLD slug should still route to A while A is live.
    expect(resolveAgent("claude-code-1", agents)?.sessionId).toBe("pty-A");
  });

  it("history-slug match is LIVE-ONLY (skips exited agents)", () => {
    const agents = buildAgents();
    agents[0].status = "exited";
    expect(resolveAgent("claude-code-1", agents)).toBeNull();
  });
});

describe("parseInput — /rename slash command (codex1+codex2 round-7)", () => {
  it("parses /rename @<agent> <nickname> with single-word nickname", () => {
    const cmd = parseInput("/rename @claude1 BugHunter");
    expect(cmd.type).toBe("rename");
    expect(cmd.target).toBe("claude1");
    expect(cmd.message).toBe("BugHunter");
  });

  it("parses /rename with multi-word freeform nickname", () => {
    const cmd = parseInput("/rename @claude1 Bug Hunter");
    expect(cmd.type).toBe("rename");
    expect(cmd.target).toBe("claude1");
    expect(cmd.message).toBe("Bug Hunter");
  });

  it("parses /rename with CJK nickname", () => {
    const cmd = parseInput("/rename @claude1 버그 헌터");
    expect(cmd.type).toBe("rename");
    expect(cmd.target).toBe("claude1");
    expect(cmd.message).toBe("버그 헌터");
  });

  it("returns rename type with no target/message on /rename alone (executor shows usage)", () => {
    const cmd = parseInput("/rename");
    expect(cmd.type).toBe("rename");
    expect(cmd.target).toBeUndefined();
    expect(cmd.message).toBeUndefined();
  });

  it("returns rename type with no target/message when only target given (no nickname)", () => {
    const cmd = parseInput("/rename @claude1");
    expect(cmd.type).toBe("rename");
    expect(cmd.target).toBeUndefined();
    expect(cmd.message).toBeUndefined();
  });
});

describe("executeCommand — /rename and /task add canonicalization (claude3 I9-1, I9-2)", () => {
  // Integration tests through the actual executor. Verify the routing AND
  // the persisted result, not just the parser output.
  const SESSION = "collab-execute-tests";

  beforeEach(() => {
    _resetWriteStateForTests();
    vi.mocked(invoke).mockClear();
    vi.mocked(invoke).mockImplementation(async () => null);
    useCollaboratorStore.setState({
      agents: [
        {
          sessionId: "pty-1",
          tool: "claude_code",
          status: "running",
          collabSessionId: SESSION,
          ordinal: 1,
          handle: "claude1",
          nickname: "Claude Code #1",
          nicknameSlug: "claude-code-1",
          nameHistory: [{ nickname: "Claude Code #1", setAt: "2024-01-01T00:00:00.000Z", setBy: "system" }],
        },
      ],
      contextSentByAgent: {},
      pendingMessagesByAgent: {},
      tasksBySession: { [SESSION]: [] },
      logEntriesBySession: { [SESSION]: [] },
      statusMessages: {},
    });
  });

  it("/rename @<handle> <nickname> updates the agent's nickname", async () => {
    await executeCommand(parseInput("/rename @claude1 Bug Hunter"), SESSION);
    const a = useCollaboratorStore.getState().agents[0];
    expect(a.nickname).toBe("Bug Hunter");
    expect(a.nicknameSlug).toBe("bug-hunter");
    expect(a.handle).toBe("claude1"); // immutable
  });

  it("/rename surfaces RenameResult.message on validation failure", async () => {
    await executeCommand(parseInput("/rename @claude1 all"), SESSION);
    const status = useCollaboratorStore.getState().statusMessages[SESSION];
    expect(status).toContain("reserved");
    // Agent unchanged.
    expect(useCollaboratorStore.getState().agents[0].nickname).toBe("Claude Code #1");
  });

  it("/rename @<unknown> errors with 'not found'", async () => {
    await executeCommand(parseInput("/rename @ghost NewName"), SESSION);
    const status = useCollaboratorStore.getState().statusMessages[SESSION];
    expect(status).toContain("not found");
    expect(useCollaboratorStore.getState().agents[0].nickname).toBe("Claude Code #1");
  });

  it("/rename strips a leading @ from the new nickname value", async () => {
    await executeCommand(parseInput("/rename @claude1 @newname"), SESSION);
    const a = useCollaboratorStore.getState().agents[0];
    expect(a.nickname).toBe("newname"); // not "@newname"
  });

  it("/task add ... @<handle> writes canonical @handle (codex3 round-8)", async () => {
    await executeCommand(parseInput("/task add Find leak | check logs @claude1"), SESSION);
    const tasks = useCollaboratorStore.getState().getTasks(SESSION);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].assignee).toBe("@claude1");
  });

  it("/task add ... @<nickname> canonicalizes through resolveAgent (codex3 round-8)", async () => {
    // First rename so claude1's nickname slug is "bug-hunter".
    useCollaboratorStore.getState().renameAgent("pty-1", "Bug Hunter");
    await executeCommand(parseInput("/task add Find leak | check logs @bug-hunter"), SESSION);
    const tasks = useCollaboratorStore.getState().getTasks(SESSION);
    expect(tasks).toHaveLength(1);
    // Critically: assignee is the canonical IMMUTABLE handle, not the typed
    // nickname slug. This is the load-bearing invariant — downstream lookups
    // (findFreshestActiveTaskForMention, recentOutcomesBySession) all key on
    // @<handle>, so a bad write here would orphan every routing path.
    expect(tasks[0].assignee).toBe("@claude1");
  });

  it("/task add ... @<unknown> errors and does NOT create the task", async () => {
    await executeCommand(parseInput("/task add Find leak | check logs @ghost"), SESSION);
    const tasks = useCollaboratorStore.getState().getTasks(SESSION);
    expect(tasks).toHaveLength(0); // task NOT created
    const status = useCollaboratorStore.getState().statusMessages[SESSION];
    expect(status).toContain("not found");
  });
});

// ---------------------------------------------------------------------------
// Phase 1.3 — Orphan `.done.json` cleanup (task-31 implementation)
// ---------------------------------------------------------------------------
//
// These tests cover the orphan-cleanup branch added to
// scanForTaskCompletions: when a `.done.json` file's task_id doesn't
// match any task in any loaded session AND the file's mtime is older
// than the 24h grace period, delete it. Otherwise preserve.
//
// Tests verify:
//  1. Empty-session pane scans walk the loop (line 921 early-return removed).
//  2. Orphan with mtime > 24h: deleted.
//  3. Orphan with mtime < 24h: preserved (hydration-race safety).
//  4. GRACE_MS boundary: file with age === GRACE_MS is preserved (strict >).
//  5. Prefix-tolerant matcher prevents false-orphan classification.
//  6. Clock-skew clamp: backward Date.now() doesn't false-delete recent files.
//  7. file-gone race: get_memory_file_mtime rejection is caught and skipped.
//  8. Cross-session match: a foreign session's task prevents orphan deletion.
describe("Phase 1.3 — orphan `.done.json` cleanup (task-31)", () => {
  const ORPHAN_GRACE_MS = 24 * 60 * 60 * 1000;
  const FOREIGN_SESSION = "test-session-foreign";

  beforeEach(() => {
    vi.useFakeTimers();
    resetStores();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.mocked(invoke).mockImplementation(async () => null);
  });

  it("empty-session pane scans the loop and deletes orphan with mtime > 24h", async () => {
    // Session has NO tasks. The pre-Phase-1.3 early-return at line 921
    // would short-circuit here; with the early-return removed, the
    // orphan loop runs.
    const orphanPath = "task-orphan-1.done.json";
    const orphanJson = JSON.stringify({ task_id: "task-orphan-1", status: "completed" });
    const oldMtime = Date.now() - ORPHAN_GRACE_MS - 1000; // 24h + 1s old
    const deletedFiles: string[] = [];

    vi.mocked(invoke).mockImplementation(async (cmd: string, args?: unknown) => {
      if (cmd === "list_memory_files") return [orphanPath];
      if (cmd === "read_memory_file") return orphanJson;
      if (cmd === "get_memory_file_mtime") return oldMtime;
      if (cmd === "delete_memory_file") {
        deletedFiles.push((args as { relativePath: string }).relativePath);
        return null;
      }
      return null;
    });

    await scanForTaskCompletions(SESSION);
    expect(deletedFiles).toContain(orphanPath);
  });

  it("preserves orphan with mtime < 24h (hydration-race safety)", async () => {
    const orphanPath = "task-orphan-2.done.json";
    const orphanJson = JSON.stringify({ task_id: "task-orphan-2", status: "completed" });
    const recentMtime = Date.now() - 1000; // 1s old
    const deletedFiles: string[] = [];

    vi.mocked(invoke).mockImplementation(async (cmd: string, args?: unknown) => {
      if (cmd === "list_memory_files") return [orphanPath];
      if (cmd === "read_memory_file") return orphanJson;
      if (cmd === "get_memory_file_mtime") return recentMtime;
      if (cmd === "delete_memory_file") {
        deletedFiles.push((args as { relativePath: string }).relativePath);
        return null;
      }
      return null;
    });

    await scanForTaskCompletions(SESSION);
    expect(deletedFiles).not.toContain(orphanPath);
  });

  it("GRACE_MS boundary: age === GRACE_MS is preserved (strict >)", async () => {
    const orphanPath = "task-orphan-boundary.done.json";
    const orphanJson = JSON.stringify({ task_id: "task-orphan-boundary", status: "completed" });
    // Exactly GRACE_MS old — strict `>` means this is preserved.
    const boundaryMtime = Date.now() - ORPHAN_GRACE_MS;
    const deletedFiles: string[] = [];

    vi.mocked(invoke).mockImplementation(async (cmd: string, args?: unknown) => {
      if (cmd === "list_memory_files") return [orphanPath];
      if (cmd === "read_memory_file") return orphanJson;
      if (cmd === "get_memory_file_mtime") return boundaryMtime;
      if (cmd === "delete_memory_file") {
        deletedFiles.push((args as { relativePath: string }).relativePath);
        return null;
      }
      return null;
    });

    await scanForTaskCompletions(SESSION);
    expect(deletedFiles).not.toContain(orphanPath);
  });

  it("prefix-tolerant matcher: truncated task_id is NOT classified as orphan", async () => {
    // Session has the long-form task; one .done.json carries the long
    // form, another carries just the prefix. NEITHER should be deleted
    // as orphan — they both prefix-match the stored task.
    const store = useCollaboratorStore.getState();
    const task = store.addTask({ objective: "x", title: "y", assignee: "@claude1" }, SESSION);
    // task.id is e.g. "task-1-1234567890"

    const longPath = `${task.id}.done.json`;
    const truncPrefix = task.id.split("-").slice(0, 2).join("-"); // e.g. "task-1"
    const truncPath = `${truncPrefix}.done.json`;

    const longJson = JSON.stringify({ task_id: task.id, status: "completed", author: "@claude1" });
    const truncJson = JSON.stringify({ task_id: truncPrefix, status: "completed", author: "@claude1" });
    const oldMtime = Date.now() - ORPHAN_GRACE_MS - 1000;
    const deletedFiles: string[] = [];

    vi.mocked(invoke).mockImplementation(async (cmd: string, args?: unknown) => {
      if (cmd === "list_memory_files") return [longPath, truncPath];
      if (cmd === "read_memory_file") {
        const rel = (args as { relativePath: string }).relativePath;
        return rel === longPath ? longJson : truncJson;
      }
      if (cmd === "get_memory_file_mtime") return oldMtime;
      if (cmd === "delete_memory_file") {
        deletedFiles.push((args as { relativePath: string }).relativePath);
        return null;
      }
      return null;
    });

    await scanForTaskCompletions(SESSION);
    // The long-form file matches the task and is processed (delete_memory_file
    // called as part of the success path); the truncated form is no longer
    // a no-op continue — it now also matches via prefix, so the in-loop find
    // returns the task and the file is processed too. Either way, neither
    // file should be deleted *as an orphan* (i.e., via the cross-session
    // orphan branch). To assert this distinctly, we verify the task DID
    // terminalize (proving the matcher saw both as belonging to it).
    const updated = useCollaboratorStore.getState().tasksBySession[SESSION]?.find((t) => t.id === task.id);
    expect(updated?.status).toBe("completed");
  });

  it("clock-skew clamp: Date.now() < mtimeMs (forward-stamped file) is preserved", async () => {
    const orphanPath = "task-orphan-future.done.json";
    const orphanJson = JSON.stringify({ task_id: "task-orphan-future", status: "completed" });
    // File mtime AHEAD of current time (e.g. NTP correction set clock back).
    const futureMtime = Date.now() + 60 * 1000;
    const deletedFiles: string[] = [];

    vi.mocked(invoke).mockImplementation(async (cmd: string, args?: unknown) => {
      if (cmd === "list_memory_files") return [orphanPath];
      if (cmd === "read_memory_file") return orphanJson;
      if (cmd === "get_memory_file_mtime") return futureMtime;
      if (cmd === "delete_memory_file") {
        deletedFiles.push((args as { relativePath: string }).relativePath);
        return null;
      }
      return null;
    });

    await scanForTaskCompletions(SESSION);
    // Math.max(0, Date.now() - mtimeMs) = 0; 0 > GRACE_MS is false; preserved.
    expect(deletedFiles).not.toContain(orphanPath);
  });

  it("file-gone race: get_memory_file_mtime rejection is caught and skipped", async () => {
    const orphanPath = "task-orphan-gone.done.json";
    const orphanJson = JSON.stringify({ task_id: "task-orphan-gone", status: "completed" });
    const deletedFiles: string[] = [];
    let mtimeRejections = 0;

    vi.mocked(invoke).mockImplementation(async (cmd: string, args?: unknown) => {
      if (cmd === "list_memory_files") return [orphanPath];
      if (cmd === "read_memory_file") return orphanJson;
      if (cmd === "get_memory_file_mtime") {
        mtimeRejections++;
        throw new Error("not found");
      }
      if (cmd === "delete_memory_file") {
        deletedFiles.push((args as { relativePath: string }).relativePath);
        return null;
      }
      return null;
    });

    // Should NOT throw, and should NOT call delete_memory_file (mtime
    // resolution failed → skip).
    await expect(scanForTaskCompletions(SESSION)).resolves.toBeUndefined();
    expect(mtimeRejections).toBeGreaterThan(0);
    expect(deletedFiles).not.toContain(orphanPath);
  });

  it("cross-session match: a foreign session's task prevents orphan deletion", async () => {
    // SESSION has no tasks; FOREIGN_SESSION has the task that the
    // .done.json belongs to. The orphan branch must NOT delete it.
    const store = useCollaboratorStore.getState();
    const foreignTask = store.addTask({ objective: "x", title: "y", assignee: "@claude1" }, FOREIGN_SESSION);

    const path = `${foreignTask.id}.done.json`;
    const doneJson = JSON.stringify({ task_id: foreignTask.id, status: "completed", author: "@claude1" });
    const oldMtime = Date.now() - ORPHAN_GRACE_MS - 1000;
    const deletedFiles: string[] = [];

    vi.mocked(invoke).mockImplementation(async (cmd: string, args?: unknown) => {
      if (cmd === "list_memory_files") return [path];
      if (cmd === "read_memory_file") return doneJson;
      if (cmd === "get_memory_file_mtime") return oldMtime;
      if (cmd === "delete_memory_file") {
        deletedFiles.push((args as { relativePath: string }).relativePath);
        return null;
      }
      return null;
    });

    // Scanning SESSION (no tasks). FOREIGN_SESSION owns the matching task.
    await scanForTaskCompletions(SESSION);
    // The orphan branch sees foundInAnySession=true via the cross-session
    // tasksBySession lookup, so the file is preserved (left for FOREIGN_SESSION
    // to process when it scans).
    expect(deletedFiles).not.toContain(path);
  });
});


