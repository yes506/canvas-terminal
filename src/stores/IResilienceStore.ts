import type {
  RootCauseSign,
  RecoveryPhase,
  ResilienceState,
  ResourceWatermark,
  IncidentId,
} from "../lib/resilience/types";

/**
 * IResilienceStore — recovery FSM + incident-correlated observation store.
 *
 * Cohesion source: the single source of truth for the resilience FSM
 * (healthy → suspect → recovering → recovered/failed) and the per-incident
 * observations (sign, boundaryCaught, watermark). Implemented as a Zustand
 * store (matching stores/ convention) so RootErrorBoundary, the detector, the
 * orchestrator, and any status UI subscribe to the same state.
 *
 * Round-2 review fixes:
 *  - boundaryCaught wiring (claude3 C2): recordBoundaryCaught + currentIncidentId
 *    give the detector a path to read the boundary's evidence and correlate the
 *    two async paths (visibility vs error-boundary) into ONE incident.
 *  - watermark writer (codex2 L/M / claude3 C3): recordWatermark fills the
 *    ResilienceState.lastWatermark the diagnostic trail (and the gate) relies on.
 */
export interface IResilienceStore {
  /**
   * Responsibility: Open a new incident and return its generation token.
   * Pipeline-position: (suspect trigger) -> THIS -> IResilienceStore.recordBoundaryCaught / recordSign
   * Inputs: None.
   * Outputs: IncidentId — a fresh monotonic token for the current incident.
   * Side-effects: sets lastIncidentId; resets boundaryCaught to false; notifies
   *   subscribers. Idempotent within one incident is NOT implied — each call
   *   starts a new incident window.
   * Preconditions: called once when the FSM leaves 'healthy' for 'suspect'.
   * Postconditions: snapshotState().lastIncidentId === the returned id and
   *   boundaryCaught === false until a boundary catch is recorded.
   * Failure-modes: None.
   * Collaborators: None.
   */
  beginIncident(): IncidentId;

  /**
   * Responsibility: Record that RootErrorBoundary caught a throw in an incident.
   * Pipeline-position: IResilienceBoundary.onTopLevelError -> THIS -> IDeathDetector.classifySign
   * Inputs:
   *   - incidentId: IncidentId — the incident the catch belongs to
   * Outputs: void.
   * Side-effects: sets boundaryCaught=true iff incidentId === current incident;
   *   a stale incidentId is ignored (a catch from a prior incident must not
   *   taint the current classification); notifies subscribers.
   * Preconditions: incidentId was obtained from beginIncident().
   * Postconditions: for the matching incident, snapshotState().boundaryCaught
   *   === true (read back by the detector).
   * Failure-modes: None. (stale id is a silent no-op, by design)
   * Collaborators: None.
   */
  recordBoundaryCaught(incidentId: IncidentId): void;

  /**
   * Responsibility: Record the classified sign for a specific incident.
   * Pipeline-position: IDeathDetector.classifySign -> THIS -> IResilienceStore.transition
   * Inputs:
   *   - sign: RootCauseSign — the inferred root-cause sign
   *   - incidentId: IncidentId — the incident this sign belongs to (carried
   *     through from SignClassification.incidentId)
   * Outputs: void.
   * Side-effects: writes lastSign iff incidentId === current incident; notifies
   *   subscribers. A stale incidentId is a silent no-op.
   * Round-4 fix (claude2 SHOULD-FIX #1 — @claude1 task-6): previously `recordSign`
   *   took no incidentId and wrote `lastSign` for the implicit "current" incident,
   *   while `classifySign` already carries `incidentId` and `recordBoundaryCaught`
   *   guards on it. If a new incident is minted between classify and record, the
   *   sign would land on the wrong incident with no guard — asymmetric with the
   *   store's own correlation model. This restores symmetry.
   * Preconditions: incidentId was obtained from beginIncident() (via SignClassification).
   * Postconditions: for the matching incident, snapshotState().lastSign === sign;
   *   for a stale incident, state is unchanged.
   * Failure-modes: None. (stale id is a silent no-op, by design)
   * Collaborators: None.
   */
  recordSign(sign: RootCauseSign, incidentId: IncidentId): void;

  /**
   * Responsibility: Record the latest resource-pressure watermark.
   * Pipeline-position: IWatermarkSampler.log -> THIS -> (diagnostic trail / gate)
   * Inputs:
   *   - mark: ResourceWatermark — a fully-populated sample
   * Outputs: void.
   * Side-effects: writes lastWatermark; notifies subscribers.
   * Preconditions: mark produced by IWatermarkSampler.sample().
   * Postconditions: snapshotState().lastWatermark === mark.
   * Failure-modes: None.
   * Collaborators: None.
   */
  recordWatermark(mark: ResourceWatermark): void;

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
   * Postconditions: snapshotState().phase === the applied phase; subscribers re-render.
   * Failure-modes: None surfaced (an illegal transition lands in 'failed').
   * Collaborators: None.
   */
  transition(to: RecoveryPhase): void;

  /**
   * Responsibility: Report the active incident token, or null when healthy.
   * Pipeline-position: IResilienceBoundary.onTopLevelError -> THIS -> recordBoundaryCaught
   * Inputs: None.
   * Outputs: IncidentId | null — the current incident, or null in 'healthy'.
   * Side-effects: None.
   * Preconditions: None.
   * Postconditions: equals the id from the latest beginIncident() until the
   *   FSM returns to 'healthy', then null.
   * Failure-modes: None.
   * Collaborators: None.
   */
  currentIncidentId(): IncidentId | null;

  /**
   * Responsibility: Return an immutable snapshot of resilience state.
   * Pipeline-position: (any consumer) -> THIS -> IResilienceBoundary.renderFallback
   * Inputs: None.
   * Outputs: ResilienceState — phase + lastSign + lastWatermark + attempts +
   *   boundaryCaught + lastIncidentId.
   * Side-effects: None.
   * Preconditions: None.
   * Postconditions: returned object reflects state at call time; mutating it
   *   does not affect the store.
   * Failure-modes: None.
   * Collaborators: None.
   */
  snapshotState(): ResilienceState;
}
