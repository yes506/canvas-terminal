import type {
  RootCauseSign,
  RecoveryDecision,
  RecoveryOutcome,
} from "./types";

/**
 * IRecoveryOrchestrator — the recovery control loop.
 *
 * Cohesion source: owns the end-to-end recovery sequence and the gate that
 * keeps it evidence-driven. It decides WHETHER to act on a sign, then runs
 * snapshot → reload → restore → reattach → verify. This is the only seam
 * allowed to trigger a reload, so the staged-implementation gate (ship
 * #1/#2 first, confirm the sign, then enable #3) lives here as shouldRecover.
 */
export interface IRecoveryOrchestrator {
  /**
   * Responsibility: Gate whether a recovery should run for a given sign.
   * Pipeline-position: IResilienceStore.transition -> THIS -> IRecoveryOrchestrator.recover
   * Inputs:
   *   - sign: RootCauseSign — the classified incident sign
   * Outputs: RecoveryDecision — proceed flag + chosen action + reason.
   * Side-effects: None. (pure policy; reads config/feature-gate state)
   * Preconditions: a sign has been recorded for the current incident.
   * Postconditions: proceed===false ⇒ action 'none'; while the #3 gate is
   *   closed (evidence not yet confirmed), returns proceed:false regardless
   *   of sign so no reload is triggered.
   * Failure-modes: None. (total; an 'unknown' sign maps to proceed:false)
   * Collaborators: None. (consults policy only)
   */
  shouldRecover(sign: RootCauseSign): RecoveryDecision;

  /**
   * Responsibility: Execute the full non-destructive recovery sequence.
   * Pipeline-position: IRecoveryOrchestrator.shouldRecover -> THIS -> ITopologySnapshot.capture
   * Inputs:
   *   - decision: RecoveryDecision — must have proceed===true and a non-'none' action
   * Outputs: Promise<RecoveryOutcome> — success + restored/lost session counts
   *   + elapsedMs + resulting phase.
   * Side-effects: captures topology, persists it, triggers the webview
   *   reload/recreate, then on the fresh context restores topology and
   *   reattaches PTYs; advances the resilience FSM throughout.
   * Preconditions: decision.proceed===true; called at most once per incident
   *   (the orchestrator must self-guard against re-entrancy).
   * Postconditions: on success, every alive PTY is reattached and visible;
   *   lostSessions enumerates PTYs that did not survive; phase is 'recovered'
   *   or 'failed'.
   * Failure-modes:
   *   - Error — thrown only if capture cannot complete before reload (nothing
   *     to restore); post-reload per-session failures surface in lostSessions.
   *   - Cancelled — if abort() is called mid-run, resolves with success:false
   *     and phase:'failed' rather than throwing.
   * Collaborators: ITopologySnapshot.capture, ITopologySnapshot.restore,
   *   IPtyReattachClient.reattach, IResilienceStore.transition
   */
  recover(decision: RecoveryDecision): Promise<RecoveryOutcome>;

  /**
   * Responsibility: Abort an in-flight recovery and settle to a safe state.
   * Pipeline-position: (external trigger) -> THIS -> IResilienceStore.transition
   * Inputs:
   *   - reason: string — why the abort was requested (for diagnostics)
   * Outputs: void.
   * Side-effects: signals the in-flight recover() to stop; transitions the
   *   FSM toward 'failed'; leaves already-restored panes intact.
   * Preconditions: None. (safe to call when nothing is running)
   * Postconditions: no further recovery side-effects occur for this incident;
   *   idempotent — repeated abort() calls are no-ops.
   * Failure-modes: None.
   * Collaborators: IResilienceStore.transition
   */
  abort(reason: string): void;
}
