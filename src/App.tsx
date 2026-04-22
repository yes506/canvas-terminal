import { useRef, useCallback, useEffect } from "react";
import { DrawingBoard } from "./components/canvas/DrawingBoard";
import { Toolbar } from "./components/canvas/Toolbar";
import { TerminalTabs } from "./components/terminal/TerminalTabs";
import { useCanvasIntegration } from "./components/canvas/CanvasIntegration";
import { useKeyboardShortcuts } from "./hooks/useKeyboardShortcuts";
import { useCanvasStore } from "./stores/canvasStore";
import { getVersion } from "@tauri-apps/api/app";
import { getCurrentWindow } from "@tauri-apps/api/window";

export default function App() {
  const { exportToTerminal, importIntoCanvas, isWaitingForImport } = useCanvasIntegration();
  const drawerOpen = useCanvasStore((s) => s.drawerOpen);
  useKeyboardShortcuts();

  useEffect(() => {
    getVersion().then((version) => {
      getCurrentWindow().setTitle(`Canvas Terminal v${version}`);
    });
  }, []);

  const containerRef = useRef<HTMLDivElement>(null);
  const canvasPanelRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    dragging.current = true;

    const onMouseMove = (ev: MouseEvent) => {
      if (!dragging.current || !containerRef.current || !canvasPanelRef.current) return;
      const containerWidth = containerRef.current.getBoundingClientRect().width;
      // Allow canvas to expand up to full width (minus 48px minimum for terminal visibility)
      const newWidth = Math.max(280, Math.min(ev.clientX, containerWidth - 48));
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
    <div ref={containerRef} className="flex h-screen w-screen overflow-hidden" style={{ background: "transparent" }}>
      {/* Canvas panel — always mounted, width controlled by CSS */}
      <div
        ref={canvasPanelRef}
        className="flex flex-shrink-0 h-full overflow-hidden"
        style={{
          background: "transparent",
          width: drawerOpen ? "35%" : 0,
          minWidth: drawerOpen ? 280 : 0,
        }}
      >
        <Toolbar onExportToTerminal={exportToTerminal} onImportIntoCanvas={importIntoCanvas} isWaitingForImport={isWaitingForImport} />
        <div
          className="flex-1 h-full min-w-0 border-r border-surface-lighter"
          style={{ background: "#2f2f2f" }}
        >
          <div className="h-full w-full">
            <DrawingBoard />
          </div>
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
      <div className="flex-1 h-full min-w-0 bg-surface">
        <TerminalTabs />
      </div>
    </div>
  );
}
