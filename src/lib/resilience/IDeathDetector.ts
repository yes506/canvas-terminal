import type { LivenessVerdict, SignClassification } from "./types";

/**
 * IDeathDetector — sign inference engine.
 *
 * Cohesion source: turns raw liveness/boundary observations into a
 * RootCauseSign. This is the discriminator the whole diagnosis hinges on:
 * a boundary catch implies hypothesis B (js-fatal); a heartbeat gap whose
 * ticks never resume (inferred indirectly, since a dead JS context cannot
 * self-report) plus a healthy boundary implies hypothesis A.
 */
export interface IDeathDetector {
  /**
   * Responsibility: Analyze the heartbeat gap observed on visibility regain.
   * Pipeline-position: IHeartbeat.lastBeatAt -> THIS -> IDeathDetector.classifySign
   * Inputs: None. (reads the heartbeat's last-beat time + now)
   * Outputs: LivenessVerdict — gapMs + suspectDeath flag + sampledAt.
   * Side-effects: reads current time; no writes.
   * Preconditions: invoked from a visibilitychange/pageshow handler on the
   *   document becoming visible again.
   * Postconditions: suspectDeath === (gapMs > threshold); verdict reflects
   *   the instant of this call.
   * Failure-modes: None. (a missing prior tick yields gapMs from epoch 0,
   *   which the threshold treats as not-suspect on first run)
   * Collaborators: IHeartbeat.lastBeatAt (reads last tick time)
   */
  onVisibilityRegained(): LivenessVerdict;

  /**
   * Responsibility: Combine liveness + boundary evidence into a sign.
   * Pipeline-position: IDeathDetector.onVisibilityRegained -> THIS -> IResilienceStore.recordSign
   * Inputs:
   *   - verdict: LivenessVerdict — from onVisibilityRegained()
   *   - boundaryCaught: boolean — true if RootErrorBoundary caught a throw
   *     in the same incident window
   * Outputs: SignClassification — sign + confidence(0..1) + rationale.
   * Side-effects: None.
   * Preconditions: verdict is fresh (same incident as boundaryCaught).
   * Postconditions: boundaryCaught === true ⇒ sign 'js-fatal'; otherwise a
   *   suspectDeath verdict ⇒ 'webcontent-death'; neither ⇒ 'unknown'.
   * Failure-modes: None. (total over its inputs; ambiguity surfaces as
   *   'unknown' with low confidence rather than a throw)
   * Collaborators: None. (pure function of its inputs)
   */
  classifySign(
    verdict: LivenessVerdict,
    boundaryCaught: boolean,
  ): SignClassification;
}
