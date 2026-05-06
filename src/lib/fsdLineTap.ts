/**
 * Incremental line tap for FSD protocol parsing.
 *
 * Per plan v5 §6.1 + @codex2 task-17 §1: this lives in `AgentMiniTerminal.tsx`'s
 * `pty-data-${sessionId}` listener path BEFORE `capture.feed`. PTY emits bytes,
 * not lines, so we accumulate a per-session string buffer until we see `\n`.
 *
 * Defenses:
 *  - Per-session string buffer (handles `\n` and `\r\n`)
 *  - PTY carriage-return redraw collapse before parsing
 *  - Hard-wrap reassembly for incomplete `##FSD` JSON
 *  - ANSI strip BEFORE regex (per plan v5 §1.5)
 *  - 64 KB partial-line cap (DoS guard, per plan v5 §3 rule 4)
 *  - `expectEcho(text, ms)` targeted echo suppressor (per plan v5 §5.1)
 *  - Falls back to blanket-mute if Phase 0 `EchoFidelity` < 80%
 */

import { stripAnsi } from "./agentOutputCapture";
import { parseFsdLine, ParseResult } from "./fsdProtocol";

const PARTIAL_LINE_BYTES_CAP = 64 * 1024;
const PENDING_FSD_BYTES_CAP = 64 * 1024;
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
  /** Incomplete `##FSD` JSON split by hard-wrapped PTY output. */
  let pendingFsdLine: string | null = null;

  const echoWindow = opts.echoWindowMs ?? ECHO_WINDOW_DEFAULT_MS;
  void opts.sessionId; // sessionId is held by the caller for event scoping

  function processLines(): void {
    let idx = nextLineBoundary(buffer);
    while (idx >= 0) {
      const rawLine = buffer.substring(0, idx);
      // Skip the line terminator. Lines are finalized only on LF; a CR just
      // before LF is part of CRLF and will be trimmed by normalizePtyLine.
      const next = idx + 1;
      buffer = buffer.substring(next);

      const stripped = extractFsdCandidate(rawLine);
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

      processProtocolLine(stripped);

      idx = nextLineBoundary(buffer);
    }

    processUnterminatedFsdCandidate();

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

  function processProtocolLine(line: string): void {
    if (pendingFsdLine != null) {
      pendingFsdLine += line.trimStart();
      if (pendingFsdLine.length > PENDING_FSD_BYTES_CAP) {
        opts.onCommand({ kind: "malformed", code: "json-parse", reason: "FSD command exceeded partial-line cap" });
        pendingFsdLine = null;
        return;
      }

      const pendingResult = parseFsdLine(pendingFsdLine);
      if (pendingResult.kind === "ok") {
        pendingFsdLine = null;
        opts.onCommand(pendingResult);
        return;
      }
      if (pendingResult.kind === "malformed" && isIncompleteJson(pendingResult.reason)) {
        return;
      }

      pendingFsdLine = null;
      if (pendingResult.kind !== "skip") {
        opts.onCommand(pendingResult);
      }
      return;
    }

    const result = parseFsdLine(line);
    if (result.kind === "malformed" && isIncompleteJson(result.reason)) {
      pendingFsdLine = line;
      return;
    }
    if (result.kind !== "skip") {
      opts.onCommand(result);
    }
  }

  function processUnterminatedFsdCandidate(): void {
    if (pendingFsdLine != null || buffer.length === 0) return;

    const stripped = extractFsdCandidate(buffer);
    if (stripped.length === 0) return;
    if (consumeEcho(stripped)) {
      buffer = "";
      return;
    }
    if (Date.now() < blanketMuteUntil) {
      buffer = "";
      return;
    }

    const result = parseFsdLine(stripped);
    if (result.kind === "ok") {
      buffer = "";
      opts.onCommand(result);
    }
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
      pendingFsdLine = null;
      echoExpect = null;
      blanketMuteUntil = 0;
    },
  };
}

/**
 * Returns index of the next completed line.
 *
 * PTY output from full-screen CLIs often uses bare carriage returns to redraw
 * the same visual row while streaming. Treating those CRs as line boundaries
 * turns a partially redrawn `##FSD` JSON command into a malformed command.
 */
function nextLineBoundary(buf: string): number {
  return buf.indexOf("\n");
}

/**
 * Collapse carriage-return redraw frames to the final visible row.
 *
 * Example: `##FSD {"t\r##FSD {"type":"plan"}\r\n` should parse the final
 * redrawn row, not report the first partial frame as malformed.
 */
function normalizePtyLine(rawLine: string): string {
  const withoutCrlf = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
  const lastCarriageReturn = withoutCrlf.lastIndexOf("\r");
  if (lastCarriageReturn < 0) return withoutCrlf;
  return withoutCrlf.slice(lastCarriageReturn + 1);
}

/**
 * Extract the FSD candidate from a raw PTY line, with redraw-rescue.
 *
 * Default: take the post-last-CR segment (visually-final row). But if that
 * segment isn't a valid `##FSD` ok command and an earlier CR-frame IS,
 * prefer the latest valid FSD frame. This rescues a complete `##FSD`
 * command that gets visually overwritten by a status-bar redraw emitted
 * in the same chunk — e.g. `##FSD {valid}\r<status>` would otherwise
 * drop the FSD content because `lastIndexOf("\r")` returns `<status>`.
 *
 * Walks newest-to-oldest to honor redraw semantics: latest valid FSD wins.
 */
function extractFsdCandidate(rawLine: string): string {
  const lastSegment = stripAnsi(normalizePtyLine(rawLine));
  if (!rawLine.includes("##FSD")) return lastSegment;
  if (parseFsdLine(lastSegment).kind === "ok") return lastSegment;

  const trimmed = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
  const segments = trimmed.split("\r");
  for (let i = segments.length - 1; i >= 0; i--) {
    const candidate = stripAnsi(segments[i]);
    if (parseFsdLine(candidate).kind === "ok") return candidate;
  }
  return lastSegment;
}

function isIncompleteJson(reason: string): boolean {
  return reason.includes("Unterminated string") || reason.includes("Unexpected end of JSON input");
}

/** Phase-0 outcome: if `EchoFidelity` < this, fall back to blanket mute. */
export const ECHO_FIDELITY_FALLBACK_THRESHOLD = ECHO_FIDELITY_THRESHOLD;
