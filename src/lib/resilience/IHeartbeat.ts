/**
 * IHeartbeat — liveness ticker.
 *
 * Cohesion source: owns the single "is the render loop alive" signal. A
 * monotonically-advancing tick whose last-beat timestamp lets the death
 * detector distinguish "we were backgrounded" (gap, then ticks resume)
 * from "the WebContent process died" (gap, ticks never resume because the
 * whole JS context is gone).
 */
export interface IHeartbeat {
  /**
   * Responsibility: Begin emitting liveness ticks on the chosen cadence.
   * Pipeline-position: app bootstrap -> THIS -> IHeartbeat.recordTick
   * Inputs: None.
   * Outputs: void — ticker is running after return.
   * Side-effects: schedules a recurring timer / rAF loop; advances time.
   * Preconditions: called once after the React root mounts; not already started.
   * Postconditions: ticks fire until stop(); idempotent — a second start()
   *   before stop() is a no-op (does not create a second timer).
   * Failure-modes: None. (total; environment timer APIs always present)
   * Collaborators: IHeartbeat.recordTick (each scheduled fire calls it)
   */
  start(): void;

  /**
   * Responsibility: Record that the render loop reached this instant alive.
   * Pipeline-position: IHeartbeat.start (scheduler) -> THIS -> IDeathDetector.onVisibilityRegained
   * Inputs: None.
   * Outputs: void.
   * Side-effects: writes the last-beat timestamp to internal state.
   * Preconditions: start() has been called.
   * Postconditions: lastBeatAt() returns the time of this call.
   * Failure-modes: None.
   * Collaborators: None. (pure state write; readers poll lastBeatAt)
   */
  recordTick(): void;

  /**
   * Responsibility: Report when the most recent tick was recorded.
   * Pipeline-position: IHeartbeat.recordTick -> THIS -> IDeathDetector.onVisibilityRegained
   * Inputs: None.
   * Outputs: number — epoch ms of the last recordTick(); 0 if never ticked.
   * Side-effects: None.
   * Preconditions: None.
   * Postconditions: return value is non-decreasing across calls within one
   *   live JS context.
   * Failure-modes: None.
   * Collaborators: None.
   */
  lastBeatAt(): number;

  /**
   * Responsibility: Stop emitting liveness ticks and release the timer.
   * Pipeline-position: IHeartbeat.start -> ... -> THIS (teardown)
   * Inputs: None.
   * Outputs: void.
   * Side-effects: clears the recurring timer / cancels the rAF loop.
   * Preconditions: None.
   * Postconditions: no further recordTick() calls occur from the scheduler;
   *   idempotent — repeated stop() calls are no-ops.
   * Failure-modes: None.
   * Collaborators: None.
   */
  stop(): void;
}
