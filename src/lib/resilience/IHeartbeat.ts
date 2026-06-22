/**
 * IHeartbeat — front-end liveness ticker (telemetry only).
 *
 * Cohesion source: owns the in-memory "is the render loop alive" signal. It
 * distinguishes "backgrounded-but-alive" (gap, then ticks resume) from a
 * top-level JS stall, and it FORWARDS each beat to IWebContentWatchdog so a
 * durable last-beat survives a dead JS context.
 *
 * SCOPE NOTE (round-2 review): the in-memory last-beat CANNOT by itself
 * confirm hypothesis A (WebContent death) — a dead JS context takes its
 * last-beat with it. Positive 'webcontent-death' confirmation is owned by
 * IWebContentWatchdog (Rust-durable), never by lastBeatAt(). See
 * IWebContentWatchdog and IDeathDetector.
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
   * Responsibility: Record that the render loop reached this instant alive,
   *   and forward the beat to the durable watchdog sink.
   * Pipeline-position: IHeartbeat.start (scheduler) -> THIS -> IWebContentWatchdog.reportBeat
   * Inputs: None.
   * Outputs: void.
   * Side-effects: writes the in-memory last-beat timestamp; calls
   *   IWebContentWatchdog.reportBeat(now) (throttled) so a durable copy
   *   survives a dead JS context.
   * Preconditions: start() has been called.
   * Postconditions: lastBeatAt() returns the time of this call; the durable
   *   sink has been asked to advance to >= that time.
   * Failure-modes: None. (watchdog IPC failures are swallowed inside reportBeat)
   * Collaborators: IWebContentWatchdog.reportBeat
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
