import type { ReplayBudget, PtyReattachResult } from "./types";

/**
 * IPtyReattachClient — front-end client for the Rust PTY-reattach contract.
 *
 * Cohesion source: owns the IPC round-trip that rebinds a freshly-mounted
 * xterm to a Rust PTY that SURVIVED the webview reload (PTYs live in the Rust
 * process, which an in-place reload does not kill — PID is stable).
 *
 * Round-2 review fixes:
 *  - Replay delivery (codex2 MED / claude3 #3 / codex3 #3): the current Rust
 *    reader thread emits output immediately and retains NO tail
 *    (pty.rs start_reader_thread; state.rs PtySession has no buffer). So replay
 *    REQUIRES a new Rust-side bounded per-session ring buffer. That cross-
 *    boundary contract is specified in architecture.html (ownership, retention
 *    cap, UTF-8 boundary handling, lock strategy, listener idempotency).
 *    Replay is delivered through the EXISTING `pty-data-{sessionId}` event the
 *    front end already listens on — NOT returned inline — which is why
 *    restoreShell (mount) must precede reattach (replay into mounted xterm).
 *  - ALWAYS-ON ring, not allocated at reattach (round-4 — claude2 SHOULD-FIX #2,
 *    sharpens codex3 #3 — @claude1 task-6): the ring MUST be populated by the
 *    existing reader thread UNCONDITIONALLY from PTY creation. During the reload
 *    gap the old context's pty-data listener is dead and the new one has not yet
 *    re-subscribed, so the reader keeps emitting into the void — and exactly
 *    those listener-gap bytes are the ones replay must recover. An on-demand ring
 *    started at reattach would miss precisely the gap window. `reattach` therefore
 *    only sets the replay cursor + flush order; it does NOT start buffering.
 *  - Sequencing (claude3 C4 / codex3 #2): a single reattach() call replaces
 *    the prior reattach()+replayInto() pair, removing the "replayInto needs a
 *    mounted terminal before restore" contradiction.
 */
export interface IPtyReattachClient {
  /**
   * Responsibility: Rebind one session to its surviving Rust PTY and trigger
   *   a bounded replay of its output ring into the already-mounted xterm.
   * Pipeline-position: ITopologySnapshot.restoreShell -> THIS -> IRecoveryOrchestrator.recover (verify)
   * Inputs:
   *   - sessionId: string — a session id from the restored snapshot (original,
   *     reused id — the terminal for it is already mounted by restoreShell)
   *   - replayBudget: ReplayBudget — caps how much ring buffer Rust re-emits
   * Outputs: Promise<PtyReattachResult> — alive flag + replayBytes re-emitted;
   *   alive=false ⇒ the PTY is gone and the caller surfaces a dead pane.
   * Side-effects: invokes the reattach_pty IPC ONLY — listener setup is NOT
   *   this method's job (impl-round correction): the adopt-mode mount
   *   (adoptDetachedSession / AgentMiniTerminal adopt) subscribes the
   *   pty-data / pty-exit listeners BEFORE the adoption-readiness barrier
   *   releases and this is called. Rust then re-emits up to
   *   replayBudget.maxBytes of its ring buffer through pty-data-{sessionId},
   *   which those already-live listeners write into the mounted terminal.
   *   Moving listener setup back into reattach() would reopen the
   *   listenerless-replay bug the barrier exists to prevent.
   * Ordering (claude3 R4, amended by the webcontent-death-recovery impl
   *   review): Rust flushes the replay tail under the same per-session emit
   *   lock as live output, so replayed scrollback and live bytes never
   *   INTERLEAVE/garble. Duplication, however, is an ACCEPTED LIMITATION:
   *   output emitted between the adopt-time listener subscribe and the
   *   replay flush arrives live AND again inside the replay tail (cosmetic;
   *   bounded by the adoption-readiness timeout; idle sessions unaffected).
   *   Eliminating it needs an adopt-time ring high-water-mark IPC — recorded
   *   follow-up (see reattach_pty's Rust docstring). A second reattach for a
   *   session does not double-subscribe anything (there is nothing to
   *   subscribe here) — it only re-emits the ring tail again.
   * Preconditions: the Rust PID is unchanged (reload, not restart); the xterm
   *   for sessionId is already mounted (restoreShell ran); the pty-data /
   *   pty-exit listeners for sessionId ARE already attached by the adopt-mode
   *   mount (that is exactly what the adoption-readiness signal certifies).
   * Postconditions: on alive=true, the replayed tail is written in order then
   *   live pty-data events flow; replayBytes <= replayBudget.maxBytes. On
   *   alive=false the caller restores a dead/exited tile preserving handle/log
   *   (per AgentSnapshot recovery policy) rather than dropping the pane.
   * Failure-modes:
   *   - Error — thrown when the IPC transport fails; a dead PTY is alive=false,
   *     NOT a throw. (Listener double-subscription cannot originate here —
   *     this method subscribes nothing; the adopt-mode mounts own that.)
   * Collaborators: reattach_pty (Rust IPC + Rust ring buffer)
   */
  reattach(
    sessionId: string,
    replayBudget: ReplayBudget,
  ): Promise<PtyReattachResult>;
}
