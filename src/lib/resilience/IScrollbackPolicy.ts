import type { Terminal } from "@xterm/xterm";
import type { TerminalKind } from "./types";

/**
 * IScrollbackPolicy — per-terminal scrollback cap.
 *
 * Cohesion source: owns the bound on retained scrollback lines. Unbounded
 * scrollback across many tabs + many collaborator mini-terminals is a
 * standing memory-growth source that compounds toward jettison. This policy
 * sets a per-kind cap (main terminals get more than numerous mini panes)
 * and applies it to a live xterm.
 */
export interface IScrollbackPolicy {
  /**
   * Responsibility: Resolve the scrollback line cap for a terminal kind.
   * Pipeline-position: terminalManager.createTerminal -> THIS -> IScrollbackPolicy.enforce
   * Inputs:
   *   - kind: TerminalKind — 'main' (few, large) or 'mini' (many, small)
   * Outputs: number — max retained scrollback lines for that kind (> 0).
   * Side-effects: None.
   * Preconditions: None.
   * Postconditions: 'mini' cap <= 'main' cap (numerous panes are bounded
   *   more tightly); value is deterministic for a given kind.
   * Failure-modes: None. (total over the closed TerminalKind union)
   * Collaborators: None.
   */
  limitFor(kind: TerminalKind): number;

  /**
   * Responsibility: Apply the resolved cap to a live terminal.
   * Pipeline-position: IScrollbackPolicy.limitFor -> THIS -> (xterm bounded)
   * Inputs:
   *   - terminal: Terminal — a live xterm instance
   *   - kind: TerminalKind — its class, selecting the cap
   * Outputs: void.
   * Side-effects: sets the terminal's `scrollback` option, trimming any
   *   buffer beyond the cap.
   * Preconditions: terminal is constructed (open() not required).
   * Postconditions: terminal.options.scrollback === limitFor(kind);
   *   idempotent — re-applying the same kind is a no-op.
   * Failure-modes: None surfaced (a disposed terminal is guarded and skipped).
   * Collaborators: IScrollbackPolicy.limitFor
   */
  enforce(terminal: Terminal, kind: TerminalKind): void;
}
