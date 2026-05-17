import { Plus, X as CloseIcon } from "lucide-react";
import { useBrowserStore, MAX_TABS } from "../../stores/browserStore";

/**
 * Chrome-like tab strip. Plan.md row #21.
 * - Tab buttons show title (or fallback "New Tab").
 * - Active tab is highlighted.
 * - Close × per tab.
 * - Single + button (disabled at MAX_TABS with tooltip).
 *
 * Inline styles — same reasoning as the rest of the browser drawer
 * rows (visual reliability regardless of Tailwind JIT cache state).
 */
export function TabStrip() {
  const tabs = useBrowserStore((s) => s.tabs);
  const activeTabId = useBrowserStore((s) => s.activeTabId);
  const newTab = useBrowserStore((s) => s.newTab);
  const closeTab = useBrowserStore((s) => s.closeTab);
  const setActiveTab = useBrowserStore((s) => s.setActiveTab);

  const atCap = tabs.length >= MAX_TABS;

  return (
    <div
      role="tablist"
      aria-label="Browser tabs"
      style={{
        display: "flex",
        alignItems: "stretch",
        gap: 2,
        padding: "4px 6px 0 6px",
        background: "#1f1f1f",
        borderBottom: "1px solid #2a2a2a",
        minHeight: 30,
        flexShrink: 0,
        overflowX: "auto",
      }}
    >
      {tabs.map((tab) => {
        const isActive = tab.id === activeTabId;
        const label = tab.title.trim() !== "" ? tab.title : "New Tab";
        return (
          <div
            key={tab.id}
            role="tab"
            aria-selected={isActive}
            onClick={() => setActiveTab(tab.id)}
            title={label}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              padding: "4px 8px",
              minWidth: 80,
              maxWidth: 200,
              background: isActive ? "#2a2a2a" : "transparent",
              border: "1px solid",
              borderColor: isActive ? "#3a3a3a" : "transparent",
              borderBottom: isActive ? "1px solid #2a2a2a" : "1px solid transparent",
              borderRadius: "6px 6px 0 0",
              cursor: "pointer",
              fontSize: 11,
              color: isActive ? "#e0e0e0" : "#999999",
              flexShrink: 0,
            }}
          >
            <span
              style={{
                flex: 1,
                minWidth: 0,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {label}
            </span>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                closeTab(tab.id);
              }}
              title="Close tab"
              aria-label={`Close ${label}`}
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                padding: 2,
                background: "transparent",
                border: "none",
                color: "#888888",
                cursor: "pointer",
                borderRadius: 3,
                flexShrink: 0,
              }}
            >
              <CloseIcon size={11} />
            </button>
          </div>
        );
      })}
      <button
        type="button"
        onClick={() => {
          if (!atCap) newTab();
        }}
        disabled={atCap}
        title={atCap ? `Tab limit reached (${MAX_TABS})` : "New tab"}
        aria-label="New tab"
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: "4px 8px",
          background: "transparent",
          border: "none",
          color: atCap ? "#555555" : "#cccccc",
          cursor: atCap ? "not-allowed" : "pointer",
          borderRadius: 4,
          flexShrink: 0,
          marginLeft: 2,
        }}
      >
        <Plus size={14} />
      </button>
    </div>
  );
}
