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
  imeHandlers: {
    el: HTMLTextAreaElement;
    nativeFocus: (opts?: FocusOptions) => void;
    onFocus: () => void;
  } | null;
  rebindIme: (() => void) | null;
  docKeyDown: ((e: KeyboardEvent) => void) | null;
  docInput: ((e: Event) => void) | null;
  imeOverlayEl: HTMLSpanElement | null;
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
          if (s.imeOverlayEl) {
            s.imeOverlayEl.style.fontSize = `${state.fontSize}px`;
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

  // WebGL addon for GPU-accelerated rendering
  try {
    const webglAddon = new WebglAddon(true);
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
    imeHandlers: null,
    rebindIme: null,
    docKeyDown: null,
    docInput: null,
    imeOverlayEl: null,
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
  // ---------------------------------------------------------------------------
  // Korean IME handling for WKWebView (Tauri on macOS)
  //
  // WKWebView has two critical differences from standard browsers:
  //   1. Event order: input fires BEFORE keydown (reversed from spec)
  //   2. No composition events: uses insertText + insertReplacementText
  //      instead of compositionstart/compositionupdate/compositionend
  //
  // Strategy:
  //   - Patch triggerDataEvent to defer Korean chars by 20ms (allows
  //     keydown(229) to set isComposing before we commit)
  //   - Track textarea value during composition; show a DOM overlay
  //     at the cursor position for visual feedback
  //   - Flush the composed text to PTY when a non-229 keydown arrives
  // ---------------------------------------------------------------------------
  let isComposing = false;
  let imeStartPos = 0;       // textarea position where current composition began
  let imeFlushGen = 0;       // generation counter to prevent deferred duplicates
  let imeFragment = "";      // current composing fragment (for flush on Enter)

  // DOM-based composition overlay — font must match xterm.js renderer exactly.
  // Appended to .xterm-screen so positioning is relative to the cell grid,
  // not the padded container div.
  const overlayEl = document.createElement("span");
  overlayEl.style.cssText =
    `position:absolute;color:inherit;` +
    `font-family:${terminal.options.fontFamily ?? "monospace"};` +
    `font-size:${terminal.options.fontSize ?? 12}px;` +
    `font-weight:${terminal.options.fontWeight ?? "normal"};` +
    `-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility;` +
    `pointer-events:none;` +
    `z-index:10;white-space:pre;display:none;padding:0;margin:0;`;
  // Fake cursor bar — rendered to the right of composing text
  const fakeCursorEl = document.createElement("span");
  fakeCursorEl.style.cssText =
    `display:inline-block;width:2px;vertical-align:top;` +
    `animation:ime-cursor-blink 1s step-end infinite;`;
  overlayEl.appendChild(fakeCursorEl);
  // Inject blink keyframes if not already present
  if (!document.getElementById("ime-cursor-blink-style")) {
    const styleEl = document.createElement("style");
    styleEl.id = "ime-cursor-blink-style";
    styleEl.textContent = `@keyframes ime-cursor-blink { 0%,50% { opacity: 1; } 50.01%,100% { opacity: 0; } }`;
    document.head.appendChild(styleEl);
  }
  const screenEl = containerEl.querySelector(".xterm-screen") as HTMLElement | null;
  if (screenEl) {
    screenEl.style.position = "relative";
    screenEl.appendChild(overlayEl);
  } else {
    containerEl.style.position = "relative";
    containerEl.appendChild(overlayEl);
  }
  managed.imeOverlayEl = overlayEl;

  // Hide real cursor during composition by directly setting the internal
  // isCursorHidden flag on xterm.js's core service. This is more reliable
  // than DECTCEM (\x1b[?25l]) because:
  //   1. DECTCEM goes through the async input handler — the shell can send
  //      \x1b[?25h (show cursor) in its prompt, overriding our hide.
  //   2. cursorWidth has a minimum clamp of 1 in OptionsService.
  // Direct flag access mirrors how iTerm2 handles it: the renderer checks
  // coreService.isCursorHidden synchronously before drawing the cursor.
  let cursorHidden = false;
  const core = (terminal as any)._core;
  // Intercept shell escape sequences that try to show the cursor during
  // composition. We replace the isCursorHidden property with a getter/setter
  // that ignores writes while composition is active.
  let cursorHiddenLock = false;
  if (core?.coreService) {
    const cs = core.coreService;
    let _realHidden = cs.isCursorHidden;
    Object.defineProperty(cs, "isCursorHidden", {
      get() { return cursorHiddenLock ? true : _realHidden; },
      set(v: boolean) {
        if (!cursorHiddenLock) _realHidden = v;
      },
      configurable: true,
    });
  }

  const hideCursor = () => {
    if (!cursorHidden) {
      cursorHiddenLock = true;
      terminal.options.cursorBlink = false;
      cursorHidden = true;
    }
  };

  const restoreCursor = () => {
    if (cursorHidden) {
      cursorHiddenLock = false;
      terminal.options.cursorBlink = true;
      cursorHidden = false;
    }
  };

  // Check if a character is full-width (CJK, etc.) — occupies 2 terminal cells.
  const isFullWidth = (ch: string) => {
    const cp = ch.codePointAt(0) ?? 0;
    return (cp >= 0x1100 && cp <= 0x115F) ||  // Hangul Jamo
           (cp >= 0x2E80 && cp <= 0x303E) ||  // CJK Radicals, Kangxi, CJK Symbols
           (cp >= 0x3040 && cp <= 0x33BF) ||  // Hiragana, Katakana, CJK Compat
           (cp >= 0x3400 && cp <= 0x4DBF) ||  // CJK Unified Ext A
           (cp >= 0x4E00 && cp <= 0xA4CF) ||  // CJK Unified, Yi
           (cp >= 0xA960 && cp <= 0xA97C) ||  // Hangul Jamo Extended-A
           (cp >= 0xAC00 && cp <= 0xD7AF) ||  // Hangul Syllables
           (cp >= 0xD7B0 && cp <= 0xD7FF) ||  // Hangul Jamo Extended-B
           (cp >= 0xF900 && cp <= 0xFAFF) ||  // CJK Compat Ideographs
           (cp >= 0xFE30 && cp <= 0xFE6F) ||  // CJK Compat Forms
           (cp >= 0xFF01 && cp <= 0xFF60) ||  // Fullwidth Forms
           (cp >= 0xFFE0 && cp <= 0xFFE6) ||  // Fullwidth Signs
           (cp >= 0x20000 && cp <= 0x2FA1F);  // CJK Ext B-F, Compat Supplement
  };

  const showOverlay = (text: string) => {
    imeFragment = text;
    // Remove old character spans and text nodes, keep fakeCursorEl
    while (overlayEl.firstChild && overlayEl.firstChild !== fakeCursorEl) {
      overlayEl.removeChild(overlayEl.firstChild);
    }
    if (!fakeCursorEl.parentNode) overlayEl.appendChild(fakeCursorEl);
    const dims = (terminal as any)._core?._renderService?.dimensions;
    if (dims) {
      const cx = terminal.buffer.active.cursorX;
      const cy = terminal.buffer.active.cursorY;
      const cellW = dims.css.cell.width;
      const cellH = dims.css.cell.height;
      const cursorColor = terminal.options.theme?.cursor ?? "#ffffff";
      overlayEl.style.fontSize = `${terminal.options.fontSize ?? 12}px`;
      overlayEl.style.lineHeight = `${cellH}px`;
      overlayEl.style.height = `${cellH}px`;
      overlayEl.style.left = `${cx * cellW}px`;
      overlayEl.style.top = `${cy * cellH}px`;
      // Render each character in a fixed-width span matching the cell grid.
      // CJK characters occupy 2 cells; ASCII occupies 1 cell.
      // Each span has an opaque background matching the terminal theme to
      // visually cover the WebGL-rendered cursor underneath.
      const bg = terminal.options.theme?.background ?? "#1a1a1a";
      const fg = terminal.options.theme?.foreground ?? "#e0e0e0";
      overlayEl.style.color = fg;
      for (const ch of text) {
        const charSpan = document.createElement("span");
        charSpan.textContent = ch;
        const w = isFullWidth(ch) ? cellW * 2 : cellW;
        charSpan.style.cssText = `display:inline-block;width:${w}px;height:${cellH}px;text-align:center;background:${bg};`;
        overlayEl.insertBefore(charSpan, fakeCursorEl);
      }
      fakeCursorEl.style.height = `${cellH}px`;
      fakeCursorEl.style.backgroundColor = cursorColor;
    }
    overlayEl.style.display = text ? "" : "none";
    if (text) hideCursor();
  };

  const clearOverlay = () => {
    while (overlayEl.firstChild && overlayEl.firstChild !== fakeCursorEl) {
      overlayEl.removeChild(overlayEl.firstChild);
    }
    overlayEl.style.display = "none";
    imeFragment = "";
    restoreCursor();
  };

  // Detect committed text via compositionend. When the IME commits a
  // syllable at a boundary (e.g., "복" committed when user types "ㅈ"),
  // compositionend fires with e.data="복". Send it to the PTY since
  // triggerDataEvent is suppressed during composition.
  // Guard: only send if imeFragment is non-empty (prevents double-send
  // when our docKeyDown handler already flushed on Enter/Esc/Tab).
  const onCompositionEnd = (e: CompositionEvent) => {
    if (e.data && isComposing && imeFragment) {
      invoke("write_to_pty", { sessionId, data: e.data }).catch(() => {});
      imeFragment = "";
    }
  };
  terminal.textarea?.addEventListener("compositionend", onCompositionEnd);

  // Reset composition on blur (prevents permanently stuck isComposing).
  const onTextareaBlur = () => {
    if (isComposing) {
      const composed = imeFragment;
      clearOverlay();
      if (composed) {
        invoke("write_to_pty", { sessionId, data: composed }).catch(() => {});
      }
      isComposing = false;
      imeFlushGen++;
    }
  };
  terminal.textarea?.addEventListener("blur", onTextareaBlur);

  // Track composition state via input events (for overlay updates)
  const docInput = (e: Event) => {
    if (e.target !== terminal.textarea || !isComposing) return;
    const ie = e as InputEvent;
    if (ie.inputType === "insertReplacementText" || ie.inputType === "insertText") {
      const ta = terminal.textarea;
      if (ta) {
        showOverlay(ta.value.substring(imeStartPos));
      }
    }
  };
  document.addEventListener("input", docInput, true);

  // Document-level keydown (capture) — manages isComposing flag and flush.
  const docKeyDown = (e: KeyboardEvent) => {
    if (e.target !== terminal.textarea) return;
    const isEnter = e.key === "Enter" || e.code === "Enter";
    const isTerminating = isEnter || e.key === "Escape" || e.code === "Escape" ||
                          e.key === "Tab" || e.code === "Tab";
    if (e.keyCode === 229 && !isTerminating) {
      if (!isComposing) {
        imeStartPos = Math.max(0, (terminal.textarea?.value.length ?? 1) - 1);
      }
      isComposing = true;
      const ta = terminal.textarea;
      if (ta) {
        showOverlay(ta.value.substring(imeStartPos));
      }
    } else if (!e.isComposing || isTerminating) {
      // Modifier keys (Shift, Ctrl, Alt, Meta) never terminate IME composition.
      // In WKWebView, Shift keydown during Korean IME may fire with
      // isComposing=false and keyCode!=229, which would incorrectly flush
      // the composing consonant (e.g. ㄱ) before the Shift+vowel combines (e.g. 계).
      const isModifier = e.key === "Shift" || e.key === "Control" ||
                         e.key === "Alt" || e.key === "Meta";
      if (isComposing && !isModifier) {
        // Flush only the current composing fragment — committed characters
        // already passed through triggerDataEvent to the PTY.
        const composed = imeFragment;
        clearOverlay();
        // Send composed text + terminating key in ONE write to
        // guarantee ordering (async invoke could reorder otherwise).
        const keySuffix = isTerminating
          ? (isEnter ? "\r" : e.key === "Escape" || e.code === "Escape" ? "\x1b" : "\t")
          : "";
        const data = composed + keySuffix;
        if (data) {
          invoke("write_to_pty", { sessionId, data }).catch(() => {});
          for (const ch of composed) {
            if (ch === "\r") lineBuffer = "";
            else if (ch >= " ") lineBuffer += ch;
          }
          if (isEnter) lineBuffer = "";
        }
        imeFlushGen++;
        if (isTerminating) {
          e.stopImmediatePropagation();
          e.preventDefault();
        }
      }
      if (!isModifier) isComposing = false;
    }
  };
  document.addEventListener("keydown", docKeyDown, true);
  managed.docKeyDown = docKeyDown;
  managed.docInput = docInput;

  // Patch triggerDataEvent — suppress during composition, defer Korean chars.
  const xtermCore = (terminal as any)._core;
  if (xtermCore?.coreService?.triggerDataEvent) {
    const origTrigger = xtermCore.coreService.triggerDataEvent.bind(
      xtermCore.coreService,
    );
    const reKorean = /[\u1100-\u11FF\u3131-\u318E\uAC00-\uD7A3]/;

    xtermCore.coreService.triggerDataEvent = (
      data: string,
      wasUserInput?: boolean,
    ) => {
      // Suppress all triggerDataEvent during composition. Committed
      // characters are sent by the compositionend listener instead.
      if (isComposing) return;
      // WKWebView fires input BEFORE keydown for IME. Defer Korean
      // chars by 20ms so keydown(229) can set isComposing first.
      if (data.length === 1 && reKorean.test(data)) {
        const gen = imeFlushGen;
        setTimeout(() => {
          if (!isComposing && gen === imeFlushGen) {
            origTrigger(data, wasUserInput);
          }
        }, 20);
        return;
      }
      origTrigger(data, wasUserInput);
    };
  }

  const bindImeHandlers = () => {
    const helperTextarea =
      terminal.textarea ??
      containerEl.querySelector<HTMLTextAreaElement>(".xterm-helper-textarea");

    if (!helperTextarea || managed.disposed) return;
    if (managed.imeHandlers?.el === helperTextarea) return;

    if (managed.imeHandlers) {
      const { el, nativeFocus, onFocus } = managed.imeHandlers;
      el.focus = nativeFocus;
      el.removeEventListener("focus", onFocus);
      managed.imeHandlers = null;
    }

    const nativeFocus = helperTextarea.focus.bind(helperTextarea);
    helperTextarea.focus = (opts?: FocusOptions) => {
      nativeFocus({ ...opts, preventScroll: true });
    };

    const onFocus = () => {
      requestAnimationFrame(() => {
        document.documentElement.scrollTop = 0;
        document.documentElement.scrollLeft = 0;
        document.body.scrollTop = 0;
        document.body.scrollLeft = 0;
      });
    };
    helperTextarea.addEventListener("focus", onFocus);

    managed.imeHandlers = {
      el: helperTextarea,
      nativeFocus,
      onFocus,
    };
  };

  managed.rebindIme = bindImeHandlers;
  bindImeHandlers();

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
  s.rebindIme?.();

  // Fit after layout settles
  requestAnimationFrame(() => {
    s.rebindIme?.();
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

  // Remove document-level IME listeners
  if (s.docInput) {
    document.removeEventListener("input", s.docInput, true);
    s.docInput = null;
  }
  if (s.docKeyDown) {
    document.removeEventListener("keydown", s.docKeyDown, true);
    s.docKeyDown = null;
  }

  // Remove IME listeners
  if (s.imeHandlers) {
    const { el, nativeFocus, onFocus } = s.imeHandlers;
    el.focus = nativeFocus;
    el.removeEventListener("focus", onFocus);
    s.imeHandlers = null;
  }

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
