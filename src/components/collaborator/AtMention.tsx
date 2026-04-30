import { useRef, useEffect } from "react";
import { useShallow } from "zustand/react/shallow";
import { useCollaboratorStore } from "../../stores/collaboratorStore";
import { useCollabSessionId } from "./CollabSessionContext";
import { TOOL_CONFIGS, type SpawnedAgent, type ToolId } from "../../types/collaborator";

interface AtMentionProps {
  query: string;
  selectedIndex: number;
  onSelect: (name: string) => void;
}

/** One row in the mention dropdown. Discriminated so the synthetic broadcast
 *  row (no `tool`) is type-safe without optional chaining at every call site. */
export type MentionEntry =
  | {
      kind: "agent";
      handle: string;
      nickname: string;
      nicknameSlug: string;
      tool: ToolId;
      ordinal: number;
    }
  | { kind: "all" };

/** Pure helper used by both the dropdown render and the InputPrompt key handler.
 *  Filters agents by handle prefix or nicknameSlug prefix (case-insensitive),
 *  sorted by ordinal then tool, with the synthetic "all" row appended when its
 *  prefix matches the query. One entry per agent — Array.filter over `agents`
 *  guarantees uniqueness without a separate dedup pass. */
export function filterMentionEntries(
  query: string,
  agents: SpawnedAgent[],
): MentionEntry[] {
  const q = query.toLowerCase();
  const sorted = [...agents].sort(
    (a, b) => a.ordinal - b.ordinal || a.tool.localeCompare(b.tool),
  );
  const entries: MentionEntry[] = sorted
    .filter(
      (a) =>
        a.handle.toLowerCase().startsWith(q) ||
        a.nicknameSlug.startsWith(q),
    )
    .map((a) => ({
      kind: "agent",
      handle: a.handle,
      nickname: a.nickname,
      nicknameSlug: a.nicknameSlug,
      tool: a.tool,
      ordinal: a.ordinal,
    }));
  if ("all".startsWith(q)) entries.push({ kind: "all" });
  return entries;
}

export function AtMention({ query, selectedIndex, onSelect }: AtMentionProps) {
  const collabSessionId = useCollabSessionId();
  const agents = useCollaboratorStore(
    useShallow((s) => s.agents.filter((a) => a.collabSessionId === collabSessionId)),
  );
  const listRef = useRef<HTMLDivElement>(null);

  const entries = filterMentionEntries(query, agents);

  // Scroll selected into view
  useEffect(() => {
    const el = listRef.current?.children[selectedIndex] as HTMLElement | undefined;
    el?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  if (entries.length === 0) return null;

  return (
    <div
      ref={listRef}
      className="absolute bottom-full left-0 right-0 mb-1 mx-3 bg-surface-light border border-surface-lighter rounded-md shadow-lg max-h-40 overflow-y-auto z-20"
    >
      {entries.map((entry, i) => {
        const colorClass =
          entry.kind === "all"
            ? "text-accent"
            : TOOL_CONFIGS.find((c) => c.id === entry.tool)?.colorClass ??
              "text-text";

        const key = entry.kind === "all" ? "__all__" : entry.handle;
        const selectValue = entry.kind === "all" ? "all" : entry.handle;
        const primary =
          entry.kind === "all" ? "@all" : entry.nickname;
        const secondary =
          entry.kind === "all" ? "Broadcast to all" : `@${entry.handle}`;

        return (
          <button
            key={key}
            className={`flex items-center gap-2 w-full px-3 py-1.5 text-xs text-left transition-colors ${
              i === selectedIndex
                ? "bg-accent/20 text-text"
                : "text-text hover:bg-surface-lighter"
            }`}
            onMouseDown={(e) => {
              e.preventDefault(); // Prevent input blur
              onSelect(selectValue);
            }}
          >
            <span className={`font-bold ${colorClass} truncate min-w-0`}>{primary}</span>
            <span className="text-text-dim flex-shrink-0">{secondary}</span>
          </button>
        );
      })}
    </div>
  );
}

/** Extract the @-mention query from an input string at cursor position. */
export function extractMentionQuery(
  value: string,
  cursorPos: number,
): { query: string; start: number } | null {
  // Scan backward from cursor to find @
  let i = cursorPos - 1;
  while (i >= 0 && /[a-zA-Z0-9]/.test(value[i])) {
    i--;
  }
  if (i < 0 || value[i] !== "@") return null;
  // @ must be at start or preceded by whitespace
  if (i > 0 && !/\s/.test(value[i - 1])) return null;

  const query = value.slice(i + 1, cursorPos);
  return { query, start: i };
}
