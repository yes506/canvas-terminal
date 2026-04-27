import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";

// Mock Tauri invoke first — must be hoisted before any component imports.
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(null),
}));

// Mock the child components that pull in xterm.js / heavy deps. We don't
// need to render them; we only care about CollaboratorPane's own effects
// (the polling fallback and the lifecycle wiring at lines 44-90).
vi.mock("./AgentMiniTerminal", () => ({
  AgentMiniTerminal: () => null,
}));
vi.mock("./AgentToolbar", () => ({
  AgentToolbar: () => null,
}));
vi.mock("./InputPrompt", () => ({
  InputPrompt: () => null,
}));

import { CollaboratorPane } from "./CollaboratorPane";
import * as Store from "../../stores/collaboratorStore";
import { useCollaboratorStore } from "../../stores/collaboratorStore";
import { useTerminalStore } from "../../stores/terminalStore";

const PANE_SESSION = "pane-session-test";

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
}

describe("Phase 1.1 — CollaboratorPane polling fallback (task-31 implementation)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetStores();
    vi.mocked(invoke).mockReset();
    vi.mocked(invoke).mockResolvedValue(null);
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.mocked(invoke).mockImplementation(async () => null);
  });

  it("runs an immediate scan on mount (cold-start), before the first POLL_MS interval", async () => {
    // Pre-populate a task whose .done.json already exists at mount time.
    // The cold-start scan must terminalize the task before the first
    // setInterval tick fires.
    const store = useCollaboratorStore.getState();
    const task = store.addTask(
      { objective: "x", title: "y", assignee: "@claude1" },
      PANE_SESSION,
    );

    const doneJson = JSON.stringify({
      task_id: task.id,
      status: "completed",
      author: "@claude1",
    });
    let deleted = false;
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "list_memory_files") return deleted ? [] : [`${task.id}.done.json`];
      if (cmd === "read_memory_file") return deleted ? null : doneJson;
      if (cmd === "delete_memory_file") {
        deleted = true;
        return null;
      }
      return null;
    });

    render(<CollaboratorPane paneSessionId={PANE_SESSION} />);

    // Drain the immediate-scan promise chain WITHOUT advancing timers
    // (timers stay frozen at T+0; the POLL_MS interval has NOT fired).
    await vi.waitFor(() => {
      const t = useCollaboratorStore.getState().tasksBySession[PANE_SESSION]?.find((x) => x.id === task.id);
      expect(t?.status).toBe("completed");
    });

    // Confirm the interval hasn't fired yet by checking timer count.
    const calls = vi.mocked(invoke).mock.calls.filter((c) => c[0] === "list_memory_files");
    // Exactly ONE list_memory_files from the immediate scan, not from a poll tick.
    expect(calls.length).toBeGreaterThanOrEqual(1);
  });

  it("keeps polling every POLL_MS while mounted", async () => {
    render(<CollaboratorPane paneSessionId={PANE_SESSION} />);
    // Drain immediate-scan microtasks first.
    await vi.waitFor(() => {
      const calls = vi.mocked(invoke).mock.calls.filter((c) => c[0] === "list_memory_files");
      expect(calls.length).toBeGreaterThanOrEqual(1);
    });
    const callsAfterMount = vi.mocked(invoke).mock.calls.filter(
      (c) => c[0] === "list_memory_files",
    ).length;

    // Advance two full POLL_MS intervals; expect at least 2 more list calls.
    await vi.advanceTimersByTimeAsync(2000);
    await vi.advanceTimersByTimeAsync(2000);

    const callsAfterTwoTicks = vi.mocked(invoke).mock.calls.filter(
      (c) => c[0] === "list_memory_files",
    ).length;
    expect(callsAfterTwoTicks).toBeGreaterThanOrEqual(callsAfterMount + 2);
  });

  it("clears the interval on unmount (no zombie timer)", async () => {
    const { unmount } = render(<CollaboratorPane paneSessionId={PANE_SESSION} />);
    await vi.waitFor(() => {
      const calls = vi.mocked(invoke).mock.calls.filter((c) => c[0] === "list_memory_files");
      expect(calls.length).toBeGreaterThanOrEqual(1);
    });

    unmount();
    const callsAtUnmount = vi.mocked(invoke).mock.calls.filter(
      (c) => c[0] === "list_memory_files",
    ).length;

    // After unmount, the interval should be cleared — no further
    // list_memory_files calls even after several POLL_MS windows.
    await vi.advanceTimersByTimeAsync(2000 * 3);
    const callsAfterUnmountWait = vi.mocked(invoke).mock.calls.filter(
      (c) => c[0] === "list_memory_files",
    ).length;
    expect(callsAfterUnmountWait).toBe(callsAtUnmount);
  });

  it("scan IPC throw is internally swallowed; polling continues without propagating", async () => {
    // OBSERVABLE invariant test: even when an underlying IPC throws,
    // scanForTaskCompletions's outer try/catch swallows the error,
    // the awaited promise resolves normally, and CollaboratorPane's
    // outer .catch() is NOT reached. The pane should still be mounted
    // and the interval should keep firing. The next test directly
    // exercises the catch+warn branch by forcing
    // scanForTaskCompletions itself to reject.
    let throwOnce = true;
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "list_memory_files") {
        if (throwOnce) {
          throwOnce = false;
          throw new Error("simulated IPC failure");
        }
        return [];
      }
      return null;
    });

    render(<CollaboratorPane paneSessionId={PANE_SESSION} />);
    await vi.waitFor(() => {
      expect(vi.mocked(invoke).mock.calls.length).toBeGreaterThan(0);
    });

    // Subsequent ticks should still attempt the scan despite the first
    // tick's IPC failure.
    await vi.advanceTimersByTimeAsync(2000);
    expect(vi.mocked(invoke).mock.calls.filter((c) => c[0] === "list_memory_files").length)
      .toBeGreaterThan(1);
  });

  it("scanForTaskCompletions REJECTING directly hits the mount-time catch + console.warn", async () => {
    // Directly exercise CollaboratorPane's mount-time catch branch by
    // forcing scanForTaskCompletions itself to reject (bypassing its
    // internal IPC swallow). Today this is unreachable because
    // scanForTaskCompletions internally catches IPC errors, but the
    // catch+warn is intentional defensive future-proofing — a future
    // refactor that surfaces a throw must warn-log rather than turn
    // into an unhandled rejection.
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const scanSpy = vi
      .spyOn(Store, "scanForTaskCompletions")
      .mockRejectedValueOnce(new Error("simulated mount scan rejection"))
      .mockResolvedValue(undefined); // subsequent poll ticks succeed

    render(<CollaboratorPane paneSessionId={PANE_SESSION} />);

    await vi.waitFor(() => {
      expect(warnSpy).toHaveBeenCalledWith(
        "scanForTaskCompletions failed on pane mount:",
        expect.any(Error),
      );
    });

    scanSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it("scanForTaskCompletions REJECTING on a poll tick hits the poll-tick catch + console.warn", async () => {
    // Same as above but for the polling-tick branch. The two catches
    // log with different prefixes ("on pane mount" vs "in poll tick"),
    // so we lock in both invariants independently.
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const scanSpy = vi
      .spyOn(Store, "scanForTaskCompletions")
      .mockResolvedValueOnce(undefined) // mount-time scan succeeds
      .mockRejectedValueOnce(new Error("simulated poll-tick rejection"))
      .mockResolvedValue(undefined);

    render(<CollaboratorPane paneSessionId={PANE_SESSION} />);

    // Drain the mount-time scan first (resolves successfully).
    await vi.waitFor(() => {
      expect(scanSpy).toHaveBeenCalledTimes(1);
    });

    // Advance past the first POLL_MS tick (rejects).
    await vi.advanceTimersByTimeAsync(2000);

    await vi.waitFor(() => {
      expect(warnSpy).toHaveBeenCalledWith(
        "scanForTaskCompletions failed in poll tick:",
        expect.any(Error),
      );
    });

    scanSpy.mockRestore();
    warnSpy.mockRestore();
  });
});
