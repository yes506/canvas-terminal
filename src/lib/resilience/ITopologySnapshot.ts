import type { TopologySnapshot, RestoreReport } from "./types";

/**
 * ITopologySnapshot — terminal/collaborator topology (de)serializer.
 *
 * Cohesion source: the single seam between the live in-memory stores
 * (terminalStore tabs/paneTree, collaboratorStore agents) and a
 * persistable form that survives a webview reload. Because the front-end
 * topology lives ONLY in memory today, this is the load-bearing piece that
 * makes reload non-destructive. The PID-stable collab-memory dir + live
 * Rust PTYs are what the restored sessions reattach against.
 */
export interface ITopologySnapshot {
  /**
   * Responsibility: Serialize the current terminal+collaborator topology.
   * Pipeline-position: IRecoveryOrchestrator.recover -> THIS -> IPtyReattachClient.reattach
   * Inputs: None. (reads terminalStore + collaboratorStore)
   * Outputs: TopologySnapshot — versioned, fully serializable; every leaf
   *   carries its sessionId and (best-effort) cwd.
   * Side-effects: may invoke get_pty_cwd IPC per leaf to capture cwd; no
   *   store mutations.
   * Preconditions: stores are initialized; called before the reload is
   *   triggered (capture must precede teardown).
   * Postconditions: snapshot.tabs reflects the live tab/pane tree at call
   *   time; snapshot is JSON-round-trippable.
   * Failure-modes: a per-leaf cwd lookup failure degrades that leaf's cwd to
   *   null (not a throw); a fully empty topology yields tabs: [].
   * Collaborators: persist_topology (Rust IPC — durable store across reload)
   */
  capture(): Promise<TopologySnapshot>;

  /**
   * Responsibility: Rebuild live stores from a persisted snapshot.
   * Pipeline-position: IPtyReattachClient.replayInto -> THIS -> recovery complete
   * Inputs:
   *   - snapshot: TopologySnapshot — produced by capture() (version must be
   *     a schema this restorer supports)
   * Outputs: RestoreReport — counts of restored tabs/sessions + failedSessions.
   * Side-effects: mutates terminalStore/collaboratorStore to recreate tabs,
   *   panes, and active selections; does NOT spawn new PTYs (reattach owns that).
   * Preconditions: snapshot.version is supported; called after the reload,
   *   on a freshly-mounted store; PTY reattach has populated session handles.
   * Postconditions: for each restorable leaf a pane exists bound to its
   *   original sessionId; unrestorable leaves are listed in failedSessions
   *   and omitted from the tree.
   * Failure-modes:
   *   - Error — thrown only on an unsupported snapshot.version (incompatible
   *     schema); per-leaf failures are collected into failedSessions, not thrown.
   * Collaborators: load_topology (Rust IPC — durable read across reload)
   */
  restore(snapshot: TopologySnapshot): RestoreReport;
}
