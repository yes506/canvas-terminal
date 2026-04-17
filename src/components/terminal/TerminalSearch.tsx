import { useState, useRef, useEffect } from "react";
import { X, ChevronUp, ChevronDown } from "lucide-react";
import {
  useTerminalStore,
  getSearchAddon,
  selectActiveSessionId,
} from "../../stores/terminalStore";

export function TerminalSearch() {
  const searchVisible = useTerminalStore((s) => s.searchVisible);
  const setSearchVisible = useTerminalStore((s) => s.setSearchVisible);
  const activeSessionId = useTerminalStore(selectActiveSessionId);
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (searchVisible) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [searchVisible]);

  if (!searchVisible || !activeSessionId) return null;

  const addon = getSearchAddon(activeSessionId);

  const findNext = () => {
    if (addon && query) addon.findNext(query);
  };

  const findPrev = () => {
    if (addon && query) addon.findPrevious(query);
  };

  const close = () => {
    if (addon) addon.clearDecorations();
    setSearchVisible(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    // Never interfere with IME composition (Korean, Japanese, Chinese)
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;

    if (e.key === "Enter") {
      e.preventDefault();
      if (e.shiftKey) findPrev();
      else findNext();
    }
    if (e.key === "Escape") {
      e.preventDefault();
      close();
    }
  };

  return (
    <div className="absolute top-0 right-0 z-50 flex items-center gap-1 px-2 py-1 bg-surface-light border border-surface-lighter rounded-bl-md shadow-lg">
      <input
        ref={inputRef}
        type="text"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          if (addon && e.target.value) addon.findNext(e.target.value);
        }}
        onKeyDown={handleKeyDown}
        placeholder="Find..."
        className="bg-surface text-text text-xs px-2 py-1 rounded border border-surface-lighter outline-none focus:border-accent w-40"
      />
      <button
        onClick={findPrev}
        className="text-text-muted hover:text-text p-0.5"
        title="Previous (Shift+Enter)"
      >
        <ChevronUp size={14} />
      </button>
      <button
        onClick={findNext}
        className="text-text-muted hover:text-text p-0.5"
        title="Next (Enter)"
      >
        <ChevronDown size={14} />
      </button>
      <button
        onClick={close}
        className="text-text-muted hover:text-text p-0.5"
        title="Close (Escape)"
      >
        <X size={14} />
      </button>
    </div>
  );
}
