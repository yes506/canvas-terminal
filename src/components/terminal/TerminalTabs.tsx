import { useEffect, useRef, useState, useCallback } from "react";
import { useTerminalStore } from "../../stores/terminalStore";
import { useCanvasStore } from "../../stores/canvasStore";
import { PaneTree } from "./PaneTree";
import { TerminalSearch } from "./TerminalSearch";
import { ThemeSelector } from "../settings/ThemeSelector";
import { Plus, X, PanelLeftOpen, PanelLeftClose, Copy, Pencil } from "lucide-react";
import { getCurrentWindow } from "@tauri-apps/api/window";

interface ContextMenu {
  x: number;
  y: number;
  tabId: string;
}

interface DragState {
  tabIndex: number;
  startX: number;
  offsetX: number;       // cursor offset from tab left edge
  currentX: number;
  insertIndex: number;   // where the tab would land if dropped now
}

export function TerminalTabs() {
  const { tabs, activeTabId, addTab, removeTab, setActiveTab, renameTab, reorderTab, duplicateTab } =
    useTerminalStore();
  const initialized = useRef(false);
  const [editingTabId, setEditingTabId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const editInputRef = useRef<HTMLInputElement>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenu | null>(null);
  const prevMouseDownRef = useRef(0);
  const lastMouseDownRef = useRef(0);
  const contextMenuRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const didDragRef = useRef(false);
  const tabRefsRef = useRef<(HTMLDivElement | null)[]>([]);
  const tabBarRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!initialized.current && tabs.length === 0) {
      initialized.current = true;
      addTab();
    }
  }, [tabs.length, addTab]);

  useEffect(() => {
    if (editingTabId && editInputRef.current) {
      editInputRef.current.focus();
      editInputRef.current.select();
    }
  }, [editingTabId]);

  const escapePressedRef = useRef(false);

  const commitRename = useCallback(() => {
    if (escapePressedRef.current) {
      escapePressedRef.current = false;
      return;
    }
    if (editingTabId) {
      renameTab(editingTabId, editValue);
      setEditingTabId(null);
    }
  }, [editingTabId, editValue, renameTab]);

  // Dismiss context menu on click outside
  useEffect(() => {
    if (!contextMenu) return;
    const dismiss = (e: MouseEvent) => {
      // Don't dismiss if the click is inside the context menu itself
      if (contextMenuRef.current?.contains(e.target as Node)) return;
      setContextMenu(null);
    };
    // Use mousedown so it doesn't race with button onClick
    window.addEventListener("mousedown", dismiss);
    return () => window.removeEventListener("mousedown", dismiss);
  }, [contextMenu]);

  const handleContextMenu = (e: React.MouseEvent, tabId: string) => {
    e.preventDefault();
    // Clamp position to keep menu within viewport
    const menuW = 160;
    const menuH = 72;
    const x = Math.min(e.clientX, window.innerWidth - menuW);
    const y = Math.min(e.clientY, window.innerHeight - menuH);
    setContextMenu({ x, y, tabId });
  };

  const handleDoubleClick = (tabId: string, currentTitle: string) => {
    setEditingTabId(tabId);
    setEditValue(currentTitle);
  };

  const handleClose = (e: React.MouseEvent, tabId: string) => {
    e.stopPropagation();
    if (tabs.length === 1) {
      try { getCurrentWindow().close().catch(() => {}); } catch { /* no Tauri */ }
      return;
    }
    removeTab(tabId);
  };

  // Compute insert index from current drag X position
  const computeInsertIndex = useCallback(
    (clientX: number, _dragIndex: number): number => {
      const refs = tabRefsRef.current;
      for (let i = 0; i < refs.length; i++) {
        const el = refs[i];
        if (!el) continue;
        const rect = el.getBoundingClientRect();
        const midX = rect.left + rect.width / 2;
        if (clientX < midX) {
          return i;
        }
      }
      return refs.length;
    },
    [],
  );

  const handlePointerDown = useCallback(
    (e: React.PointerEvent, index: number) => {
      // Only primary button
      if (e.button !== 0) return;
      // Don't drag while editing
      if (editingTabId === tabs[index]?.id) return;
      // Don't capture pointer when clicking the close button
      if ((e.target as HTMLElement).closest("button")) return;

      const tabEl = tabRefsRef.current[index];
      if (!tabEl) return;
      const rect = tabEl.getBoundingClientRect();

      // Capture pointer for smooth tracking even outside the element
      tabEl.setPointerCapture(e.pointerId);

      const startX = e.clientX;
      const offsetX = e.clientX - rect.left;

      // We don't start drag immediately — wait for a 4px threshold in onPointerMove.
      // Store pending state in refs so we avoid re-renders until drag is confirmed.
      pendingDragRef.current = { index, startX, offsetX, pointerId: e.pointerId };
    },
    [editingTabId, tabs],
  );

  const pendingDragRef = useRef<{
    index: number;
    startX: number;
    offsetX: number;
    pointerId: number;
  } | null>(null);

  const handlePointerMove = useCallback(
    (e: React.PointerEvent) => {
      // Check if we need to promote pending drag to active drag
      const pending = pendingDragRef.current;
      if (pending && !drag) {
        const dx = Math.abs(e.clientX - pending.startX);
        if (dx < 4) return; // Below threshold
        // Prevent double-click rename triggering a drag
        if (lastMouseDownRef.current - prevMouseDownRef.current < 500) {
          pendingDragRef.current = null;
          return;
        }
        // Start drag
        setDrag({
          tabIndex: pending.index,
          startX: pending.startX,
          offsetX: pending.offsetX,
          currentX: e.clientX,
          insertIndex: pending.index,
        });
        pendingDragRef.current = null;
        return;
      }

      if (!drag) return;

      const insertIndex = computeInsertIndex(e.clientX, drag.tabIndex);
      setDrag((prev) =>
        prev ? { ...prev, currentX: e.clientX, insertIndex } : null,
      );
    },
    [drag, computeInsertIndex],
  );

  const handlePointerUp = useCallback(
    (_e: React.PointerEvent) => {
      pendingDragRef.current = null;
      if (!drag) return;

      let toIndex = drag.insertIndex;
      // Adjust because removing from original position shifts indices
      if (toIndex > drag.tabIndex) toIndex -= 1;
      if (toIndex !== drag.tabIndex) {
        reorderTab(drag.tabIndex, toIndex);
      }
      // Flag so the subsequent onClick (which fires after pointerUp) is suppressed.
      // setDrag(null) makes `drag` null before onClick runs, defeating the !drag guard.
      didDragRef.current = true;
      setDrag(null);
    },
    [drag, reorderTab],
  );

  if (tabs.length === 0) {
    return null;
  }

  return (
    <div className="flex flex-col h-full">
      {/* Tab bar */}
      <div
        ref={tabBarRef}
        className="flex items-center bg-surface-light border-b border-surface-lighter h-8 flex-shrink-0 relative"
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
      >
        {/* Canvas drawer toggle */}
        <CanvasToggleButton />

        {tabs.map((tab, index) => {
          const isDragged = drag?.tabIndex === index;
          // Show insertion indicator before this tab
          const showInsertBefore = drag !== null && drag.insertIndex === index && drag.tabIndex !== index;
          const showInsertAfter = drag !== null && drag.insertIndex === tabs.length && index === tabs.length - 1 && drag.tabIndex !== index;

          return (
            <div
              key={tab.id}
              ref={(el) => { tabRefsRef.current[index] = el; }}
              className={`flex items-center gap-1 px-3 h-full text-xs cursor-pointer border-r border-surface-lighter select-none relative transition-opacity duration-150 ${
                tab.id === activeTabId
                  ? "bg-surface text-text"
                  : "text-text-muted hover:bg-surface"
              } ${isDragged ? "opacity-40" : ""}`}
              style={isDragged ? { cursor: "grabbing" } : undefined}
              onMouseDown={() => { prevMouseDownRef.current = lastMouseDownRef.current; lastMouseDownRef.current = Date.now(); }}
              onPointerDown={(e) => handlePointerDown(e, index)}
              onClick={(e) => {
                if (didDragRef.current) { didDragRef.current = false; return; }
                if (e.detail === 1 && !drag) setActiveTab(tab.id);
              }}
              onDoubleClick={() => handleDoubleClick(tab.id, tab.title)}
              onContextMenu={(e) => handleContextMenu(e, tab.id)}
            >
              {/* Insertion indicator — left side */}
              {showInsertBefore && (
                <div className="absolute left-0 top-1 bottom-1 w-0.5 bg-accent rounded-full -translate-x-[1px] z-10" />
              )}
              {editingTabId === tab.id ? (
                <input
                  ref={editInputRef}
                  className="bg-surface border border-accent outline-none text-xs text-text w-28 px-1 py-0.5 rounded-sm"
                  value={editValue}
                  onChange={(e) => setEditValue(e.target.value)}
                  onBlur={commitRename}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") commitRename();
                    if (e.key === "Escape") {
                      escapePressedRef.current = true;
                      setEditingTabId(null);
                    }
                  }}
                  onClick={(e) => e.stopPropagation()}
                  maxLength={30}
                />
              ) : (
                <span
                  className="truncate max-w-[120px]"
                  title="Double-click to rename"
                >
                  {tab.title}
                </span>
              )}
              <button
                className="ml-1 hover:text-red-400"
                onClick={(e) => handleClose(e, tab.id)}
              >
                <X size={12} />
              </button>
              {/* Insertion indicator — right side (last tab only) */}
              {showInsertAfter && (
                <div className="absolute right-0 top-1 bottom-1 w-0.5 bg-accent rounded-full translate-x-[1px] z-10" />
              )}
            </div>
          );
        })}
        <button
          className="px-2 h-full text-text-muted hover:text-text hover:bg-surface"
          onClick={() => addTab()}
          title="New Tab (Cmd+T)"
        >
          <Plus size={14} />
        </button>

        <div className="flex-1" />

        <ThemeSelector />

        {/* Floating drag preview */}
        {drag && tabRefsRef.current[drag.tabIndex] && (() => {
          const tabEl = tabRefsRef.current[drag.tabIndex]!;
          const barRect = tabBarRef.current?.getBoundingClientRect();
          if (!barRect) return null;
          const tabWidth = tabEl.offsetWidth;
          const left = drag.currentX - drag.offsetX - barRect.left;
          return (
            <div
              className="absolute top-0 h-8 flex items-center gap-1 px-3 text-xs bg-surface border border-accent rounded shadow-lg z-20 pointer-events-none opacity-90"
              style={{ left, width: tabWidth }}
            >
              <span className="truncate max-w-[120px] text-text">
                {tabs[drag.tabIndex]?.title}
              </span>
            </div>
          );
        })()}
      </div>

      {/* Tab content */}
      <div className="flex-1 relative">
        {tabs.map((tab) => (
          <div
            key={tab.id}
            className="absolute inset-0"
            style={{
              display: tab.id === activeTabId ? "flex" : "none",
            }}
          >
            <PaneTree node={tab.paneTree} />
          </div>
        ))}

        <TerminalSearch />
      </div>

      {/* Context menu */}
      {contextMenu && (
        <div
          ref={contextMenuRef}
          className="fixed z-50 bg-surface-light border border-surface-lighter rounded-lg shadow-lg py-1 min-w-[160px]"
          style={{ left: contextMenu.x, top: contextMenu.y }}
        >
          <button
            className="flex items-center gap-2 w-full px-3 py-1.5 text-xs text-text hover:bg-surface-lighter transition-colors text-left"
            onClick={() => {
              const tab = tabs.find((t) => t.id === contextMenu.tabId);
              if (tab) handleDoubleClick(tab.id, tab.title);
              setContextMenu(null);
            }}
          >
            <Pencil size={12} />
            Rename Tab
          </button>
          <button
            className="flex items-center gap-2 w-full px-3 py-1.5 text-xs text-text hover:bg-surface-lighter transition-colors text-left"
            onClick={() => {
              duplicateTab(contextMenu.tabId);
              setContextMenu(null);
            }}
          >
            <Copy size={12} />
            Duplicate Tab
          </button>
        </div>
      )}
    </div>
  );
}

function CanvasToggleButton() {
  const { drawerOpen, toggleDrawer } = useCanvasStore();

  return (
    <button
      className="px-2 h-full text-text-muted hover:text-text hover:bg-surface border-r border-surface-lighter transition-colors"
      onClick={toggleDrawer}
      title={drawerOpen ? "Close Canvas" : "Open Canvas"}
    >
      {drawerOpen ? <PanelLeftClose size={14} /> : <PanelLeftOpen size={14} />}
    </button>
  );
}
