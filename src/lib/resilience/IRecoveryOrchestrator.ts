import type {
  RootCauseSign,
  RecoveryDecision,
  RecoveryLaunch,
  RecoveryOutcome,
  DeathEvidence,
} from "./types";

/**
 * IRecoveryOrchestrator — the reload-crossing recovery control loop.
 *
 * Cohesion source: owns the recovery sequence, the evidence gate, and the
 * teardown-suppression seam — SPLIT across the webview reload boundary.
 *
 * Round-3 review fix (codex2 HIGH / claude3 HIGH / codex3 #1 — 3-way
 * convergence): a single in-memory recover() CANNOT trigger a reload and then
 * continue, because the reload destroys the JS context, its Promise, the
 * Zustand store, and any in-memory flag. (The same "in-memory can't cross a
 * reload" lesson behind the proactive-persistence fix, now applied to the
 * orchestrator's OWN control state.) Recovery is therefore two phases joined
 * by the durable IRecoverySession:
 *   - prepareReloadRecovery() runs in the OLD/live context (or is replaced by
 *     Rust on the A path, where no old-context JS survives to run it).
 *   - resumeAfterReload() runs in the FRESH context's bootstrap.
 *
 * Hypothesis B (js-fatal, JS alive) may instead recover IN-TREE via the
 * boundary's retry control (renderFallback) WITHOUT a reload; this orchestrator
 * owns only the reload-crossing path used for A (and B escalation).
 */
export interface IRecoveryOrchestrator {
  /**
   * Responsibility: Gate whether/how a recovery should run for a sign.
   * Pipeline-position: IResilienceStore.transition -> THIS -> IRecoveryOrchestrator.prepareReloadRecovery
   * Inputs:
   *   - sign: RootCauseSign — the classified incident sign
   * Outputs: RecoveryDecision — proceed flag + chosen action + reason.
   * Side-effects: None. (pure policy; reads config/evidence-gate state)
   * Preconditions: a sign has been recorded for the current incident.
   * Postconditions: proceed===false ⇒ action 'none'; while the #3 evidence gate
   *   is closed, returns proceed:false regardless of sign; 'gpu-loss' and
   *   'unknown' return proceed:false (advisory only — no auto-reload) until
   *   their handling is explicitly enabled.
   * Failure-modes: None. (total)
   * Collaborators: None.
   */
  shouldRecover(sign: RootCauseSign): RecoveryDecision;

  /**
   * Responsibility: Stage a reload-crossing recovery from the OLD/live context.
   * Pipeline-position: IRecoveryOrchestrator.shouldRecover -> THIS -> (reload) -> resumeAfterReload
   * Inputs:
   *   - decision: RecoveryDecision — proceed===true, non-'none' action
   * Outputs: Promise<RecoveryLaunch> — token + action + reloadRequested. Note:
   *   the returned Promise typically does NOT resolve in this context — the
   *   reload tears it down; the result type documents the staging contract.
   * Side-effects: opens a durable IRecoverySession (suppressTeardown=true),
   *   ENSURES a current persisted topology snapshot exists, then requests the
   *   reload/recreate. Writes durable state BEFORE requesting the reload.
   * Preconditions: decision.proceed===true; ITopologySnapshot.persist has been
   *   running proactively while healthy.
   * Postconditions: on the next (fresh) context, IRecoverySession.loadPending()
   *   returns this session; not called on the A path when JS is already dead
   *   (Rust sets the same durable session and reloads instead).
   * Failure-modes:
   *   - Error — thrown if the durable session cannot be written; the caller MUST
   *     NOT request a reload in that case (avoids a fresh boot with no intent).
   * Collaborators: IRecoverySession.begin, ITopologySnapshot.persist
   */
  prepareReloadRecovery(decision: RecoveryDecision): Promise<RecoveryLaunch>;

  /**
   * Responsibility: Resume + complete recovery on the FRESH post-reload context.
   * Pipeline-position: IRecoverySession.loadPending -> THIS -> ITopologySnapshot.restoreShell -> IPtyReattachClient.reattach
   * Inputs:
   *   - evidence: DeathEvidence — durable death evidence read on bootstrap
   * Outputs: Promise<RecoveryOutcome> — success + restored/lost counts + phase.
   * Side-effects: seeds the in-memory isReloadInProgress()=true from the durable
   *   session BEFORE any collaborator component mounts; opens the incident for the
   *   A/bootstrap path (IResilienceStore.beginIncident — the path-A issuance owner,
   *   per claude3 R2); runs loadPersisted → restoreShell → (await xterm refs) →
   *   reattach → verify; clears the durable session and the flag at the end.
   * Preconditions: IRecoverySession.loadPending() returned a non-expired session
   *   for this boot; called once, before normal app startup proceeds.
   * Postconditions: alive PTYs reattached + visible; dead PTYs become exited tiles
   *   preserving handle/log (per AgentSnapshot policy); durable session cleared;
   *   isReloadInProgress()===false; phase 'recovered' or 'failed'.
   * Failure-modes:
   *   - Error — thrown if no durable snapshot exists to restore; per-session
   *     failures surface in lostSessions, not thrown.
   *   - Cancelled — abort() mid-run resolves success:false / phase:'failed'.
   * Collaborators: IRecoverySession.loadPending, IRecoverySession.clear,
   *   ITopologySnapshot.loadPersisted, ITopologySnapshot.restoreShell,
   *   IPtyReattachClient.reattach, IResilienceStore.beginIncident,
   *   IResilienceStore.transition
   */
  resumeAfterReload(evidence: DeathEvidence): Promise<RecoveryOutcome>;

  /**
   * Responsibility: Report whether an orchestrated reload-recovery is active,
   *   so component teardown can suppress kill_pty.
   * Pipeline-position: (collaborator unmount cleanup) -> THIS -> skip-or-run kill_pty
   * Inputs: None.
   * Outputs: boolean — true from the start of prepareReloadRecovery through the
   *   completion of resumeAfterReload's reattach.
   * Side-effects: None (synchronous read). It is SEEDED from the durable
   *   IRecoverySession at fresh-context bootstrap (before mounts) so the flag is
   *   valid in the new context even though the prior in-memory flag was lost.
   * Preconditions: bootstrap has read IRecoverySession.loadPending() and seeded
   *   the flag before the first collaborator mount.
   * Postconditions: a true result obligates collaborator mini-terminal cleanup
   *   (AgentMiniTerminal.tsx:820) and any destroySession() restore path to SKIP
   *   invoke("kill_pty")/removeAgent. (Main terminal unmount already only parks —
   *   useTerminal.ts:42 — so it needs no guard.)
   * Failure-modes: None.
   * Collaborators: None. (seed source is IRecoverySession; read is in-memory)
   */
  isReloadInProgress(): boolean;

  /**
   * Responsibility: Abort an in-flight recovery and settle to a safe state.
   * Pipeline-position: (external trigger) -> THIS -> IRecoverySession.clear
   * Inputs:
   *   - reason: string — why the abort was requested (for diagnostics)
   * Outputs: void.
   * Side-effects: clears the durable IRecoverySession + the in-memory flag;
   *   transitions the FSM toward 'failed'; leaves already-restored panes intact.
   * Preconditions: None. (safe to call when nothing is running)
   * Postconditions: no further recovery side-effects occur for this incident;
   *   isReloadInProgress() returns false; loadPending() returns null next boot;
   *   idempotent.
   * Failure-modes: None.
   * Collaborators: IRecoverySession.clear, IResilienceStore.transition
   */
  abort(reason: string): void;
}
