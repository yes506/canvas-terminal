import type { IWebglContextBudget } from "./IWebglContextBudget";
import type { WebglGrant } from "./types";
import { resilienceConfig } from "./config";

/**
 * Concrete IWebglContextBudget — global cap on simultaneous xterm WebGL
 * contexts. Tracks granted session ids in a Set so acquire/release are
 * idempotent per session (a re-acquire for an already-granted session does not
 * double-count; a release for an unknown session is tolerated).
 */
export class WebglContextBudget implements IWebglContextBudget {
  private readonly granted = new Set<string>();
  private readonly cap: number;

  constructor(cap: number = resilienceConfig.webglContextCap) {
    this.cap = cap;
  }

  acquire(sessionId: string): WebglGrant {
    // Idempotent: an already-granted session keeps its slot without
    // consuming another (postcondition: activeCount unchanged on re-acquire).
    if (this.granted.has(sessionId)) {
      return { sessionId, granted: true, reason: "already granted" };
    }
    if (this.granted.size >= this.cap) {
      return {
        sessionId,
        granted: false,
        reason: `cap reached: ${this.cap} active`,
      };
    }
    this.granted.add(sessionId);
    return { sessionId, granted: true, reason: "granted" };
  }

  release(sessionId: string): void {
    // Set.delete is itself idempotent — a second release for the same session
    // (or an unknown session) does not double-decrement.
    this.granted.delete(sessionId);
  }

  activeCount(): number {
    return this.granted.size;
  }
}

/** Process-wide singleton — the cap is global across all terminals. */
export const webglContextBudget = new WebglContextBudget();
