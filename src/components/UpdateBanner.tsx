import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useUpdateStore } from "../stores/updateStore";
import { downloadAndInstall, restartApp, skipVersion } from "../lib/updater";

const RELEASES_URL = "https://github.com/yes506/canvas-terminal/releases/latest";
const UP_TO_DATE_AUTO_DISMISS_MS = 4000;

function openReleasesPage() {
  invoke("open_external_url", { url: RELEASES_URL }).catch((err) => {
    console.warn("[updater] open_external_url failed:", err);
  });
}

export function UpdateBanner() {
  const { state, availableVersion, update, downloadProgress, error, dismiss } =
    useUpdateStore();

  // Auto-dismiss the "up to date" confirmation after a few seconds. The state
  // is only set on manual checks (per lib/updater.ts), so this is the user's
  // explicit confirmation that the menu command did something — no need to
  // leave it sitting there forever.
  useEffect(() => {
    if (state !== "upToDate") return;
    const handle = window.setTimeout(dismiss, UP_TO_DATE_AUTO_DISMISS_MS);
    return () => window.clearTimeout(handle);
  }, [state, dismiss]);

  if (state === "idle" || state === "checking") {
    return null;
  }

  return (
    <div
      role="status"
      className="flex items-center gap-3 px-3 py-1.5 text-xs bg-surface-light border-b border-surface-lighter text-text"
      style={{ minHeight: 28 }}
    >
      {state === "available" && update && (
        <>
          <span className="flex-1">
            <span className="font-semibold">v{availableVersion}</span> is available
            — installing will close all terminal tabs.
          </span>
          <button
            className="px-2 py-0.5 bg-accent text-surface rounded hover:opacity-90"
            onClick={() => downloadAndInstall(update)}
          >
            Install
          </button>
          <button
            className="px-2 py-0.5 text-text-muted hover:text-text"
            onClick={() => availableVersion && skipVersion(availableVersion)}
          >
            Skip this version
          </button>
        </>
      )}

      {state === "downloading" && (
        <>
          <span className="flex-1">
            Downloading v{availableVersion}… {Math.round(downloadProgress * 100)}%
          </span>
          <div className="w-32 h-1 bg-surface-lighter rounded overflow-hidden">
            <div
              className="h-full bg-accent transition-all"
              style={{ width: `${downloadProgress * 100}%` }}
            />
          </div>
        </>
      )}

      {state === "readyToRelaunch" && (
        <>
          <span className="flex-1">
            Update ready. Restart to finish installing v{availableVersion}.
          </span>
          <button
            className="px-2 py-0.5 bg-accent text-surface rounded hover:opacity-90"
            onClick={() => restartApp()}
          >
            Restart now
          </button>
          <button
            className="px-2 py-0.5 text-text-muted hover:text-text"
            onClick={dismiss}
          >
            Restart later
          </button>
        </>
      )}

      {state === "upToDate" && (
        <>
          <span className="flex-1">Canvas Terminal is up to date.</span>
          <button
            className="px-2 py-0.5 text-text-muted hover:text-text"
            onClick={dismiss}
          >
            Dismiss
          </button>
        </>
      )}

      {state === "error" && (
        <>
          <span className="flex-1">{error}</span>
          <button
            className="px-2 py-0.5 bg-accent text-surface rounded hover:opacity-90"
            onClick={openReleasesPage}
          >
            Open releases page
          </button>
          <button
            className="px-2 py-0.5 text-text-muted hover:text-text"
            onClick={dismiss}
          >
            Dismiss
          </button>
        </>
      )}
    </div>
  );
}
