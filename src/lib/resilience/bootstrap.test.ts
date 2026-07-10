import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import {
  runResilienceBootstrap,
  scheduleTopologyPersist,
  _resetBootstrapForTests,
} from "./bootstrap";
import {
  signalAdoptionReady,
  isRestoredSessionId,
  recoveryOrchestrator,
  _resetAdoptionBarrierForTests,
} from "./RecoveryOrchestrator";
import { heartbeat } from "./Heartbeat";
import { resilienceConfig } from "./config";
import { useTerminalStore } from "../../stores/terminalStore";
import { useCollaboratorStore } from "../../stores/collaboratorStore";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(null),
}));

/** Pending recovery session in the pinned nested wire shape. */
const PENDING_SESSION = {
  token: "rs-test-1",
  decision: {
    proceed: true,
    sign: "webcontent-death",
    action: "reload-in-place",
    reason: "test",
  },
  suppressTeardown: true,
  createdAt: 1,
  expiresAt: Number.MAX_SAFE_INTEGER,
  attempts: 0,
  maxAttempts: 2,
};

/** One terminal leaf + one collaborator leaf with one agent. */
const SNAPSHOT = {
  version: resilienceConfig.snapshotSchemaVersion,
  capturedAt: 1,
  activeTabId: "tab-1",
  tabs: [
    {
      id: "tab-1",
      title: "restored",
      activePaneSessionId: "term-1",
      maximizedPaneSessionId: null,
      paneTree: {
        type: "split",
        direction: "horizontal",
        children: [
          { type: "leaf", kind: "terminal", sessionId: "term-1", cwd: null, agents: null },
          {
            type: "leaf",
            kind: "collaborator",
            sessionId: "collab-1",
            cwd: null,
            agents: [
              {
                sessionId: "agent-1",
                collabSessionId: "collab-1",
                tool: "claude_code",
                cwd: null,
                status: "running",
                handle: "claude1",
                ordinal: 1,
                nickname: "Claude Code #1",
                nicknameSlug: "claude-code-1",
                nameHistory: [
                  { nickname: "Claude Code #1", setAt: "2026-01-01T00:00:00.000Z", setBy: "system" },
                ],
                publishOptedIn: true,
              },
            ],
          },
        ],
      },
    },
  ],
};

function mockIpc(overrides: {
  pending?: typeof PENDING_SESSION | null;
  snapshot?: typeof SNAPSHOT | null;
  onReattach?: (sessionId: string) => void;
}) {
  const reattached: string[] = [];
  vi.mocked(invoke).mockImplementation(async (cmd: string, args?: unknown) => {
    switch (cmd) {
      case "read_death_evidence":
        return {
          observedTermination: overrides.pending != null,
          lastGoodBeatAt: 1,
          gapMs: 30000,
          launchCount: 2,
          reloadedSinceLastBeat: overrides.pending != null,
        };
      case "load_recovery_session":
        return overrides.pending ?? null;
      case "claim_recovery_attempt":
        return overrides.pending ? { ...overrides.pending, attempts: 1 } : null;
      case "load_topology":
        return overrides.snapshot ?? null;
      case "reattach_pty": {
        const id = (args as { sessionId: string }).sessionId;
        reattached.push(id);
        overrides.onReattach?.(id);
        return { sessionId: id, alive: true, replayBytes: 42 };
      }
      default:
        return null;
    }
  });
  return { reattached };
}

function resetStores() {
  useTerminalStore.setState({ tabs: [], activeTabId: null });
  useCollaboratorStore.setState({ agents: [], tasksBySession: {}, logEntriesBySession: {} });
}

beforeEach(() => {
  resetStores();
  _resetBootstrapForTests();
  _resetAdoptionBarrierForTests();
  vi.mocked(invoke).mockClear();
  vi.mocked(invoke).mockResolvedValue(null);
});

afterEach(() => {
  heartbeat.stop();
  _resetBootstrapForTests();
  _resetAdoptionBarrierForTests();
});

describe("bootstrap Phase A ordering (node 12)", () => {
  it("healthy boot: registers __ct_probe, reads evidence before starting the heartbeat, and never resumes", async () => {
    const calls: string[] = [];
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      calls.push(cmd);
      return null;
    });

    await runResilienceBootstrap();

    expect(typeof window.__ct_probe).toBe("function");
    // Evidence read precedes any heartbeat forward (contract: read BEFORE
    // the first new beat overwrites the durable last-beat).
    const evidenceIdx = calls.indexOf("read_death_evidence");
    const firstBeatIdx = calls.indexOf("report_heartbeat");
    expect(evidenceIdx).toBeGreaterThanOrEqual(0);
    if (firstBeatIdx !== -1) {
      expect(evidenceIdx).toBeLessThan(firstBeatIdx);
    }
    // No pending session → no claim, no reattach, no reload-in-progress.
    expect(calls).not.toContain("claim_recovery_attempt");
    expect(calls).not.toContain("reattach_pty");
    expect(recoveryOrchestrator.isReloadInProgress()).toBe(false);
  });

  it("__ct_probe answers with an immediate heartbeat tick", async () => {
    await runResilienceBootstrap();
    vi.mocked(invoke).mockClear();
    window.__ct_probe!();
    expect(heartbeat.lastBeatAt()).toBeGreaterThan(0);
  });

  it("pending session seeds isReloadInProgress before render unblocks", async () => {
    mockIpc({ pending: PENDING_SESSION, snapshot: SNAPSHOT });
    // Bootstrap resolves once the barrier is ARMED (restoreShell done) —
    // at that instant the restored tabs are already in the store, so the
    // first render can never observe the empty default-tab state.
    await runResilienceBootstrap();
    expect(recoveryOrchestrator.isReloadInProgress()).toBe(true);
    expect(useTerminalStore.getState().tabs.length).toBe(1);
    expect(useTerminalStore.getState().tabs[0].id).toBe("tab-1");
    // Restored ids are queryable by the adopt paths.
    expect(isRestoredSessionId("term-1")).toBe(true);
    expect(isRestoredSessionId("agent-1")).toBe(true);
    expect(isRestoredSessionId("someone-else")).toBe(false);
  });
});

describe("adoption-readiness barrier (node 12b)", () => {
  it("holds reattach until every expected adoption signals ready, then reattaches all", async () => {
    const { reattached } = mockIpc({ pending: PENDING_SESSION, snapshot: SNAPSHOT });
    await runResilienceBootstrap();

    // Barrier armed, mounts not yet ready → replay must not have fired.
    expect(reattached).toEqual([]);

    signalAdoptionReady("term-1");
    // Still one expected id outstanding.
    await Promise.resolve();
    expect(reattached).toEqual([]);

    signalAdoptionReady("agent-1");
    // Drain the resume pipeline (barrier resolve → reattach loop → clear).
    await vi.waitFor(() => {
      expect(reattached.sort()).toEqual(["agent-1", "term-1"]);
    });
    await vi.waitFor(() => {
      expect(recoveryOrchestrator.isReloadInProgress()).toBe(false);
    });
    // Recovery cleared the durable session.
    expect(vi.mocked(invoke).mock.calls.some((c) => c[0] === "clear_recovery_session")).toBe(true);
  });

  it("times out unready adoptions as lost and still reattaches the ready ones", async () => {
    vi.useFakeTimers();
    try {
      const { reattached } = mockIpc({ pending: PENDING_SESSION, snapshot: SNAPSHOT });
      await runResilienceBootstrap();

      signalAdoptionReady("term-1"); // agent-1 never mounts
      await vi.advanceTimersByTimeAsync(resilienceConfig.adoptionReadinessTimeoutMs + 1);

      expect(reattached).toEqual(["term-1"]);
      expect(recoveryOrchestrator.isReloadInProgress()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("late signals for non-restored ids are ignored", async () => {
    mockIpc({ pending: PENDING_SESSION, snapshot: SNAPSHOT });
    await runResilienceBootstrap();
    // Unknown id must not count toward the barrier.
    signalAdoptionReady("not-restored");
    await Promise.resolve();
    expect(vi.mocked(invoke).mock.calls.some((c) => c[0] === "reattach_pty")).toBe(false);
    // Complete the resume properly so its in-flight barrier/flag can't leak
    // into subsequent tests (the orchestrator is a module singleton).
    signalAdoptionReady("term-1");
    signalAdoptionReady("agent-1");
    await vi.waitFor(() => {
      expect(recoveryOrchestrator.isReloadInProgress()).toBe(false);
    });
  });
});

describe("shared topology persist trigger (node 15)", () => {
  it("an agent-only mutation triggers persist_topology (rev-2 3-way MED)", async () => {
    vi.useFakeTimers();
    try {
      await runResilienceBootstrap();
      vi.mocked(invoke).mockClear();
      vi.mocked(invoke).mockResolvedValue(null);

      // Mutate ONLY the collaborator store — no terminalStore change.
      useCollaboratorStore.setState({
        agents: [
          {
            sessionId: "agent-x",
            tool: "claude_code",
            status: "running",
            collabSessionId: "collab-x",
            ordinal: 1,
            handle: "claude1",
            nickname: "Claude Code #1",
            nicknameSlug: "claude-code-1",
            nameHistory: [
              { nickname: "Claude Code #1", setAt: "2026-01-01T00:00:00.000Z", setBy: "system" },
            ],
          },
        ],
      });

      await vi.advanceTimersByTimeAsync(resilienceConfig.persistDebounceMs + 50);
      expect(
        vi.mocked(invoke).mock.calls.some((c) => c[0] === "persist_topology"),
      ).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("persist is suppressed while a recovery is in flight", async () => {
    vi.useFakeTimers();
    try {
      mockIpc({ pending: PENDING_SESSION, snapshot: SNAPSHOT });
      await runResilienceBootstrap(); // barrier armed, recovery in flight
      vi.mocked(invoke).mockClear();

      scheduleTopologyPersist();
      await vi.advanceTimersByTimeAsync(resilienceConfig.persistDebounceMs + 50);
      expect(
        vi.mocked(invoke).mock.calls.some((c) => c[0] === "persist_topology"),
      ).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
