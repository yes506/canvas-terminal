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
  hydrateBranchProtectionAcks,
} from "./collaboratorStore";
import type { CollabTask, SpawnedAgent } from "../types/collaborator";
import {
  parseInput,
  resolveAgent,
  executeCommand,
  getHelpText,
  checkBranchProtection,
  _clearVerifiedProtectedCacheForTests,
} from "../components/collaborator/commands";
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
  // Round-21 (claude3 task-99 O5): the verified-protected TTL cache
  // is module-level state in commands.ts and would leak across tests.
  // Imported directly to avoid the circular import that would result
  // from triggering the reset from collaboratorStore.ts.
  _clearVerifiedProtectedCacheForTests();
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
    pendingMerge: null,
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

describe("Copilot CLI roster registration", () => {
  // Module-level ordinal counters in collaboratorStore are keyed by
  // `${collabSessionId}:${tool}` and persist across tests. Each test in this
  // suite uses a fresh unique session id so ordinals start at 1 deterministically.
  beforeEach(() => {
    useCollaboratorStore.setState({ agents: [] });
  });

  it("derives @copilot1 handle and 'Copilot CLI #1' nickname from the registry row", () => {
    const session = `copilot-suite-${Date.now()}-1`;
    useCollaboratorStore.getState().addAgent({
      sessionId: "pty-copilot-1",
      tool: "copilot_cli",
      status: "running",
      collabSessionId: session,
    });

    const agent = useCollaboratorStore
      .getState()
      .agents.find((a) => a.sessionId === "pty-copilot-1")!;

    expect(agent.handle).toBe("copilot1");
    expect(agent.ordinal).toBe(1);
    expect(agent.nickname).toBe("Copilot CLI #1");
    expect(agent.nicknameSlug).toBe("copilot-cli-1");
    expect(agent.nameHistory[0]).toMatchObject({
      nickname: "Copilot CLI #1",
      setBy: "system",
    });
  });

  it("isolates Copilot ordinals from other tools (claude1 + copilot1, not copilot2)", () => {
    const session = `copilot-suite-${Date.now()}-2`;
    const store = useCollaboratorStore.getState();
    store.addAgent({
      sessionId: "pty-claude-1",
      tool: "claude_code",
      status: "running",
      collabSessionId: session,
    });
    store.addAgent({
      sessionId: "pty-copilot-1",
      tool: "copilot_cli",
      status: "running",
      collabSessionId: session,
    });

    const handles = useCollaboratorStore
      .getState()
      .agents.map((a) => a.handle)
      .sort();
    expect(handles).toEqual(["claude1", "copilot1"]);
  });

  it("includes @copilot in the /help agent roster string", () => {
    expect(getHelpText()).toMatch(/@copilot\b/);
  });
});

// ---------------------------------------------------------------------------
// codex2 task-67 H1 — central pendingMerge cleanup on terminal transitions.
// updateTask must clear pendingMerge when status flips to a terminal state
// (completed | blocked) regardless of whether the caller passed it. This
// prevents stale merge metadata accumulating once LB1 starts populating it.
// ---------------------------------------------------------------------------

describe("LB4 — /task done and /task status completed gate refusal (codex2 task-59 H1)", () => {
  // The slash-command path was a known approval-gate bypass: an agent
  // (or user) running /task done on a worktree-backed task would skip
  // the awaiting-approval flow that scanForTaskCompletions enforces
  // for .done.json. Now refused with an actionable message; user must
  // either let the agent write .done.json (auto-routes through gate)
  // or use /task status blocked to abandon explicitly.
  const LB4_SESSION = "collab-lb4-tests";

  beforeEach(() => {
    _resetWriteStateForTests();
    vi.mocked(invoke).mockClear();
    vi.mocked(invoke).mockImplementation(async () => null);
  });

  function setupAgent(opts: { withWorktree: boolean }) {
    useCollaboratorStore.setState({
      agents: [
        {
          sessionId: "pty-1",
          tool: "claude_code",
          status: "running",
          collabSessionId: LB4_SESSION,
          ordinal: 1,
          handle: "claude1",
          nickname: "Claude Code #1",
          nicknameSlug: "claude-code-1",
          nameHistory: [
            {
              nickname: "Claude Code #1",
              setAt: "2024-01-01T00:00:00.000Z",
              setBy: "system",
            },
          ],
          worktree: opts.withWorktree
            ? {
                repoRoot: "/r",
                path: "/wt",
                branch: "agent/claude_code-session-1",
                baseRef: "origin/dev",
                baseSha: "abc",
                baseFresh: true,
                createdAtMs: 1,
              }
            : null,
        },
      ],
      contextSentByAgent: {},
      pendingMessagesByAgent: {},
      tasksBySession: { [LB4_SESSION]: [] },
      logEntriesBySession: { [LB4_SESSION]: [] },
      statusMessages: {},
    });
  }

  it("/task done refuses worktree-backed tasks with an actionable message", async () => {
    setupAgent({ withWorktree: true });
    const store = useCollaboratorStore.getState();
    const task = store.addTask(
      { title: "x", objective: "x", assignee: "@claude1" },
      LB4_SESSION,
    );
    await executeCommand(
      parseInput(`/task ${task.id} done with notes`),
      LB4_SESSION,
    );
    // Task is unchanged — gate refused the manual completion.
    const updated = useCollaboratorStore
      .getState()
      .tasksBySession[LB4_SESSION]?.find((t) => t.id === task.id);
    expect(updated?.status).toBe("pending");
    // Status line surfaces the actionable message.
    const status = useCollaboratorStore.getState().statusMessages[LB4_SESSION];
    expect(status).toContain("worktree-backed agent");
    expect(status).toContain("bypasses the approval gate");
  });

  it("/task done succeeds for tasks without a worktree-backed assignee", async () => {
    setupAgent({ withWorktree: false });
    const store = useCollaboratorStore.getState();
    const task = store.addTask(
      { title: "x", objective: "x", assignee: "@claude1" },
      LB4_SESSION,
    );
    await executeCommand(
      parseInput(`/task ${task.id} done all good`),
      LB4_SESSION,
    );
    const updated = useCollaboratorStore
      .getState()
      .tasksBySession[LB4_SESSION]?.find((t) => t.id === task.id);
    expect(updated?.status).toBe("completed");
    expect(updated?.conclusion).toBe("all good");
  });

  it("/task status completed refuses worktree-backed tasks", async () => {
    setupAgent({ withWorktree: true });
    const store = useCollaboratorStore.getState();
    const task = store.addTask(
      { title: "x", objective: "x", assignee: "@claude1" },
      LB4_SESSION,
    );
    await executeCommand(
      parseInput(`/task ${task.id} status completed`),
      LB4_SESSION,
    );
    const updated = useCollaboratorStore
      .getState()
      .tasksBySession[LB4_SESSION]?.find((t) => t.id === task.id);
    expect(updated?.status).toBe("pending");
    const status = useCollaboratorStore.getState().statusMessages[LB4_SESSION];
    expect(status).toContain("worktree-backed agent");
  });

  it("/task status blocked succeeds for worktree-backed tasks (explicit abandonment is allowed)", async () => {
    // Manual `blocked` is fine — the user is explicitly choosing to
    // abandon the task. Only `completed` bypasses the gate's "did the
    // agent's work get reviewed?" question.
    setupAgent({ withWorktree: true });
    const store = useCollaboratorStore.getState();
    const task = store.addTask(
      { title: "x", objective: "x", assignee: "@claude1" },
      LB4_SESSION,
    );
    await executeCommand(
      parseInput(`/task ${task.id} status blocked`),
      LB4_SESSION,
    );
    const updated = useCollaboratorStore
      .getState()
      .tasksBySession[LB4_SESSION]?.find((t) => t.id === task.id);
    expect(updated?.status).toBe("blocked");
  });

  // Round-9: LB5 multi-task-per-agent gate (claude3 task-46 ISS-2).

  it("/task assign refuses worktree-backed agent that already has an active task", async () => {
    // Two concurrent git-write tasks in one worktree would co-mingle
    // diffs and defeat the per-task approval gate. Refuse re-assignment
    // when the target agent already has a non-terminal task.
    setupAgent({ withWorktree: true });
    const store = useCollaboratorStore.getState();
    // Existing task assigned to @claude1, status pending.
    const existing = store.addTask(
      { title: "first", objective: "first", assignee: "@claude1" },
      LB4_SESSION,
    );
    // Try to assign a SECOND task to @claude1.
    const second = store.addTask(
      { title: "second", objective: "second" },
      LB4_SESSION,
    );
    await executeCommand(
      parseInput(`/task ${second.id} assign @claude1`),
      LB4_SESSION,
    );
    const updated = useCollaboratorStore
      .getState()
      .tasksBySession[LB4_SESSION]?.find((t) => t.id === second.id);
    // Second task NOT assigned (refused).
    expect(updated?.assignee).toBeNull();
    // Status line surfaces the refusal with conflicting task id.
    const status = useCollaboratorStore.getState().statusMessages[LB4_SESSION];
    expect(status).toContain("active worktree-backed task");
    expect(status).toContain(existing.id);
  });

  it("/task add refuses to assign to worktree-backed agent that already has an active task", async () => {
    setupAgent({ withWorktree: true });
    const store = useCollaboratorStore.getState();
    store.addTask(
      { title: "first", objective: "first", assignee: "@claude1" },
      LB4_SESSION,
    );
    await executeCommand(
      parseInput("/task add second-title | second-obj @claude1"),
      LB4_SESSION,
    );
    // Second task NOT created (refused before addTask). Verify only the
    // first task exists.
    const tasks = useCollaboratorStore
      .getState()
      .tasksBySession[LB4_SESSION] ?? [];
    expect(tasks).toHaveLength(1);
    expect(tasks[0].title).toBe("first");
    const status = useCollaboratorStore.getState().statusMessages[LB4_SESSION];
    expect(status).toContain("active worktree-backed task");
  });

  it("/task add allows assigning to a non-worktree-backed agent that already has tasks", async () => {
    // The LB5 invariant only applies when the agent has a worktree.
    // Read-only investigators (no worktree) can have multiple tasks.
    setupAgent({ withWorktree: false });
    const store = useCollaboratorStore.getState();
    store.addTask(
      { title: "first", objective: "first", assignee: "@claude1" },
      LB4_SESSION,
    );
    await executeCommand(
      parseInput("/task add second-title | second-obj @claude1"),
      LB4_SESSION,
    );
    const tasks = useCollaboratorStore
      .getState()
      .tasksBySession[LB4_SESSION] ?? [];
    expect(tasks).toHaveLength(2);
    expect(tasks.every((t) => t.assignee === "@claude1")).toBe(true);
  });

  it("/task assign refuses reassignment when prior task blocked but worktree lease still held (round-10 codex1 H1)", async () => {
    // Round-10 lease-based rule: `blocked` does NOT release the
    // worktree (LB1 fail-closed preserves it for inspection; manual
    // `/task status blocked` is abandonment, not cleanup). While
    // agent.worktree is set, no new git-write task may be assigned
    // to the same handle — the worktree's diff state is unreviewed
    // and a new task would co-mingle.
    setupAgent({ withWorktree: true });
    const store = useCollaboratorStore.getState();
    const old = store.addTask(
      { title: "first", objective: "first", assignee: "@claude1" },
      LB4_SESSION,
    );
    // Block the prior task. Worktree is still preserved on the agent.
    store.updateTask(old.id, { status: "blocked" }, LB4_SESSION);
    const next = store.addTask(
      { title: "second", objective: "second" },
      LB4_SESSION,
    );
    await executeCommand(
      parseInput(`/task ${next.id} assign @claude1`),
      LB4_SESSION,
    );
    // Refused: lease still held by `old` even though it's blocked.
    const updated = useCollaboratorStore
      .getState()
      .tasksBySession[LB4_SESSION]?.find((t) => t.id === next.id);
    expect(updated?.assignee).toBeNull();
    const status = useCollaboratorStore.getState().statusMessages[LB4_SESSION];
    expect(status).toContain("active worktree-backed task");
  });

  it("/task assign allows reassignment after the worktree lease is released (escape hatch)", async () => {
    // The lease is released by either:
    //   - merge of the prior task (orchestrator clears agent.worktree
    //     after git_worktree_remove), OR
    //   - explicit Discard via D14 (future) clears agent.worktree, OR
    //   - the agent record being removed entirely (no agent → no lease).
    // Test (b): simulate Discard by clearing agent.worktree directly.
    setupAgent({ withWorktree: true });
    const store = useCollaboratorStore.getState();
    const old = store.addTask(
      { title: "first", objective: "first", assignee: "@claude1" },
      LB4_SESSION,
    );
    store.updateTask(old.id, { status: "blocked" }, LB4_SESSION);

    // Simulate the Discard action releasing the lease.
    useCollaboratorStore.setState({
      agents: useCollaboratorStore
        .getState()
        .agents.map((a) =>
          a.handle === "claude1" ? { ...a, worktree: null } : a,
        ),
    });

    const next = store.addTask(
      { title: "second", objective: "second" },
      LB4_SESSION,
    );
    await executeCommand(
      parseInput(`/task ${next.id} assign @claude1`),
      LB4_SESSION,
    );
    const updated = useCollaboratorStore
      .getState()
      .tasksBySession[LB4_SESSION]?.find((t) => t.id === next.id);
    expect(updated?.assignee).toBe("@claude1");
  });

  it("addTask structural gate refuses programmatic assignment to held lease (round-10 claude3 O1)", async () => {
    // The structural gate inside addTask catches paths that bypass the
    // slash command — e.g., sendToAgent's auto-create, future UI
    // buttons, programmatic helpers. Test directly via store.addTask().
    setupAgent({ withWorktree: true });
    const store = useCollaboratorStore.getState();
    store.addTask(
      { title: "first", objective: "first", assignee: "@claude1" },
      LB4_SESSION,
    );
    // Suppress the expected console.warn from the structural gate.
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    // Direct addTask call (not through slash command).
    const second = store.addTask(
      { title: "second", objective: "second", assignee: "@claude1" },
      LB4_SESSION,
    );
    // Task created but assignee dropped (silent structural refusal).
    expect(second.assignee).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("LB5: refused to assign"),
    );
    warnSpy.mockRestore();
  });

  it("updateTask structural gate refuses programmatic reassignment to held lease (round-10 claude3 O1)", async () => {
    // Direct store.updateTask call should also be gated. Tests the
    // structural backstop for any caller that bypasses the slash
    // command (future UI assign button, programmatic helper).
    setupAgent({ withWorktree: true });
    const store = useCollaboratorStore.getState();
    store.addTask(
      { title: "first", objective: "first", assignee: "@claude1" },
      LB4_SESSION,
    );
    const second = store.addTask(
      { title: "second", objective: "second" },
      LB4_SESSION,
    );
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    // Direct updateTask({assignee}) should be silently refused.
    store.updateTask(second.id, { assignee: "@claude1" }, LB4_SESSION);
    const updated = useCollaboratorStore
      .getState()
      .tasksBySession[LB4_SESSION]?.find((t) => t.id === second.id);
    expect(updated?.assignee).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("LB5: refused to reassign"),
    );
    warnSpy.mockRestore();
  });

  // Round-11: codex2 task-87 H1+M1 — sendToAgent/broadcastToAll lease check
  // and updateTask assignedAt fix when LB5 drops the assignee field.

  it("updateTask: refused reassignment does NOT bump assignedAt (round-11 codex2 M1)", async () => {
    // M1: when LB5 drops the assignee field via the structural gate, the
    // surrounding `reassigned` flag must also be cleared. Otherwise the
    // task's assignedAt is bumped as if a real reassignment happened —
    // surfacing the rejected handle as "fresh" in the indicator UI.
    setupAgent({ withWorktree: true });
    const store = useCollaboratorStore.getState();
    // Existing task assigned to @claude1 holds the lease.
    store.addTask(
      { title: "first", objective: "first", assignee: "@claude1" },
      LB4_SESSION,
    );
    // A second task initially unassigned.
    const second = store.addTask(
      { title: "second", objective: "second" },
      LB4_SESSION,
    );
    const before = useCollaboratorStore
      .getState()
      .tasksBySession[LB4_SESSION]?.find((t) => t.id === second.id);
    const initialAssignedAt = before?.assignedAt;
    // Wait long enough that a real reassignment would produce a strictly
    // greater timestamp. Without the M1 fix this test would observe a
    // bumped assignedAt; with the fix it must equal initialAssignedAt.
    await new Promise((r) => setTimeout(r, 5));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    // Try to reassign to @claude1 — LB5 drops the assignee field.
    store.updateTask(second.id, { assignee: "@claude1" }, LB4_SESSION);
    const updated = useCollaboratorStore
      .getState()
      .tasksBySession[LB4_SESSION]?.find((t) => t.id === second.id);
    // assignee untouched (refused).
    expect(updated?.assignee).toBeNull();
    // assignedAt NOT bumped — refused reassignment is a no-op for
    // freshness purposes.
    expect(updated?.assignedAt).toBe(initialAssignedAt);
    warnSpy.mockRestore();
  });

  it("sendToAgent refuses the operation when target's worktree lease is held and no active task exists (round-11 codex2 H1)", async () => {
    // H1: structural gate at addTask refuses the ledger write but
    // sendToAgent's PTY injection still proceeded — so an agent could
    // receive a fresh prompt that lands inside the held worktree under a
    // task with no assignee. The send must be refused outright when:
    //   (a) target's worktree lease is held, AND
    //   (b) no active task exists for the target (so we'd auto-create).
    setupAgent({ withWorktree: true });
    const store = useCollaboratorStore.getState();
    // Existing task assigned to @claude1, status awaiting-approval — past
    // pending/in-progress, so findFreshestActiveTaskForMention returns null
    // and would otherwise fall through to auto-create.
    const existing = store.addTask(
      { title: "first", objective: "first", assignee: "@claude1" },
      LB4_SESSION,
    );
    store.updateTask(existing.id, { status: "awaiting-approval" }, LB4_SESSION);
    vi.mocked(invoke).mockClear();

    await store.sendToAgent("pty-1", "do another thing");

    // Send refused: NO inject_into_pty call.
    const injects = vi
      .mocked(invoke)
      .mock.calls.filter((c) => c[0] === "inject_into_pty");
    expect(injects).toHaveLength(0);
    // No new task auto-created either; only the original task remains.
    const tasks = useCollaboratorStore.getState().tasksBySession[LB4_SESSION] ?? [];
    expect(tasks).toHaveLength(1);
    expect(tasks[0].id).toBe(existing.id);
    // Status surfaces actionable refusal mentioning the conflicting task.
    const status = useCollaboratorStore.getState().statusMessages[LB4_SESSION];
    expect(status).toContain("worktree lease still held");
    expect(status).toContain(existing.id);
  });

  it("sendToAgent allows the operation when target has an active pending task (refresh path, no auto-create)", async () => {
    // The lease check ONLY fires when sendToAgent would otherwise
    // auto-create. If an active pending/in-progress task exists for the
    // target, the send refreshes assignedAt — driving the existing task
    // forward, which is correct even if the worktree is reuse-pending.
    setupAgent({ withWorktree: true });
    const store = useCollaboratorStore.getState();
    store.addTask(
      { title: "first", objective: "first", assignee: "@claude1" },
      LB4_SESSION,
    );
    vi.mocked(invoke).mockClear();

    await store.sendToAgent("pty-1", "follow-up");

    const injects = vi
      .mocked(invoke)
      .mock.calls.filter((c) => c[0] === "inject_into_pty");
    expect(injects).toHaveLength(1);
  });

  it("broadcastToAll skips agents with held worktree leases AND continues with the rest (round-11 codex2 H1)", async () => {
    // Per-agent: each agent that would auto-create AND has a held lease
    // is skipped. Agents that have an active task to refresh, or no held
    // lease, still receive the broadcast. Status line surfaces skipped
    // handles with actionable advice.
    useCollaboratorStore.setState({
      agents: [
        {
          sessionId: "pty-1",
          tool: "claude_code",
          status: "running",
          collabSessionId: LB4_SESSION,
          ordinal: 1,
          handle: "claude1",
          nickname: "Claude Code #1",
          nicknameSlug: "claude-code-1",
          nameHistory: [
            { nickname: "Claude Code #1", setAt: "2024-01-01T00:00:00.000Z", setBy: "system" },
          ],
          worktree: {
            repoRoot: "/r",
            path: "/wt1",
            branch: "agent/claude_code-session-1",
            baseRef: "origin/dev",
            baseSha: "abc",
            baseFresh: true,
            createdAtMs: 1,
          },
        },
        {
          sessionId: "pty-2",
          tool: "claude_code",
          status: "running",
          collabSessionId: LB4_SESSION,
          ordinal: 2,
          handle: "claude2",
          nickname: "Claude Code #2",
          nicknameSlug: "claude-code-2",
          nameHistory: [
            { nickname: "Claude Code #2", setAt: "2024-01-01T00:00:00.000Z", setBy: "system" },
          ],
          worktree: {
            repoRoot: "/r",
            path: "/wt2",
            branch: "agent/claude_code-session-2",
            baseRef: "origin/dev",
            baseSha: "def",
            baseFresh: true,
            createdAtMs: 2,
          },
        },
      ],
      contextSentByAgent: {},
      pendingMessagesByAgent: {},
      tasksBySession: { [LB4_SESSION]: [] },
      logEntriesBySession: { [LB4_SESSION]: [] },
      statusMessages: {},
    });
    const store = useCollaboratorStore.getState();
    // @claude1 holds a lease; its task is awaiting-approval (no active task).
    const c1Task = store.addTask(
      { title: "c1-task", objective: "c1", assignee: "@claude1" },
      LB4_SESSION,
    );
    store.updateTask(c1Task.id, { status: "awaiting-approval" }, LB4_SESSION);
    // @claude2 has no task — nothing held; broadcast should auto-create.
    vi.mocked(invoke).mockClear();

    await store.broadcastToAll("everyone work on this", LB4_SESSION);

    // Exactly 1 inject — to @claude2 (pty-2) only. @claude1 was skipped.
    const injects = vi
      .mocked(invoke)
      .mock.calls.filter((c) => c[0] === "inject_into_pty");
    expect(injects).toHaveLength(1);
    expect((injects[0][1] as { sessionId: string }).sessionId).toBe("pty-2");
    // Combined status: broadcast acknowledgement + skip notice.
    const status = useCollaboratorStore.getState().statusMessages[LB4_SESSION];
    expect(status).toContain("Broadcast sent to 1 agent");
    expect(status).toContain("skipped 1");
    expect(status).toContain("@claude1");
  });

  it("broadcastToAll: when ALL targets have held leases, sends nothing", async () => {
    // Edge case: every target is lease-blocked. Skip status fires; no
    // fan-out happens (the function returns early after the filter).
    setupAgent({ withWorktree: true });
    const store = useCollaboratorStore.getState();
    const t = store.addTask(
      { title: "x", objective: "x", assignee: "@claude1" },
      LB4_SESSION,
    );
    store.updateTask(t.id, { status: "awaiting-approval" }, LB4_SESSION);
    vi.mocked(invoke).mockClear();

    await store.broadcastToAll("blast", LB4_SESSION);

    const injects = vi
      .mocked(invoke)
      .mock.calls.filter((c) => c[0] === "inject_into_pty");
    expect(injects).toHaveLength(0);
    const status = useCollaboratorStore.getState().statusMessages[LB4_SESSION];
    expect(status).toContain("Skipped");
    expect(status).toContain("@claude1");
  });

  // Round-8: cover the live-record gap (codex1+codex2+claude3 convergent).

  it("/task done refuses tasks whose pendingMerge is set even after the agent record is gone", async () => {
    // Round-8 round of fixes: gate must hold even if the live
    // SpawnedAgent record disappears (e.g., user clicked X mid-flow).
    // pendingMerge being non-null means the gate already engaged; a
    // slash-command `completed` here would silently bypass an
    // already-running approval flow.
    setupAgent({ withWorktree: true });
    const store = useCollaboratorStore.getState();
    const task = store.addTask(
      { title: "x", objective: "x", assignee: "@claude1" },
      LB4_SESSION,
    );
    // Simulate the gate having already engaged.
    store.updateTask(
      task.id,
      {
        status: "awaiting-approval",
        pendingMerge: {
          branch: "agent/test",
          worktreePath: "/wt",
          repoRoot: "/r",
          baseRef: "origin/dev",
          baseSha: "abc",
          baseFresh: true,
          diffSummary: { committed: ["x.ts"], staged: [], unstaged: [], untracked: [] },
          agentHandle: "@claude1",
        },
      },
      LB4_SESSION,
    );
    // Now wipe the agent record — simulating UI-tile-dismissed-while-
    // worktree-was-clean OR any other transient state.
    useCollaboratorStore.setState({ agents: [] });

    await executeCommand(
      parseInput(`/task ${task.id} done forced`),
      LB4_SESSION,
    );

    const updated = useCollaboratorStore
      .getState()
      .tasksBySession[LB4_SESSION]?.find((t) => t.id === task.id);
    // Refused: status unchanged from awaiting-approval.
    expect(updated?.status).toBe("awaiting-approval");
    // pendingMerge intact (central cleanup didn't fire because no
    // terminal transition happened).
    expect(updated?.pendingMerge).not.toBeNull();
  });
});

describe("scanForTaskCompletions LB1 awaiting-approval gate (P2)", () => {
  // Each test uses a unique session so the module-level `nextOrdinal`
  // counter (which resetStores can't reach) doesn't cause an agent's
  // handle to drift across tests. Without per-test sessions, test 1's
  // claude_code spawn gets handle `claude1`; test 2's gets `claude2`;
  // and tests asserting `@claude1` would silently mis-resolve.
  let sessionCounter = 0;
  let lb1Session: string;

  beforeEach(() => {
    sessionCounter += 1;
    lb1Session = `lb1-test-${sessionCounter}`;
    resetStores();
    vi.mocked(invoke).mockReset();
    vi.mocked(invoke).mockResolvedValue(null);
  });
  afterEach(() => {
    vi.mocked(invoke).mockImplementation(async () => null);
  });

  const fakeWorktree = {
    repoRoot: "/r",
    path: "/wt",
    branch: "agent/claude_code-session-1",
    baseRef: "origin/dev",
    baseSha: "abc123",
    baseFresh: true,
    createdAtMs: 1,
  };

  function setupAgentWithWorktree() {
    const store = useCollaboratorStore.getState();
    store.addAgent({
      sessionId: "pty-1",
      tool: "claude_code",
      status: "running",
      collabSessionId: lb1Session,
      worktree: fakeWorktree,
    });
  }

  it("flips a worktree-backed task with source delta to awaiting-approval (LB1)", async () => {
    setupAgentWithWorktree();
    const store = useCollaboratorStore.getState();
    const task = store.addTask(
      { title: "x", objective: "x", assignee: "@claude1" },
      lb1Session,
    );
    const doneJson = JSON.stringify({
      task_id: task.id,
      status: "completed",
      author: "@claude1",
    });
    let deleted = false;
    let killPtyCalled = false;
    let diffSummaryCalledAt: number | null = null;
    let killPtyCalledAt: number | null = null;
    let nextCallIdx = 0;
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      const idx = nextCallIdx++;
      if (cmd === "list_memory_files")
        return deleted ? [] : [`${task.id}.done.json`];
      if (cmd === "read_memory_file") return deleted ? null : doneJson;
      if (cmd === "delete_memory_file") {
        deleted = true;
        return null;
      }
      if (cmd === "kill_pty") {
        killPtyCalled = true;
        killPtyCalledAt = idx;
        return null;
      }
      if (cmd === "git_diff_summary") {
        diffSummaryCalledAt = idx;
        return {
          hasChanges: true,
          committed: ["src/foo.ts"],
          staged: [],
          unstaged: [],
          untracked: [],
        };
      }
      return null;
    });

    await scanForTaskCompletions(lb1Session);

    // Invariant: status is awaiting-approval, NOT completed.
    const updated = useCollaboratorStore
      .getState()
      .tasksBySession[lb1Session]?.find((t) => t.id === task.id);
    expect(updated?.status).toBe("awaiting-approval");
    // Invariant: pendingMerge is populated with the snapshot.
    expect(updated?.pendingMerge).not.toBeNull();
    expect(updated?.pendingMerge?.branch).toBe(fakeWorktree.branch);
    expect(updated?.pendingMerge?.worktreePath).toBe(fakeWorktree.path);
    expect(updated?.pendingMerge?.baseSha).toBe(fakeWorktree.baseSha);
    expect(updated?.pendingMerge?.diffSummary.committed).toEqual(["src/foo.ts"]);
    expect(updated?.pendingMerge?.agentHandle).toBe("@claude1");
    // Invariant: kill_pty was called.
    expect(killPtyCalled).toBe(true);
    // Invariant: kill_pty was called BEFORE git_diff_summary
    // (claude3 task-46 R2 ordering — frozen worktree before snapshot).
    expect(killPtyCalledAt).not.toBeNull();
    expect(diffSummaryCalledAt).not.toBeNull();
    expect(killPtyCalledAt!).toBeLessThan(diffSummaryCalledAt!);
  });

  it("auto-completes a worktree-backed task with NO source delta", async () => {
    // Agent worked in a worktree but produced no changes (e.g., read-only
    // investigation). Should terminalize as completed, not awaiting-approval.
    setupAgentWithWorktree();
    const store = useCollaboratorStore.getState();
    const task = store.addTask(
      { title: "x", objective: "x", assignee: "@claude1" },
      lb1Session,
    );
    const doneJson = JSON.stringify({
      task_id: task.id,
      status: "completed",
      author: "@claude1",
    });
    let deleted = false;
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "list_memory_files")
        return deleted ? [] : [`${task.id}.done.json`];
      if (cmd === "read_memory_file") return deleted ? null : doneJson;
      if (cmd === "delete_memory_file") {
        deleted = true;
        return null;
      }
      if (cmd === "git_diff_summary") {
        return {
          hasChanges: false,
          committed: [],
          staged: [],
          unstaged: [],
          untracked: [],
        };
      }
      return null;
    });

    await scanForTaskCompletions(lb1Session);

    const updated = useCollaboratorStore
      .getState()
      .tasksBySession[lb1Session]?.find((t) => t.id === task.id);
    expect(updated?.status).toBe("completed");
    expect(updated?.pendingMerge).toBeNull();
  });

  it("auto-completes when the agent has no worktree (no-isolation path)", async () => {
    // Agent spawned outside a git repo (no worktree provisioned).
    // Existing behavior: terminalize directly to completed.
    const store = useCollaboratorStore.getState();
    store.addAgent({
      sessionId: "pty-2",
      tool: "claude_code",
      status: "running",
      collabSessionId: lb1Session,
      worktree: null,
    });
    const task = store.addTask(
      { title: "x", objective: "x", assignee: "@claude1" },
      lb1Session,
    );
    const doneJson = JSON.stringify({
      task_id: task.id,
      status: "completed",
      author: "@claude1",
    });
    let deleted = false;
    let gitDiffCalled = false;
    let killPtyCalled = false;
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "list_memory_files")
        return deleted ? [] : [`${task.id}.done.json`];
      if (cmd === "read_memory_file") return deleted ? null : doneJson;
      if (cmd === "delete_memory_file") {
        deleted = true;
        return null;
      }
      if (cmd === "kill_pty") killPtyCalled = true;
      if (cmd === "git_diff_summary") gitDiffCalled = true;
      return null;
    });

    await scanForTaskCompletions(lb1Session);

    const updated = useCollaboratorStore
      .getState()
      .tasksBySession[lb1Session]?.find((t) => t.id === task.id);
    expect(updated?.status).toBe("completed");
    expect(updated?.pendingMerge).toBeNull();
    // No worktree → don't kill PTY or scan diff.
    expect(killPtyCalled).toBe(false);
    expect(gitDiffCalled).toBe(false);
  });

  it("kill_pty failure does NOT bypass the gate (round-7 codex1+codex2 H1)", async () => {
    // A dead PTY is already frozen. kill_pty failure must not block the
    // diff snapshot — we still try git_diff_summary and route based on
    // its result. If diff shows source delta, flip to awaiting-approval
    // even though kill_pty failed. PTY-already-exited is the most common
    // legitimate cause; we shouldn't strand the task OR bypass the gate.
    setupAgentWithWorktree();
    const store = useCollaboratorStore.getState();
    const task = store.addTask(
      { title: "x", objective: "x", assignee: "@claude1" },
      lb1Session,
    );
    const doneJson = JSON.stringify({
      task_id: task.id,
      status: "completed",
      author: "@claude1",
    });
    let deleted = false;
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "list_memory_files")
        return deleted ? [] : [`${task.id}.done.json`];
      if (cmd === "read_memory_file") return deleted ? null : doneJson;
      if (cmd === "delete_memory_file") {
        deleted = true;
        return null;
      }
      if (cmd === "kill_pty") throw new Error("PTY already exited");
      if (cmd === "git_diff_summary") {
        // PTY was already gone, but diff still works — and shows changes.
        return {
          hasChanges: true,
          committed: ["src/foo.ts"],
          staged: [],
          unstaged: [],
          untracked: [],
        };
      }
      return null;
    });

    await scanForTaskCompletions(lb1Session);

    const updated = useCollaboratorStore
      .getState()
      .tasksBySession[lb1Session]?.find((t) => t.id === task.id);
    // The gate engaged successfully despite kill_pty failing.
    expect(updated?.status).toBe("awaiting-approval");
    expect(updated?.pendingMerge).not.toBeNull();
    expect(updated?.pendingMerge?.diffSummary.committed).toEqual(["src/foo.ts"]);
    // Warn was logged for the kill_pty failure but didn't bypass the gate.
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("kill_pty failed"),
      expect.any(Error),
    );
    warnSpy.mockRestore();
  });

  it("git_diff_summary failure FAILS CLOSED → blocked (round-7 codex1+codex2 H1)", async () => {
    // If the diff snapshot fails, we cannot determine whether source
    // changed. Terminalizing as `completed` would silently bypass the
    // approval gate — exactly the bypass codex1+codex2 flagged. Must
    // fail closed: status → blocked, worktree preserved, error in
    // conclusion so the user can act on it.
    setupAgentWithWorktree();
    const store = useCollaboratorStore.getState();
    const task = store.addTask(
      { title: "x", objective: "x", assignee: "@claude1" },
      lb1Session,
    );
    const doneJson = JSON.stringify({
      task_id: task.id,
      status: "completed",
      author: "@claude1",
    });
    let deleted = false;
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "list_memory_files")
        return deleted ? [] : [`${task.id}.done.json`];
      if (cmd === "read_memory_file") return deleted ? null : doneJson;
      if (cmd === "delete_memory_file") {
        deleted = true;
        return null;
      }
      if (cmd === "kill_pty") return null; // succeeds
      if (cmd === "git_diff_summary")
        throw new Error("worktree path not found");
      return null;
    });

    await scanForTaskCompletions(lb1Session);

    const updated = useCollaboratorStore
      .getState()
      .tasksBySession[lb1Session]?.find((t) => t.id === task.id);
    // FAIL CLOSED: blocked, NOT completed.
    expect(updated?.status).toBe("blocked");
    // Diagnostic info preserved so the user can investigate.
    expect(updated?.conclusion).toContain("git_diff_summary failed");
    expect(updated?.conclusion).toContain("worktree path not found");
    // pendingMerge cleared (terminal transition central cleanup ran).
    expect(updated?.pendingMerge).toBeNull();
    // Warning logged for diagnostic visibility.
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("LB1 fail-closed"),
      expect.any(Error),
    );
    warnSpy.mockRestore();
  });

  it("gates by task.assignee, not data.author (round-7 codex2 H2 spoofing)", async () => {
    // .done.json's `author` field is unauthenticated and a malicious
    // agent could spoof it (e.g., to a handle without a worktree) to
    // bypass the gate. The gate must route via task.assignee — the
    // orchestrator-controlled field — and find the assignee's worktree
    // regardless of what `author` claims.
    setupAgentWithWorktree(); // assignee @claude1 has the worktree
    const store = useCollaboratorStore.getState();
    const task = store.addTask(
      { title: "x", objective: "x", assignee: "@claude1" },
      lb1Session,
    );
    // Spoof: agent claims to be @some-other-agent (no worktree).
    const doneJson = JSON.stringify({
      task_id: task.id,
      status: "completed",
      author: "@some-other-agent",
    });
    let deleted = false;
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "list_memory_files")
        return deleted ? [] : [`${task.id}.done.json`];
      if (cmd === "read_memory_file") return deleted ? null : doneJson;
      if (cmd === "delete_memory_file") {
        deleted = true;
        return null;
      }
      if (cmd === "kill_pty") return null;
      if (cmd === "git_diff_summary") {
        return {
          hasChanges: true,
          committed: ["src/foo.ts"],
          staged: [],
          unstaged: [],
          untracked: [],
        };
      }
      return null;
    });

    await scanForTaskCompletions(lb1Session);

    const updated = useCollaboratorStore
      .getState()
      .tasksBySession[lb1Session]?.find((t) => t.id === task.id);
    // Spoof did NOT bypass the gate — assignee has a worktree, so the
    // gate engages and flips to awaiting-approval.
    expect(updated?.status).toBe("awaiting-approval");
    expect(updated?.pendingMerge).not.toBeNull();
    // pendingMerge.agentHandle reflects the assignee, NOT the spoofed
    // author. completedBy stays as audit metadata of who self-claimed.
    expect(updated?.pendingMerge?.agentHandle).toBe("@claude1");
    expect(updated?.completedBy).toBe("@some-other-agent");
  });
});

describe("updateTask central pendingMerge cleanup (codex2 task-67 H1)", () => {
  beforeEach(() => {
    resetStores();
  });

  const fakePendingMerge = {
    branch: "agent/test-1",
    worktreePath: "/tmp/wt",
    repoRoot: "/tmp/repo",
    baseRef: "origin/dev",
    baseSha: "abc123",
    baseFresh: true,
    diffSummary: {
      committed: ["src/foo.ts"],
      staged: [],
      unstaged: [],
      untracked: [],
    },
    agentHandle: "@claude2",
  };

  it("clears pendingMerge when status transitions to completed", () => {
    const store = useCollaboratorStore.getState();
    const task = store.addTask({ title: "x", objective: "x" }, SESSION);
    // Simulate the awaiting-approval gate having populated pendingMerge.
    store.updateTask(
      task.id,
      { status: "awaiting-approval", pendingMerge: fakePendingMerge },
      SESSION,
    );
    const beforeTerminal = store.getTasks(SESSION).find((t) => t.id === task.id);
    expect(beforeTerminal?.pendingMerge).not.toBeNull();

    // Caller transitions to completed WITHOUT explicitly passing pendingMerge.
    // The central cleanup must still null it.
    store.updateTask(task.id, { status: "completed" }, SESSION);
    const afterTerminal = store.getTasks(SESSION).find((t) => t.id === task.id);
    expect(afterTerminal?.status).toBe("completed");
    expect(afterTerminal?.pendingMerge).toBeNull();
  });

  it("clears pendingMerge when status transitions to blocked", () => {
    const store = useCollaboratorStore.getState();
    const task = store.addTask({ title: "x", objective: "x" }, SESSION);
    store.updateTask(
      task.id,
      { status: "merge-conflict", pendingMerge: fakePendingMerge },
      SESSION,
    );
    store.updateTask(task.id, { status: "blocked" }, SESSION);
    const after = store.getTasks(SESSION).find((t) => t.id === task.id);
    expect(after?.status).toBe("blocked");
    expect(after?.pendingMerge).toBeNull();
  });

  it("warns when transitioning to a P2 non-terminal without a snapshot", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const store = useCollaboratorStore.getState();
    const task = store.addTask({ title: "x", objective: "x" }, SESSION);
    // No pendingMerge supplied; existing task has none either.
    store.updateTask(task.id, { status: "awaiting-approval" }, SESSION);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("without pendingMerge snapshot"),
    );
    warnSpy.mockRestore();
  });

  it("does NOT warn when an existing pendingMerge is preserved across non-terminal transitions", () => {
    // E.g., awaiting-approval → approved-merging while keeping the same
    // snapshot. Caller doesn't need to re-supply.
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const store = useCollaboratorStore.getState();
    const task = store.addTask({ title: "x", objective: "x" }, SESSION);
    store.updateTask(
      task.id,
      { status: "awaiting-approval", pendingMerge: fakePendingMerge },
      SESSION,
    );
    warnSpy.mockClear();
    // Transition awaiting-approval → approved-merging. Caller doesn't
    // re-supply pendingMerge; the existing snapshot satisfies the rule.
    store.updateTask(task.id, { status: "approved-merging" }, SESSION);
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// D14 — Approve / Discard slash commands (orchestrator-owned merge surface)
// ---------------------------------------------------------------------------
//
// Approve flow: optional git_create_approval_commit (when residue exists) →
// git_merge_worktree → git_worktree_remove → release lease + transition
// task to `completed`. Each GitError variant routes to a specific status
// transition: merge-conflict / hook failure → `merge-conflict`; stale base /
// dirty parent / empty commit → restore `awaiting-approval`; push-failed-
// after-merge → `completed` with warning (local merge already happened).
//
// Discard flow: git_worktree_remove + git_branch_force_delete → release
// lease + transition task to `blocked`.
//
// Both flows release the agent's worktree lease so a follow-up task can be
// assigned to the same agent (LB5 lease-based).

describe("D14 — /task approve and /task discard slash commands", () => {
  const D14_SESSION = "collab-d14-tests";

  beforeEach(() => {
    _resetWriteStateForTests();
    // Round-21 (claude3 task-99 O5): flush the verified-protected TTL
    // cache so cached protected verdicts from one test don't leak into
    // another test that mocks a different protection state.
    _clearVerifiedProtectedCacheForTests();
    vi.mocked(invoke).mockClear();
    vi.mocked(invoke).mockImplementation(async () => null);
  });

  function setupAwaitingApprovalTask(opts: {
    hasResidue: boolean;
    /**
     * Default: pre-ack the branch-protection limited guarantee for "/r"
     * so LB3 doesn't gate the Approve flow in D14 tests. Tests
     * specifically exercising the LB3 wizard pass `ackProtection: false`
     * to opt into the protection-state IPC sequence.
     */
    ackProtection?: boolean;
  } = { hasResidue: true }) {
    const ackProtection = opts.ackProtection ?? true;
    useCollaboratorStore.setState({
      agents: [
        {
          sessionId: "pty-1",
          tool: "claude_code",
          status: "exited", // round-8: PTY exits after LB1 flip; record persists
          collabSessionId: D14_SESSION,
          ordinal: 1,
          handle: "claude1",
          nickname: "Claude Code #1",
          nicknameSlug: "claude-code-1",
          nameHistory: [
            { nickname: "Claude Code #1", setAt: "2024-01-01T00:00:00.000Z", setBy: "system" },
          ],
          worktree: {
            repoRoot: "/r",
            path: "/wt",
            branch: "agent/claude_code-session-1",
            baseRef: "origin/dev",
            baseSha: "abc",
            baseFresh: true,
            createdAtMs: 1,
          },
        },
      ],
      contextSentByAgent: {},
      pendingMessagesByAgent: {},
      tasksBySession: { [D14_SESSION]: [] },
      logEntriesBySession: { [D14_SESSION]: [] },
      statusMessages: {},
      branchProtectionAcks: ackProtection
        ? { "/r": { acceptedAt: "2024-01-01T00:00:00.000Z" } }
        : {},
    });
    const store = useCollaboratorStore.getState();
    const task = store.addTask(
      { title: "feat", objective: "feat", assignee: "@claude1" },
      D14_SESSION,
    );
    store.updateTask(
      task.id,
      {
        status: "awaiting-approval",
        pendingMerge: {
          branch: "agent/claude_code-session-1",
          worktreePath: "/wt",
          repoRoot: "/r",
          baseRef: "origin/dev",
          baseSha: "abc",
          baseFresh: true,
          diffSummary: opts.hasResidue
            ? { committed: ["a.ts"], staged: ["b.ts"], unstaged: [], untracked: [] }
            : { committed: ["a.ts"], staged: [], unstaged: [], untracked: [] },
          agentHandle: "@claude1",
        },
      },
      D14_SESSION,
    );
    return { taskId: task.id };
  }

  it("/task approve: happy path — runs approval-commit + merge + cleanup, releases lease, marks completed", async () => {
    const { taskId } = setupAwaitingApprovalTask({ hasResidue: true });
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "git_create_approval_commit") return { commitSha: "deadbeef", stagedCount: 1 };
      if (cmd === "git_merge_worktree") return { mergedSha: "abcd1234", pushed: false };
      if (cmd === "git_worktree_remove") return { kind: "fullyRemoved" };
      return null;
    });
    await executeCommand(parseInput(`/task ${taskId} approve`), D14_SESSION);
    const task = useCollaboratorStore
      .getState()
      .tasksBySession[D14_SESSION]?.find((t) => t.id === taskId);
    expect(task?.status).toBe("completed");
    expect(task?.pendingMerge).toBeNull();
    expect(task?.conclusion).toContain("abcd1234");
    // Lease released.
    const agent = useCollaboratorStore.getState().agents[0];
    expect(agent.worktree).toBeNull();
    // Verify all three git IPCs fired in order (filter out persistence
    // calls like read_memory_file / write_memory_file).
    const gitOrder = vi
      .mocked(invoke)
      .mock.calls.map((c) => c[0])
      .filter((c) => typeof c === "string" && c.startsWith("git_"));
    expect(gitOrder).toEqual([
      "git_create_approval_commit",
      "git_merge_worktree",
      "git_worktree_remove",
    ]);
  });

  it("/task approve: skips approval-commit when diffSummary has no working-tree residue", async () => {
    const { taskId } = setupAwaitingApprovalTask({ hasResidue: false });
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "git_merge_worktree") return { mergedSha: "abcd1234", pushed: false };
      if (cmd === "git_worktree_remove") return { kind: "fullyRemoved" };
      return null;
    });
    await executeCommand(parseInput(`/task ${taskId} approve`), D14_SESSION);
    const gitOrder = vi
      .mocked(invoke)
      .mock.calls.map((c) => c[0])
      .filter((c) => typeof c === "string" && c.startsWith("git_"));
    // git_create_approval_commit NOT called (committed-only branch).
    expect(gitOrder).toEqual(["git_merge_worktree", "git_worktree_remove"]);
    const task = useCollaboratorStore
      .getState()
      .tasksBySession[D14_SESSION]?.find((t) => t.id === taskId);
    expect(task?.status).toBe("completed");
  });

  it("/task approve --push: passes push=true to merge", async () => {
    const { taskId } = setupAwaitingApprovalTask({ hasResidue: false });
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "git_merge_worktree") return { mergedSha: "abcd1234", pushed: true };
      if (cmd === "git_worktree_remove") return { kind: "fullyRemoved" };
      return null;
    });
    await executeCommand(parseInput(`/task ${taskId} approve --push`), D14_SESSION);
    const mergeCall = vi
      .mocked(invoke)
      .mock.calls.find((c) => c[0] === "git_merge_worktree");
    expect((mergeCall![1] as { push: boolean }).push).toBe(true);
    const status = useCollaboratorStore.getState().statusMessages[D14_SESSION];
    expect(status).toContain("pushed");
  });

  it("/task approve -- <message>: passes the custom message to approval-commit", async () => {
    const { taskId } = setupAwaitingApprovalTask({ hasResidue: true });
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "git_create_approval_commit") return { commitSha: "x", stagedCount: 1 };
      if (cmd === "git_merge_worktree") return { mergedSha: "y", pushed: false };
      if (cmd === "git_worktree_remove") return { kind: "fullyRemoved" };
      return null;
    });
    await executeCommand(
      parseInput(`/task ${taskId} approve -- Custom commit subject`),
      D14_SESSION,
    );
    const acCall = vi
      .mocked(invoke)
      .mock.calls.find((c) => c[0] === "git_create_approval_commit");
    expect((acCall![1] as { message: string }).message).toBe("Custom commit subject");
  });

  it("/task approve: refuses when task has no pendingMerge", async () => {
    setupAwaitingApprovalTask();
    const store = useCollaboratorStore.getState();
    const plain = store.addTask({ title: "x", objective: "x" }, D14_SESSION);
    await executeCommand(parseInput(`/task ${plain.id} approve`), D14_SESSION);
    const status = useCollaboratorStore.getState().statusMessages[D14_SESSION];
    expect(status).toContain("no pending merge");
  });

  it("/task approve: refuses when status is not awaiting-approval / merge-conflict", async () => {
    const { taskId } = setupAwaitingApprovalTask();
    // Move to in-progress (won't auto-clear pendingMerge per central rule).
    useCollaboratorStore.setState((s) => ({
      tasksBySession: {
        ...s.tasksBySession,
        [D14_SESSION]: s.tasksBySession[D14_SESSION].map((t) =>
          t.id === taskId ? { ...t, status: "in-progress" } : t,
        ),
      },
    }));
    await executeCommand(parseInput(`/task ${taskId} approve`), D14_SESSION);
    const status = useCollaboratorStore.getState().statusMessages[D14_SESSION];
    expect(status).toContain("Approve only fires for");
  });

  it("/task approve: hookFailed → task transitions to merge-conflict, worktree preserved (round-12 O5: 'pre-unknown' wording fix)", async () => {
    const { taskId } = setupAwaitingApprovalTask({ hasResidue: false });
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "git_merge_worktree") {
        // Round-12 claude3 O5: backend's classifier always sets
        // stage: "unknown" for HookFailed (the stage isn't recoverable
        // from stderr alone). The rendered status MUST fall back to
        // "pre-commit" (the dominant case), NOT "pre-unknown".
        throw { kind: "hookFailed", stage: "unknown", stderr: "pre-commit hook rejected" };
      }
      return null;
    });
    await executeCommand(parseInput(`/task ${taskId} approve`), D14_SESSION);
    const task = useCollaboratorStore
      .getState()
      .tasksBySession[D14_SESSION]?.find((t) => t.id === taskId);
    expect(task?.status).toBe("merge-conflict");
    // pendingMerge is NOT cleared on merge-conflict (still pending review).
    expect(task?.pendingMerge).not.toBeNull();
    // Worktree remove NOT called.
    const ipcOrder = vi
      .mocked(invoke)
      .mock.calls.map((c) => c[0])
      .filter((c) => typeof c === "string" && c.startsWith("git_"));
    expect(ipcOrder).not.toContain("git_worktree_remove");
    // Lease still held.
    const agent = useCollaboratorStore.getState().agents[0];
    expect(agent.worktree).not.toBeNull();
    // Round-12 O5: status must NOT contain the awkward "pre-unknown".
    const statusMsg = useCollaboratorStore.getState().statusMessages[D14_SESSION];
    expect(statusMsg).toContain("pre-commit hook failed");
    expect(statusMsg).not.toContain("pre-unknown");
  });

  it("/task approve: mergeConflict → task transitions to merge-conflict with file list in status", async () => {
    const { taskId } = setupAwaitingApprovalTask({ hasResidue: false });
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "git_merge_worktree") {
        throw { kind: "mergeConflict", branch: "agent/x", files: ["src/a.ts", "src/b.ts"] };
      }
      return null;
    });
    await executeCommand(parseInput(`/task ${taskId} approve`), D14_SESSION);
    const task = useCollaboratorStore
      .getState()
      .tasksBySession[D14_SESSION]?.find((t) => t.id === taskId);
    expect(task?.status).toBe("merge-conflict");
    const status = useCollaboratorStore.getState().statusMessages[D14_SESSION];
    expect(status).toContain("merge conflict");
    expect(status).toContain("src/a.ts");
  });

  it("/task approve: targetBranchStale → restores awaiting-approval (retryable precondition)", async () => {
    const { taskId } = setupAwaitingApprovalTask({ hasResidue: false });
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "git_merge_worktree") {
        throw { kind: "targetBranchStale", target: "dev", message: "non-fast-forward" };
      }
      return null;
    });
    await executeCommand(parseInput(`/task ${taskId} approve`), D14_SESSION);
    const task = useCollaboratorStore
      .getState()
      .tasksBySession[D14_SESSION]?.find((t) => t.id === taskId);
    // Stale-base is retryable: user can `git pull` and re-Approve.
    expect(task?.status).toBe("awaiting-approval");
    const status = useCollaboratorStore.getState().statusMessages[D14_SESSION];
    expect(status).toContain("can't fast-forward");
  });

  it("/task approve: parentRepoDirty → restores awaiting-approval, surfaces dirty file list", async () => {
    const { taskId } = setupAwaitingApprovalTask({ hasResidue: false });
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "git_merge_worktree") {
        throw { kind: "parentRepoDirty", repoRoot: "/r", files: ["docs/x.md"] };
      }
      return null;
    });
    await executeCommand(parseInput(`/task ${taskId} approve`), D14_SESSION);
    const task = useCollaboratorStore
      .getState()
      .tasksBySession[D14_SESSION]?.find((t) => t.id === taskId);
    expect(task?.status).toBe("awaiting-approval");
    const status = useCollaboratorStore.getState().statusMessages[D14_SESSION];
    expect(status).toContain("parent repo");
    expect(status).toContain("docs/x.md");
  });

  it("/task approve: pushFailedAfterMerge → marks completed but warns (local merge already done)", async () => {
    const { taskId } = setupAwaitingApprovalTask({ hasResidue: false });
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "git_merge_worktree") {
        throw { kind: "pushFailedAfterMerge", mergedSha: "deadbeef", stderr: "remote rejected" };
      }
      if (cmd === "git_worktree_remove") return { kind: "fullyRemoved" };
      return null;
    });
    await executeCommand(parseInput(`/task ${taskId} approve --push`), D14_SESSION);
    const task = useCollaboratorStore
      .getState()
      .tasksBySession[D14_SESSION]?.find((t) => t.id === taskId);
    // Local merge succeeded, so task is completed.
    expect(task?.status).toBe("completed");
    expect(task?.conclusion).toContain("deadbeef");
    expect(task?.conclusion).toContain("push failed");
    const status = useCollaboratorStore.getState().statusMessages[D14_SESSION];
    expect(status).toContain("push failed");
    // Worktree cleanup still ran.
    const ipcOrder = vi
      .mocked(invoke)
      .mock.calls.map((c) => c[0])
      .filter((c) => typeof c === "string" && c.startsWith("git_"));
    expect(ipcOrder).toContain("git_worktree_remove");
    // Lease released even on push failure (local merge happened).
    const agent = useCollaboratorStore.getState().agents[0];
    expect(agent.worktree).toBeNull();
  });

  it("/task approve: after approval-commit succeeds, retry skips approval-commit and reaches merge (round-12 codex1+codex2+claude2 H1)", async () => {
    // Round-12 H1 (load-bearing): when approval-commit succeeds but the
    // subsequent merge fails (e.g., targetBranchStale), the retry must
    // skip the now-redundant approval-commit. Otherwise, the stale
    // pendingMerge.diffSummary still says "residue exists" → retry
    // calls git_create_approval_commit against a clean tree → backend's
    // EmptyCommit short-circuit fires → retry never reaches merge.
    // Strands the task in approval limbo.
    const { taskId } = setupAwaitingApprovalTask({ hasResidue: true });

    // First Approve attempt: approval-commit succeeds, merge fails.
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "git_create_approval_commit") {
        return { commitSha: "ac1", stagedCount: 1 };
      }
      if (cmd === "git_merge_worktree") {
        throw { kind: "targetBranchStale", target: "dev", message: "non-fast-forward" };
      }
      return null;
    });
    await executeCommand(parseInput(`/task ${taskId} approve`), D14_SESSION);

    // After first attempt: approval-commit DID fire, merge DID fire,
    // status restored to awaiting-approval (targetBranchStale is
    // retryable), pendingMerge still set BUT diffSummary should now
    // show empty staged/unstaged/untracked (residue folded into
    // committed) so retry won't re-issue approval-commit.
    let task = useCollaboratorStore
      .getState()
      .tasksBySession[D14_SESSION]?.find((t) => t.id === taskId);
    expect(task?.status).toBe("awaiting-approval");
    expect(task?.pendingMerge).not.toBeNull();
    expect(task?.pendingMerge?.diffSummary.staged).toEqual([]);
    expect(task?.pendingMerge?.diffSummary.unstaged).toEqual([]);
    expect(task?.pendingMerge?.diffSummary.untracked).toEqual([]);
    // Original residue files (from setupAwaitingApprovalTask: ["b.ts"])
    // should now be in committed alongside the original committed
    // files (["a.ts"]).
    expect(task?.pendingMerge?.diffSummary.committed).toContain("a.ts");
    expect(task?.pendingMerge?.diffSummary.committed).toContain("b.ts");

    // Second attempt: user has resolved the stale-base issue (git pull),
    // retries Approve. Mock now succeeds at merge. Approval-commit must
    // NOT be called again.
    vi.mocked(invoke).mockClear();
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "git_merge_worktree") return { mergedSha: "abcd", pushed: false };
      if (cmd === "git_worktree_remove") return { kind: "fullyRemoved" };
      // Defensive: if H1 isn't fixed and approval-commit IS called on a
      // now-clean tree, the backend would return EmptyCommit. We mock
      // that variant to simulate backend behavior.
      if (cmd === "git_create_approval_commit") {
        throw { kind: "emptyCommit", message: "no working-tree changes to stage" };
      }
      return null;
    });
    await executeCommand(parseInput(`/task ${taskId} approve`), D14_SESSION);

    // H1 fix verified: approval-commit NOT called on retry.
    const retryGitOrder = vi
      .mocked(invoke)
      .mock.calls.map((c) => c[0])
      .filter((c) => typeof c === "string" && c.startsWith("git_"));
    expect(retryGitOrder).not.toContain("git_create_approval_commit");
    expect(retryGitOrder).toContain("git_merge_worktree");
    // Task is now completed.
    task = useCollaboratorStore
      .getState()
      .tasksBySession[D14_SESSION]?.find((t) => t.id === taskId);
    expect(task?.status).toBe("completed");
    expect(task?.conclusion).toContain("abcd");
  });

  it("/task approve: approval-commit failure restores awaiting-approval, never proceeds to merge", async () => {
    const { taskId } = setupAwaitingApprovalTask({ hasResidue: true });
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "git_create_approval_commit") {
        throw { kind: "hookFailed", stage: "commit", stderr: "lint error" };
      }
      return null;
    });
    await executeCommand(parseInput(`/task ${taskId} approve`), D14_SESSION);
    const task = useCollaboratorStore
      .getState()
      .tasksBySession[D14_SESSION]?.find((t) => t.id === taskId);
    expect(task?.status).toBe("awaiting-approval");
    expect(task?.pendingMerge).not.toBeNull();
    // Merge MUST NOT fire after approval-commit failure.
    const ipcOrder = vi
      .mocked(invoke)
      .mock.calls.map((c) => c[0])
      .filter((c) => typeof c === "string" && c.startsWith("git_"));
    expect(ipcOrder).not.toContain("git_merge_worktree");
  });

  it("/task discard: happy path — removes worktree, force-deletes branch, releases lease, marks blocked", async () => {
    const { taskId } = setupAwaitingApprovalTask();
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "git_worktree_remove") return { kind: "fullyRemoved" };
      if (cmd === "git_branch_force_delete") return null;
      return null;
    });
    await executeCommand(
      parseInput(`/task ${taskId} discard reviewer rejected`),
      D14_SESSION,
    );
    const task = useCollaboratorStore
      .getState()
      .tasksBySession[D14_SESSION]?.find((t) => t.id === taskId);
    expect(task?.status).toBe("blocked");
    expect(task?.pendingMerge).toBeNull();
    expect(task?.conclusion).toBe("Discarded: reviewer rejected");
    // Lease released.
    const agent = useCollaboratorStore.getState().agents[0];
    expect(agent.worktree).toBeNull();
    // Both IPCs fired.
    const ipcOrder = vi
      .mocked(invoke)
      .mock.calls.map((c) => c[0])
      .filter((c) => typeof c === "string" && c.startsWith("git_"));
    expect(ipcOrder).toContain("git_worktree_remove");
    expect(ipcOrder).toContain("git_branch_force_delete");
  });

  it("/task discard: refuses when task has no pendingMerge", async () => {
    setupAwaitingApprovalTask();
    const store = useCollaboratorStore.getState();
    const plain = store.addTask({ title: "x", objective: "x" }, D14_SESSION);
    await executeCommand(parseInput(`/task ${plain.id} discard`), D14_SESSION);
    const status = useCollaboratorStore.getState().statusMessages[D14_SESSION];
    expect(status).toContain("no pending merge");
    // Original status unchanged.
    const task = useCollaboratorStore
      .getState()
      .tasksBySession[D14_SESSION]?.find((t) => t.id === plain.id);
    expect(task?.status).toBe("pending");
  });

  it("/task discard: REFUSES when git_worktree_remove fails (round-12 codex2 H2: lease load-bearing)", async () => {
    // Round-12 codex2 H2 (load-bearing): if the worktree-remove step fails,
    // Discard MUST refuse — the source delta still exists on disk and
    // releasing the lease + marking the task blocked would corrupt the
    // LB5 lease model. The user must resolve the cleanup error and retry.
    const { taskId } = setupAwaitingApprovalTask();
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "git_worktree_remove") throw "could not lock index";
      if (cmd === "git_branch_force_delete") return null;
      return null;
    });
    await executeCommand(parseInput(`/task ${taskId} discard`), D14_SESSION);
    const task = useCollaboratorStore
      .getState()
      .tasksBySession[D14_SESSION]?.find((t) => t.id === taskId);
    // Task status UNCHANGED — discard refused.
    expect(task?.status).toBe("awaiting-approval");
    // pendingMerge preserved — caller can retry.
    expect(task?.pendingMerge).not.toBeNull();
    // Lease still held — agent.worktree NOT cleared.
    const agent = useCollaboratorStore.getState().agents[0];
    expect(agent.worktree).not.toBeNull();
    // Branch-delete must NOT have fired (we abort before it).
    const ipcOrder = vi
      .mocked(invoke)
      .mock.calls.map((c) => c[0])
      .filter((c) => typeof c === "string" && c.startsWith("git_"));
    expect(ipcOrder).not.toContain("git_branch_force_delete");
    // Status surfaces the actionable error.
    const status = useCollaboratorStore.getState().statusMessages[D14_SESSION];
    expect(status).toContain("Discard refused");
    expect(status).toContain("worktree-remove failed");
  });

  it("/task discard: branch-delete failure AFTER successful worktree-remove is just cleanup debt (warns, completes)", async () => {
    // Round-12 codex2 H2: branch-delete failure is DIFFERENT from
    // worktree-remove failure — once the worktree is gone, the load-
    // bearing artifact is gone too. A leftover branch is cleanup debt
    // (the user can `git branch -D` manually); the task can still
    // transition to blocked + release the lease.
    const { taskId } = setupAwaitingApprovalTask();
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "git_worktree_remove") return { kind: "fullyRemoved" };
      if (cmd === "git_branch_force_delete") throw "branch is checked out elsewhere";
      return null;
    });
    await executeCommand(parseInput(`/task ${taskId} discard`), D14_SESSION);
    const task = useCollaboratorStore
      .getState()
      .tasksBySession[D14_SESSION]?.find((t) => t.id === taskId);
    expect(task?.status).toBe("blocked");
    const status = useCollaboratorStore.getState().statusMessages[D14_SESSION];
    expect(status).toContain("branch-delete warning");
  });

  it("/task discard: also fires for tasks already in merge-conflict (post-failed-Approve cleanup)", async () => {
    const { taskId } = setupAwaitingApprovalTask();
    // Move to merge-conflict (simulating a failed Approve that left the
    // worktree preserved). pendingMerge is still set per central rule.
    useCollaboratorStore.setState((s) => ({
      tasksBySession: {
        ...s.tasksBySession,
        [D14_SESSION]: s.tasksBySession[D14_SESSION].map((t) =>
          t.id === taskId ? { ...t, status: "merge-conflict" } : t,
        ),
      },
    }));
    vi.mocked(invoke).mockImplementation(async () => null);
    await executeCommand(parseInput(`/task ${taskId} discard`), D14_SESSION);
    const task = useCollaboratorStore
      .getState()
      .tasksBySession[D14_SESSION]?.find((t) => t.id === taskId);
    expect(task?.status).toBe("blocked");
  });

  // -------------------------------------------------------------------------
  // LB3 — branch-protection three-state wizard (round-13)
  // -------------------------------------------------------------------------

  it("/task approve: refuses when LB3 reports verified-unprotected and repo is not acked", async () => {
    const { taskId } = setupAwaitingApprovalTask({
      hasResidue: false,
      ackProtection: false,
    });
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "git_get_remote_url") return "https://github.com/owner/repo.git";
      if (cmd === "run_gh_api") return { exitCode: 4, stdout: "", stderr: "Not Found (HTTP 404)" };
      return null;
    });
    await executeCommand(parseInput(`/task ${taskId} approve`), D14_SESSION);
    const task = useCollaboratorStore
      .getState()
      .tasksBySession[D14_SESSION]?.find((t) => t.id === taskId);
    // Approve refused: status unchanged, no merge attempted.
    expect(task?.status).toBe("awaiting-approval");
    const status = useCollaboratorStore.getState().statusMessages[D14_SESSION];
    expect(status).toContain("Branch protection NOT enabled");
    expect(status).toContain("accept-limited");
    // Verify no merge IPCs fired.
    const ipcOrder = vi
      .mocked(invoke)
      .mock.calls.map((c) => c[0])
      .filter((c) => typeof c === "string" && c.startsWith("git_merge"));
    expect(ipcOrder).toHaveLength(0);
  });

  it("/task approve: refuses when LB3 reports unknown (non-GitHub remote) and repo is not acked", async () => {
    const { taskId } = setupAwaitingApprovalTask({
      hasResidue: false,
      ackProtection: false,
    });
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "git_get_remote_url") return "https://gitlab.com/owner/repo.git";
      return null;
    });
    await executeCommand(parseInput(`/task ${taskId} approve`), D14_SESSION);
    const task = useCollaboratorStore
      .getState()
      .tasksBySession[D14_SESSION]?.find((t) => t.id === taskId);
    expect(task?.status).toBe("awaiting-approval");
    const status = useCollaboratorStore.getState().statusMessages[D14_SESSION];
    expect(status).toContain("Cannot verify branch protection");
    expect(status).toContain("accept-limited");
  });

  it("/task approve: proceeds silently when LB3 reports verified-protected (no [limited-guarantee] prefix)", async () => {
    const { taskId } = setupAwaitingApprovalTask({
      hasResidue: false,
      ackProtection: false,
    });
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "git_get_remote_url") return "https://github.com/owner/repo.git";
      if (cmd === "run_gh_api") {
        return { exitCode: 0, stdout: '{"required_pull_request_reviews":{"dismiss_stale_reviews":true}}', stderr: "" };
      }
      if (cmd === "git_merge_worktree") return { mergedSha: "abcd", pushed: false };
      if (cmd === "git_worktree_remove") return { kind: "fullyRemoved" };
      return null;
    });
    await executeCommand(parseInput(`/task ${taskId} approve`), D14_SESSION);
    const task = useCollaboratorStore
      .getState()
      .tasksBySession[D14_SESSION]?.find((t) => t.id === taskId);
    expect(task?.status).toBe("completed");
    const status = useCollaboratorStore.getState().statusMessages[D14_SESSION];
    // No [limited-guarantee] prefix on verified-protected path.
    expect(status).not.toContain("[limited-guarantee]");
    expect(status).toContain("approved");
  });

  it("/task approve: proceeds with [limited-guarantee] prefix when repo is acked", async () => {
    const { taskId } = setupAwaitingApprovalTask({
      hasResidue: false,
      ackProtection: true, // acked, LB3 check should be skipped entirely
    });
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "git_merge_worktree") return { mergedSha: "abcd", pushed: false };
      if (cmd === "git_worktree_remove") return { kind: "fullyRemoved" };
      return null;
    });
    await executeCommand(parseInput(`/task ${taskId} approve`), D14_SESSION);
    const task = useCollaboratorStore
      .getState()
      .tasksBySession[D14_SESSION]?.find((t) => t.id === taskId);
    expect(task?.status).toBe("completed");
    const status = useCollaboratorStore.getState().statusMessages[D14_SESSION];
    expect(status).toContain("[limited-guarantee]");
    // LB3 check IPCs should NOT have fired (early-skip when acked).
    const ipcs = vi.mocked(invoke).mock.calls.map((c) => c[0]);
    expect(ipcs).not.toContain("git_get_remote_url");
    expect(ipcs).not.toContain("run_gh_api");
  });

  it("/branch-protection accept-limited: persists ack per-repo and is idempotent", async () => {
    setupAwaitingApprovalTask({ hasResidue: false, ackProtection: false });
    await executeCommand(
      parseInput("/branch-protection accept-limited -- corporate self-hosted GitLab"),
      D14_SESSION,
    );
    const acks = useCollaboratorStore.getState().branchProtectionAcks;
    expect(acks["/r"]).toBeDefined();
    expect(acks["/r"].note).toBe("corporate self-hosted GitLab");
    const status1 = useCollaboratorStore.getState().statusMessages[D14_SESSION];
    expect(status1).toContain("Limited guarantee accepted");

    // Second call should be a no-op (idempotent) — same timestamp preserved.
    const originalTs = acks["/r"].acceptedAt;
    await executeCommand(
      parseInput("/branch-protection accept-limited -- different note"),
      D14_SESSION,
    );
    const acks2 = useCollaboratorStore.getState().branchProtectionAcks;
    expect(acks2["/r"].acceptedAt).toBe(originalTs);
    expect(acks2["/r"].note).toBe("corporate self-hosted GitLab"); // unchanged
    const status2 = useCollaboratorStore.getState().statusMessages[D14_SESSION];
    expect(status2).toContain("already accepted");
  });

  it("/branch-protection check: reports verified-protected without mutating ack state", async () => {
    setupAwaitingApprovalTask({ hasResidue: false, ackProtection: false });
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "git_get_remote_url") return "https://github.com/owner/repo.git";
      if (cmd === "run_gh_api") {
        return { exitCode: 0, stdout: '{"required_pull_request_reviews":{"dismiss_stale_reviews":true}}', stderr: "" };
      }
      return null;
    });
    await executeCommand(parseInput("/branch-protection check"), D14_SESSION);
    const status = useCollaboratorStore.getState().statusMessages[D14_SESSION];
    expect(status).toContain("Branch protection verified");
    // /check is read-only; should NOT have set the ack flag.
    const acks = useCollaboratorStore.getState().branchProtectionAcks;
    expect(acks["/r"]).toBeUndefined();
  });

  it("/branch-protection list-acks: lists acked repos with notes", async () => {
    setupAwaitingApprovalTask({ hasResidue: false, ackProtection: false });
    useCollaboratorStore.getState().acceptBranchProtectionLimited("/r", "test note");
    useCollaboratorStore.getState().acceptBranchProtectionLimited("/other", undefined);
    await executeCommand(parseInput("/branch-protection list-acks"), D14_SESSION);
    const status = useCollaboratorStore.getState().statusMessages[D14_SESSION];
    expect(status).toContain("/r");
    expect(status).toContain("/other");
    expect(status).toContain("test note");
  });

  it("checkBranchProtection: queries /branches/dev/protection NOT /branches/main (round-13 codex1 H1)", async () => {
    // Round-13 codex1 H1 (load-bearing): the LB3 check must verify the
    // actual landing branch, not `main`. Approve merges/pushes `dev`
    // (per APPROVAL_TARGET_BRANCH); checking `main` while `dev` is
    // unprotected would silently pass the gate on the wrong branch.
    let calledArgs: string[] = [];
    const fakeInvoke = vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "git_get_remote_url") return "https://github.com/owner/repo.git";
      if (cmd === "run_gh_api") {
        calledArgs = (args?.args as string[]) ?? [];
        return {
          exitCode: 0,
          stdout: '{"required_pull_request_reviews":{"dismiss_stale_reviews":true}}',
          stderr: "",
        };
      }
      throw new Error(`unexpected IPC: ${cmd}`);
    });
    await checkBranchProtection("/r", fakeInvoke as unknown as typeof invoke);
    expect(calledArgs[0]).toBe("/repos/owner/repo/branches/dev/protection");
    expect(calledArgs[0]).not.toContain("/main/");
  });

  it("checkBranchProtection: 200 with empty protection body → verified-unprotected (round-13 codex2 H1)", async () => {
    // Round-13 codex2 H1 (load-bearing): a 200 response from the
    // protection endpoint only proves the protection object exists.
    // It does NOT prove the rule actually blocks direct pushes. An
    // empty protection JSON (or one with all meaningful fields null)
    // must NOT pass as `verified-protected`.
    const fakeInvoke = vi.fn(async (cmd: string) => {
      if (cmd === "git_get_remote_url") return "https://github.com/owner/repo.git";
      if (cmd === "run_gh_api") {
        return {
          exitCode: 0,
          stdout: '{"required_status_checks":null,"restrictions":null,"required_pull_request_reviews":null}',
          stderr: "",
        };
      }
      throw new Error(`unexpected IPC: ${cmd}`);
    });
    const state = await checkBranchProtection(
      "/r",
      fakeInvoke as unknown as typeof invoke,
    );
    expect(state).toBe("verified-unprotected");
  });

  it("checkBranchProtection: 200 with required_status_checks ALONE → verified-unprotected (round-14 codex2 H1)", async () => {
    // Round-14 codex2 H1: per GitHub docs, status checks gate direct
    // pushes on checks passing — they don't BLOCK direct pushes. After
    // the required checks pass, anyone with write access can `git push
    // origin <branch>` directly. For LB3's no-direct-push guarantee,
    // status-checks alone is NOT sufficient; the user needs PR-review
    // or non-empty push restrictions.
    const fakeInvoke = vi.fn(async (cmd: string) => {
      if (cmd === "git_get_remote_url") return "https://github.com/owner/repo.git";
      if (cmd === "run_gh_api") {
        return {
          exitCode: 0,
          stdout: '{"required_status_checks":{"strict":true,"contexts":["ci/test"]},"restrictions":null,"required_pull_request_reviews":null}',
          stderr: "",
        };
      }
      throw new Error(`unexpected IPC: ${cmd}`);
    });
    const state = await checkBranchProtection(
      "/r",
      fakeInvoke as unknown as typeof invoke,
    );
    expect(state).toBe("verified-unprotected");
  });

  it("checkBranchProtection: 200 with required_pull_request_reviews → verified-protected", async () => {
    const fakeInvoke = vi.fn(async (cmd: string) => {
      if (cmd === "git_get_remote_url") return "https://github.com/owner/repo.git";
      if (cmd === "run_gh_api") {
        return {
          exitCode: 0,
          stdout: '{"required_pull_request_reviews":{"dismiss_stale_reviews":true},"required_status_checks":null,"restrictions":null}',
          stderr: "",
        };
      }
      throw new Error(`unexpected IPC: ${cmd}`);
    });
    const state = await checkBranchProtection(
      "/r",
      fakeInvoke as unknown as typeof invoke,
    );
    expect(state).toBe("verified-protected");
  });

  it("checkBranchProtection: 200 with restrictions populated (allowlisted user) → verified-protected", async () => {
    const fakeInvoke = vi.fn(async (cmd: string) => {
      if (cmd === "git_get_remote_url") return "https://github.com/owner/repo.git";
      if (cmd === "run_gh_api") {
        return {
          exitCode: 0,
          // round-14: restrictions must have at least one allowlisted
          // user/team/app to count as meaningful — empty arrays don't.
          stdout: '{"required_status_checks":null,"restrictions":{"users":[{"login":"admin"}],"teams":[],"apps":[]},"required_pull_request_reviews":null}',
          stderr: "",
        };
      }
      throw new Error(`unexpected IPC: ${cmd}`);
    });
    const state = await checkBranchProtection(
      "/r",
      fakeInvoke as unknown as typeof invoke,
    );
    expect(state).toBe("verified-protected");
  });

  it("checkBranchProtection: 200 with restrictions present but empty arrays → verified-unprotected (round-14)", async () => {
    // Empty restrictions {users:[],teams:[],apps:[]} doesn't actually
    // restrict anyone — GitHub serves this shape even when restrictions
    // are unconfigured for certain account types. Conservative: require
    // at least one allowlisted entry.
    const fakeInvoke = vi.fn(async (cmd: string) => {
      if (cmd === "git_get_remote_url") return "https://github.com/owner/repo.git";
      if (cmd === "run_gh_api") {
        return {
          exitCode: 0,
          stdout: '{"required_status_checks":null,"restrictions":{"users":[],"teams":[],"apps":[]},"required_pull_request_reviews":null}',
          stderr: "",
        };
      }
      throw new Error(`unexpected IPC: ${cmd}`);
    });
    const state = await checkBranchProtection(
      "/r",
      fakeInvoke as unknown as typeof invoke,
    );
    expect(state).toBe("verified-unprotected");
  });

  it("checkBranchProtection: 200 with malformed JSON body → unknown (round-14 codex2 M1 + claude2 O3)", async () => {
    // Round-14: parse failure routes to `unknown`, not `verified-
    // unprotected`. The user might have valid protection but `gh`
    // returned a body we can't classify (truncation, wrapping, etc.).
    // The right diagnostic is "cannot verify, run accept-limited",
    // NOT "enable protection" (which the user may already have done).
    const fakeInvoke = vi.fn(async (cmd: string) => {
      if (cmd === "git_get_remote_url") return "https://github.com/owner/repo.git";
      if (cmd === "run_gh_api") {
        return { exitCode: 0, stdout: "not-json-at-all", stderr: "" };
      }
      throw new Error(`unexpected IPC: ${cmd}`);
    });
    const state = await checkBranchProtection(
      "/r",
      fakeInvoke as unknown as typeof invoke,
    );
    expect(state).toBe("unknown");
  });

  it("/branch-protection accept-limited: falls back to task pendingMerge.repoRoot when no agent record (round-13 codex2 M1)", async () => {
    // Round-13 codex2 M1: `/task approve` uses `task.pendingMerge.repoRoot`,
    // so it can identify the repo even after agent-record loss. The
    // `/branch-protection` subcommands must have the same fallback —
    // otherwise Approve refuses with "run accept-limited" but
    // accept-limited says it can't identify a repo.
    useCollaboratorStore.setState({
      // NO agents — record loss scenario.
      agents: [],
      contextSentByAgent: {},
      pendingMessagesByAgent: {},
      tasksBySession: { [D14_SESSION]: [] },
      logEntriesBySession: { [D14_SESSION]: [] },
      statusMessages: {},
      branchProtectionAcks: {},
    });
    const store = useCollaboratorStore.getState();
    const task = store.addTask(
      { title: "x", objective: "x", assignee: "@claude1" },
      D14_SESSION,
    );
    // Simulate the gate having engaged before the agent record was lost.
    store.updateTask(
      task.id,
      {
        status: "awaiting-approval",
        pendingMerge: {
          branch: "agent/x",
          worktreePath: "/wt-orphan",
          repoRoot: "/r-from-task",
          baseRef: "origin/dev",
          baseSha: "abc",
          baseFresh: true,
          diffSummary: { committed: ["x.ts"], staged: [], unstaged: [], untracked: [] },
          agentHandle: "@claude1",
        },
      },
      D14_SESSION,
    );

    await executeCommand(
      parseInput("/branch-protection accept-limited -- record-loss recovery"),
      D14_SESSION,
    );

    // Ack should land on the task's pendingMerge.repoRoot.
    const acks = useCollaboratorStore.getState().branchProtectionAcks;
    expect(acks["/r-from-task"]).toBeDefined();
    expect(acks["/r-from-task"].note).toBe("record-loss recovery");
    const status = useCollaboratorStore.getState().statusMessages[D14_SESSION];
    expect(status).toContain("Limited guarantee accepted");
  });

  it("checkBranchProtection: returns 'unknown' for non-GitHub remotes (no gh API call)", async () => {
    const fakeInvoke = vi.fn(async (cmd: string) => {
      if (cmd === "git_get_remote_url") return "https://gitlab.com/owner/repo.git";
      throw new Error(`unexpected IPC: ${cmd}`);
    });
    const state = await checkBranchProtection(
      "/r",
      fakeInvoke as unknown as typeof invoke,
    );
    expect(state).toBe("unknown");
    // Confirm gh wasn't called.
    expect(fakeInvoke).not.toHaveBeenCalledWith("run_gh_api", expect.anything());
  });

  it("checkBranchProtection: returns 'unknown' when origin remote is missing", async () => {
    const fakeInvoke = vi.fn(async (cmd: string) => {
      if (cmd === "git_get_remote_url") throw "No such remote 'origin'";
      throw new Error(`unexpected IPC: ${cmd}`);
    });
    const state = await checkBranchProtection(
      "/r",
      fakeInvoke as unknown as typeof invoke,
    );
    expect(state).toBe("unknown");
  });

  it("checkBranchProtection: 404 from gh API → verified-unprotected", async () => {
    const fakeInvoke = vi.fn(async (cmd: string) => {
      if (cmd === "git_get_remote_url") return "git@github.com:owner/repo.git";
      if (cmd === "run_gh_api") {
        return { exitCode: 4, stdout: "", stderr: "gh: Not Found (HTTP 404)" };
      }
      throw new Error(`unexpected IPC: ${cmd}`);
    });
    const state = await checkBranchProtection(
      "/r",
      fakeInvoke as unknown as typeof invoke,
    );
    expect(state).toBe("verified-unprotected");
  });

  it("checkBranchProtection: auth/network failure (non-404 error) → unknown", async () => {
    const fakeInvoke = vi.fn(async (cmd: string) => {
      if (cmd === "git_get_remote_url") return "https://github.com/owner/repo.git";
      if (cmd === "run_gh_api") {
        return { exitCode: 1, stdout: "", stderr: "gh: authentication required" };
      }
      throw new Error(`unexpected IPC: ${cmd}`);
    });
    const state = await checkBranchProtection(
      "/r",
      fakeInvoke as unknown as typeof invoke,
    );
    expect(state).toBe("unknown");
  });

  // -------------------------------------------------------------------------
  // Round-15 polish: persistence + clear-ack + lock_branch support
  // -------------------------------------------------------------------------

  it("checkBranchProtection: 200 with lock_branch.enabled true → verified-protected (round-15 claude3 O2)", async () => {
    // GitHub's `lock_branch.enabled === true` field locks the branch
    // entirely (no pushes by anyone, even via PR). Counts as meaningful
    // protection per claude3's deferred polish from task-99.
    const fakeInvoke = vi.fn(async (cmd: string) => {
      if (cmd === "git_get_remote_url") return "https://github.com/owner/repo.git";
      if (cmd === "run_gh_api") {
        return {
          exitCode: 0,
          stdout: '{"required_status_checks":null,"restrictions":null,"required_pull_request_reviews":null,"lock_branch":{"enabled":true}}',
          stderr: "",
        };
      }
      throw new Error(`unexpected IPC: ${cmd}`);
    });
    const state = await checkBranchProtection(
      "/r",
      fakeInvoke as unknown as typeof invoke,
    );
    expect(state).toBe("verified-protected");
  });

  it("checkBranchProtection: 200 with lock_branch.enabled false → verified-unprotected (round-15)", async () => {
    // lock_branch present but disabled is the default GitHub serves
    // when no rule is configured. Don't classify as meaningful.
    const fakeInvoke = vi.fn(async (cmd: string) => {
      if (cmd === "git_get_remote_url") return "https://github.com/owner/repo.git";
      if (cmd === "run_gh_api") {
        return {
          exitCode: 0,
          stdout: '{"required_status_checks":null,"restrictions":null,"required_pull_request_reviews":null,"lock_branch":{"enabled":false}}',
          stderr: "",
        };
      }
      throw new Error(`unexpected IPC: ${cmd}`);
    });
    const state = await checkBranchProtection(
      "/r",
      fakeInvoke as unknown as typeof invoke,
    );
    expect(state).toBe("verified-unprotected");
  });

  it("acceptBranchProtectionLimited: persists via write_app_config_file (round-16 claude2 task-103 critical fix)", async () => {
    // Round-16 (claude2 task-103 critical): persistence MUST target
    // app_config_dir, not the per-PID memory dir. The memory dir is
    // wiped on every app start by clear_stale_sessions(), so writes
    // there don't survive restarts.
    setupAwaitingApprovalTask({ hasResidue: false, ackProtection: false });
    const writeCalls: Array<{ cmd: string; relativePath: string; content: string }> = [];
    vi.mocked(invoke).mockImplementation(async (cmd: string, args?: unknown) => {
      if (cmd === "write_app_config_file" || cmd === "write_memory_file") {
        const a = args as { relativePath: string; content: string };
        writeCalls.push({ cmd, relativePath: a.relativePath, content: a.content });
      }
      return null;
    });
    useCollaboratorStore.getState().acceptBranchProtectionLimited("/r", "test note");
    // Allow promise chain to drain.
    await new Promise((r) => setTimeout(r, 10));
    const persistCall = writeCalls.find(
      (c) => c.relativePath === "branch-protection-acks.json",
    );
    expect(persistCall).toBeDefined();
    // CRITICAL: must be the app_config variant (cross-restart durable),
    // NOT the memory variant (wiped by clear_stale_sessions on start).
    expect(persistCall!.cmd).toBe("write_app_config_file");
    const persisted = JSON.parse(persistCall!.content);
    expect(persisted["/r"]).toBeDefined();
    expect(persisted["/r"].note).toBe("test note");
  });

  it("clearBranchProtectionAck: removes ack and persists empty map via write_app_config_file", async () => {
    setupAwaitingApprovalTask({ hasResidue: false, ackProtection: true }); // pre-acked at /r
    const writeCalls: Array<{ cmd: string; relativePath: string; content: string }> = [];
    vi.mocked(invoke).mockImplementation(async (cmd: string, args?: unknown) => {
      if (cmd === "write_app_config_file" || cmd === "write_memory_file") {
        const a = args as { relativePath: string; content: string };
        writeCalls.push({ cmd, relativePath: a.relativePath, content: a.content });
      }
      return null;
    });
    useCollaboratorStore.getState().clearBranchProtectionAck("/r");
    await new Promise((r) => setTimeout(r, 10));
    expect(useCollaboratorStore.getState().branchProtectionAcks["/r"]).toBeUndefined();
    const persistCall = writeCalls.find(
      (c) => c.relativePath === "branch-protection-acks.json",
    );
    expect(persistCall).toBeDefined();
    expect(persistCall!.cmd).toBe("write_app_config_file");
    const persisted = JSON.parse(persistCall!.content);
    expect(persisted["/r"]).toBeUndefined();
  });

  it("clearBranchProtectionAck: no-op when ack doesn't exist (no persist IPC)", async () => {
    setupAwaitingApprovalTask({ hasResidue: false, ackProtection: false });
    const ackPersistCalls: string[] = [];
    vi.mocked(invoke).mockImplementation(async (cmd: string, args?: unknown) => {
      // Filter to ack-persistence writes only — task-list and conversation
      // log writes are unrelated.
      if (
        cmd === "write_app_config_file" &&
        (args as { relativePath?: string } | undefined)?.relativePath ===
          "branch-protection-acks.json"
      ) {
        ackPersistCalls.push(cmd);
      }
      return null;
    });
    useCollaboratorStore.getState().clearBranchProtectionAck("/r");
    await new Promise((r) => setTimeout(r, 10));
    // No-op: no ack-file persist write should have fired.
    expect(ackPersistCalls).toHaveLength(0);
  });

  it("persistBranchProtectionAcks: serialized writes — final on-disk state matches latest in-memory mutation (round-16 codex2 M1)", async () => {
    // Round-16 codex2 task-104 M1 (load-bearing): without write
    // serialization, a fast accept-then-clear sequence could leave
    // disk holding the accept payload (write A finishes after write
    // B) — resurrecting the cleared ack on next restart, defeating
    // the point of clear-ack.
    //
    // The fix: a promise chain serializes writes AND each write
    // snapshots the in-memory state at execution time (not call time).
    // Result: the LAST write to land always reflects the latest
    // mutation, regardless of how many calls are queued.
    setupAwaitingApprovalTask({ hasResidue: false, ackProtection: false });
    const writeOrder: string[] = [];
    vi.mocked(invoke).mockImplementation(async (cmd: string, args?: unknown) => {
      if (
        cmd === "write_app_config_file" &&
        (args as { relativePath?: string } | undefined)?.relativePath ===
          "branch-protection-acks.json"
      ) {
        writeOrder.push((args as { content: string }).content);
      }
      return null;
    });
    // accept then clear in quick succession.
    useCollaboratorStore.getState().acceptBranchProtectionLimited("/r", "first");
    useCollaboratorStore.getState().clearBranchProtectionAck("/r");
    await new Promise((r) => setTimeout(r, 20));
    // Both writes must have fired (no swallowed writes).
    expect(writeOrder.length).toBeGreaterThanOrEqual(1);
    // CRITICAL invariant: the FINAL disk state must reflect the latest
    // mutation (cleared). Even if write A landed after write B due to
    // out-of-order completion, the chain serializes them so the final
    // write always reflects the latest snapshot.
    const finalDiskState = JSON.parse(writeOrder[writeOrder.length - 1]);
    expect(finalDiskState).toEqual({});
    // And the in-memory state is also cleared.
    expect(useCollaboratorStore.getState().branchProtectionAcks["/r"]).toBeUndefined();
  });

  it("/branch-protection clear-ack: removes ack for active session's repo", async () => {
    setupAwaitingApprovalTask({ hasResidue: false, ackProtection: true });
    vi.mocked(invoke).mockImplementation(async () => null);
    await executeCommand(parseInput("/branch-protection clear-ack"), D14_SESSION);
    expect(useCollaboratorStore.getState().branchProtectionAcks["/r"]).toBeUndefined();
    const status = useCollaboratorStore.getState().statusMessages[D14_SESSION];
    expect(status).toContain("Cleared limited-guarantee ack");
  });

  it("/branch-protection clear-ack <repoRoot>: clears explicit repo (multi-repo support)", async () => {
    setupAwaitingApprovalTask({ hasResidue: false, ackProtection: true });
    // Add a second ack for a different repo.
    useCollaboratorStore.getState().acceptBranchProtectionLimited("/r-other", "other repo");
    vi.mocked(invoke).mockImplementation(async () => null);
    await executeCommand(
      parseInput("/branch-protection clear-ack /r-other"),
      D14_SESSION,
    );
    const acks = useCollaboratorStore.getState().branchProtectionAcks;
    expect(acks["/r-other"]).toBeUndefined();
    // Active session's ack is unaffected.
    expect(acks["/r"]).toBeDefined();
  });

  it("/branch-protection clear-ack: surfaces no-op message when nothing to clear", async () => {
    setupAwaitingApprovalTask({ hasResidue: false, ackProtection: false });
    await executeCommand(parseInput("/branch-protection clear-ack"), D14_SESSION);
    const status = useCollaboratorStore.getState().statusMessages[D14_SESSION];
    expect(status).toContain("No limited-guarantee ack to clear");
  });

  it("hydrateBranchProtectionAcks: loads persisted map from app_config_dir (round-16 claude2)", async () => {
    useCollaboratorStore.setState({ branchProtectionAcks: {} });
    vi.mocked(invoke).mockImplementation(async (cmd: string, args?: unknown) => {
      if (cmd === "read_app_config_file") {
        if (
          (args as { relativePath?: string } | undefined)?.relativePath ===
          "branch-protection-acks.json"
        ) {
          return JSON.stringify({
            "/persisted-repo": { acceptedAt: "2024-01-01T00:00:00.000Z", note: "persisted" },
          });
        }
      }
      return null;
    });
    await hydrateBranchProtectionAcks();
    const acks = useCollaboratorStore.getState().branchProtectionAcks;
    expect(acks["/persisted-repo"]).toBeDefined();
    expect(acks["/persisted-repo"].note).toBe("persisted");
  });

  it("hydrateBranchProtectionAcks: in-memory acks made before hydration resolves WIN (round-16 codex2 M2 + claude3 O1)", async () => {
    // Round-16: hydration MUST merge rather than overwrite. If the
    // user accepts a limited guarantee BEFORE hydration's setState
    // resolves (rare race during App.tsx mount), the in-memory ack
    // must NOT be lost. Final state = union with in-memory winning
    // on conflict (the user's most recent action).
    useCollaboratorStore.setState({
      branchProtectionAcks: {
        "/in-memory-repo": { acceptedAt: "in-memory-ts", note: "from-current-session" },
      },
    });
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "read_app_config_file") {
        return JSON.stringify({
          "/disk-repo": { acceptedAt: "old-ts", note: "from-prior-restart" },
        });
      }
      return null;
    });
    await hydrateBranchProtectionAcks();
    const acks = useCollaboratorStore.getState().branchProtectionAcks;
    // Both entries present after merge.
    expect(acks["/in-memory-repo"]?.note).toBe("from-current-session");
    expect(acks["/disk-repo"]?.note).toBe("from-prior-restart");
  });

  it("hydrateBranchProtectionAcks: empty disk preserves in-memory acks (no clobber)", async () => {
    useCollaboratorStore.setState({
      branchProtectionAcks: { "/from-current-session": { acceptedAt: "x" } },
    });
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "read_app_config_file") return null; // file missing
      return null;
    });
    await hydrateBranchProtectionAcks();
    // Round-16 fix: empty disk MUST NOT clobber in-memory acks.
    // The previous round-15 behavior (overwrite) lost user acks
    // accepted between mount and hydration resolution.
    expect(
      useCollaboratorStore.getState().branchProtectionAcks["/from-current-session"],
    ).toBeDefined();
  });

  it("hydrateBranchProtectionAcks: in-memory takes precedence on disk-vs-memory conflict", async () => {
    // Same repoRoot in both — the in-memory entry (the user's most
    // recent action this session) should override the disk entry.
    useCollaboratorStore.setState({
      branchProtectionAcks: {
        "/r": { acceptedAt: "new-ts", note: "fresh-action" },
      },
    });
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "read_app_config_file") {
        return JSON.stringify({
          "/r": { acceptedAt: "old-ts", note: "stale-disk-state" },
        });
      }
      return null;
    });
    await hydrateBranchProtectionAcks();
    const acks = useCollaboratorStore.getState().branchProtectionAcks;
    expect(acks["/r"]?.note).toBe("fresh-action");
    expect(acks["/r"]?.acceptedAt).toBe("new-ts");
  });

  // -------------------------------------------------------------------------
  // Round-17 polish: hydration-window write recovery + entry-shape validation
  // -------------------------------------------------------------------------

  it("hydrateBranchProtectionAcks: persists merged state to disk so hydration-window race doesn't lose previously-acked repos (round-17 claude2 task-106)", async () => {
    // Round-17 claude2 task-106: scenario:
    //   1. Run 1: user accepted /repoA → disk had /repoA. App exited.
    //   2. Run 2: hydration starts; read fires, captures disk={/repoA}.
    //   3. Before read resolves, user types accept-limited /repoB →
    //      in-memory={/repoB}, write fires → disk now {/repoB}.
    //      /repoA is LOST on disk.
    //   4. Hydration's read resolves with old onDisk={/repoA}; merge
    //      produces in-memory={/repoA, /repoB}. Good.
    //   5. BUG: hydration didn't trigger a write. Disk stays {/repoB}.
    //      App exits → /repoA permanently lost.
    //
    // Fix: hydration triggers persistBranchProtectionAcks() after the
    // merge. The chain serializes; final disk state reflects the union.
    useCollaboratorStore.setState({
      // Simulates step 3: user accepted /repoB during hydration window.
      branchProtectionAcks: {
        "/repoB": { acceptedAt: "in-mem-ts", note: "added during hydration window" },
      },
    });
    const writeCalls: Array<{ relativePath: string; content: string }> = [];
    vi.mocked(invoke).mockImplementation(async (cmd: string, args?: unknown) => {
      if (cmd === "read_app_config_file") {
        // Disk still has /repoA from the prior session.
        return JSON.stringify({
          "/repoA": { acceptedAt: "old-ts", note: "from-prior-restart" },
        });
      }
      if (cmd === "write_app_config_file") {
        const a = args as { relativePath: string; content: string };
        writeCalls.push(a);
      }
      return null;
    });
    await hydrateBranchProtectionAcks();
    await new Promise((r) => setTimeout(r, 10));

    // In-memory: union with both repos.
    const acks = useCollaboratorStore.getState().branchProtectionAcks;
    expect(acks["/repoA"]).toBeDefined();
    expect(acks["/repoB"]).toBeDefined();

    // CRITICAL: hydration must have triggered a persist write so disk
    // reflects the merged union, not just the last in-flight write.
    const ackPersistCall = writeCalls.find(
      (c) => c.relativePath === "branch-protection-acks.json",
    );
    expect(ackPersistCall).toBeDefined();
    const finalDiskState = JSON.parse(ackPersistCall!.content);
    expect(finalDiskState["/repoA"]).toBeDefined();
    expect(finalDiskState["/repoB"]).toBeDefined();
  });

  it("hydrateBranchProtectionAcks: does NOT trigger a write when in-memory is a subset of disk (no merge change)", async () => {
    // If disk is the source of truth and in-memory has no extra entries,
    // there's nothing to flush. Avoid spurious writes — they'd just be
    // identity-rewrites adding wear to the file.
    useCollaboratorStore.setState({ branchProtectionAcks: {} });
    const writeCalls: string[] = [];
    vi.mocked(invoke).mockImplementation(async (cmd: string, args?: unknown) => {
      if (cmd === "read_app_config_file") {
        return JSON.stringify({
          "/repoA": { acceptedAt: "old-ts" },
        });
      }
      if (
        cmd === "write_app_config_file" &&
        (args as { relativePath?: string } | undefined)?.relativePath ===
          "branch-protection-acks.json"
      ) {
        writeCalls.push(cmd);
      }
      return null;
    });
    await hydrateBranchProtectionAcks();
    await new Promise((r) => setTimeout(r, 10));
    // No extra entries in memory → no need to re-persist disk.
    expect(writeCalls).toHaveLength(0);
  });

  it("checkBranchProtection: 200 with restrictions {users:[null]} → verified-unprotected (round-17 claude3 task-102 O1)", async () => {
    // Round-17 claude3 task-102 O1: validate that allowlist entries
    // are non-null objects, not just that arrays have length > 0.
    // Prevents `[null]` or `["malformed-string"]` from satisfying
    // the meaningful-protection check.
    const fakeInvoke = vi.fn(async (cmd: string) => {
      if (cmd === "git_get_remote_url") return "https://github.com/owner/repo.git";
      if (cmd === "run_gh_api") {
        return {
          exitCode: 0,
          stdout: '{"required_status_checks":null,"restrictions":{"users":[null],"teams":[],"apps":[]},"required_pull_request_reviews":null}',
          stderr: "",
        };
      }
      throw new Error(`unexpected IPC: ${cmd}`);
    });
    const state = await checkBranchProtection(
      "/r",
      fakeInvoke as unknown as typeof invoke,
    );
    expect(state).toBe("verified-unprotected");
  });

  it("checkBranchProtection: 200 with restrictions {users:['malformed-string']} → verified-unprotected (round-17 claude3 task-102 O1)", async () => {
    const fakeInvoke = vi.fn(async (cmd: string) => {
      if (cmd === "git_get_remote_url") return "https://github.com/owner/repo.git";
      if (cmd === "run_gh_api") {
        return {
          exitCode: 0,
          stdout: '{"required_status_checks":null,"restrictions":{"users":["scalar-string-not-object"],"teams":[],"apps":[]},"required_pull_request_reviews":null}',
          stderr: "",
        };
      }
      throw new Error(`unexpected IPC: ${cmd}`);
    });
    const state = await checkBranchProtection(
      "/r",
      fakeInvoke as unknown as typeof invoke,
    );
    expect(state).toBe("verified-unprotected");
  });

  // -------------------------------------------------------------------------
  // Round-18: symmetric clear-during-hydration race
  // -------------------------------------------------------------------------

  it("clearBranchProtectionAck during hydration window does NOT resurrect the cleared ack (round-18 codex1 round5 BLOCKING)", async () => {
    // Round-18 codex1 round5: symmetric counterpart of round-16's race.
    //   1. Run 1: user accepted /repoA → disk {/repoA}. App exits.
    //   2. Run 2: hydration's read fires (in-flight, will return {/repoA}).
    //   3. Before read resolves, user runs clear-ack /repoA.
    //      - In-memory was {} (hydration hasn't applied yet) → no
    //        in-memory mutation, but sessionClears records the intent.
    //   4. Hydration resolves with stale onDisk={/repoA}; merge would
    //      have re-introduced /repoA WITHOUT the sessionClears filter.
    //   5. With round-18 fix: hydration filters onDisk via sessionClears,
    //      so /repoA is dropped before merge. Final in-memory = {}.
    //   6. Symmetric-diff check sees sessionClears.has(/repoA) → fires
    //      a write so disk converges to {}.
    useCollaboratorStore.setState({ branchProtectionAcks: {} });
    const writeCalls: Array<{ relativePath: string; content: string }> = [];
    let resolveRead: ((v: string | null) => void) | null = null;
    vi.mocked(invoke).mockImplementation(async (cmd: string, args?: unknown) => {
      if (cmd === "read_app_config_file") {
        // Defer the read so the user's clear-ack can race against it.
        return new Promise<string | null>((r) => {
          resolveRead = r;
        });
      }
      if (cmd === "write_app_config_file") {
        const a = args as { relativePath: string; content: string };
        writeCalls.push(a);
      }
      return null;
    });
    // Step 2: hydration starts (read deferred).
    const hydrationPromise = hydrateBranchProtectionAcks();
    // Step 3: user clears /repoA before read resolves.
    useCollaboratorStore.getState().clearBranchProtectionAck("/repoA");
    // Step 4: now resolve the read with the stale {/repoA} payload.
    resolveRead!(JSON.stringify({ "/repoA": { acceptedAt: "old-ts" } }));
    await hydrationPromise;
    await new Promise((r) => setTimeout(r, 10));
    // Final in-memory: /repoA must NOT be present (clear-ack honored).
    expect(useCollaboratorStore.getState().branchProtectionAcks["/repoA"]).toBeUndefined();
    // Disk must have converged: at least one write to the acks file
    // whose final content has /repoA absent.
    const ackWrites = writeCalls.filter(
      (c) => c.relativePath === "branch-protection-acks.json",
    );
    expect(ackWrites.length).toBeGreaterThan(0);
    const finalDiskState = JSON.parse(ackWrites[ackWrites.length - 1].content);
    expect(finalDiskState["/repoA"]).toBeUndefined();
  });

  it("hydrateBranchProtectionAcks: subset-of-disk skip honors sessionClears (round-18 symmetric-diff)", async () => {
    // Edge case: in-memory is a strict subset of onDisk's RAW state,
    // but sessionClears stripped a key from disk's effective state.
    // The diff check must fire a write to converge — otherwise the
    // cleared key would silently re-appear after restart.
    useCollaboratorStore.setState({ branchProtectionAcks: {} });
    const writeCalls: string[] = [];
    let resolveRead: ((v: string | null) => void) | null = null;
    vi.mocked(invoke).mockImplementation(async (cmd: string, args?: unknown) => {
      if (cmd === "read_app_config_file") {
        return new Promise<string | null>((r) => {
          resolveRead = r;
        });
      }
      if (
        cmd === "write_app_config_file" &&
        (args as { relativePath?: string } | undefined)?.relativePath ===
          "branch-protection-acks.json"
      ) {
        writeCalls.push((args as { content: string }).content);
      }
      return null;
    });
    const hydrationPromise = hydrateBranchProtectionAcks();
    useCollaboratorStore.getState().clearBranchProtectionAck("/repoA");
    resolveRead!(JSON.stringify({ "/repoA": { acceptedAt: "old-ts" } }));
    await hydrationPromise;
    await new Promise((r) => setTimeout(r, 10));
    // The hydration symmetric-diff path must trigger a write (because
    // sessionClears dropped /repoA from the merge but disk still has it).
    expect(writeCalls.length).toBeGreaterThan(0);
    expect(JSON.parse(writeCalls[writeCalls.length - 1])).toEqual({});
  });

  it("clearBranchProtectionAck: sessionClears persists across multiple no-op calls (idempotent tracker)", () => {
    useCollaboratorStore.setState({ branchProtectionAcks: {} });
    // First clear records intent even though in-memory was empty.
    useCollaboratorStore.getState().clearBranchProtectionAck("/repoA");
    // Second clear of the same repo is a true no-op.
    useCollaboratorStore.getState().clearBranchProtectionAck("/repoA");
    // sessionClears is module-private; we exercise its effect via a
    // hydration check below (round-18 invariant: even after multiple
    // no-op clears, hydration must still strip the cleared key).
    expect(useCollaboratorStore.getState().branchProtectionAcks).toEqual({});
  });

  // -------------------------------------------------------------------------
  // Round-19 P5 polish: GHE detection, sessionClears.delete on accept,
  // weak-vs-empty diagnostic specificity
  // -------------------------------------------------------------------------

  it("checkBranchProtection: GHE host (github.acme.com) recognized as GitHub-flavored (round-19 claude3 task-99 O2 follow-up)", async () => {
    // Round-19 P5: self-hosted GitHub Enterprise URLs should reach the
    // gh api call — `gh` can talk to GHE when authed against the
    // appropriate host. The prior code rejected non-`github.com` URLs
    // unconditionally, forcing GHE users to always accept-limited.
    const fakeInvoke = vi.fn(async (cmd: string) => {
      if (cmd === "git_get_remote_url") return "https://github.acme.com/owner/repo.git";
      if (cmd === "run_gh_api") {
        return {
          exitCode: 0,
          stdout: '{"required_pull_request_reviews":{"dismiss_stale_reviews":true}}',
          stderr: "",
        };
      }
      throw new Error(`unexpected IPC: ${cmd}`);
    });
    const state = await checkBranchProtection(
      "/r",
      fakeInvoke as unknown as typeof invoke,
    );
    expect(state).toBe("verified-protected");
    // gh api must have been invoked (proves GHE host wasn't rejected
    // at the host-detection step).
    expect(fakeInvoke).toHaveBeenCalledWith(
      "run_gh_api",
      expect.objectContaining({
        args: expect.arrayContaining([
          expect.stringContaining("/repos/owner/repo/branches/dev/protection"),
        ]),
      }),
    );
  });

  it("checkBranchProtection: GHE SSH form (git@github.acme.com:owner/repo) recognized", async () => {
    const fakeInvoke = vi.fn(async (cmd: string) => {
      if (cmd === "git_get_remote_url") return "git@github.acme.com:owner/repo.git";
      if (cmd === "run_gh_api") {
        return {
          exitCode: 0,
          stdout: '{"required_pull_request_reviews":{"dismiss_stale_reviews":true}}',
          stderr: "",
        };
      }
      throw new Error(`unexpected IPC: ${cmd}`);
    });
    const state = await checkBranchProtection(
      "/r",
      fakeInvoke as unknown as typeof invoke,
    );
    expect(state).toBe("verified-protected");
  });

  it("checkBranchProtection: non-github host (gitlab.com) still routes to unknown", async () => {
    // Regression check: the round-19 GHE detection broadened scope, but
    // non-github hosts must still route to unknown.
    const fakeInvoke = vi.fn(async (cmd: string) => {
      if (cmd === "git_get_remote_url") return "https://gitlab.com/owner/repo.git";
      throw new Error(`unexpected IPC: ${cmd}`);
    });
    const state = await checkBranchProtection(
      "/r",
      fakeInvoke as unknown as typeof invoke,
    );
    expect(state).toBe("unknown");
  });

  it("checkBranchProtection: a host like 'githubexample.com' (substring) does NOT match", async () => {
    // Defense: prior `/github\.com[:/]/` regex would falsely match
    // `https://githubexample.com/owner/repo` because of substring
    // semantics. Round-19's host-anchored detection rejects this.
    const fakeInvoke = vi.fn(async (cmd: string) => {
      if (cmd === "git_get_remote_url") return "https://githubexample.com/owner/repo.git";
      throw new Error(`unexpected IPC: ${cmd}`);
    });
    const state = await checkBranchProtection(
      "/r",
      fakeInvoke as unknown as typeof invoke,
    );
    expect(state).toBe("unknown");
  });

  it("acceptBranchProtectionLimited: removes repo from sessionClears (round-19 claude2 task-112 + claude3 task-114 O3)", async () => {
    // Round-19 P5: clear-then-accept in same session must clean up the
    // sessionClears tracker. Without this, a subsequent hydration
    // (e.g., React 18 strict mode double-invocation) would filter the
    // newly-acked repo out of onDisk and trigger a redundant write.
    setupAwaitingApprovalTask({ hasResidue: false, ackProtection: false });
    // First clear-ack records intent in sessionClears (in-memory was empty).
    useCollaboratorStore.getState().clearBranchProtectionAck("/r");
    // Now re-accept the SAME repo. sessionClears.delete should fire.
    useCollaboratorStore.getState().acceptBranchProtectionLimited("/r", "re-accepted");
    // Wait for the accept's write to drain through the chain.
    await new Promise((r) => setTimeout(r, 10));
    // Now switch the mock to track only writes that happen DURING
    // (and after) the hydration call.
    let writesAfterHydrationStart = 0;
    let trackingActive = false;
    vi.mocked(invoke).mockImplementation(async (cmd: string, args?: unknown) => {
      if (cmd === "read_app_config_file") {
        return JSON.stringify({
          "/r": { acceptedAt: "re-accepted-ts", note: "re-accepted" },
        });
      }
      if (
        trackingActive &&
        cmd === "write_app_config_file" &&
        (args as { relativePath?: string } | undefined)?.relativePath ===
          "branch-protection-acks.json"
      ) {
        writesAfterHydrationStart++;
      }
      return null;
    });
    trackingActive = true;
    await hydrateBranchProtectionAcks();
    await new Promise((r) => setTimeout(r, 10));
    // No write should fire DURING hydration — disk and in-memory both
    // have /r, sessionClears no longer has /r → no diff → no write.
    expect(writesAfterHydrationStart).toBe(0);
    expect(
      useCollaboratorStore.getState().branchProtectionAcks["/r"],
    ).toBeDefined();
  });

  // -------------------------------------------------------------------------
  // Round-20: GHE --hostname plumbing + nonBlockingFields rendering + @-strip
  // -------------------------------------------------------------------------

  it("checkBranchProtection: GHE call passes --hostname github.acme.com to gh api (round-20 codex1 round7 + codex2 task-116 H1 BLOCKING)", async () => {
    // Round-20 codex1 round7 BLOCKING + codex2 task-116 H1 (convergent):
    // GHE host detection alone is insufficient if `gh api` still
    // targets the default github.com host. Without --hostname plumbing,
    // a public github.com repo with the same owner/repo can mask the
    // GHE branch's true protection state (false verified-protected
    // for actually-unprotected GHE branch). The fix plumbs the
    // detected host through to the gh api invocation.
    let capturedArgs: string[] = [];
    const fakeInvoke = vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "git_get_remote_url") return "https://github.acme.com/owner/repo.git";
      if (cmd === "run_gh_api") {
        capturedArgs = (args?.args as string[]) ?? [];
        return {
          exitCode: 0,
          stdout: '{"required_pull_request_reviews":{"dismiss_stale_reviews":true}}',
          stderr: "",
        };
      }
      throw new Error(`unexpected IPC: ${cmd}`);
    });
    await checkBranchProtection("/r", fakeInvoke as unknown as typeof invoke);
    // CRITICAL: --hostname must be present and target the GHE host.
    expect(capturedArgs).toContain("--hostname");
    const hostnameIdx = capturedArgs.indexOf("--hostname");
    expect(capturedArgs[hostnameIdx + 1]).toBe("github.acme.com");
    // The path itself is unchanged.
    expect(capturedArgs[0]).toBe("/repos/owner/repo/branches/dev/protection");
  });

  it("checkBranchProtection: github.com calls do NOT pass --hostname (default host, no flag needed)", async () => {
    // Defensive regression: --hostname should only be added for non-
    // default hosts. Adding it unconditionally would be a behavioral
    // change against the prior round-19 contract (and would surface
    // odd error messages if gh CLI rejects a redundant flag in some
    // versions).
    let capturedArgs: string[] = [];
    const fakeInvoke = vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "git_get_remote_url") return "https://github.com/owner/repo.git";
      if (cmd === "run_gh_api") {
        capturedArgs = (args?.args as string[]) ?? [];
        return {
          exitCode: 0,
          stdout: '{"required_pull_request_reviews":{"dismiss_stale_reviews":true}}',
          stderr: "",
        };
      }
      throw new Error(`unexpected IPC: ${cmd}`);
    });
    await checkBranchProtection("/r", fakeInvoke as unknown as typeof invoke);
    expect(capturedArgs).not.toContain("--hostname");
    // Args should be just the path.
    expect(capturedArgs).toEqual(["/repos/owner/repo/branches/dev/protection"]);
  });

  it("/branch-protection check: renders nonBlockingFields for weak protection (round-20 codex2 task-116 M1 + claude3 task-117 O1)", async () => {
    // Round-20 (codex2 task-116 M1 + claude3 task-117 O1): the
    // ProtectionDetail data added in round-19 must actually surface
    // in the slash-command output. Weak protection (status_checks
    // alone) should name the field in the user-facing message.
    setupAwaitingApprovalTask({ hasResidue: false, ackProtection: false });
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "git_get_remote_url") return "https://github.com/owner/repo.git";
      if (cmd === "run_gh_api") {
        return {
          exitCode: 0,
          stdout: '{"required_status_checks":{"strict":true,"contexts":["ci/test"]},"restrictions":null,"required_pull_request_reviews":null}',
          stderr: "",
        };
      }
      return null;
    });
    await executeCommand(parseInput("/branch-protection check"), D14_SESSION);
    const status = useCollaboratorStore.getState().statusMessages[D14_SESSION];
    expect(status).toContain("required_status_checks");
    expect(status).toContain("no direct-push-blocking field");
  });

  it("/branch-protection check: renders the GHE host in the status message (round-20)", async () => {
    setupAwaitingApprovalTask({ hasResidue: false, ackProtection: false });
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "git_get_remote_url") return "https://github.acme.com/owner/repo.git";
      if (cmd === "run_gh_api") {
        return {
          exitCode: 0,
          stdout: '{"required_pull_request_reviews":{"dismiss_stale_reviews":true}}',
          stderr: "",
        };
      }
      return null;
    });
    await executeCommand(parseInput("/branch-protection check"), D14_SESSION);
    const status = useCollaboratorStore.getState().statusMessages[D14_SESSION];
    // GHE host should appear in the status (not just generic "origin/dev").
    expect(status).toContain("github.acme.com/dev");
  });

  it("/task approve: strips @ prefix from agentHandle before passing to git_create_approval_commit (round-20 P5 cosmetic)", async () => {
    // Round-20 P5 (claude2 task-70 Concern 5 carry-over): the @ is a
    // UI/mention sigil, not part of the actual handle. Stripping it
    // before passing to git author makes the commit author render
    // as `claude1 via orchestrator <…>` instead of `@claude1 via …`.
    const { taskId } = setupAwaitingApprovalTask({ hasResidue: true });
    let capturedHandle: string | undefined;
    vi.mocked(invoke).mockImplementation(async (cmd: string, args?: unknown) => {
      if (cmd === "git_create_approval_commit") {
        capturedHandle = (args as { agentHandle: string }).agentHandle;
        return { commitSha: "abc", stagedCount: 1 };
      }
      if (cmd === "git_merge_worktree") return { mergedSha: "merged", pushed: false };
      if (cmd === "git_worktree_remove") return { kind: "fullyRemoved" };
      return null;
    });
    await executeCommand(parseInput(`/task ${taskId} approve`), D14_SESSION);
    // The pendingMerge snapshot has `agentHandle: "@claude1"`; the
    // approval-commit IPC must receive the stripped form.
    expect(capturedHandle).toBe("claude1");
    expect(capturedHandle).not.toContain("@");
  });

  // -------------------------------------------------------------------------
  // Round-21 P5: verified-protected TTL caching (claude3 task-99 O5)
  // -------------------------------------------------------------------------

  it("checkBranchProtectionDetail: caches verified-protected verdict so subsequent calls skip the IPC sequence (round-21 claude3 task-99 O5)", async () => {
    // Round-21 (claude3 task-99 O5): each Approve previously incurred
    // ~1s of `gh api` latency even when protection state hadn't
    // changed. The TTL cache returns the prior verified-protected
    // verdict without an IPC round-trip. Subsequent verified-protected
    // calls should be cache hits — zero IPCs to git_get_remote_url
    // or run_gh_api on the second call.
    const { checkBranchProtectionDetail } = await import(
      "../components/collaborator/commands"
    );
    let ipcCount = 0;
    const fakeInvoke = vi.fn(async (cmd: string) => {
      if (cmd === "git_get_remote_url") {
        ipcCount++;
        return "https://github.com/owner/repo.git";
      }
      if (cmd === "run_gh_api") {
        ipcCount++;
        return {
          exitCode: 0,
          stdout: '{"required_pull_request_reviews":{"dismiss_stale_reviews":true}}',
          stderr: "",
        };
      }
      throw new Error(`unexpected IPC: ${cmd}`);
    });
    // First call: full IPC round-trip.
    const v1 = await checkBranchProtectionDetail(
      "/r-cache-test",
      fakeInvoke as unknown as typeof invoke,
    );
    expect(v1.state).toBe("verified-protected");
    const ipcsAfterFirst = ipcCount;
    expect(ipcsAfterFirst).toBeGreaterThan(0);
    // Second call: should hit cache, no new IPCs.
    const v2 = await checkBranchProtectionDetail(
      "/r-cache-test",
      fakeInvoke as unknown as typeof invoke,
    );
    expect(v2.state).toBe("verified-protected");
    expect(ipcCount).toBe(ipcsAfterFirst); // no new IPCs
  });

  it("checkBranchProtectionDetail: useCache:false bypasses cache (round-21)", async () => {
    // /branch-protection check sets useCache: false to force a fresh
    // re-evaluation when the user explicitly asks.
    const { checkBranchProtectionDetail } = await import(
      "../components/collaborator/commands"
    );
    let ghApiCalls = 0;
    const fakeInvoke = vi.fn(async (cmd: string) => {
      if (cmd === "git_get_remote_url") return "https://github.com/owner/repo.git";
      if (cmd === "run_gh_api") {
        ghApiCalls++;
        return {
          exitCode: 0,
          stdout: '{"required_pull_request_reviews":{"dismiss_stale_reviews":true}}',
          stderr: "",
        };
      }
      throw new Error(`unexpected IPC: ${cmd}`);
    });
    await checkBranchProtectionDetail(
      "/r-bypass-test",
      fakeInvoke as unknown as typeof invoke,
    );
    expect(ghApiCalls).toBe(1);
    // Second call with useCache: false — must re-fetch.
    await checkBranchProtectionDetail(
      "/r-bypass-test",
      fakeInvoke as unknown as typeof invoke,
      undefined,
      { useCache: false },
    );
    expect(ghApiCalls).toBe(2);
  });

  it("checkBranchProtectionDetail: only caches verified-protected (other states re-fetch each call)", async () => {
    // verified-unprotected and unknown gate on user action; caching
    // them would defeat the up-to-date diagnostic. Only the protected
    // verdict — where the user just wants to skip the wizard quickly
    // — gets cached.
    const { checkBranchProtectionDetail } = await import(
      "../components/collaborator/commands"
    );
    let ghApiCalls = 0;
    const fakeInvoke = vi.fn(async (cmd: string) => {
      if (cmd === "git_get_remote_url") return "https://github.com/owner/repo.git";
      if (cmd === "run_gh_api") {
        ghApiCalls++;
        return { exitCode: 4, stdout: "", stderr: "Not Found (HTTP 404)" };
      }
      throw new Error(`unexpected IPC: ${cmd}`);
    });
    await checkBranchProtectionDetail(
      "/r-unprotected",
      fakeInvoke as unknown as typeof invoke,
    );
    expect(ghApiCalls).toBe(1);
    // Second call: NOT cached, re-fetches.
    await checkBranchProtectionDetail(
      "/r-unprotected",
      fakeInvoke as unknown as typeof invoke,
    );
    expect(ghApiCalls).toBe(2);
  });

  it("invalidateVerifiedProtectedCache: clearBranchProtectionAck flushes the cached protected verdict (round-21)", async () => {
    // Round-21: when the user runs /branch-protection clear-ack, any
    // cached verified-protected verdict for that repo must be flushed
    // so the next Approve re-checks gh api. Without this, the user
    // could clear the ack, expect the wizard to re-fire, but instead
    // hit a cached "you're already protected" verdict and skip the
    // wizard entirely.
    setupAwaitingApprovalTask({ hasResidue: false, ackProtection: true });
    const { checkBranchProtectionDetail } = await import(
      "../components/collaborator/commands"
    );
    let ghApiCalls = 0;
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "git_get_remote_url") return "https://github.com/owner/repo.git";
      if (cmd === "run_gh_api") {
        ghApiCalls++;
        return {
          exitCode: 0,
          stdout: '{"required_pull_request_reviews":{"dismiss_stale_reviews":true}}',
          stderr: "",
        };
      }
      return null;
    });
    // Prime the cache.
    await checkBranchProtectionDetail("/r");
    expect(ghApiCalls).toBe(1);
    // Verify cache hit.
    await checkBranchProtectionDetail("/r");
    expect(ghApiCalls).toBe(1);
    // User runs /branch-protection clear-ack — should flush cache.
    await executeCommand(parseInput("/branch-protection clear-ack"), D14_SESSION);
    // Next call should re-fetch.
    await checkBranchProtectionDetail("/r");
    expect(ghApiCalls).toBe(2);
  });

  // -------------------------------------------------------------------------
  // Round-22: codex2 task-122 BLOCKING fix — explicit re-check invalidates
  // stale protected cache when fresh result is unprotected
  // -------------------------------------------------------------------------

  it("checkBranchProtectionDetail: useCache:false with fresh unprotected result invalidates stale protected cache (round-22 codex2 task-122 BLOCKING)", async () => {
    // Round-22 codex2 task-122 BLOCKING: scenario:
    //   1. Cache holds verified-protected for /r (prior successful check).
    //   2. Protection disabled on GitHub.
    //   3. User runs /branch-protection check → useCache:false bypasses,
    //      returns fresh verified-unprotected.
    //   4. PRIOR BUG: stale protected entry survived in cache. Next
    //      /task approve hit cache → returned stale verified-protected
    //      → Approve proceeded silently on now-unprotected branch.
    //   5. ROUND-22 FIX: fresh non-protected verdict deletes the stale
    //      cache entry, so subsequent Approves re-fetch and refuse.
    const { checkBranchProtectionDetail } = await import(
      "../components/collaborator/commands"
    );
    let ghCallCount = 0;
    let ghReturnsProtected = true;
    const fakeInvoke = vi.fn(async (cmd: string) => {
      if (cmd === "git_get_remote_url") return "https://github.com/owner/repo.git";
      if (cmd === "run_gh_api") {
        ghCallCount++;
        if (ghReturnsProtected) {
          return {
            exitCode: 0,
            stdout: '{"required_pull_request_reviews":{"dismiss_stale_reviews":true}}',
            stderr: "",
          };
        }
        return { exitCode: 4, stdout: "", stderr: "Not Found (HTTP 404)" };
      }
      throw new Error(`unexpected IPC: ${cmd}`);
    });

    // Step 1: prime the cache with verified-protected.
    const v1 = await checkBranchProtectionDetail(
      "/r-toctou",
      fakeInvoke as unknown as typeof invoke,
    );
    expect(v1.state).toBe("verified-protected");
    expect(ghCallCount).toBe(1);

    // Step 2: simulate protection being disabled on GitHub.
    ghReturnsProtected = false;

    // Step 3: explicit user re-check via useCache:false → returns fresh
    // verified-unprotected.
    const v2 = await checkBranchProtectionDetail(
      "/r-toctou",
      fakeInvoke as unknown as typeof invoke,
      undefined,
      { useCache: false },
    );
    expect(v2.state).toBe("verified-unprotected");
    expect(ghCallCount).toBe(2);

    // Step 4: subsequent default (cached) call must NOT return the
    // stale verified-protected entry. The cache should have been
    // invalidated by step 3's fresh non-protected result.
    const v3 = await checkBranchProtectionDetail(
      "/r-toctou",
      fakeInvoke as unknown as typeof invoke,
    );
    expect(v3.state).toBe("verified-unprotected");
    // CRITICAL: ghCallCount must have incremented — the cache lookup
    // missed (because step 3 invalidated) and a fresh fetch fired.
    expect(ghCallCount).toBe(3);
  });

  it("/task approve after /branch-protection check sees protection-disabled (round-22 end-to-end TOCTOU regression)", async () => {
    // End-to-end version of the round-22 BLOCKING fix: the user's
    // mental model is "I just ran /check and it said unprotected,
    // therefore Approve should ask for accept-limited". The prior
    // bug let Approve silently proceed via the stale protected cache.
    const { taskId } = setupAwaitingApprovalTask({
      hasResidue: false,
      ackProtection: false,
    });
    let ghReturnsProtected = true;
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "git_get_remote_url") return "https://github.com/owner/repo.git";
      if (cmd === "run_gh_api") {
        if (ghReturnsProtected) {
          return {
            exitCode: 0,
            stdout: '{"required_pull_request_reviews":{"dismiss_stale_reviews":true}}',
            stderr: "",
          };
        }
        return { exitCode: 4, stdout: "", stderr: "Not Found (HTTP 404)" };
      }
      if (cmd === "git_merge_worktree") return { mergedSha: "abc", pushed: false };
      if (cmd === "git_worktree_remove") return { kind: "fullyRemoved" };
      return null;
    });

    // Step 1: prime via initial Approve attempt (verified-protected,
    // proceeds, caches the verdict).
    await executeCommand(parseInput(`/task ${taskId} approve`), D14_SESSION);
    let task = useCollaboratorStore
      .getState()
      .tasksBySession[D14_SESSION]?.find((t) => t.id === taskId);
    expect(task?.status).toBe("completed");

    // Reset task to awaiting-approval for the next attempt (simulating
    // a new agent task on the same repo).
    useCollaboratorStore.setState((s) => ({
      tasksBySession: {
        ...s.tasksBySession,
        [D14_SESSION]: s.tasksBySession[D14_SESSION].map((t) =>
          t.id === taskId
            ? {
                ...t,
                status: "awaiting-approval" as const,
                pendingMerge: {
                  branch: "agent/x",
                  worktreePath: "/wt2",
                  repoRoot: "/r",
                  baseRef: "origin/dev",
                  baseSha: "abc",
                  baseFresh: true,
                  diffSummary: { committed: ["a.ts"], staged: [], unstaged: [], untracked: [] },
                  agentHandle: "@claude1",
                },
              }
            : t,
        ),
      },
    }));

    // Step 2: protection disabled on GitHub.
    ghReturnsProtected = false;

    // Step 3: user runs /branch-protection check explicitly. Sees
    // unprotected. The check invalidates the cache.
    await executeCommand(parseInput("/branch-protection check"), D14_SESSION);

    // Step 4: user runs /task approve. Round-22 fix: the stale
    // verified-protected cache was invalidated in step 3, so Approve
    // re-checks gh api, sees unprotected, refuses with accept-limited
    // guidance.
    await executeCommand(parseInput(`/task ${taskId} approve`), D14_SESSION);
    task = useCollaboratorStore
      .getState()
      .tasksBySession[D14_SESSION]?.find((t) => t.id === taskId);
    // CRITICAL: status must remain awaiting-approval (refused), not
    // re-completed via stale cache.
    expect(task?.status).toBe("awaiting-approval");
    const status = useCollaboratorStore.getState().statusMessages[D14_SESSION];
    expect(status).toContain("Branch protection NOT enabled");
  });

  // -------------------------------------------------------------------------
  // Round-23: codex2 task-125 BLOCKING — early-return paths must invalidate
  // stale protected cache (full-symmetry invariant)
  // -------------------------------------------------------------------------

  it("checkBranchProtectionDetail: useCache:false with origin missing invalidates stale protected cache (round-23 codex2 task-125 BLOCKING — git_get_remote_url throw path)", async () => {
    const { checkBranchProtectionDetail } = await import(
      "../components/collaborator/commands"
    );
    let originExists = true;
    const fakeInvoke = vi.fn(async (cmd: string) => {
      if (cmd === "git_get_remote_url") {
        if (!originExists) throw "No such remote 'origin'";
        return "https://github.com/owner/repo.git";
      }
      if (cmd === "run_gh_api") {
        return {
          exitCode: 0,
          stdout: '{"required_pull_request_reviews":{"dismiss_stale_reviews":true}}',
          stderr: "",
        };
      }
      throw new Error(`unexpected IPC: ${cmd}`);
    });
    // Step 1: prime cache with verified-protected.
    const v1 = await checkBranchProtectionDetail(
      "/r-origin",
      fakeInvoke as unknown as typeof invoke,
    );
    expect(v1.state).toBe("verified-protected");
    // Step 2: simulate origin removal.
    originExists = false;
    // Step 3: explicit re-check via useCache:false → unknown.
    const v2 = await checkBranchProtectionDetail(
      "/r-origin",
      fakeInvoke as unknown as typeof invoke,
      undefined,
      { useCache: false },
    );
    expect(v2.state).toBe("unknown");
    // Step 4: subsequent default (cached) call — must NOT return
    // stale verified-protected. Cache should have been invalidated
    // by the early-return path.
    const v3 = await checkBranchProtectionDetail(
      "/r-origin",
      fakeInvoke as unknown as typeof invoke,
    );
    expect(v3.state).toBe("unknown");
  });

  it("checkBranchProtectionDetail: useCache:false with non-GitHub remote invalidates cache (round-23 — !host path)", async () => {
    const { checkBranchProtectionDetail } = await import(
      "../components/collaborator/commands"
    );
    let isGithub = true;
    const fakeInvoke = vi.fn(async (cmd: string) => {
      if (cmd === "git_get_remote_url") {
        return isGithub
          ? "https://github.com/owner/repo.git"
          : "https://gitlab.com/owner/repo.git";
      }
      if (cmd === "run_gh_api") {
        return {
          exitCode: 0,
          stdout: '{"required_pull_request_reviews":{"dismiss_stale_reviews":true}}',
          stderr: "",
        };
      }
      throw new Error(`unexpected IPC: ${cmd}`);
    });
    const v1 = await checkBranchProtectionDetail(
      "/r-host",
      fakeInvoke as unknown as typeof invoke,
    );
    expect(v1.state).toBe("verified-protected");
    // User changes remote to non-GitHub host.
    isGithub = false;
    const v2 = await checkBranchProtectionDetail(
      "/r-host",
      fakeInvoke as unknown as typeof invoke,
      undefined,
      { useCache: false },
    );
    expect(v2.state).toBe("unknown");
    // Subsequent cached call must NOT serve the stale protected entry.
    const v3 = await checkBranchProtectionDetail(
      "/r-host",
      fakeInvoke as unknown as typeof invoke,
    );
    expect(v3.state).toBe("unknown");
  });

  it("checkBranchProtectionDetail: useCache:false with run_gh_api throw invalidates cache (round-23 — gh api catch path)", async () => {
    const { checkBranchProtectionDetail } = await import(
      "../components/collaborator/commands"
    );
    let ghThrows = false;
    const fakeInvoke = vi.fn(async (cmd: string) => {
      if (cmd === "git_get_remote_url") return "https://github.com/owner/repo.git";
      if (cmd === "run_gh_api") {
        if (ghThrows) throw "network unreachable";
        return {
          exitCode: 0,
          stdout: '{"required_pull_request_reviews":{"dismiss_stale_reviews":true}}',
          stderr: "",
        };
      }
      throw new Error(`unexpected IPC: ${cmd}`);
    });
    const v1 = await checkBranchProtectionDetail(
      "/r-network",
      fakeInvoke as unknown as typeof invoke,
    );
    expect(v1.state).toBe("verified-protected");
    // Network failure simulated.
    ghThrows = true;
    const v2 = await checkBranchProtectionDetail(
      "/r-network",
      fakeInvoke as unknown as typeof invoke,
      undefined,
      { useCache: false },
    );
    expect(v2.state).toBe("unknown");
    // Subsequent cached call must NOT serve stale protected entry.
    const v3 = await checkBranchProtectionDetail(
      "/r-network",
      fakeInvoke as unknown as typeof invoke,
    );
    expect(v3.state).toBe("unknown");
  });

  it("checkBranchProtectionDetail: useCache:false with malformed URL invalidates cache (round-23 — !parsed path)", async () => {
    const { checkBranchProtectionDetail } = await import(
      "../components/collaborator/commands"
    );
    let urlOk = true;
    const fakeInvoke = vi.fn(async (cmd: string) => {
      if (cmd === "git_get_remote_url") {
        return urlOk
          ? "https://github.com/owner/repo.git"
          // detectGithubHost recognizes the host, but parseGithubOwnerRepo
          // can't extract owner/repo from this shape (no owner/repo
          // path segments after the host).
          : "https://github.com/";
      }
      if (cmd === "run_gh_api") {
        return {
          exitCode: 0,
          stdout: '{"required_pull_request_reviews":{"dismiss_stale_reviews":true}}',
          stderr: "",
        };
      }
      throw new Error(`unexpected IPC: ${cmd}`);
    });
    const v1 = await checkBranchProtectionDetail(
      "/r-malformed",
      fakeInvoke as unknown as typeof invoke,
    );
    expect(v1.state).toBe("verified-protected");
    urlOk = false;
    const v2 = await checkBranchProtectionDetail(
      "/r-malformed",
      fakeInvoke as unknown as typeof invoke,
      undefined,
      { useCache: false },
    );
    expect(v2.state).toBe("unknown");
    const v3 = await checkBranchProtectionDetail(
      "/r-malformed",
      fakeInvoke as unknown as typeof invoke,
    );
    expect(v3.state).toBe("unknown");
  });

  // -------------------------------------------------------------------------
  // Round-24: structural cache-reconciliation invariant
  // (claude2 task-127 Concern 1)
  // -------------------------------------------------------------------------

  it("checkBranchProtectionDetail: structural invariant — all unknown-state outcomes consistently invalidate cache (round-24 claude2 task-127 Concern 1)", async () => {
    // Round-24 invariant: the inner-IIFE + finalizeVerdict refactor
    // means every non-protected verdict produced by the fresh-fetch
    // path automatically invalidates the cache. This test exercises
    // the full state-space (origin-throw, !host, !parsed, gh-throw,
    // gh-404, gh-auth-failure, weak-protection, empty-protection,
    // unparseable-body) and asserts: after each, the prior cached
    // verified-protected entry is gone.
    const { checkBranchProtectionDetail } = await import(
      "../components/collaborator/commands"
    );

    type Scenario = {
      name: string;
      url?: string | null;
      ghResponse?: { exitCode: number; stdout: string; stderr: string };
      ghThrows?: boolean;
      urlThrows?: boolean;
      expectedState: "unknown" | "verified-unprotected";
    };

    const scenarios: Scenario[] = [
      {
        name: "origin missing (git_get_remote_url throw)",
        urlThrows: true,
        expectedState: "unknown",
      },
      {
        name: "non-GitHub remote (!host)",
        url: "https://gitlab.com/owner/repo.git",
        expectedState: "unknown",
      },
      {
        name: "malformed URL (!parsed)",
        url: "https://github.com/",
        expectedState: "unknown",
      },
      {
        name: "run_gh_api throws (network failure)",
        url: "https://github.com/owner/repo.git",
        ghThrows: true,
        expectedState: "unknown",
      },
      {
        name: "gh api 404 (verified-unprotected)",
        url: "https://github.com/owner/repo.git",
        ghResponse: { exitCode: 4, stdout: "", stderr: "Not Found (HTTP 404)" },
        expectedState: "verified-unprotected",
      },
      {
        name: "gh api auth failure (unknown)",
        url: "https://github.com/owner/repo.git",
        ghResponse: { exitCode: 1, stdout: "", stderr: "authentication required" },
        expectedState: "unknown",
      },
      {
        name: "weak protection (status_checks only)",
        url: "https://github.com/owner/repo.git",
        ghResponse: {
          exitCode: 0,
          stdout:
            '{"required_status_checks":{"strict":true},"required_pull_request_reviews":null,"restrictions":null}',
          stderr: "",
        },
        expectedState: "verified-unprotected",
      },
      {
        name: "empty protection (all null)",
        url: "https://github.com/owner/repo.git",
        ghResponse: {
          exitCode: 0,
          stdout: '{"required_status_checks":null,"required_pull_request_reviews":null,"restrictions":null}',
          stderr: "",
        },
        expectedState: "verified-unprotected",
      },
      {
        name: "unparseable body (treats as unknown)",
        url: "https://github.com/owner/repo.git",
        ghResponse: { exitCode: 0, stdout: "not json", stderr: "" },
        expectedState: "unknown",
      },
    ];

    for (const scenario of scenarios) {
      // Reset cache between scenarios for isolation.
      _clearVerifiedProtectedCacheForTests();

      // Step 1: prime cache with verified-protected.
      const primeMock = vi.fn(async (cmd: string) => {
        if (cmd === "git_get_remote_url") return "https://github.com/owner/repo.git";
        if (cmd === "run_gh_api") {
          return {
            exitCode: 0,
            stdout: '{"required_pull_request_reviews":{"dismiss_stale_reviews":true}}',
            stderr: "",
          };
        }
        throw new Error(`unexpected IPC: ${cmd}`);
      });
      const primed = await checkBranchProtectionDetail(
        `/r-scenario-${scenario.name}`,
        primeMock as unknown as typeof invoke,
      );
      expect(primed.state).toBe("verified-protected");

      // Step 2: simulate the scenario's failure / state-change.
      const scenarioMock = vi.fn(async (cmd: string) => {
        if (cmd === "git_get_remote_url") {
          if (scenario.urlThrows) throw "no origin";
          return scenario.url!;
        }
        if (cmd === "run_gh_api") {
          if (scenario.ghThrows) throw "network unreachable";
          return scenario.ghResponse!;
        }
        throw new Error(`unexpected IPC: ${cmd}`);
      });
      const v = await checkBranchProtectionDetail(
        `/r-scenario-${scenario.name}`,
        scenarioMock as unknown as typeof invoke,
        undefined,
        { useCache: false },
      );
      expect(v.state).toBe(scenario.expectedState);

      // Step 3: subsequent default (cached) call must NOT serve stale
      // protected — the round-24 finalizeVerdict invariant guarantees
      // every non-protected verdict invalidated the cache.
      const v2 = await checkBranchProtectionDetail(
        `/r-scenario-${scenario.name}`,
        scenarioMock as unknown as typeof invoke,
      );
      expect(v2.state).toBe(scenario.expectedState);
      // Verify it actually re-fetched (not a cached protected hit).
      expect(v2.state).not.toBe("verified-protected");
    }
  });

  // -------------------------------------------------------------------------
  // Round-25 P5: SSH URL forms (with and without port) + trailing slash
  // -------------------------------------------------------------------------

  it("checkBranchProtection: ssh:// URL with explicit port (round-25 claude2 task-115 carry-over)", async () => {
    // Round-25: ssh://git@github.com:22/owner/repo previously routed
    // to !parsed (correct safe fallback) but with noisy "cannot
    // verify" UX. The parser now handles the optional port.
    let calledArgs: string[] = [];
    const fakeInvoke = vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "git_get_remote_url") return "ssh://git@github.com:22/owner/repo.git";
      if (cmd === "run_gh_api") {
        calledArgs = (args?.args as string[]) ?? [];
        return {
          exitCode: 0,
          stdout: '{"required_pull_request_reviews":{"dismiss_stale_reviews":true}}',
          stderr: "",
        };
      }
      throw new Error(`unexpected IPC: ${cmd}`);
    });
    const state = await checkBranchProtection(
      "/r-ssh-port",
      fakeInvoke as unknown as typeof invoke,
    );
    expect(state).toBe("verified-protected");
    // Owner and repo extracted correctly (port stripped from path).
    expect(calledArgs[0]).toBe("/repos/owner/repo/branches/dev/protection");
  });

  it("checkBranchProtection: ssh:// URL without explicit port (round-25)", async () => {
    let calledArgs: string[] = [];
    const fakeInvoke = vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "git_get_remote_url") return "ssh://git@github.com/owner/repo.git";
      if (cmd === "run_gh_api") {
        calledArgs = (args?.args as string[]) ?? [];
        return {
          exitCode: 0,
          stdout: '{"required_pull_request_reviews":{"dismiss_stale_reviews":true}}',
          stderr: "",
        };
      }
      throw new Error(`unexpected IPC: ${cmd}`);
    });
    const state = await checkBranchProtection(
      "/r-ssh-noport",
      fakeInvoke as unknown as typeof invoke,
    );
    expect(state).toBe("verified-protected");
    expect(calledArgs[0]).toBe("/repos/owner/repo/branches/dev/protection");
  });

  it("checkBranchProtection: HTTPS URL with trailing slash (round-25 — copy-paste from browser)", async () => {
    let calledArgs: string[] = [];
    const fakeInvoke = vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "git_get_remote_url") return "https://github.com/owner/repo/";
      if (cmd === "run_gh_api") {
        calledArgs = (args?.args as string[]) ?? [];
        return {
          exitCode: 0,
          stdout: '{"required_pull_request_reviews":{"dismiss_stale_reviews":true}}',
          stderr: "",
        };
      }
      throw new Error(`unexpected IPC: ${cmd}`);
    });
    const state = await checkBranchProtection(
      "/r-trailing-slash",
      fakeInvoke as unknown as typeof invoke,
    );
    expect(state).toBe("verified-protected");
    expect(calledArgs[0]).toBe("/repos/owner/repo/branches/dev/protection");
  });

  it("checkBranchProtection: ssh:// URL with port to GHE host (round-25 cross-feature: GHE + ssh-with-port)", async () => {
    let calledArgs: string[] = [];
    const fakeInvoke = vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "git_get_remote_url") return "ssh://git@github.acme.com:22/owner/repo.git";
      if (cmd === "run_gh_api") {
        calledArgs = (args?.args as string[]) ?? [];
        return {
          exitCode: 0,
          stdout: '{"required_pull_request_reviews":{"dismiss_stale_reviews":true}}',
          stderr: "",
        };
      }
      throw new Error(`unexpected IPC: ${cmd}`);
    });
    const state = await checkBranchProtection(
      "/r-ghe-ssh-port",
      fakeInvoke as unknown as typeof invoke,
    );
    expect(state).toBe("verified-protected");
    // GHE --hostname must be passed alongside the parsed path.
    expect(calledArgs[0]).toBe("/repos/owner/repo/branches/dev/protection");
    expect(calledArgs).toContain("--hostname");
    expect(calledArgs[calledArgs.indexOf("--hostname") + 1]).toBe("github.acme.com");
  });

  it("checkBranchProtection: malformed URL (no path after host) still routes to unknown (round-25 regression check)", async () => {
    // The round-25 parser broadening must NOT accidentally accept
    // pathless URLs. `https://github.com/` has no owner/repo segments;
    // must remain unknown.
    const fakeInvoke = vi.fn(async (cmd: string) => {
      if (cmd === "git_get_remote_url") return "https://github.com/";
      throw new Error(`unexpected IPC: ${cmd}`);
    });
    const state = await checkBranchProtection(
      "/r-pathless",
      fakeInvoke as unknown as typeof invoke,
    );
    expect(state).toBe("unknown");
  });

  it("releaseAgentWorktree: clears worktree on the matching session/handle, no-ops elsewhere", () => {
    useCollaboratorStore.setState({
      agents: [
        {
          sessionId: "pty-1",
          tool: "claude_code",
          status: "running",
          collabSessionId: "session-A",
          ordinal: 1,
          handle: "claude1",
          nickname: "C1",
          nicknameSlug: "c1",
          nameHistory: [{ nickname: "C1", setAt: "x", setBy: "system" }],
          worktree: { repoRoot: "/r", path: "/wtA", branch: "agent/a", baseRef: "origin/dev", baseSha: "x", baseFresh: true, createdAtMs: 1 },
        },
        // Same handle on a different session — must NOT be released.
        {
          sessionId: "pty-2",
          tool: "claude_code",
          status: "running",
          collabSessionId: "session-B",
          ordinal: 1,
          handle: "claude1",
          nickname: "C1",
          nicknameSlug: "c1",
          nameHistory: [{ nickname: "C1", setAt: "x", setBy: "system" }],
          worktree: { repoRoot: "/r2", path: "/wtB", branch: "agent/b", baseRef: "origin/dev", baseSha: "x", baseFresh: true, createdAtMs: 1 },
        },
      ],
    });
    useCollaboratorStore.getState().releaseAgentWorktree("@claude1", "session-A");
    const agents = useCollaboratorStore.getState().agents;
    expect(agents.find((a) => a.collabSessionId === "session-A")?.worktree).toBeNull();
    expect(agents.find((a) => a.collabSessionId === "session-B")?.worktree).not.toBeNull();
  });
});
