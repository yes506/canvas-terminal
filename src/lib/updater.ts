import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { invoke } from "@tauri-apps/api/core";
import { useUpdateStore } from "../stores/updateStore";

interface Settings {
  auto_check_updates: boolean;
  last_skipped_version: string | null;
}

async function getSettings(): Promise<Settings> {
  try {
    return await invoke<Settings>("get_settings");
  } catch {
    return { auto_check_updates: true, last_skipped_version: null };
  }
}

async function setSettings(settings: Settings): Promise<void> {
  try {
    await invoke("set_settings", { settings });
  } catch {
    // Persist failure is non-fatal — the toggle still works in-memory for the session.
  }
}

let inFlight = false;

export async function checkForUpdates(opts: { manual: boolean }): Promise<void> {
  if (inFlight) return;
  inFlight = true;
  const store = useUpdateStore.getState();

  try {
    const settings = await getSettings();
    if (!opts.manual && !settings.auto_check_updates) {
      // Setting gates the auto-check path; manual checks always proceed.
      return;
    }

    store.setState("checking");

    let update: Update | null = null;
    try {
      update = await check();
    } catch (err) {
      // Network error / 404 / malformed manifest — silent on auto, visible on manual.
      if (opts.manual) {
        store.setError("Couldn't check for updates. Please try again later.");
      } else {
        store.setState("idle");
      }
      console.warn("[updater] check failed:", err);
      return;
    }

    if (!update) {
      // Already on latest.
      if (opts.manual) {
        store.setState("upToDate");
      } else {
        store.setState("idle");
      }
      return;
    }

    if (!opts.manual && settings.last_skipped_version === update.version) {
      // User dismissed this exact version on a previous run.
      store.setState("idle");
      return;
    }

    store.setAvailable(update);
  } finally {
    inFlight = false;
  }
}

export async function downloadAndInstall(update: Update): Promise<void> {
  const store = useUpdateStore.getState();
  store.setState("downloading");
  store.setProgress(0);

  let totalBytes = 0;
  let downloadedBytes = 0;

  try {
    await update.downloadAndInstall((event) => {
      switch (event.event) {
        case "Started":
          totalBytes = event.data.contentLength ?? 0;
          downloadedBytes = 0;
          store.setProgress(0);
          break;
        case "Progress":
          downloadedBytes += event.data.chunkLength;
          if (totalBytes > 0) {
            store.setProgress(Math.min(1, downloadedBytes / totalBytes));
          }
          break;
        case "Finished":
          store.setProgress(1);
          break;
      }
    });
    store.setState("readyToRelaunch");
  } catch (err) {
    const message = String(err ?? "");
    if (message.toLowerCase().includes("signature")) {
      // Signature verification failed — recovery-oriented copy, not attack-alarm.
      store.setError(
        "Update couldn't be verified. Open the releases page to download manually.",
      );
    } else {
      store.setError("Update install failed. Please try again later.");
    }
    console.warn("[updater] install failed:", err);
  }
}

export async function restartApp(): Promise<void> {
  await relaunch();
}

export async function skipVersion(version: string): Promise<void> {
  const settings = await getSettings();
  await setSettings({ ...settings, last_skipped_version: version });
  useUpdateStore.getState().setState("idle");
}

export async function setAutoCheckEnabled(enabled: boolean): Promise<void> {
  const settings = await getSettings();
  await setSettings({ ...settings, auto_check_updates: enabled });
}
