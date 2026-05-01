import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(null),
}));

// We import the helper, not the component — avoids xterm.js/PTY plumbing.
import { handlePtyExit, cleanupWorktreedAgent } from "./AgentMiniTerminal";
import type { WorktreeMetadata } from "../../types/collaborator";
import * as Store from "../../stores/collaboratorStore";
import { useCollaboratorStore } from "../../stores/collaboratorStore";

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

  // -------------------------------------------------------------------
  // cleanupWorktreedAgent (round-9 cleanup-helper extracted for testing,
  // closes codex2 task-79 M2 test-gap + codex1 task-77 H1 ordering bug).
  // -------------------------------------------------------------------

  describe("cleanupWorktreedAgent (round-9)", () => {
    const fakeWorktree: WorktreeMetadata = {
      repoRoot: "/r",
      path: "/wt",
      branch: "agent/test-1",
      baseRef: "origin/dev",
      baseSha: "abc123",
      baseFresh: true,
      createdAtMs: 1,
    };

    it("ENFORCES kill_pty BEFORE git_diff_summary (codex1 task-77 H1 ordering)", async () => {
      // The freeze-before-snapshot invariant LB1 enforces in the scanner
      // must also hold here. A still-running PTY could mutate the
      // worktree between the kill IPC and the diff if kill weren't
      // awaited first; mis-classifying the worktree as clean would
      // silently auto-remove pending work.
      let nextCallIdx = 0;
      let killAt: number | null = null;
      let diffAt: number | null = null;
      const inv = vi.fn(async (cmd: string) => {
        const idx = nextCallIdx++;
        if (cmd === "kill_pty") {
          killAt = idx;
          return null;
        }
        if (cmd === "git_diff_summary") {
          diffAt = idx;
          return {
            hasChanges: false,
            committed: [],
            staged: [],
            unstaged: [],
            untracked: [],
          };
        }
        if (cmd === "git_worktree_remove") return { kind: "fullyRemoved" };
        return null;
      });
      const removeAgent = vi.fn();
      const setAgentStatus = vi.fn();
      await cleanupWorktreedAgent({
        sessionId: "pty-1",
        worktree: fakeWorktree,
        storeOps: { removeAgent, setAgentStatus },
        invokeShim: inv as unknown as typeof invoke,
      });
      expect(killAt).not.toBeNull();
      expect(diffAt).not.toBeNull();
      expect(killAt!).toBeLessThan(diffAt!);
    });

    it("hasChanges=false → removes worktree + removes agent record", async () => {
      const inv = vi.fn(async (cmd: string) => {
        if (cmd === "kill_pty") return null;
        if (cmd === "git_diff_summary") {
          return {
            hasChanges: false,
            committed: [],
            staged: [],
            unstaged: [],
            untracked: [],
          };
        }
        if (cmd === "git_worktree_remove") return { kind: "fullyRemoved" };
        return null;
      });
      const removeAgent = vi.fn();
      const setAgentStatus = vi.fn();
      await cleanupWorktreedAgent({
        sessionId: "pty-1",
        worktree: fakeWorktree,
        storeOps: { removeAgent, setAgentStatus },
        invokeShim: inv as unknown as typeof invoke,
      });
      expect(inv).toHaveBeenCalledWith(
        "git_worktree_remove",
        expect.objectContaining({ worktreePath: fakeWorktree.path }),
      );
      expect(removeAgent).toHaveBeenCalledWith("pty-1");
      expect(setAgentStatus).not.toHaveBeenCalled();
    });

    it("hasChanges=true → preserves worktree, sets agent status to exited", async () => {
      const inv = vi.fn(async (cmd: string) => {
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
      const removeAgent = vi.fn();
      const setAgentStatus = vi.fn();
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      await cleanupWorktreedAgent({
        sessionId: "pty-1",
        worktree: fakeWorktree,
        storeOps: { removeAgent, setAgentStatus },
        invokeShim: inv as unknown as typeof invoke,
      });
      // git_worktree_remove must NOT be called.
      expect(inv).not.toHaveBeenCalledWith(
        "git_worktree_remove",
        expect.anything(),
      );
      // Record preserved with exited status.
      expect(setAgentStatus).toHaveBeenCalledWith("pty-1", "exited");
      expect(removeAgent).not.toHaveBeenCalled();
      warnSpy.mockRestore();
    });

    it("diff probe failure → preserves agent record defensively (unknown ≠ silent cleanup)", async () => {
      const inv = vi.fn(async (cmd: string) => {
        if (cmd === "kill_pty") return null;
        if (cmd === "git_diff_summary")
          throw new Error("worktree path missing");
        return null;
      });
      const removeAgent = vi.fn();
      const setAgentStatus = vi.fn();
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      await cleanupWorktreedAgent({
        sessionId: "pty-1",
        worktree: fakeWorktree,
        storeOps: { removeAgent, setAgentStatus },
        invokeShim: inv as unknown as typeof invoke,
      });
      // Probe failure → preserve, don't auto-remove.
      expect(setAgentStatus).toHaveBeenCalledWith("pty-1", "exited");
      expect(removeAgent).not.toHaveBeenCalled();
      // No git_worktree_remove invocation.
      expect(inv).not.toHaveBeenCalledWith(
        "git_worktree_remove",
        expect.anything(),
      );
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("worktree diff probe failed"),
        expect.any(Error),
      );
      warnSpy.mockRestore();
    });

    it("kill_pty failure does NOT abort cleanup — diff still runs (a dead PTY is already frozen)", async () => {
      const inv = vi.fn(async (cmd: string) => {
        if (cmd === "kill_pty") throw new Error("PTY already exited");
        if (cmd === "git_diff_summary") {
          return {
            hasChanges: false,
            committed: [],
            staged: [],
            unstaged: [],
            untracked: [],
          };
        }
        if (cmd === "git_worktree_remove") return { kind: "fullyRemoved" };
        return null;
      });
      const removeAgent = vi.fn();
      const setAgentStatus = vi.fn();
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      await cleanupWorktreedAgent({
        sessionId: "pty-1",
        worktree: fakeWorktree,
        storeOps: { removeAgent, setAgentStatus },
        invokeShim: inv as unknown as typeof invoke,
      });
      // Diff still ran despite kill failure.
      expect(inv).toHaveBeenCalledWith(
        "git_diff_summary",
        expect.anything(),
      );
      // Cleanup proceeded (worktree clean → fully removed).
      expect(inv).toHaveBeenCalledWith(
        "git_worktree_remove",
        expect.anything(),
      );
      expect(removeAgent).toHaveBeenCalledWith("pty-1");
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("kill_pty failed"),
        expect.any(Error),
      );
      warnSpy.mockRestore();
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
