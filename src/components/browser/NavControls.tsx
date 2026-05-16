import { ArrowLeft, ArrowRight, RotateCw, X as StopIcon, Loader2 } from "lucide-react";
import { useBrowserStore } from "../../stores/browserStore";
import {
  browserGoBack,
  browserGoForward,
  browserReload,
  browserStop,
} from "../../lib/browserIpc";

/**
 * Back / forward / reload-or-stop + loading spinner. The page title is
 * rendered separately in BrowserDrawer's top row so it can't squeeze the
 * address bar.
 *
 * Round-5-UX: switched fully to inline styles to bypass any Tailwind
 * JIT/cache miss. The previous Tailwind-based version may have had
 * specific classes (text-text-muted, hover:bg-surface-lighter,
 * text-accent, animate-spin) silently dropped from the dev bundle.
 */
export function NavControls() {
  const isLoading = useBrowserStore((s) => s.isLoading);

  const fireAndForget = (fn: () => Promise<void>) => () => {
    fn().catch(() => {
      // Silent; "browser webview not created" if drawer is closing.
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
      <button type="button" style={btnStyle} onClick={fireAndForget(browserGoBack)} title="Back" aria-label="Back">
        <ArrowLeft size={16} color="#cccccc" />
      </button>
      <button type="button" style={btnStyle} onClick={fireAndForget(browserGoForward)} title="Forward" aria-label="Forward">
        <ArrowRight size={16} color="#cccccc" />
      </button>
      {isLoading ? (
        <button type="button" style={btnStyle} onClick={fireAndForget(browserStop)} title="Stop" aria-label="Stop">
          <StopIcon size={16} color="#cccccc" />
        </button>
      ) : (
        <button type="button" style={btnStyle} onClick={fireAndForget(browserReload)} title="Reload" aria-label="Reload">
          <RotateCw size={16} color="#cccccc" />
        </button>
      )}
      {isLoading && (
        <Loader2 size={14} color="#ffffff" style={{ marginLeft: 4, flexShrink: 0 }} />
      )}
    </div>
  );
}
