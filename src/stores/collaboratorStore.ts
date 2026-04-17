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

You are a participant in a multi-agent collaboration.

### Rules
1. **Read before acting**: Read the conversation log and \`context.md\` (if present) in the shared memory directory to understand prior context and other agents' work.
2. **Be self-contained**: Include enough detail that any other agent can understand what you did.
3. **Reference by task ID** (e.g. "task-1-...").
4. **Signal blockers**: State the blocking task ID and what you need.
5. **Signal completion**: When done, write a JSON file to the shared memory directory to signal task completion. The system will automatically update the task and generate a report in the conversation log.

\`\`\`bash
cat > SHARED_MEMORY_DIR/TASK_ID.done.json << 'EOF'
{
  "task_id": "TASK_ID",
  "status": "completed",
  "reasoning": "Why this approach, alternatives considered, trade-offs",
  "conclusion": "What was decided/done (1-3 sentences)",
  "output": "file paths, artifacts, or key results"
}
EOF
\`\`\`

Replace \`SHARED_MEMORY_DIR\` with the path shown above and \`TASK_ID\` with your assigned task ID.

### File Conventions
- \`conversation-*.md\` — **Read only** for context. Do NOT write to it directly. The system appends task reports automatically when task status changes.
- Task definitions file — **READ ONLY**.
- \`context.md\` — Shared context (if present).
- Shared memory directory — Write files here to share artifacts with other agents.
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
    if (t.reasoning) lines.push(`**Reasoning**: ${t.reasoning}`);
    if (t.conclusion) lines.push(`**Conclusion**: ${t.conclusion}`);
    if (t.output) lines.push(`**Output**: ${t.output}`);
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

function taskFileRelativePath(collabSessionId: string): string {
  return `tasks-${collabSessionId}.md`;
}

function ensureSessionMemoryFiles(collabSessionId: string): void {
  const conversationPath = `conversation-${collabSessionId}.md`;
  invoke<string | null>("read_memory_file", {
    relativePath: conversationPath,
  })
    .then((existing) => {
      if (existing === null) {
        return invoke("write_memory_file", {
          relativePath: conversationPath,
          content: "# Collaborator Conversation Log\n",
        });
      }
      return null;
    })
    .catch(() => {});

  const tasksPath = taskFileRelativePath(collabSessionId);
  invoke<string | null>("read_memory_file", {
    relativePath: tasksPath,
  })
    .then((existing) => {
      if (existing === null) {
        return invoke("write_memory_file", {
          relativePath: tasksPath,
          content: formatTasksMarkdown([]),
        });
      }
      return null;
    })
    .catch(() => {});
}

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
  statusMessages: Record<string, string>;
  inputHistory: string[];
  historyIndex: number;
  /** In-memory conversation log entries, keyed by collaborator session. */
  logEntriesBySession: Record<string, LogEntry[]>;
  /** Structured tasks for multi-agent collaboration, keyed by collaborator session. */
  tasksBySession: Record<string, CollabTask[]>;
  /** Prefilled input value set externally (e.g. canvas toolbar), keyed by collabSessionId. */
  pendingInputs: Record<string, string>;

  // Session lifecycle
  startSession: (id: string) => void;
  endSession: (forSession: string) => void;

  // Agent lifecycle
  addAgent: (agent: SpawnedAgent) => void;
  removeAgent: (sessionId: string) => void;
  setAgentStatus: (
    sessionId: string,
    status: SpawnedAgent["status"],
  ) => void;
  killAllAgents: (forSession?: string) => Promise<void>;
  /** Return agents belonging to a specific collaborator session. */
  getSessionAgents: (forSession: string) => SpawnedAgent[];

  // Messaging
  sendToAgent: (sessionId: string, content: string) => Promise<void>;
  broadcastToAll: (content: string, forSession?: string) => Promise<void>;
  setStatus: (msg: string | null, forSession?: string) => void;
  getStatus: (forSession: string) => string | null;
  appendLog: (
    role: LogEntry["role"],
    content: string,
    forSession: string,
  ) => void;

  // Input prefill (scoped per collaborator session)
  setPendingInput: (collabSessionId: string, input: string | null) => void;

  // Task management
  addTask: (opts: {
    title: string;
    objective: string;
    context?: string;
    deliverables?: string[];
    assignee?: string | null;
    dependencies?: string[];
  }, forSession: string) => CollabTask;
  updateTask: (
    taskId: string,
    updates: Partial<Pick<CollabTask, "status" | "assignee" | "reasoning" | "conclusion" | "output">>,
    forSession: string,
  ) => void;
  getTasks: (forSession: string) => CollabTask[];
  persistTasks: (forSession: string) => Promise<void>;

  // Input history
  pushHistory: (input: string) => void;
  navigateHistory: (direction: "up" | "down") => string | null;
}

/**
 * Scan shared memory for task completion signal files (*.done.json).
 * Agents write these files to signal task completion with structured data.
 *
 * Expected format:
 * ```json
 * {
 *   "task_id": "task-1-...",
 *   "status": "completed",
 *   "reasoning": "...",
 *   "conclusion": "...",
 *   "output": "..."
 * }
 * ```
 */
export async function scanForTaskCompletions(forSession: string): Promise<void> {
  try {
    const files = await invoke<string[]>("list_memory_files");
    const doneFiles = files.filter((f) => f.endsWith(".done.json"));
    if (doneFiles.length === 0) return;

    const store = useCollaboratorStore.getState();
    const tasks = store.getTasks(forSession);
    if (tasks.length === 0) return;

    for (const relPath of doneFiles) {
      try {
        const raw = await invoke<string | null>("read_memory_file", { relativePath: relPath });
        if (!raw) continue;
        const data = JSON.parse(raw) as {
          task_id?: string;
          status?: string;
          reasoning?: string;
          conclusion?: string;
          output?: string;
        };
        if (!data.task_id) continue;

        // Find matching task
        const task = tasks.find((t) => t.id === data.task_id || t.id.startsWith(data.task_id!));
        if (!task) continue;
        // Skip if already in terminal state
        if (task.status === "completed" || task.status === "blocked") continue;

        const status = data.status === "blocked" ? "blocked" : "completed";
        store.updateTask(task.id, {
          status: status as CollabTask["status"],
          reasoning: data.reasoning ?? null,
          conclusion: data.conclusion ?? null,
          output: data.output ?? null,
        }, forSession);

        // Delete the signal file after processing
        await invoke("delete_memory_file", { relativePath: relPath });
      } catch {
        // Skip malformed files
      }
    }
  } catch {
    // Non-critical
  }
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
    parts.push(`[Task definitions: ${dir}/${taskFileRelativePath(collabSessionId)}]`);
  } else {
    parts.push(`[Task definitions: ${dir}/tasks.md]`);
  }

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
  statusMessages: {},
  inputHistory: [],
  historyIndex: -1,
  logEntriesBySession: {},
  tasksBySession: {},
  pendingInputs: {},

  // -- Session lifecycle --------------------------------------------------

  startSession: (id) => {
    set((s) => ({
      logEntriesBySession: s.logEntriesBySession[id]
        ? s.logEntriesBySession
        : { ...s.logEntriesBySession, [id]: [] },
      tasksBySession: s.tasksBySession[id]
        ? s.tasksBySession
        : { ...s.tasksBySession, [id]: [] },
      statusMessages: s.statusMessages[id]
        ? s.statusMessages
        : s.statusMessages,
      agents: s.agents.filter((a) => a.collabSessionId !== id),
    }));
    ensureSessionMemoryFiles(id);
  },

  endSession: (forSession) => {
    set((s) => {
      const { [forSession]: _status, ...statusMessages } = s.statusMessages;
      const { [forSession]: _logs, ...logEntriesBySession } = s.logEntriesBySession;
      const { [forSession]: _tasks, ...tasksBySession } = s.tasksBySession;
      const { [forSession]: _pending, ...pendingInputs } = s.pendingInputs;
      return {
        statusMessages,
        logEntriesBySession,
        tasksBySession,
        pendingInputs,
        agents: s.agents.filter((a) => a.collabSessionId !== forSession),
      };
    });
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

  killAllAgents: async (forSession) => {
    const { agents } = get();
    const sid = forSession;
    const toKill = sid ? agents.filter((a) => a.collabSessionId === sid) : agents;
    for (const agent of toKill) {
      try {
        await invoke("kill_pty", { sessionId: agent.sessionId });
      } catch {
        // Already dead
      }
    }
    taskCounter = 0;
    if (sid) {
      set((s) => ({
        agents: s.agents.filter((a) => a.collabSessionId !== sid),
      }));
    } else {
      set({ agents: [] });
    }
    if (sid) {
      try {
        await invoke("delete_memory_file", {
          relativePath: `conversation-${sid}.md`,
        });
      } catch {
        // Non-critical — file may not exist
      }
      try {
        await invoke("delete_memory_file", {
          relativePath: taskFileRelativePath(sid),
        });
      } catch {
        // Non-critical — file may not exist
      }
    }
  },

  getSessionAgents: (forSession) => {
    return get().agents.filter((a) => a.collabSessionId === forSession);
  },

  // -- Messaging ----------------------------------------------------------

  sendToAgent: async (sessionId, content) => {
    try {
      const { agents, tasksBySession } = get();
      const agent = agents.find((a) => a.sessionId === sessionId);
      const tool = agent?.tool ?? null;
      const agentCollabId = agent?.collabSessionId ?? null;
      // Auto-create a task if none exist for this session
      if (agentCollabId) {
        const existing = tasksBySession[agentCollabId] ?? [];
        const hasActiveTask = existing.some((t) =>
          t.assignee === `@${agent ? toolShortName(agent.tool) : "?"}` &&
          (t.status === "pending" || t.status === "in-progress"),
        );
        if (!hasActiveTask) {
          const title = content.length > 60 ? content.substring(0, 57) + "..." : content;
          get().addTask({
            title,
            objective: content,
            assignee: `@${agent ? toolShortName(agent.tool) : "?"}`,
          }, agentCollabId);
        }
      }
      const sessionTasks = agentCollabId ? (get().tasksBySession[agentCollabId] ?? []) : [];
      const text = await prependContextHeader(content, agentCollabId, sessionTasks);
      await invoke("inject_into_pty", { sessionId, text, tool });
      const label = agent ? toolLabel(agent.tool) : sessionId;
      if (agentCollabId) {
        get().setStatus(`Sent to ${label}`, agentCollabId);
        get().appendLog("user", `@${agent ? toolShortName(agent.tool) : "?"} ${content}`, agentCollabId);
      }
    } catch (err) {
      const { agents } = get();
      const agent = agents.find((a) => a.sessionId === sessionId);
      if (agent?.collabSessionId) {
        get().setStatus(`Error: ${err}`, agent.collabSessionId);
      }
    }
  },

  broadcastToAll: async (content, forSession) => {
    const { agents, tasksBySession } = get();
    const sid = forSession ?? null;
    const targetAgents = sid ? agents.filter((a) => a.collabSessionId === sid) : agents;
    if (targetAgents.length === 0) {
      if (sid) get().setStatus("No agents running. Launch a tool first.", sid);
      return;
    }
    // Auto-create tasks for each agent if none exist
    if (sid) {
      for (const agent of targetAgents) {
        const existing = tasksBySession[sid] ?? [];
        const mention = `@${toolShortName(agent.tool)}`;
        const hasActiveTask = existing.some((t) =>
          t.assignee === mention &&
          (t.status === "pending" || t.status === "in-progress"),
        );
        if (!hasActiveTask) {
          const title = content.length > 60 ? content.substring(0, 57) + "..." : content;
          get().addTask({
            title,
            objective: content,
            assignee: mention,
          }, sid);
        }
      }
    }
    const text = await prependContextHeader(content, sid, sid ? (get().tasksBySession[sid] ?? []) : []);
    let sent = 0;
    for (const agent of targetAgents) {
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
    if (sid) {
      get().setStatus(`Broadcast sent to ${sent} agent${sent !== 1 ? "s" : ""}`, sid);
      get().appendLog("user", `@all ${content}`, sid);
    }
  },

  setStatus: (msg, forSession) => {
    if (!forSession) return;
    set((s) => {
      if (msg === null) {
        const { [forSession]: _, ...rest } = s.statusMessages;
        return { statusMessages: rest };
      }
      return { statusMessages: { ...s.statusMessages, [forSession]: msg } };
    });
  },

  getStatus: (forSession) => get().statusMessages[forSession] ?? null,

  appendLog: (role, content, forSession) => {
    const entry: LogEntry = { time: nowTime(), role, content };
    set((s) => ({
      logEntriesBySession: {
        ...s.logEntriesBySession,
        [forSession]: [...(s.logEntriesBySession[forSession] ?? []), entry],
      },
    }));

    // Persist by reading existing file first, then appending.
    // This preserves any content agents wrote directly to the file
    // (e.g. task reports appended via their own tools).
    // Writes are serialized via conversationWriteChain to prevent races.
    const relPath = `conversation-${forSession}.md`;
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
  },

  // -- Input prefill -------------------------------------------------------

  setPendingInput: (collabSessionId, input) => {
    set((s) => {
      if (input === null) {
        const { [collabSessionId]: _, ...rest } = s.pendingInputs;
        return { pendingInputs: rest };
      }
      return { pendingInputs: { ...s.pendingInputs, [collabSessionId]: input } };
    });
  },

  // -- Task management ----------------------------------------------------

  addTask: (opts, forSession) => {
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
      reasoning: null,
      conclusion: null,
      output: null,
      createdAt: now,
      updatedAt: now,
    };
    set((s) => ({
      tasksBySession: {
        ...s.tasksBySession,
        [forSession]: [...(s.tasksBySession[forSession] ?? []), task],
      },
    }));
    get().appendLog("system", `Task created: ${task.id} — ${task.title}`, forSession);
    get().persistTasks(forSession);
    return task;
  },

  updateTask: (taskId, updates, forSession) => {
    const prevTask = (get().tasksBySession[forSession] ?? []).find((t) => t.id === taskId);
    const prevStatus = prevTask?.status;

    set((s) => ({
      tasksBySession: {
        ...s.tasksBySession,
        [forSession]: (s.tasksBySession[forSession] ?? []).map((t) =>
          t.id === taskId
            ? { ...t, ...updates, updatedAt: new Date().toISOString() }
            : t,
        ),
      },
    }));
    const task = (get().tasksBySession[forSession] ?? []).find((t) => t.id === taskId);
    if (task) {
      // Append a structured task report when status changes to a terminal state
      const isTerminal = task.status === "completed" || task.status === "blocked";
      const statusChanged = task.status !== prevStatus;
      if (isTerminal && statusChanged) {
        const report = [
          `# ${task.id} — ${task.status}`,
          `**Agent**: ${task.assignee ?? "unassigned"}`,
          `**Subject**: ${task.title}`,
          task.reasoning ? `**Reasoning**: ${task.reasoning}` : null,
          task.conclusion ? `**Conclusion**: ${task.conclusion}` : null,
          task.output ? `**Output**: ${task.output}` : null,
        ].filter(Boolean).join("\n");
        get().appendLog("system", `Task Report\n${report}`, forSession);
      } else {
        get().appendLog("system", `Task updated: ${taskId} → ${task.status}`, forSession);
      }
    }
    get().persistTasks(forSession);
  },

  getTasks: (forSession) => get().tasksBySession[forSession] ?? [],

  persistTasks: async (forSession) => {
    const tasks = get().tasksBySession[forSession] ?? [];
    try {
      await invoke("write_memory_file", {
        relativePath: taskFileRelativePath(forSession),
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
