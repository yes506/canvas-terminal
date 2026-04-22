import { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Folder, File } from "lucide-react";

export interface FileEntry {
  name: string;
  isDir: boolean;
  fullPath: string;
}

interface FileCompletionProps {
  /** The path query after the trigger (e.g. "/usr/lo" from "@/usr/lo") */
  query: string;
  selectedIndex: number;
  onSelect: (fullPath: string, isDir: boolean, confirmSelect?: boolean) => void;
  /** Reports the number of visible entries so the parent can clamp keyboard index */
  onEntryCount?: (count: number) => void;
  /** Ref callback to let the parent trigger selection of the current index via keyboard.
   *  When called with confirmDir=true (Enter), directories are confirmed as final selections.
   *  When called without or false (Tab), directories are navigated into. */
  selectRef?: React.MutableRefObject<((confirmDir?: boolean) => void) | null>;
}

function isEscapedWhitespace(value: string, index: number): boolean {
  if (!/\s/.test(value[index] ?? "")) return false;
  let backslashes = 0;
  for (let i = index - 1; i >= 0 && value[i] === "\\"; i--) {
    backslashes++;
  }
  return backslashes % 2 === 1;
}

export function escapeShellPath(path: string): string {
  return path.replace(/([\\\s"'`$!&()*[\]{}|;<>?])/g, "\\$1");
}

export function unescapeShellPath(path: string): string {
  return path.replace(/\\(.)/g, "$1");
}

/**
 * Detect file-path completion trigger in input text.
 * Returns the path query and start position if `@/`, `@./`, or `@~/` is found.
 */
export function extractFileQuery(
  value: string,
  cursorPos: number,
): { query: string; start: number } | null {
  // Scan backward to the start of the current whitespace-delimited token.
  // This allows `@` characters inside the path itself, such as
  // `@./node_modules/@types/react`, while still using a leading `@` as the trigger.
  let i = cursorPos - 1;
  while (
    i >= 0 &&
    (!/\s/.test(value[i]) || isEscapedWhitespace(value, i))
  ) {
    i--;
  }
  const tokenStart = i + 1;
  const token = value.slice(tokenStart, cursorPos);
  if (!token.startsWith("@")) return null;
  if (token.length < 2) return null;

  const rawQuery = token.slice(1);
  const query = unescapeShellPath(rawQuery);
  // Must start with /, ./, or ~/  to be a file path
  if (!query.startsWith("/") && !query.startsWith("./") && !query.startsWith("~/")) {
    return null;
  }

  return { query, start: tokenStart };
}

export function FileCompletion({
  query,
  selectedIndex,
  onSelect,
  onEntryCount,
  selectRef,
}: FileCompletionProps) {
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);

  // Derive the directory to list and the filter prefix
  const lastSlash = query.lastIndexOf("/");
  const dirPath = lastSlash >= 0 ? query.slice(0, lastSlash + 1) : query;
  const filter = lastSlash >= 0 ? query.slice(lastSlash + 1).toLowerCase() : "";
  const showHidden = filter.startsWith(".");

  // Fetch directory entries when dirPath changes
  useEffect(() => {
    let cancelled = false;
    setLoading(true);

    invoke<Array<[string, boolean, string]>>("list_directory", { path: dirPath })
      .then((result) => {
        if (cancelled) return;
        setEntries(
          result.map(([name, isDir, fullPath]) => ({ name, isDir, fullPath })),
        );
      })
      .catch(() => {
        if (!cancelled) setEntries([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => { cancelled = true; };
  }, [dirPath]);

  // Filter entries by the partial name after the last /
  const filtered = entries.filter((e) => {
    if (!showHidden && e.name.startsWith(".")) return false;
    return e.name.toLowerCase().startsWith(filter);
  });

  // Report entry count to parent
  useEffect(() => {
    onEntryCount?.(filtered.length);
  }, [filtered.length, onEntryCount]);

  // Expose keyboard-triggered select
  useEffect(() => {
    if (selectRef) {
      selectRef.current = (confirmDir?: boolean) => {
        const entry = filtered[selectedIndex];
        if (entry) onSelect(entry.fullPath, entry.isDir, confirmDir);
      };
    }
    return () => {
      if (selectRef) selectRef.current = null;
    };
  }, [selectRef, filtered, selectedIndex, onSelect]);

  // Scroll selected into view
  useEffect(() => {
    const el = listRef.current?.children[selectedIndex] as HTMLElement | undefined;
    el?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  if (loading && filtered.length === 0) {
    return (
      <div className="absolute bottom-full left-0 right-0 mb-1 mx-3 bg-surface-light border border-surface-lighter rounded-md shadow-lg px-3 py-2 z-20">
        <span className="text-xs text-text-dim font-mono">Loading...</span>
      </div>
    );
  }

  if (filtered.length === 0) return null;

  return (
    <div
      ref={listRef}
      className="absolute bottom-full left-0 right-0 mb-1 mx-3 bg-surface-light border border-surface-lighter rounded-md shadow-lg max-h-48 overflow-y-auto z-20"
    >
      {filtered.map((entry, i) => (
        <button
          key={entry.fullPath}
          className={`flex items-center gap-2 w-full px-3 py-1.5 text-xs text-left transition-colors ${
            i === selectedIndex
              ? "bg-accent/20 text-text"
              : "text-text hover:bg-surface-lighter"
          }`}
          onMouseDown={(e) => {
            e.preventDefault();
            onSelect(entry.fullPath, entry.isDir);
          }}
          onMouseEnter={() => {
            // Visual hover feedback only — index controlled by parent
          }}
        >
          {entry.isDir ? (
            <Folder size={12} className="text-yellow-400 shrink-0" />
          ) : (
            <File size={12} className="text-text-dim shrink-0" />
          )}
          <span className="font-mono truncate">
            {entry.name}
            {entry.isDir ? "/" : ""}
          </span>
        </button>
      ))}
    </div>
  );
}
