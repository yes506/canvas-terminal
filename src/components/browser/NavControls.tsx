import { ArrowLeft, ArrowRight, RotateCw, X as StopIcon, Loader2 } from "lucide-react";
import { useBrowserStore } from "../../stores/browserStore";
import {
  browserGoBack,
  browserGoForward,
  browserReload,
  browserStop,
} from "../../lib/browserIpc";

/**
 * Back / forward / reload / stop + loading spinner + page title.
 *
 * Buttons are always-enabled (per Phase-3 Round-2: Tauri 2 has no reliable
 * canGoBack/canGoForward source in v1). Clicks at history boundaries are
 * no-ops inside the webview.
 */
export function NavControls() {
  const isLoading = useBrowserStore((s) => s.isLoading);
  const pageTitle = useBrowserStore((s) => s.pageTitle);

  const fireAndForget = (fn: () => Promise<void>) => () => {
    fn().catch(() => {
      // Silent; common case is "browser webview not created" if drawer is
      // closing — the next open will re-create.
    });
  };

  return (
    <div className="flex items-center gap-0.5">
      <button
        type="button"
        className="p-1 text-text-muted hover:text-text hover:bg-surface-lighter rounded transition-colors"
        onClick={fireAndForget(browserGoBack)}
        title="Back"
        aria-label="Back"
      >
        <ArrowLeft size={14} />
      </button>
      <button
        type="button"
        className="p-1 text-text-muted hover:text-text hover:bg-surface-lighter rounded transition-colors"
        onClick={fireAndForget(browserGoForward)}
        title="Forward"
        aria-label="Forward"
      >
        <ArrowRight size={14} />
      </button>
      {isLoading ? (
        <button
          type="button"
          className="p-1 text-text-muted hover:text-text hover:bg-surface-lighter rounded transition-colors"
          onClick={fireAndForget(browserStop)}
          title="Stop"
          aria-label="Stop"
        >
          <StopIcon size={14} />
        </button>
      ) : (
        <button
          type="button"
          className="p-1 text-text-muted hover:text-text hover:bg-surface-lighter rounded transition-colors"
          onClick={fireAndForget(browserReload)}
          title="Reload"
          aria-label="Reload"
        >
          <RotateCw size={14} />
        </button>
      )}
      {isLoading && (
        <Loader2 size={12} className="text-accent animate-spin ml-1 flex-shrink-0" />
      )}
      {pageTitle && (
        <span
          className="ml-2 text-[11px] text-text-muted truncate max-w-[160px]"
          title={pageTitle}
        >
          {pageTitle}
        </span>
      )}
    </div>
  );
}
