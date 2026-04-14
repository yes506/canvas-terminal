import { useState, useRef, useEffect, useCallback } from "react";
import {
  useCollaboratorStore,
  mentionableNames,
  agentDisplayName,
  toolShortName,
} from "../../stores/collaboratorStore";
import { parseInput, executeCommand } from "./commands";
import { AtMention, extractMentionQuery } from "./AtMention";
import type { SpawnedAgent } from "../../types/collaborator";

const BASE_HEIGHT = 28; // single-line height in px
const LINE_HEIGHT = 18; // approx line height for additional rows
const MAX_ROWS = 6;

/** Pending message awaiting target selection. */
interface PendingMessage {
  message: string;
  /** When set, wraps the selected target into a command instead of plain send. */
  commandPrefix?: string;
}

function targetHandle(agent: SpawnedAgent, allAgents: SpawnedAgent[]): string {
  const sameToolAgents = allAgents
    .filter((a) => a.tool === agent.tool)
    .sort((a, b) => a.sessionId.localeCompare(b.sessionId));
  const short = toolShortName(agent.tool);

  if (sameToolAgents.length <= 1) return `@${short}`;

  const index =
    sameToolAgents.findIndex((a) => a.sessionId === agent.sessionId) + 1;
  return `@${short}${index}`;
}

export function InputPrompt() {
  const [value, setValue] = useState("");
  const [mentionIndex, setMentionIndex] = useState(0);
  const [pending, setPending] = useState<PendingMessage | null>(null);
  const [selectorIndex, setSelectorIndex] = useState(0);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const pushHistory = useCollaboratorStore((s) => s.pushHistory);
  const navigateHistory = useCollaboratorStore((s) => s.navigateHistory);
  const agents = useCollaboratorStore((s) => s.agents);
  const pendingInput = useCollaboratorStore((s) => s.pendingInput);
  const setPendingInput = useCollaboratorStore((s) => s.setPendingInput);

  // Consume externally-set pending input (e.g. from canvas toolbar)
  useEffect(() => {
    if (pendingInput !== null) {
      setValue(pendingInput);
      setPendingInput(null);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [pendingInput, setPendingInput]);

  // Compute mention state
  const cursorPos = inputRef.current?.selectionStart ?? value.length;
  const mention = extractMentionQuery(value, cursorPos);
  const showMention = mention !== null && agents.length > 0;

  // Build selector options: individual agents + "all" (skip "all" for canvas commands)
  const selectorOptions: Array<{
    label: string;
    detail?: string;
    agent: SpawnedAgent | null;
  }> = agents.map((a) => ({
    label: agentDisplayName(a, agents),
    detail: targetHandle(a, agents),
    agent: a,
  }));
  if (agents.length > 1 && !pending?.commandPrefix) {
    selectorOptions.push({ label: "All agents", detail: "@all", agent: null });
  }
  const showSelector = pending !== null && selectorOptions.length > 0;

  // Compute filtered count for bounds checking
  const filteredCount = (() => {
    if (!mention) return 0;
    const names = mentionableNames(agents);
    const lower = mention.query.toLowerCase();
    let count = names.filter((n) => n.toLowerCase().startsWith(lower)).length;
    if ("all".startsWith(lower)) count++;
    return count;
  })();

  // Reset mention index when query changes
  useEffect(() => {
    setMentionIndex(0);
  }, [mention?.query]);

  // Reset selector index when pending changes
  useEffect(() => {
    setSelectorIndex(0);
  }, [pending]);

  // Auto-focus on mount
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Auto-resize textarea height
  const lineCount = value.split("\n").length;
  const rows = Math.min(lineCount, MAX_ROWS);
  const textareaHeight =
    rows <= 1 ? BASE_HEIGHT : BASE_HEIGHT + (rows - 1) * LINE_HEIGHT;

  const insertMention = useCallback(
    (name: string) => {
      if (!mention) return;
      const before = value.slice(0, mention.start);
      const after = value.slice(cursorPos);
      const newValue = `${before}@${name} ${after}`;
      setValue(newValue);
      // Move cursor after the inserted mention
      const newPos = mention.start + name.length + 2; // @name + space
      requestAnimationFrame(() => {
        inputRef.current?.setSelectionRange(newPos, newPos);
      });
    },
    [mention, value, cursorPos],
  );

  /** Execute with a selected target from the selector. */
  const executeWithTarget = useCallback(
    async (option: { label: string; detail?: string; agent: SpawnedAgent | null }) => {
      if (!pending) return;
      const { message: msg, commandPrefix } = pending;
      setPending(null);

      if (commandPrefix && option.agent) {
        // Canvas command with target — execute as a slash command
        const handle = option.detail ?? `@${toolShortName(option.agent.tool)}`;
        const fullCmd = `${commandPrefix} ${handle}`;
        await executeCommand(parseInput(fullCmd));
      } else {
        const store = useCollaboratorStore.getState();
        if (option.agent === null) {
          // "All agents" selected
          await store.broadcastToAll(msg);
        } else {
          // Send directly to the specific agent
          await store.sendToAgent(option.agent.sessionId, msg);
        }
      }
      requestAnimationFrame(() => inputRef.current?.focus());
    },
    [pending],
  );

  /** Dismiss the selector and return the message to the input. */
  const dismissSelector = useCallback(() => {
    if (pending) {
      setValue(pending.message);
      setPending(null);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [pending]);

  const handleSubmit = useCallback(async () => {
    const trimmed = value.trim();
    if (!trimmed) return;

    pushHistory(trimmed);
    setValue("");

    const cmd = parseInput(trimmed);

    if (cmd.type === "needs-target") {
      if (agents.length === 0) {
        useCollaboratorStore.getState().setStatus("No agents running.");
        return;
      }
      if (agents.length === 1) {
        // Only one agent — send directly without showing selector
        await useCollaboratorStore.getState().sendToAgent(agents[0].sessionId, cmd.message!);
        return;
      }
      // Multiple agents — show target selector
      setPending({ message: cmd.message! });
      return;
    }

    // Canvas commands without a target → show target selector
    if ((cmd.type === "canvas-export" || cmd.type === "canvas-import") && !cmd.target) {
      if (agents.length === 0) {
        useCollaboratorStore.getState().setStatus("No agents running.");
        return;
      }
      const prefix = cmd.type === "canvas-export" ? "/canvas-export" : "/canvas-import";
      if (agents.length === 1) {
        // Only one agent — execute directly
        const handle = `@${toolShortName(agents[0].tool)}`;
        await executeCommand(parseInput(`${prefix} ${handle}`));
        return;
      }
      // Multiple agents — show target selector
      setPending({ message: prefix, commandPrefix: prefix });
      return;
    }

    await executeCommand(cmd);
  }, [value, pushHistory, agents]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      // --- Target selector is visible ---
      if (showSelector) {
        if (e.key === "ArrowUp") {
          e.preventDefault();
          setSelectorIndex((i) => (i > 0 ? i - 1 : selectorOptions.length - 1));
          return;
        }
        if (e.key === "ArrowDown") {
          e.preventDefault();
          setSelectorIndex((i) => (i < selectorOptions.length - 1 ? i + 1 : 0));
          return;
        }
        if (e.key === "Enter" || e.key === "Tab") {
          e.preventDefault();
          const selected = selectorOptions[selectorIndex];
          if (selected) executeWithTarget(selected);
          return;
        }
        if (e.key === "Escape") {
          e.preventDefault();
          dismissSelector();
          return;
        }
        // Number keys 1-9 for quick selection
        const num = parseInt(e.key);
        if (num >= 1 && num <= selectorOptions.length) {
          e.preventDefault();
          executeWithTarget(selectorOptions[num - 1]);
          return;
        }
        return;
      }

      // When mention dropdown is visible, intercept navigation keys
      if (showMention && filteredCount > 0) {
        if (e.key === "ArrowUp") {
          e.preventDefault();
          setMentionIndex((i) => (i > 0 ? i - 1 : filteredCount - 1));
          return;
        }
        if (e.key === "ArrowDown") {
          e.preventDefault();
          setMentionIndex((i) => (i < filteredCount - 1 ? i + 1 : 0));
          return;
        }
        if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
          e.preventDefault();
          // Get the name at mentionIndex from the filtered list
          const names = mentionableNames(agents);
          const lower = (mention?.query ?? "").toLowerCase();
          const filtered = names.filter((n) =>
            n.toLowerCase().startsWith(lower),
          );
          if ("all".startsWith(lower)) filtered.push("all");
          const selected = filtered[mentionIndex];
          if (selected) insertMention(selected);
          return;
        }
        if (e.key === "Escape") {
          e.preventDefault();
          // Clear the @ token to dismiss
          if (mention) {
            const before = value.slice(0, mention.start);
            const after = value.slice(cursorPos);
            setValue(before + after);
          }
          return;
        }
      }

      // Shift+Enter → insert newline (line feed)
      if (e.key === "Enter" && e.shiftKey) {
        // Let the default textarea behavior insert a newline
        return;
      }

      // Default behavior
      if (e.key === "Enter") {
        e.preventDefault();
        handleSubmit();
      } else if (e.key === "ArrowUp" && !value.includes("\n")) {
        // Only navigate history when input is single-line
        e.preventDefault();
        const prev = navigateHistory("up");
        if (prev !== null) setValue(prev);
      } else if (e.key === "ArrowDown" && !value.includes("\n")) {
        e.preventDefault();
        const next = navigateHistory("down");
        if (next !== null) setValue(next);
      }
    },
    [
      showSelector,
      selectorOptions,
      selectorIndex,
      executeWithTarget,
      dismissSelector,
      showMention,
      filteredCount,
      mentionIndex,
      agents,
      mention,
      value,
      cursorPos,
      insertMention,
      handleSubmit,
      navigateHistory,
    ],
  );

  return (
    <div className="relative shrink-0">
      {/* Target selector dropdown */}
      {showSelector && (
        <div className="absolute bottom-full left-0 right-0 mx-2 mb-1 bg-surface-light border border-surface-lighter rounded-md shadow-lg overflow-hidden z-50">
          <div className="px-3 py-1.5 text-xs text-text-dim border-b border-surface-lighter font-mono">
            Send to: <span className="text-cyan-400">↑↓</span> navigate{" "}
            <span className="text-cyan-400">Enter</span> select{" "}
            <span className="text-cyan-400">Esc</span> cancel
          </div>
          {selectorOptions.map((opt, i) => (
            <button
              key={opt.agent?.sessionId ?? "all"}
              className={`w-full text-left px-3 py-1.5 text-sm font-mono transition-colors ${
                i === selectorIndex
                  ? "bg-accent/20 text-accent"
                  : "text-text hover:bg-surface-lighter"
              }`}
              onMouseEnter={() => setSelectorIndex(i)}
              onClick={() => executeWithTarget(opt)}
            >
              <span className="text-text-dim mr-2">{i + 1}.</span>
              <span>{opt.label}</span>
              {opt.detail && (
                <span className="text-text-dim ml-2">{opt.detail}</span>
              )}
            </button>
          ))}
        </div>
      )}

      {/* @ mention dropdown */}
      {showMention && !showSelector && mention && (
        <AtMention
          query={mention.query}
          selectedIndex={mentionIndex}
          onSelect={insertMention}
        />
      )}

      <div
        className="flex items-start px-3 py-1.5 border-t border-surface-lighter bg-surface font-mono text-sm cursor-text"
        onClick={() => inputRef.current?.focus()}
      >
        <span className="text-green-400 font-bold mr-2 select-none leading-7">&gt;</span>
        <textarea
          ref={inputRef}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={handleKeyDown}
          className="flex-1 bg-transparent text-text outline-none placeholder-text-dim resize-none leading-7"
          style={{ height: textareaHeight }}
          placeholder={
            pending
              ? "Select a target above..."
              : "/help  /status  /canvas-export  @agent message"
          }
          spellCheck={false}
          autoComplete="off"
          rows={1}
          readOnly={!!pending}
        />
      </div>
    </div>
  );
}
