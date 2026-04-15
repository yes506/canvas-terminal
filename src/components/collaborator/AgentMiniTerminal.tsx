import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useShallow } from "zustand/react/shallow";
import { terminalThemes } from "../terminal/themes";
import { useTerminalStore } from "../../stores/terminalStore";
import { useCollaboratorStore, agentDisplayName, toolLabel } from "../../stores/collaboratorStore";
import { useCollabSessionId } from "./CollabSessionContext";
import { createOutputCapture } from "../../lib/agentOutputCapture";
import type { ToolConfig } from "../../types/collaborator";
import { X } from "lucide-react";

interface AgentMiniTerminalProps {
  sessionId: string;
  tool: ToolConfig;
  cwd: string | null;
  onClose: (sessionId: string) => void;
}

/**
 * Spawns a PTY session, runs an AI CLI tool in it, and renders an interactive
 * xterm.js terminal. Users can type directly into the AI CLI tool.
 */
export function AgentMiniTerminal({
  sessionId,
  tool,
  cwd,
  onClose,
}: AgentMiniTerminalProps) {
  const collabSessionId = useCollabSessionId();
  const termRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
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
  const captureRef = useRef<ReturnType<typeof createOutputCapture> | null>(null);
  const disposed = useRef(false);
  const [focused, setFocused] = useState(false);

  useEffect(() => {
    disposed.current = false;

    const timer = setTimeout(async () => {
      if (!termRef.current || terminalRef.current) return;

      const { fontSize, themeName } = useTerminalStore.getState();
      const theme = terminalThemes[themeName] ?? terminalThemes.catppuccin;

      const terminal = new Terminal({
        theme,
        fontFamily:
          "'JetBrains Mono', 'Fira Code', 'SF Mono', Menlo, monospace",
        fontSize: Math.max(fontSize - 2, 9),
        lineHeight: 1.15,
        cursorBlink: true,
        cursorStyle: "bar",
        scrollback: 5000,
        allowProposedApi: true,
      });

      const fitAddon = new FitAddon();
      terminal.loadAddon(fitAddon);
      terminal.open(termRef.current);

      // Load WebGL addon for GPU-accelerated, sharper text rendering
      try {
        const webglAddon = new WebglAddon(true);
        webglAddon.onContextLoss(() => webglAddon.dispose());
        terminal.loadAddon(webglAddon);
      } catch {
        // WebGL not available, fall back to canvas renderer
      }

      fitAddon.fit();
      requestAnimationFrame(() => fitAddon.fit());

      terminalRef.current = terminal;
      fitAddonRef.current = fitAddon;

      if (disposed.current) {
        terminal.dispose();
        return;
      }

      // ResizeObserver
      const observer = new ResizeObserver(() => {
        if (
          termRef.current &&
          termRef.current.offsetWidth > 0 &&
          termRef.current.offsetHeight > 0
        ) {
          fitAddon.fit();
        }
      });
      if (termRef.current) observer.observe(termRef.current);
      observerRef.current = observer;

      // Set up output capture (no longer logs raw terminal output to conversation log;
      // only user prompts and tasks are persisted there)
      const capture = createOutputCapture({
        agentLabel: toolLabel(tool.id),
        onFlush: () => {
          // Intentionally no-op: conversation log only tracks user prompts and tasks
        },
      });
      captureRef.current = capture;

      // Listen for PTY output
      unlistenDataRef.current = await listen<string>(
        `pty-data-${sessionId}`,
        (event) => {
          if (!disposed.current) {
            terminal.write(event.payload);
            capture.feed(event.payload);
          }
        },
      );

      if (disposed.current) {
        unlistenDataRef.current?.();
        observer.disconnect();
        terminal.dispose();
        return;
      }

      // Listen for PTY exit
      unlistenExitRef.current = await listen(
        `pty-exit-${sessionId}`,
        () => {
          if (!disposed.current) {
            // Flush any remaining buffered output before marking exit
            captureRef.current?.flush();
            terminal.write("\r\n\x1b[33m[Process exited]\x1b[0m\r\n");
            useCollaboratorStore
              .getState()
              .setAgentStatus(sessionId, "exited");
          }
        },
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
          cwd: cwd ?? null,
        });
      } catch (err) {
        if (!disposed.current) {
          terminal.write(
            `\r\n\x1b[31m[Failed to start shell: ${err}]\x1b[0m\r\n`,
          );
        }
        return;
      }

      if (disposed.current) return;

      // Let app-level shortcuts bubble past xterm
      terminal.attachCustomKeyEventHandler((e) => {
        if (e.isComposing || e.keyCode === 229) return true;
        // Shift+Enter → CSI u escape for tools like Claude Code
        if (e.key === "Enter" && e.shiftKey && !e.metaKey && !e.ctrlKey) {
          e.preventDefault();
          if (e.type === "keydown") {
            invoke("write_to_pty", { sessionId, data: "\x1b[13;2u" }).catch(() => {});
          }
          return false;
        }
        if ((e.metaKey || e.ctrlKey) && ["t","w","f","d","e","z","s","o","=","-","0","1","2","3","4","5","6","7","8","9","Enter"].includes(e.key)) {
          return false;
        }
        if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === "[" || e.key === "]")) {
          return false;
        }
        return true;
      });

      // IME composition handling for CJK input
      let isComposing = false;
      let skipNextOnData = false;
      const helperTextarea = termRef.current?.querySelector<HTMLTextAreaElement>(
        ".xterm-helper-textarea"
      );

      if (helperTextarea) {
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

        const onCompositionStart = () => { isComposing = true; };
        const onCompositionEnd = (e: CompositionEvent) => {
          isComposing = false;
          if (disposed.current) return;
          if (e.data) {
            skipNextOnData = true;
            invoke("write_to_pty", { sessionId, data: e.data }).catch(() => {});
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

      // Forward user keystrokes to PTY
      terminal.onData((data) => {
        if (disposed.current) return;
        if (skipNextOnData) { skipNextOnData = false; return; }
        if (isComposing) return;
        invoke("write_to_pty", { sessionId, data }).catch(() => {});
      });

      // Track focus state for visual indicator
      terminal.textarea?.addEventListener("focus", () => setFocused(true));
      terminal.textarea?.addEventListener("blur", () => setFocused(false));

      // Run the AI CLI tool command
      try {
        await invoke("write_to_pty", {
          sessionId,
          data: tool.command + "\n",
        });
      } catch {
        // Shell may have exited already
      }

      // Register in store
      useCollaboratorStore.getState().addAgent({
        sessionId,
        tool: tool.id,
        status: "running",
        collabSessionId,
      });

      // Handle resize
      let resizeTimer: ReturnType<typeof setTimeout> | null = null;
      terminal.onResize(({ cols, rows }) => {
        if (disposed.current) return;
        if (resizeTimer) clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => {
          if (!disposed.current) {
            invoke("resize_pty", { sessionId, cols, rows }).catch(() => {});
          }
        }, 80);
      });
    }, 0);

    return () => {
      clearTimeout(timer);
      disposed.current = true;
      // Flush remaining output and clean up capture
      captureRef.current?.flush();
      captureRef.current?.dispose();
      captureRef.current = null;
      unlistenDataRef.current?.();
      unlistenExitRef.current?.();
      observerRef.current?.disconnect();
      observerRef.current = null;

      // Remove IME composition listeners
      if (imeHandlersRef.current) {
        const { el, nativeFocus, onFocus, onStart, onEnd } = imeHandlersRef.current;
        el.focus = nativeFocus;
        el.removeEventListener("focus", onFocus);
        el.removeEventListener("compositionstart", onStart);
        el.removeEventListener("compositionend", onEnd);
        imeHandlersRef.current = null;
      }

      // Kill PTY
      invoke("kill_pty", { sessionId }).catch(() => {});
      useCollaboratorStore.getState().removeAgent(sessionId);

      // Dispose xterm
      const term = terminalRef.current;
      terminalRef.current = null;
      if (term) {
        setTimeout(() => {
          try {
            term.dispose();
          } catch {
            /* xterm internal */
          }
        }, 0);
      }
    };
  }, [sessionId, tool.command, cwd, collabSessionId]);

  // React to theme changes
  useEffect(() => {
    return useTerminalStore.subscribe((state, prev) => {
      if (state.themeName !== prev.themeName && terminalRef.current) {
        const theme =
          terminalThemes[state.themeName] ?? terminalThemes.catppuccin;
        terminalRef.current.options.theme = theme;
      }
    });
  }, []);

  // React to font size changes
  useEffect(() => {
    return useTerminalStore.subscribe((state, prev) => {
      if (state.fontSize !== prev.fontSize && terminalRef.current) {
        terminalRef.current.options.fontSize = Math.max(state.fontSize - 2, 9);
        fitAddonRef.current?.fit();
      }
    });
  }, []);

  const agent = useCollaboratorStore((s) =>
    s.agents.find((a) => a.sessionId === sessionId),
  );
  const sessionAgents = useCollaboratorStore(
    useShallow((s) => s.agents.filter((a) => a.collabSessionId === collabSessionId)),
  );
  const displayName = agent ? agentDisplayName(agent, sessionAgents) : tool.label;
  const isExited = agent?.status === "exited";

  return (
    <div className={`flex flex-col h-full min-h-0 border rounded-md overflow-hidden ${focused ? "border-accent" : "border-surface-lighter"}`}>
      {/* Agent header */}
      <div className="flex items-center gap-2 px-2 py-1 bg-surface-light border-b border-surface-lighter text-xs shrink-0">
        <span
          className={`w-1.5 h-1.5 rounded-full shrink-0 ${isExited ? "bg-gray-500" : "bg-green-400"}`}
        />
        <span className={`font-bold ${tool.colorClass} truncate`}>
          {displayName}
        </span>
        <div className="flex-1" />
        <button
          className="text-text-dim hover:text-red-400 transition-colors p-0.5"
          onClick={() => onClose(sessionId)}
          title="Close agent"
        >
          <X size={12} />
        </button>
      </div>
      {/* xterm container */}
      <div ref={termRef} className="flex-1 min-h-0 bg-surface" />
    </div>
  );
}
