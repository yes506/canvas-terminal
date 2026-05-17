import { useState, useEffect, FormEvent } from "react";
import {
  useBrowserStore,
  selectActiveUrl,
  selectActiveError,
} from "../../stores/browserStore";
import { classifyScheme } from "../../lib/urlScheme";
import { navigateBrowserTab } from "../../lib/browserIpc";

export function AddressBar() {
  const activeUrl = useBrowserStore(selectActiveUrl);
  const error = useBrowserStore(selectActiveError);
  const setTabError = useBrowserStore((s) => s.setTabError);

  const [draft, setDraft] = useState(activeUrl);

  // Sync draft with the active tab's URL when it changes (link clicks,
  // history pop, tab switch).
  useEffect(() => {
    setDraft(activeUrl);
  }, [activeUrl]);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const tabId = useBrowserStore.getState().activeTabId;
    if (!tabId) return;

    const result = classifyScheme(draft);
    if (result.action !== "allow") {
      setTabError(tabId, `${result.action}: ${result.reason}`);
      return;
    }
    try {
      await navigateBrowserTab(tabId, result.normalizedUrl);
      setTabError(tabId, null);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setTabError(tabId, msg);
    }
  };

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
