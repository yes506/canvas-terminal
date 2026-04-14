import { invoke } from "@tauri-apps/api/core";
import {
  useCollaboratorStore,
  agentDisplayName,
  toolShortName,
} from "../../stores/collaboratorStore";
import { exportCanvasSnapshot, startImportForSession } from "../../lib/canvasOps";
import type { SpawnedAgent, TaskStatus } from "../../types/collaborator";

export interface ParsedCommand {
  type:
    | "send"
    | "broadcast"
    | "status"
    | "clear"
    | "help"
    | "canvas-export"
    | "canvas-import"
    | "context"
    | "memory"
    | "task"
    | "unknown";
  target?: string;
  message?: string;
  raw: string;
}

export function parseInput(input: string): ParsedCommand {
  const trimmed = input.trim();

  if (trimmed === "/status") return { type: "status", raw: trimmed };
  if (trimmed === "/clear") return { type: "clear", raw: trimmed };
  if (trimmed === "/help") return { type: "help", raw: trimmed };

  const canvasExportMatch = trimmed.match(/^\/canvas-export(?:\s+@(\S+))?$/);
  if (canvasExportMatch) {
    return { type: "canvas-export", target: canvasExportMatch[1], raw: trimmed };
  }
  const canvasImportMatch = trimmed.match(/^\/canvas-import(?:\s+@(\S+))?$/);
  if (canvasImportMatch) {
    return { type: "canvas-import", target: canvasImportMatch[1], raw: trimmed };
  }

  if (trimmed === "/context" || trimmed.startsWith("/context ")) {
    const text = trimmed.slice("/context".length).trim();
    return { type: "context", message: text || undefined, raw: trimmed };
  }

  if (trimmed === "/memory" || trimmed.startsWith("/memory ")) {
    const rest = trimmed.slice("/memory".length).trim();
    return { type: "memory", message: rest || undefined, raw: trimmed };
  }

  if (trimmed === "/task" || trimmed.startsWith("/task ")) {
    const rest = trimmed.slice("/task".length).trim();
    return { type: "task", message: rest || undefined, raw: trimmed };
  }

  // @agent message
  const atMatch = trimmed.match(/^@(\S+)\s+(.+)$/s);
  if (atMatch) {
    const target = atMatch[1];
    const message = atMatch[2];
    if (target === "all") {
      return { type: "broadcast", message, raw: trimmed };
    }
    return { type: "send", target, message, raw: trimmed };
  }

  // Bare text → broadcast
  if (trimmed.length > 0) {
    return { type: "broadcast", message: trimmed, raw: trimmed };
  }

  return { type: "unknown", raw: trimmed };
}

export function resolveAgent(
  target: string,
  agents: SpawnedAgent[],
): SpawnedAgent | null {
  const lower = target.toLowerCase();

  // Indexed targeting: @claude1, @claude2, @codex2, etc.
  const indexMatch = lower.match(/^([a-z]+?)(\d+)$/);
  if (indexMatch) {
    const toolPrefix = indexMatch[1];
    const oneBasedIdx = parseInt(indexMatch[2], 10);
    const sameToolAgents = agents
      .filter((a) => toolShortName(a.tool).startsWith(toolPrefix))
      .sort((a, b) => a.sessionId.localeCompare(b.sessionId));
    if (oneBasedIdx >= 1 && oneBasedIdx <= sameToolAgents.length) {
      return sameToolAgents[oneBasedIdx - 1];
    }
    return null;
  }

  // Match by tool short name
  return (
    agents.find((a) => toolShortName(a.tool) === lower) ??
    agents.find((a) => toolShortName(a.tool).includes(lower)) ??
    agents.find((a) => a.sessionId === target) ??
    null
  );
}

export function getHelpText(): string {
  return [
    "Type directly in each agent terminal. This prompt is for commands & broadcasts.",
    "",
    "Commands:",
    "  @<agent> <msg>    Inject message into agent",
    "  @all <msg>        Broadcast to all agents",
    "  /status           Show running agents",
    "  /help             Show help",
    "",
    "Tasks: /task list  /task add <title> | <objective> [@agent]",
    "       /task <id> status <pending|in-progress|completed|blocked>",
    "       /task <id> assign @<agent>  /task <id> done [notes]",
    "Canvas: /canvas-export [@a]  /canvas-import [@a]",
    "Memory: /context <text>  /memory list|read|delete|clear",
    "Agents: @claude @codex @gemini  Indexed: @claude1 @claude2",
  ].join("\n");
}

export function getStatusText(agents: SpawnedAgent[]): string {
  if (agents.length === 0) {
    return "No agents running. Use the toolbar to launch AI tools.";
  }
  const lines = [`${agents.length} agent${agents.length !== 1 ? "s" : ""}:`];
  for (const a of agents) {
    const name = agentDisplayName(a, agents);
    const statusTag = a.status === "exited" ? " [exited]" : "";
    lines.push(`  ${name}${statusTag}`);
  }
  return lines.join("  ");
}

// ---------------------------------------------------------------------------
// Command Execution
// ---------------------------------------------------------------------------

export async function executeCommand(cmd: ParsedCommand): Promise<void> {
  const store = useCollaboratorStore.getState();
  const status = (msg: string | null) => store.setStatus(msg);

  switch (cmd.type) {
    case "status": {
      status(getStatusText(store.agents));
      break;
    }

    case "clear": {
      status(null);
      break;
    }

    case "help": {
      status(getHelpText());
      break;
    }

    case "send": {
      if (!cmd.target || !cmd.message) break;
      const agent = resolveAgent(cmd.target, store.agents);
      if (!agent) {
        status(`Agent "${cmd.target}" not found.`);
        break;
      }
      const lower = cmd.target.toLowerCase();
      if (!/\d$/.test(cmd.target)) {
        const matches = store.agents.filter((a) =>
          toolShortName(a.tool).includes(lower),
        );
        if (matches.length > 1) {
          status(
            `Multiple ${cmd.target} sessions. Use @${cmd.target}1, @${cmd.target}2. Sent to first.`,
          );
        }
      }
      await store.sendToAgent(agent.sessionId, cmd.message);
      break;
    }

    case "broadcast": {
      if (!cmd.message) break;
      await store.broadcastToAll(cmd.message);
      break;
    }

    case "canvas-export": {
      try {
        const path = await exportCanvasSnapshot();
        if (!path) {
          status("Canvas is empty.");
          break;
        }
        const targets: SpawnedAgent[] = [];
        if (cmd.target) {
          const agent = resolveAgent(cmd.target, store.agents);
          if (!agent) {
            status(`Agent "${cmd.target}" not found. Saved at ${path}`);
            break;
          }
          targets.push(agent);
        } else {
          targets.push(...store.agents);
        }
        for (const agent of targets) {
          await invoke("inject_into_pty", {
            sessionId: agent.sessionId,
            text: path,
            tool: agent.tool,
          });
        }
        status(
          targets.length > 0
            ? `Canvas exported to ${targets.length} agent(s)`
            : `Canvas exported: ${path}`,
        );
      } catch (err) {
        status(`Export failed: ${err}`);
      }
      break;
    }

    case "canvas-import": {
      try {
        const agents = store.agents;
        let targetAgent: SpawnedAgent | null = null;

        if (cmd.target) {
          targetAgent = resolveAgent(cmd.target, agents);
          if (!targetAgent) {
            status(`Agent "${cmd.target}" not found.`);
            break;
          }
        } else if (agents.length === 1) {
          targetAgent = agents[0];
        } else if (agents.length === 0) {
          status("No agents running.");
          break;
        } else {
          status("Multiple agents. Specify: /canvas-import @claude");
          break;
        }

        await startImportForSession(
          targetAgent.sessionId,
          targetAgent.tool,
          (msg) => status(msg),
        );
      } catch (err) {
        status(`Import failed: ${err}`);
      }
      break;
    }

    case "context": {
      try {
        if (cmd.message === "clear") {
          await invoke<boolean>("delete_memory_file", {
            relativePath: "context.md",
          });
          status("Shared context cleared.");
          store.appendLog("system", "Context cleared");
        } else if (cmd.message) {
          await invoke<string>("write_memory_file", {
            relativePath: "context.md",
            content: cmd.message,
          });
          status("Shared context updated.");
          store.appendLog("system", `Context set: ${cmd.message}`);
        } else {
          const content = await invoke<string | null>("read_memory_file", {
            relativePath: "context.md",
          });
          status(content ? `Context: ${content}` : "No shared context set.");
        }
      } catch (err) {
        status(`Context error: ${err}`);
      }
      break;
    }

    case "task": {
      try {
        const sub = cmd.message ?? "";

        // /task  or  /task list
        if (sub === "" || sub === "list") {
          const tasks = store.getTasks();
          if (tasks.length === 0) {
            status("No tasks. Create one: /task add <title> | <objective> [@agent]");
          } else {
            const lines = [`${tasks.length} task(s):`];
            for (const t of tasks) {
              const a = t.assignee ?? "unassigned";
              lines.push(`  [${t.status}] ${t.id}: ${t.title} (${a})`);
            }
            status(lines.join("  "));
          }
          break;
        }

        // /task add <title> | <objective> [@agent]
        if (sub.startsWith("add ") || sub === "add") {
          const body = sub.slice("add".length).trim();
          if (!body) {
            status("Usage: /task add <title> | <objective> [@agent]");
            break;
          }
          const pipeIdx = body.indexOf("|");
          let title: string;
          let objective: string;
          let assignee: string | null = null;

          if (pipeIdx >= 0) {
            title = body.slice(0, pipeIdx).trim();
            let rest = body.slice(pipeIdx + 1).trim();
            // Extract @agent from the end
            const atMatch = rest.match(/\s+@(\S+)$/);
            if (atMatch) {
              assignee = `@${atMatch[1]}`;
              rest = rest.slice(0, -atMatch[0].length).trim();
            }
            objective = rest;
          } else {
            // No pipe — title only, extract @agent
            let rest = body;
            const atMatch = rest.match(/\s+@(\S+)$/);
            if (atMatch) {
              assignee = `@${atMatch[1]}`;
              rest = rest.slice(0, -atMatch[0].length).trim();
            }
            title = rest;
            objective = rest;
          }

          const task = store.addTask({ title, objective, assignee });
          status(`Task created: ${task.id} — "${task.title}"${assignee ? ` → ${assignee}` : ""}`);
          break;
        }

        // /task <id> status <status>
        const statusMatch = sub.match(/^(\S+)\s+status\s+(\S+)$/);
        if (statusMatch) {
          const [, taskId, newStatus] = statusMatch;
          const valid = ["pending", "in-progress", "completed", "blocked"];
          if (!valid.includes(newStatus)) {
            status(`Invalid status. Use: ${valid.join(", ")}`);
            break;
          }
          const task = store.getTasks().find((t) => t.id === taskId || t.id.startsWith(taskId));
          if (!task) {
            status(`Task not found: ${taskId}`);
            break;
          }
          store.updateTask(task.id, { status: newStatus as TaskStatus });
          status(`Task ${task.id} → ${newStatus}`);
          break;
        }

        // /task <id> assign @<agent>
        const assignMatch = sub.match(/^(\S+)\s+assign\s+@(\S+)$/);
        if (assignMatch) {
          const [, taskId, agent] = assignMatch;
          const task = store.getTasks().find((t) => t.id === taskId || t.id.startsWith(taskId));
          if (!task) {
            status(`Task not found: ${taskId}`);
            break;
          }
          store.updateTask(task.id, { assignee: `@${agent}` });
          status(`Task ${task.id} assigned to @${agent}`);
          break;
        }

        // /task <id> done [notes]
        const doneMatch = sub.match(/^(\S+)\s+done(?:\s+(.+))?$/s);
        if (doneMatch) {
          const [, taskId, notes] = doneMatch;
          const task = store.getTasks().find((t) => t.id === taskId || t.id.startsWith(taskId));
          if (!task) {
            status(`Task not found: ${taskId}`);
            break;
          }
          store.updateTask(task.id, {
            status: "completed",
            completionNotes: notes?.trim() ?? null,
          });
          status(`Task ${task.id} completed${notes ? ` — ${notes.trim()}` : ""}`);
          break;
        }

        status("Usage: /task list | add <title> | <id> status|assign|done");
      } catch (err) {
        status(`Task error: ${err}`);
      }
      break;
    }

    case "memory": {
      try {
        const sub = cmd.message ?? "";
        if (sub === "list" || sub === "") {
          const files = await invoke<string[]>("list_memory_files");
          status(
            files.length === 0
              ? "No shared memory files."
              : `Memory: ${files.join(", ")}`,
          );
        } else if (sub.startsWith("read ")) {
          const relPath = sub.slice("read ".length).trim();
          const content = await invoke<string | null>("read_memory_file", {
            relativePath: relPath,
          });
          status(
            content
              ? `${relPath}: ${content.slice(0, 200)}`
              : `Not found: ${relPath}`,
          );
        } else if (sub.startsWith("delete ")) {
          const relPath = sub.slice("delete ".length).trim();
          const deleted = await invoke<boolean>("delete_memory_file", {
            relativePath: relPath,
          });
          status(deleted ? `Deleted: ${relPath}` : `Not found: ${relPath}`);
        } else if (sub === "clear") {
          await invoke("clear_memory_dir");
          status("All shared memory files cleared.");
        } else {
          status("Usage: /memory list|read <p>|delete <p>|clear");
        }
      } catch (err) {
        status(`Memory error: ${err}`);
      }
      break;
    }

    default: {
      status("Unknown command. Type /help.");
    }
  }
}
