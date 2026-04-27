import { create } from "zustand";

interface ToastState {
  message: string | null;
  showToast: (msg: string, ttlMs?: number) => void;
}

let gen = 0;

// FIXME: the renderer for this store currently lives in DrawingBoard.tsx.
// If a future route mounts the app without DrawingBoard, the toast won't render.
// Consider hoisting the renderer to App.tsx as a follow-up.
export const useToastStore = create<ToastState>((set) => ({
  message: null,
  showToast: (msg, ttlMs = 2500) => {
    const my = ++gen;
    set({ message: msg });
    window.setTimeout(() => {
      // Generation guard: only clear if no newer toast has been shown.
      if (my === gen) set({ message: null });
    }, ttlMs);
  },
}));
