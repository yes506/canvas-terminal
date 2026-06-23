import type { IHeartbeat } from "./IHeartbeat";
import type { IWebContentWatchdog } from "./IWebContentWatchdog";
import { webContentWatchdog } from "./WebContentWatchdog";
import { resilienceConfig } from "./config";

/**
 * Concrete IHeartbeat — in-memory liveness ticker that forwards each beat to
 * the durable Rust watchdog sink (throttled) so a last-beat survives a dead JS
 * context. The in-memory last-beat alone CANNOT confirm WebContent death (it
 * dies with the context) — positive confirmation is the watchdog's job.
 */
export class Heartbeat implements IHeartbeat {
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastBeat = 0;
  private lastForwardedAt = 0;
  private readonly watchdog: IWebContentWatchdog;
  private readonly intervalMs: number;
  private readonly forwardThrottleMs: number;

  constructor(
    watchdog: IWebContentWatchdog = webContentWatchdog,
    intervalMs: number = resilienceConfig.heartbeatIntervalMs,
    forwardThrottleMs: number = resilienceConfig.beatForwardThrottleMs,
  ) {
    this.watchdog = watchdog;
    this.intervalMs = intervalMs;
    this.forwardThrottleMs = forwardThrottleMs;
  }

  start(): void {
    // Idempotent: a second start() before stop() must not create a 2nd timer.
    if (this.timer !== null) return;
    this.timer = setInterval(() => this.recordTick(), this.intervalMs);
  }

  recordTick(): void {
    const now = Date.now();
    this.lastBeat = now;
    // Throttle the durable forward so a fast tick cadence does not flood IPC.
    if (now - this.lastForwardedAt >= this.forwardThrottleMs) {
      this.lastForwardedAt = now;
      this.watchdog.reportBeat(now);
    }
  }

  lastBeatAt(): number {
    return this.lastBeat;
  }

  stop(): void {
    // Idempotent: repeated stop() calls are no-ops.
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}

/** Shared singleton — one ticker per JS context. */
export const heartbeat = new Heartbeat();
