import type { Terminal } from "@xterm/xterm";
import type { ReplayBudget, PtyReattachResult } from "./types";

/**
 * IPtyReattachClient — front-end client for the Rust PTY-reattach contract.
 *
 * Cohesion source: owns the IPC round-trip that rebinds a freshly-mounted
 * xterm to a Rust PTY that SURVIVED the webview reload (PTYs live in the
 * Rust process, which jettison/reload does not kill). Mirrors the existing
 * pty.rs command-client pattern (spawn_shell / get_pty_cwd) but reattaches
 * instead of spawning.
 *
 * Rust-side contract (documented in architecture.html, skeleton not emitted
 * this run): `reattach_pty(session_id, replay_budget) -> PtyReattachResult`.
 */
export interface IPtyReattachClient {
  /**
   * Responsibility: Rebind one session to its surviving Rust PTY.
   * Pipeline-position: ITopologySnapshot.capture -> THIS -> IPtyReattachClient.replayInto
   * Inputs:
   *   - sessionId: string — a session id from the captured snapshot
   *   - replayBudget: ReplayBudget — caps how much scrollback Rust replays
   * Outputs: Promise<PtyReattachResult> — alive flag + replayBytes; alive
   *   false means the PTY is gone and the caller must surface a dead pane.
   * Side-effects: invokes the reattach_pty IPC; re-subscribes the pty-data /
   *   pty-exit event listeners for sessionId.
   * Preconditions: the Rust process is the same one that owned the PTY (PID
   *   unchanged — reload, not restart); listeners for sessionId are not
   *   already attached.
   * Postconditions: on alive=true, subsequent pty-data events for sessionId
   *   flow to the front end; replayBytes <= replayBudget.maxBytes.
   * Failure-modes:
   *   - Error — thrown when the IPC itself fails (transport error); a dead
   *     PTY is reported via alive=false, NOT thrown.
   * Collaborators: reattach_pty (Rust IPC)
   */
  reattach(
    sessionId: string,
    replayBudget: ReplayBudget,
  ): Promise<PtyReattachResult>;

  /**
   * Responsibility: Write a PTY's replay buffer into its xterm instance.
   * Pipeline-position: IPtyReattachClient.reattach -> THIS -> ITopologySnapshot.restore
   * Inputs:
   *   - sessionId: string — the reattached session
   *   - terminal: Terminal — the freshly-mounted xterm for that session
   * Outputs: void.
   * Side-effects: writes replayed bytes into the terminal buffer; scrolls to
   *   bottom so the user sees the restored tail.
   * Preconditions: reattach(sessionId, ...) returned alive=true; terminal is
   *   open() and sized.
   * Postconditions: the terminal viewport shows the replayed scrollback tail.
   * Failure-modes: None surfaced (a write to a disposed terminal is guarded
   *   and dropped, matching terminalManager's disposed-guard pattern).
   * Collaborators: None. (terminal sink; xterm write)
   */
  replayInto(sessionId: string, terminal: Terminal): void;
}
