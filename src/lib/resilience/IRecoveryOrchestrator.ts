import type {
  RootCauseSign,
  RecoveryDecision,
  RecoveryOutcome,
} from "./types";

/**
 * IRecoveryOrchestrator — the recovery control loop.
 *
 * Cohesion source: owns the end-to-end recovery sequence, the evidence gate
 * that keeps it from running before the failure mode is confirmed, AND the
 * teardown-suppression flag that stops an orchestrated reload from killing the
 * PTYs it is trying to preserve.
 *
 * Round-2 review fixes:
 *  - Sequence (claude3 C1/C4 / codex3 #2): recovery starts from the durable
 *    loadPersisted() snapshot (NOT a capture taken after the failure — under
 *    hypothesis A there is no live JS to capture), then restoreShell (mount),
 *    then reattach (replay into mounted xterms), then verify.
 *  - Teardown suppression (codex2 H2 / claude3 #4 / codex3 #4): AgentMiniTerminal
 *    and terminal unmount cleanup call kill_pty (AgentMiniTerminal.tsx:820). An
 *    in-place reload unmounts components, which would kill the surviving PTYs
 *    before reattach. isReloadInProgress() is the seam those cleanup paths must
 *    consult to SKIP kill_pty during orchestrated recovery.
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
   * Postconditions: proceed===false ⇒ action 'none'; while the #3 evidence
   *   gate is closed (failure mode not yet confirmed at runtime), returns
   *   proceed:false regardless of sign so no reload is triggered.
   * Failure-modes: None. (total; 'unknown'/'gpu-loss' map to proceed:false
   *   until their handling is explicitly enabled)
   * Collaborators: None. (consults policy only)
   */
  shouldRecover(sign: RootCauseSign): RecoveryDecision;

  /**
   * Responsibility: Execute the full non-destructive recovery sequence.
   * Pipeline-position: IRecoveryOrchestrator.shouldRecover -> THIS -> ITopologySnapshot.loadPersisted
   * Inputs:
   *   - decision: RecoveryDecision — must have proceed===true and a non-'none' action
   * Outputs: Promise<RecoveryOutcome> — success + restored/lost session counts
   *   + elapsedMs + resulting phase.
   * Side-effects: sets isReloadInProgress()=true (suppresses kill_pty teardown);
   *   triggers the webview reload/recreate; on the fresh context runs
   *   loadPersisted → restoreShell → (await xterm refs) → reattach → verify;
   *   advances the resilience FSM throughout; clears the suppression flag at the end.
   * Preconditions: decision.proceed===true; a durable snapshot was being
   *   persisted proactively while healthy; called at most once per incident
   *   (self-guard against re-entrancy).
   * Postconditions: on success, every alive PTY is reattached and visible and
   *   lostSessions enumerates PTYs that did not survive; phase is 'recovered'
   *   or 'failed'; the teardown-suppression flag is cleared.
   * Failure-modes:
   *   - Error — thrown only if no durable snapshot exists to restore (nothing
   *     to recover); post-reload per-session failures surface in lostSessions.
   *   - Cancelled — if abort() is called mid-run, resolves success:false /
   *     phase:'failed' rather than throwing.
   * Collaborators: ITopologySnapshot.loadPersisted, ITopologySnapshot.restoreShell,
   *   IPtyReattachClient.reattach, IResilienceStore.transition
   */
  recover(decision: RecoveryDecision): Promise<RecoveryOutcome>;

  /**
   * Responsibility: Report whether an orchestrated reload is in progress, so
   *   component teardown can suppress kill_pty.
   * Pipeline-position: (component unmount cleanup) -> THIS -> skip-or-run kill_pty
   * Inputs: None.
   * Outputs: boolean — true between the start of recover()'s reload and the
   *   completion of reattach; false otherwise.
   * Side-effects: None. (pure read of the suppression flag)
   * Preconditions: None. (safe to call from any unmount path at any time)
   * Postconditions: a true result obligates the caller (AgentMiniTerminal /
   *   terminal cleanup) to SKIP invoke("kill_pty") and removeAgent for that unmount.
   * Failure-modes: None.
   * Collaborators: None.
   */
  isReloadInProgress(): boolean;

  /**
   * Responsibility: Abort an in-flight recovery and settle to a safe state.
   * Pipeline-position: (external trigger) -> THIS -> IResilienceStore.transition
   * Inputs:
   *   - reason: string — why the abort was requested (for diagnostics)
   * Outputs: void.
   * Side-effects: signals the in-flight recover() to stop; clears the
   *   teardown-suppression flag; transitions the FSM toward 'failed'; leaves
   *   already-restored panes intact.
   * Preconditions: None. (safe to call when nothing is running)
   * Postconditions: no further recovery side-effects occur for this incident;
   *   isReloadInProgress() returns false; idempotent.
   * Failure-modes: None.
   * Collaborators: IResilienceStore.transition
   */
  abort(reason: string): void;
}
