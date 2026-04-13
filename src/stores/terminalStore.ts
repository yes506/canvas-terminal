import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import type { Terminal } from "@xterm/xterm";
import type { SearchAddon } from "@xterm/addon-search";
import type { Tab, PaneNode, PaneLeaf, ClosedTab } from "../types/terminal";
import { generateSessionId } from "../lib/sessionId";

// Terminal instance registry
const terminalInstances = new Map<string, Terminal>();
const searchAddons = new Map<string, SearchAddon>();

// Session CWD map — stores initial cwd for sessions spawned via duplicateTab
const sessionCwdMap = new Map<string, string>();

let nextTabId = 1;

export function consumeSessionCwd(sessionId: string): string | undefined {
  const cwd = sessionCwdMap.get(sessionId);
  if (cwd) sessionCwdMap.delete(sessionId);
  return cwd;
}

export function registerTerminal(id: string, term: Terminal, search: SearchAddon) {
  terminalInstances.set(id, term);
  searchAddons.set(id, search);
}

export function unregisterTerminal(id: string) {
  terminalInstances.delete(id);
  searchAddons.delete(id);
}

export function getTerminalInstance(id: string): Terminal | undefined {
  return terminalInstances.get(id);
}

export function getSearchAddon(id: string): SearchAddon | undefined {
  return searchAddons.get(id);
}

export function getActiveSessionId(): string | null {
  const state = useTerminalStore.getState();
  const tab = state.tabs.find((t) => t.id === state.activeTabId);
  return tab?.activePaneSessionId ?? null;
}

export function selectActiveSessionId(state: TerminalState): string | null {
  const tab = state.tabs.find((t) => t.id === state.activeTabId);
  return tab?.activePaneSessionId ?? null;
}

// Pane tree helpers
function findAndReplace(
  node: PaneNode,
  targetSessionId: string,
  replacer: (leaf: PaneLeaf) => PaneNode
): PaneNode {
  if (node.type === "leaf") {
    return node.sessionId === targetSessionId ? replacer(node) : node;
  }
  return {
    ...node,
    children: [
      findAndReplace(node.children[0], targetSessionId, replacer),
      findAndReplace(node.children[1], targetSessionId, replacer),
    ],
  };
}

function removeLeaf(node: PaneNode, targetSessionId: string): PaneNode | null {
  if (node.type === "leaf") {
    return node.sessionId === targetSessionId ? null : node;
  }
  const left = removeLeaf(node.children[0], targetSessionId);
  const right = removeLeaf(node.children[1], targetSessionId);
  if (!left) return right;
  if (!right) return left;
  return { ...node, children: [left, right] };
}

function collectSessionIds(node: PaneNode): string[] {
  if (node.type === "leaf") return [node.sessionId];
  return [
    ...collectSessionIds(node.children[0]),
    ...collectSessionIds(node.children[1]),
  ];
}

const UNDO_CLOSE_TIMEOUT = 5000;

interface TerminalState {
  tabs: Tab[];
  activeTabId: string | null;
  fontSize: number;
  searchVisible: boolean;
  themeName: string;
  closedTabs: ClosedTab[];

  // Tab management
  addTab: (cwd?: string) => void;
  duplicateTab: (tabId: string) => void;
  removeTab: (id: string) => void;
  setActiveTab: (id: string) => void;
  renameTab: (id: string, title: string) => void;
  reorderTab: (fromIndex: number, toIndex: number) => void;
  undoCloseTab: () => void;

  // Pane management
  splitPane: (direction: "horizontal" | "vertical") => void;
  removePaneSession: (sessionId: string) => void;
  setActivePaneSession: (sessionId: string) => void;
  navigatePane: (direction: "next" | "prev") => void;
  toggleMaximizePane: () => void;

  // Font
  increaseFontSize: () => void;
  decreaseFontSize: () => void;
  resetFontSize: () => void;

  // Search
  toggleSearch: () => void;
  setSearchVisible: (visible: boolean) => void;

  // Theme
  setTheme: (name: string) => void;
}

export const useTerminalStore = create<TerminalState>((set, get) => ({
  tabs: [],
  activeTabId: null,
  fontSize: 13,
  searchVisible: false,
  themeName: "monochrome",
  closedTabs: [],

  addTab: (cwd?: string) => {
    const sessionId = generateSessionId();
    // Store cwd so useTerminal can pass it to spawn_shell
    if (cwd) {
      sessionCwdMap.set(sessionId, cwd);
    }
    const tabId = `tab-${nextTabId++}-${Date.now()}`;
    const tab: Tab = {
      id: tabId,
      title: `Terminal ${get().tabs.length + 1}`,
      paneTree: { type: "leaf", sessionId },
      activePaneSessionId: sessionId,
      maximizedPaneSessionId: null,
    };
    set((state) => ({
      tabs: [...state.tabs, tab],
      activeTabId: tabId,
    }));
  },

  duplicateTab: (tabId: string) => {
    const state = get();
    const tab = state.tabs.find((t) => t.id === tabId);
    if (!tab) return;

    // Get the CWD of the active pane's PTY session
    invoke<string>("get_pty_cwd", { sessionId: tab.activePaneSessionId })
      .then((cwd) => {
        get().addTab(cwd);
      })
      .catch(() => {
        // Fallback: open tab with default directory
        get().addTab();
      });
  },

  removeTab: (id) => {
    const state = get();
    const idx = state.tabs.findIndex((t) => t.id === id);
    if (idx === -1) return;

    const tabToClose = state.tabs[idx];
    const filtered = [...state.tabs];
    filtered.splice(idx, 1);

    // Save to closed tabs stack for undo
    const closedTabs = [
      { tab: tabToClose, closedAt: Date.now() },
      ...state.closedTabs,
    ].slice(0, 5); // Keep max 5

    set({
      tabs: filtered,
      activeTabId:
        state.activeTabId === id
          ? filtered[filtered.length - 1]?.id ?? null
          : state.activeTabId,
      closedTabs,
    });
  },

  setActiveTab: (id) => set({ activeTabId: id }),

  renameTab: (id, title) =>
    set((state) => ({
      tabs: state.tabs.map((t) =>
        t.id === id ? { ...t, title: title.trim() || t.title } : t
      ),
    })),

  reorderTab: (fromIndex, toIndex) =>
    set((state) => {
      const newTabs = [...state.tabs];
      const [moved] = newTabs.splice(fromIndex, 1);
      newTabs.splice(toIndex, 0, moved);
      return { tabs: newTabs };
    }),

  undoCloseTab: () => {
    const state = get();
    const now = Date.now();
    // Find the most recently closed tab within the undo window
    const entry = state.closedTabs.find(
      (c) => now - c.closedAt < UNDO_CLOSE_TIMEOUT
    );
    if (!entry) return;

    set({
      tabs: [...state.tabs, entry.tab],
      activeTabId: entry.tab.id,
      closedTabs: state.closedTabs.filter((c) => c !== entry),
    });
  },

  splitPane: (direction) => {
    const state = get();
    const tab = state.tabs.find((t) => t.id === state.activeTabId);
    if (!tab) return;

    const newSessionId = generateSessionId();
    const newTree = findAndReplace(
      tab.paneTree,
      tab.activePaneSessionId,
      (leaf) => ({
        type: "split" as const,
        direction,
        children: [
          leaf,
          { type: "leaf" as const, sessionId: newSessionId },
        ] as [PaneNode, PaneNode],
      })
    );

    set((state) => ({
      tabs: state.tabs.map((t) =>
        t.id === tab.id
          ? {
              ...t,
              paneTree: newTree,
              activePaneSessionId: newSessionId,
              maximizedPaneSessionId: null, // Exit maximize on split
            }
          : t
      ),
    }));
  },

  removePaneSession: (sessionId) => {
    const state = get();
    const tab = state.tabs.find((t) => t.id === state.activeTabId);
    if (!tab) return;

    const allIds = collectSessionIds(tab.paneTree);
    if (allIds.length <= 1) {
      get().removeTab(tab.id);
      return;
    }

    const newTree = removeLeaf(tab.paneTree, sessionId);
    if (!newTree) return;

    const remainingIds = collectSessionIds(newTree);
    const newActive = remainingIds.includes(tab.activePaneSessionId)
      ? tab.activePaneSessionId
      : remainingIds[0];

    set((state) => ({
      tabs: state.tabs.map((t) =>
        t.id === tab.id
          ? {
              ...t,
              paneTree: newTree,
              activePaneSessionId: newActive,
              maximizedPaneSessionId: null,
            }
          : t
      ),
    }));
  },

  setActivePaneSession: (sessionId) => {
    const state = get();
    set({
      tabs: state.tabs.map((t) =>
        t.id === state.activeTabId
          ? { ...t, activePaneSessionId: sessionId }
          : t
      ),
    });
  },

  navigatePane: (direction) => {
    const state = get();
    const tab = state.tabs.find((t) => t.id === state.activeTabId);
    if (!tab) return;

    const allIds = collectSessionIds(tab.paneTree);
    if (allIds.length < 2) return;

    const curIdx = allIds.indexOf(tab.activePaneSessionId);
    const nextIdx =
      direction === "next"
        ? (curIdx + 1) % allIds.length
        : (curIdx - 1 + allIds.length) % allIds.length;

    const nextId = allIds[nextIdx];
    set({
      tabs: state.tabs.map((t) =>
        t.id === tab.id ? { ...t, activePaneSessionId: nextId } : t
      ),
    });

    // Focus the target terminal
    getTerminalInstance(nextId)?.focus();
  },

  toggleMaximizePane: () => {
    const state = get();
    const tab = state.tabs.find((t) => t.id === state.activeTabId);
    if (!tab) return;

    const allIds = collectSessionIds(tab.paneTree);
    if (allIds.length < 2) return; // No point maximizing single pane

    const isMaximized = tab.maximizedPaneSessionId !== null;
    set({
      tabs: state.tabs.map((t) =>
        t.id === tab.id
          ? {
              ...t,
              maximizedPaneSessionId: isMaximized
                ? null
                : tab.activePaneSessionId,
            }
          : t
      ),
    });
  },

  increaseFontSize: () =>
    set((state) => ({ fontSize: Math.min(state.fontSize + 1, 28) })),
  decreaseFontSize: () =>
    set((state) => ({ fontSize: Math.max(state.fontSize - 1, 8) })),
  resetFontSize: () => set({ fontSize: 13 }),

  toggleSearch: () => set((state) => ({ searchVisible: !state.searchVisible })),
  setSearchVisible: (visible) => set({ searchVisible: visible }),

  setTheme: (name) => set({ themeName: name }),
}));
