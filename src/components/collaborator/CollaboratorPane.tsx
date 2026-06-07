import { useEffect, useRef, useState, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useShallow } from "zustand/react/shallow";
import { useCollaboratorStore, scanForTaskCompletions } from "../../stores/collaboratorStore";
import { useTerminalStore, getActiveSessionId } from "../../stores/terminalStore";
import { generateSessionId } from "../../lib/sessionId";
import { CollabSessionContext } from "./CollabSessionContext";
import { AgentToolbar } from "./AgentToolbar";
import { AgentMiniTerminal } from "./AgentMiniTerminal";
import { InputPrompt } from "./InputPrompt";
import { Zap, Cpu, X, Monitor } from "lucide-react";
import type { ToolConfig } from "../../types/collaborator";

// Load-bearing fix for the collaborator mini-terminal reflow bug.
// If a column shrinks below this width, FitAddon proposes tiny cols
// (down to its internal floor of 2), `resize_pty` propagates them,
// and the child CLI redraws with hard newlines that xterm cannot
// reflow on re-expand — leaving 1-char-wide stranded lines behind.
// This is the perpendicular-axis mirror of the 220px row floor added
// in b261437 (`fix(collaborator): floor mini-terminal tile height at
// 220px`), enforced through the same `gridAutoRows: minmax(...)`
// pattern.
//
// Relation to the AgentMiniTerminal MIN_TERMINAL_COLS=20 JS guard:
//   MIN_AGENT_TILE_WIDTH_PX ≈ MIN_TERMINAL_COLS × monospace-cell-width
//   + container padding. At the default terminal fontSize=11 (mini
//   uses fontSize-2 = 9), cell width is ~9px, so 360px ≈ ~38 cols
//   of usable width — comfortably above the floor. The CSS floor is
//   load-bearing; the JS guard is defense-in-depth for callers that
//   render the terminal outside this grid (tests, future layouts).
//
// Edge: large terminal fontSize (≥16px) maps 360px to ~16-18 cols —
// still above FitAddon.MINIMUM_COLS=2 but cramped for Claude/Codex
// prompt frames. Re-tune the constant if that becomes a real pain.
const MIN_AGENT_TILE_WIDTH_PX = 360;

interface CollaboratorPaneProps {
  /** Session ID from the pane tree — used as the collab session identifier. */
  paneSessionId: string;
}

interface Spawn {
  sessionId: string;
  tool: ToolConfig;
  cwd: string | null;
  /** True once the initial CWD has been resolved (or failed). */
  cwdReady: boolean;
}

export function CollaboratorPane({ paneSessionId }: CollaboratorPaneProps) {
  const startSession = useCollaboratorStore((s) => s.startSession);
  const endSession = useCollaboratorStore((s) => s.endSession);
  const killAllAgents = useCollaboratorStore((s) => s.killAllAgents);

  const [spawns, setSpawns] = useState<Spawn[]>([]);
  const mountedRef = useRef(false);
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  // Tracks the grid scroll-container's content-box height so we can fix
  // row height to the "4-agent target" once spawns.length > 4. Null until
  // the first ResizeObserver tick — we fall back to minmax(220px, 1fr)
  // in the interim, which is what ≤4 agents use anyway, so the only
  // first-paint mismatch is a single frame when a pane mounts already
  // holding >4 agents (rare).
  const [contentHeight, setContentHeight] = useState<number | null>(null);
  const collabId = paneSessionId;
  const statusMessage = useCollaboratorStore((s) => s.statusMessages[collabId] ?? null);

  // Filter agents for this specific collaborator pane (useShallow prevents
  // re-renders when .filter() returns a structurally identical array)
  const agents = useCollaboratorStore(
    useShallow((s) => s.agents.filter((a) => a.collabSessionId === collabId)),
  );

  // Session lifecycle
  useEffect(() => {
    mountedRef.current = true;
    startSession(collabId);

    return () => {
      mountedRef.current = false;
      // Kill only this session's agents and clear memory on unmount
      killAllAgents(collabId);
      endSession(collabId);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Per-session polling fallback for `.done.json` task-completion ingestion.
  //
  // The primary trigger for `scanForTaskCompletions` is the per-agent PTY
  // capture's `onFlush` debounce in `AgentMiniTerminal`, which can miss
  // when (a) the buffer filters to empty after an agent's quiet completion,
  // (b) `muteCapture` reset() drops the pending flush, (c) continuous CLI
  // animation keeps the debounce timer alive forever, or (d) a single agent
  // finishes silently with no peer capture to pump the trigger.
  //
  // This poll bounds the resulting "stuck in progress" staleness to ≤ POLL_MS
  // for any mounted pane. It also runs an immediate scan on mount (before
  // the first interval) so a `.done.json` already on disk when the pane
  // mounts (session restored, agent finished while pane was unmounted)
  // is processed without waiting for the first POLL_MS interval.
  useEffect(() => {
    let cancelled = false;
    // Immediate kickoff. Async chain (list_memory_files + per-file IPCs)
    // resolves after mount, but does NOT wait for the first POLL_MS tick.
    // scanForTaskCompletions internally swallows errors; the .catch here
    // is belt-and-suspenders against a future refactor that surfaces one,
    // and the warn-log mirrors AgentMiniTerminal's pty-exit-handler
    // pattern so a regression is discoverable rather than silent.
    void scanForTaskCompletions(collabId).catch((err) => {
      console.warn("scanForTaskCompletions failed on pane mount:", err);
    });

    const POLL_MS = 2000;
    const handle = window.setInterval(() => {
      if (cancelled) return;
      void scanForTaskCompletions(collabId).catch((err) => {
        console.warn("scanForTaskCompletions failed in poll tick:", err);
      });
    }, POLL_MS);

    return () => {
      cancelled = true;
      window.clearInterval(handle);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Spawn a new agent — show UI tile immediately, resolve CWD before starting PTY
  const handleSpawn = useCallback((tool: ToolConfig) => {
    const sessionId = generateSessionId();
    // Add spawn immediately for instant UI feedback (tile visible, but PTY waits for CWD)
    setSpawns((prev) => [...prev, { sessionId, tool, cwd: null, cwdReady: false }]);

    // Resolve CWD asynchronously with a timeout, then mark ready so AgentMiniTerminal mounts.
    // If lsof stalls or takes too long, proceed with null cwd (home directory) after 2s.
    (async () => {
      let resolved: string | null = null;
      try {
        const activeSession = getActiveSessionId();
        if (activeSession) {
          const cwdPromise = invoke<string>("get_pty_cwd", {
            sessionId: activeSession,
          });
          const timeoutPromise = new Promise<null>((resolve) =>
            setTimeout(() => resolve(null), 2000),
          );
          resolved = await Promise.race([cwdPromise, timeoutPromise]);
        }
      } catch {
        // Fall back to null (home directory)
      }
      if (mountedRef.current) {
        setSpawns((prev) =>
          prev.map((s) =>
            s.sessionId === sessionId
              ? { ...s, cwd: resolved, cwdReady: true }
              : s,
          ),
        );
      }
    })();
  }, []);

  // Observe the scroll container's content-box height so we can pin
  // grid row height to the 4-agent target when spawns.length > 4.
  // Fires once on attach with the initial size, then on every layout
  // change (window resize, pane split drag, sidebar toggle, etc.).
  useEffect(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const entry = entries[entries.length - 1];
      if (entry) setContentHeight(entry.contentRect.height);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Close a single agent
  const handleClose = useCallback((sessionId: string) => {
    setSpawns((prev) => prev.filter((s) => s.sessionId !== sessionId));
    // AgentMiniTerminal's cleanup effect handles kill_pty + store removal
  }, []);

  return (
    <CollabSessionContext.Provider value={collabId}>
      <div className="flex flex-col h-full w-full bg-surface">
        {/* Header */}
        <div className="flex items-center gap-2 px-3 py-1.5 border-b border-surface-lighter bg-surface-light text-xs shrink-0">
          <Zap size={12} className="text-accent" />
          <span className="font-bold uppercase tracking-wider text-text">
            Collaborator
          </span>
          <span className="text-text-dim">
            {agents.length} agent{agents.length !== 1 ? "s" : ""}
          </span>
          <span
            className="font-mono text-text-dim min-w-0 max-w-[40%] truncate"
            title={collabId}
          >
            {collabId}
          </span>
          <div className="flex-1" />
          <button
            type="button"
            className="p-0.5 rounded hover:bg-surface-lighter text-text-dim hover:text-text transition-colors"
            onClick={() => {
              invoke("open_dashboard").catch((err) => {
                console.error("[dashboard] open_dashboard failed:", err);
              });
            }}
            title="Open Dashboard (⌘⇧D)"
            aria-label="Open Dashboard"
          >
            <Monitor size={14} />
          </button>
          <button
            className="p-0.5 rounded hover:bg-surface-lighter text-text-dim hover:text-text transition-colors"
            onClick={() => useTerminalStore.getState().openCollaboratorSplit()}
            title="Close collaborator"
          >
            <X size={14} />
          </button>
        </div>

        {/* Tool launch buttons */}
        <AgentToolbar onSpawn={handleSpawn} agents={agents} />

        {/* Mini terminal grid */}
        <div ref={scrollContainerRef} className="flex-1 min-h-0 overflow-auto p-2">
          {spawns.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full text-text-dim text-sm font-mono gap-2">
              <Cpu size={24} className="opacity-50" />
              <p>No agents running</p>
              <p className="text-xs">Launch an AI tool above, then type directly in its terminal</p>
            </div>
          ) : (
            <div
              className="grid gap-2 h-full"
              style={{
                // `minmax(MIN_AGENT_TILE_WIDTH_PX, 1fr)` columns enforce a
                // horizontal floor for each tile so xterm's fitAddon can't
                // size the PTY below the cols threshold where Claude/Codex
                // TUIs collapse into 1-char-wide hard-newline output that
                // can never reflow on re-expand. See the constant's docstring
                // for the cascade and the b261437 row-floor precedent.
                // `gridAutoRows` rule:
                //   ≤4 agents → minmax(220px, 1fr): rows stretch to fill,
                //   220px floor (b261437) protects the Claude/Codex TUI
                //   header/transcript/prompt/footer stacking edge.
                //   >4 agents → pin each row to the 4-agent target height
                //   ((contentHeight - one 8px gap) / 2). This stops the
                //   transition from 4 → 5 agents from squishing every tile
                //   down to the 220px floor; instead the grid overflows and
                //   the parent `overflow-auto` provides a vertical scrollbar
                //   on the right. Still clamped at 220px for sanity when the
                //   pane itself is tiny.
                // The parent already has `overflow-auto`, so the pane scrolls
                // when many agents push the grid past viewport (or when a
                // narrow window can't fit two min-width columns) instead of
                // squeezing tiles below the floor.
                gridTemplateColumns:
                  spawns.length === 1
                    ? `minmax(${MIN_AGENT_TILE_WIDTH_PX}px, 1fr)`
                    : `repeat(2, minmax(${MIN_AGENT_TILE_WIDTH_PX}px, 1fr))`,
                gridAutoRows:
                  spawns.length > 4 && contentHeight !== null
                    ? `${Math.max(220, (contentHeight - 8) / 2)}px`
                    : "minmax(220px, 1fr)",
              }}
            >
              {spawns.map((spawn) =>
                spawn.cwdReady ? (
                  <AgentMiniTerminal
                    key={spawn.sessionId}
                    sessionId={spawn.sessionId}
                    tool={spawn.tool}
                    cwd={spawn.cwd}
                    onClose={handleClose}
                  />
                ) : (
                  <div
                    key={spawn.sessionId}
                    className="flex flex-col h-full min-h-[220px] border rounded-md overflow-hidden border-surface-lighter"
                  >
                    <div className="flex items-center gap-2 px-2 py-1 bg-surface-light border-b border-surface-lighter text-xs shrink-0">
                      <span className="w-1.5 h-1.5 rounded-full shrink-0 bg-yellow-400 animate-pulse" />
                      <span className={`font-bold ${spawn.tool.colorClass} truncate`}>
                        {spawn.tool.label}
                      </span>
                    </div>
                    <div className="flex-1 flex items-center justify-center text-text-dim text-xs font-mono">
                      Starting...
                    </div>
                  </div>
                ),
              )}
            </div>
          )}
        </div>

        {/* Status line */}
        {statusMessage && (
          <div className="px-3 py-1 border-t border-surface-lighter text-xs text-cyan-400 font-mono truncate shrink-0">
            {statusMessage}
          </div>
        )}

        {/* Input */}
        <InputPrompt />
      </div>
    </CollabSessionContext.Provider>
  );
}
