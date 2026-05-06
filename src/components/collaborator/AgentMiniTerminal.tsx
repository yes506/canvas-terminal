import { useCallback, useEffect, useRef, useState } from "react";
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
import { createFsdLineTap } from "../../lib/fsdLineTap";
import type { ParseResult } from "../../lib/fsdProtocol";
import { isEnvBootstrapped } from "../../lib/terminalManager";
import type { ToolConfig } from "../../types/collaborator";
import type { MessageKind } from "../../types/inbox";

/// Plan v6 Phase B Tauri event payload for `fsd-inbox-leader-message-{handle}`.
/// Mirrors the JSON emitted by `LeaderInboxPoller` at `poller.rs:223-231`.
/// Round-8 reflection per claude5 task-85 §2.2: type `kind` as the typed
/// `MessageKind` union from `types/inbox.ts` so a future `MessageKind`
/// variant change surfaces as a TS compile error here, not a silent
/// fallthrough to the `else` branch.
type InboxLeaderEventPayload = {
  message_id: string;
  kind: MessageKind;
  content: string;
  run_id: string | null;
  task_id: string | null;
  turn: number | null;
  seq_global: number;
};
import { X } from "lucide-react";
import { FsdToggle } from "./FsdToggle";
import { FsdRunChip } from "./FsdRunChip";
import { SwarmDrawer } from "./SwarmDrawer";
import type { DispatchResponse, FsdCommand, FsdLeaderState } from "../../types/fsd";

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
 * Sanitize leader-supplied text before re-injecting it into the leader's PTY.
 *
 * The orchestrator may echo a leader's malformed `##FSD …` line back through
 * `[FSD MALFORMED COMMAND]` / `[FSD ORCHESTRATOR RESPONSE]` / `[FSD ITERATION
 * REPORT]` blocks. The leader's own line tap is NOT gated against re-parsing
 * self-injected text (only non-leaders are gated), so a verbatim `##FSD`
 * substring in the inject can re-trigger the parser and start a strike loop.
 *
 * Replacing `##FSD` with `# #FSD` (the documented §5.4 escape) breaks the
 * line-tap regex without changing the semantic content the leader sees.
 */
export function sanitizeFsd(s: string | null | undefined): string {
  return (s ?? "").replace(/##FSD\b/g, "# #FSD");
}

/**
 * Parser-isolation predicate for the FSD line tap.
 *
 * The tap is per-mini-terminal but must only PARSE PTY output for sessions
 * that are currently FSD leaders. Without this gate, every mini-terminal —
 * including non-leader Codex/Gemini followers — runs the `##FSD ...` regex
 * over its own PTY echo. That created a side channel where:
 *   - typed user text containing `##FSD` got dispatched as malformed,
 *   - and `[FSD MALFORMED COMMAND]` got injected back into the agent's PTY.
 *
 * The earlier IPC-side guard (`if tier === "off" return`) inside the
 * onCommand callback only short-circuits the dispatch — it does NOT stop
 * the parser. This predicate gates `feed()` itself, so non-leaders never
 * accumulate a partial-line buffer or invoke the parser at all.
 *
 * Returns true only when this session has an active FSD leader registration
 * with a non-`off` tier.
 */
export function shouldFeedFsdTap(
  fsdByLeaderSessionId: Record<string, FsdLeaderState>,
  sessionId: string,
): boolean {
  const fsd = fsdByLeaderSessionId[sessionId];
  return fsd != null && fsd.tier !== "off";
}

export function buildFallbackFsdPlanCommand(
  leaderSessionId: string,
  collabSessionId: string | null,
): FsdCommand | null {
  const state = useCollaboratorStore.getState();
  const fsd = state.fsdByLeaderSessionId[leaderSessionId];
  if (!fsd || fsd.tier === "off" || fsd.activeRunId != null) return null;
  const leader = state.agents.find((a) => a.sessionId === leaderSessionId);
  if (!leader) return null;
  const tasks = collabSessionId ? (state.tasksBySession[collabSessionId] ?? []) : [];
  const task = tasks
    .filter((t) =>
      t.assignee === `@${leader.handle}` &&
      (t.status === "pending" || t.status === "in-progress"))
    .sort((a, b) => new Date(b.assignedAt).getTime() - new Date(a.assignedAt).getTime())[0];
  // Phase 3.3 (claude2/claude3 review): if no actionable task exists, return
  // null and let the strike+remind path fire instead of synthesizing a vague
  // "Complete the current user request via FSD" run. A vague run starts but
  // can't be usefully steered — the leader has no concrete goal and no
  // success criteria to evaluate against — so it burns turns and tokens for
  // no product value. Better to surface the malformed shorthand to the user
  // (via the orchestrator's strike message) and let them either author a
  // proper plan or assign a task first.
  const goal = task?.objective || task?.title;
  if (!goal) return null;
  const randomId = () =>
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return {
    v: 1,
    cmd_id: randomId(),
    sn: fsd.sessionNonce,
    rn: "",
    run_id: randomId(),
    type: "plan",
    goal,
    success_criteria: [
      "Dispatch at least one assistant task unless the goal is already complete.",
      "Synthesize assistant results before writing the collaborator completion report.",
    ],
    max_turns: 4,
  };
}

/**
 * Pure routing decision for a parsed `##FSD` line — extracted so the
 * dispatch logic in `AgentMiniTerminal`'s line-tap callback can be unit
 * tested without mounting xterm or mocking IPC.
 *
 * Maps a `(ParseResult, fallbackPlan)` pair to one of four discrete
 * actions the line tap takes:
 *  - `dispatch-cmd` — leader emitted a well-formed command; forward to
 *    `fsd_dispatch_command` IPC.
 *  - `dispatch-fallback` — leader shorthand'd `##FSD plan` and we have
 *    enough state to synthesize a recovery plan; dispatch that.
 *  - `local-reminder` — leader shorthand'd `##FSD plan` but no actionable
 *    task is assigned; inject a local `[FSD MALFORMED COMMAND]` with
 *    recovery guidance and SKIP the backend strike (no run to attribute
 *    to). Closes the no-task feedback hole codex2 task-40 P1 raised.
 *  - `report-strike` — any other malformed line; report to the canonical
 *    Rust strike counter via `fsd_report_malformed`.
 *  - `ignore` — `kind: "skip"` (not an `##FSD` line at all).
 */
export type FsdRouteAction =
  | { kind: "dispatch-cmd"; cmd: FsdCommand }
  | { kind: "dispatch-fallback"; cmd: FsdCommand }
  | { kind: "local-reminder"; reason: string }
  | { kind: "report-strike"; reason: string }
  | { kind: "ignore" };

export function routeFsdParseResult(
  result: ParseResult,
  fallbackPlan: FsdCommand | null,
): FsdRouteAction {
  if (result.kind === "ok") return { kind: "dispatch-cmd", cmd: result.cmd };
  if (result.kind === "skip") return { kind: "ignore" };
  // result.kind === "malformed"
  if (result.code === "shorthand-plan") {
    if (fallbackPlan) return { kind: "dispatch-fallback", cmd: fallbackPlan };
    // No fallback synthesizable → local reminder, NOT a backend strike.
    return { kind: "local-reminder", reason: result.reason };
  }
  return { kind: "report-strike", reason: result.reason };
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
  const fsdTapRef = useRef<ReturnType<typeof createFsdLineTap> | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
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

  /**
   * Inject text into the leader PTY with echo suppression.
   *
   * Defaults to TARGETED echo suppression (`expectEcho`) — bracketed-paste
   * echoes the same text back, so the tap matches and silently consumes only
   * that text. A real leader-emitted `##FSD done` immediately after still
   * flows through.
   *
   * Per @codex3 task-59 P1/P2: blanket mute risks dropping real leader
   * commands emitted within the mute window. Use it only as an opt-in
   * fallback when targeted echo suppression isn't reliable enough on the
   * current CLI (Phase 0 spike's `EchoFidelity` scenario decides per-CLI).
   */
  const injectFsdLeaderText = useCallback(
    (text: string, opts?: { fallbackBlanketMuteMs?: number }) => {
      // Targeted echo suppression — DEFAULT. The tap matches the exact
      // injected text within a 1200ms window and consumes the echo.
      fsdTapRef.current?.expectEcho(text, 1200);
      // Blanket mute is opt-in: only enabled when a CLI is known (per Phase
      // 0 EchoFidelity outcome) to mangle bracketed-paste echo such that
      // expectEcho can't match. When set, blanket-drops EVERYTHING for the
      // window — risk is dropping a real leader command emitted quickly.
      if (opts?.fallbackBlanketMuteMs && opts.fallbackBlanketMuteMs > 0) {
        fsdTapRef.current?.enableBlanketMute(opts.fallbackBlanketMuteMs);
      }
      invoke("inject_into_pty", { sessionId, text, tool: tool.id }).catch((err) => {
        console.warn("[FSD] inject_into_pty failed:", err);
      });
    },
    [sessionId, tool.id],
  );

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

      // FSD line tap — parses `##FSD` lines from PTY output and dispatches
      // them to the orchestrator via fsd_dispatch_command. Lives in the SAME
      // listener path as `capture.feed` (per @codex2 task-17 §1) — sequence:
      // writeWithFollowBottom → fsdTap.feed → capture.feed → checkReady.
      const fsdTap = createFsdLineTap({
        sessionId,
        onCommand: (result) => {
          const fsdState = useCollaboratorStore.getState().fsdByLeaderSessionId[sessionId];
          if (!fsdState || fsdState.tier === "off") return;
          if (result.kind === "ok") {
            invoke<DispatchResponse>("fsd_dispatch_command", {
              leaderSessionId: sessionId,
              cmd: result.cmd,
            })
              .then((resp) => {
                // Toggle-off race guard: if FSD was disabled while the dispatch
                // was in flight, drop the response — injecting it now would
                // surprise the user (no longer the leader's expected mode).
                const cur = useCollaboratorStore.getState().fsdByLeaderSessionId[sessionId];
                if (!cur || cur.tier === "off") return;
                if (!resp.message || resp.next_action === "ack") return;
                injectFsdLeaderText(
                  [
                    "[FSD ORCHESTRATOR RESPONSE]",
                    `result: ${resp.result}`,
                    `next_action: ${resp.next_action}`,
                    `strikes: ${resp.strike_count}`,
                    sanitizeFsd(resp.message),
                  ].join("\n"),
                );
              })
              .catch((err) => {
              console.warn("[FSD] dispatch_command failed:", err);
              });
          } else if (result.kind === "malformed") {
            console.debug("[FSD] malformed line:", result.code, result.reason);
            // Recovery synthesis ONLY for shorthand `##FSD plan` — the other
            // shorthand verbs (dispatch/done/blocked) need live run context
            // (task list, summary, reason) that the harness cannot fabricate;
            // they fall through to strike+remind with a clearer message.
            const fallbackPlan = result.code === "shorthand-plan"
              ? buildFallbackFsdPlanCommand(sessionId, collabSessionId)
              : null;
            // No-task fallback hole (codex2 task-40 P1): when the leader
            // emitted `##FSD plan` shorthand BUT no actionable task exists,
            // `buildFallbackFsdPlanCommand` returns null. The next backend
            // call to `fsd_report_malformed(runId: null)` returns
            // `out_of_scope` (no active run), and the `.then()` branch below
            // suppresses the inject for `out_of_scope` — so the leader sees
            // nothing. Inject a local reminder here that explains the gap and
            // tells the leader how to recover (full JSON plan or assign a
            // task first). Skip the backend call entirely — there's no run to
            // attribute a strike to, and the local reminder is the actionable
            // signal the leader needs.
            if (result.code === "shorthand-plan" && !fallbackPlan) {
              injectFsdLeaderText(
                [
                  "[FSD MALFORMED COMMAND]",
                  sanitizeFsd(result.reason),
                  "No actionable collaborator task is currently assigned to you,",
                  "so the harness cannot synthesize a fallback plan from your",
                  "shorthand. Either emit a full JSON plan command — `##FSD",
                  "{\"v\":1,\"type\":\"plan\",\"goal\":\"…\",…}` — or have a task",
                  "assigned (`/task add … @<your-handle>`) before retrying.",
                ].join("\n"),
              );
              return;
            }
            if (fallbackPlan) {
              invoke<DispatchResponse>("fsd_dispatch_command", {
                leaderSessionId: sessionId,
                cmd: fallbackPlan,
              })
                .then((resp) => {
                  // Toggle-off race guard (same reasoning as the ok-branch above).
                  const cur = useCollaboratorStore.getState().fsdByLeaderSessionId[sessionId];
                  if (!cur || cur.tier === "off") return;
                  if (resp.result === "accepted" || resp.next_action === "ack") {
                    injectFsdLeaderText(
                      [
                        "[FSD SHORTHAND PLAN RECOVERED]",
                        "Your `##FSD plan` shorthand was converted into a valid JSON plan.",
                        "Continue only with JSON `dispatch`, `done`, or `blocked` commands.",
                      ].join("\n"),
                    );
                    return;
                  }
                  injectFsdLeaderText(
                    [
                      "[FSD ORCHESTRATOR RESPONSE]",
                      `result: ${resp.result}`,
                      `next_action: ${resp.next_action}`,
                      `strikes: ${resp.strike_count}`,
                      sanitizeFsd(resp.message ?? "fallback plan was not accepted"),
                    ].join("\n"),
                  );
                })
                .catch((err) => {
                  console.warn("[FSD] fallback plan dispatch failed:", err);
                });
              return;
            }
            // Report to backend so the canonical Rust strike counter
            // increments. Per @codex2 task-50 P1 / @codex3 task-52 P1 /
            // @claude3 task-58 §5.2 — frontend's optimistic count is for UI
            // responsiveness; orchestrator owns the authoritative count and
            // can force-block at STRIKES_PER_TURN.
            invoke<{ result: string; strike_count: number; message: string }>(
              "fsd_report_malformed",
              {
                leaderSessionId: sessionId,
                runId: null,
                reason: result.reason,
              },
            )
              .then((resp) => {
                // Toggle-off race guard: if FSD was disabled mid-flight, don't
                // resurface a malformed-line reminder for an inactive leader.
                const cur = useCollaboratorStore.getState().fsdByLeaderSessionId[sessionId];
                if (!cur || cur.tier === "off") return;
                if (resp.result === "out_of_scope") return;
                injectFsdLeaderText(
                  [
                    "[FSD MALFORMED COMMAND]",
                    `result: ${resp.result}`,
                    `strikes: ${resp.strike_count}`,
                    sanitizeFsd(result.reason),
                    "Emit exactly one valid JSON object on a line prefixed by ##FSD.",
                    "Do not emit shorthand such as `##FSD plan`; the line must start with `##FSD {`.",
                  ].join("\n"),
                );
              })
              .catch((err) => {
                console.warn("[FSD] fsd_report_malformed failed:", err);
                // Same toggle-off race guard as the success branch (codex1
                // task-38 finding 4): if FSD was disabled while the backend
                // call was in flight, don't surface a reminder for an
                // inactive leader on the local-fallback path either.
                const cur = useCollaboratorStore.getState().fsdByLeaderSessionId[sessionId];
                if (!cur || cur.tier === "off") return;
                // Fall back to local-only reminder if backend unreachable.
                injectFsdLeaderText(
                  [
                    "[FSD MALFORMED COMMAND]",
                    sanitizeFsd(result.reason),
                    "Emit exactly one valid JSON object on a line prefixed by ##FSD.",
                    "Do not emit shorthand such as `##FSD plan`; the line must start with `##FSD {`.",
                  ].join("\n"),
                );
              });
          }
        },
      });
      fsdTapRef.current = fsdTap;

      // Listen for PTY output
      const feedFsdTap = (payload: string) => {
        const state = useCollaboratorStore.getState();
        if (shouldFeedFsdTap(state.fsdByLeaderSessionId, sessionId)) {
          fsdTap.feed(payload);
        }
      };
      unlistenDataRef.current = await listen<string>(
        `pty-data-${sessionId}`,
        (event) => {
          if (!disposed.current) {
            writeWithFollowBottom(event.payload);
            feedFsdTap(event.payload);
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

      // Spawn the CLI tool — try direct process first, fall back to shell
      const [program, ...programArgs] = tool.command.split(/\s+/);
      let spawnedViaShell = false;

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
            feedFsdTap(event.payload); // FSD tap also wired in the replacement listener
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
      // FSD tap cleanup
      fsdTapRef.current?.dispose();
      fsdTapRef.current = null;
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
    // cwd intentionally excluded — it may update asynchronously after mount
    // (Step 3: non-blocking CWD). Including it would destroy and recreate the
    // terminal when CWD resolves. The initial cwd value at mount time is sufficient.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, tool.command, collabSessionId]);

  // Parser isolation: clear the FSD line tap's internal buffer when this
  // session stops being an FSD leader. Pairs with the `shouldFeedFsdTap`
  // gate inside the data listener — together they guarantee non-leader
  // mini-terminals neither parse incoming PTY chunks nor retain stale
  // partial-line state from a previous active period.
  const fsdTier = useCollaboratorStore(
    (s) => s.fsdByLeaderSessionId[sessionId]?.tier,
  );
  useEffect(() => {
    if (fsdTier == null || fsdTier === "off") {
      fsdTapRef.current?.dispose();
    }
  }, [fsdTier]);

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

  // FSD event subscriptions — backend emits these per leader handle.
  // Updates the store so the UI chip + drawer reflect run progress.
  const agentForFsd = useCollaboratorStore((s) =>
    s.agents.find((a) => a.sessionId === sessionId),
  );
  useEffect(() => {
    if (!agentForFsd?.handle) return;
    const handle = agentForFsd.handle;
    const unlistenStart = listen<{ run_id: string; run_nonce: string; max_turns: number }>(
      `fsd-run-start-${handle}`,
      (e) => {
        useCollaboratorStore.getState().applyFsdRunStart(sessionId, e.payload);
        injectFsdLeaderText(
          [
            "[FSD RUN STARTED]",
            `run_id: ${e.payload.run_id}`,
            `run_nonce: ${e.payload.run_nonce}`,
            `max_turns: ${e.payload.max_turns}`,
            "Use this run_nonce as rn for every dispatch, done, or blocked command in this run.",
          ].join("\n"),
        );
      },
    );
    const unlistenReport = listen<{ run_id: string; turn: number; report: string }>(
      `fsd-iteration-report-${handle}`,
      (e) => {
        // Use targeted echo suppression only (no blanket mute) per @codex3
        // task-59 P1 — blanket mute risks dropping a real `##FSD done` the
        // leader emits within 2s of receiving the report. expectEcho matches
        // the exact injected text and only consumes that.
        injectFsdLeaderText(
          [
            "[FSD ITERATION REPORT]",
            `run_id: ${e.payload.run_id}`,
            `turn: ${e.payload.turn}`,
            "",
            sanitizeFsd(e.payload.report),
          ].join("\n"),
        );
      },
    );
    // Plan v6 Phase B: when `fsd_inbox_delivery=true` the orchestrator
    // routes iteration reports through `LeaderInboxPoller` which emits
    // `fsd-inbox-leader-message-{handle}` instead of the legacy
    // `fsd-iteration-report-{handle}`. Without this listener, enabling the
    // feature flag would silently drop iteration reports — codex2 task-75
    // P0 + codex3 task-77 P0. Maps to the same `injectFsdLeaderText`
    // pipeline as the legacy event.
    const unlistenInboxLeaderMsg = listen<InboxLeaderEventPayload>(
      `fsd-inbox-leader-message-${handle}`,
      (e) => {
        const p = e.payload;
        if (p.kind === "iteration_report" && p.turn != null && p.run_id != null) {
          injectFsdLeaderText(
            [
              "[FSD ITERATION REPORT]",
              `run_id: ${p.run_id}`,
              `turn: ${p.turn}`,
              "",
              sanitizeFsd(p.content),
            ].join("\n"),
          );
        } else {
          // Other inbox kinds (broadcast, agent_message, control) inject the
          // raw content; the leader's prompt handles classification.
          injectFsdLeaderText(sanitizeFsd(p.content));
        }
      },
    );
    // fsd-task-start makes the SwarmDrawer chip appear immediately when the
    // task is dispatched (per @claude2 task-49 §3.1) — without this the
    // drawer was empty until tasks completed.
    const unlistenTaskStart = listen<{ run_id: string; turn: number; task_id: string; tool: string; role_hint?: string | null }>(
      `fsd-task-start-${handle}`,
      (e) => useCollaboratorStore.getState().applyFsdTaskStart(sessionId, e.payload),
    );
    const unlistenDone = listen<{
      run_id: string; turn: number; task_id: string;
      tool?: string; role_hint?: string | null;
      kind: string; wallclock_ms: number;
      exit_code?: number | null; last_line?: string;
    }>(
      `fsd-task-done-${handle}`,
      (e) => useCollaboratorStore.getState().applyFsdTaskDone(sessionId, e.payload),
    );
    const unlistenEnd = listen<{ run_id: string; status: string }>(
      `fsd-run-end-${handle}`,
      (e) => useCollaboratorStore.getState().applyFsdRunEnd(sessionId, e.payload),
    );
    return () => {
      unlistenStart.then((u) => u()).catch(() => {});
      unlistenReport.then((u) => u()).catch(() => {});
      unlistenInboxLeaderMsg.then((u) => u()).catch(() => {});
      unlistenTaskStart.then((u) => u()).catch(() => {});
      unlistenDone.then((u) => u()).catch(() => {});
      unlistenEnd.then((u) => u()).catch(() => {});
    };
  }, [sessionId, agentForFsd?.handle, injectFsdLeaderText]);

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
        {/* FSD: run-status chip + tier toggle (plan v5 §6.1). Off / Pilot are
            functional in Phase 1; x1/x2/x3 are disabled until Phase 2. */}
        {agent && agent.handle && (
          <>
            <FsdRunChip
              leaderSessionId={sessionId}
              onClick={() => setDrawerOpen((v) => !v)}
            />
            <FsdToggle
              leaderSessionId={sessionId}
              leaderHandle={agent.handle}
              disabled={isExited || isSpawning || isPreRegistration}
            />
          </>
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
      {/* FSD swarm drawer — collapsed by default, opens via FsdRunChip click. */}
      <SwarmDrawer leaderSessionId={sessionId} open={drawerOpen} />
    </div>
  );
}
