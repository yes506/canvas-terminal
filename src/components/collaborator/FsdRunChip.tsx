import { useCollaboratorStore } from "../../stores/collaboratorStore";

interface FsdRunChipProps {
  leaderSessionId: string;
  onClick?: () => void;
}

/**
 * Compact run-status chip rendered next to the lifecycle dot in the
 * AgentMiniTerminal header. Shows `turn N · K/M ✓` summary; click → toggle drawer.
 */
export function FsdRunChip({ leaderSessionId, onClick }: FsdRunChipProps) {
  const fsdState = useCollaboratorStore(
    (s) => s.fsdByLeaderSessionId[leaderSessionId] ?? null,
  );
  if (fsdState == null || fsdState.tier === "off") return null;

  const total = fsdState.tasks.length;
  const ok = fsdState.tasks.filter((t) => t.status === "done" && t.exitCode === 0).length;
  const errored = fsdState.tasks.filter((t) => t.status === "errored").length;
  const running = fsdState.tasks.filter((t) => t.status === "running" || t.status === "pending").length;

  let statusTone = "text-text-dim";
  if (fsdState.status === "done") statusTone = "text-green-400";
  else if (fsdState.status === "blocked" || fsdState.status === "cancelled") statusTone = "text-red-400";
  else if (fsdState.status === "cap_tripped" || fsdState.status === "interrupted") statusTone = "text-amber-400";
  else if (running > 0) statusTone = "text-cyan-400";

  let summary: string;
  if (fsdState.activeRunId == null) {
    summary = "FSD ready";
  } else if (fsdState.status === "done") {
    summary = `done · ${ok}/${total} ✓`;
  } else if (fsdState.status === "blocked") {
    summary = "blocked";
  } else if (fsdState.status === "cancelled") {
    summary = "cancelled";
  } else if (fsdState.status === "cap_tripped") {
    summary = "cap-tripped";
  } else if (fsdState.status === "interrupted") {
    summary = "interrupted";
  } else if (total === 0) {
    summary = `turn ${fsdState.turn}`;
  } else {
    summary = `turn ${fsdState.turn} · ${ok}/${total} ✓` + (errored > 0 ? ` · ${errored} ⚠` : "");
  }

  return (
    <button
      type="button"
      onClick={onClick}
      className={`px-1.5 py-0.5 text-[10px] font-mono rounded border border-surface-lighter shrink-0 hover:bg-surface-lighter transition-colors ${statusTone}`}
      title="FSD run status — click to open swarm drawer"
    >
      {summary}
    </button>
  );
}
