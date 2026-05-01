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
  /**
   * Spawn lifecycle:
   *  - `pending`: provisioning in flight; placeholder shows progress.
   *  - `ready`: cwd resolved and (if applicable) worktree created;
   *             AgentMiniTerminal mounts and the PTY launches.
   *  - `blocked`: in a git repo but worktree provisioning failed —
   *               PTY does NOT mount; placeholder shows the reason
   *               and a Cancel button. This is the load-bearing
   *               fail-closed path that prevents a non-isolated agent
   *               from running in the shared checkout (codex1 task-53
   *               H1 / codex2 task-55 High / claude3 task-56).
   */
  status: "pending" | "ready" | "blocked";
  /** Worktree metadata when status === "ready" and cwd is in a git repo.
   *  null otherwise (no-repo case, or non-git cwd). Threaded into
   *  AgentMiniTerminal which forwards it to addAgent so the store
   *  record carries it for P2's awaiting-approval gate. */
  worktree: WorktreeMetadata | null;
  /** One-line note for the placeholder UI (success path: nothing or
   *  "Provisioning isolated worktree…" or stale-base warning;
   *  blocked path: the actionable error reason). */
  provisioningMessage: string | null;
}

/**
 * Result of `provisionWorktreeForSpawn`. Tagged union — the closure
 * inside `handleSpawn` switches on `outcome` to decide whether to mount
 * the PTY (`ok`/`no-repo`) or block the spawn entirely (`blocked`).
 *
 * `blocked` is the **fail-closed** path required by the v5 L1 invariant
 * (codex1 task-53 H1, codex2 task-55 High, claude3 task-56): when cwd is
 * inside a git repo but worktree provisioning fails, the agent must NOT
 * be spawned in the parent repo, because a non-isolated agent + P2's
 * `worktree != null` gate condition silently bypasses the approval gate.
 */
export type ProvisioningResult =
  | {
      outcome: "ok";
      /** PTY runs INSIDE the worktree. */
      cwd: string;
      worktree: WorktreeMetadata;
      /** One-line note for the spawn placeholder (e.g., stale-base
       *  warning). null when nothing is worth surfacing. */
      provisioningMessage: string | null;
    }
  | {
      outcome: "no-repo";
      /** PTY runs in the resolved cwd (or null = home dir). No worktree
       *  isolation because the cwd isn't in a git repo at all. */
      cwd: string | null;
    }
  | {
      outcome: "blocked";
      /** Reason to show in the placeholder. Concrete (backend error
       *  string) so the user knows what to fix. */
      reason: string;
      /** Optional persistent status-line message. */
      errorStatus: string | null;
    };

/**
 * Decide whether `resolvedCwd` is a git repo and, if so, provision a
 * fresh per-agent worktree from `origin/dev`. Pure-ish helper exported
 * for testing: every effect is via the injected `invoke` shim.
 *
 * Three outcomes:
 *  - `ok`: cwd is in a repo and the worktree is provisioned. PTY mounts
 *          INSIDE the worktree.
 *  - `no-repo`: cwd is not in a git repo. PTY mounts in cwd (no L1
 *               isolation, because there's no shared checkout to protect).
 *  - `blocked`: cwd IS in a git repo but provisioning failed (most
 *               commonly the missing-`dev` case, OR `git_detect_repo`
 *               itself errored). The caller MUST NOT mount the PTY
 *               because doing so would put a non-isolated agent on the
 *               shared checkout — P2's gate would then silently auto-
 *               complete its tasks (worktree=null bypass).
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

  if (!resolvedCwd) {
    // No active terminal, no cwd to probe → spawn at home dir, no
    // isolation needed because there's no shared checkout in scope.
    return { outcome: "no-repo", cwd: null };
  }

  let repo: RepoInfo | null;
  try {
    repo = await inv<RepoInfo | null>("git_detect_repo", { cwd: resolvedCwd });
  } catch (err) {
    // Probe error inside an arbitrary cwd: we can't tell if it's a git
    // repo or not. Block to be safe — claude2 Concern 4 + codex2 Med-#3:
    // "unknown" must not mean "spawn unisolated."
    console.warn("[collab/spawn] git_detect_repo failed:", err);
    return {
      outcome: "blocked",
      reason: `Could not determine whether ${resolvedCwd} is a git repo: ${String(err)}`,
      errorStatus: null,
    };
  }
  if (!repo) {
    // Definitely not a git repo. Safe to spawn in cwd.
    return { outcome: "no-repo", cwd: resolvedCwd };
  }

  // From here on: cwd IS in a git repo. Any failure must block, NOT
  // fall through to a parent-repo spawn (codex1 H1 / codex2 High).
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
      outcome: "ok",
      cwd: worktree.path,
      worktree,
      provisioningMessage: worktree.baseFresh
        ? null
        : "worktree based on stale local origin/dev (offline fallback)",
    };
  } catch (err) {
    const msg = String(err);
    return {
      outcome: "blocked",
      reason: msg,
      // claude3 task-60 minor wording fix: don't reference policy.json
      // because the D7 modal that consumes it isn't shipped in v1.
      // Point the user at concrete actions they can take right now.
      errorStatus: `Cannot spawn collaborator agent: worktree provisioning failed (${msg}). Create a \`dev\` branch in this repo (\`git branch dev\`) or spawn outside this repo.`,
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
          status: "pending",
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
        if (!mountedRef.current) return;

        // Tagged-union dispatch: each branch sets the spawn status
        // explicitly. The `blocked` branch is the load-bearing safety
        // path — placeholder stays without a PTY mount.
        switch (result.outcome) {
          case "ok":
            setSpawns((prev) =>
              prev.map((s) =>
                s.sessionId === sessionId
                  ? {
                      ...s,
                      cwd: result.cwd,
                      status: "ready",
                      worktree: result.worktree,
                      provisioningMessage: result.provisioningMessage,
                    }
                  : s,
              ),
            );
            break;
          case "no-repo":
            setSpawns((prev) =>
              prev.map((s) =>
                s.sessionId === sessionId
                  ? {
                      ...s,
                      cwd: result.cwd,
                      status: "ready",
                      worktree: null,
                      provisioningMessage: null,
                    }
                  : s,
              ),
            );
            break;
          case "blocked":
            // FAIL-CLOSED: PTY does NOT mount. Placeholder shows the
            // actionable error + Cancel button. User must dismiss the
            // failed spawn and either fix the underlying issue
            // (configure a non-main base in policy.json, create a `dev`
            // branch, or spawn outside the repo) before launching again.
            if (result.errorStatus) {
              useCollaboratorStore
                .getState()
                .setStatus(result.errorStatus, collabId, "persistent");
            }
            setSpawns((prev) =>
              prev.map((s) =>
                s.sessionId === sessionId
                  ? {
                      ...s,
                      cwd: null,
                      status: "blocked",
                      worktree: null,
                      provisioningMessage: result.reason,
                    }
                  : s,
              ),
            );
            break;
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
              {spawns.map((spawn) => {
                if (spawn.status === "ready") {
                  return (
                    <AgentMiniTerminal
                      key={spawn.sessionId}
                      sessionId={spawn.sessionId}
                      tool={spawn.tool}
                      cwd={spawn.cwd}
                      worktree={spawn.worktree}
                      onClose={handleClose}
                    />
                  );
                }
                // Blocked: fail-closed placeholder — provisioning failed
                // inside a git repo. Show reason + Cancel; do NOT mount
                // a PTY. (codex1 H1 / codex2 High / claude3 fail-closed.)
                if (spawn.status === "blocked") {
                  return (
                    <div
                      key={spawn.sessionId}
                      className="flex flex-col h-full min-h-0 border rounded-md overflow-hidden border-red-500/40"
                    >
                      <div className="flex items-center gap-2 px-2 py-1 bg-surface-light border-b border-surface-lighter text-xs shrink-0">
                        <span className="w-1.5 h-1.5 rounded-full shrink-0 bg-red-400" />
                        <span
                          className={`font-bold ${spawn.tool.colorClass} truncate`}
                        >
                          {spawn.tool.label}
                        </span>
                        <span className="text-red-300 text-[10px] uppercase tracking-wider">
                          spawn blocked
                        </span>
                        <div className="flex-1" />
                        <button
                          className="text-text-dim hover:text-red-400 transition-colors p-0.5 shrink-0"
                          onClick={() => handleClose(spawn.sessionId)}
                          title="Cancel this spawn"
                          aria-label="Cancel blocked spawn"
                        >
                          <X size={12} />
                        </button>
                      </div>
                      <div className="flex-1 flex flex-col items-center justify-center text-xs font-mono px-3 py-2 gap-2 text-center">
                        <p className="text-red-300">
                          Worktree provisioning failed — agent not started.
                        </p>
                        <p className="text-text-dim break-words max-h-24 overflow-y-auto">
                          {spawn.provisioningMessage}
                        </p>
                        <p className="text-text-dim text-[11px]">
                          Configure a non-main base, create a <code>dev</code>{" "}
                          branch, or spawn outside this repo.
                        </p>
                      </div>
                    </div>
                  );
                }
                // Pending — provisioning in flight. Existing placeholder.
                return (
                  <div
                    key={spawn.sessionId}
                    className="flex flex-col h-full min-h-0 border rounded-md overflow-hidden border-surface-lighter"
                  >
                    <div className="flex items-center gap-2 px-2 py-1 bg-surface-light border-b border-surface-lighter text-xs shrink-0">
                      <span className="w-1.5 h-1.5 rounded-full shrink-0 bg-yellow-400 animate-pulse" />
                      <span
                        className={`font-bold ${spawn.tool.colorClass} truncate`}
                      >
                        {spawn.tool.label}
                      </span>
                    </div>
                    <div className="flex-1 flex items-center justify-center text-text-dim text-xs font-mono px-2 text-center">
                      {spawn.provisioningMessage ?? "Starting..."}
                    </div>
                  </div>
                );
              })}
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
