import { useEffect, useRef, useState } from "react";
import { useTerminalStore } from "../../stores/terminalStore";
import { useCanvasStore } from "../../stores/canvasStore";
import { PaneTree } from "./PaneTree";
import { TerminalSearch } from "./TerminalSearch";
import { ThemeSelector } from "../settings/ThemeSelector";
import { Plus, X, PanelLeftOpen, PanelLeftClose } from "lucide-react";

export function TerminalTabs() {
  const { tabs, activeTabId, addTab, removeTab, setActiveTab, reorderTab } =
    useTerminalStore();
  const initialized = useRef(false);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);

  useEffect(() => {
    if (!initialized.current && tabs.length === 0) {
      initialized.current = true;
      addTab();
    }
  }, [tabs.length, addTab]);

  if (tabs.length === 0) {
    return null;
  }

  const handleDragStart = (e: React.DragEvent, index: number) => {
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
            draggable
            onDragStart={(e) => handleDragStart(e, index)}
            onDragOver={(e) => handleDragOver(e, index)}
            onDrop={(e) => handleDrop(e, index)}
            onDragEnd={handleDragEnd}
            className={`flex items-center gap-1 px-3 h-full text-xs cursor-pointer border-r border-surface-lighter select-none ${
              tab.id === activeTabId
                ? "bg-surface text-text"
                : "text-text-muted hover:bg-surface"
            } ${dragOverIndex === index ? "border-l-2 border-l-accent" : ""}`}
            onClick={() => setActiveTab(tab.id)}
          >
            <span>{tab.title}</span>
            {tabs.length > 1 && (
              <button
                className="ml-1 hover:text-red-400"
                onClick={(e) => {
                  e.stopPropagation();
                  removeTab(tab.id);
                }}
              >
                <X size={12} />
              </button>
            )}
          </div>
        ))}
        <button
          className="px-2 h-full text-text-muted hover:text-text hover:bg-surface"
          onClick={addTab}
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
