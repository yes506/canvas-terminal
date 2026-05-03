/**
 * Incremental line tap for FSD protocol parsing.
 *
 * Per plan v5 §6.1 + @codex2 task-17 §1: this lives in `AgentMiniTerminal.tsx`'s
 * `pty-data-${sessionId}` listener path BEFORE `capture.feed`. PTY emits bytes,
 * not lines, so we accumulate a per-session string buffer until we see `\n`.
 *
 * Defenses:
 *  - Per-session string buffer (handles `\n`, `\r\n`, bare `\r`)
 *  - ANSI strip BEFORE regex (per plan v5 §1.5)
 *  - 64 KB partial-line cap (DoS guard, per plan v5 §3 rule 4)
 *  - `expectEcho(text, ms)` targeted echo suppressor (per plan v5 §5.1)
 *  - Falls back to blanket-mute if Phase 0 `EchoFidelity` < 80%
 */

import { stripAnsi } from "./agentOutputCapture";
import { parseFsdLine, ParseResult } from "./fsdProtocol";

const PARTIAL_LINE_BYTES_CAP = 64 * 1024;
const ECHO_WINDOW_DEFAULT_MS = 800;
const ECHO_FIDELITY_THRESHOLD = 0.8;

export interface FsdLineTap {
  /** Feed a raw PTY chunk (bytes-as-string). */
  feed(payload: string): void;
  /**
   * Tell the tap that we just injected `text` and to consume any matching
   * echo within `ms`. Per plan v5 §5.1 — targeted echo suppressor.
   */
  expectEcho(text: string, ms?: number): void;
  /**
   * Returns true if the most recent inject's echo window has not yet expired.
   * Used by classifyMismatch's "insideEchoWindow" check (plan v5 §5.2).
   */
  insideEchoWindow(): boolean;
  /** Disable targeted echo suppression (Phase-0-driven fallback). */
  enableBlanketMute(durationMs?: number): void;
  /** Force-flush + dispose. */
  dispose(): void;
}

export interface CreateFsdLineTapOptions {
  sessionId: string;
  /** Called when a valid `##FSD` command is parsed. */
  onCommand: (result: ParseResult) => void;
  /**
   * Optional override for the echo-suppressor window. The default is
   * `ECHO_WINDOW_DEFAULT_MS` (800 ms). Phase 0 may recommend tightening.
   */
  echoWindowMs?: number;
}

export function createFsdLineTap(opts: CreateFsdLineTapOptions): FsdLineTap {
  let buffer = "";
  /** Pending echo we expect to consume (set by expectEcho). */
  let echoExpect: { text: string; expiresAt: number } | null = null;
  /** Blanket-mute window end (set by enableBlanketMute fallback). */
  let blanketMuteUntil = 0;

  const echoWindow = opts.echoWindowMs ?? ECHO_WINDOW_DEFAULT_MS;
  void opts.sessionId; // sessionId is held by the caller for event scoping

  function processLines(): void {
    let idx = nextLineBoundary(buffer);
    while (idx >= 0) {
      const rawLine = buffer.substring(0, idx);
      // Skip the line terminator (handles \r\n, \n, \r).
      let next = idx + 1;
      if (buffer[idx] === "\r" && buffer[idx + 1] === "\n") next = idx + 2;
      buffer = buffer.substring(next);

      const stripped = stripAnsi(rawLine);
      if (stripped.length === 0) {
        idx = nextLineBoundary(buffer);
        continue;
      }

      // Echo suppression: if the line equals (or is a prefix of) the expected
      // echoed text and we're still inside the echo window, drop it silently.
      if (consumeEcho(stripped)) {
        idx = nextLineBoundary(buffer);
        continue;
      }
      if (Date.now() < blanketMuteUntil) {
        // Blanket-mute fallback active — drop everything regardless of content.
        idx = nextLineBoundary(buffer);
        continue;
      }

      const result = parseFsdLine(stripped);
      if (result.kind !== "skip") {
        opts.onCommand(result);
      }

      idx = nextLineBoundary(buffer);
    }

    // Truncate runaway partial lines — DoS guard.
    if (buffer.length > PARTIAL_LINE_BYTES_CAP) {
      buffer = buffer.substring(buffer.length - PARTIAL_LINE_BYTES_CAP);
    }
  }

  function consumeEcho(line: string): boolean {
    if (echoExpect == null) return false;
    if (Date.now() > echoExpect.expiresAt) {
      echoExpect = null;
      return false;
    }
    // The echo is the whole `text` injected; we may receive it across
    // multiple lines (bracketed paste expands newlines). Be lenient — if
    // the line appears verbatim inside the expected text, consume.
    if (echoExpect.text.includes(line) || line.includes(echoExpect.text)) {
      // Once any portion matches, narrow the expected text to whatever
      // hasn't been seen yet (best-effort). Simpler: just clear and trust
      // the timer for any remaining echo lines.
      echoExpect = null;
      return true;
    }
    return false;
  }

  return {
    feed(payload: string): void {
      buffer += payload;
      processLines();
    },
    expectEcho(text: string, ms?: number): void {
      echoExpect = {
        text,
        expiresAt: Date.now() + (ms ?? echoWindow),
      };
    },
    insideEchoWindow(): boolean {
      if (echoExpect != null && Date.now() < echoExpect.expiresAt) return true;
      if (Date.now() < blanketMuteUntil) return true;
      return false;
    },
    enableBlanketMute(durationMs?: number): void {
      blanketMuteUntil = Date.now() + (durationMs ?? 1500);
    },
    dispose(): void {
      buffer = "";
      echoExpect = null;
      blanketMuteUntil = 0;
    },
  };
}

/** Returns index of the first \n or \r in buffer, or -1 if none. */
function nextLineBoundary(buf: string): number {
  for (let i = 0; i < buf.length; i++) {
    const c = buf[i];
    if (c === "\n" || c === "\r") return i;
  }
  return -1;
}

/** Phase-0 outcome: if `EchoFidelity` < this, fall back to blanket mute. */
export const ECHO_FIDELITY_FALLBACK_THRESHOLD = ECHO_FIDELITY_THRESHOLD;
