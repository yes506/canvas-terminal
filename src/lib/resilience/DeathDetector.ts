import type { IDeathDetector } from "./IDeathDetector";
import type { IHeartbeat } from "./IHeartbeat";
import type {
  LivenessVerdict,
  SignClassification,
  DeathEvidence,
  ResourceWatermark,
  IncidentId,
} from "./types";
import { heartbeat } from "./Heartbeat";
import { resilienceConfig } from "./config";

/**
 * Concrete IDeathDetector — fuses durable death evidence, the error-boundary
 * flag, and the watermark trail into a RootCauseSign. No single source covers
 * all hypotheses, so the classifier is layered: boundary catch ⇒ js-fatal;
 * else durable suspect ⇒ webcontent-death; else blank+context-loss ⇒ gpu-loss
 * (advisory, LOW confidence); else unknown.
 */
export class DeathDetector implements IDeathDetector {
  private readonly heartbeat: IHeartbeat;
  private readonly thresholdMs: number;

  constructor(
    hb: IHeartbeat = heartbeat,
    thresholdMs: number = resilienceConfig.deathSuspicionThresholdMs,
  ) {
    this.heartbeat = hb;
    this.thresholdMs = thresholdMs;
  }

  onVisibilityRegained(evidence: DeathEvidence): LivenessVerdict {
    const now = Date.now();
    // Prefer the durable gap (survives a dead context). Fall back to the live
    // in-memory heartbeat only when no durable gap is available (live-context
    // visibility-regain case).
    let gapMs: number;
    if (evidence.gapMs != null) {
      gapMs = evidence.gapMs;
    } else {
      const last = this.heartbeat.lastBeatAt();
      gapMs = last > 0 ? now - last : 0;
    }
    const suspectDeath =
      evidence.observedTermination ||
      evidence.reloadedSinceLastBeat ||
      gapMs > this.thresholdMs;
    return { gapMs, suspectDeath, sampledAt: now };
  }

  classifySign(
    verdict: LivenessVerdict,
    boundaryCaught: boolean,
    watermark: ResourceWatermark,
    blankObserved: boolean,
    incidentId: IncidentId,
  ): SignClassification {
    if (boundaryCaught) {
      return {
        sign: "js-fatal",
        confidence: 0.95,
        rationale: "RootErrorBoundary caught a top-level throw in this incident",
        incidentId,
      };
    }
    if (verdict.suspectDeath) {
      return {
        sign: "webcontent-death",
        confidence: 0.9,
        rationale: `durable death evidence (gap ${verdict.gapMs}ms)`,
        incidentId,
      };
    }
    // gpu-loss requires BOTH a blank-content probe AND recent context losses;
    // WebGL loss alone is not root-content loss. Always emitted at LOW
    // confidence — advisory/diagnostic only (shouldRecover never auto-recovers it).
    if (blankObserved && watermark.webglContextLosses > 0) {
      return {
        sign: "gpu-loss",
        confidence: 0.2,
        rationale: `blank content with ${watermark.webglContextLosses} WebGL context-loss event(s)`,
        incidentId,
      };
    }
    return {
      sign: "unknown",
      confidence: 0.1,
      rationale: "no discriminator fired conclusively",
      incidentId,
    };
  }
}

/** Shared singleton. */
export const deathDetector = new DeathDetector();
