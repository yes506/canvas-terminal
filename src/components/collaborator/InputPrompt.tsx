import { useState, useRef, useEffect, useCallback } from "react";
import { useShallow } from "zustand/react/shallow";
import {
  useCollaboratorStore,
  mentionableNames,
  agentDisplayName,
} from "../../stores/collaboratorStore";
import { useCollabSessionId } from "./CollabSessionContext";
import { parseInput, executeCommand } from "./commands";
import { AtMention, extractMentionQuery } from "./AtMention";
import { FileCompletion, escapeShellPath, extractFileQuery } from "./FileCompletion";
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

function targetHandle(agent: SpawnedAgent): string {
  return `@${agent.handle}`;
}

export function InputPrompt() {
  const collabSessionId = useCollabSessionId();
  const [value, setValue] = useState("");
  const [mentionIndex, setMentionIndex] = useState(0);
  const [fileIndex, setFileIndex] = useState(0);
  const [fileEntryCount, setFileEntryCount] = useState(0);
  const [pending, setPending] = useState<PendingMessage | null>(null);
  const [selectorIndex, setSelectorIndex] = useState(0);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileSelectRef = useRef<((confirmDir?: boolean) => void) | null>(null);
  const pushHistory = useCollaboratorStore((s) => s.pushHistory);
  const navigateHistory = useCollaboratorStore((s) => s.navigateHistory);
  const agents = useCollaboratorStore(
    useShallow((s) => s.agents.filter((a) => a.collabSessionId === collabSessionId)),
  );
  const pendingInput = useCollaboratorStore((s) => s.pendingInputs[collabSessionId] ?? null);
  const setPendingInput = useCollaboratorStore((s) => s.setPendingInput);

  // Consume externally-set pending input (e.g. from canvas toolbar)
  useEffect(() => {
    if (pendingInput !== null) {
      setValue(pendingInput);
      setPendingInput(collabSessionId, null);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [pendingInput, setPendingInput, collabSessionId]);

  // Compute mention and file-completion state
  const cursorPos = inputRef.current?.selectionStart ?? value.length;
  const fileQuery = extractFileQuery(value, cursorPos);
  const mention = fileQuery ? null : extractMentionQuery(value, cursorPos);
  const showFile = fileQuery !== null;
  const showMention = mention !== null && agents.length > 0;

  // Build selector options: individual agents + "all" when the pending command supports broadcast.
  // Sort by ordinal for consistent ordering in the selector.
  const sortedAgents = [...agents].sort((a, b) => a.ordinal - b.ordinal || a.tool.localeCompare(b.tool));
  const selectorOptions: Array<{
    label: string;
    detail?: string;
    agent: SpawnedAgent | null;
  }> = sortedAgents.map((a) => ({
    label: agentDisplayName(a),
    detail: targetHandle(a),
    agent: a,
  }));
  const allowAllSelectorOption =
    !pending?.commandPrefix || !pending.commandPrefix.startsWith("/canvas-import");
  if (agents.length > 1 && allowAllSelectorOption) {
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

  // Reset file index when file query changes
  useEffect(() => {
    setFileIndex(0);
  }, [fileQuery?.query]);

  // Track file entry count for keyboard bounds (updated by FileCompletion via callback)
  const handleFileEntryCount = useCallback((count: number) => {
    setFileEntryCount(count);
  }, []);

  // Reset selector index when pending changes
  useEffect(() => {
    setSelectorIndex(0);
  }, [pending]);

  // Auto-focus on mount
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Auto-resize textarea height based on scrollHeight (handles soft wraps + hard newlines)
  const MAX_HEIGHT = BASE_HEIGHT + (MAX_ROWS - 1) * LINE_HEIGHT;
  const [textareaHeight, setTextareaHeight] = useState(BASE_HEIGHT);

  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    // Reset to minimum so scrollHeight reflects actual content
    el.style.height = `${BASE_HEIGHT}px`;
    const needed = Math.min(el.scrollHeight, MAX_HEIGHT);
    el.style.height = `${needed}px`;
    el.style.overflowY = el.scrollHeight > MAX_HEIGHT ? "auto" : "hidden";
    setTextareaHeight(needed);
  }, [value]);

  // Re-measure when the container width changes (soft wraps change without text change)
  useEffect(() => {
    const el = inputRef.current?.parentElement;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const ta = inputRef.current;
      if (!ta) return;
      ta.style.height = `${BASE_HEIGHT}px`;
      const needed = Math.min(ta.scrollHeight, MAX_HEIGHT);
      ta.style.height = `${needed}px`;
      ta.style.overflowY = ta.scrollHeight > MAX_HEIGHT ? "auto" : "hidden";
      setTextareaHeight(needed);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const insertFilePath = useCallback(
    (fullPath: string, isDir: boolean, confirmSelect?: boolean) => {
      if (!fileQuery) return;
      if (isDir && !confirmSelect) {
        // Tab on directory — descend into it, keep @ trigger and dropdown open
        const before = value.slice(0, fileQuery.start);
        const after = value.slice(cursorPos);
        const escapedPath = escapeShellPath(fullPath);
        const dirPath = escapedPath.endsWith("/") ? escapedPath : `${escapedPath}/`;
        const newValue = `${before}@${dirPath}${after}`;
        setValue(newValue);
        const newPos = fileQuery.start + 1 + dirPath.length;
        requestAnimationFrame(() => {
          inputRef.current?.setSelectionRange(newPos, newPos);
          inputRef.current?.focus();
        });
      } else {
        // Enter on any entry, or file selected — insert full path and close dropdown
        const before = value.slice(0, fileQuery.start);
        const after = value.slice(cursorPos);
        const escapedPath = escapeShellPath(fullPath);
        // Append trailing / for directories so the path is unambiguous
        const suffix = isDir ? "/" : "";
        const newValue = `${before}${escapedPath}${suffix} ${after}`;
        setValue(newValue);
        const newPos = fileQuery.start + escapedPath.length + suffix.length + 1;
        requestAnimationFrame(() => {
          inputRef.current?.setSelectionRange(newPos, newPos);
          inputRef.current?.focus();
        });
      }
      setFileIndex(0);
    },
    [fileQuery, value, cursorPos],
  );

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

      if (commandPrefix) {
        // Canvas command with target — insert @handle or @all right after the slash command
        const handle = option.agent
          ? (option.detail ?? `@${option.agent.handle}`)
          : "@all";
        const spaceIdx = commandPrefix.indexOf(" ", 1);
        const baseCmd = spaceIdx > 0 ? commandPrefix.slice(0, spaceIdx) : commandPrefix;
        const trailing = spaceIdx > 0 ? commandPrefix.slice(spaceIdx) : "";
        const fullCmd = `${baseCmd} ${handle}${trailing}`;
        await executeCommand(parseInput(fullCmd), collabSessionId);
      } else {
        const store = useCollaboratorStore.getState();
        if (option.agent === null) {
          // "All agents" selected — scoped to this collaborator pane
          await store.broadcastToAll(msg, collabSessionId);
        } else {
          // Send directly to the specific agent
          await store.sendToAgent(option.agent.sessionId, msg);
        }
      }
      requestAnimationFrame(() => inputRef.current?.focus());
    },
    [pending, collabSessionId],
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

    pushHistory(trimmed, collabSessionId);
    setValue("");

    const cmd = parseInput(trimmed);

    if (cmd.type === "needs-target") {
      if (agents.length === 0) {
        useCollaboratorStore.getState().setStatus("No agents running.", collabSessionId);
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

    // Canvas export without a target → show target selector (not auto-broadcast)
    if (cmd.type === "canvas-export" && !cmd.target) {
      if (agents.length === 0) {
        useCollaboratorStore.getState().setStatus("No agents running.", collabSessionId);
        return;
      }
      const prefix = "/canvas-export";
      const suffix = cmd.message ? ` ${cmd.message}` : "";
      if (agents.length === 1) {
        const handle = agents[0].handle;
        await executeCommand(parseInput(`${prefix} @${handle}${suffix}`), collabSessionId);
        return;
      }
      setPending({ message: `${prefix}${suffix}`, commandPrefix: `${prefix}${suffix}` });
      return;
    }

    // Canvas import without a target → show target selector
    if (cmd.type === "canvas-import" && !cmd.target) {
      if (agents.length === 0) {
        useCollaboratorStore.getState().setStatus("No agents running.", collabSessionId);
        return;
      }
      const prefix = "/canvas-import";
      const suffix = cmd.message ? ` ${cmd.message}` : "";
      if (agents.length === 1) {
        // Only one agent — execute directly
        const handle = agents[0].handle;
        await executeCommand(parseInput(`${prefix} @${handle}${suffix}`), collabSessionId);
        return;
      }
      // Multiple agents — show target selector (preserve user message in commandPrefix)
      setPending({ message: `${prefix}${suffix}`, commandPrefix: `${prefix}${suffix}` });
      return;
    }

    await executeCommand(cmd, collabSessionId);
  }, [value, pushHistory, agents, collabSessionId]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      // Never interfere with IME composition (Korean, Japanese, Chinese)
      if (e.nativeEvent.isComposing || e.keyCode === 229) return;

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

      // When file completion dropdown is visible, intercept navigation keys
      if (showFile && fileEntryCount > 0) {
        if (e.key === "ArrowUp") {
          e.preventDefault();
          setFileIndex((i) => (i > 0 ? i - 1 : fileEntryCount - 1));
          return;
        }
        if (e.key === "ArrowDown") {
          e.preventDefault();
          setFileIndex((i) => (i < fileEntryCount - 1 ? i + 1 : 0));
          return;
        }
        if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
          e.preventDefault();
          // Enter = confirm selection (insert path, close dropdown)
          // Tab   = navigate into directory (keep dropdown open)
          const confirmDir = e.key === "Enter";
          fileSelectRef.current?.(confirmDir);
          return;
        }
        if (e.key === "Escape") {
          e.preventDefault();
          // Remove the @path text to dismiss
          if (fileQuery) {
            const before = value.slice(0, fileQuery.start);
            const after = value.slice(cursorPos);
            setValue(before + after);
          }
          return;
        }
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
        const prev = navigateHistory("up", collabSessionId, value);
        if (prev !== null) setValue(prev);
      } else if (e.key === "ArrowDown" && !value.includes("\n")) {
        e.preventDefault();
        const next = navigateHistory("down", collabSessionId);
        if (next !== null) setValue(next);
      }
    },
    [
      showSelector,
      selectorOptions,
      selectorIndex,
      executeWithTarget,
      dismissSelector,
      showFile,
      fileEntryCount,
      fileQuery,
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

      {/* File path completion dropdown */}
      {showFile && !showSelector && fileQuery && (
        <FileCompletion
          query={fileQuery.query}
          selectedIndex={fileIndex}
          onSelect={insertFilePath}
          onEntryCount={handleFileEntryCount}
          selectRef={fileSelectRef}
        />
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
