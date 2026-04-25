import { invoke } from "@tauri-apps/api/core";
import {
  useCollaboratorStore,
  agentDisplayName,
  toolLabel,
} from "../../stores/collaboratorStore";
import { exportCanvasSnapshot, startImportForSession } from "../../lib/canvasOps";
import type { SpawnedAgent, TaskStatus } from "../../types/collaborator";

export interface ParsedCommand {
  type:
    | "send"
    | "broadcast"
    | "needs-target"
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

  const canvasExportMatch = trimmed.match(/^\/canvas-export(?:\s+@?(\S+))?(?:\s+([\s\S]+))?$/);
  if (canvasExportMatch) {
    return { type: "canvas-export", target: canvasExportMatch[1], message: canvasExportMatch[2]?.trim(), raw: trimmed };
  }
  const canvasImportMatch = trimmed.match(/^\/canvas-import(?:\s+@?(\S+))?$/);
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

  // Bare text → needs target selection (no auto-broadcast)
  if (trimmed.length > 0) {
    return { type: "needs-target", message: trimmed, raw: trimmed };
  }

  return { type: "unknown", raw: trimmed };
}

export function resolveAgent(
  target: string,
  agents: SpawnedAgent[],
): SpawnedAgent | null {
  const lower = target.toLowerCase();

  // Exact handle match (primary resolution path)
  const exactMatch = agents.find((a) => a.handle === lower);
  if (exactMatch) return exactMatch;

  // Prefix match: "@claude" → first agent whose handle starts with "claude"
  const prefixMatch = agents.find((a) => a.handle.startsWith(lower));
  if (prefixMatch) return prefixMatch;

  // Fallback: sessionId match
  return agents.find((a) => a.sessionId === target) ?? null;
}

export function getHelpText(): string {
  return [
    "Type directly in each agent terminal. This prompt is for commands & targeted messages.",
    "",
    "Commands:",
    "  @<agent> <msg>    Send message to specific agent",
    "  @all <msg>        Broadcast to all agents",
    "  <bare text>       Shows target selector before sending",
    "  /status           Show running agents",
    "  /help             Show help",
    "",
    "Tasks: /task list  /task add <title> | <objective> [@agent]",
    "       /task <id> status <pending|in-progress|completed|blocked>",
    "       /task <id> assign @<agent>  /task <id> done [notes]",
    "Canvas: /canvas-export [agent] (no target = all)  /canvas-import [agent]",
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
    const name = agentDisplayName(a);
    const statusTag = a.status === "exited" ? " [exited]" : "";
    lines.push(`  ${name}${statusTag}`);
  }
  return lines.join("  ");
}

// ---------------------------------------------------------------------------
// Command Execution
// ---------------------------------------------------------------------------

export async function executeCommand(cmd: ParsedCommand, collabSessionId?: string): Promise<void> {
  const store = useCollaboratorStore.getState();
  const status = (msg: string | null) => store.setStatus(msg, collabSessionId);
  // Scope agents to the current collaborator session when available
  const scopedAgents = collabSessionId
    ? store.agents.filter((a) => a.collabSessionId === collabSessionId)
    : store.agents;

  switch (cmd.type) {
    case "status": {
      status(getStatusText(scopedAgents));
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
      const agent = resolveAgent(cmd.target, scopedAgents);
      if (!agent) {
        status(`Agent "${cmd.target}" not found.`);
        break;
      }
      const lower = cmd.target.toLowerCase();
      if (!/\d$/.test(cmd.target)) {
        const matches = scopedAgents.filter((a) =>
          a.handle.startsWith(lower),
        );
        if (matches.length > 1) {
          status(
            `Multiple ${cmd.target} sessions. Use @${matches[0].handle}, @${matches[1].handle}. Sent to first.`,
          );
        }
      }
      await store.sendToAgent(agent.sessionId, cmd.message);
      break;
    }

    case "broadcast": {
      if (!cmd.message) break;
      await store.broadcastToAll(cmd.message, collabSessionId);
      break;
    }

    case "canvas-export": {
      try {
        const target = cmd.target ?? "all";
        const path = await exportCanvasSnapshot();
        if (!path) {
          status("Canvas is empty.");
          break;
        }

        const lines = [
          "[Canvas Terminal] A canvas snapshot has been exported for your reference.",
          `Image path: ${path}`,
        ];
        if (cmd.message) {
          lines.push(cmd.message);
        } else {
          lines.push("Please analyze this image and respond.");
        }
        const prompt = lines.join("\n");

        if (target.toLowerCase() === "all") {
          if (scopedAgents.length === 0) {
            status(`Canvas exported at ${path}. No agents running to broadcast.`);
            break;
          }
          await store.broadcastToAll(prompt, collabSessionId);
          status(`Canvas broadcast to ${scopedAgents.length} agent${scopedAgents.length !== 1 ? "s" : ""}`);
          break;
        }

        const agent = resolveAgent(target, scopedAgents);
        if (!agent) {
          status(`Agent "${target}" not found. Saved at ${path}`);
          break;
        }

        await store.sendToAgent(agent.sessionId, prompt);
        status(`Canvas exported to ${toolLabel(agent.tool)}`);
      } catch (err) {
        status(`Export failed: ${err}`);
      }
      break;
    }

    case "canvas-import": {
      try {
        if (!cmd.target) {
          status("Usage: /canvas-import <agent>  (specify a target agent)");
          break;
        }
        const agent = resolveAgent(cmd.target, scopedAgents);
        if (!agent) {
          status(`Agent "${cmd.target}" not found.`);
          break;
        }

        await startImportForSession(
          agent.sessionId,
          agent.tool,
          (msg) => status(msg),
          () => {},
          {
            sendFn: async (prompt) => {
              await store.sendToAgent(agent.sessionId, prompt);
            },
          },
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
        } else if (cmd.message) {
          await invoke<string>("write_memory_file", {
            relativePath: "context.md",
            content: cmd.message,
          });
          status("Shared context updated.");
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
          if (!collabSessionId) {
            status("Task commands require a collaborator session.");
            break;
          }
          const tasks = store.getTasks(collabSessionId);
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
          if (!collabSessionId) {
            status("Task commands require a collaborator session.");
            break;
          }
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

          const task = store.addTask({ title, objective, assignee }, collabSessionId);
          status(`Task created: ${task.id} — "${task.title}"${assignee ? ` → ${assignee}` : ""}`);
          break;
        }

        // /task <id> status <status>
        const statusMatch = sub.match(/^(\S+)\s+status\s+(\S+)$/);
        if (statusMatch) {
          if (!collabSessionId) {
            status("Task commands require a collaborator session.");
            break;
          }
          const [, taskId, newStatus] = statusMatch;
          const valid = ["pending", "in-progress", "completed", "blocked"];
          if (!valid.includes(newStatus)) {
            status(`Invalid status. Use: ${valid.join(", ")}`);
            break;
          }
          const task = store.getTasks(collabSessionId).find((t) => t.id === taskId || t.id.startsWith(taskId));
          if (!task) {
            status(`Task not found: ${taskId}`);
            break;
          }
          store.updateTask(task.id, { status: newStatus as TaskStatus }, collabSessionId);
          status(`Task ${task.id} → ${newStatus}`);
          break;
        }

        // /task <id> assign @<agent>
        const assignMatch = sub.match(/^(\S+)\s+assign\s+@(\S+)$/);
        if (assignMatch) {
          if (!collabSessionId) {
            status("Task commands require a collaborator session.");
            break;
          }
          const [, taskId, agent] = assignMatch;
          const task = store.getTasks(collabSessionId).find((t) => t.id === taskId || t.id.startsWith(taskId));
          if (!task) {
            status(`Task not found: ${taskId}`);
            break;
          }
          store.updateTask(task.id, { assignee: `@${agent}` }, collabSessionId);
          status(`Task ${task.id} assigned to @${agent}`);
          break;
        }

        // /task <id> done [notes]
        const doneMatch = sub.match(/^(\S+)\s+done(?:\s+(.+))?$/s);
        if (doneMatch) {
          if (!collabSessionId) {
            status("Task commands require a collaborator session.");
            break;
          }
          const [, taskId, notes] = doneMatch;
          const task = store.getTasks(collabSessionId).find((t) => t.id === taskId || t.id.startsWith(taskId));
          if (!task) {
            status(`Task not found: ${taskId}`);
            break;
          }
          store.updateTask(task.id, {
            status: "completed",
            conclusion: notes?.trim() ?? null,
          }, collabSessionId);
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
