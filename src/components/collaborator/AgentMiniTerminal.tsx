import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { terminalThemes } from "../terminal/themes";
import { useTerminalStore } from "../../stores/terminalStore";
import {
  useCollaboratorStore,
  agentDisplayName,
  getAgentTaskState,
  getIndicatorPresentation,
  scanForTaskCompletions,
  type AgentLifecycle,
} from "../../stores/collaboratorStore";
import { useCollabSessionId } from "./CollabSessionContext";
import { createOutputCapture, stripAnsi, registerCapture, unregisterCapture } from "../../lib/agentOutputCapture";
import { isEnvBootstrapped } from "../../lib/terminalManager";
import type { ToolConfig } from "../../types/collaborator";
import { X } from "lucide-react";

interface AgentMiniTerminalProps {
  sessionId: string;
  tool: ToolConfig;
  cwd: string | null;
  onClose: (sessionId: string) => void;
}

/**
 * PTY-exit handler logic, extracted as a pure function for testability.
 *
 * Statement order is load-bearing:
 *   1. flush capture buffer
 *   2. write `[Process exited]` to the terminal — visible IMMEDIATELY,
 *      before any IPC, so a slow scan can't delay the visible notice
 *   3. await scanForTaskCompletions — terminalizes the task and records
 *      the recentOutcome BEFORE the lifecycle flips; without this, an
 *      agent that writes .done.json then exits before the next poll
 *      tick leaves tasks-{sid}.md stuck on `in-progress` and the
 *      conversation log without a Task Report (data integrity)
 *   4. flip lifecycle to `"exited"` — runs unconditionally even if the
 *      scan throws, so a future scan exception cannot strand the
 *      indicator on `"running"`
 */
export async function handlePtyExit(opts: {
  disposed: boolean;
  capture: { flush(): void } | null;
  writeProcessExitedLine: () => void;
  collabSessionId: string | null;
  sessionId: string;
}): Promise<void> {
  if (opts.disposed) return;
  opts.capture?.flush();
  opts.writeProcessExitedLine();
  if (opts.collabSessionId) {
    try {
      await scanForTaskCompletions(opts.collabSessionId);
    } catch (err) {
      // Non-fatal: scanForTaskCompletions internally swallows IPC
      // errors today, but a future refactor could surface an exception.
      // Logging makes a regression discoverable without blocking the
      // lifecycle flip below.
      console.warn(
        "scanForTaskCompletions failed in pty-exit handler:",
        err,
      );
    }
  }
  useCollaboratorStore.getState().setAgentStatus(opts.sessionId, "exited");
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
  // A3 — track the worktree agent_id (if worktree mode was active for
  // this terminal) so we can call release_worktree on cleanup. The
  // supervisor's force_close path is reached via force_close_worktree
  // when the user explicitly asks to terminate; release_worktree
  // covers the normal "agent finished" close.
  const worktreeAgentIdRef = useRef<string | null>(null);
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
  // Inline-rename state for the header label. `editing === false` shows the
  // <span>; `editing === true` shows an <input value={draft}>. The store action
  // owns validation and human messages — we only thread RenameResult.message
  // back to setStatus on failure. (codex1+codex2 round-3-onwards.)
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const renameInputRef = useRef<HTMLInputElement | null>(null);
  // E20+E23 — half-state chip for PreserveFailed / GcError. Polls the
  // worktree lease while it exists; null when the agent has no
  // worktree lease (legacy spawn path).
  const [leaseSnapshot, setLeaseSnapshot] = useState<{
    state_kind: string;
    state_reason: string | null;
    gc_retries: number | null;
  } | null>(null);

  // E20+E23 — poll the worktree lease snapshot every 2s while the
  // agent is mounted. Sets `leaseSnapshot` so the half-state chip
  // re-renders when the lease enters PreserveFailed or GcError.
  // No-op for non-worktree agents (worktreeAgentIdRef.current === null).
  useEffect(() => {
    let cancelled = false;
    const tick = () => {
      const id = worktreeAgentIdRef.current;
      if (!id) return;
      invoke("query_agent_lease", { agentId: id })
        .then((snap) => {
          if (cancelled) return;
          if (snap == null) {
            setLeaseSnapshot(null);
          } else {
            setLeaseSnapshot(snap as typeof leaseSnapshot);
          }
        })
        .catch(() => {});
    };
    const handle = setInterval(tick, 2000);
    return () => {
      cancelled = true;
      clearInterval(handle);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    disposed.current = false;

    const initTerminal = async () => {
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
      // Keep collaborator mini terminals on the default renderer.
      // These panes are small and numerous, so avoiding WebGL prevents
      // idle GPU-context loss from leaving a black, stale viewport.

      fitAddon.fit();
      requestAnimationFrame(() => {
        fitAddon.fit();
        terminal.scrollToBottom();
      });

      terminalRef.current = terminal;
      fitAddonRef.current = fitAddon;

      // S2 fix: auto-follow PTY output when user is at-bottom OR actively
      // focused on this terminal. Preserves manual scrollback (user can
      // scroll up to read past output without being yanked back) but
      // ensures the live prompt is always visible in the steady state.
      // The 2-row dead zone tolerates cosmetic TUI redraw jitter without
      // weakening genuine scroll-up intent. Defined here (not later) so
      // it's in scope for the early write sites at L142, L162, L205.
      const writeWithFollowBottom = (payload: string) => {
        const buf = terminal.buffer.active;
        const shouldFollow =
          buf.baseY - buf.viewportY <= 2 ||
          document.activeElement === terminal.textarea;
        terminal.write(payload, () => {
          if (disposed.current) return;
          if (shouldFollow) terminal.scrollToBottom();
        });
      };

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
        agentLabel: tool.label,
        onFlush: (_label, _text) => {
          if (collabSessionId) {
            // Only scan for task completion signals — do NOT log raw PTY output
            // to the conversation file. Only task reports belong there.
            scanForTaskCompletions(collabSessionId);
          }
        },
      });
      captureRef.current = capture;
      registerCapture(sessionId, capture);

      // Listen for PTY output
      unlistenDataRef.current = await listen<string>(
        `pty-data-${sessionId}`,
        (event) => {
          if (!disposed.current) {
            writeWithFollowBottom(event.payload);
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

      // Listen for PTY exit. Logic is delegated to `handlePtyExit` (above)
      // so it can be unit-tested without xterm/PTY plumbing. Tauri's
      // listen() accepts async callbacks and does not block event dispatch
      // on the returned promise — no back-pressure.
      unlistenExitRef.current = await listen(
        `pty-exit-${sessionId}`,
        () => {
          void handlePtyExit({
            disposed: disposed.current,
            capture: captureRef.current,
            writeProcessExitedLine: () =>
              writeWithFollowBottom("\r\n\x1b[33m[Process exited]\x1b[0m\r\n"),
            collabSessionId,
            sessionId,
          });
        },
      );

      if (disposed.current) {
        unlistenDataRef.current?.();
        unlistenExitRef.current?.();
        observer.disconnect();
        terminal.dispose();
        return;
      }

      // Spawn the CLI tool — try direct process first, fall back to shell.
      //
      // **A3 — worktree-backed agent mode** (Phase 4.5/5 production
      // wiring per claude2/codex2/codex3 convergence): when localStorage
      // flag `worktree-mode-enabled` is `"true"` AND the cwd is set
      // (worktree provisioning needs a repo root), we route through
      // provision_worktree → start_worktree_agent. The supervisor then
      // owns the lease lifecycle (heartbeat, monitor, force_close) and
      // the existing PTY IPC commands (write_to_pty / resize_pty /
      // kill_pty) keep working unchanged because start_worktree_agent
      // wires the master/writer/reader into AppState::sessions.
      const [program, ...programArgs] = tool.command.split(/\s+/);
      let spawnedViaShell = false;
      const worktreeEnabled =
        cwd != null &&
        typeof window !== "undefined" &&
        window.localStorage?.getItem("worktree-mode-enabled") === "true";

      // **F3 fix per codex1/codex2/codex3 P0 convergence**: when
      // worktree mode is enabled, fail CLOSED on any boot error.
      // Falling back to legacy spawn_process after `provision_worktree`
      // succeeded (but `start_worktree_agent` failed) would (a) leak
      // the provisioned worktree+lease+lock state and (b) run an
      // UNSUPERVISED agent in the original repo — exactly the
      // isolation breach worktree mode is designed to prevent.
      //
      // Recovery: if provisioning succeeded, call force_close_worktree
      // to clean up the orphaned lease before bailing out.
      if (worktreeEnabled) {
        let provisionedAgentId: string | null = null;
        try {
          const provisioned = (await invoke("provision_worktree", {
            request: {
              session_id: sessionId,
              task_id: `agent-${sessionId}`,
              repo_root: cwd,
              parent_agent_id: null,
              base_ref: null,
              heartbeat_timeout_secs: null,
            },
          })) as { agent_id: string; worktree_path: string };
          provisionedAgentId = provisioned.agent_id;
          worktreeAgentIdRef.current = provisioned.agent_id;
          await invoke("start_worktree_agent", {
            request: {
              agent_id: provisioned.agent_id,
              session_id: sessionId,
              program,
              args: programArgs.length > 0 ? programArgs : null,
              cols: terminal.cols,
              rows: terminal.rows,
              env: null,
            },
          });
        } catch (e) {
          // Cleanup any orphaned provisioned lease before surfacing
          // the error. Backend's force_close_worktree is idempotent
          // and tolerates "no live supervisor" (drainer-only path).
          if (provisionedAgentId) {
            try {
              await invoke("force_close_worktree", { agentId: provisionedAgentId });
            } catch (cleanupErr) {
              console.warn(
                "force_close_worktree cleanup after boot failure also failed:",
                cleanupErr,
              );
            }
            worktreeAgentIdRef.current = null;
          }
          if (!disposed.current) {
            writeWithFollowBottom(
              `\r\n\x1b[31m[Worktree-mode boot failed: ${String(
                e,
              )}]\x1b[0m\r\n` +
                `\r\n\x1b[33m[Worktree mode is fail-closed — disable ` +
                `localStorage["worktree-mode-enabled"] to spawn directly.]\x1b[0m\r\n`,
            );
          }
          return;
        }
      } else {
        try {
          await invoke("spawn_process", {
            sessionId,
            program,
            args: programArgs.length > 0 ? programArgs : null,
            extraEnv: null,
            cwd: cwd ?? null,
            cols: terminal.cols,
            rows: terminal.rows,
          });
        } catch {
          // Fallback: spawn shell then type the command
          spawnedViaShell = true;
          try {
            await invoke("spawn_shell", {
              sessionId,
              cols: terminal.cols,
              rows: terminal.rows,
              cwd: cwd ?? null,
              login: !isEnvBootstrapped(),
            });
          } catch (shellErr) {
            if (!disposed.current) {
              writeWithFollowBottom(
                `\r\n\x1b[31m[Failed to start: ${shellErr}]\x1b[0m\r\n`,
              );
            }
            return;
          }
        }
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
        // S2 fix: user typing is explicit "I want to see the prompt" intent.
        // Always snap to bottom on input — prevents the case where the user
        // started typing while scrolled up and didn't realize their input
        // was happening at the live prompt below the visible viewport.
        terminal.scrollToBottom();
      });

      // Track focus state for visual indicator. Focus also snaps to bottom
      // (compensating for the preventScroll: true override at L471 above
      // which suppresses the browser's natural scroll-caret-into-view).
      // Do it on the next animation frame so xterm has settled, and guard
      // disposal so a refocus that races a unmount doesn't throw.
      terminal.textarea?.addEventListener("focus", () => {
        setFocused(true);
        requestAnimationFrame(() => {
          if (!disposed.current && document.activeElement === terminal.textarea) {
            terminal.scrollToBottom();
          }
        });
      });
      terminal.textarea?.addEventListener("blur", () => setFocused(false));

      // If we fell back to shell spawn, type the CLI tool command into the shell
      if (spawnedViaShell) {
        try {
          await invoke("write_to_pty", {
            sessionId,
            data: tool.command + "\n",
          });
        } catch {
          // Shell may have exited already
        }
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
        /✦\s*$/,      // Gemini CLI prompt
        />>>\s*$/,     // Gemini CLI alternate prompt
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
      }, 5000); // 5s fallback — if CLI doesn't show a recognizable prompt

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
            writeWithFollowBottom(event.payload);
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
    };

    initTerminal();

    return () => {
      if (readyTimeoutRef.current) {
        clearTimeout(readyTimeoutRef.current);
        readyTimeoutRef.current = null;
      }
      disposed.current = true;
      // Flush remaining output and clean up capture
      captureRef.current?.flush();
      captureRef.current?.dispose();
      captureRef.current = null;
      unregisterCapture(sessionId);
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

      // **F2 fix per codex1/codex2/codex3 P0 convergence + K2 fix per
      // codex1 B2 (rev-6 verification)**: for worktree-backed sessions,
      // kill_pty does NOT terminate the agent — SupervisorChildShim::kill
      // is a no-op. The real PG is owned by the Supervisor, so user-close
      // MUST go through force_close_worktree.
      //
      // K2: previously we always tore down the UI even if force_close
      // failed. The backend intentionally keeps the supervisor registered
      // for retry on kill failure, but the user got no failure surface.
      // Now we surface the error on the terminal so the user can see
      // it and decide whether to forcibly remove the session anyway
      // (close X again with the chip showing the failure).
      if (worktreeAgentIdRef.current) {
        const agentId = worktreeAgentIdRef.current;
        worktreeAgentIdRef.current = null;
        invoke("force_close_worktree", { agentId })
          .then(() => {
            // Successful supervised close — proceed with normal teardown
            invoke("kill_pty", { sessionId }).catch(() => {});
            useCollaboratorStore.getState().removeAgent(sessionId);
          })
          .catch((err) => {
            // K2: surface the failure. Restore the agent_id ref so a
            // retry close (user clicks X again) tries again with the
            // supervisor still registered.
            worktreeAgentIdRef.current = agentId;
            console.warn("force_close_worktree failed on close:", err);
            // Write to terminal via the ref (writeWithFollowBottom is
            // closure-scoped to initTerminal; from cleanup we touch
            // the terminal directly).
            try {
              const term = terminalRef.current;
              if (term && !disposed.current) {
                term.write(
                  `\r\n\x1b[31m[Close failed: ${String(err)}]\x1b[0m\r\n` +
                    `\x1b[33m[Click X again to retry, or use the half-state ` +
                    `chip's discard action to forcibly remove.]\x1b[0m\r\n`,
                );
              }
            } catch {
              // term.write may throw if terminal disposed mid-call;
              // intentionally swallow — the console.warn above is the
              // signal of last resort.
            }
            // Don't tear down the UI — leave the agent visible so the
            // user can retry or use discard_artifact from the chip.
          });
      } else {
        invoke("kill_pty", { sessionId }).catch(() => {});
        useCollaboratorStore.getState().removeAgent(sessionId);
      }

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
    // cwd intentionally excluded — it may update asynchronously after mount
    // (Step 3: non-blocking CWD). Including it would destroy and recreate the
    // terminal when CWD resolves. The initial cwd value at mount time is sufficient.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, tool.command, collabSessionId]);

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
  const displayName = agent ? agentDisplayName(agent) : tool.label;
  const isExited = agent?.status === "exited";
  const isSpawning = agent?.status === "spawning";
  // Pre-registration window: the component mounts and starts spawning the
  // PTY before `addAgent({ status: "spawning" })` runs. Treat the missing
  // agent record as "starting…" so the header doesn't briefly read "idle".
  const isPreRegistration = !agent;

  // Subscribe to the slices that drive the in-frame state indicator, scoped
  // to this collab session so an outcome change in *another* session does
  // not re-render this component.
  const tasksForSession = useCollaboratorStore((s) =>
    collabSessionId ? s.tasksBySession[collabSessionId] ?? null : null,
  );
  const sessionOutcomes = useCollaboratorStore((s) =>
    collabSessionId ? s.recentOutcomesBySession[collabSessionId] ?? null : null,
  );
  // Wrap in a single-key map so we can keep using getAgentTaskState's
  // existing signature without contorting it.
  const outcomesProxy = collabSessionId && sessionOutcomes
    ? { [collabSessionId]: sessionOutcomes }
    : {};
  const taskState =
    agent && collabSessionId
      ? getAgentTaskState(collabSessionId, agent.handle, tasksForSession ?? [], outcomesProxy)
      : { kind: "idle" as const };

  // Resolve indicator visuals + ARIA attributes via the pure helper. The
  // mapping (lifecycle × task state → color/label/aria) is unit-tested in
  // collaboratorStore.test.ts so changes go through a typed isolated function
  // instead of an inline IIFE that's only verifiable by rendering the full
  // xterm-bound component.
  // Use the imported `AgentLifecycle` type so adding a 5th lifecycle to
  // the canonical type errors out here instead of silently coercing to
  // "running" via the ternary fallthrough.
  const lifecycle: AgentLifecycle =
    isExited ? "exited"
    : isSpawning ? "spawning"
    : isPreRegistration ? "pre-registration"
    : "running";
  const indicator = getIndicatorPresentation(lifecycle, taskState);

  return (
    <div className={`flex flex-col h-full min-h-0 border rounded-md overflow-hidden ${focused ? "border-accent" : "border-surface-lighter"}`}>
      {/* Agent header */}
      <div className="flex items-center gap-2 px-2 py-1 bg-surface-light border-b border-surface-lighter text-xs shrink-0">
        {/* Status light — `ping` halo flags a fresh outcome (completed/blocked).
            Static `ring` keeps the highlight visible even when reduced-motion
            disables the halo animation. */}
        <span className="relative inline-flex w-2 h-2 shrink-0" aria-hidden="true" title={indicator.label}>
          {indicator.ping && (
            <span className={`absolute inline-flex w-full h-full rounded-full opacity-70 motion-safe:animate-ping ${indicator.color}`} />
          )}
          <span
            className={`relative inline-flex w-2 h-2 rounded-full ${indicator.color} ring-2 ${indicator.ringColor} ${indicator.pulse ? "motion-safe:animate-pulse" : ""}`}
          />
        </span>
        {editing ? (
          <input
            ref={renameInputRef}
            type="text"
            value={draft}
            maxLength={32}
            autoFocus
            spellCheck={false}
            className={`font-bold ${tool.colorClass} bg-surface border border-accent/40 rounded px-1 py-0 text-xs outline-none focus:border-accent w-32 sm:w-44 shrink-0`}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                if (!collabSessionId) return;
                const result = useCollaboratorStore.getState().renameAgent(sessionId, draft);
                if (result.ok) {
                  setEditing(false);
                } else {
                  // Enter on invalid: KEEP the input open so the user can
                  // correct without losing their typed value. Surface the
                  // store's human message via the footer status slot.
                  // (Phase 5 spec: Enter is a deliberate commit gesture.)
                  useCollaboratorStore.getState().setStatus(result.message, collabSessionId, "persistent");
                }
              } else if (e.key === "Escape") {
                e.preventDefault();
                setEditing(false);
              }
            }}
            onBlur={() => {
              if (!collabSessionId) {
                setEditing(false);
                return;
              }
              const result = useCollaboratorStore.getState().renameAgent(sessionId, draft);
              if (!result.ok) {
                // Blur on invalid: REVERT silently so an accidental focus
                // shift doesn't leave the input in a bad state. Surface the
                // reason so the user knows why their pending edit didn't
                // commit. (Phase 5 spec: blur is often accidental.)
                useCollaboratorStore.getState().setStatus(result.message, collabSessionId, "persistent");
              }
              setEditing(false);
            }}
          />
        ) : (
          <span
            className={`font-bold ${tool.colorClass} truncate shrink-0 cursor-text select-none`}
            title="Double-click to rename"
            onDoubleClick={(e) => {
              e.preventDefault();
              setDraft(displayName);
              setEditing(true);
              requestAnimationFrame(() => renameInputRef.current?.select());
            }}
          >
            {displayName}
          </span>
        )}
        <span
          role={indicator.liveRole}
          aria-live={indicator.liveLevel}
          aria-atomic="true"
          className={`flex-1 min-w-0 truncate text-[11px] ${indicator.tone}`}
          title={indicator.label}
        >
          {indicator.label}
        </span>
        {/* E20+E23 — half-state chip with retry/discard for worktree
            leases that landed in PreserveFailed or GcError. */}
        {leaseSnapshot &&
          (leaseSnapshot.state_kind === "preserve_failed" ||
            leaseSnapshot.state_kind === "gc_error") && (
            <WorktreeHalfStateChip
              snapshot={leaseSnapshot}
              agentId={worktreeAgentIdRef.current ?? ""}
              onChange={() => {
                // Trigger immediate re-poll after retry/discard so the
                // chip reflects the new state without waiting for the
                // 2-second tick.
                if (worktreeAgentIdRef.current) {
                  invoke("query_agent_lease", {
                    agentId: worktreeAgentIdRef.current,
                  })
                    .then((snap) => setLeaseSnapshot((snap as typeof leaseSnapshot) ?? null))
                    .catch(() => {});
                }
              }}
            />
          )}
        <button
          className="text-text-dim hover:text-red-400 transition-colors p-0.5 shrink-0"
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

/// E20+E23 — compact half-state chip rendered in the agent header
/// when the worktree lease is in PreserveFailed or GcError.
/// Surfaces the reason (truncated) and offers Retry / Discard buttons.
function WorktreeHalfStateChip({
  snapshot,
  agentId,
  onChange,
}: {
  snapshot: { state_kind: string; state_reason: string | null; gc_retries: number | null };
  agentId: string;
  onChange: () => void;
}) {
  const isPreserveFailed = snapshot.state_kind === "preserve_failed";
  const tone = isPreserveFailed
    ? "bg-amber-900/40 text-amber-300 border-amber-700/40"
    : "bg-rose-900/40 text-rose-300 border-rose-700/40";
  const label = isPreserveFailed
    ? "preserve failed"
    : `gc error${snapshot.gc_retries != null ? ` (×${snapshot.gc_retries})` : ""}`;

  const handleRetry = () => {
    if (!agentId) return;
    invoke("retry_preserve", { agentId })
      .then(onChange)
      .catch((e) => console.warn("retry_preserve failed:", e));
  };
  const handleDiscard = () => {
    if (!agentId) return;
    if (
      typeof window !== "undefined" &&
      !window.confirm(
        "Discard preserved artifact? This is irreversible — the quarantine snapshot will be deleted.",
      )
    ) {
      return;
    }
    invoke("discard_artifact", { agentId })
      .then(onChange)
      .catch((e) => console.warn("discard_artifact failed:", e));
  };

  return (
    <span
      className={`inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] border rounded ${tone}`}
      title={snapshot.state_reason ?? label}
    >
      <span className="font-medium">{label}</span>
      <button
        className="hover:underline focus:underline"
        onClick={handleRetry}
        title="Retry preservation"
      >
        retry
      </button>
      <span aria-hidden>·</span>
      <button
        className="hover:underline focus:underline"
        onClick={handleDiscard}
        title="Discard artifact (irreversible)"
      >
        discard
      </button>
    </span>
  );
}
