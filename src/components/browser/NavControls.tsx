import { ArrowLeft, ArrowRight, RotateCw, X as StopIcon, Loader2 } from "lucide-react";
import {
  useBrowserStore,
  selectActiveLoading,
} from "../../stores/browserStore";
import {
  browserTabGoBack,
  browserTabGoForward,
  browserTabReload,
  browserTabStop,
} from "../../lib/browserIpc";

/**
 * Back / forward / reload-or-stop + loading spinner — routed to the
 * active tab via the BrowserStore.activeTabId.
 */
export function NavControls() {
  const isLoading = useBrowserStore(selectActiveLoading);

  const fireAndForget = (fn: (tabId: string) => Promise<void>) => () => {
    const tabId = useBrowserStore.getState().activeTabId;
    if (!tabId) return;
    fn(tabId).catch(() => {
      // Silent; "browser tab not created" if the drawer is closing.
    });
  };

  const btnStyle: React.CSSProperties = {
    padding: 4,
    color: "#999999",
    background: "transparent",
    border: "none",
    cursor: "pointer",
    borderRadius: 4,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
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
        onClick={fireAndForget(browserTabGoBack)}
        title="Back"
        aria-label="Back"
      >
        <ArrowLeft size={16} color="#cccccc" />
      </button>
      <button
        type="button"
        style={btnStyle}
        onClick={fireAndForget(browserTabGoForward)}
        title="Forward"
        aria-label="Forward"
      >
        <ArrowRight size={16} color="#cccccc" />
      </button>
      {isLoading ? (
        <button
          type="button"
          style={btnStyle}
          onClick={fireAndForget(browserTabStop)}
          title="Stop"
          aria-label="Stop"
        >
          <StopIcon size={16} color="#cccccc" />
        </button>
      ) : (
        <button
          type="button"
          style={btnStyle}
          onClick={fireAndForget(browserTabReload)}
          title="Reload"
          aria-label="Reload"
        >
          <RotateCw size={16} color="#cccccc" />
        </button>
      )}
      {isLoading && (
        <Loader2 size={14} color="#ffffff" style={{ marginLeft: 4, flexShrink: 0 }} />
      )}
    </div>
  );
}
