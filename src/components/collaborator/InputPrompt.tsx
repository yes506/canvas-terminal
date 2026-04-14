import { useState, useRef, useEffect, useCallback } from "react";
import { useCollaboratorStore, mentionableNames } from "../../stores/collaboratorStore";
import { parseInput, executeCommand } from "./commands";
import { AtMention, extractMentionQuery } from "./AtMention";

const BASE_HEIGHT = 28; // single-line height in px
const LINE_HEIGHT = 18; // approx line height for additional rows
const MAX_ROWS = 6;

export function InputPrompt() {
  const [value, setValue] = useState("");
  const [mentionIndex, setMentionIndex] = useState(0);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const pushHistory = useCollaboratorStore((s) => s.pushHistory);
  const navigateHistory = useCollaboratorStore((s) => s.navigateHistory);
  const agents = useCollaboratorStore((s) => s.agents);

  // Compute mention state
  const cursorPos = inputRef.current?.selectionStart ?? value.length;
  const mention = extractMentionQuery(value, cursorPos);
  const showMention = mention !== null && agents.length > 0;

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

  const handleSubmit = useCallback(async () => {
    const trimmed = value.trim();
    if (!trimmed) return;

    pushHistory(trimmed);
    setValue("");

    const cmd = parseInput(trimmed);
    await executeCommand(cmd);
  }, [value, pushHistory]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
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
      {/* @ mention dropdown */}
      {showMention && mention && (
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
          placeholder="/help  /status  /canvas-export  @all broadcast"
          spellCheck={false}
          autoComplete="off"
          rows={1}
        />
      </div>
    </div>
  );
}
