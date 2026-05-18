import { FolderOpen } from "lucide-react";
import { open } from "@tauri-apps/plugin-dialog";
import { useBrowserStore } from "../../stores/browserStore";
import { mintLocalFileToken, navigateBrowserTab } from "../../lib/browserIpc";

/**
 * Opens the native file picker, mints a tab-scoped localfile token
 * via IPC, and navigates the active tab to
 * `localfile://localhost/<token>` (C9 path-based shape).
 *
 * Errors (canceled dialog excepted) surface via `setTabError` on the
 * BrowserStore — same channel the address bar uses for URL-validation
 * errors, so the red border + error message reuse the existing UX.
 */
export function OpenFileButton() {
  const handleClick = async () => {
    const tabId = useBrowserStore.getState().activeTabId;
    if (!tabId) return;
    const setTabError = useBrowserStore.getState().setTabError;

    try {
      const picked = await open({ multiple: false, directory: false });
      // User canceled — no error.
      if (picked === null || picked === undefined) return;
      // tauri-plugin-dialog v2 returns `string` for a single non-directory
      // pick when `multiple: false`; defensive for older API shapes.
      const path =
        typeof picked === "string"
          ? picked
          : Array.isArray(picked)
            ? picked[0]
            : (picked as { path: string }).path;
      if (!path) return;

      const token = await mintLocalFileToken(tabId, path);
      const url = `localfile://localhost/${token}`;
      await navigateBrowserTab(tabId, url);
      setTabError(tabId, null);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setTabError(tabId, msg);
    }
  };

  return (
    <button
      type="button"
      onClick={handleClick}
      title="Open Local File"
      aria-label="Open Local File"
      style={{
        padding: 4,
        color: "#999999",
        background: "transparent",
        border: "none",
        cursor: "pointer",
        borderRadius: 4,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <FolderOpen size={16} color="#cccccc" />
    </button>
  );
}
