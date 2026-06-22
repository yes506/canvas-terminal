import type {
  RootCauseSign,
  RecoveryPhase,
  ResilienceState,
} from "../lib/resilience/types";

/**
 * IResilienceStore — recovery FSM + last-observation store.
 *
 * Cohesion source: the single source of truth for the resilience finite
 * state machine (healthy → suspect → recovering → recovered/failed) and the
 * last sign/watermark. Implemented as a Zustand store (one-per-concern,
 * matching the existing stores/ convention) so the RootErrorBoundary, the
 * orchestrator, and any status UI subscribe to the same state.
 */
export interface IResilienceStore {
  /**
   * Responsibility: Record the classified sign for the current incident.
   * Pipeline-position: IDeathDetector.classifySign -> THIS -> IResilienceStore.transition
   * Inputs:
   *   - sign: RootCauseSign — the inferred root-cause sign
   * Outputs: void.
   * Side-effects: writes lastSign into store state; notifies subscribers.
   * Preconditions: None.
   * Postconditions: snapshotState().lastSign === sign.
   * Failure-modes: None.
   * Collaborators: None. (state write; orchestrator reads via snapshotState)
   */
  recordSign(sign: RootCauseSign): void;

  /**
   * Responsibility: Move the recovery FSM to a new phase.
   * Pipeline-position: IResilienceStore.recordSign -> THIS -> IRecoveryOrchestrator.shouldRecover
   * Inputs:
   *   - to: RecoveryPhase — the target phase
   * Outputs: void.
   * Side-effects: updates phase; increments recoveryAttempts when entering
   *   'recovering'; notifies subscribers.
   * Preconditions: `to` is a legal successor of the current phase (illegal
   *   transitions are coerced to 'failed', not silently applied).
   * Postconditions: snapshotState().phase === the applied phase; subscribers
   *   re-render.
   * Failure-modes: None surfaced (an illegal transition lands in 'failed').
   * Collaborators: None.
   */
  transition(to: RecoveryPhase): void;

  /**
   * Responsibility: Return an immutable snapshot of resilience state.
   * Pipeline-position: (any consumer) -> THIS -> IResilienceBoundary.renderFallback
   * Inputs: None.
   * Outputs: ResilienceState — phase + lastSign + lastWatermark + attempts.
   * Side-effects: None.
   * Preconditions: None.
   * Postconditions: returned object reflects state at call time; mutating it
   *   does not affect the store.
   * Failure-modes: None.
   * Collaborators: None.
   */
  snapshotState(): ResilienceState;
}
