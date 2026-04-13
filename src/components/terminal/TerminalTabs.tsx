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

export function TerminalTabs() {
  const { tabs, activeTabId, addTab, removeTab, setActiveTab, renameTab, reorderTab, duplicateTab } =
    useTerminalStore();
  const initialized = useRef(false);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);
  const [editingTabId, setEditingTabId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const editInputRef = useRef<HTMLInputElement>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenu | null>(null);
  const prevMouseDownRef = useRef(0);
  const lastMouseDownRef = useRef(0);
  const contextMenuRef = useRef<HTMLDivElement>(null);

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

  if (tabs.length === 0) {
    return null;
  }

  const handleDragStart = (e: React.DragEvent, index: number) => {
    // Prevent drag if two mousedowns occurred within 500ms (double-click pattern).
    // Compare previous vs current mousedown — NOT current mousedown vs dragstart,
    // which would block ALL drags since dragstart always follows its own mousedown closely.
    if (lastMouseDownRef.current - prevMouseDownRef.current < 500) {
      e.preventDefault();
      return;
    }
    e.dataTransfer.setData("text/plain", String(index));
    e.dataTransfer.effectAllowed = "move";
  };

  const handleDragOver = (e: React.DragEvent, index: number) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setDragOverIndex(index);
  };

  const handleDrop = (e: React.DragEvent, toIndex: number) => {
    e.preventDefault();
    const fromIndex = parseInt(e.dataTransfer.getData("text/plain"));
    if (!isNaN(fromIndex) && fromIndex !== toIndex) {
      reorderTab(fromIndex, toIndex);
    }
    setDragOverIndex(null);
  };

  const handleDragEnd = () => {
    setDragOverIndex(null);
  };

  return (
    <div className="flex flex-col h-full">
      {/* Tab bar */}
      <div className="flex items-center bg-surface-light border-b border-surface-lighter h-8 flex-shrink-0">
        {/* Canvas drawer toggle */}
        <CanvasToggleButton />

        {tabs.map((tab, index) => (
          <div
            key={tab.id}
            draggable={editingTabId !== tab.id}
            onDragStart={(e) => handleDragStart(e, index)}
            onDragOver={(e) => handleDragOver(e, index)}
            onDrop={(e) => handleDrop(e, index)}
            onDragEnd={handleDragEnd}
            className={`flex items-center gap-1 px-3 h-full text-xs cursor-pointer border-r border-surface-lighter select-none ${
              tab.id === activeTabId
                ? "bg-surface text-text"
                : "text-text-muted hover:bg-surface"
            } ${dragOverIndex === index ? "border-l-2 border-l-accent" : ""}`}
            onMouseDown={() => { prevMouseDownRef.current = lastMouseDownRef.current; lastMouseDownRef.current = Date.now(); }}
            onClick={(e) => { if (e.detail === 1) setActiveTab(tab.id); }}
            onDoubleClick={() => handleDoubleClick(tab.id, tab.title)}
            onContextMenu={(e) => handleContextMenu(e, tab.id)}
          >
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
          </div>
        ))}
        <button
          className="px-2 h-full text-text-muted hover:text-text hover:bg-surface"
          onClick={() => addTab()}
          title="New Tab (Cmd+T)"
        >
          <Plus size={14} />
        </button>

        <div className="flex-1" />

        <ThemeSelector />
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
