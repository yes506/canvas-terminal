/**
 * terminalManager.ts
 *
 * Owns the full lifecycle of xterm Terminal instances, independent of React.
 * Terminal DOM elements live in a hidden "host" container and are reparented
 * into visible pane slots on mount, then parked back on unmount.
 * This prevents the black-flash / PTY-kill that occurs when React unmounts
 * and remounts TerminalPane during pane-tree restructuring (e.g. opening
 * the Collaborator split).
 */
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { SearchAddon } from "@xterm/addon-search";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebglAddon } from "@xterm/addon-webgl";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { terminalThemes } from "../components/terminal/themes";
import {
  useTerminalStore,
  registerTerminal,
  unregisterTerminal,
} from "../stores/terminalStore";
import {
  attachKoreanImeShim,
  type KoreanImeShimHandle,
} from "./xtermImeShim";

// Shortcuts that should NOT be consumed by xterm (let them bubble to app)
const INTERCEPTED_KEYS = new Set([
  "t", "w", "f", "d", "e", "z", "s", "o", "=", "-", "0",
  "1", "2", "3", "4", "5", "6", "7", "8", "9",
  "Enter",
]);

export interface ManagedTerminal {
  terminal: Terminal;
  fitAddon: FitAddon;
  searchAddon: SearchAddon;
  containerEl: HTMLDivElement;
  unlistenData: UnlistenFn | null;
  unlistenExit: UnlistenFn | null;
  observer: ResizeObserver | null;
  // Sole IME lifecycle owner. Replaces the prior 5 fields
  // (imeHandlers/rebindIme/docKeyDown/docInput/imeOverlayEl) — see
  // src/lib/xtermImeShim.ts. The handle's dispose() is invoked by
  // cleanupManaged; do NOT add parallel manual cleanup.
  imeHandle: KoreanImeShimHandle | null;
  disposed: boolean;
}

const sessions = new Map<string, ManagedTerminal>();

// ---------------------------------------------------------------------------
// Env bootstrap — resolve login-shell environment once, reuse for all PTYs
// ---------------------------------------------------------------------------

let envBootstrapped = false;

/** Returns true if cached env is available, false if fallback to login shell is needed. */
export async function ensureEnvBootstrapped(): Promise<boolean> {
  if (envBootstrapped) return true;
  try {
    await invoke("bootstrap_env", { force: false });
    envBootstrapped = true;
    return true;
  } catch (err) {
    console.warn("Failed to bootstrap env, will use login shell:", err);
    return false;
  }
}

export function isEnvBootstrapped(): boolean {
  return envBootstrapped;
}

// Fire-and-forget eager bootstrap so the first terminal tab is fast
invoke("bootstrap_env", { force: false }).then(() => {
  envBootstrapped = true;
}).catch(() => {});

// ---------------------------------------------------------------------------
// Hidden host element — offscreen parking lot for terminal DOM elements
// ---------------------------------------------------------------------------

let hostEl: HTMLDivElement | null = null;

function getHostEl(): HTMLDivElement {
  if (!hostEl) {
    hostEl = document.createElement("div");
    hostEl.id = "terminal-host";
    Object.assign(hostEl.style, {
      position: "fixed",
      left: "-9999px",
      top: "-9999px",
      width: "1px",
      height: "1px",
      overflow: "hidden",
      pointerEvents: "none",
    });
    document.body.appendChild(hostEl);
  }
  return hostEl;
}

// ---------------------------------------------------------------------------
// Global font-size / theme subscriptions (one for all managed terminals)
// ---------------------------------------------------------------------------

let globalSubInitialized = false;

function ensureGlobalSubscriptions() {
  if (globalSubInitialized) return;
  globalSubInitialized = true;

  useTerminalStore.subscribe((state, prev) => {
    if (state.fontSize !== prev.fontSize) {
      for (const s of sessions.values()) {
        if (!s.disposed) {
          s.terminal.options.fontSize = state.fontSize;
          const overlayEl = s.imeHandle?.overlayEl;
          if (overlayEl) {
            overlayEl.style.fontSize = `${state.fontSize}px`;
          }
          // Only fit if in a visible slot — avoid resizing to 1x1 when parked
          if (s.containerEl.offsetWidth > 0 && s.containerEl.offsetHeight > 0) {
            const buf = s.terminal.buffer.active;
            const wasAtBottom = buf.viewportY >= buf.baseY;
            s.fitAddon.fit();
            if (wasAtBottom) s.terminal.scrollToBottom();
          }
        }
      }
    }
    if (state.themeName !== prev.themeName) {
      const theme = terminalThemes[state.themeName] ?? terminalThemes.catppuccin;
      for (const s of sessions.values()) {
        if (!s.disposed) {
          s.terminal.options.theme = theme;
        }
      }
    }
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function getSession(sessionId: string): ManagedTerminal | undefined {
  return sessions.get(sessionId);
}

export function hasSession(sessionId: string): boolean {
  return sessions.has(sessionId);
}

/**
 * Create a new xterm Terminal + PTY for the given sessionId.
 * If `parentEl` is provided the terminal opens there (correct initial
 * dimensions); otherwise it parks in the offscreen host.
 * No-op if the session already exists.
 */
export async function createSession(
  sessionId: string,
  opts?: { cwd?: string | null; parentEl?: HTMLElement },
): Promise<ManagedTerminal | null> {
  if (sessions.has(sessionId)) return sessions.get(sessionId)!;

  ensureGlobalSubscriptions();

  const { fontSize, themeName } = useTerminalStore.getState();
  const theme = terminalThemes[themeName] ?? terminalThemes.catppuccin;

  // Create a persistent container div for this terminal.
  // If a visible parentEl is supplied, open there so xterm measures correct
  // cols/rows for spawn_shell. Otherwise fall back to the offscreen host.
  const containerEl = document.createElement("div");
  containerEl.style.width = "100%";
  containerEl.style.height = "100%";
  (opts?.parentEl ?? getHostEl()).appendChild(containerEl);

  const terminal = new Terminal({
    theme,
    fontFamily: "'JetBrainsMono Nerd Font Mono', 'Noto Sans Mono CJK KR', 'D2Coding', 'JetBrains Mono', Menlo, monospace",
    fontSize,
    lineHeight: 1.2,
    cursorBlink: true,
    cursorStyle: "bar",
    scrollback: 10000,
    allowProposedApi: true,
  });

  const fitAddon = new FitAddon();
  const searchAddon = new SearchAddon();
  const unicode11Addon = new Unicode11Addon();
  terminal.loadAddon(fitAddon);
  terminal.loadAddon(new WebLinksAddon());
  terminal.loadAddon(searchAddon);
  terminal.loadAddon(unicode11Addon);
  terminal.unicode.activeVersion = "11";

  // Let app-level shortcuts bubble past xterm
  terminal.attachCustomKeyEventHandler((e) => {
    // Return true so xterm does NOT call preventDefault() on IME key
    // events.  preventDefault() blocks the browser from initiating IME
    // composition entirely.  The triggerDataEvent patch below handles
    // suppressing any output xterm's _handleKey produces for IME keys.
    if (e.isComposing || e.keyCode === 229) return true;

    // Shift+Enter → CSI u escape sequence
    if (e.key === "Enter" && e.shiftKey && !e.metaKey && !e.ctrlKey) {
      e.preventDefault();
      if (e.type === "keydown") {
        invoke("write_to_pty", { sessionId, data: "\x1b[13;2u" }).catch(() => {});
      }
      return false;
    }
    if ((e.metaKey || e.ctrlKey) && INTERCEPTED_KEYS.has(e.key)) {
      return false;
    }
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === "[" || e.key === "]")) {
      return false;
    }
    if ((e.metaKey || e.ctrlKey) && e.altKey && e.key.startsWith("Arrow")) {
      return false;
    }
    return true;
  });

  terminal.open(containerEl);

  // WebGL addon for GPU-accelerated rendering.
  //
  // The constructor's boolean is `preserveDrawingBuffer`. It used to be `true`
  // because the prior "Capture Full Window" implementation rasterized via
  // html2canvas, which clones the DOM and copies canvases through
  // drawImage() — that pixel-readback path needs the WebGL drawing buffer
  // preserved between frames. Once the capture path moved to a native OS
  // compositor read (commands::capture::capture_main_window_png), the
  // readback requirement went away and we can keep the (small) browser
  // optimization of letting the GL driver discard the buffer.
  //
  // Any future feature that wants to read xterm WebGL pixels back from JS
  // (OCR, search highlight rasterization, etc.) must re-enable this flag
  // — leave the buffer-discard default in place until that need actually
  // shows up.
  try {
    const webglAddon = new WebglAddon(false);
    webglAddon.onContextLoss(() => { try { webglAddon.dispose(); } catch { /* already disposed */ } });
    terminal.loadAddon(webglAddon);
  } catch {
    // Fall back to canvas renderer
  }

  // Initial fit so terminal.cols/rows are correct before spawn_shell.
  // Only fit if the container is visible (i.e. opened in a visible parentEl).
  if (containerEl.offsetWidth > 0 && containerEl.offsetHeight > 0) {
    fitAddon.fit();
  }

  const managed: ManagedTerminal = {
    terminal,
    fitAddon,
    searchAddon,
    containerEl,
    unlistenData: null,
    unlistenExit: null,
    observer: null,
    imeHandle: null,
    disposed: false,
  };

  sessions.set(sessionId, managed);
  registerTerminal(sessionId, terminal, searchAddon);

  // ResizeObserver — observes containerEl (moves with it across reparents)
  const observer = new ResizeObserver(() => {
    if (!managed.disposed && containerEl.offsetWidth > 0 && containerEl.offsetHeight > 0) {
      const buf = terminal.buffer.active;
      const wasAtBottom = buf.viewportY >= buf.baseY;
      fitAddon.fit();
      if (wasAtBottom) terminal.scrollToBottom();
    }
  });
  observer.observe(containerEl);
  managed.observer = observer;

  // Listen for PTY output
  managed.unlistenData = await listen<string>(
    `pty-data-${sessionId}`,
    (event) => {
      if (!managed.disposed) {
        terminal.write(event.payload);
      }
    },
  );

  if (managed.disposed) {
    cleanupManaged(managed, sessionId);
    return null;
  }

  managed.unlistenExit = await listen(
    `pty-exit-${sessionId}`,
    () => {
      if (!managed.disposed) {
        terminal.write("\r\n\x1b[33m[Process exited]\x1b[0m\r\n");
      }
    },
  );

  if (managed.disposed) {
    cleanupManaged(managed, sessionId);
    return null;
  }

  // Ensure env is cached before spawning — fall back to login shell if bootstrap failed
  const hasCachedEnv = await ensureEnvBootstrapped();

  // Spawn shell: use cached env (login: false) when available, login shell as fallback
  try {
    await invoke("spawn_shell", {
      sessionId,
      cols: terminal.cols,
      rows: terminal.rows,
      cwd: opts?.cwd ?? null,
      login: !hasCachedEnv,
    });
  } catch (error) {
    terminal.write(
      `\r\n\x1b[31m[Failed to start shell: ${error}]\x1b[0m\r\n`,
    );
    return managed;
  }

  if (managed.disposed) return managed;

  // Track line buffer for "collaborator" command detection
  let lineBuffer = "";

  // Korean IME shim — single helper, single dispose() path. See
  // src/lib/xtermImeShim.ts for the bug context (compositionend duplicate-
  // prefix render) and the full dispose restoration contract.
  //
  // Korean compositions DO NOT flow through `terminal.onData`; they take
  // the shim's direct `invoke("write_to_pty")` path. The `onComposedFlush`
  // subscription below keeps `lineBuffer` in sync so a Korean → IME-off →
  // ASCII "collaborator\r" sequence still triggers the in-app spawn
  // intercept below (plan node 8b sub-case i).
  managed.imeHandle = attachKoreanImeShim(terminal, containerEl, {
    sessionId,
    webgl: true,
    defaultFontSize: 12,
    onComposedFlush: (_committedText, terminator) => {
      // Korean syllables MUST NOT accumulate into lineBuffer — otherwise a
      // "한글 → IME off → collaborator\r" sequence would leave "한글collaborator"
      // in lineBuffer and miss the spawn check at terminal.onData below.
      // Terminator '\r' from a mid-composition Enter still resets lineBuffer
      // (mirrors the terminal.onData '\r' branch below).
      if (terminator === "\r") {
        lineBuffer = "";
      }
    },
  });

  // Forward user input to PTY
  terminal.onData((data) => {
    if (managed.disposed) return;
    // isComposing guard handled at triggerDataEvent level;
    // onData only fires when triggerDataEvent was NOT suppressed.

    // Detect "collaborator" command
    if (data === "\r") {
      if (lineBuffer.trim() === "collaborator") {
        lineBuffer = "";
        invoke("write_to_pty", { sessionId, data: "\x15" }).catch(() => {});
        useTerminalStore.getState().openCollaboratorSplit();
        return;
      }
      lineBuffer = "";
    } else if (data === "\x7f") {
      lineBuffer = lineBuffer.slice(0, -1);
    } else if (data.length === 1 && data >= " ") {
      lineBuffer += data;
    } else if (data === "\x03") {
      lineBuffer = "";
    }

    invoke("write_to_pty", { sessionId, data }).catch(() => {});
  });

  // Handle resize with debounce
  let resizeTimer: ReturnType<typeof setTimeout> | null = null;
  terminal.onResize(({ cols, rows }) => {
    if (managed.disposed) return;
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (!managed.disposed) {
        invoke("resize_pty", { sessionId, cols, rows }).catch(() => {});
      }
    }, 80);
  });

  return managed;
}

/**
 * Move the terminal's DOM element from the hidden host into a visible slot.
 * Re-fits the terminal to the new container dimensions.
 */
export function reparentTo(sessionId: string, parentEl: HTMLElement): void {
  const s = sessions.get(sessionId);
  if (!s || s.disposed) return;

  parentEl.appendChild(s.containerEl);
  s.imeHandle?.rebind();

  // Fit after layout settles
  requestAnimationFrame(() => {
    s.imeHandle?.rebind();
    if (!s.disposed && s.containerEl.offsetWidth > 0 && s.containerEl.offsetHeight > 0) {
      const buf = s.terminal.buffer.active;
      const wasAtBottom = buf.viewportY >= buf.baseY;
      s.fitAddon.fit();
      if (wasAtBottom) s.terminal.scrollToBottom();
    }
  });
}

/**
 * Park the terminal's DOM element back in the hidden host.
 * The terminal and PTY remain alive.
 */
export function parkInHost(sessionId: string): void {
  const s = sessions.get(sessionId);
  if (!s || s.disposed) return;

  getHostEl().appendChild(s.containerEl);
}

/**
 * Destroy a terminal session — kill PTY, dispose xterm, clean up listeners.
 * Called only on explicit tab/pane close.
 */
export function destroySession(sessionId: string): void {
  const s = sessions.get(sessionId);
  if (!s) return;

  s.disposed = true;
  cleanupManaged(s, sessionId);
  sessions.delete(sessionId);
}

function cleanupManaged(s: ManagedTerminal, sessionId: string): void {
  s.unlistenData?.();
  s.unlistenExit?.();
  s.observer?.disconnect();

  // Korean IME shim — sole-owner cleanup. Replaces the prior 3 manual
  // cleanup blocks (docInput/docKeyDown listeners + imeHandlers focus
  // unpatch). The handle's dispose() also restores triggerDataEvent
  // and the isCursorHidden property descriptor — leaks the prior
  // inline shim left open.
  s.imeHandle?.dispose();
  s.imeHandle = null;

  unregisterTerminal(sessionId);

  // Kill PTY
  invoke("kill_pty", { sessionId }).catch(() => {});

  // Dispose xterm (deferred to avoid crashes during React commit phase).
  // Don't remove containerEl here — React's unmount of the slot div will
  // handle DOM removal. Removing it prematurely causes a visible flash
  // because the slot becomes empty before React re-renders.
  const term = s.terminal;
  const el = s.containerEl;
  setTimeout(() => {
    try {
      term.dispose();
    } catch {
      /* xterm internal */
    }
    // Clean up containerEl in case it wasn't removed by React (e.g. mid-flight
    // destroy during createSession, where no React component owns the element)
    el.remove();
  }, 0);
}
