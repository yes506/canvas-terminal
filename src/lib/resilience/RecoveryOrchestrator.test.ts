import { describe, it, expect, afterEach } from "vitest";
import {
  RecoveryOrchestrator,
  collectSnapshotSessionIds,
} from "./RecoveryOrchestrator";
import { resilienceConfig } from "./config";
import type { AgentSnapshot, TopologySnapshot } from "./types";

function agent(sessionId: string): AgentSnapshot {
  return {
    sessionId,
    collabSessionId: "collab-1",
    tool: "claude_code",
    cwd: null,
    status: "running",
    handle: "claude1",
    ordinal: 1,
    nickname: "Claude Code #1",
    nicknameSlug: "claude-code-1",
    nameHistory: [{ nickname: "Claude Code #1", setAt: "t", setBy: "system" }],
    publishOptedIn: true,
  };
}

describe("RecoveryOrchestrator.shouldRecover", () => {
  afterEach(() => {
    resilienceConfig.recoveryGateOpen = false;
  });

  it("returns proceed:false for every sign while the #3 gate is CLOSED", () => {
    const o = new RecoveryOrchestrator();
    for (const sign of [
      "webcontent-death",
      "js-fatal",
      "gpu-loss",
      "unknown",
    ] as const) {
      const d = o.shouldRecover(sign);
      expect(d.proceed).toBe(false);
      expect(d.action).toBe("none");
    }
  });

  it("authorizes only webcontent-death once the gate is OPEN", () => {
    resilienceConfig.recoveryGateOpen = true;
    const o = new RecoveryOrchestrator();
    expect(o.shouldRecover("webcontent-death")).toMatchObject({
      proceed: true,
      action: "reload-in-place",
    });
    // B recovers in-tree; advisory signs never auto-reload.
    expect(o.shouldRecover("js-fatal").proceed).toBe(false);
    expect(o.shouldRecover("gpu-loss").proceed).toBe(false);
    expect(o.shouldRecover("unknown").proceed).toBe(false);
  });
});

describe("collectSnapshotSessionIds (F1 regression)", () => {
  it("collects terminal-leaf ids and agent ids, but NOT collaborator-container ids", () => {
    const snapshot: TopologySnapshot = {
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
              {
                type: "leaf",
                kind: "collaborator",
                sessionId: "collab-container-1",
                cwd: null,
                agents: [agent("agent-1"), agent("agent-2")],
              },
            ],
          },
        },
      ],
    };
    const ids = collectSnapshotSessionIds(snapshot);
    expect(ids).toEqual(["term-1", "agent-1", "agent-2"]);
    // The container leaf (no backing PTY) must never enter the reattach loop.
    expect(ids).not.toContain("collab-container-1");
  });

  it("handles a collaborator leaf with no agents without emitting its id", () => {
    const snapshot: TopologySnapshot = {
      version: 1,
      capturedAt: 0,
      activeTabId: "tab-1-1",
      tabs: [
        {
          id: "tab-1-1",
          title: "t",
          activePaneSessionId: "collab-1",
          maximizedPaneSessionId: null,
          paneTree: {
            type: "leaf",
            kind: "collaborator",
            sessionId: "collab-1",
            cwd: null,
            agents: null,
          },
        },
      ],
    };
    expect(collectSnapshotSessionIds(snapshot)).toEqual([]);
  });
});
