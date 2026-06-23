import { invoke } from "@tauri-apps/api/core";
import type { ITopologySnapshot } from "./ITopologySnapshot";
import type {
  TopologySnapshot,
  TabSnapshot,
  SnapshotPane,
  AgentSnapshot,
  RestoreReport,
} from "./types";
import type { PaneNode } from "../../types/terminal";
import type { SpawnedAgent } from "../../types/collaborator";
import { useTerminalStore } from "../../stores/terminalStore";
import { useCollaboratorStore } from "../../stores/collaboratorStore";
import { resilienceConfig } from "./config";

/** Materialize the AgentSnapshot[] for one collaborator pane from the store. */
function agentSnapshotsFor(collabSessionId: string): AgentSnapshot[] {
  const agents = useCollaboratorStore.getState().agents;
  return agents
    .filter((a) => a.collabSessionId === collabSessionId)
    .map(toAgentSnapshot);
}

function toAgentSnapshot(a: SpawnedAgent): AgentSnapshot {
  return {
    sessionId: a.sessionId,
    collabSessionId: a.collabSessionId,
    tool: a.tool,
    cwd: null, // agent cwd is not tracked on the live row; unresolved at capture
    status: a.status,
    handle: a.handle,
    ordinal: a.ordinal,
    nickname: a.nickname,
    nicknameSlug: a.nicknameSlug,
    nameHistory: a.nameHistory.map((h) => ({
      nickname: h.nickname,
      setAt: h.setAt,
      setBy: h.setBy,
    })),
    // Resolve the optional `=== true` opt-in to a concrete boolean.
    publishOptedIn: a.publishOptedIn === true,
  };
}

/** Read a leaf's cwd via the cached IPC, degrading to null on any failure. */
async function readLeafCwd(sessionId: string): Promise<string | null> {
  try {
    return await invoke<string>("get_pty_cwd", { sessionId });
  } catch {
    return null;
  }
}

async function capturePane(node: PaneNode): Promise<SnapshotPane> {
  if (node.type === "leaf") {
    const cwd = await readLeafCwd(node.sessionId);
    const agents =
      node.kind === "collaborator" ? agentSnapshotsFor(node.sessionId) : null;
    return {
      type: "leaf",
      kind: node.kind,
      sessionId: node.sessionId,
      cwd,
      agents,
    };
  }
  return {
    type: "split",
    direction: node.direction,
    children: [
      await capturePane(node.children[0]),
      await capturePane(node.children[1]),
    ],
  };
}

/** Walk every leaf of a persisted SnapshotPane. */
function walkSnapshotLeaves(
  node: SnapshotPane,
  cb: (leaf: Extract<SnapshotPane, { type: "leaf" }>) => void,
): void {
  if (node.type === "leaf") {
    cb(node);
    return;
  }
  walkSnapshotLeaves(node.children[0], cb);
  walkSnapshotLeaves(node.children[1], cb);
}

/**
 * Concrete ITopologySnapshot — the (de)serializer seam between the live stores
 * and a reload-surviving persisted form. Persistence is PROACTIVE (capture +
 * persist run while HEALTHY); recovery starts from loadPersisted, never from a
 * post-failure capture. restoreShell rebuilds the pane shell with ORIGINAL
 * session ids via the restore-only store seams (no spawn-minting); the PTY
 * binding follows in IPtyReattachClient.
 */
export class TopologySnapshotService implements ITopologySnapshot {
  async capture(): Promise<TopologySnapshot> {
    const { tabs, activeTabId } = useTerminalStore.getState();
    const tabSnapshots: TabSnapshot[] = [];
    for (const tab of tabs) {
      tabSnapshots.push({
        id: tab.id,
        title: tab.title,
        paneTree: await capturePane(tab.paneTree),
        activePaneSessionId: tab.activePaneSessionId,
        maximizedPaneSessionId: tab.maximizedPaneSessionId,
      });
    }
    return {
      version: resilienceConfig.snapshotSchemaVersion,
      capturedAt: Date.now(),
      tabs: tabSnapshots,
      activeTabId,
    };
  }

  persist(snapshot: TopologySnapshot): Promise<void> {
    // Writes to the PID-stable Rust memory dir so a reload re-reads the same
    // key. Rejects on IPC transport failure; the debounced caller swallows it.
    return invoke<void>("persist_topology", { snapshot });
  }

  async loadPersisted(): Promise<TopologySnapshot | null> {
    // "Nothing persisted" comes back as null; only a transport failure rejects.
    const snapshot = await invoke<TopologySnapshot | null>("load_topology");
    return snapshot ?? null;
  }

  restoreShell(snapshot: TopologySnapshot): RestoreReport {
    if (snapshot.version !== resilienceConfig.snapshotSchemaVersion) {
      throw new Error(`unsupported snapshot.version ${snapshot.version}`);
    }
    const failedSessions: string[] = [];
    let restoredSessions = 0;

    // Phase 1 of the 2-phase restore: rebuild tabs/panes binding the ORIGINAL
    // session ids (no generateSessionId), under the teardown-suppression guard
    // owned by the orchestrator. The PTY rebind/replay is phase 2 (reattach).
    useTerminalStore.getState().restoreTabs(snapshot.tabs, snapshot.activeTabId);

    for (const tab of snapshot.tabs) {
      walkSnapshotLeaves(tab.paneTree, (leaf) => {
        restoredSessions += 1;
        if (leaf.kind === "collaborator" && leaf.agents) {
          // Seed the collaborator tiles verbatim (identity preserved).
          useCollaboratorStore.getState().restoreAgents(leaf.agents);
        }
      });
    }

    return {
      restoredTabs: snapshot.tabs.length,
      restoredSessions,
      failedSessions,
    };
  }
}

/** Shared singleton. */
export const topologySnapshotService = new TopologySnapshotService();
