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
  const [checkedIds, setCheckedIds] = useState<Set<string>>(new Set());
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

  // Reset selector index AND checked set when pending changes (selector opens
  // or closes). Checked-set reset is critical: a previous canceled selection
  // must not survive into the next time the selector opens.
  useEffect(() => {
    setSelectorIndex(0);
    setCheckedIds(new Set());
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

  /** Toggle a row's checked state in the selector's multi-select set. */
  const toggleChecked = useCallback((id: string) => {
    setCheckedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  /** Execute with the entire checked set. Routes to broadcastToAll only when
   *  the synthetic "all" sentinel row is checked. Selecting every individual
   *  agent fans out N sendToAgent calls — equivalent in result, but each agent
   *  receives its own first-send-gating window rather than one shared one. */
  const executeWithChecked = useCallback(async () => {
    if (!pending) return;
    const { message: msg, commandPrefix } = pending;
    const ids = Array.from(checkedIds);
    if (ids.length === 0) return;
    setPending(null);
    setCheckedIds(new Set());

    const store = useCollaboratorStore.getState();
    const allSelected = ids.includes("all");

    if (commandPrefix) {
      // Canvas command paths: fan out per checked agent. The "all" sentinel
      // takes precedence — running canvas-export once with @all is cheaper
      // than N individual exports.
      const spaceIdx = commandPrefix.indexOf(" ", 1);
      const baseCmd = spaceIdx > 0 ? commandPrefix.slice(0, spaceIdx) : commandPrefix;
      const trailing = spaceIdx > 0 ? commandPrefix.slice(spaceIdx) : "";
      if (allSelected) {
        await executeCommand(parseInput(`${baseCmd} @all${trailing}`), collabSessionId);
      } else {
        for (const id of ids) {
          const agent = agents.find((a) => a.sessionId === id);
          if (!agent) continue;
          await executeCommand(
            parseInput(`${baseCmd} @${agent.handle}${trailing}`),
            collabSessionId,
          );
        }
      }
    } else {
      if (allSelected) {
        await store.broadcastToAll(msg, collabSessionId);
      } else {
        for (const id of ids) {
          await store.sendToAgent(id, msg);
        }
      }
    }
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [pending, checkedIds, agents, collabSessionId]);

  /** Execute with a selected target from the selector. */
  const executeWithTarget = useCallback(
    async (option: { label: string; detail?: string; agent: SpawnedAgent | null }) => {
      if (!pending) return;
      const { message: msg, commandPrefix } = pending;
      setPending(null);
      setCheckedIds(new Set());

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
      setCheckedIds(new Set());
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
        // Space toggles the cursor row's checkbox.
        if (e.key === " ") {
          e.preventDefault();
          const opt = selectorOptions[selectorIndex];
          if (opt) toggleChecked(opt.agent?.sessionId ?? "all");
          return;
        }
        if (e.key === "Enter" || e.key === "Tab") {
          e.preventDefault();
          // If the user has explicitly checked rows, send to those.
          // Otherwise fall back to the cursor row (single-target fast path
          // preserves muscle memory for "open selector, press Enter").
          if (checkedIds.size > 0) {
            executeWithChecked();
          } else {
            const selected = selectorOptions[selectorIndex];
            if (selected) executeWithTarget(selected);
          }
          return;
        }
        if (e.key === "Escape") {
          e.preventDefault();
          dismissSelector();
          return;
        }
        // Digit keys 1-9 toggle the corresponding row's checkbox (NOT one-shot
        // send). This keeps the selection model uniform: Space, click, and
        // digits all toggle; Enter submits. Previous behavior (one-shot send
        // on digit) silently discarded user-toggled checkboxes — see v6 §7.
        const num = parseInt(e.key);
        if (num >= 1 && num <= selectorOptions.length) {
          e.preventDefault();
          const opt = selectorOptions[num - 1];
          if (opt) {
            toggleChecked(opt.agent?.sessionId ?? "all");
            setSelectorIndex(num - 1);
          }
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
      checkedIds,
      toggleChecked,
      executeWithChecked,
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
          <div className="px-3 py-1.5 text-xs text-text-dim border-b border-surface-lighter font-mono flex items-center justify-between">
            <span>
              Send to: <span className="text-cyan-400">↑↓</span> navigate{" "}
              <span className="text-cyan-400">Space/1-9</span> toggle{" "}
              <span className="text-cyan-400">Enter</span> send{" "}
              <span className="text-cyan-400">Esc</span> cancel
            </span>
            {checkedIds.size > 0 && (
              <span className="text-accent font-bold">{checkedIds.size} selected</span>
            )}
          </div>
          {selectorOptions.map((opt, i) => {
            const id = opt.agent?.sessionId ?? "all";
            const isChecked = checkedIds.has(id);
            return (
              <button
                key={id}
                className={`w-full text-left px-3 py-1.5 text-sm font-mono transition-colors flex items-center gap-2 ${
                  i === selectorIndex
                    ? "bg-accent/20 text-accent"
                    : "text-text hover:bg-surface-lighter"
                }`}
                onMouseEnter={() => setSelectorIndex(i)}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => toggleChecked(id)}
              >
                <span className="text-text-dim w-4 shrink-0">{i + 1}.</span>
                <span
                  className={`inline-block w-3.5 h-3.5 border rounded-sm shrink-0 flex items-center justify-center text-[10px] leading-none ${
                    isChecked
                      ? "bg-accent border-accent text-surface"
                      : "border-surface-lighter bg-surface"
                  }`}
                  aria-hidden="true"
                >
                  {isChecked ? "✓" : ""}
                </span>
                <span className="truncate">{opt.label}</span>
                {opt.detail && (
                  <span className="text-text-dim ml-2 truncate">{opt.detail}</span>
                )}
              </button>
            );
          })}
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
