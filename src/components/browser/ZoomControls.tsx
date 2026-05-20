import { ZoomIn, ZoomOut } from "lucide-react";
import {
  useBrowserStore,
  selectActiveZoom,
  nextZoomStep,
  prevZoomStep,
  ZOOM_DEFAULT,
} from "../../stores/browserStore";
import { browserTabSetZoom } from "../../lib/browserIpc";

/**
 * Apply a new zoom level to the active tab. IPC-first: the OS-layer
 * `Webview::set_zoom` must succeed before the store commits, so the
 * displayed percent can never lie about the rendered page. "not
 * created" errors during the create-race silently no-op; any other
 * Rust-side failure surfaces via the per-tab error field.
 */
async function applyZoom(level: number) {
  const state = useBrowserStore.getState();
  const tabId = state.activeTabId;
  if (!tabId) return;
  const current = state.tabs.find((t) => t.id === tabId)?.zoom ?? ZOOM_DEFAULT;
  if (level === current) return;
  try {
    await browserTabSetZoom(tabId, level);
    useBrowserStore.getState().setTabZoom(tabId, level);
  } catch (err) {
    const msg = String(err);
    if (msg.includes("not created")) return; // transient create-race
    useBrowserStore.getState().setTabError(tabId, msg);
  }
}

/**
 * Three-button zoom group rendered after the AddressBar in the
 * browser drawer's nav row. Decoupled from `NavControls` because
 * the layout requires it after the address input, while NavControls
 * sits before it.
 */
export function ZoomControls() {
  const zoom = useBrowserStore(selectActiveZoom);
  const percentLabel = `${Math.round(zoom * 100)}%`;

  const btnStyle: React.CSSProperties = {
    padding: 4,
    color: "#cccccc",
    background: "transparent",
    border: "none",
    cursor: "pointer",
    borderRadius: 4,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  };

  const labelStyle: React.CSSProperties = {
    minWidth: 40,
    padding: "2px 6px",
    color: "#cccccc",
    background: "transparent",
    border: "none",
    cursor: "pointer",
    borderRadius: 4,
    fontSize: 11,
    fontFamily: "inherit",
    fontVariantNumeric: "tabular-nums",
    textAlign: "center",
  };

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 2,
        flexShrink: 0,
      }}
    >
      <button
        type="button"
        style={btnStyle}
        onClick={() => applyZoom(prevZoomStep(zoom))}
        title="Zoom out (Cmd+-)"
        aria-label="Zoom out"
      >
        <ZoomOut size={16} />
      </button>
      <button
        type="button"
        style={labelStyle}
        onClick={() => applyZoom(ZOOM_DEFAULT)}
        title="Reset zoom to 100% (Cmd+0)"
        aria-label={`Reset zoom (currently ${percentLabel})`}
      >
        {percentLabel}
      </button>
      <button
        type="button"
        style={btnStyle}
        onClick={() => applyZoom(nextZoomStep(zoom))}
        title="Zoom in (Cmd+=)"
        aria-label="Zoom in"
      >
        <ZoomIn size={16} />
      </button>
    </div>
  );
}
