import { useCollaboratorStore } from "../../stores/collaboratorStore";

interface SwarmDrawerProps {
  leaderSessionId: string;
  open: boolean;
}

const STATUS_DOT: Record<string, string> = {
  pending: "bg-text-dim",
  running: "bg-cyan-400 animate-pulse",
  done: "bg-green-400",
  errored: "bg-red-400",
  stalled: "bg-amber-400",
};

const TOOL_LETTER: Record<string, string> = {
  claude_code: "C",
  codex_cli: "X",
  gemini_cli: "G",
  copilot_cli: "P",
};

/**
 * Collapsible drawer rendered under the leader's xterm. Per-task chip with
 * status dot, tool letter, role hint, last-line preview, runtime. Click-to-modal
 * stdout viewer is Phase 2 per plan v5 §11.
 */
export function SwarmDrawer({ leaderSessionId, open }: SwarmDrawerProps) {
  const fsdState = useCollaboratorStore(
    (s) => s.fsdByLeaderSessionId[leaderSessionId] ?? null,
  );
  if (!open || fsdState == null) return null;

  const tasks = fsdState.tasks;
  if (tasks.length === 0) {
    return (
      <div className="px-3 py-2 text-[11px] text-text-dim font-mono border-t border-surface-lighter bg-surface-light">
        No FSD tasks yet — leader will dispatch when it emits its first plan.
      </div>
    );
  }

  return (
    <div className="border-t border-surface-lighter bg-surface-light max-h-[200px] overflow-y-auto">
      <div className="px-3 py-1 text-[10px] uppercase tracking-wider text-text-dim border-b border-surface-lighter">
        Swarm — {tasks.length} task{tasks.length !== 1 ? "s" : ""} · turn {fsdState.turn}
      </div>
      {tasks.map((t) => {
        const dot = STATUS_DOT[t.status] ?? "bg-text-dim";
        const letter = TOOL_LETTER[t.tool] ?? "?";
        const wallclock = t.wallclockMs > 0 ? `${(t.wallclockMs / 1000).toFixed(1)}s` : "—";
        return (
          <div
            key={t.taskId}
            className="flex items-center gap-2 px-3 py-1 text-[11px] font-mono border-b border-surface-lighter/40 last:border-b-0"
          >
            <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${dot}`} />
            <span className="font-bold w-4 text-center text-text-dim shrink-0">{letter}</span>
            <span className="text-cyan-400 shrink-0">{t.taskId}</span>
            {t.roleHint && (
              <span className="text-purple-400 italic shrink-0">{t.roleHint}</span>
            )}
            <span className="flex-1 min-w-0 truncate text-text-dim">
              {t.lastLine ?? <span className="opacity-50">(no output yet)</span>}
            </span>
            <span className="text-text-dim shrink-0">{wallclock}</span>
            {t.exitCode != null && (
              <span className={`shrink-0 ${t.exitCode === 0 ? "text-green-400" : "text-red-400"}`}>
                exit {t.exitCode}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}
