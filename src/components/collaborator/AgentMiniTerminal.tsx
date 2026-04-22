import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useShallow } from "zustand/react/shallow";
import { terminalThemes } from "../terminal/themes";
import { useTerminalStore } from "../../stores/terminalStore";
import { useCollaboratorStore, agentDisplayName, toolLabel, scanForTaskCompletions } from "../../stores/collaboratorStore";
import { useCollabSessionId } from "./CollabSessionContext";
import { createOutputCapture, stripAnsi } from "../../lib/agentOutputCapture";
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
  } | null>(null);
  const captureRef = useRef<ReturnType<typeof createOutputCapture> | null>(null);
  const docKeyDownRef = useRef<((e: KeyboardEvent) => void) | null>(null);
  const docInputRef = useRef<((e: Event) => void) | null>(null);
  const imeOverlayRef = useRef<HTMLSpanElement | null>(null);
  const readyTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
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
          "'JetBrainsMono Nerd Font Mono', 'Noto Sans Mono CJK KR', 'D2Coding', 'JetBrains Mono', Menlo, monospace",
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
      requestAnimationFrame(() => {
        fitAddon.fit();
        terminal.scrollToBottom();
      });

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
          const buf = terminal.buffer.active;
          const wasAtBottom = buf.viewportY >= buf.baseY;
          fitAddon.fit();
          if (wasAtBottom) terminal.scrollToBottom();
        }
      });
      if (termRef.current) observer.observe(termRef.current);
      observerRef.current = observer;

      const capture = createOutputCapture({
        agentLabel: toolLabel(tool.id),
        onFlush: () => {
          // After agent output settles, check for task completion signals.
          // Agents write *.done.json files to shared memory to signal completion.
          if (collabSessionId) {
            scanForTaskCompletions(collabSessionId);
          }
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
        // Return true so xterm does NOT call preventDefault() on IME
        // key events — preventDefault() blocks the IME from composing.
        // The triggerDataEvent patch handles suppressing IME output.
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

      // IME composition handling for CJK input (WKWebView)
      // See terminalManager.ts for detailed explanation.
      let isComposing = false;
      let imeStartPos = 0;
      let imeFlushGen = 0;
      let imeFragment = "";

      const overlayEl = document.createElement("span");
      overlayEl.style.cssText =
        `position:absolute;color:inherit;` +
        `font-family:${terminal.options.fontFamily ?? "monospace"};` +
        `font-size:${terminal.options.fontSize ?? 10}px;` +
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
      if (!document.getElementById("ime-cursor-blink-style")) {
        const styleEl = document.createElement("style");
        styleEl.id = "ime-cursor-blink-style";
        styleEl.textContent = `@keyframes ime-cursor-blink { 0%,50% { opacity: 1; } 50.01%,100% { opacity: 0; } }`;
        document.head.appendChild(styleEl);
      }
      const screenEl = termRef.current?.querySelector(".xterm-screen") as HTMLElement | null;
      if (screenEl) {
        screenEl.style.position = "relative";
        screenEl.appendChild(overlayEl);
        imeOverlayRef.current = overlayEl;
      } else if (termRef.current) {
        termRef.current.style.position = "relative";
        termRef.current.appendChild(overlayEl);
        imeOverlayRef.current = overlayEl;
      }
      let cursorHidden = false;
      const core = (terminal as any)._core;
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

      const isFullWidth = (ch: string) => {
        const cp = ch.codePointAt(0) ?? 0;
        return (cp >= 0x1100 && cp <= 0x115F) ||
               (cp >= 0x2E80 && cp <= 0x303E) ||
               (cp >= 0x3040 && cp <= 0x33BF) ||
               (cp >= 0x3400 && cp <= 0x4DBF) ||
               (cp >= 0x4E00 && cp <= 0xA4CF) ||
               (cp >= 0xA960 && cp <= 0xA97C) ||
               (cp >= 0xAC00 && cp <= 0xD7AF) ||
               (cp >= 0xD7B0 && cp <= 0xD7FF) ||
               (cp >= 0xF900 && cp <= 0xFAFF) ||
               (cp >= 0xFE30 && cp <= 0xFE6F) ||
               (cp >= 0xFF01 && cp <= 0xFF60) ||
               (cp >= 0xFFE0 && cp <= 0xFFE6) ||
               (cp >= 0x20000 && cp <= 0x2FA1F);
      };

      const showOverlay = (text: string) => {
        imeFragment = text;
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
          overlayEl.style.fontSize = `${terminal.options.fontSize ?? 10}px`;
          overlayEl.style.lineHeight = `${cellH}px`;
          overlayEl.style.height = `${cellH}px`;
          overlayEl.style.left = `${cx * cellW}px`;
          overlayEl.style.top = `${cy * cellH}px`;
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
      // syllable at a boundary, send it to PTY (triggerDataEvent is suppressed).
      const onCompositionEnd = (e: CompositionEvent) => {
        if (e.data && isComposing && imeFragment) {
          invoke("write_to_pty", { sessionId, data: e.data }).catch(() => {});
          imeFragment = "";
        }
      };
      terminal.textarea?.addEventListener("compositionend", onCompositionEnd);

      const onTextareaBlur = () => {
        if (isComposing) {
          const composed = imeFragment;
          clearOverlay();
          if (composed) invoke("write_to_pty", { sessionId, data: composed }).catch(() => {});
          isComposing = false;
          imeFlushGen++;
        }
      };
      terminal.textarea?.addEventListener("blur", onTextareaBlur);

      const docInput = (e: Event) => {
        const ta = termRef.current?.querySelector(".xterm-helper-textarea") as HTMLTextAreaElement | null;
        if (e.target !== ta || !isComposing) return;
        const ie = e as InputEvent;
        if (ie.inputType === "insertReplacementText" || ie.inputType === "insertText") {
          if (ta) showOverlay(ta.value.substring(imeStartPos));
        }
      };
      document.addEventListener("input", docInput, true);
      docInputRef.current = docInput;

      const docKeyDown = (e: KeyboardEvent) => {
        const ta = termRef.current?.querySelector(".xterm-helper-textarea") as HTMLTextAreaElement | null;
        if (e.target !== ta) return;
        const isEnter = e.key === "Enter" || e.code === "Enter";
        const isTerminating = isEnter || e.key === "Escape" || e.code === "Escape" ||
                              e.key === "Tab" || e.code === "Tab";
        if (e.keyCode === 229 && !isTerminating) {
          if (!isComposing) {
            imeStartPos = Math.max(0, (ta?.value.length ?? 1) - 1);
          }
          isComposing = true;
          if (ta) showOverlay(ta.value.substring(imeStartPos));
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
            const keySuffix = isTerminating
              ? (isEnter ? "\r" : e.key === "Escape" || e.code === "Escape" ? "\x1b" : "\t")
              : "";
            const data = composed + keySuffix;
            if (data) {
              invoke("write_to_pty", { sessionId, data }).catch(() => {});
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
      docKeyDownRef.current = docKeyDown;

      // Patch triggerDataEvent to suppress/defer during IME composition
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
          if (isComposing) return;
          if (data.length === 1 && reKorean.test(data)) {
            const gen = imeFlushGen;
            setTimeout(() => {
              if (!isComposing && gen === imeFlushGen) origTrigger(data, wasUserInput);
            }, 20);
            return;
          }
          origTrigger(data, wasUserInput);
        };
      }

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
        imeHandlersRef.current = {
          el: helperTextarea,
          nativeFocus,
          onFocus,
        };
      }

      // Forward user keystrokes to PTY
      terminal.onData((data) => {
        if (disposed.current) return;
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

      // Register in store as "spawning" — not ready for messages yet.
      // The readiness detector below will set status to "running" and flush
      // any queued messages once the CLI tool's prompt appears.
      useCollaboratorStore.getState().addAgent({
        sessionId,
        tool: tool.id,
        status: "spawning",
        collabSessionId,
      });

      // ---- CLI readiness detection ----
      // Watch PTY output for prompt patterns indicating the CLI is ready for input.
      // Each CLI tool shows a prompt when ready (e.g. "> " for Claude, "❯ " for Codex).
      const READY_PATTERNS = [
        />\s*$/,       // Claude Code prompt: "> "
        /❯\s*$/,      // Codex CLI prompt
        /\$\s*$/,      // Generic shell prompt
      ];
      let readyDetected = false;
      // We accumulate a small tail buffer to match prompt patterns
      let readyBuf = "";
      const READY_BUF_MAX = 200;
      // Also use a fallback timer in case prompt pattern isn't matched
      readyTimeoutRef.current = setTimeout(() => {
        if (!readyDetected && !disposed.current) {
          readyDetected = true;
          const store = useCollaboratorStore.getState();
          store.setAgentStatus(sessionId, "running");
          store.flushPendingMessages(sessionId);
        }
      }, 8000); // 8s fallback — if CLI doesn't show a recognizable prompt

      const checkReady = (raw: string) => {
        if (readyDetected) return;
        readyBuf += stripAnsi(raw);
        if (readyBuf.length > READY_BUF_MAX) {
          readyBuf = readyBuf.slice(-READY_BUF_MAX);
        }
        const tail = readyBuf.slice(-80);
        if (READY_PATTERNS.some((re) => re.test(tail))) {
          readyDetected = true;
          if (readyTimeoutRef.current) clearTimeout(readyTimeoutRef.current);
          const store = useCollaboratorStore.getState();
          store.setAgentStatus(sessionId, "running");
          store.flushPendingMessages(sessionId);
        }
      };

      // Tap into the existing data listener to also check readiness
      const origDataUnlisten = unlistenDataRef.current;
      unlistenDataRef.current = await listen<string>(
        `pty-data-${sessionId}`,
        (event) => {
          if (!disposed.current) {
            terminal.write(event.payload);
            capture.feed(event.payload);
            checkReady(event.payload);
          }
        },
      );
      // Unlisten the original listener that was set up before
      origDataUnlisten?.();

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
      if (readyTimeoutRef.current) {
        clearTimeout(readyTimeoutRef.current);
        readyTimeoutRef.current = null;
      }
      disposed.current = true;
      // Flush remaining output and clean up capture
      captureRef.current?.flush();
      captureRef.current?.dispose();
      captureRef.current = null;
      unlistenDataRef.current?.();
      unlistenExitRef.current?.();
      observerRef.current?.disconnect();
      observerRef.current = null;

      // Remove document-level IME listeners
      if (docInputRef.current) {
        document.removeEventListener("input", docInputRef.current, true);
        docInputRef.current = null;
      }
      if (docKeyDownRef.current) {
        document.removeEventListener("keydown", docKeyDownRef.current, true);
        docKeyDownRef.current = null;
      }

      // Remove IME composition listeners
      if (imeHandlersRef.current) {
        const { el, nativeFocus, onFocus } = imeHandlersRef.current;
        el.focus = nativeFocus;
        el.removeEventListener("focus", onFocus);
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
        const newSize = Math.max(state.fontSize - 2, 9);
        terminalRef.current.options.fontSize = newSize;
        if (imeOverlayRef.current) {
          imeOverlayRef.current.style.fontSize = `${newSize}px`;
        }
        const buf = terminalRef.current.buffer.active;
        const wasAtBottom = buf.viewportY >= buf.baseY;
        fitAddonRef.current?.fit();
        if (wasAtBottom) terminalRef.current.scrollToBottom();
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
  const isSpawning = agent?.status === "spawning";

  return (
    <div className={`flex flex-col h-full min-h-0 border rounded-md overflow-hidden ${focused ? "border-accent" : "border-surface-lighter"}`}>
      {/* Agent header */}
      <div className="flex items-center gap-2 px-2 py-1 bg-surface-light border-b border-surface-lighter text-xs shrink-0">
        <span
          className={`w-1.5 h-1.5 rounded-full shrink-0 ${isExited ? "bg-gray-500" : isSpawning ? "bg-yellow-400 animate-pulse" : "bg-green-400"}`}
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
