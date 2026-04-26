import { invoke } from "@tauri-apps/api/core";
import {
  useCollaboratorStore,
  agentDisplayName,
  toolLabel,
  slugify,
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
    | "rename"
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

  // Canvas export: require explicit @target to distinguish agent handle from prompt message.
  // Branch 1: /canvas-export @target [message] → groups 1,2
  // Branch 2: /canvas-export message (no @)   → group 3
  const canvasExportMatch = trimmed.match(/^\/canvas-export(?:\s+@(\S+)(?:\s+([\s\S]+))?|\s+([\s\S]+))?$/);
  if (canvasExportMatch) {
    return {
      type: "canvas-export",
      target: canvasExportMatch[1],
      message: (canvasExportMatch[2] ?? canvasExportMatch[3])?.trim(),
      raw: trimmed,
    };
  }
  // Canvas import: require explicit @target (same fix as export)
  const canvasImportMatch = trimmed.match(/^\/canvas-import(?:\s+@(\S+))?(?:\s+([\s\S]+))?$/);
  if (canvasImportMatch) {
    return { type: "canvas-import", target: canvasImportMatch[1], message: canvasImportMatch[2]?.trim(), raw: trimmed };
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

  // /rename @<agent> <new-nickname>
  // Captures the new nickname as the rest of the line (allows spaces).
  const renameMatch = trimmed.match(/^\/rename\s+@(\S+)\s+(.+)$/);
  if (renameMatch) {
    return {
      type: "rename",
      target: renameMatch[1],
      message: renameMatch[2].trim(),
      raw: trimmed,
    };
  }
  if (trimmed === "/rename" || trimmed.startsWith("/rename ")) {
    // Malformed — pass through with no target/message so the executor can
    // surface a usage hint.
    return { type: "rename", raw: trimmed };
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
  const slug = slugify(target);

  // Exact handle match (primary resolution path; allows exited agents — handles
  // are immutable + unique forever within a collabSessionId).
  const exactHandleMatch = agents.find((a) => a.handle === lower);
  if (exactHandleMatch) return exactHandleMatch;

  // Exact nickname-slug match — LIVE AGENTS ONLY. Per v5 §4 "live agents own
  // the namespace": after a rename releases an exited agent's slug, the resolver
  // must prefer the live agent. Otherwise `@bug-hunter` could route to dead A.
  if (slug.length > 0) {
    const exactSlugMatch = agents.find(
      (a) => a.status !== "exited" && a.nicknameSlug === slug,
    );
    if (exactSlugMatch) return exactSlugMatch;
  }

  // Handle prefix match: "@claude" → first agent whose handle starts with
  // "claude". Allows exited agents — prefix routing is best-effort and
  // first-match by iteration order; a user typing a partial handle is
  // intentionally targeting that named agent regardless of liveness.
  const prefixHandleMatch = agents.find((a) => a.handle.startsWith(lower));
  if (prefixHandleMatch) return prefixHandleMatch;

  // Nickname-slug prefix — LIVE AGENTS ONLY. Same rationale as exact-slug.
  if (slug.length > 0) {
    const prefixSlugMatch = agents.find(
      (a) => a.status !== "exited" && a.nicknameSlug.startsWith(slug),
    );
    if (prefixSlugMatch) return prefixSlugMatch;
  }

  // History-slug match — LIVE AGENTS ONLY. Lets users address an agent by any
  // PAST nickname; a renamed agent stays reachable even if the user remembers
  // the old label (e.g., scrolling back through the conversation log and
  // typing the name they see there). v6 §2 step 5. (claude2 G6 round-8.)
  if (slug.length > 0) {
    const historyMatch = agents.find(
      (a) =>
        a.status !== "exited" &&
        a.nameHistory.some((r) => slugify(r.nickname) === slug),
    );
    if (historyMatch) return historyMatch;
  }

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
    "Canvas: /canvas-export [msg]  /canvas-export @agent [msg]  /canvas-import @agent",
    "Memory: /context <text>  /memory list|read|delete|clear",
    "Agents: @claude @codex @gemini  Indexed: @claude1 @claude2  Or by nickname: @bug-hunter",
    "Rename: /rename @<agent> <new nickname>",
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
          status("Usage: /canvas-import @<agent>  (specify a target agent)");
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

          // Canonicalize the trailing @-token through resolveAgent BEFORE
          // writing the assignee. Symmetric with the /task <id> assign path
          // (see comment there). Without this, `/task add ... @bug-hunter`
          // would persist the mutable nickname token into t.assignee, and
          // every handle-keyed downstream lookup (findFreshestActiveTaskForMention,
          // recentOutcomesBySession) would fail to match. (codex3 round-8.)
          const canonicalizeAssignee = (rawToken: string): string | null => {
            const resolved = resolveAgent(rawToken, scopedAgents);
            return resolved ? `@${resolved.handle}` : null;
          };
          let unresolvedToken: string | null = null;
          if (pipeIdx >= 0) {
            title = body.slice(0, pipeIdx).trim();
            let rest = body.slice(pipeIdx + 1).trim();
            const atMatch = rest.match(/\s+@(\S+)$/);
            if (atMatch) {
              const canonical = canonicalizeAssignee(atMatch[1]);
              if (canonical) {
                assignee = canonical;
              } else {
                unresolvedToken = atMatch[1];
              }
              rest = rest.slice(0, -atMatch[0].length).trim();
            }
            objective = rest;
          } else {
            let rest = body;
            const atMatch = rest.match(/\s+@(\S+)$/);
            if (atMatch) {
              const canonical = canonicalizeAssignee(atMatch[1]);
              if (canonical) {
                assignee = canonical;
              } else {
                unresolvedToken = atMatch[1];
              }
              rest = rest.slice(0, -atMatch[0].length).trim();
            }
            title = rest;
            objective = rest;
          }

          if (unresolvedToken) {
            status(`Agent "${unresolvedToken}" not found.`);
            break;
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
          // Canonicalize the typed token through resolveAgent BEFORE writing to
          // the task ledger. Otherwise a user typing /task X assign @bug-hunter
          // (a nickname) would land assignee: "@bug-hunter" — which never
          // matches handle-keyed lookups in findFreshestActiveTaskForMention or
          // recentOutcomesBySession after a future rename. The on-disk audit
          // also stays canonical: the markdown writer at formatTasksMarkdown
          // (`Assignee` line) sees @<handle>, not the typed nickname.
          const resolved = resolveAgent(agent, scopedAgents);
          if (!resolved) {
            status(`Agent "${agent}" not found.`);
            break;
          }
          store.updateTask(task.id, { assignee: `@${resolved.handle}` }, collabSessionId);
          status(`Task ${task.id} assigned to @${resolved.handle}`);
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

    case "rename": {
      if (!cmd.target || !cmd.message) {
        status('Usage: /rename @<agent> <new nickname>');
        break;
      }
      const targetAgent = resolveAgent(cmd.target, scopedAgents);
      if (!targetAgent) {
        status(`Agent "${cmd.target}" not found.`);
        break;
      }
      // Strip a leading "@" if the user typed it as part of the nickname value.
      // The rename action validates and returns RenameResult — we surface
      // result.message verbatim on failure (store owns the strings).
      const newNickname = cmd.message.replace(/^@/, "");
      const result = store.renameAgent(targetAgent.sessionId, newNickname);
      if (result.ok) {
        status(
          `Agent @${targetAgent.handle} renamed to "${newNickname.trim()}"`,
        );
      } else {
        status(result.message);
      }
      break;
    }

    default: {
      status("Unknown command. Type /help.");
    }
  }
}
