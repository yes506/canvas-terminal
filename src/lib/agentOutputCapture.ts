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
 * Patterns that indicate the CLI tool has finished responding and is waiting
 * for the next prompt.  When detected at the tail of the buffer we flush
 * immediately rather than waiting for the full quietMs timeout.
 */
const RESPONSE_DONE_PATTERNS = [
  /(?:^|\n)(?:\w+\s)?>\s*$/,  // CLI prompt: "> ", "gemini > ", "codex > " (rejects ">>>")
  /(?:^|\n)\$\s*$/,            // shell prompt at line start
];

export function createOutputCapture(opts: {
  agentLabel: string;
  quietMs?: number;
  maxChars?: number;
  onFlush: (agentLabel: string, text: string) => void;
}) {
  const { agentLabel, quietMs = 2000, maxChars = 8000, onFlush } = opts;

  let buffer = "";
  let timer: ReturnType<typeof setTimeout> | null = null;
  /** Whether we've received substantial content (not just a prompt echo). */
  let hasContent = false;

  function doFlush() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    const text = buffer.trim();
    buffer = "";
    hasContent = false;
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

    // Track whether we have meaningful content (more than just whitespace/prompt)
    if (clean.trim().length > 5) {
      hasContent = true;
    }

    // Auto-flush if buffer is getting large
    if (buffer.length >= maxChars) {
      doFlush();
      return;
    }

    // If we have substantial content and see a prompt pattern at the tail,
    // use a shorter timeout to flush sooner — the agent is likely done.
    const tail = buffer.slice(-100);
    const atPrompt = hasContent && RESPONSE_DONE_PATTERNS.some((re) => re.test(tail));

    // Reset debounce timer
    if (timer) clearTimeout(timer);
    timer = setTimeout(doFlush, atPrompt ? Math.min(quietMs, 800) : quietMs);
  }

  function flush() {
    doFlush();
  }

  /** Silently discard buffered data without calling onFlush. */
  function reset() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    buffer = "";
    hasContent = false;
  }

  function dispose() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    buffer = "";
  }

  return { feed, flush, reset, dispose };
}
