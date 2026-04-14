import { useEffect, useRef, useCallback } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { SearchAddon } from "@xterm/addon-search";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebglAddon } from "@xterm/addon-webgl";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { terminalThemes } from "./themes";
import {
  useTerminalStore,
  registerTerminal,
  unregisterTerminal,
  consumeSessionCwd,
} from "../../stores/terminalStore";
import type { PaneNode } from "../../types/terminal";

function collectLeafSessionIds(node: PaneNode): string[] {
  if (node.type === "leaf") return [node.sessionId];
  return [
    ...collectLeafSessionIds(node.children[0]),
    ...collectLeafSessionIds(node.children[1]),
  ];
}

// Shortcuts that should NOT be consumed by xterm (let them bubble to app)
const INTERCEPTED_KEYS = new Set([
  "t", "w", "f", "d", "e", "z", "s", "o", "=", "-", "0",
  "1", "2", "3", "4", "5", "6", "7", "8", "9",
  "Enter",
]);

export function useTerminal(sessionId: string) {
  const termRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const searchAddonRef = useRef<SearchAddon | null>(null);
  const unlistenDataRef = useRef<UnlistenFn | null>(null);
  const unlistenExitRef = useRef<UnlistenFn | null>(null);
  const observerRef = useRef<ResizeObserver | null>(null);
  const imeHandlersRef = useRef<{
    el: HTMLTextAreaElement;
    nativeFocus: (opts?: FocusOptions) => void;
    onFocus: () => void;
    onStart: () => void;
    onEnd: (e: CompositionEvent) => void;
  } | null>(null);
  const disposed = useRef(false);

  const init = useCallback(async () => {
    if (!termRef.current || terminalRef.current) return;

    const { fontSize, themeName } = useTerminalStore.getState();
    const theme = terminalThemes[themeName] ?? terminalThemes.catppuccin;

    const terminal = new Terminal({
      theme,
      fontFamily: "'JetBrains Mono', 'Fira Code', 'SF Mono', Menlo, monospace",
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
      // Never interfere with IME composition (Korean, Japanese, Chinese input)
      if (e.isComposing || e.keyCode === 229) return true;

      // Shift+Enter → send CSI u escape sequence so apps (e.g. Claude Code) recognise it
      if (e.key === "Enter" && e.shiftKey && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        if (e.type === "keydown") {
          invoke("write_to_pty", { sessionId, data: "\x1b[13;2u" }).catch(() => {});
        }
        return false;
      }
      if ((e.metaKey || e.ctrlKey) && INTERCEPTED_KEYS.has(e.key)) {
        return false; // Don't handle — let DOM event propagate
      }
      // Cmd+Shift+[ and Cmd+Shift+] for tab switching
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === "[" || e.key === "]")) {
        return false;
      }
      // Cmd+Opt+Arrow for pane navigation
      if ((e.metaKey || e.ctrlKey) && e.altKey && e.key.startsWith("Arrow")) {
        return false;
      }
      return true; // xterm handles it
    });

    terminal.open(termRef.current);

    // Load WebGL addon for GPU-accelerated, sharper text rendering
    try {
      const webglAddon = new WebglAddon(true /* preserveDrawingBuffer — needed for canvas capture */);
      webglAddon.onContextLoss(() => {
        webglAddon.dispose();
      });
      terminal.loadAddon(webglAddon);
    } catch {
      // WebGL not available, fall back to canvas renderer (default)
    }

    // Initial fit + delayed re-fit to handle containers that aren't fully laid out yet
    fitAddon.fit();
    requestAnimationFrame(() => fitAddon.fit());

    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;
    searchAddonRef.current = searchAddon;

    // Register in instance registry
    registerTerminal(sessionId, terminal, searchAddon);

    // ResizeObserver — guard against fitting hidden terminals (display:none tabs)
    const observer = new ResizeObserver(() => {
      if (termRef.current && termRef.current.offsetWidth > 0 && termRef.current.offsetHeight > 0) {
        fitAddon.fit();
      }
    });
    if (termRef.current) {
      observer.observe(termRef.current);
    }
    observerRef.current = observer;

    // Listen for PTY output
    unlistenDataRef.current = await listen<string>(
      `pty-data-${sessionId}`,
      (event) => {
        if (!disposed.current) {
          terminal.write(event.payload);
        }
      }
    );

    if (disposed.current) {
      unlistenDataRef.current?.();
      observer.disconnect();
      terminal.dispose();
      return;
    }

    unlistenExitRef.current = await listen(
      `pty-exit-${sessionId}`,
      () => {
        if (!disposed.current) {
          terminal.write("\r\n\x1b[33m[Process exited]\x1b[0m\r\n");
        }
      }
    );

    if (disposed.current) {
      unlistenDataRef.current?.();
      unlistenExitRef.current?.();
      observer.disconnect();
      terminal.dispose();
      return;
    }

    // Spawn shell (with optional cwd for duplicated tabs)
    const cwd = consumeSessionCwd(sessionId);
    try {
      await invoke("spawn_shell", {
        sessionId,
        cols: terminal.cols,
        rows: terminal.rows,
        cwd: cwd ?? null,
      });
    } catch (error) {
      console.error("Failed to spawn shell:", error);
      terminal.write(`\r\n\x1b[31m[Failed to start shell: ${error}]\x1b[0m\r\n`);
      return;
    }

    if (disposed.current) return;

    // IME composition handling for CJK input (Korean, Japanese, Chinese)
    // xterm.js in Tauri's webview may fire onData for individual jamo/kana
    // before the OS IME can compose them into syllables. We suppress onData
    // during composition and send the composed result from compositionend.
    let isComposing = false;
    let skipNextOnData = false;
    const helperTextarea = termRef.current?.querySelector<HTMLTextAreaElement>(
      ".xterm-helper-textarea"
    );

    if (helperTextarea) {
      // Prevent WKWebView auto-scroll when xterm focuses the textarea.
      // WKWebView scrolls the native NSScrollView to bring focused elements
      // into view, bypassing CSS overflow. We fix this at the source by
      // patching focus() to always use preventScroll:true (Safari 15+).
      const nativeFocus = helperTextarea.focus.bind(helperTextarea);
      helperTextarea.focus = (opts?: FocusOptions) => {
        nativeFocus({ ...opts, preventScroll: true });
      };

      // Fallback: if WKWebView still scrolls (e.g. on programmatic focus
      // from the native layer), reset scroll on the next animation frame.
      const onFocus = () => {
        requestAnimationFrame(() => {
          document.documentElement.scrollTop = 0;
          document.documentElement.scrollLeft = 0;
          document.body.scrollTop = 0;
          document.body.scrollLeft = 0;
        });
      };
      helperTextarea.addEventListener("focus", onFocus);
      const onCompositionStart = () => {
        isComposing = true;
      };
      const onCompositionEnd = (e: CompositionEvent) => {
        isComposing = false;
        if (disposed.current) return;
        if (e.data) {
          skipNextOnData = true;
          invoke("write_to_pty", { sessionId, data: e.data }).catch((err) => {
            console.error("Failed to write to PTY:", err);
          });
        }
      };
      helperTextarea.addEventListener("compositionstart", onCompositionStart);
      helperTextarea.addEventListener("compositionend", onCompositionEnd);
      imeHandlersRef.current = {
        el: helperTextarea,
        nativeFocus,
        onFocus,
        onStart: onCompositionStart,
        onEnd: onCompositionEnd,
      };
    }

    // Track current line buffer for command detection
    let lineBuffer = "";

    // Forward user input to PTY (skip during IME composition)
    terminal.onData((data) => {
      if (disposed.current) return;
      if (skipNextOnData) {
        skipNextOnData = false;
        return;
      }
      if (isComposing) return;

      // Detect "collaborator" command: buffer input and check on Enter
      if (data === "\r") {
        if (lineBuffer.trim() === "collaborator") {
          lineBuffer = "";
          // Send Ctrl+U to clear the shell's input buffer (the individual
          // characters were already forwarded), then Ctrl+C as fallback.
          invoke("write_to_pty", { sessionId, data: "\x15" }).catch(() => {});
          useTerminalStore.getState().openCollaboratorSplit();
          return;
        }
        lineBuffer = "";
      } else if (data === "\x7f") {
        // Backspace — remove last character from buffer
        lineBuffer = lineBuffer.slice(0, -1);
      } else if (data.length === 1 && data >= " ") {
        lineBuffer += data;
      } else if (data === "\x03") {
        // Ctrl+C — reset buffer
        lineBuffer = "";
      }

      invoke("write_to_pty", { sessionId, data }).catch((err) => {
        console.error("Failed to write to PTY:", err);
      });
    });

    // Handle resize — debounce to avoid flooding the backend with SIGWINCH
    // during continuous resizes (e.g. dragging the canvas panel divider).
    let resizeTimer: ReturnType<typeof setTimeout> | null = null;
    terminal.onResize(({ cols, rows }) => {
      if (disposed.current) return;
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        if (!disposed.current) {
          invoke("resize_pty", { sessionId, cols, rows }).catch((err) => {
            console.error("Failed to resize PTY:", err);
          });
        }
      }, 80);
    });
  }, [sessionId]);

  // Main lifecycle — defer init so React StrictMode cleanup cancels it
  // before xterm is created, preventing disposed-terminal race conditions.
  useEffect(() => {
    disposed.current = false;
    const timer = setTimeout(() => {
      init().catch((err) => {
        if (!disposed.current) {
          console.error("Terminal init failed:", err);
        }
      });
    }, 0);

    return () => {
      clearTimeout(timer);
      disposed.current = true;
      unlistenDataRef.current?.();
      unlistenExitRef.current?.();
      observerRef.current?.disconnect();
      observerRef.current = null;
      // Remove scroll-prevention and IME composition listeners
      if (imeHandlersRef.current) {
        const { el, nativeFocus, onFocus, onStart, onEnd } = imeHandlersRef.current;
        el.focus = nativeFocus; // restore original focus()
        el.removeEventListener("focus", onFocus);
        el.removeEventListener("compositionstart", onStart);
        el.removeEventListener("compositionend", onEnd);
        imeHandlersRef.current = null;
      }
      unregisterTerminal(sessionId);
      // Defer terminal dispose outside React's commit phase so xterm's
      // internal RAF callbacks don't throw during React's error handling,
      // which would crash the entire component tree.
      const term = terminalRef.current;
      terminalRef.current = null;
      if (term) {
        setTimeout(() => { try { term.dispose(); } catch { /* xterm internal */ } }, 0);
      }
      try { invoke("kill_pty", { sessionId }).catch(() => {}); } catch { /* no Tauri */ }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  // React to font size changes
  useEffect(() => {
    return useTerminalStore.subscribe((state, prev) => {
      if (state.fontSize !== prev.fontSize && terminalRef.current) {
        terminalRef.current.options.fontSize = state.fontSize;
        fitAddonRef.current?.fit();
      }
    });
  }, []);

  // React to theme changes
  useEffect(() => {
    return useTerminalStore.subscribe((state, prev) => {
      if (state.themeName !== prev.themeName && terminalRef.current) {
        const theme = terminalThemes[state.themeName] ?? terminalThemes.catppuccin;
        terminalRef.current.options.theme = theme;
      }
    });
  }, []);

  // Re-fit when this terminal's tab becomes visible (fixes column crash on new tabs)
  useEffect(() => {
    return useTerminalStore.subscribe((state, prev) => {
      if (state.activeTabId !== prev.activeTabId && terminalRef.current && fitAddonRef.current) {
        // Only re-fit if THIS terminal belongs to the newly active tab
        const activeTab = state.tabs.find((t) => t.id === state.activeTabId);
        if (!activeTab) return;
        const activeSessionIds = collectLeafSessionIds(activeTab.paneTree);
        if (!activeSessionIds.includes(sessionId)) return;

        // Delay fit to allow DOM to update display:none → display:flex
        requestAnimationFrame(() => {
          fitAddonRef.current?.fit();
        });
      }
    });
  }, [sessionId]);

  const writeToPty = useCallback(
    (data: string) => {
      invoke("write_to_pty", { sessionId, data }).catch((err) => {
        console.error("Failed to write to PTY:", err);
      });
    },
    [sessionId]
  );

  return { termRef, terminalRef, fitAddonRef, searchAddonRef, writeToPty };
}
