import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import type { SpawnedAgent, ToolId, CollabTask } from "../types/collaborator";
import { TOOL_CONFIGS } from "../types/collaborator";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TOOL_LABELS: Record<string, string> = Object.fromEntries(
  TOOL_CONFIGS.map((t) => [t.id, t.label]),
);

export function toolLabel(tool: string): string {
  return TOOL_LABELS[tool] ?? tool;
}

/** Short name used for @-mentions (e.g. "claude", "codex", "gemini"). */
export function toolShortName(tool: ToolId): string {
  const cfg = TOOL_CONFIGS.find((t) => t.id === tool);
  return cfg?.command ?? tool;
}

/** Build a display name that disambiguates multiple sessions of the same tool. */
export function agentDisplayName(
  agent: SpawnedAgent,
  allAgents: SpawnedAgent[],
): string {
  const sameToolAgents = allAgents
    .filter((a) => a.tool === agent.tool)
    .sort((a, b) => a.sessionId.localeCompare(b.sessionId));
  const base = toolLabel(agent.tool);

  if (sameToolAgents.length <= 1) return base;

  const index =
    sameToolAgents.findIndex((a) => a.sessionId === agent.sessionId) + 1;
  return `${base} #${index}`;
}

/**
 * Build the list of @-mentionable names from the current agent set.
 * Returns entries like ["claude", "codex"] or ["claude1", "claude2", "codex"].
 */
export function mentionableNames(agents: SpawnedAgent[]): string[] {
  const names: string[] = [];
  const byTool = new Map<ToolId, SpawnedAgent[]>();
  for (const a of agents) {
    const list = byTool.get(a.tool) ?? [];
    list.push(a);
    byTool.set(a.tool, list);
  }
  for (const [tool, list] of byTool) {
    const short = toolShortName(tool);
    if (list.length === 1) {
      names.push(short);
    } else {
      list
        .sort((a, b) => a.sessionId.localeCompare(b.sessionId))
        .forEach((_, i) => names.push(`${short}${i + 1}`));
    }
  }
  return names;
}

// ---------------------------------------------------------------------------
// Conversation log
// ---------------------------------------------------------------------------

interface LogEntry {
  time: string; // HH:MM:SS
  role: "user" | "system" | "agent";
  content: string;
}

function nowTime(): string {
  return new Date().toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function formatLogEntry(e: LogEntry): string {
  const tag =
    e.role === "user" ? "User" : e.role === "agent" ? "Agent" : "System";
  return `## [${e.time}] ${tag}\n${e.content}\n`;
}

// Serialize async writes to prevent race conditions when multiple
// appendLog calls happen in quick succession.
let conversationWriteChain: Promise<unknown> = Promise.resolve();

// ---------------------------------------------------------------------------
// Task protocol — injected into every agent prompt
// ---------------------------------------------------------------------------

const TASK_PROTOCOL = `
## Agent Task Protocol

You are a participant agent in a multi-agent collaboration session. You MUST follow these rules:

### Rules
1. **Read before acting**: Before starting work, read the conversation log in the shared memory directory to understand prior context and other agents' work.
2. **Claim your task**: If a task is assigned to you, update its status in your response.
3. **Log on completion**: When your turn completes, you MUST **append** your task completion report to the conversation log file (the \`conversation-*.md\` file listed above). Do NOT create separate task report files.
4. **Be self-contained**: Include enough detail in your outputs that any other agent can understand what you did without needing to ask.
5. **Reference by task ID**: When referring to other tasks, use the task ID (e.g. "task-1-...").
6. **Signal blockers**: If you are blocked on another agent's work, explicitly state the blocking task ID and what you need.

### File Conventions
- \`tasks.md\` — **READ ONLY**. System-managed task definitions. Do not write to this file.
- \`conversation-*.md\` — Conversation log. Read for context, **append your task report here** when done.
- \`context.md\` — Shared context. Read for additional instructions.

### Task Completion Report Format
Append to the conversation log file:

\`\`\`
## [HH:MM:SS] Agent — Task Report
# [TASK_ID] — [STATUS: completed|blocked|in-progress]
**Agent**: [your name]
**Reasoning**: [Detailed reasoning process — explain WHY you chose this approach, what alternatives you considered, what trade-offs you weighed, and how you arrived at your decisions. This is the most important section.]
**Summary**: [1-3 sentences of what you did]
**Output**: [file paths, artifacts, or key results]
**Blockers**: [none, or description of what's blocking]
\`\`\`
`.trim();

/** Format tasks array into a markdown document for shared memory. */
function formatTasksMarkdown(tasks: CollabTask[]): string {
  if (tasks.length === 0) return "# Collaboration Tasks\n\nNo tasks defined yet.\n";

  const lines = ["# Collaboration Tasks\n"];
  for (const t of tasks) {
    lines.push(`## ${t.id} — ${t.status}`);
    lines.push(`**Title**: ${t.title}`);
    lines.push(`**Assignee**: ${t.assignee ?? "unassigned"}`);
    lines.push(`**Objective**: ${t.objective}`);
    if (t.context) lines.push(`**Context**: ${t.context}`);
    if (t.deliverables.length > 0) {
      lines.push("**Deliverables**:");
      for (const d of t.deliverables) lines.push(`  - ${d}`);
    }
    if (t.dependencies.length > 0) {
      lines.push(`**Dependencies**: ${t.dependencies.join(", ")}`);
    }
    if (t.completionNotes) lines.push(`**Completion Notes**: ${t.completionNotes}`);
    lines.push(`**Created**: ${t.createdAt}`);
    lines.push(`**Updated**: ${t.updatedAt}`);
    lines.push("");
  }
  return lines.join("\n");
}

/** Build a concise task summary for context header injection. */
function formatTaskSummaryForPrompt(tasks: CollabTask[]): string {
  if (tasks.length === 0) return "";
  const lines = ["\n## Active Tasks"];
  for (const t of tasks) {
    const assignee = t.assignee ?? "unassigned";
    lines.push(`- [${t.status}] ${t.id}: ${t.title} (${assignee})`);
    if (t.objective) lines.push(`  Objective: ${t.objective}`);
    if (t.deliverables.length > 0) lines.push(`  Deliverables: ${t.deliverables.join("; ")}`);
    if (t.dependencies.length > 0) lines.push(`  Depends on: ${t.dependencies.join(", ")}`);
  }
  return lines.join("\n");
}

let taskCounter = 0;

// ---------------------------------------------------------------------------
// Shared memory helpers
// ---------------------------------------------------------------------------

let memoryDirCache: string | null = null;

async function getMemoryDir(): Promise<string> {
  if (!memoryDirCache) {
    memoryDirCache = await invoke<string>("init_memory_dir");
  }
  return memoryDirCache;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

interface CollaboratorState {
  agents: SpawnedAgent[];
  statusMessage: string | null;
  inputHistory: string[];
  historyIndex: number;

  /** Current collaborator session id — null when not mounted. */
  collabSessionId: string | null;
  /** In-memory conversation log entries. */
  logEntries: LogEntry[];
  /** Structured tasks for multi-agent collaboration. */
  tasks: CollabTask[];

  // Session lifecycle
  startSession: (id: string) => void;
  endSession: () => void;

  // Agent lifecycle
  addAgent: (agent: SpawnedAgent) => void;
  removeAgent: (sessionId: string) => void;
  setAgentStatus: (
    sessionId: string,
    status: SpawnedAgent["status"],
  ) => void;
  killAllAgents: () => Promise<void>;

  // Messaging
  sendToAgent: (sessionId: string, content: string) => Promise<void>;
  broadcastToAll: (content: string) => Promise<void>;
  setStatus: (msg: string | null) => void;
  appendLog: (
    role: LogEntry["role"],
    content: string,
  ) => void;

  // Task management
  addTask: (opts: {
    title: string;
    objective: string;
    context?: string;
    deliverables?: string[];
    assignee?: string | null;
    dependencies?: string[];
  }) => CollabTask;
  updateTask: (
    taskId: string,
    updates: Partial<Pick<CollabTask, "status" | "assignee" | "completionNotes">>,
  ) => void;
  getTasks: () => CollabTask[];
  persistTasks: () => Promise<void>;

  // Input history
  pushHistory: (input: string) => void;
  navigateHistory: (direction: "up" | "down") => string | null;
}

/** Build context header prepended to every message sent to agents. */
async function prependContextHeader(
  text: string,
  collabSessionId: string | null,
  tasks: CollabTask[],
): Promise<string> {
  const dir = await getMemoryDir();
  const parts: string[] = [];

  parts.push(`[Collaborator shared memory: ${dir}]`);

  if (collabSessionId) {
    parts.push(
      `[Conversation log: ${dir}/conversation-${collabSessionId}.md]`,
    );
  }

  parts.push(`[Task definitions: ${dir}/tasks.md]`);

  try {
    const content = await invoke<string | null>("read_memory_file", {
      relativePath: "context.md",
    });
    if (content) {
      parts.push(`[Shared context: ${dir}/context.md]`);
    }
  } catch {
    // No context file
  }

  parts.push(
    "[To share notes with other agents, write files to the shared memory directory above.]",
  );

  // Inject task protocol and active task summary
  parts.push(TASK_PROTOCOL);
  const taskSummary = formatTaskSummaryForPrompt(tasks);
  if (taskSummary) parts.push(taskSummary);

  parts.push(text);
  return parts.join("\n");
}

export const useCollaboratorStore = create<CollaboratorState>((set, get) => ({
  agents: [],
  statusMessage: null,
  inputHistory: [],
  historyIndex: -1,
  collabSessionId: null,
  logEntries: [],
  tasks: [],

  // -- Session lifecycle --------------------------------------------------

  startSession: (id) => {
    taskCounter = 0;
    set({ collabSessionId: id, logEntries: [], agents: [], tasks: [], statusMessage: null });
  },

  endSession: () => {
    taskCounter = 0;
    set({ collabSessionId: null, logEntries: [], agents: [], tasks: [], statusMessage: null });
  },

  // -- Agent lifecycle ----------------------------------------------------

  addAgent: (agent) => {
    set((s) => ({ agents: [...s.agents, agent] }));
  },

  removeAgent: (sessionId) => {
    set((s) => ({ agents: s.agents.filter((a) => a.sessionId !== sessionId) }));
  },

  setAgentStatus: (sessionId, status) => {
    set((s) => ({
      agents: s.agents.map((a) =>
        a.sessionId === sessionId ? { ...a, status } : a,
      ),
    }));
  },

  killAllAgents: async () => {
    const { agents } = get();
    for (const agent of agents) {
      try {
        await invoke("kill_pty", { sessionId: agent.sessionId });
      } catch {
        // Already dead
      }
    }
    taskCounter = 0;
    set({ agents: [], tasks: [] });
    try {
      await invoke("clear_memory_dir");
    } catch {
      // Non-critical
    }
  },

  // -- Messaging ----------------------------------------------------------

  sendToAgent: async (sessionId, content) => {
    try {
      const { agents, collabSessionId, tasks } = get();
      const agent = agents.find((a) => a.sessionId === sessionId);
      const tool = agent?.tool ?? null;
      const text = await prependContextHeader(content, collabSessionId, tasks);
      await invoke("inject_into_pty", { sessionId, text, tool });
      const label = agent ? toolLabel(agent.tool) : sessionId;
      set({ statusMessage: `Sent to ${label}` });
      get().appendLog("user", `@${agent ? toolShortName(agent.tool) : "?"} ${content}`);
    } catch (err) {
      set({ statusMessage: `Error: ${err}` });
    }
  },

  broadcastToAll: async (content) => {
    const { agents, collabSessionId, tasks } = get();
    if (agents.length === 0) {
      set({ statusMessage: "No agents running. Launch a tool first." });
      return;
    }
    const text = await prependContextHeader(content, collabSessionId, tasks);
    let sent = 0;
    for (const agent of agents) {
      try {
        await invoke("inject_into_pty", {
          sessionId: agent.sessionId,
          text,
          tool: agent.tool,
        });
        sent++;
      } catch {
        // Skip failed
      }
    }
    set({
      statusMessage: `Broadcast sent to ${sent} agent${sent !== 1 ? "s" : ""}`,
    });
    get().appendLog("user", `@all ${content}`);
  },

  setStatus: (msg) => set({ statusMessage: msg }),

  appendLog: (role, content) => {
    const entry: LogEntry = { time: nowTime(), role, content };
    const entries = [...get().logEntries, entry];
    set({ logEntries: entries });

    // Persist by reading existing file first, then appending.
    // This preserves any content agents wrote directly to the file
    // (e.g. task reports appended via their own tools).
    // Writes are serialized via conversationWriteChain to prevent races.
    const { collabSessionId } = get();
    if (collabSessionId) {
      const relPath = `conversation-${collabSessionId}.md`;
      const newBlock = formatLogEntry(entry);
      conversationWriteChain = conversationWriteChain.then(() =>
        invoke<string | null>("read_memory_file", { relativePath: relPath })
          .then((existing) => {
            const base = existing ?? "# Collaborator Conversation Log\n";
            return invoke("write_memory_file", {
              relativePath: relPath,
              content: base + "\n" + newBlock,
            });
          })
          .catch(() => {}),
      );
    }
  },

  // -- Task management ----------------------------------------------------

  addTask: (opts) => {
    taskCounter++;
    const now = new Date().toISOString();
    const task: CollabTask = {
      id: `task-${taskCounter}-${Date.now()}`,
      title: opts.title,
      objective: opts.objective,
      context: opts.context ?? "",
      deliverables: opts.deliverables ?? [],
      assignee: opts.assignee ?? null,
      dependencies: opts.dependencies ?? [],
      status: "pending",
      completionNotes: null,
      createdAt: now,
      updatedAt: now,
    };
    set((s) => ({ tasks: [...s.tasks, task] }));
    get().appendLog("system", `Task created: ${task.id} — ${task.title}`);
    get().persistTasks();
    return task;
  },

  updateTask: (taskId, updates) => {
    set((s) => ({
      tasks: s.tasks.map((t) =>
        t.id === taskId
          ? { ...t, ...updates, updatedAt: new Date().toISOString() }
          : t,
      ),
    }));
    const task = get().tasks.find((t) => t.id === taskId);
    if (task) {
      get().appendLog("system", `Task updated: ${taskId} → ${task.status}`);
    }
    get().persistTasks();
  },

  getTasks: () => get().tasks,

  persistTasks: async () => {
    const { tasks } = get();
    try {
      await invoke("write_memory_file", {
        relativePath: "tasks.md",
        content: formatTasksMarkdown(tasks),
      });
    } catch {
      // Non-critical
    }
  },

  // -- Input history ------------------------------------------------------

  pushHistory: (input) => {
    set((s) => ({
      inputHistory: [...s.inputHistory, input],
      historyIndex: -1,
    }));
  },

  navigateHistory: (direction) => {
    const { inputHistory, historyIndex } = get();
    if (inputHistory.length === 0) return null;

    let newIndex: number;
    if (direction === "up") {
      newIndex =
        historyIndex === -1
          ? inputHistory.length - 1
          : Math.max(0, historyIndex - 1);
    } else {
      if (historyIndex === -1) return null;
      newIndex = historyIndex + 1;
      if (newIndex >= inputHistory.length) {
        set({ historyIndex: -1 });
        return "";
      }
    }

    set({ historyIndex: newIndex });
    return inputHistory[newIndex] ?? null;
  },
}));
