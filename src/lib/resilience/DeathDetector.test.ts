import { describe, it, expect } from "vitest";
import { DeathDetector } from "./DeathDetector";
import type { IHeartbeat } from "./IHeartbeat";
import type { LivenessVerdict, ResourceWatermark, DeathEvidence } from "./types";

function watermark(losses: number): ResourceWatermark {
  return {
    jsHeapUsedBytes: null,
    webglContexts: 0,
    webglContextLosses: losses,
    terminalTabs: 0,
    collaboratorPanes: 0,
    sampledAt: 0,
  };
}
function verdict(suspectDeath: boolean): LivenessVerdict {
  return { gapMs: suspectDeath ? 99999 : 0, suspectDeath, sampledAt: 0 };
}
function evidence(p: Partial<DeathEvidence>): DeathEvidence {
  return {
    observedTermination: false,
    lastGoodBeatAt: null,
    gapMs: null,
    launchCount: 0,
    reloadedSinceLastBeat: false,
    ...p,
  };
}
const fakeHb = (last: number): IHeartbeat => ({
  start() {},
  recordTick() {},
  lastBeatAt: () => last,
  stop() {},
});

describe("DeathDetector.classifySign", () => {
  const d = new DeathDetector(fakeHb(0), 1000);

  it("boundaryCaught outranks everything -> js-fatal", () => {
    const c = d.classifySign(verdict(true), true, watermark(5), true, "i1");
    expect(c.sign).toBe("js-fatal");
    expect(c.incidentId).toBe("i1");
  });

  it("suspectDeath (no boundary) -> webcontent-death", () => {
    expect(d.classifySign(verdict(true), false, watermark(0), false, "i").sign).toBe(
      "webcontent-death",
    );
  });

  it("gpu-loss requires BOTH blankObserved and a context loss; low confidence", () => {
    const c = d.classifySign(verdict(false), false, watermark(3), true, "i");
    expect(c.sign).toBe("gpu-loss");
    expect(c.confidence).toBeLessThan(0.5);
  });

  it("context loss WITHOUT a blank probe is not gpu-loss -> unknown", () => {
    expect(d.classifySign(verdict(false), false, watermark(3), false, "i").sign).toBe(
      "unknown",
    );
  });

  it("no discriminator -> unknown", () => {
    expect(d.classifySign(verdict(false), false, watermark(0), false, "i").sign).toBe(
      "unknown",
    );
  });
});

describe("DeathDetector.onVisibilityRegained", () => {
  it("prefers the durable evidence.gapMs over the in-memory heartbeat", () => {
    // heartbeat says 'just beat' (no gap), but durable evidence shows a big gap.
    const d = new DeathDetector(fakeHb(Date.now()), 1000);
    const v = d.onVisibilityRegained(evidence({ gapMs: 5000 }));
    expect(v.gapMs).toBe(5000);
    expect(v.suspectDeath).toBe(true);
  });

  it("observedTermination forces suspectDeath regardless of gap", () => {
    const d = new DeathDetector(fakeHb(Date.now()), 1000);
    const v = d.onVisibilityRegained(evidence({ observedTermination: true, gapMs: 0 }));
    expect(v.suspectDeath).toBe(true);
  });

  it("falls back to the heartbeat gap when evidence.gapMs is null", () => {
    const d = new DeathDetector(fakeHb(Date.now() - 5000), 1000);
    const v = d.onVisibilityRegained(evidence({ gapMs: null }));
    expect(v.suspectDeath).toBe(true);
  });

  it("no evidence and a fresh heartbeat -> not suspected", () => {
    const d = new DeathDetector(fakeHb(Date.now()), 1000);
    const v = d.onVisibilityRegained(evidence({ gapMs: null }));
    expect(v.suspectDeath).toBe(false);
  });
});
