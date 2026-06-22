import type { TopologySnapshot, RestoreReport } from "./types";

/**
 * ITopologySnapshot — terminal/collaborator topology (de)serializer.
 *
 * Cohesion source: the seam between the live in-memory stores (terminalStore
 * tabs/paneTree, collaboratorStore agents, CollaboratorPane local `spawns`)
 * and a persistable form that survives a webview reload.
 *
 * Round-2 review fix (claude3 C1 — capture-timing paradox): persistence must
 * be PROACTIVE. Under hypothesis A the JS context is already dead at recovery
 * time, so there is nothing live to capture then. Therefore capture()+persist()
 * run continuously while HEALTHY (debounced on topology change), and recovery
 * starts from loadPersisted(), never from a capture taken after the failure.
 *
 * Round-2 review fix (claude3 C4 / codex3 #2 — sequencing): restore is split
 * so panes are rebuilt BEFORE any reattach; replay then flows into the
 * already-mounted xterms. This interface owns only the shell rebuild
 * (restoreShell); IPtyReattachClient owns the binding that follows.
 */
export interface ITopologySnapshot {
  /**
   * Responsibility: Serialize the current live topology (pure read).
   * Pipeline-position: (topology change / interval) -> THIS -> ITopologySnapshot.persist
   * Inputs: None. (reads terminalStore + collaboratorStore + pane `spawns`)
   * Outputs: TopologySnapshot — versioned, isomorphic to the live PaneNode;
   *   collaborator leaves carry their AgentSnapshot[] (tool/cwd/status/handle/…).
   * Side-effects: may invoke get_pty_cwd per leaf to capture cwd; no mutations.
   * Preconditions: stores are initialized and the JS context is alive
   *   (i.e. called while HEALTHY, not after a suspected death).
   * Postconditions: snapshot mirrors the live tab/pane tree (incl.
   *   maximizedPaneSessionId) at call time; JSON-round-trippable.
   * Failure-modes: a per-leaf cwd lookup failure degrades that leaf's cwd to
   *   null (not a throw); empty topology yields tabs: [].
   * Collaborators: None. (pure serialization; persist() does the I/O)
   */
  capture(): Promise<TopologySnapshot>;

  /**
   * Responsibility: Durably write the latest snapshot (proactive, debounced).
   * Pipeline-position: ITopologySnapshot.capture -> THIS -> (Rust durable store)
   * Inputs:
   *   - snapshot: TopologySnapshot — a fresh capture() result
   * Outputs: Promise<void>.
   * Side-effects: invokes persist_topology Rust IPC, writing to the PID-stable
   *   memory dir (NOT a front-end-named file — so a reload re-reads the same key).
   * Preconditions: snapshot is internally consistent (from capture()).
   * Postconditions: a subsequent loadPersisted() (even on a fresh JS context
   *   with the same Rust PID) returns this snapshot; idempotent per snapshot.
   * Failure-modes:
   *   - Error — thrown on IPC transport failure; callers (the debounced writer)
   *     swallow it so persistence pressure never destabilizes the app.
   * Collaborators: persist_topology (Rust IPC)
   */
  persist(snapshot: TopologySnapshot): Promise<void>;

  /**
   * Responsibility: Read the last durably-persisted snapshot after a reload.
   * Pipeline-position: app bootstrap / IRecoveryOrchestrator.recover -> THIS -> ITopologySnapshot.restoreShell
   * Inputs: None.
   * Outputs: Promise<TopologySnapshot | null> — the last persisted topology,
   *   or null if none exists (clean first run).
   * Side-effects: invokes load_topology Rust IPC (read-only).
   * Preconditions: the Rust process is the same one that persisted it (PID
   *   unchanged — reload, not restart).
   * Postconditions: returns exactly the snapshot last written by persist(), or
   *   null; never partially-formed.
   * Failure-modes:
   *   - Error — thrown only on IPC transport failure; "nothing persisted" is
   *     null, not a throw.
   * Collaborators: load_topology (Rust IPC)
   */
  loadPersisted(): Promise<TopologySnapshot | null>;

  /**
   * Responsibility: Rebuild panes/tabs/components from a snapshot WITHOUT
   *   spawning or killing any PTY (phase 1 of 2-phase restore).
   * Pipeline-position: ITopologySnapshot.loadPersisted -> THIS -> IPtyReattachClient.reattach
   * Inputs:
   *   - snapshot: TopologySnapshot — from loadPersisted() (version must be supported)
   * Outputs: RestoreReport — restored tab/session counts + failedSessions.
   * Side-effects: mutates terminalStore/collaboratorStore to recreate tabs,
   *   panes, maximized state, and seeds collaborator `spawns` from AgentSnapshot[].
   *   MUST run under the recovery-teardown-suppression guard so component
   *   unmount/remount during rebuild does NOT invoke kill_pty (see
   *   IRecoveryOrchestrator.isReloadInProgress; AgentMiniTerminal.tsx:820).
   * Preconditions: snapshot.version is supported; called on the fresh post-reload
   *   stores; IRecoveryOrchestrator.isReloadInProgress() is true (teardown suppressed).
   * Postconditions: a pane exists for each restorable leaf bound to its ORIGINAL
   *   sessionId (never a freshly generated one); xterm refs become available for
   *   the subsequent reattach; unrestorable leaves land in failedSessions.
   * Failure-modes:
   *   - Error — thrown only on unsupported snapshot.version; per-leaf failures
   *     are collected into failedSessions, not thrown.
   * Collaborators: None. (pane shell only; reattach binds PTYs next)
   */
  restoreShell(snapshot: TopologySnapshot): RestoreReport;
}
