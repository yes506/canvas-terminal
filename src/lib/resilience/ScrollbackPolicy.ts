import type { Terminal } from "@xterm/xterm";
import type { IScrollbackPolicy } from "./IScrollbackPolicy";
import type { TerminalKind } from "./types";
import { resilienceConfig } from "./config";

/**
 * Concrete IScrollbackPolicy — per-kind scrollback line cap. 'main' terminals
 * (few, large) get a larger budget than 'mini' collaborator panes (numerous,
 * bounded tighter), so the invariant mini <= main holds by construction from
 * resilienceConfig.scrollbackLines.
 */
export class ScrollbackPolicy implements IScrollbackPolicy {
  private readonly caps: { main: number; mini: number };

  constructor(caps = resilienceConfig.scrollbackLines) {
    this.caps = caps;
  }

  limitFor(kind: TerminalKind): number {
    return kind === "main" ? this.caps.main : this.caps.mini;
  }

  enforce(terminal: Terminal, kind: TerminalKind): void {
    // A disposed terminal throws on option access; guard and skip rather than
    // surface (failure-mode: none surfaced to caller).
    try {
      terminal.options.scrollback = this.limitFor(kind);
    } catch {
      /* disposed terminal — nothing to enforce */
    }
  }
}

/** Shared default policy instance. */
export const scrollbackPolicy = new ScrollbackPolicy();
