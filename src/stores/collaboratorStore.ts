import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import type { SpawnedAgent, SpawnedAgentInit, ToolId, CollabTask } from "../types/collaborator";
import { TOOL_CONFIGS } from "../types/collaborator";
import { muteCapture } from "../lib/agentOutputCapture";

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

/** Return the stored display name for an agent. */
export function agentDisplayName(agent: SpawnedAgent): string {
  return agent.displayName;
}

/**
 * Build the list of @-mentionable names from the current agent set.
 * Derives directly from stored handles: ["claude1", "codex1", "claude2"].
 */
export function mentionableNames(agents: SpawnedAgent[]): string[] {
  return agents.map((a) => a.handle);
}

/** Return the stored @-mention handle for an agent. */
export function agentMentionName(agent: SpawnedAgent): string {
  return agent.handle;
}

// ---------------------------------------------------------------------------
// Per-tool ordinal counter — monotonic, never reuses ordinals
// ---------------------------------------------------------------------------

const toolOrdinalCounters = new Map<string, number>();

function nextOrdinal(collabSessionId: string, tool: ToolId): number {
  const key = `${collabSessionId}:${tool}`;
  const next = (toolOrdinalCounters.get(key) ?? 0) + 1;
  toolOrdinalCounters.set(key, next);
  return next;
}

function resetOrdinalCounters(forSession: string): void {
  for (const key of toolOrdinalCounters.keys()) {
    if (key.startsWith(`${forSession}:`)) {
      toolOrdinalCounters.delete(key);
    }
  }
}

// ---------------------------------------------------------------------------
// Conversation log
// ---------------------------------------------------------------------------

interface LogEntry {
  time: string; // HH:MM:SS
  role: "user" | "system" | "agent";
  agent?: string; // e.g. "@claude2" — only set when role === "agent"
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
  let tag: string;
  if (e.role === "user") tag = "User";
  else if (e.role === "agent") tag = e.agent ?? "Agent";
  else tag = "System";
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
  "author": "YOUR_IDENTITY",
  "status": "completed",
  "reasoning": "Why this approach, alternatives considered, trade-offs",
  "conclusion": "What was decided/done (1-3 sentences)",
  "output": "file paths, artifacts, or key results"
}
EOF
\`\`\`

Replace \`SHARED_MEMORY_DIR\` with the path shown above, \`TASK_ID\` with your assigned task ID, and \`YOUR_IDENTITY\` with your agent identity (shown in the header above, e.g. @claude1).

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
    if (t.completedBy) lines.push(`**Completed By**: ${t.completedBy}`);
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
  /** Input history per collaborator session. */
  inputHistoryBySession: Record<string, string[]>;
  /** Current history navigation index per session (-1 = not navigating). */
  historyIndexBySession: Record<string, number>;
  /** Saves the in-progress input when the user starts navigating history, per session. */
  draftInputBySession: Record<string, string>;
  /** In-memory conversation log entries, keyed by collaborator session. */
  logEntriesBySession: Record<string, LogEntry[]>;
  /** Structured tasks for multi-agent collaboration, keyed by collaborator session. */
  tasksBySession: Record<string, CollabTask[]>;
  /** Prefilled input value set externally (e.g. canvas toolbar), keyed by collabSessionId. */
  pendingInputs: Record<string, string>;
  /** Messages queued while an agent is still spawning (keyed by agent sessionId). */
  pendingMessagesByAgent: Record<string, string[]>;

  // Session lifecycle
  startSession: (id: string) => void;
  endSession: (forSession: string) => void;

  // Agent lifecycle
  addAgent: (agent: SpawnedAgentInit) => void;
  removeAgent: (sessionId: string) => void;
  setAgentStatus: (
    sessionId: string,
    status: SpawnedAgent["status"],
  ) => void;
  /** Flush queued messages for an agent that has become ready. */
  flushPendingMessages: (sessionId: string) => Promise<void>;
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
    agentName?: string,
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
    updates: Partial<Pick<CollabTask, "status" | "assignee" | "reasoning" | "conclusion" | "output" | "completedBy">>,
    forSession: string,
  ) => void;
  getTasks: (forSession: string) => CollabTask[];
  persistTasks: (forSession: string) => Promise<void>;

  // Input history
  pushHistory: (input: string, forSession: string) => void;
  navigateHistory: (direction: "up" | "down", forSession: string, currentInput?: string) => string | null;
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
          author?: string;
          agent?: string;
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
          completedBy: data.author ?? data.agent ?? null,
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
  agentIdentity?: string | null,
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

  // Inject agent identity so each agent knows who it is
  if (agentIdentity) {
    parts.push(`[Your identity: You are @${agentIdentity}. Use this name when authoring files or referencing yourself in logs.]`);
  }

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
  inputHistoryBySession: {},
  historyIndexBySession: {},
  draftInputBySession: {},
  logEntriesBySession: {},
  tasksBySession: {},
  pendingInputs: {},
  pendingMessagesByAgent: {},

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
    resetOrdinalCounters(forSession);
    set((s) => {
      const { [forSession]: _status, ...statusMessages } = s.statusMessages;
      const { [forSession]: _logs, ...logEntriesBySession } = s.logEntriesBySession;
      const { [forSession]: _tasks, ...tasksBySession } = s.tasksBySession;
      const { [forSession]: _pending, ...pendingInputs } = s.pendingInputs;
      const { [forSession]: _hist, ...inputHistoryBySession } = s.inputHistoryBySession;
      const { [forSession]: _idx, ...historyIndexBySession } = s.historyIndexBySession;
      const { [forSession]: _draft, ...draftInputBySession } = s.draftInputBySession;
      return {
        statusMessages,
        logEntriesBySession,
        tasksBySession,
        pendingInputs,
        inputHistoryBySession,
        historyIndexBySession,
        draftInputBySession,
        agents: s.agents.filter((a) => a.collabSessionId !== forSession),
      };
    });
  },

  // -- Agent lifecycle ----------------------------------------------------

  addAgent: (raw) => {
    const ordinal = nextOrdinal(raw.collabSessionId, raw.tool);
    const short = toolShortName(raw.tool);
    const agent: SpawnedAgent = {
      ...raw,
      ordinal,
      handle: `${short}${ordinal}`,
      displayName: `${toolLabel(raw.tool)} #${ordinal}`,
    };
    set((s) => ({ agents: [...s.agents, agent] }));
  },

  removeAgent: (sessionId) => {
    set((s) => {
      const { [sessionId]: _, ...pendingMessagesByAgent } = s.pendingMessagesByAgent;
      return {
        agents: s.agents.filter((a) => a.sessionId !== sessionId),
        pendingMessagesByAgent,
      };
    });
  },

  setAgentStatus: (sessionId, status) => {
    set((s) => ({
      agents: s.agents.map((a) =>
        a.sessionId === sessionId ? { ...a, status } : a,
      ),
    }));
  },

  flushPendingMessages: async (sessionId) => {
    const queue = get().pendingMessagesByAgent[sessionId];
    if (!queue || queue.length === 0) return;

    // Clear the queue first to avoid double-flushing
    set((s) => {
      const { [sessionId]: _, ...rest } = s.pendingMessagesByAgent;
      return { pendingMessagesByAgent: rest };
    });

    // Send each queued message
    for (const content of queue) {
      await get().sendToAgent(sessionId, content);
    }
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
      resetOrdinalCounters(sid);
      set((s) => ({
        agents: s.agents.filter((a) => a.collabSessionId !== sid),
      }));
    } else {
      toolOrdinalCounters.clear();
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
      const mention = agent ? agent.handle : "?";

      // Queue message if agent is still starting up
      if (agent?.status === "spawning") {
        set((s) => ({
          pendingMessagesByAgent: {
            ...s.pendingMessagesByAgent,
            [sessionId]: [...(s.pendingMessagesByAgent[sessionId] ?? []), content],
          },
        }));
        if (agentCollabId) {
          get().setStatus("Agent starting up, message queued...", agentCollabId);
        }
        return;
      }

      // Auto-create a task if none exist for this session
      if (agentCollabId) {
        const existing = tasksBySession[agentCollabId] ?? [];
        const hasActiveTask = existing.some((t) =>
          t.assignee === `@${mention}` &&
          (t.status === "pending" || t.status === "in-progress"),
        );
        if (!hasActiveTask) {
          const title = content.length > 60 ? content.substring(0, 57) + "..." : content;
          get().addTask({
            title,
            objective: content,
            assignee: `@${mention}`,
          }, agentCollabId);
        }
      }
      const sessionTasks = agentCollabId ? (get().tasksBySession[agentCollabId] ?? []) : [];
      const text = await prependContextHeader(content, agentCollabId, sessionTasks, mention);
      // Mute the output capture to suppress the echoed prompt from being logged
      muteCapture(sessionId, 1500);
      await invoke("inject_into_pty", { sessionId, text, tool });
      const label = agent ? toolLabel(agent.tool) : sessionId;
      if (agentCollabId) {
        get().setStatus(`Sent to ${label}`, agentCollabId);
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
        const mention = `@${agent.handle}`;
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
    const sessionTasks = sid ? (get().tasksBySession[sid] ?? []) : [];
    let sent = 0;
    for (const agent of targetAgents) {
      // Queue for agents that are still starting up
      if (agent.status === "spawning") {
        set((s) => ({
          pendingMessagesByAgent: {
            ...s.pendingMessagesByAgent,
            [agent.sessionId]: [...(s.pendingMessagesByAgent[agent.sessionId] ?? []), content],
          },
        }));
        sent++;
        continue;
      }
      try {
        // Each agent gets its own identity injected into the context header
        const identity = agent.handle;
        const text = await prependContextHeader(content, sid, sessionTasks, identity);
        // Mute the output capture to suppress the echoed prompt from being logged
        muteCapture(agent.sessionId, 1500);
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

  appendLog: (role, content, forSession, agentName) => {
    const entry: LogEntry = { time: nowTime(), role, content, agent: agentName };
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
      completedBy: null,
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
          `**Agent**: ${task.completedBy ?? task.assignee ?? "unassigned"}`,
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

  pushHistory: (input, forSession) => {
    set((s) => ({
      inputHistoryBySession: {
        ...s.inputHistoryBySession,
        [forSession]: [...(s.inputHistoryBySession[forSession] ?? []), input],
      },
      historyIndexBySession: { ...s.historyIndexBySession, [forSession]: -1 },
      draftInputBySession: { ...s.draftInputBySession, [forSession]: "" },
    }));
  },

  navigateHistory: (direction, forSession, currentInput) => {
    const s = get();
    const inputHistory = s.inputHistoryBySession[forSession] ?? [];
    const historyIndex = s.historyIndexBySession[forSession] ?? -1;
    if (inputHistory.length === 0) return null;

    let newIndex: number;
    if (direction === "up") {
      // Save the current input as draft when first entering history
      if (historyIndex === -1) {
        set((prev) => ({
          draftInputBySession: { ...prev.draftInputBySession, [forSession]: currentInput ?? "" },
        }));
        newIndex = inputHistory.length - 1;
      } else {
        newIndex = Math.max(0, historyIndex - 1);
      }
    } else {
      if (historyIndex === -1) return null;
      newIndex = historyIndex + 1;
      if (newIndex >= inputHistory.length) {
        // Navigated past the end — restore the draft
        const draftInput = get().draftInputBySession[forSession] ?? "";
        set((prev) => ({
          historyIndexBySession: { ...prev.historyIndexBySession, [forSession]: -1 },
          draftInputBySession: { ...prev.draftInputBySession, [forSession]: "" },
        }));
        return draftInput;
      }
    }

    set((prev) => ({
      historyIndexBySession: { ...prev.historyIndexBySession, [forSession]: newIndex },
    }));
    return inputHistory[newIndex] ?? null;
  },
}));
