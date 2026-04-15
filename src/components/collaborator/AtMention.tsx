import { useRef, useEffect } from "react";
import { useShallow } from "zustand/react/shallow";
import { useCollaboratorStore, mentionableNames, toolLabel } from "../../stores/collaboratorStore";
import { useCollabSessionId } from "./CollabSessionContext";
import { TOOL_CONFIGS } from "../../types/collaborator";

interface AtMentionProps {
  query: string;
  selectedIndex: number;
  onSelect: (name: string) => void;
}

/** Map a mentionable name to a color class. */
function colorForName(name: string): string {
  for (const cfg of TOOL_CONFIGS) {
    if (name.startsWith(cfg.command)) return cfg.colorClass;
  }
  return "text-accent";
}

export function AtMention({ query, selectedIndex, onSelect }: AtMentionProps) {
  const collabSessionId = useCollabSessionId();
  const agents = useCollaboratorStore(
    useShallow((s) => s.agents.filter((a) => a.collabSessionId === collabSessionId)),
  );
  const listRef = useRef<HTMLDivElement>(null);

  // Build options: filtered mentionable names + "all"
  const names = mentionableNames(agents);
  const lower = query.toLowerCase();
  const filtered = names.filter((n) => n.toLowerCase().startsWith(lower));
  // Always include "all" if it matches or query is empty
  if ("all".startsWith(lower)) {
    filtered.push("all");
  }

  // Scroll selected into view
  useEffect(() => {
    const el = listRef.current?.children[selectedIndex] as HTMLElement | undefined;
    el?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  if (filtered.length === 0) return null;

  return (
    <div
      ref={listRef}
      className="absolute bottom-full left-0 right-0 mb-1 mx-3 bg-surface-light border border-surface-lighter rounded-md shadow-lg max-h-40 overflow-y-auto z-20"
    >
      {filtered.map((name, i) => {
        const isAll = name === "all";
        const color = isAll ? "text-accent" : colorForName(name);
        const label = isAll
          ? "Broadcast to all"
          : toolLabel(
              TOOL_CONFIGS.find((c) => name.startsWith(c.command))?.id ?? name,
            );

        return (
          <button
            key={name}
            className={`flex items-center gap-2 w-full px-3 py-1.5 text-xs text-left transition-colors ${
              i === selectedIndex
                ? "bg-accent/20 text-text"
                : "text-text hover:bg-surface-lighter"
            }`}
            onMouseDown={(e) => {
              e.preventDefault(); // Prevent input blur
              onSelect(name);
            }}
          >
            <span className={`font-bold ${color}`}>@{name}</span>
            <span className="text-text-dim">{label}</span>
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
