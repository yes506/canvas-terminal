import { TOOL_CONFIGS } from "../../types/collaborator";
import type { ToolConfig, SpawnedAgent } from "../../types/collaborator";

interface AgentToolbarProps {
  onSpawn: (tool: ToolConfig) => void;
  agents: SpawnedAgent[];
}

const TOOL_ICONS: Record<string, string> = {
  claude_code: "C",
  codex_cli: "X",
  gemini_cli: "G",
};

export function AgentToolbar({ onSpawn, agents }: AgentToolbarProps) {
  return (
    <div className="flex items-center gap-1.5 px-3 py-1.5 border-b border-surface-lighter bg-surface text-xs shrink-0">
      {TOOL_CONFIGS.map((tool) => {
        const count = agents.filter((a) => a.tool === tool.id).length;
        return (
          <button
            key={tool.id}
            className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md border border-surface-lighter hover:border-accent hover:bg-surface-light transition-colors ${tool.colorClass}`}
            onClick={() => onSpawn(tool)}
            title={`Launch ${tool.label}`}
          >
            <span className="font-bold text-[10px] w-4 h-4 flex items-center justify-center rounded bg-surface-lighter">
              {TOOL_ICONS[tool.id] ?? "?"}
            </span>
            <span className="font-medium">{tool.label}</span>
            {count > 0 && (
              <span className="ml-0.5 px-1 py-0 rounded-full bg-surface-lighter text-text-dim text-[10px]">
                {count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
