import { describe, it, expect } from "vitest";
import { RecoveryOrchestrator } from "./RecoveryOrchestrator";
import type { ITopologySnapshot } from "./ITopologySnapshot";
import type { IRecoverySession } from "./IRecoverySession";
import type { IPtyReattachClient } from "./IPtyReattachClient";
import type { IResilienceStore } from "../../stores/IResilienceStore";
import type {
  DeathEvidence,
  RecoveryDecision,
  RecoverySession,
  TopologySnapshot,
  PtyReattachResult,
  RecoveryPhase,
  RootCauseSign,
  IncidentId,
} from "./types";

// ---- fixtures --------------------------------------------------------------

const EVIDENCE: DeathEvidence = {
  observedTermination: true,
  lastGoodBeatAt: 1,
  gapMs: 5000,
  launchCount: 2,
  reloadedSinceLastBeat: true,
};

function decision(sign: RootCauseSign): RecoveryDecision {
  return { proceed: true, sign, action: "reload-in-place", reason: "test" };
}

function session(over: Partial<RecoverySession> = {}): RecoverySession {
  return {
    token: "tok-1",
    decision: decision("webcontent-death"),
    suppressTeardown: true,
    createdAt: 0,
    expiresAt: Number.MAX_SAFE_INTEGER,
    attempts: 1,
    maxAttempts: 2,
    ...over,
  };
}

function twoTerminalSnapshot(): TopologySnapshot {
  return {
    version: 1,
    capturedAt: 0,
    activeTabId: "tab-1-1",
    tabs: [
      {
        id: "tab-1-1",
        title: "t",
        activePaneSessionId: "term-1",
        maximizedPaneSessionId: null,
        paneTree: {
          type: "split",
          direction: "horizontal",
          children: [
            { type: "leaf", kind: "terminal", sessionId: "term-1", cwd: null, agents: null },
            { type: "leaf", kind: "terminal", sessionId: "term-2", cwd: null, agents: null },
          ],
        },
      },
    ],
  };
}

// ---- fakes (record call order + args) --------------------------------------

interface Harness {
  o: RecoveryOrchestrator;
  calls: string[];
  phases: RecoveryPhase[];
  signs: RootCauseSign[];
}

function makeHarness(opts: {
  pending: RecoverySession | null;
  claimed?: RecoverySession | null;
  snapshot?: TopologySnapshot | null;
  reattach?: (sessionId: string) => PtyReattachResult | Promise<PtyReattachResult>;
}): Harness {
  const calls: string[] = [];
  const phases: RecoveryPhase[] = [];
  const signs: RootCauseSign[] = [];

  const topology: ITopologySnapshot = {
    capture: async () => twoTerminalSnapshot(),
    persist: async () => {},
    loadPersisted: async () => {
      calls.push("loadPersisted");
      return opts.snapshot === undefined ? twoTerminalSnapshot() : opts.snapshot;
    },
    restoreShell: (snap) => {
      calls.push("restoreShell");
      let restoredSessions = 0;
      for (const tab of snap.tabs) {
        const walk = (n: TopologySnapshot["tabs"][number]["paneTree"]): void => {
          if (n.type === "leaf") restoredSessions += 1;
          else {
            walk(n.children[0]);
            walk(n.children[1]);
          }
        };
        walk(tab.paneTree);
      }
      return { restoredTabs: snap.tabs.length, restoredSessions, failedSessions: [] };
    },
  };

  const sessionClient: IRecoverySession = {
    begin: async () => session(),
    loadPending: async () => {
      calls.push("loadPending");
      return opts.pending;
    },
    claimAttempt: async () => {
      calls.push("claimAttempt");
      return opts.claimed === undefined ? session() : opts.claimed;
    },
    clear: async () => {
      calls.push("clear");
    },
  };

  const reattach: IPtyReattachClient = {
    reattach: async (sessionId) => {
      calls.push(`reattach:${sessionId}`);
      return opts.reattach
        ? opts.reattach(sessionId)
        : { sessionId, alive: true, replayBytes: 0 };
    },
  };

  const store: IResilienceStore = {
    beginIncident: (): IncidentId => {
      calls.push("beginIncident");
      return "inc-1";
    },
    recordBoundaryCaught: () => {},
    recordSign: (sign) => {
      signs.push(sign);
    },
    recordWatermark: () => {},
    transition: (to) => {
      phases.push(to);
    },
    currentIncidentId: () => null,
    snapshotState: () => ({
      phase: "healthy",
      lastSign: null,
      lastWatermark: null,
      recoveryAttempts: 0,
      boundaryCaught: false,
      lastIncidentId: null,
    }),
  };

  return {
    o: new RecoveryOrchestrator(topology, sessionClient, reattach, store),
    calls,
    phases,
    signs,
  };
}

// ---- tests -----------------------------------------------------------------

describe("RecoveryOrchestrator.resumeAfterReload", () => {
  it("no pending session → fails fast without any restore side-effect", async () => {
    const h = makeHarness({ pending: null });
    const out = await h.o.resumeAfterReload(EVIDENCE);
    expect(out.phase).toBe("failed");
    expect(out.success).toBe(false);
    expect(h.calls).not.toContain("restoreShell");
    expect(h.calls).not.toContain("claimAttempt");
  });

  it("claimAttempt returns null (stale token) → clear + fail, no restore", async () => {
    const h = makeHarness({ pending: session(), claimed: null });
    const out = await h.o.resumeAfterReload(EVIDENCE);
    expect(out.phase).toBe("failed");
    expect(h.calls).toContain("clear");
    expect(h.calls).not.toContain("restoreShell");
    expect(h.phases).toContain("failed");
  });

  it("attempts > maxAttempts → fail fast, no restore", async () => {
    const h = makeHarness({
      pending: session(),
      claimed: session({ attempts: 3, maxAttempts: 2 }),
    });
    const out = await h.o.resumeAfterReload(EVIDENCE);
    expect(out.phase).toBe("failed");
    expect(h.calls).not.toContain("restoreShell");
  });

  it("claims ONE attempt BEFORE any restore side-effect (crash-loop ordering)", async () => {
    const h = makeHarness({ pending: session(), claimed: session() });
    await h.o.resumeAfterReload(EVIDENCE);
    expect(h.calls.indexOf("claimAttempt")).toBeLessThan(h.calls.indexOf("restoreShell"));
    expect(h.calls.indexOf("restoreShell")).toBeLessThan(h.calls.indexOf("reattach:term-1"));
  });

  it("happy path → recovered, both PTYs reattached, sign from session.decision", async () => {
    const h = makeHarness({
      pending: session({ decision: decision("webcontent-death") }),
      claimed: session({ decision: decision("webcontent-death") }),
    });
    const out = await h.o.resumeAfterReload(EVIDENCE);
    expect(out.phase).toBe("recovered");
    expect(out.success).toBe(true);
    expect(out.restoredSessions).toBe(2);
    expect(out.lostSessions).toEqual([]);
    // Sign provenance: from the durable decision, NOT a fresh classify of EVIDENCE.
    expect(h.signs).toEqual(["webcontent-death"]);
    expect(h.phases).toEqual(["suspect", "recovering", "recovered"]);
    expect(h.calls).toContain("clear");
  });

  it("a dead PTY (alive:false) lands in lostSessions and flips success:false", async () => {
    const h = makeHarness({
      pending: session(),
      claimed: session(),
      reattach: (sessionId) => ({
        sessionId,
        alive: sessionId !== "term-2",
        replayBytes: 0,
      }),
    });
    const out = await h.o.resumeAfterReload(EVIDENCE);
    expect(out.phase).toBe("recovered");
    expect(out.success).toBe(false);
    expect(out.restoredSessions).toBe(1);
    expect(out.lostSessions).toEqual(["term-2"]);
  });

  it("no durable snapshot → transitions to failed, clears, and rethrows", async () => {
    const h = makeHarness({ pending: session(), claimed: session(), snapshot: null });
    await expect(h.o.resumeAfterReload(EVIDENCE)).rejects.toThrow(/no durable snapshot/);
    expect(h.phases).toContain("failed");
    expect(h.calls).toContain("clear");
  });
});
