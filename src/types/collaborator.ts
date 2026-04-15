export type ToolId = "claude_code" | "codex_cli" | "gemini_cli";

export interface ToolConfig {
  id: ToolId;
  label: string;
  command: string;
  colorClass: string;
}

export const TOOL_CONFIGS: ToolConfig[] = [
  { id: "claude_code", label: "Claude Code", command: "claude", colorClass: "text-purple-400" },
  { id: "codex_cli", label: "Codex CLI", command: "codex", colorClass: "text-orange-400" },
  { id: "gemini_cli", label: "Gemini CLI", command: "gemini", colorClass: "text-blue-400" },
];

export interface SpawnedAgent {
  sessionId: string;
  tool: ToolId;
  status: "spawning" | "running" | "exited";
  /** Which collaborator pane owns this agent. */
  collabSessionId: string;
}

// ---------------------------------------------------------------------------
// Structured Task
// ---------------------------------------------------------------------------

export type TaskStatus = "pending" | "in-progress" | "completed" | "blocked";

export interface CollabTask {
  /** Unique task id, e.g. "task-1-1713100000000" */
  id: string;
  /** Human-readable title */
  title: string;
  /** Detailed objective — what the agent must accomplish */
  objective: string;
  /** Background context for the agent to understand the task */
  context: string;
  /** Concrete deliverables expected */
  deliverables: string[];
  /** Assigned agent mention name (e.g. "@claude", "@codex1"), or null for unassigned */
  assignee: string | null;
  /** Dependencies — task IDs or descriptions this task depends on */
  dependencies: string[];
  /** Current status */
  status: TaskStatus;
  /** Free-form notes (agents append here when their turn completes) */
  completionNotes: string | null;
  /** ISO timestamp of creation */
  createdAt: string;
  /** ISO timestamp of last update */
  updatedAt: string;
}
