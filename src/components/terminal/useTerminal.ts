import { useEffect, useRef, useCallback } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { SearchAddon } from "@xterm/addon-search";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { terminalThemes } from "./themes";
import {
  useTerminalStore,
  registerTerminal,
  unregisterTerminal,
} from "../../stores/terminalStore";

// Shortcuts that should NOT be consumed by xterm (let them bubble to app)
const INTERCEPTED_KEYS = new Set([
  "t", "w", "f", "d", "z", "s", "o", "=", "-", "0",
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
    terminal.loadAddon(fitAddon);
    terminal.loadAddon(new WebLinksAddon());
    terminal.loadAddon(searchAddon);

    // Let app-level shortcuts bubble past xterm
    terminal.attachCustomKeyEventHandler((e) => {
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
    // Initial fit + delayed re-fit to handle containers that aren't fully laid out yet
    fitAddon.fit();
    requestAnimationFrame(() => fitAddon.fit());

    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;
    searchAddonRef.current = searchAddon;

    // Register in instance registry
    registerTerminal(sessionId, terminal, searchAddon);

    // ResizeObserver
    const observer = new ResizeObserver(() => {
      fitAddon.fit();
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

    // Spawn shell
    try {
      await invoke("spawn_shell", {
        sessionId,
        cols: terminal.cols,
        rows: terminal.rows,
      });
    } catch (error) {
      console.error("Failed to spawn shell:", error);
      terminal.write(`\r\n\x1b[31m[Failed to start shell: ${error}]\x1b[0m\r\n`);
      return;
    }

    if (disposed.current) return;

    // Forward user input to PTY
    terminal.onData((data) => {
      if (!disposed.current) {
        invoke("write_to_pty", { sessionId, data }).catch((err) => {
          console.error("Failed to write to PTY:", err);
        });
      }
    });

    // Handle resize
    terminal.onResize(({ cols, rows }) => {
      if (!disposed.current) {
        invoke("resize_pty", { sessionId, cols, rows }).catch((err) => {
          console.error("Failed to resize PTY:", err);
        });
      }
    });
  }, [sessionId]);

  // Main lifecycle
  useEffect(() => {
    disposed.current = false;
    init();

    return () => {
      disposed.current = true;
      unlistenDataRef.current?.();
      unlistenExitRef.current?.();
      observerRef.current?.disconnect();
      observerRef.current = null;
      unregisterTerminal(sessionId);
      terminalRef.current?.dispose();
      terminalRef.current = null;
      invoke("kill_pty", { sessionId }).catch((err) => {
        console.error("Failed to kill PTY:", err);
      });
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
        // Delay fit to allow DOM to update display:none → display:flex
        requestAnimationFrame(() => {
          fitAddonRef.current?.fit();
        });
      }
    });
  }, []);

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
