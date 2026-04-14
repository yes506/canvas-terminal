import { useEffect, useRef, useState, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useCollaboratorStore } from "../../stores/collaboratorStore";
import { useTerminalStore, getActiveSessionId } from "../../stores/terminalStore";
import { generateSessionId } from "../../lib/sessionId";
import { AgentToolbar } from "./AgentToolbar";
import { AgentMiniTerminal } from "./AgentMiniTerminal";
import { InputPrompt } from "./InputPrompt";
import { Zap, Cpu, X } from "lucide-react";
import type { ToolConfig } from "../../types/collaborator";

interface Spawn {
  sessionId: string;
  tool: ToolConfig;
  cwd: string | null;
}

export function CollaboratorPane() {
  const agents = useCollaboratorStore((s) => s.agents);
  const statusMessage = useCollaboratorStore((s) => s.statusMessage);
  const startSession = useCollaboratorStore((s) => s.startSession);
  const endSession = useCollaboratorStore((s) => s.endSession);
  const killAllAgents = useCollaboratorStore((s) => s.killAllAgents);

  const [spawns, setSpawns] = useState<Spawn[]>([]);
  const mountedRef = useRef(false);

  // Session lifecycle
  useEffect(() => {
    mountedRef.current = true;
    const collabId = `collab-${Date.now()}`;
    startSession(collabId);

    return () => {
      mountedRef.current = false;
      // Kill all agents and clear memory on unmount
      killAllAgents();
      endSession();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Spawn a new agent
  const handleSpawn = useCallback(async (tool: ToolConfig) => {
    // Resolve CWD from the active terminal pane
    let cwd: string | null = null;
    try {
      const activeSession = getActiveSessionId();
      if (activeSession) {
        cwd = await invoke<string>("get_pty_cwd", {
          sessionId: activeSession,
        });
      }
    } catch {
      // Fall back to null (home directory)
    }

    const sessionId = generateSessionId();
    setSpawns((prev) => [...prev, { sessionId, tool, cwd }]);
  }, []);

  // Close a single agent
  const handleClose = useCallback((sessionId: string) => {
    setSpawns((prev) => prev.filter((s) => s.sessionId !== sessionId));
    // AgentMiniTerminal's cleanup effect handles kill_pty + store removal
  }, []);

  return (
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
            {spawns.map((spawn) => (
              <AgentMiniTerminal
                key={spawn.sessionId}
                sessionId={spawn.sessionId}
                tool={spawn.tool}
                cwd={spawn.cwd}
                onClose={handleClose}
              />
            ))}
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
  );
}
