/**
 * Captures PTY output from AI agent sessions, strips ANSI escape codes,
 * and flushes readable text to the collaborator conversation log.
 */

// Strip ANSI escape sequences (CSI, OSC, etc.) from raw terminal data.
// Covers: ESC-prefixed CSI, single-byte CSI (\x9b), OSC, bracket paste,
// DEC private modes, device attribute responses, and \r carriage returns.
const ANSI_RE =
  // eslint-disable-next-line no-control-regex
  /(?:\x1b\[[0-9;?]*[ -/]*[A-Za-z~]|\x9b[0-9;?]*[ -/]*[A-Za-z~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][A-Z0-9]|\x1b[=><78NOMDEHcn]|\x1b\[[\d;]*~|\r)/g;

export function stripAnsi(raw: string): string {
  return raw.replace(ANSI_RE, "");
}

// ---------------------------------------------------------------------------
// CLI chrome / noise filtering — removes visual garbage that remains after
// ANSI code stripping.  CLI tools use cursor repositioning to animate
// spinners and progress bars; once escape codes are stripped, each animation
// frame concatenates into garbage like "✶✳✢·✻✽Puzzling…3✶✳Puzzling…4".
// ---------------------------------------------------------------------------

/**
 * Patterns to strip from post-ANSI text, applied per-line.
 * Order matters: broader patterns last so narrow ones catch first.
 */
const CLI_NOISE_PATTERNS: RegExp[] = [
  // Claude Code spinner characters (cycling: ✽✻✶✳✢·)
  /[✽✻✶✳✢·◐◑◒◓⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]+/g,
  // Claude Code thinking/cooking verbs: "Puzzling…", "Garnishing…42", "Julienning…", etc.
  /(?:Puzzling|Garnishing|Julienning|Chiffonading|Brunois(?:ing)?|Tournéing|Blanching|Braising|Searing|Deglazing|Flambéing|Folding|Tempering|Caramelizing|Reducing|Clarifying|Emulsifying|Infusing|Rendering|Resting|Proofing)…(?:\d+)?/g,
  // Claude Code banner and status bar fragments
  /▐▛███▜▌[^\n]*/g,
  /▝▜█████▛▘[^\n]*/g,
  /[▘▝]+~[^\n]*/g,
  // Status bar text without ANSI context
  /\?forshortcuts[^\n]*/g,
  /esc\s*to\s*interrupt[^\n]*/g,
  /\d+\s*MCP\s*server[^\n]*/g,
  /Claude\s*in\s*Chrome\s*enabled[^\n]*/g,
  // Box-drawing lines (horizontal rules from CLI UI)
  /^[─━═╌╍┄┅┈┉]{10,}$/gm,
  // Codex progress dots (strip first so Working patterns match cleanly)
  /[◦•]+/g,
  // Codex doubled "Working" animation: WWoorrkkiinngg (each char doubled)
  /W{2}o{1,2}r{1,2}k{1,2}i{1,2}n{1,2}g{1,2}/g,
  // Codex interleaved Working with noise chars: WWo7orrkkiinWng etc.
  // Min 10 chars to avoid matching real "Working" (7 chars)
  /W{1,2}[Wworkign\d]{10,}/g,
  // Codex timing/progress: "Working(2m 32s • esc to interrupt)"
  /Working\(\d+m?\s*\d*s?[^\n)]*\)?/g,
  // Codex "Booting MCP server" noise
  /Booting\s+MCP\s+server[^\n]*/g,
  // Claude Code tool-use chrome: "(ctrl+o to expand)" or "(ctrl+otoexpand)"
  /\(ctrl\+[a-z]\s*(?:to\s*|to\s+)\w+\)/g,
  /Running…/g,
  // Bare numbers left behind from stripped spinner counters
  /(?:^|\n)\s*\d{1,4}\s*(?:\n|$)/g,
  // Prompt symbols left at line start after stripping
  /^[❯›»]\s*$/gm,
];

/** Remove CLI tool visual noise from text that has already been ANSI-stripped. */
function filterCliNoise(text: string): string {
  let result = text;
  for (const pattern of CLI_NOISE_PATTERNS) {
    result = result.replace(pattern, "");
  }
  // Collapse runs of whitespace left by filtering
  result = result.replace(/[ \t]+/g, " ");
  result = result.replace(/\n{3,}/g, "\n\n");
  // Remove lines that are only whitespace
  result = result.replace(/^\s+$/gm, "");
  return result.trim();
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

/**
 * Detect and remove echoed prompt-injection content from captured text.
 * When we inject context headers into a PTY, the terminal echoes them back.
 * This filter removes that echoed content so only the agent's actual response
 * is logged to the conversation file.
 */
const INJECTED_HEADER_PATTERNS = [
  // Full-header shapes (prependContextHeader)
  /\[Collaborator shared memory:.*?\]/g,
  /\[Conversation log:.*?\]/g,
  /\[Task definitions:.*?\]/g,
  /\[Shared context:.*?\]/g,
  /\[To share notes with other agents.*?\]/g,
  /\[Your identity:.*?\]/g,
  /## Agent Task Protocol[\s\S]*?(?=\n## Active Tasks|\n## Your active tasks|\n## Other agents|\n## [^\n]*$)/g,
  /## Active Tasks[\s\S]*?(?=\n[^\s-]|\n*$)/g,
  // Slim-header shapes (buildSlimHeader). Mute capture should suppress
  // most of these, but a partial echo can still leak a single bracketed
  // line; without these patterns the cleanup fallback misses them and
  // they pollute the conversation log. (codex1 task-8.)
  /\[Tasks file:.*?\]/g,
  /\[You are @[^\]]+\]/g,
  /\[Protocol reminder:[\s\S]*?\]/g,
  /\[Read-discipline:[\s\S]*?\]/g,
  /## Your active tasks[\s\S]*?(?=\n## Other agents|\n[^\s-]|\n*$)/g,
  /## Other agents' active tasks[\s\S]*?(?=\n[^\s-]|\n*$)/g,
  // Pasted-text marker (CLI-side noise)
  /\[Pasted\s*text\s*#\d+\+\d+\s*lines\]/gi,
];

export function _filterInjectedContentForTests(text: string): string {
  return filterInjectedContent(text);
}

function filterInjectedContent(text: string): string {
  let result = text;
  for (const pattern of INJECTED_HEADER_PATTERNS) {
    result = result.replace(pattern, "");
  }
  // Collapse runs of blank lines left by filtering
  result = result.replace(/\n{3,}/g, "\n\n");
  return result.trim();
}

// ---------------------------------------------------------------------------
// Global capture registry — allows the store to mute captures by sessionId
// when injecting prompts, preventing echoed text from being logged.
// ---------------------------------------------------------------------------

type CaptureInstance = ReturnType<typeof createOutputCapture>;
const captureRegistry = new Map<string, CaptureInstance>();

/** Register a capture instance for a session. Called by AgentMiniTerminal. */
export function registerCapture(sessionId: string, capture: CaptureInstance): void {
  captureRegistry.set(sessionId, capture);
}

/** Unregister a capture instance. Called on cleanup. */
export function unregisterCapture(sessionId: string): void {
  captureRegistry.delete(sessionId);
}

/**
 * Mute the capture for a specific session. Called by the collaborator store
 * right before injecting a prompt into the PTY, so the echoed prompt text
 * is suppressed from the conversation log.
 */
export function muteCapture(sessionId: string, ms: number): void {
  captureRegistry.get(sessionId)?.mute(ms);
}

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
  /** When > 0, all incoming data is silently dropped until Date.now() > muteUntil. */
  let muteUntil = 0;

  function doFlush() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    const raw = buffer.trim();
    buffer = "";
    hasContent = false;
    if (raw.length === 0) return;

    // Filter out echoed prompt-injection content and CLI visual noise
    const filtered = filterInjectedContent(raw);
    if (filtered.length === 0) return;
    const text = filterCliNoise(filtered);
    if (text.length === 0) return;

    // Truncate very long outputs to keep the log manageable
    const truncated =
      text.length > maxChars
        ? text.slice(0, maxChars) + "\n...[truncated]"
        : text;
    onFlush(agentLabel, truncated);
  }

  function feed(raw: string) {
    // Drop data while muted (echo suppression after prompt injection)
    if (muteUntil > 0) {
      if (Date.now() < muteUntil) return;
      muteUntil = 0;
    }

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

  /**
   * Suppress capture for `ms` milliseconds. Used to skip the echoed
   * prompt text after injecting a message into the PTY.
   */
  function mute(ms: number) {
    reset();
    muteUntil = Date.now() + ms;
  }

  function dispose() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    buffer = "";
  }

  return { feed, flush, reset, mute, dispose };
}
