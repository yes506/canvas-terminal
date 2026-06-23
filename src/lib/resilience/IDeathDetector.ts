import type {
  LivenessVerdict,
  SignClassification,
  DeathEvidence,
  ResourceWatermark,
  IncidentId,
} from "./types";

/**
 * IDeathDetector — sign inference engine.
 *
 * Cohesion source: turns observations into a RootCauseSign + confidence for a
 * single incident. It fuses THREE evidence sources, because no one source
 * covers all hypotheses:
 *   - IWebContentWatchdog.DeathEvidence (Rust-durable) → confirms A
 *     (webcontent-death); the only source that survives a dead JS context.
 *   - RootErrorBoundary boundaryCaught (read from IResilienceStore by
 *     incidentId) → confirms B (js-fatal).
 *   - ResourceWatermark.webglContextLosses → weak signal for C (gpu-loss):
 *     blank screen while heartbeat still ticks and the boundary stays silent.
 * Round-2 review fixes: A is no longer inferred from the in-memory heartbeat
 * (G1/H1/#1/#5); boundaryCaught is correlated through an explicit incidentId
 * (claude3 C2); C is a named sign rather than a silent "healthy" (claude2 G2).
 */
export interface IDeathDetector {
  /**
   * Responsibility: Analyze the liveness gap and durable death evidence on
   *   visibility regain / fresh-context bootstrap.
   * Pipeline-position: IWebContentWatchdog.readDeathEvidence -> THIS -> IDeathDetector.classifySign
   * Inputs:
   *   - evidence: DeathEvidence — durable Rust evidence (observedTermination,
   *     lastGoodBeatAt, gapMs, reloadedSinceLastBeat); the authoritative A input.
   *     The reload decision reads the Rust-computed `reloadedSinceLastBeat`, NOT a
   *     frontend re-derivation of `launchCount` (no in-memory baseline survives —
   *     round-4 codex1 MED).
   * Outputs: LivenessVerdict — gapMs + suspectDeath + sampledAt, derived from
   *   the durable gap (not the in-memory heartbeat, which a dead context lost).
   * Side-effects: reads IHeartbeat.lastBeatAt for the live-context case; reads
   *   current time. No writes.
   * Preconditions: invoked from a visibilitychange/pageshow handler OR the
   *   post-reload bootstrap; evidence is freshly read for this incident.
   * Postconditions: suspectDeath === (evidence.observedTermination ||
   *   evidence.reloadedSinceLastBeat || durable gapMs > threshold); verdict
   *   reflects the instant of this call.
   * Failure-modes: None. (missing evidence yields suspectDeath=false, not a throw)
   * Collaborators: IHeartbeat.lastBeatAt, IWebContentWatchdog.readDeathEvidence
   */
  onVisibilityRegained(evidence: DeathEvidence): LivenessVerdict;

  /**
   * Responsibility: Fuse liveness + boundary + watermark evidence into a sign.
   * Pipeline-position: IDeathDetector.onVisibilityRegained -> THIS -> IResilienceStore.recordSign
   * Inputs:
   *   - verdict: LivenessVerdict — from onVisibilityRegained()
   *   - boundaryCaught: boolean — read from IResilienceStore for `incidentId`
   *     (true ⇒ RootErrorBoundary caught a throw in THIS incident)
   *   - watermark: ResourceWatermark — latest sample (webglContextLosses gates C)
   *   - blankObserved: boolean — implementer-supplied compositor/visual probe
   *     result: true ⇒ content area is actually blank. REQUIRED for 'gpu-loss'
   *     because WebGL context loss alone (no blank) is NOT root-content loss
   *     (codex3 #2). Pass false when no probe exists — then C stays unreachable
   *     rather than over-classified.
   *   - incidentId: IncidentId — the incident these inputs all belong to
   * Outputs: SignClassification — sign + confidence(0..1) + rationale + incidentId.
   *   'gpu-loss' is always emitted at LOW confidence (advisory/diagnostic only;
   *   shouldRecover never auto-recovers it).
   * Side-effects: None.
   * Preconditions: verdict, boundaryCaught, watermark and blankObserved are all
   *   correlated to `incidentId` (same incident window).
   * Postconditions: boundaryCaught ⇒ 'js-fatal'; else suspectDeath ⇒
   *   'webcontent-death'; else (blankObserved && recent webglContextLosses) ⇒
   *   'gpu-loss' (low confidence); else 'unknown'. Result carries the same incidentId.
   * Failure-modes: None. (total; ambiguity surfaces as 'unknown' low-confidence)
   * Collaborators: None. (pure function of its inputs)
   */
  classifySign(
    verdict: LivenessVerdict,
    boundaryCaught: boolean,
    watermark: ResourceWatermark,
    blankObserved: boolean,
    incidentId: IncidentId,
  ): SignClassification;
}
