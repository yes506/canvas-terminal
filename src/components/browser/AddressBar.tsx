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

  // INLINE STYLES — round 5-UX investigation showed Row 2 is rendering at
  // the correct DOM location but the input element itself was invisible.
  // The chrome ROWS use inline styles and ARE visible; the INPUT inside
  // used Tailwind classes (bg-surface-lighter, border-text-dim,
  // placeholder:text-text-muted, focus:ring-1) and was NOT. Hypothesis:
  // Tailwind JIT missed emitting these classes (hot-reload cache or
  // scan-glob miss). Switching to inline styles guarantees rendering
  // regardless of Tailwind build state.
  return (
    <form
      onSubmit={handleSubmit}
      style={{
        flex: 1,
        minWidth: 0,
        display: "flex",
        alignItems: "center",
        gap: 4,
      }}
    >
      <input
        type="text"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        placeholder="Enter URL"
        spellCheck={false}
        aria-label="Address bar"
        style={{
          flex: 1,
          minWidth: 0,
          background: "#3a3a3a",
          border: error ? "1px solid #f87171" : "1px solid #888888",
          padding: "6px 12px",
          fontSize: 12,
          color: "#e0e0e0",
          borderRadius: 6,
          outline: "none",
          minHeight: 28,
          fontFamily: "inherit",
        }}
        onFocus={(e) => {
          e.currentTarget.style.borderColor = "#ffffff";
          e.currentTarget.style.boxShadow = "0 0 0 1px #ffffff";
        }}
        onBlur={(e) => {
          e.currentTarget.style.borderColor = error ? "#f87171" : "#888888";
          e.currentTarget.style.boxShadow = "none";
        }}
      />
      {error && (
        <span
          style={{
            fontSize: 10,
            color: "#f87171",
            maxWidth: 180,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            flexShrink: 0,
          }}
          title={error}
        >
          {error}
        </span>
      )}
    </form>
  );
}
