import { useEffect, useRef, useState, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useShallow } from "zustand/react/shallow";
import { useCollaboratorStore } from "../../stores/collaboratorStore";
import { useTerminalStore, getActiveSessionId } from "../../stores/terminalStore";
import { generateSessionId } from "../../lib/sessionId";
import { CollabSessionContext } from "./CollabSessionContext";
import { AgentToolbar } from "./AgentToolbar";
import { AgentMiniTerminal } from "./AgentMiniTerminal";
import { InputPrompt } from "./InputPrompt";
import { Zap, Cpu, X } from "lucide-react";
import type { ToolConfig } from "../../types/collaborator";

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
          <div className="flex-1" />
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
        <div className="flex-1 min-h-0 overflow-auto p-2">
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
                gridTemplateColumns:
                  spawns.length === 1 ? "1fr" : "repeat(2, 1fr)",
                gridTemplateRows:
                  spawns.length <= 2
                    ? "1fr"
                    : `repeat(${Math.ceil(spawns.length / 2)}, 1fr)`,
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
                    className="flex flex-col h-full min-h-0 border rounded-md overflow-hidden border-surface-lighter"
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
