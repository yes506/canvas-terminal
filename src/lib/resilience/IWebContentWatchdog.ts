import type { DeathEvidence } from "./types";

/**
 * IWebContentWatchdog — front-end client for the Rust-owned death observer.
 *
 * Cohesion source: owns the ONLY path that can positively confirm hypothesis
 * A (WebContent jettison). A heartbeat that lives only in the renderer cannot
 * detect "the renderer died" — the JS context and its in-memory last-beat
 * vanish together (codex2 H1 / claude2 G1 / claude3 #1 / codex3 #5). So death
 * detection is promoted from the prior "optional hook" to a first-class
 * contract: the front end forwards beats to Rust (durable), and Rust either
 * (a) fires its native didTerminateWebProcess delegate to trigger a reload,
 * or (b) records the last beat so the post-reload bootstrap can read the gap.
 *
 * Rust-side contract (documented in architecture.html, skeleton not emitted
 * this run): a per-webview last-beat + launch counter; a webview-death
 * delegate hook that triggers reload/recreate; `read_death_evidence()` IPC.
 */
export interface IWebContentWatchdog {
  /**
   * Responsibility: Forward a liveness beat to the durable Rust sink.
   * Pipeline-position: IHeartbeat.recordTick -> THIS -> (Rust durable last-beat)
   * Inputs:
   *   - at: number — epoch ms of the beat being reported
   * Outputs: void.
   * Side-effects: invokes a fire-and-forget Rust IPC that overwrites the
   *   per-webview last-beat timestamp; no JS state mutation.
   * Preconditions: called from a live JS context (i.e. from recordTick).
   * Postconditions: Rust's durable last-beat is >= `at` (best-effort; a
   *   dropped IPC just leaves the prior beat, which only widens the measured gap).
   * Side-effects note: throttled by the caller — beats are coalesced so this
   *   does not flood IPC.
   * Failure-modes: None surfaced — IPC failures are swallowed so telemetry
   *   never destabilizes the app it observes.
   * Collaborators: None. (Rust durable sink; terminal)
   */
  reportBeat(at: number): void;

  /**
   * Responsibility: Read durable death evidence after a (re)launch.
   * Pipeline-position: app bootstrap -> THIS -> IDeathDetector.classifySign
   * Inputs: None.
   * Outputs: Promise<DeathEvidence> — observedTermination + lastGoodBeatAt +
   *   gapMs + launchCount; the authoritative input for the 'webcontent-death'
   *   branch of classification.
   * Side-effects: invokes the read_death_evidence Rust IPC (read-only).
   * Preconditions: called once early on the fresh JS context, before the
   *   first new heartbeat overwrites the durable last-beat.
   * Postconditions: gapMs, when non-null, reflects (bootstrap now − durable
   *   last-beat); launchCount reflects the current webview generation.
   * Failure-modes:
   *   - Error — thrown only if the IPC transport itself fails; "no prior
   *     evidence" is reported as observedTermination=false / nulls, not a throw.
   * Collaborators: None. (Rust IPC; feeds the detector)
   */
  readDeathEvidence(): Promise<DeathEvidence>;
}
