import { invoke } from "@tauri-apps/api/core";
import type { IWebContentWatchdog } from "./IWebContentWatchdog";
import type { DeathEvidence } from "./types";

/**
 * Concrete IWebContentWatchdog — front-end client for the Rust-owned death
 * observer. The Rust side (per-webview durable last-beat + launch counter +
 * read_death_evidence IPC) is documented in architecture.html and lands in a
 * separate Rust planner run; these bodies are the calling contract.
 *
 * reportBeat swallows all IPC failures (telemetry must never destabilize the
 * app it observes). readDeathEvidence surfaces only a transport failure as a
 * throw — "no prior evidence" comes back as observedTermination=false / nulls.
 */
export class WebContentWatchdog implements IWebContentWatchdog {
  reportBeat(at: number): void {
    // Fire-and-forget; the caller (Heartbeat.recordTick) throttles so this
    // does not flood IPC. A dropped beat just widens the next measured gap.
    void invoke("report_heartbeat", { at }).catch(() => {
      /* swallowed — see failure-mode contract */
    });
  }

  readDeathEvidence(): Promise<DeathEvidence> {
    // Read-only; the bootstrap calls this once before the first new beat
    // overwrites the durable last-beat. A transport failure propagates.
    return invoke<DeathEvidence>("read_death_evidence");
  }
}

/** Shared singleton — one durable sink per webview. */
export const webContentWatchdog = new WebContentWatchdog();
