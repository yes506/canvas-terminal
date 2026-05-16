import { create } from "zustand";
import type { BrowserState } from "../types/browser";

const DEFAULT_DRAWER_WIDTH = 500; // CSS px; clamped on first user drag

interface BrowserStoreActions {
  toggle: () => void;
  setDrawerOpen: (open: boolean) => void;
  setDrawerWidth: (width: number) => void;
  setCurrentUrl: (url: string) => void;
  setPageTitle: (title: string) => void;
  setLoading: (isLoading: boolean) => void;
  setError: (err: string | null) => void;
}

export type BrowserStore = BrowserState & BrowserStoreActions;

export const useBrowserStore = create<BrowserStore>((set) => ({
  drawerOpen: false,
  drawerWidth: DEFAULT_DRAWER_WIDTH,
  currentUrl: "about:blank",
  pageTitle: "",
  isLoading: false,
  error: null,

  toggle: () => set((s) => ({ drawerOpen: !s.drawerOpen, error: null })),
  setDrawerOpen: (open) => set({ drawerOpen: open }),
  setDrawerWidth: (width) => set({ drawerWidth: width }),
  setCurrentUrl: (url) => set({ currentUrl: url }),
  setPageTitle: (title) => set({ pageTitle: title }),
  setLoading: (isLoading) => set({ isLoading }),
  setError: (err) => set({ error: err }),
}));
