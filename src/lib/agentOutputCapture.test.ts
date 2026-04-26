import { describe, it, expect } from "vitest";
import { _filterInjectedContentForTests as filterInjectedContent } from "./agentOutputCapture";

// Regression: when capture-mute is imperfect, an echoed slim header must
// be filtered out before it lands in the conversation log. The earlier
// pattern set only matched the full-header line forms; the slim header
// introduces six new shapes that were leaking through. (codex1 task-8.)
describe("INJECTED_HEADER_PATTERNS — slim-header echo filtering (B3)", () => {
  it("filters all slim-header line forms out of an echoed payload", () => {
    const echo = [
      "[Collaborator shared memory: /tmp/mem]",
      "[Tasks file: /tmp/mem/tasks-session-x.md]",
      "[Conversation log: /tmp/mem/conversation-session-x.md]",
      "[Shared context: /tmp/mem/context.md]",
      "[You are @claude1]",
      "[Protocol reminder: signal completion via /tmp/mem/{TASK_ID}.done.json — full protocol was sent in this session's first message]",
      "",
      "## Your active tasks",
      "- [pending] task-9: do the thing",
      "  Objective: do the thing well",
      "",
      "## Other agents' active tasks (2)",
      "- task-10 (@codex1): another thing",
      "- task-11 (@claude2): yet another",
      "[Read-discipline: trust the task list above — prefer targeted Grep over full Read of shared tasks/conversation files]",
      "",
      "Real agent reply starts here.",
    ].join("\n");

    const filtered = filterInjectedContent(echo);
    // The only thing left should be the agent's actual reply.
    expect(filtered).toBe("Real agent reply starts here.");
  });

  it("still filters the legacy full-header forms (no regression)", () => {
    const echo = [
      "[Collaborator shared memory: /tmp/mem]",
      "[Conversation log: /tmp/mem/conv.md]",
      "[Task definitions: /tmp/mem/tasks.md]",
      "[Shared context: /tmp/mem/context.md]",
      "[To share notes with other agents, write files to the shared memory directory above.]",
      "[Your identity: You are @claude1. Use this name when authoring files or referencing yourself in logs.]",
      "## Agent Task Protocol",
      "You are a participant in a multi-agent collaboration.",
      "## Active Tasks",
      "- [pending] task-1: do it",
      "Real reply.",
    ].join("\n");

    const filtered = filterInjectedContent(echo);
    expect(filtered).toBe("Real reply.");
  });

  it("preserves agent text that happens to contain bracketed words but does not match a header pattern", () => {
    const text = [
      "I read the file and found this line:",
      "  [Note] This is just a note in the agent's reply.",
      "Done.",
    ].join("\n");

    const filtered = filterInjectedContent(text);
    expect(filtered).toBe(text.trim());
  });

  it("collapses runs of blank lines left after stripping the echoed header", () => {
    const echo = [
      "[Collaborator shared memory: /tmp/mem]",
      "[Tasks file: /tmp/mem/t.md]",
      "[You are @codex1]",
      "[Protocol reminder: signal completion via /tmp/mem/{TASK_ID}.done.json]",
      "",
      "",
      "",
      "Reply line 1.",
      "Reply line 2.",
    ].join("\n");

    const filtered = filterInjectedContent(echo);
    expect(filtered).toBe("Reply line 1.\nReply line 2.");
  });

  it("filters slim-header headings even when the full task list block is present (Your + Other)", () => {
    // Simulates a case where the entire slim header echoes, including the
    // multi-section task summary. Both `## Your active tasks` and
    // `## Other agents' active tasks` patterns must terminate cleanly so
    // they don't swallow the agent's actual reply that follows.
    const echo = [
      "[Tasks file: /tmp/mem/t.md]",
      "[You are @claude2]",
      "[Protocol reminder: x]",
      "## Your active tasks",
      "- [pending] task-A: alpha",
      "## Other agents' active tasks (1)",
      "- task-B (@codex2): beta",
      "[Read-discipline: trust the task list above]",
      "",
      "Agent's actual reply here.",
      "Second line of reply.",
    ].join("\n");

    const filtered = filterInjectedContent(echo);
    expect(filtered).toContain("Agent's actual reply here.");
    expect(filtered).toContain("Second line of reply.");
    expect(filtered).not.toContain("Your active tasks");
    expect(filtered).not.toContain("Other agents' active tasks");
    expect(filtered).not.toContain("Read-discipline");
    expect(filtered).not.toContain("Tasks file:");
    expect(filtered).not.toContain("You are @");
    expect(filtered).not.toContain("Protocol reminder:");
  });
});
