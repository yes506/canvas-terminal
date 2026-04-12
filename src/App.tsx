import { useRef, useCallback } from "react";
import { DrawingBoard } from "./components/canvas/DrawingBoard";
import { Toolbar } from "./components/canvas/Toolbar";
import { TerminalTabs } from "./components/terminal/TerminalTabs";
import { useCanvasIntegration } from "./components/canvas/CanvasIntegration";
import { useKeyboardShortcuts } from "./hooks/useKeyboardShortcuts";
import { useCanvasStore } from "./stores/canvasStore";

export default function App() {
  const { exportToTerminal, importIntoCanvas, isWaitingForImport } = useCanvasIntegration();
  const drawerOpen = useCanvasStore((s) => s.drawerOpen);
  useKeyboardShortcuts();

  const containerRef = useRef<HTMLDivElement>(null);
  const canvasPanelRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    dragging.current = true;

    const onMouseMove = (ev: MouseEvent) => {
      if (!dragging.current || !containerRef.current || !canvasPanelRef.current) return;
      const containerWidth = containerRef.current.getBoundingClientRect().width;
      const newWidth = Math.max(280, Math.min(ev.clientX, containerWidth * 0.6));
      canvasPanelRef.current.style.width = `${newWidth}px`;
    };

    const onMouseUp = () => {
      dragging.current = false;
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
    };

    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
  }, []);

  return (
    <div ref={containerRef} className="flex h-screen w-screen bg-surface overflow-hidden">
      {/* Canvas panel — always mounted, width controlled by CSS */}
      <div
        ref={canvasPanelRef}
        className="flex flex-shrink-0 h-full overflow-hidden"
        style={{ width: drawerOpen ? "35%" : 0, minWidth: drawerOpen ? 280 : 0 }}
      >
        <Toolbar onExportToTerminal={exportToTerminal} onImportIntoCanvas={importIntoCanvas} isWaitingForImport={isWaitingForImport} />
        <div className="flex-1 h-full min-w-0 border-r border-surface-lighter">
          <DrawingBoard />
        </div>
      </div>

      {/* Drag handle — only visible when canvas is open */}
      {drawerOpen && (
        <div
          className="w-1 flex-shrink-0 bg-surface-lighter hover:bg-accent cursor-col-resize transition-colors"
          onMouseDown={handleMouseDown}
        />
      )}

      {/* Terminal — always mounted, never re-created */}
      <div className="flex-1 h-full min-w-0">
        <TerminalTabs />
      </div>
    </div>
  );
}
