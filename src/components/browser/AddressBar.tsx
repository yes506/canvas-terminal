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
        className={`flex-1 min-w-0 bg-surface border ${
          error ? "border-red-400" : "border-surface-lighter"
        } px-2 py-1 text-xs text-text rounded outline-none focus:border-accent min-h-[24px]`}
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
