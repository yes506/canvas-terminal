/**
 * Captures PTY output from AI agent sessions, strips ANSI escape codes,
 * and flushes readable text to the collaborator conversation log.
 */

// Strip ANSI escape sequences (CSI, OSC, etc.) from raw terminal data
const ANSI_RE =
  // eslint-disable-next-line no-control-regex
  /(?:\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][A-Z0-9]|\x1b[=><78NOMDEHcn]|\x1b\[[0-9;]*[ -/]*[A-Za-z]|\r)/g;

export function stripAnsi(raw: string): string {
  return raw.replace(ANSI_RE, "");
}

/**
 * Creates a buffered output capture for a single agent session.
 *
 * - `feed(data)` accepts raw PTY data (with ANSI codes).
 * - After `quietMs` of silence the buffer is flushed via `onFlush`.
 * - `flush()` forces an immediate flush (call on agent exit).
 * - `dispose()` cleans up timers.
 */
export function createOutputCapture(opts: {
  agentLabel: string;
  quietMs?: number;
  maxChars?: number;
  onFlush: (agentLabel: string, text: string) => void;
}) {
  const { agentLabel, quietMs = 2000, maxChars = 8000, onFlush } = opts;

  let buffer = "";
  let timer: ReturnType<typeof setTimeout> | null = null;

  function doFlush() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    const text = buffer.trim();
    buffer = "";
    if (text.length > 0) {
      // Truncate very long outputs to keep the log manageable
      const truncated =
        text.length > maxChars
          ? text.slice(0, maxChars) + "\n...[truncated]"
          : text;
      onFlush(agentLabel, truncated);
    }
  }

  function feed(raw: string) {
    const clean = stripAnsi(raw);
    if (!clean) return;

    buffer += clean;

    // Auto-flush if buffer is getting large
    if (buffer.length >= maxChars) {
      doFlush();
      return;
    }

    // Reset debounce timer
    if (timer) clearTimeout(timer);
    timer = setTimeout(doFlush, quietMs);
  }

  function flush() {
    doFlush();
  }

  function dispose() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    buffer = "";
  }

  return { feed, flush, dispose };
}
