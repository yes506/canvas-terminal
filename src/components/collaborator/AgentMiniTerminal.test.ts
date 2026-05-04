import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(null),
}));

// We import the helper, not the component — avoids xterm.js/PTY plumbing.
import {
  buildFallbackFsdPlanCommand,
  handlePtyExit,
  routeFsdParseResult,
  sanitizeFsd,
  shouldFeedFsdTap,
} from "./AgentMiniTerminal";
import type { FsdCommand } from "../../types/fsd";
import * as Store from "../../stores/collaboratorStore";
import { useCollaboratorStore } from "../../stores/collaboratorStore";
import type { FsdLeaderState } from "../../types/fsd";

const SESSION_ID = "pty-test-session";
const COLLAB_SESSION = "collab-test-session";

function resetStores() {
  useCollaboratorStore.setState({
    tasksBySession: {},
    statusMessages: {},
    logEntriesBySession: {},
    recentOutcomesBySession: {},
    contextSentByAgent: {},
    pendingMessagesByAgent: {},
    agents: [
      {
        sessionId: SESSION_ID,
        tool: "claude_code",
        status: "running",
        collabSessionId: COLLAB_SESSION,
        ordinal: 1,
        handle: "claude1",
        nickname: "Claude Code #1",
        nicknameSlug: "claude-code-1",
        nameHistory: [
          { nickname: "Claude Code #1", setAt: "2024-01-01T00:00:00.000Z", setBy: "system" },
        ],
      },
    ],
  });
}

describe("Phase 1.2 — handlePtyExit (task-31 implementation)", () => {
  beforeEach(() => {
    resetStores();
    vi.mocked(invoke).mockReset();
    vi.mocked(invoke).mockResolvedValue(null);
  });

  afterEach(() => {
    vi.mocked(invoke).mockImplementation(async () => null);
  });

  it("statement order: flush → writeProcessExitedLine → await scan → setAgentStatus(exited)", async () => {
    const events: string[] = [];

    // Pre-stage a .done.json that scanForTaskCompletions will process.
    const store = useCollaboratorStore.getState();
    const task = store.addTask(
      { objective: "x", title: "y", assignee: "@claude1" },
      COLLAB_SESSION,
    );
    const doneJson = JSON.stringify({
      task_id: task.id,
      status: "completed",
      author: "@claude1",
    });
    let deleted = false;
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "list_memory_files") {
        events.push("list_memory_files");
        return deleted ? [] : [`${task.id}.done.json`];
      }
      if (cmd === "read_memory_file") return deleted ? null : doneJson;
      if (cmd === "delete_memory_file") {
        deleted = true;
        return null;
      }
      return null;
    });

    const flush = vi.fn(() => events.push("flush"));
    const writeProcessExitedLine = vi.fn(() => events.push("write[Process exited]"));

    // Spy on setAgentStatus by intercepting the store action.
    const origSetAgentStatus = useCollaboratorStore.getState().setAgentStatus;
    useCollaboratorStore.setState({
      setAgentStatus: (sid, status) => {
        events.push(`setAgentStatus(${status})`);
        origSetAgentStatus(sid, status);
      },
    });

    await handlePtyExit({
      disposed: false,
      capture: { flush },
      writeProcessExitedLine,
      collabSessionId: COLLAB_SESSION,
      sessionId: SESSION_ID,
    });

    // Required ordering invariants:
    //   flush BEFORE [Process exited] BEFORE list_memory_files BEFORE setAgentStatus(exited)
    const flushIdx = events.indexOf("flush");
    const writeIdx = events.indexOf("write[Process exited]");
    const scanIdx = events.indexOf("list_memory_files");
    const statusIdx = events.indexOf("setAgentStatus(exited)");

    expect(flushIdx).toBeGreaterThanOrEqual(0);
    expect(writeIdx).toBeGreaterThan(flushIdx);
    expect(scanIdx).toBeGreaterThan(writeIdx);
    expect(statusIdx).toBeGreaterThan(scanIdx);

    // Confirm task terminalized BEFORE lifecycle flip — recentOutcome
    // must be recorded before setAgentStatus("exited") so a future
    // precedence-flip in getIndicatorPresentation can surface ✓.
    const updated = useCollaboratorStore.getState().tasksBySession[COLLAB_SESSION]?.find(
      (t) => t.id === task.id,
    );
    expect(updated?.status).toBe("completed");
    expect(useCollaboratorStore.getState().recentOutcomesBySession[COLLAB_SESSION]?.claude1?.kind)
      .toBe("completed");
  });

  it("scan IPC throw is internally swallowed; lifecycle still flips to exited", async () => {
    // This test exercises the OBSERVABLE invariant: even when the
    // underlying IPC throws, scanForTaskCompletions's own outer
    // try/catch (collaboratorStore.ts:969-971) swallows the error,
    // the awaited promise resolves normally, and the handler's
    // try/catch is NOT entered. The next test directly exercises the
    // handler's catch path by forcing scanForTaskCompletions itself
    // to reject.
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "list_memory_files") {
        throw new Error("simulated IPC failure");
      }
      return null;
    });

    const flush = vi.fn();
    const writeProcessExitedLine = vi.fn();

    await handlePtyExit({
      disposed: false,
      capture: { flush },
      writeProcessExitedLine,
      collabSessionId: COLLAB_SESSION,
      sessionId: SESSION_ID,
    });

    // Lifecycle MUST have flipped to "exited" even with the scan IPC throwing.
    const agent = useCollaboratorStore.getState().agents.find(
      (a) => a.sessionId === SESSION_ID,
    );
    expect(agent?.status).toBe("exited");

    // Visible exit notice still fired — order preserved across error path.
    expect(writeProcessExitedLine).toHaveBeenCalledTimes(1);
    expect(flush).toHaveBeenCalledTimes(1);
  });

  it("scanForTaskCompletions REJECTING directly hits handler's try/catch + console.warn", async () => {
    // Directly exercise the handler's catch branch by forcing
    // scanForTaskCompletions itself to reject (bypassing its internal
    // swallow). Today this code path is unreachable because
    // scanForTaskCompletions internally swallows IPC errors, but the
    // catch+warn-log is intentional defensive future-proofing — a future
    // refactor that surfaces the throw must NOT strand the lifecycle on
    // "running" or fail silently. Locks both invariants in one test.
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const scanSpy = vi
      .spyOn(Store, "scanForTaskCompletions")
      .mockRejectedValueOnce(new Error("simulated scan rejection"));

    const flush = vi.fn();
    const writeProcessExitedLine = vi.fn();

    await handlePtyExit({
      disposed: false,
      capture: { flush },
      writeProcessExitedLine,
      collabSessionId: COLLAB_SESSION,
      sessionId: SESSION_ID,
    });

    // Catch branch MUST have warn-logged with the expected prefix.
    expect(warnSpy).toHaveBeenCalledWith(
      "scanForTaskCompletions failed in pty-exit handler:",
      expect.any(Error),
    );
    // Lifecycle MUST still flip — the catch must not block setAgentStatus.
    const agent = useCollaboratorStore.getState().agents.find(
      (a) => a.sessionId === SESSION_ID,
    );
    expect(agent?.status).toBe("exited");

    scanSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it("disposed=true short-circuits — no flush, no write, no scan, no status flip", async () => {
    const flush = vi.fn();
    const writeProcessExitedLine = vi.fn();

    await handlePtyExit({
      disposed: true,
      capture: { flush },
      writeProcessExitedLine,
      collabSessionId: COLLAB_SESSION,
      sessionId: SESSION_ID,
    });

    expect(flush).not.toHaveBeenCalled();
    expect(writeProcessExitedLine).not.toHaveBeenCalled();
    expect(vi.mocked(invoke)).not.toHaveBeenCalled();
    const agent = useCollaboratorStore.getState().agents.find(
      (a) => a.sessionId === SESSION_ID,
    );
    expect(agent?.status).toBe("running"); // unchanged
  });

  it("null collabSessionId skips scan but still writes exit line and flips lifecycle", async () => {
    const flush = vi.fn();
    const writeProcessExitedLine = vi.fn();

    await handlePtyExit({
      disposed: false,
      capture: { flush },
      writeProcessExitedLine,
      collabSessionId: null,
      sessionId: SESSION_ID,
    });

    expect(flush).toHaveBeenCalledTimes(1);
    expect(writeProcessExitedLine).toHaveBeenCalledTimes(1);
    // No collabSession → no scan IPCs.
    expect(vi.mocked(invoke)).not.toHaveBeenCalled();
    const agent = useCollaboratorStore.getState().agents.find(
      (a) => a.sessionId === SESSION_ID,
    );
    expect(agent?.status).toBe("exited");
  });

  it("removed agent during scan: setAgentStatus is naturally a no-op", async () => {
    // Pre-stage scan to take a microtask.
    const store = useCollaboratorStore.getState();
    const task = store.addTask(
      { objective: "x", title: "y", assignee: "@claude1" },
      COLLAB_SESSION,
    );
    const doneJson = JSON.stringify({ task_id: task.id, status: "completed" });
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "list_memory_files") return [`${task.id}.done.json`];
      if (cmd === "read_memory_file") return doneJson;
      if (cmd === "delete_memory_file") return null;
      return null;
    });

    const flush = vi.fn();
    const writeProcessExitedLine = vi.fn();

    // Run handler and remove agent mid-await.
    const handlerPromise = handlePtyExit({
      disposed: false,
      capture: { flush },
      writeProcessExitedLine,
      collabSessionId: COLLAB_SESSION,
      sessionId: SESSION_ID,
    });
    // Simulate component cleanup deleting the agent during the scan.
    useCollaboratorStore.setState({ agents: [] });

    // Handler should resolve cleanly — setAgentStatus's `.map(a => …)`
    // finds no matching agent and returns the array unchanged.
    await expect(handlerPromise).resolves.toBeUndefined();
    // Agents array remains empty (no zombie agent re-introduced).
    expect(useCollaboratorStore.getState().agents).toHaveLength(0);
  });

  it("shouldFeedFsdTap: false for sessions with no FSD leader registration (parser isolation)", () => {
    expect(shouldFeedFsdTap({}, "session-1")).toBe(false);
  });

  it("shouldFeedFsdTap: false when tier is off (gate stops parsing on non-leaders)", () => {
    const state: Record<string, FsdLeaderState> = {
      "session-1": {
        leaderSessionId: "session-1",
        leaderHandle: "claude1",
        tier: "off",
        activeRunId: null,
        sessionNonce: "",
        runNonce: null,
        strikeCount: 0,
        emissionMode: "unavailable",
        tasks: [],
        status: null,
        turn: 0,
      },
    };
    expect(shouldFeedFsdTap(state, "session-1")).toBe(false);
  });

  it("shouldFeedFsdTap: true when tier is pilot (active leader; parser allowed)", () => {
    const state: Record<string, FsdLeaderState> = {
      "session-1": {
        leaderSessionId: "session-1",
        leaderHandle: "claude1",
        tier: "pilot",
        activeRunId: null,
        sessionNonce: "abc12345",
        runNonce: null,
        strikeCount: 0,
        emissionMode: "prompt_lines",
        tasks: [],
        status: null,
        turn: 0,
      },
    };
    expect(shouldFeedFsdTap(state, "session-1")).toBe(true);
  });

  it("shouldFeedFsdTap: gate is per-session — leader session A doesn't enable parsing on B", () => {
    const state: Record<string, FsdLeaderState> = {
      "session-A": {
        leaderSessionId: "session-A",
        leaderHandle: "claude1",
        tier: "pilot",
        activeRunId: null,
        sessionNonce: "abc12345",
        runNonce: null,
        strikeCount: 0,
        emissionMode: "prompt_lines",
        tasks: [],
        status: null,
        turn: 0,
      },
    };
    expect(shouldFeedFsdTap(state, "session-A")).toBe(true);
    expect(shouldFeedFsdTap(state, "session-B")).toBe(false);
  });

  it("sanitizeFsd: replaces ##FSD with # #FSD so re-injected text doesn't re-trigger the parser", () => {
    expect(sanitizeFsd("##FSD plan")).toBe("# #FSD plan");
    expect(sanitizeFsd('JSON parse failed near "##FSD {…}"'))
      .toBe('JSON parse failed near "# #FSD {…}"');
  });

  it("sanitizeFsd: handles null/undefined → empty string (defensive for resp.message ?? null)", () => {
    expect(sanitizeFsd(null)).toBe("");
    expect(sanitizeFsd(undefined)).toBe("");
  });

  it("sanitizeFsd: escapes EVERY occurrence (global regex, not just first)", () => {
    expect(sanitizeFsd("a ##FSD b ##FSD c")).toBe("a # #FSD b # #FSD c");
  });

  it("sanitizeFsd: word-boundary `\\b` prevents `##FSDish` from being rewritten", () => {
    // Both `D` and `i` are word characters, so `\b` does NOT match between
    // them — `##FSDish` is left as-is. This is correct: only `##FSD` followed
    // by whitespace (or end-of-string) can be parsed by the line-tap regex
    // `^\s*##FSD\s+`, so a non-token substring like `##FSDish` couldn't have
    // re-triggered the parser anyway. Aggressive replacement would corrupt
    // legitimate text (e.g. a discussion of `##FSDish-syntax`).
    expect(sanitizeFsd("##FSDish is fine")).toBe("##FSDish is fine");
    // Trailing whitespace IS at the boundary, so `##FSD plan` is rewritten.
    expect(sanitizeFsd("##FSD plan ##FSDish")).toBe("# #FSD plan ##FSDish");
  });

  it("sanitizeFsd: leaves the documented `# #FSD` escape untouched", () => {
    // Idempotency: applying the helper to already-escaped text is a no-op.
    expect(sanitizeFsd("# #FSD plan")).toBe("# #FSD plan");
    expect(sanitizeFsd("# #FSD ##FSD plan"))
      .toBe("# #FSD # #FSD plan"); // escaped left, raw middle → escaped middle
  });

  it("buildFallbackFsdPlanCommand: returns null when no FSD leader is registered for the session", () => {
    // No fsdByLeaderSessionId entry → null. This is the "FSD off / not a
    // leader" path; the line tap shouldn't have fired in the first place,
    // but the helper is defensive.
    expect(buildFallbackFsdPlanCommand("pty-leader-1", "collab-1")).toBeNull();
  });

  it("buildFallbackFsdPlanCommand: returns null when leader has no actionable assigned task (Phase 3.3 / codex2 task-40 P1)", () => {
    // Seed an active FSD leader with NO assigned tasks. The shorthand-plan
    // recovery synthesis MUST NOT proceed — there's no goal to put in the
    // synthesized plan. Returning null lets the caller (AgentMiniTerminal)
    // surface a local `[FSD MALFORMED COMMAND]` reminder instead of starting
    // a vague run.
    useCollaboratorStore.setState((s) => ({
      fsdByLeaderSessionId: {
        ...s.fsdByLeaderSessionId,
        [SESSION_ID]: {
          leaderSessionId: SESSION_ID,
          leaderHandle: "claude1",
          tier: "pilot",
          activeRunId: null,
          sessionNonce: "abc12345",
          runNonce: null,
          strikeCount: 0,
          emissionMode: "prompt_lines",
          tasks: [],
          status: null,
          turn: 0,
        },
      },
      tasksBySession: {}, // explicitly no tasks
    }));
    expect(buildFallbackFsdPlanCommand(SESSION_ID, COLLAB_SESSION)).toBeNull();
  });

  it("buildFallbackFsdPlanCommand: returns null when a run is already active (avoid clobbering an in-flight run)", () => {
    useCollaboratorStore.setState((s) => ({
      fsdByLeaderSessionId: {
        ...s.fsdByLeaderSessionId,
        [SESSION_ID]: {
          leaderSessionId: SESSION_ID,
          leaderHandle: "claude1",
          tier: "pilot",
          activeRunId: "run-already-going",
          sessionNonce: "abc12345",
          runNonce: "deadbeef",
          strikeCount: 0,
          emissionMode: "prompt_lines",
          tasks: [],
          status: "running",
          turn: 1,
        },
      },
    }));
    expect(buildFallbackFsdPlanCommand(SESSION_ID, COLLAB_SESSION)).toBeNull();
  });

  it("buildFallbackFsdPlanCommand: synthesizes a plan from the assigned task's objective when one exists", () => {
    useCollaboratorStore.setState((s) => ({
      fsdByLeaderSessionId: {
        ...s.fsdByLeaderSessionId,
        [SESSION_ID]: {
          leaderSessionId: SESSION_ID,
          leaderHandle: "claude1",
          tier: "pilot",
          activeRunId: null,
          sessionNonce: "abc12345",
          runNonce: null,
          strikeCount: 0,
          emissionMode: "prompt_lines",
          tasks: [],
          status: null,
          turn: 0,
        },
      },
      tasksBySession: {},
    }));
    useCollaboratorStore.getState().addTask(
      { objective: "audit FSD parser surface", title: "FSD audit", assignee: "@claude1" },
      COLLAB_SESSION,
    );

    const plan = buildFallbackFsdPlanCommand(SESSION_ID, COLLAB_SESSION);
    expect(plan).not.toBeNull();
    if (plan && plan.type === "plan") {
      expect(plan.goal).toBe("audit FSD parser surface");
      expect(plan.sn).toBe("abc12345");
      expect(plan.rn).toBe("");
      expect(plan.v).toBe(1);
      expect(plan.success_criteria?.length ?? 0).toBeGreaterThan(0);
    }
  });

  // Phase 2.1 + claude2 task-51 R5: the line-tap onCommand callback's routing
  // decision is now extracted as a pure helper so each branch — including the
  // load-bearing no-task local-reminder branch — is directly testable without
  // mounting xterm or mocking the IPC layer.
  describe("routeFsdParseResult — pure routing decision (R5)", () => {
    const validPlan: FsdCommand = {
      v: 1,
      cmd_id: "c1",
      sn: "abc12345",
      rn: "",
      run_id: "r1",
      type: "plan",
      goal: "test",
    };

    it("ok ParseResult → dispatch-cmd action carrying the parsed command", () => {
      const action = routeFsdParseResult({ kind: "ok", cmd: validPlan }, null);
      expect(action.kind).toBe("dispatch-cmd");
      if (action.kind === "dispatch-cmd") expect(action.cmd).toBe(validPlan);
    });

    it("skip ParseResult → ignore (not an `##FSD` line at all)", () => {
      expect(routeFsdParseResult({ kind: "skip" }, null).kind).toBe("ignore");
    });

    it("shorthand-plan WITH fallback synthesizable → dispatch-fallback (recovery path)", () => {
      const action = routeFsdParseResult(
        { kind: "malformed", code: "shorthand-plan", reason: "shorthand: ##FSD plan…" },
        validPlan,
      );
      expect(action.kind).toBe("dispatch-fallback");
      if (action.kind === "dispatch-fallback") expect(action.cmd).toBe(validPlan);
    });

    it("shorthand-plan WITHOUT fallback (no actionable task) → local-reminder, NOT report-strike", () => {
      // codex2 task-40 P1 hole: previously this case would fall through to
      // fsd_report_malformed, which returns out_of_scope (no active run), and
      // the frontend would silently suppress feedback. The local-reminder
      // action path bypasses the backend entirely so the leader sees a
      // recovery hint.
      const action = routeFsdParseResult(
        { kind: "malformed", code: "shorthand-plan", reason: "no goal" },
        null,
      );
      expect(action.kind).toBe("local-reminder");
      // Critically: NOT report-strike. Asserting the negative pins down the
      // codex2 P1 fix.
      expect(action.kind).not.toBe("report-strike");
    });

    it("shorthand-other (dispatch/done/blocked verbs) → report-strike (no recovery possible)", () => {
      const action = routeFsdParseResult(
        { kind: "malformed", code: "shorthand-other", reason: "shorthand: ##FSD dispatch…" },
        null,
      );
      expect(action.kind).toBe("report-strike");
    });

    it("json-parse / shape malformed codes → report-strike", () => {
      expect(
        routeFsdParseResult(
          { kind: "malformed", code: "json-parse", reason: "JSON parse failed" },
          null,
        ).kind,
      ).toBe("report-strike");
      expect(
        routeFsdParseResult(
          { kind: "malformed", code: "shape", reason: "missing field: type" },
          null,
        ).kind,
      ).toBe("report-strike");
    });

    it("shorthand-plan with fallback IGNORES other-code regardless (defensive priority)", () => {
      // The dispatch logic checks code === 'shorthand-plan' before consulting
      // the fallback. Document that other codes never use the fallback even
      // if one is supplied (e.g. by a future caller).
      const action = routeFsdParseResult(
        { kind: "malformed", code: "shorthand-other", reason: "x" },
        validPlan,
      );
      expect(action.kind).toBe("report-strike");
    });
  });

  it("keeps mini terminals on the default renderer to avoid idle WebGL blank panes", () => {
    // Behavioral guard: the WebGL addon must not be imported in the mini-terminal
    // path. Asserting only the import absence (not the rationale comment text)
    // keeps this test resilient to harmless comment rewording.
    const source = readFileSync(
      resolve(process.cwd(), "src/components/collaborator/AgentMiniTerminal.tsx"),
      "utf8",
    );

    expect(source).not.toContain("@xterm/addon-webgl");
    expect(source).not.toContain("WebglAddon");
  });
});
