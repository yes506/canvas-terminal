import { create } from "zustand";
import type { Update } from "@tauri-apps/plugin-updater";

export type UpdateState =
  | "idle"
  | "checking"
  | "available"
  | "downloading"
  | "readyToRelaunch"
  | "upToDate"
  | "error";

interface UpdateStoreState {
  state: UpdateState;
  availableVersion: string | null;
  update: Update | null;
  downloadProgress: number;
  error: string | null;

  setState: (state: UpdateState) => void;
  setAvailable: (update: Update) => void;
  setProgress: (progress: number) => void;
  setError: (message: string) => void;
  dismiss: () => void;
}

export const useUpdateStore = create<UpdateStoreState>((set) => ({
  state: "idle",
  availableVersion: null,
  update: null,
  downloadProgress: 0,
  error: null,

  setState: (state) => set({ state, error: null }),
  setAvailable: (update) =>
    set({
      state: "available",
      availableVersion: update.version,
      update,
      error: null,
    }),
  setProgress: (downloadProgress) => set({ downloadProgress }),
  setError: (error) => set({ state: "error", error }),
  dismiss: () =>
    set({
      state: "idle",
      availableVersion: null,
      update: null,
      downloadProgress: 0,
      error: null,
    }),
}));
