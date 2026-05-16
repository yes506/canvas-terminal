import { useState, useEffect, FormEvent } from "react";
import { useBrowserStore } from "../../stores/browserStore";
import { classifyScheme } from "../../lib/urlScheme";
import { navigateBrowser } from "../../lib/browserIpc";

export function AddressBar() {
  const currentUrl = useBrowserStore((s) => s.currentUrl);
  const setError = useBrowserStore((s) => s.setError);
  const error = useBrowserStore((s) => s.error);
  const [draft, setDraft] = useState(currentUrl);

  // Keep the visible draft in sync with the canonical store value when the
  // browser navigates on its own (link clicks, history pop, etc.).
  useEffect(() => {
    setDraft(currentUrl);
  }, [currentUrl]);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const result = classifyScheme(draft);
    if (result.action !== "allow") {
      setError(`${result.action}: ${result.reason}`);
      return;
    }
    try {
      await navigateBrowser(result.normalizedUrl);
      setError(null);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="flex-1 min-w-0 flex items-center gap-1">
      <input
        type="text"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        placeholder="Enter URL"
        // High-contrast against row's bg-surface (#1a1a1a): use
        // bg-surface-lighter (#3a3a3a) + visible border. The previous
        // bg-surface input + 1px border-surface-lighter was nearly
        // invisible on a dark theme (user feedback round 4-UX).
        className={`flex-1 min-w-0 bg-surface-lighter border ${
          error ? "border-red-400" : "border-text-dim"
        } px-3 py-1.5 text-xs text-text rounded-md outline-none focus:border-accent focus:ring-1 focus:ring-accent placeholder:text-text-muted min-h-[28px]`}
        spellCheck={false}
        aria-label="Address bar"
      />
      {error && (
        <span
          className="text-[10px] text-red-400 truncate max-w-[180px] flex-shrink-0"
          title={error}
        >
          {error}
        </span>
      )}
    </form>
  );
}
