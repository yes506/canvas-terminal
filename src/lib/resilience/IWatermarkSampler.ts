import type { ResourceWatermark } from "./types";

/**
 * IWatermarkSampler — resource-pressure observer.
 *
 * Cohesion source: owns sampling + logging of the memory/GPU/tab-count
 * watermarks that correlate with WebContent jettison. Produces the
 * evidence trail that confirms hypothesis A (memory pressure → death)
 * before any heavyweight recovery is implemented.
 */
export interface IWatermarkSampler {
  /**
   * Responsibility: Capture a point-in-time resource-pressure sample.
   * Pipeline-position: visibility/heartbeat trigger -> THIS -> IWatermarkSampler.log
   * Inputs: None.
   * Outputs: ResourceWatermark — all fields populated; jsHeapUsedBytes is
   *   null when performance.memory is unavailable (non-Chromium/WebKit).
   * Side-effects: reads performance.memory + live store counts; no writes.
   * Preconditions: stores (terminal/collaborator) are initialized.
   * Postconditions: returned sampledAt == time of this call.
   * Failure-modes: None. (missing APIs degrade to null fields, not throws)
   * Collaborators: IWebglContextBudget.activeCount (for webglContexts)
   */
  sample(): ResourceWatermark;

  /**
   * Responsibility: Persist/emit a watermark for later correlation.
   * Pipeline-position: IWatermarkSampler.sample -> THIS -> IDeathDetector.onVisibilityRegained
   * Inputs:
   *   - mark: ResourceWatermark — a fully-populated sample from sample()
   * Outputs: void.
   * Side-effects: appends to the console/diagnostic log AND calls
   *   IResilienceStore.recordWatermark(mark) so the FSM's lastWatermark (the
   *   diagnostic trail the evidence gate relies on) is populated.
   * Preconditions: mark was produced by sample() (fields internally consistent).
   * Postconditions: the mark is observable in the diagnostic log and in
   *   IResilienceStore.snapshotState().lastWatermark.
   * Failure-modes: None surfaced to caller (logging failures are swallowed
   *   so instrumentation never destabilizes the app it observes).
   * Collaborators: IResilienceStore.recordWatermark
   */
  log(mark: ResourceWatermark): void;
}
