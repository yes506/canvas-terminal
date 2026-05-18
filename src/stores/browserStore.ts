import { create } from "zustand";
import type { BrowserState, Tab } from "../types/browser";

const DEFAULT_DRAWER_WIDTH = 500; // CSS px; clamped on first user drag
const MAX_TABS = 10;
const BLANK_URL = "about:blank";

function makeBlankTab(): Tab {
  return {
    id: crypto.randomUUID(),
    url: BLANK_URL,
    title: "",
    isLoading: false,
    error: null,
  };
}

interface BrowserStoreActions {
  toggle: () => void;
  setDrawerOpen: (open: boolean) => void;
  setDrawerWidth: (width: number) => void;

  // Tab lifecycle
  newTab: () => void;
  closeTab: (id: string) => void;
  setActiveTab: (id: string) => void;

  // Per-tab field setters (called by browser-tab-* event subscribers)
  setTabUrl: (id: string, url: string) => void;
  setTabTitle: (id: string, title: string) => void;
  setTabLoading: (id: string, isLoading: boolean) => void;
  setTabError: (id: string, err: string | null) => void;

  // Bulk seed (used by BrowserTabsSettings.seedFirstTabUrl on mount)
  seedInitialTab: (url: string) => void;
}

export type BrowserStore = BrowserState & BrowserStoreActions;

export const useBrowserStore = create<BrowserStore>((set) => ({
  drawerOpen: false,
  drawerWidth: DEFAULT_DRAWER_WIDTH,
  tabs: [],
  activeTabId: null,

  toggle: () => set((s) => ({ drawerOpen: !s.drawerOpen })),
  setDrawerOpen: (open) => set({ drawerOpen: open }),
  setDrawerWidth: (width) => set({ drawerWidth: width }),

  newTab: () =>
    set((s) => {
      if (s.tabs.length >= MAX_TABS) return s;
      const tab = makeBlankTab();
      return { tabs: [...s.tabs, tab], activeTabId: tab.id };
    }),

  closeTab: (id) =>
    set((s) => {
      const idx = s.tabs.findIndex((t) => t.id === id);
      if (idx < 0) return s;
      const remaining = s.tabs.filter((t) => t.id !== id);
      if (remaining.length === 0) {
        // Last tab closed → replace with one fresh blank tab (SC3).
        const replacement = makeBlankTab();
        return { tabs: [replacement], activeTabId: replacement.id };
      }
      // Pick next active if we closed the active one. Prefer the
      // previous sibling (Chrome-like); fall back to the new first tab.
      let nextActive = s.activeTabId;
      if (s.activeTabId === id) {
        const prevIdx = Math.max(0, idx - 1);
        nextActive = remaining[Math.min(prevIdx, remaining.length - 1)].id;
      }
      return { tabs: remaining, activeTabId: nextActive };
    }),

  setActiveTab: (id) =>
    set((s) => {
      if (!s.tabs.find((t) => t.id === id)) return s;
      return { activeTabId: id };
    }),

  setTabUrl: (id, url) =>
    set((s) => ({
      tabs: s.tabs.map((t) => (t.id === id ? { ...t, url } : t)),
    })),
  setTabTitle: (id, title) =>
    set((s) => ({
      tabs: s.tabs.map((t) => (t.id === id ? { ...t, title } : t)),
    })),
  setTabLoading: (id, isLoading) =>
    set((s) => ({
      tabs: s.tabs.map((t) => (t.id === id ? { ...t, isLoading } : t)),
    })),
  setTabError: (id, err) =>
    set((s) => ({
      tabs: s.tabs.map((t) => (t.id === id ? { ...t, error: err } : t)),
    })),

  seedInitialTab: (url) =>
    set((s) => {
      if (s.tabs.length > 0) return s; // already seeded
      const tab: Tab = { ...makeBlankTab(), url };
      return { tabs: [tab], activeTabId: tab.id };
    }),
}));

/** Selector helpers — return undefined when there is no active tab. */
export function selectActiveTab(s: BrowserState): Tab | undefined {
  return s.tabs.find((t) => t.id === s.activeTabId);
}
export function selectActiveUrl(s: BrowserState): string {
  return selectActiveTab(s)?.url ?? BLANK_URL;
}
export function selectActiveTitle(s: BrowserState): string {
  return selectActiveTab(s)?.title ?? "";
}
export function selectActiveLoading(s: BrowserState): boolean {
  return selectActiveTab(s)?.isLoading ?? false;
}
export function selectActiveError(s: BrowserState): string | null {
  return selectActiveTab(s)?.error ?? null;
}

export { MAX_TABS };
