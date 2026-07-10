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
import {
  attachKoreanImeShim,
  type KoreanImeShimHandle,
} from "../../lib/xtermImeShim";
import type { ToolConfig } from "../../types/collaborator";
import { supportsPeerContextPublishing } from "../../types/collaborator";
import {
  recoveryOrchestrator,
  signalAdoptionReady,
} from "../../lib/resilience/RecoveryOrchestrator";
import {
  consumeReservation,
  releaseReservation,
  reserveAgentHandle,
} from "../../lib/peerContext";
import {
  ENV_AGENT_ID,
  ENV_COLLAB_SESSION_ID,
} from "../../types/peerContext";
import { Eye, EyeOff, X } from "lucide-react";

// Defense-in-depth floor for FitAddon-driven PTY resizes. The
// load-bearing fix is the CSS column floor in CollaboratorPane.tsx
// (MIN_AGENT_TILE_WIDTH_PX), which guarantees fitAddon.proposeDimensions
// never sees a degenerate container. These constants guard the
// helper used at all four fit() sites below, so a caller that renders
// the terminal outside the collaborator grid (tests, future layouts)
// still can't drive cols≈2 redraws into the child CLI.
export const MIN_TERMINAL_COLS = 20;
export const MIN_TERMINAL_ROWS = 6;

/**
 * Pure decision: is it safe to call FitAddon.fit() given the
 * dimensions FitAddon would propose? Returns false (= skip the fit)
 * when:
 *   - proposed is undefined (FitAddon returns undefined when its
 *     parentElement is missing or has zero cell-width)
 *   - cols/rows are missing, non-finite (NaN/Infinity), or non-positive
 *   - cols or rows fall below the supplied floor
 *
 * The plain-object shape (rather than a FitAddon instance) keeps this
 * helper trivially unit-testable without xterm/jsdom mocking.
 */
export function shouldFitMiniTerminal(
  proposed: { cols?: number; rows?: number } | undefined,
  floors: { minCols: number; minRows: number } = {
    minCols: MIN_TERMINAL_COLS,
    minRows: MIN_TERMINAL_ROWS,
  },
): boolean {
  if (!proposed) return false;
  const { cols, rows } = proposed;
  if (
    typeof cols !== "number" ||
    !Number.isFinite(cols) ||
    cols <= 0 ||
    typeof rows !== "number" ||
    !Number.isFinite(rows) ||
    rows <= 0
  ) {
    return false;
  }
  return cols >= floors.minCols && rows >= floors.minRows;
}

interface AgentMiniTerminalProps {
  sessionId: string;
  tool: ToolConfig;
  cwd: string | null;
  onClose: (sessionId: string) => void;
  /**
   * Recovery adopt mode (webcontent-death-recovery node 18): the Rust PTY
   * for `sessionId` SURVIVED a webview reload and the store row was already
   * restored verbatim (`restoreAgents`). The mount must therefore skip
   * `reserveAgentHandle` / `spawn_process` / `spawn_shell` / `addAgent`
   * entirely — it only rebuilds the xterm surface, re-subscribes the
   * pty-data/pty-exit listeners, and signals the adoption-readiness barrier
   * so `resumeAfterReload` can flush the replay ring into a live listener.
   */
  adopt?: boolean;
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
  adopt = false,
}: AgentMiniTerminalProps) {
  const collabSessionId = useCollabSessionId();
  const termRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const unlistenDataRef = useRef<UnlistenFn | null>(null);
  const unlistenExitRef = useRef<UnlistenFn | null>(null);
  const observerRef = useRef<ResizeObserver | null>(null);
  // Sole IME lifecycle owner. Replaces the prior 4 refs
  // (imeHandlersRef/docKeyDownRef/docInputRef/imeOverlayRef) — see
  // src/lib/xtermImeShim.ts. The handle's dispose() is invoked by the
  // unmount path; do NOT add parallel manual cleanup.
  const imeHandleRef = useRef<KoreanImeShimHandle | null>(null);
  const captureRef = useRef<ReturnType<typeof createOutputCapture> | null>(null);
  const readyTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Holds the u64 token returned by `invoke('watch_transcript')` so the
  // matching `invoke('unwatch_transcript')` can release it on unmount or
  // when publishOptedIn flips false. null = no active watch.
  const watchTokenRef = useRef<number | null>(null);
  const disposed = useRef(false);
  // Monotonic per-effect-run counter. Each useEffect entry bumps this and
  // captures the new value in a closure-local `runId`; async paths inside
  // that effect verify `initRunRef.current === runId` (via `isCurrentRun()`)
  // before touching shared state. Defeats the React.StrictMode double-mount
  // race that, without this guard, lets Mount #1's stale async closures
  // run their post-await side effects (notably `addAgent`) AFTER Mount #2
  // has reset `disposed.current = false` for its own run — producing
  // duplicate SpawnedAgent records under the same `sessionId`. Restores
  // the pattern collaterally removed by 69ca18b ("Revert worktree feature").
  const initRunRef = useRef(0);
  const [focused, setFocused] = useState(false);
  // Inline-rename state for the header label. `editing === false` shows the
  // <span>; `editing === true` shows an <input value={draft}>. The store action
  // owns validation and human messages — we only thread RenameResult.message
  // back to setStatus on failure. (codex1+codex2 round-3-onwards.)
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const renameInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    // Bump-and-capture the per-run id BEFORE resetting `disposed.current`.
    // Order matters: if cleanup #1 fires before this effect run starts,
    // Mount #1's closures (captured against the prior runId) see the bumped
    // value and bail; the disposed-flag reset below only affects new closures.
    const runId = ++initRunRef.current;
    disposed.current = false;
    const isCurrentRun = () => !disposed.current && initRunRef.current === runId;

    // Effect-local state for the redraw-artifact refresh interval (see the
    // setInterval block deeper in initTerminal for rationale). These MUST
    // be plain let-bindings — calling React hooks (useRef/useState) inside
    // this effect would be an invalid hooks-in-effect pattern. Both the
    // initTerminal closure and the cleanup return at the bottom of this
    // effect capture them by reference.
    let lastPtyDataAt = 0;
    let refreshInterval: ReturnType<typeof setInterval> | null = null;
    // Visibility-restore observer state (see the IntersectionObserver
    // block deeper in initTerminal). Same idiom as the bindings above —
    // captured by the IO callback closure and the cleanup return.
    let wasIntersecting = true;
    let visibilityObserver: IntersectionObserver | null = null;

    const initTerminal = async () => {
      if (!termRef.current || terminalRef.current) return;

      const { fontSize, themeName } = useTerminalStore.getState();
      const theme = terminalThemes[themeName] ?? terminalThemes.catppuccin;

      const terminal = new Terminal({
        theme,
        fontFamily:
          "'JetBrainsMono Nerd Font Mono', 'Noto Sans Mono CJK KR', 'D2Coding', 'JetBrains Mono', Menlo, monospace",
        fontSize: Math.max(fontSize - 2, 9),
        // Match the main terminal's lineHeight (terminalManager.ts:187).
        // The previous 1.15 was tuned for vertical compactness in small panes
        // but left zero air between rows, so html2canvas screenshots showed
        // glyph descenders bleeding into the next row whenever the cloned
        // DOM lost xterm's runtime row-clip stylesheet. 1.2 matches the
        // main terminal and the +0.05 is not visually perceptible.
        lineHeight: 1.2,
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

      // Guarded fit: propose first, only call fit() when the proposed
      // dimensions clear MIN_TERMINAL_COLS/ROWS. Skipping leaves
      // xterm's default 80×24 in place, which spawn IPC (L329/L338)
      // will carry to the PTY — safe even if the pane mounts at a
      // pathologically narrow size during initial layout. Returns
      // whether the fit actually ran so callers can gate follow-up
      // side effects (e.g. scrollToBottom).
      const safeFit = (): boolean => {
        const proposed = fitAddon.proposeDimensions();
        if (!shouldFitMiniTerminal(proposed)) return false;
        fitAddon.fit();
        return true;
      };

      safeFit();
      requestAnimationFrame(() => {
        if (safeFit()) terminal.scrollToBottom();
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
        // textarea-rewrite v3.4: focus owner is the shadow textarea
        // managed by attachKoreanImeShim, not xterm's helper. Use
        // `imeHandleRef.current?.isFocused()` as the source of truth.
        const shouldFollow =
          buf.baseY - buf.viewportY <= 2 ||
          (imeHandleRef.current?.isFocused() ?? false);
        terminal.write(payload, () => {
          if (!isCurrentRun()) return;
          if (shouldFollow) terminal.scrollToBottom();
        });
      };

      if (!isCurrentRun()) {
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
          // Only auto-scroll if the fit actually ran — a skipped fit
          // leaves the buffer untouched and forcing scrollToBottom
          // would yank the user out of any manual scrollback.
          if (safeFit() && wasAtBottom) terminal.scrollToBottom();
        }
      });
      if (termRef.current) observer.observe(termRef.current);
      observerRef.current = observer;

      // Visibility-restore IntersectionObserver. Complements the 500 ms
      // refresh interval below for the cross-tab-switch case: when a
      // CollaboratorPane lives inside an inactive terminal tab, the host
      // hides it with `display: none` (TerminalTabs.tsx). That propagates
      // through to this tile, xterm's internal RenderService pauses via
      // its own IntersectionObserver (RenderService.ts:106-144) and only
      // remembers `_needsFullRefresh`; the 500 ms interval here is also
      // a no-op while hidden (offsetWidth/Height guards). On restore,
      // RenderService schedules a refresh, but a per-tile ResizeObserver
      // tick can race ahead and call safeFit() — `terminal.resize()`
      // changes row count and a stale frame from the prior size shows
      // for a beat, producing the "text line collision" symptom users
      // reported with ≥5 agents across ≥2 panes.
      //
      // The mitigation here is a one-shot on the hidden→visible
      // transition: bump `lastPtyDataAt` so the 500 ms interval pulses
      // through the post-restore settle window, then on the next
      // animation frame re-fit and force-refresh the full viewport
      // AFTER the resize has settled. The rAF gate is load-bearing —
      // running safeFit + refresh synchronously inside the IO callback
      // misses the layout tick that the IO entry itself just announced.
      visibilityObserver = new IntersectionObserver(
        (entries) => {
          if (!isCurrentRun()) return;
          const entry = entries[entries.length - 1];
          if (!entry) return;
          const nowVisible = entry.isIntersecting;
          if (!wasIntersecting && nowVisible) {
            // Feed the recency gate on the 500 ms interval so it pulses
            // through the settle window even if the agent is idle.
            lastPtyDataAt = Date.now();
            requestAnimationFrame(() => {
              if (!isCurrentRun()) return;
              const el = termRef.current;
              if (!el?.isConnected) return;
              if (el.offsetWidth <= 0 || el.offsetHeight <= 0) return;
              // safeFit() picks up any size delta accumulated while
              // hidden; the refresh discards the stale canvas frame
              // that the renderer painted at the prior row count.
              safeFit();
              if (terminal.rows > 0) {
                terminal.refresh(0, terminal.rows - 1);
              }
              // Two-step PTY size toggle to force a SIGWINCH at the
              // child TUI (Claude/Codex). Background — both prior
              // fixes (mini-terminal-redraw-interval 740c327 and
              // visibility-restore 6a2dc2a) only repaint the xterm
              // canvas; neither informs the child PTY process that
              // anything changed. The user-reported symptom ("text
              // line collision on every pane switch — slight manual
              // resize clears it") is a buffer/cursor mismatch that
              // only the child TUI's own redraw can reconcile. The
              // manual resize works precisely because it changes
              // cols/rows → terminal.onResize fires → resize_pty IPC
              // → ioctl(TIOCSWINSZ) on the PTY master → kernel emits
              // SIGWINCH → TUI redraws from scratch.
              //
              // safeFit() above is a no-op on terminal.onResize when
              // proposed dims equal current dims, which is the
              // common case on a pure tab switch (no layout change).
              // And the Linux/macOS kernel SUPPRESSES SIGWINCH when
              // TIOCSWINSZ is called with the same winsize as the
              // current one (Linux: tty_do_resize gates on memcmp;
              // BSD: same delta check). So a single same-dim
              // invoke("resize_pty", ...) is a no-op end-to-end.
              //
              // The two-step (rows+1) then (rows) toggle forces two
              // real winsize deltas back-to-back; the kernel emits
              // SIGWINCH on each, the TUI sees them and redraws.
              // Promise-chained so the Rust handler executes them in
              // order; void+catch swallows the IPC errors that occur
              // if the session was removed mid-toggle. The captured
              // const dims defend against a race with the existing
              // 80 ms terminal.onResize debounced resize_pty (which
              // would run AFTER our toggle and re-issue resize_pty
              // with the same dims — a kernel-level no-op, harmless).
              //
              // See task-14-investigation-claude1.md in the collab
              // memory for the full root-cause derivation.
              const currentCols = terminal.cols;
              const currentRows = terminal.rows;
              if (currentCols > 0 && currentRows > 0) {
                void invoke("resize_pty", {
                  sessionId,
                  cols: currentCols,
                  rows: currentRows + 1,
                })
                  .then(() =>
                    invoke("resize_pty", {
                      sessionId,
                      cols: currentCols,
                      rows: currentRows,
                    }),
                  )
                  .catch(() => {});
              }
            });
          }
          wasIntersecting = nowVisible;
        },
        { threshold: 0 },
      );
      if (termRef.current) visibilityObserver.observe(termRef.current);

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
          if (isCurrentRun()) {
            writeWithFollowBottom(event.payload);
            capture.feed(event.payload);
          }
        },
      );

      if (!isCurrentRun()) {
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
            // Use !isCurrentRun() so Mount #1's stale pty-exit listener bails
            // when it fires after Mount #2 has reset disposed.current = false.
            disposed: !isCurrentRun(),
            capture: captureRef.current,
            writeProcessExitedLine: () =>
              writeWithFollowBottom("\r\n\x1b[33m[Process exited]\x1b[0m\r\n"),
            collabSessionId,
            sessionId,
          });
        },
      );

      if (!isCurrentRun()) {
        unlistenDataRef.current?.();
        unlistenExitRef.current?.();
        observer.disconnect();
        terminal.dispose();
        return;
      }

      // Spawn the CLI tool — try direct process first, fall back to shell.
      //
      // peer-context-mirror reservation lifecycle (L5+L6+L7+L8):
      // 1. BEFORE the spawn IPC, reserveAgentHandle mints the bare CT
      //    handle (e.g. "claude3") via collaboratorStore.nextOrdinal.
      //    The same counter addAgent would use, so the post-spawn
      //    record's ordinal/handle line up with the pre-spawn env.
      // 2. The reserved handle is passed into the spawn IPC via
      //    extra_env as CT_AGENT_ID + CT_COLLAB_SESSION_ID. Both
      //    spawn_process and spawn_shell accept the parameter
      //    (cycle A wired spawn_shell's body).
      // 3. On spawn success: consumeReservation returns the reserved
      //    data, and addAgent gets the pre-minted handle so it skips
      //    its own nextOrdinal mint.
      // 4. On spawn failure: releaseReservation rolls back the
      //    registry entry so the slot can be reused.
      const [program, ...programArgs] = tool.command.split(/\s+/);
      let spawnedViaShell = false;

      // L5: pre-spawn reservation. Synchronous — throws on unknown
      // collabSessionId, which the outer initTerminal's React error
      // boundary would catch; in practice collabSessionId always
      // resolves from CollabSessionContext.
      //
      // Recovery adopt mode skips the entire reservation+spawn pipeline:
      // the PTY already exists in Rust and the identity row was restored
      // verbatim — re-reserving would burn an ordinal, re-spawning would
      // replace the survivor this feature exists to preserve.
      let reservation: ReturnType<typeof reserveAgentHandle> | null = null;
      if (!adopt) {
        try {
          reservation = reserveAgentHandle(collabSessionId, tool.id);
        } catch (reserveErr) {
          if (isCurrentRun()) {
            writeWithFollowBottom(
              `\r\n\x1b[31m[Failed to reserve handle: ${reserveErr}]\x1b[0m\r\n`,
            );
          }
          return;
        }

        // L6: build extraEnv from the reservation. Using imported
        // constants (not literal strings) so the keys stay aligned with
        // the Rust adapter's expectations.
        const extraEnv: Record<string, string> = {
          [ENV_AGENT_ID]: reservation.handle,
          [ENV_COLLAB_SESSION_ID]: collabSessionId,
        };

        try {
          await invoke("spawn_process", {
            sessionId,
            program,
            args: programArgs.length > 0 ? programArgs : null,
            extraEnv,
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
              extraEnv,
            });
          } catch (shellErr) {
            // L8: release reservation on spawn failure so the ordinal
            // slot can be reused. Idempotent; safe to fire on either
            // catch path.
            releaseReservation(reservation.reservationId);
            if (isCurrentRun()) {
              writeWithFollowBottom(
                `\r\n\x1b[31m[Failed to start: ${shellErr}]\x1b[0m\r\n`,
              );
            }
            return;
          }
        }

        if (!isCurrentRun()) {
          // StrictMode dispose between spawn-success and post-spawn
          // setup: release the reservation so the next mount's fresh
          // reserveAgentHandle doesn't see a leaked slot.
          releaseReservation(reservation.reservationId);
          return;
        }
      }

      // Let app-level shortcuts bubble past xterm
      terminal.attachCustomKeyEventHandler((e) => {
        // textarea-rewrite v3.4: composition events fire on the shadow
        // textarea (not the helper), so xterm's `_handleKey` never runs
        // for IME keystrokes. Keeping the guard is harmless and defends
        // against any future xterm path that synchronously dispatches
        // an IME-marked keydown.
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


      // Korean IME shim (textarea-rewrite v3.4) — shadow textarea owns
      // composition events. The `onComposedFlush` subscription closes
      // the parity gap with ASCII input: `terminal.onData` (below)
      // snaps the viewport on every keystroke, but Korean compositions
      // take a direct PTY write path that bypasses it — so the helper
      // notifies us per-flush and we mirror the scroll behavior here.
      //
      // `shouldBubbleShortcut` mirrors the bubble decisions in
      // `attachCustomKeyEventHandler` above so app-level shortcuts
      // (Cmd+T, Cmd+W, etc.) continue to bubble past the shadow
      // textarea unchanged.
      imeHandleRef.current = attachKoreanImeShim(terminal, termRef.current!, {
        sessionId,
        webgl: false,
        defaultFontSize: 10,
        onComposedFlush: () => {
          terminal.scrollToBottom();
        },
        shouldBubbleShortcut: (e) => {
          // Round-1 fold (convergent MED from @claude3 / @codex2): case-
          // fold single-char keys before set lookup. Under Shift, e.key
          // flips to uppercase (Cmd+Shift+S → e.key === "S"), which the
          // lowercase-only list would miss. useKeyboardShortcuts.ts
          // documents this case explicitly (case "S" branch).
          const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
          if (
            (e.metaKey || e.ctrlKey) &&
            ["t","w","f","d","e","z","s","o","=","-","0","1","2","3","4","5","6","7","8","9","Enter"].includes(k)
          ) {
            return true;
          }
          if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === "[" || e.key === "]")) {
            return true;
          }
          return false;
        },
      });

      // Forward user keystrokes to PTY
      terminal.onData((data) => {
        if (!isCurrentRun()) return;
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
      // textarea-rewrite v3.4: focus events on `terminal.textarea` are
      // synthesized by the shim's `mirrorFocusState` from the shadow's
      // actual focus/blur, so the visual focus border + scroll snap
      // continue to fire. The post-focus `requestAnimationFrame`
      // guard uses `imeHandleRef.current?.isFocused()` instead of
      // `document.activeElement === terminal.textarea` because focus
      // now lives on the shadow textarea, not the helper.
      terminal.textarea?.addEventListener("focus", () => {
        setFocused(true);
        requestAnimationFrame(() => {
          if (isCurrentRun() && (imeHandleRef.current?.isFocused() ?? false)) {
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

      if (adopt) {
        // Recovery adopt mode: the store row exists (restoreAgents seeded it
        // verbatim — handle/nickname/nameHistory preserved), the PTY exists
        // in Rust, and the pty-data listener above is live. Signal the
        // adoption-readiness barrier so resumeAfterReload can release the
        // ring replay into this now-listening terminal. Idempotent under
        // StrictMode double-mount (the barrier tracks a Set).
        signalAdoptionReady(sessionId);
      } else {
      // Register in store as "spawning" — not ready for messages yet.
      // The readiness detector below will set status to "running" and flush
      // any queued messages once the CLI tool's prompt appears.
      //
      // CRITICAL guard: only the current effect-run may push the agent
      // record. Without this check, Mount #1's stale async closure (still
      // mid-await on its spawn IPC when StrictMode unmounts) reaches this
      // line AFTER Mount #2 has reset disposed.current = false, and both
      // mounts' addAgent calls land — producing two SpawnedAgent records
      // with the same sessionId. The 69ca18b revert collaterally removed
      // this guard; this is its restoration.
      if (!isCurrentRun()) {
        // Same StrictMode-dispose-mid-flight case as the spawn-success
        // guard above: release the reservation so the next mount's
        // fresh reserveAgentHandle doesn't see a leaked slot.
        if (reservation) releaseReservation(reservation.reservationId);
        return;
      }
      // L7: consume the reservation (returns reserved handle data) and
      // pass the pre-minted handle into addAgent so the store record's
      // handle matches the env-injected CT_AGENT_ID.
      const claimed = consumeReservation(reservation!.reservationId);
      useCollaboratorStore.getState().addAgent({
        sessionId,
        tool: tool.id,
        status: "spawning",
        collabSessionId,
        handle: claimed.handle,
        // publishOptedIn omitted — store defaults to `true` (cycle F
        // always-on). Eye toggle remains the per-agent opt-out.
      });
      }

      // ---- CLI readiness detection ----
      // Watch PTY output for prompt patterns indicating the CLI is ready for input.
      // Each CLI tool shows a prompt when ready (e.g. "> " for Claude, "❯ " for Codex).
      // Audited for the agy migration (gemini slot → Antigravity CLI): the
      // generic "> " pattern covers most REPL-style TUIs, and the retired
      // Gemini CLI patterns (✦, >>>) are kept — harmless if agy never
      // emits them. If agy's prompt matches none of these, the 5 s
      // fallback timer below still flips the agent to running, so
      // readiness detection degrades to a delay, never a hang. Re-measure
      // against agy's real TUI after onboarding (plan open question).
      const READY_PATTERNS = [
        />\s*$/,       // Claude Code prompt: "> " (also common REPL default)
        /❯\s*$/,      // Codex CLI prompt
        /✦\s*$/,      // legacy Gemini CLI prompt (kept for agy-slot compat)
        />>>\s*$/,     // legacy Gemini CLI alternate prompt
      ];
      let readyDetected = false;
      // We accumulate a small tail buffer to match prompt patterns
      let readyBuf = "";
      const READY_BUF_MAX = 200;
      // Also use a fallback timer in case prompt pattern isn't matched.
      // Adopt mode skips readiness detection entirely: the restored row
      // already carries the snapshot's status, and force-flipping an
      // adopted EXITED tile back to "running" would resurrect a dead agent
      // (design policy: dead tiles stay exited, identity preserved).
      if (!adopt) {
        readyTimeoutRef.current = setTimeout(() => {
          if (!readyDetected && isCurrentRun()) {
            readyDetected = true;
            const store = useCollaboratorStore.getState();
            store.setAgentStatus(sessionId, "running");
            store.flushPendingMessages(sessionId);
          }
        }, 5000); // 5s fallback — if CLI doesn't show a recognizable prompt
      }

      const checkReady = (raw: string) => {
        if (adopt || readyDetected) return;
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
          if (isCurrentRun()) {
            writeWithFollowBottom(event.payload);
            capture.feed(event.payload);
            checkReady(event.payload);
            // Feed the redraw-artifact refresh interval; the timestamp
            // gates the interval to only refresh while the tile has
            // had recent PTY output.
            lastPtyDataAt = Date.now();
          }
        },
      );
      // Unlisten the original listener that was set up before
      origDataUnlisten?.();

      // Workaround for the redraw artifact at the bottom of mini-agent
      // terminals when spawns.length > 4 across 2+ collaborator panes.
      // Manual tile resize empirically clears the stale paint; this
      // interval mimics that by forcing a full-viewport dirty mark
      // every 500ms whenever there's been recent PTY output. The
      // refresh is a no-op when xterm's RenderService is paused via
      // its built-in IntersectionObserver (RenderService.ts:106-144),
      // so this naturally targets only currently-visible tiles. If
      // this workaround doesn't fix the symptom, the next planner
      // cycle escalates to compositor-level CSS containment or the
      // WebGL renderer with idle-context handling.
      //
      // Post-await stale-run guard: initTerminal is async with multiple
      // awaits above. Without this check between the final listen() and
      // setInterval(), a StrictMode dispose-mid-flight could leave
      // Mount #1's interval running after Mount #2 starts.
      if (!isCurrentRun()) return;
      refreshInterval = setInterval(() => {
        if (!isCurrentRun()) return;
        const el = termRef.current;
        if (!el?.isConnected || el.offsetWidth <= 0 || el.offsetHeight <= 0)
          return;
        if (Date.now() - lastPtyDataAt > 1000) return;
        if (terminal.rows <= 0) return;
        terminal.refresh(0, terminal.rows - 1);
      }, 500);

      // Handle resize
      let resizeTimer: ReturnType<typeof setTimeout> | null = null;
      terminal.onResize(({ cols, rows }) => {
        if (!isCurrentRun()) return;
        if (resizeTimer) clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => {
          if (isCurrentRun()) {
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
      if (refreshInterval) {
        clearInterval(refreshInterval);
        refreshInterval = null;
      }
      if (visibilityObserver) {
        visibilityObserver.disconnect();
        visibilityObserver = null;
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

      // Korean IME shim — sole-owner cleanup. Replaces the prior 3
      // manual cleanup blocks (docInputRef/docKeyDownRef listeners +
      // imeHandlersRef focus unpatch). dispose() also restores
      // triggerDataEvent and the isCursorHidden property descriptor —
      // leaks the prior inline shim left open across StrictMode remount.
      imeHandleRef.current?.dispose();
      imeHandleRef.current = null;

      // Kill PTY — SUPPRESSED across a recovery reload (webcontent-death-
      // recovery node 13, system-design round-4 4-way blocker): the unmount
      // that accompanies the dying/reloading webview must not kill the very
      // Rust PTYs the recovery exists to reattach, nor drop the restored
      // store rows.
      if (!recoveryOrchestrator.isReloadInProgress()) {
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
        const imeOverlayEl = imeHandleRef.current?.overlayEl;
        if (imeOverlayEl) {
          imeOverlayEl.style.fontSize = `${newSize}px`;
        }
        const buf = terminalRef.current.buffer.active;
        const wasAtBottom = buf.viewportY >= buf.baseY;
        // Intentional asymmetry: when the font grows large enough
        // that the available cols drop below MIN_TERMINAL_COLS, the
        // fit is skipped this cycle and the last-good cols persist
        // until the next layout widens the tile. Don't "fix" this by
        // removing the guard — letting an unconstrained fit() through
        // here is exactly what produces the 1-char-wide hard-newline
        // damage on the PTY side.
        const fitAddon = fitAddonRef.current;
        let fitRan = false;
        if (fitAddon && shouldFitMiniTerminal(fitAddon.proposeDimensions())) {
          fitAddon.fit();
          fitRan = true;
        }
        if (fitRan && wasAtBottom) terminalRef.current.scrollToBottom();
      }
    });
  }, []);

  const agent = useCollaboratorStore((s) =>
    s.agents.find((a) => a.sessionId === sessionId),
  );

  // W9 + W10: peer-context-mirror watch lifecycle. Reactive on the
  // (handle, publishOptedIn, status) triple. When status==='running' &&
  // publishOptedIn===true, invoke('watch_transcript') and stash the
  // returned u64 token in watchTokenRef. When the dependencies flip
  // such that "should be watching" becomes false (publishOptedIn flipped
  // off, status left 'running', or component unmounts), invoke
  // ('unwatch_transcript') with the stashed token.
  //
  // The Rust side's TranscriptWatcher::unwatch is idempotent per its Q6
  // contract — double-unwatching is safe; tokens that referred to a
  // shutdown-cleared registry are silent no-ops. So we don't need to
  // synchronize the catch handlers; .catch(() => {}) is sufficient.
  //
  // Why not gated by isCurrentRun(): this useEffect doesn't share a
  // closure with the spawn useEffect's runId — it's a separate effect
  // with its own per-mount lifecycle. React handles its own
  // mount/unmount ordering; StrictMode's double-mount fires this
  // effect's cleanup between renders, which calls unwatch before the
  // next mount's watch fires. No race.
  const agentHandle = agent?.handle;
  const isRunning = agent?.status === "running";
  const isPublishing = agent?.publishOptedIn === true;
  const toolId = tool.id;
  useEffect(() => {
    // collabSessionId guards the watch too: the Rust IPC param is now a
    // non-optional String that namespaces the mirror path. In practice the
    // handle was reserved via reserveAgentHandle(collabSessionId, …) so it is
    // always present, but guarding here is cheap defense-in-depth — a null/
    // empty id would otherwise be swallowed by the .catch() with no mirror and
    // no error (claude2 review L1).
    //
    // Capability guard: tools without a tailable transcript (agy —
    // SQLite/WAL) never even attempt the watch IPC. The state level
    // already forces publishOptedIn=false for them (addAgent + restore
    // coercion), so this is belt-and-suspenders against a stale snapshot
    // or a programmatic setPublishOptedIn slipping a true through.
    if (
      !agentHandle ||
      !isRunning ||
      !isPublishing ||
      !collabSessionId ||
      !supportsPeerContextPublishing(toolId)
    ) {
      return;
    }
    let unmounted = false;
    invoke<number>("watch_transcript", {
      sessionId,
      agentHandle,
      tool: toolId,
      spawnedAtUnixMs: Date.now(),
      // Namespaces the mirror path to contexts/<collabSessionId>/<agent>.jsonl
      // (plan N10) so two collab sessions' identically-named agents (claude1)
      // never write to the same file.
      collabSessionId,
    })
      .then((token) => {
        if (unmounted) {
          // Effect cleanup already ran — release the token immediately.
          // Without this, a fast publish-toggle could leak a token whose
          // cleanup ran before its watch_transcript Promise resolved.
          invoke("unwatch_transcript", { token }).catch(() => {});
          return;
        }
        watchTokenRef.current = token;
      })
      .catch(() => {
        // watch_transcript failures (PTY died, fs_gate refused, etc.)
        // are non-fatal — the watcher's idempotent contract means the
        // next mount/toggle can retry cleanly. Don't surface a UI
        // error; the agent's terminal pane already shows its own
        // failure state.
      });
    return () => {
      unmounted = true;
      const token = watchTokenRef.current;
      if (token !== null) {
        watchTokenRef.current = null;
        invoke("unwatch_transcript", { token }).catch(() => {});
      }
    };
  }, [sessionId, agentHandle, isRunning, isPublishing, toolId, collabSessionId]);

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
    <div className={`flex flex-col h-full min-h-[220px] border rounded-md overflow-hidden ${focused ? "border-accent" : "border-surface-lighter"}`}>
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
        {agent && supportsPeerContextPublishing(tool.id) && (
          <button
            className="text-text-dim hover:text-cyan-400 transition-colors p-0.5 shrink-0"
            onClick={() =>
              useCollaboratorStore
                .getState()
                .setPublishOptedIn(
                  sessionId,
                  !(agent.publishOptedIn === true),
                )
            }
            aria-pressed={agent.publishOptedIn === true}
            title={
              agent.publishOptedIn === true
                ? "Publishing peer context (click to stop)"
                : "Not publishing peer context (click to publish)"
            }
          >
            {agent.publishOptedIn === true ? (
              <Eye size={12} />
            ) : (
              <EyeOff size={12} />
            )}
          </button>
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
