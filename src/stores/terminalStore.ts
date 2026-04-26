import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import type { Terminal } from "@xterm/xterm";
import type { SearchAddon } from "@xterm/addon-search";
import type { Tab, PaneNode, PaneLeaf, ClosedTab } from "../types/terminal";
import { generateSessionId } from "../lib/sessionId";
import { destroySession as destroyManagedSession } from "../lib/terminalManager";

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

function findLeafBySessionId(node: PaneNode, sessionId: string): PaneLeaf | null {
  if (node.type === "leaf") return node.sessionId === sessionId ? node : null;
  return findLeafBySessionId(node.children[0], sessionId) || findLeafBySessionId(node.children[1], sessionId);
}

function collectSessionIds(node: PaneNode): string[] {
  if (node.type === "leaf") return [node.sessionId];
  return [
    ...collectSessionIds(node.children[0]),
    ...collectSessionIds(node.children[1]),
  ];
}

/** Find a collaborator leaf anywhere in the pane tree. */
export function findCollaboratorLeaf(node: PaneNode): PaneLeaf | null {
  if (node.type === "leaf") return node.kind === "collaborator" ? node : null;
  return (
    findCollaboratorLeaf(node.children[0]) ||
    findCollaboratorLeaf(node.children[1])
  );
}

/**
 * Whether the collaborator pane for `collabSessionId` is *actually visible*
 * in `tab` — i.e. present in the tree AND not hidden by a maximize on a
 * different pane. PaneTree only renders the maximized leaf when one is set,
 * so a tree-membership check alone misclassifies a pane as visible while a
 * sibling pane is maximized. Used to gate unread-badge suppression/clearing
 * so collab task completions can't slip past while their pane is hidden.
 */
export function isCollabPaneVisibleInTab(tab: Tab | undefined, collabSessionId: string): boolean {
  if (!tab) return false;
  const collab = findCollaboratorLeaf(tab.paneTree);
  if (!collab || collab.sessionId !== collabSessionId) return false;
  if (tab.maximizedPaneSessionId !== null) {
    return tab.maximizedPaneSessionId === collabSessionId;
  }
  return true;
}

const UNDO_CLOSE_TIMEOUT = 5000;

interface TerminalState {
  tabs: Tab[];
  activeTabId: string | null;
  fontSize: number;
  searchVisible: boolean;
  themeName: string;
  closedTabs: ClosedTab[];

  // Per-collab-session unread completion counter (PR-B Phase 2.2)
  // Keyed by collabSessionId so badges can survive future "clear-on-pane-focus" tightening
  // without redesign. Render via findCollaboratorLeaf — see TerminalTabs.
  unreadByCollabSession: Record<string, number>;

  // Tab management
  addTab: (cwd?: string) => void;
  openCollaboratorSplit: () => void;
  duplicateTab: (tabId: string) => void;
  removeTab: (id: string) => void;
  setActiveTab: (id: string) => void;
  renameTab: (id: string, title: string) => void;
  reorderTab: (fromIndex: number, toIndex: number) => void;
  undoCloseTab: () => void;
  incrementUnread: (collabSessionId: string) => void;
  clearUnread: (collabSessionId: string) => void;

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
  fontSize: 12,
  searchVisible: false,
  themeName: "monochrome",
  closedTabs: [],
  unreadByCollabSession: {},

  incrementUnread: (collabSessionId) => {
    // Suppress badge increment only if the collaborator pane is *actually
    // visible* — i.e. present in the active tab's tree AND not hidden by a
    // maximize on another pane. Tree-membership alone is not enough: the
    // user may have maximized a terminal pane, hiding the collab pane while
    // it's still in the tree. Without this guard, completions would fire
    // no toast (removed), no in-frame light (hidden pane), and no badge
    // (suppressed) — silently lost.
    const s = get();
    const activeTab = s.tabs.find((t) => t.id === s.activeTabId);
    if (isCollabPaneVisibleInTab(activeTab, collabSessionId)) {
      return;
    }
    set((s) => ({
      unreadByCollabSession: {
        ...s.unreadByCollabSession,
        [collabSessionId]: (s.unreadByCollabSession[collabSessionId] ?? 0) + 1,
      },
    }));
  },

  clearUnread: (collabSessionId) => {
    set((s) => {
      if (!(collabSessionId in s.unreadByCollabSession)) return s;
      const { [collabSessionId]: _, ...rest } = s.unreadByCollabSession;
      return { unreadByCollabSession: rest };
    });
  },

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
      paneTree: { type: "leaf", kind: "terminal", sessionId },
      activePaneSessionId: sessionId,
      maximizedPaneSessionId: null,
    };
    set((state) => ({
      tabs: [...state.tabs, tab],
      activeTabId: tabId,
    }));
  },

  openCollaboratorSplit: () => {
    const state = get();
    const freshTab = state.tabs.find((t) => t.id === state.activeTabId);
    if (!freshTab) return;

    // Toggle: if a collaborator pane already exists in this tab, remove it
    const existing = findCollaboratorLeaf(freshTab.paneTree);
    if (existing) {
      // If the collaborator is the only pane, do nothing
      const allIds = collectSessionIds(freshTab.paneTree);
      if (allIds.length <= 1) return;

      const newTree = removeLeaf(freshTab.paneTree, existing.sessionId);
      if (!newTree) return;

      const remainingIds = collectSessionIds(newTree);
      const newActive = remainingIds.includes(freshTab.activePaneSessionId)
        ? freshTab.activePaneSessionId
        : remainingIds[0];

      set((s) => ({
        tabs: s.tabs.map((t) =>
          t.id === freshTab.id
            ? {
                ...t,
                paneTree: newTree,
                activePaneSessionId: newActive,
                maximizedPaneSessionId: null,
              }
            : t,
        ),
      }));
      return;
    }

    // Don't split if active pane is a collaborator (shouldn't happen, but guard)
    const activeLeaf = findLeafBySessionId(freshTab.paneTree, freshTab.activePaneSessionId);
    if (activeLeaf?.kind === "collaborator") return;

    const collabSessionId = generateSessionId();
    const newTree = findAndReplace(
      freshTab.paneTree,
      freshTab.activePaneSessionId,
      (leaf) => ({
        type: "split" as const,
        direction: "horizontal" as const,
        children: [
          leaf,
          { type: "leaf" as const, kind: "collaborator" as const, sessionId: collabSessionId },
        ] as [PaneNode, PaneNode],
      }),
    );

    // Keep focus on the terminal pane (not the collaborator)
    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.id === freshTab.id
          ? {
              ...t,
              paneTree: newTree,
              maximizedPaneSessionId: null,
            }
          : t,
      ),
    }));
  },

  duplicateTab: (tabId: string) => {
    const state = get();
    const tab = state.tabs.find((t) => t.id === tabId);
    if (!tab) return;

    // Don't duplicate collaborator tabs (it's a singleton)
    if (tab.paneTree.type === "leaf" && tab.paneTree.kind === "collaborator") return;

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

    // Destroy managed terminal sessions for all terminal panes in this tab
    const allLeaves = collectSessionIds(tabToClose.paneTree);
    for (const sid of allLeaves) {
      const leaf = findLeafBySessionId(tabToClose.paneTree, sid);
      if (leaf?.kind === "terminal") {
        destroyManagedSession(sid);
      }
    }

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

  setActiveTab: (id) => {
    set({ activeTabId: id });
    // Clear unread only when the collaborator pane is *actually visible* in
    // the activated tab. If a different pane is maximized, the collab pane
    // is still hidden, so the badge must persist until the user un-maximizes
    // (handled in toggleMaximizePane).
    const tab = get().tabs.find((t) => t.id === id);
    if (tab) {
      const collab = findCollaboratorLeaf(tab.paneTree);
      if (collab && isCollabPaneVisibleInTab(tab, collab.sessionId)) {
        get().clearUnread(collab.sessionId);
      }
    }
  },

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

    // Don't split collaborator panes
    const activeLeaf = findLeafBySessionId(tab.paneTree, tab.activePaneSessionId);
    if (activeLeaf?.kind === "collaborator") return;

    const newSessionId = generateSessionId();
    const newTree = findAndReplace(
      tab.paneTree,
      tab.activePaneSessionId,
      (leaf) => ({
        type: "split" as const,
        direction,
        children: [
          leaf,
          { type: "leaf" as const, kind: "terminal" as const, sessionId: newSessionId },
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

    // Destroy managed terminal session if this is a terminal pane
    const leaf = findLeafBySessionId(tab.paneTree, sessionId);
    if (leaf?.kind === "terminal") {
      destroyManagedSession(sessionId);
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
    // Un-maximizing may reveal a previously hidden collab pane. If so,
    // clear its unread badge — completions accumulated while hidden have
    // now become visible (in-frame indicator) again.
    if (isMaximized) {
      const collab = findCollaboratorLeaf(tab.paneTree);
      if (collab) {
        const updatedTab = get().tabs.find((t) => t.id === tab.id);
        if (updatedTab && isCollabPaneVisibleInTab(updatedTab, collab.sessionId)) {
          get().clearUnread(collab.sessionId);
        }
      }
    }
  },

  increaseFontSize: () =>
    set((state) => ({ fontSize: Math.min(state.fontSize + 1, 28) })),
  decreaseFontSize: () =>
    set((state) => ({ fontSize: Math.max(state.fontSize - 1, 8) })),
  resetFontSize: () => set({ fontSize: 12 }),

  toggleSearch: () => set((state) => ({ searchVisible: !state.searchVisible })),
  setSearchVisible: (visible) => set({ searchVisible: visible }),

  setTheme: (name) => set({ themeName: name }),
}));
