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
import type { RepoInfo, ToolConfig, WorktreeMetadata } from "../../types/collaborator";

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
  /** Worktree metadata if the agent was spawned in a git repo (P1 backend
   *  provisioning). null = either not a git repo, or provisioning failed.
   *  Threaded into AgentMiniTerminal which forwards it to addAgent so the
   *  store record carries it for P2's awaiting-approval gate. */
  worktree: WorktreeMetadata | null;
  /** Surface a one-line provisioning message in the spawn placeholder
   *  (e.g., "Provisioning isolated worktree…", or "missing dev branch"). */
  provisioningMessage: string | null;
}

/**
 * Result of `provisionWorktreeForSpawn`. Exported for unit testing —
 * the closure inside `handleSpawn` consumes this directly.
 */
export interface ProvisioningResult {
  /** The cwd the PTY should actually run in. Falls back to the provided
   *  `resolvedCwd` if provisioning was skipped or failed. */
  cwd: string | null;
  /** The created worktree, or null if not in a git repo / provisioning
   *  failed. The caller stores this on `SpawnedAgent` for P2 gating. */
  worktree: WorktreeMetadata | null;
  /** One-line message for the spawn placeholder UI, or null. */
  provisioningMessage: string | null;
  /** Status-line message that should be surfaced to the collab session
   *  via `setStatus`. null when there's nothing to show. */
  errorStatus: string | null;
}

/**
 * Decide whether `resolvedCwd` is a git repo and, if so, provision a
 * fresh per-agent worktree from `origin/dev`. Pure-ish helper exported
 * for testing: every effect is via the injected `invoke` shim.
 *
 * Failure (e.g., the missing-`dev` case) is non-fatal at the spawn
 * layer — the agent still launches in `resolvedCwd` (no worktree
 * isolation), but P2's awaiting-approval gate keys on `worktree` being
 * non-null, so a non-isolated agent's tasks won't auto-flip. The caller
 * surfaces the failure reason via the status line.
 */
export async function provisionWorktreeForSpawn(args: {
  resolvedCwd: string | null;
  collabId: string;
  sessionId: string;
  toolId: string;
  invokeShim?: typeof invoke;
}): Promise<ProvisioningResult> {
  const inv = args.invokeShim ?? invoke;
  const { resolvedCwd, collabId, sessionId, toolId } = args;
  const fallback: ProvisioningResult = {
    cwd: resolvedCwd,
    worktree: null,
    provisioningMessage: null,
    errorStatus: null,
  };
  if (!resolvedCwd) return fallback;

  let repo: RepoInfo | null;
  try {
    repo = await inv<RepoInfo | null>("git_detect_repo", { cwd: resolvedCwd });
  } catch {
    // git_detect_repo failure is unexpected (it's a local-only probe);
    // proceed without isolation rather than blocking the spawn.
    return fallback;
  }
  if (!repo) return fallback;

  try {
    const worktreePath = await inv<string>("compute_worktree_path", {
      collabId,
      sessionId,
      toolId,
    });
    const branchName = `agent/${toolId}-${sessionId}`;
    const worktree = await inv<WorktreeMetadata>("git_worktree_create", {
      repoRoot: repo.root,
      worktreePath,
      branchName,
      baseRef: "origin/dev",
    });
    return {
      cwd: worktree.path,
      worktree,
      provisioningMessage: worktree.baseFresh
        ? null
        : "worktree based on stale local origin/dev (offline fallback)",
      errorStatus: null,
    };
  } catch (err) {
    const msg = String(err);
    return {
      cwd: resolvedCwd,
      worktree: null,
      provisioningMessage: `worktree provisioning failed: ${msg}`,
      errorStatus: `Spawn proceeding without worktree isolation. ${msg}`,
    };
  }
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

  // Spawn a new agent — show UI tile immediately, resolve CWD + provision
  // an isolated git worktree (if cwd is in a repo) before starting PTY.
  //
  // The worktree-provisioning step is the L1 load-bearing layer of the
  // worktree-isolation policy (v5 §2). When cwd is inside a git repo, we
  // call git_worktree_create to spawn the agent into ~/.cache/canvas-
  // terminal/worktrees/<collab>/<tool>-<session> on a fresh agent/
  // branch from origin/dev. If the repo lacks origin/dev (or local dev),
  // the spawn surfaces an actionable error in the status line — the full
  // missing-`dev` modal (D7) is P5 polish work.
  const handleSpawn = useCallback(
    (tool: ToolConfig) => {
      const sessionId = generateSessionId();
      // Add spawn immediately for instant UI feedback.
      setSpawns((prev) => [
        ...prev,
        {
          sessionId,
          tool,
          cwd: null,
          cwdReady: false,
          worktree: null,
          provisioningMessage: null,
        },
      ]);

      (async () => {
        // Phase 1: resolve CWD (existing behavior, lsof-based with 2s budget).
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
          // Fall back to null (home directory).
        }

        // Phase 2: provision an isolated worktree if cwd is in a git repo.
        // Show the "Provisioning isolated worktree…" message synchronously
        // so the user sees feedback during the network-bounded fetch.
        if (resolved && mountedRef.current) {
          setSpawns((prev) =>
            prev.map((s) =>
              s.sessionId === sessionId
                ? { ...s, provisioningMessage: "Provisioning isolated worktree…" }
                : s,
            ),
          );
        }
        const result = await provisionWorktreeForSpawn({
          resolvedCwd: resolved,
          collabId,
          sessionId,
          toolId: tool.id,
        });
        if (result.errorStatus) {
          useCollaboratorStore
            .getState()
            .setStatus(result.errorStatus, collabId, "persistent");
        }

        if (mountedRef.current) {
          setSpawns((prev) =>
            prev.map((s) =>
              s.sessionId === sessionId
                ? {
                    ...s,
                    cwd: result.cwd,
                    cwdReady: true,
                    worktree: result.worktree,
                    provisioningMessage: result.provisioningMessage,
                  }
                : s,
            ),
          );
        }
      })();
    },
    [collabId],
  );

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
                    worktree={spawn.worktree}
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
                    <div className="flex-1 flex items-center justify-center text-text-dim text-xs font-mono px-2 text-center">
                      {spawn.provisioningMessage ?? "Starting..."}
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
