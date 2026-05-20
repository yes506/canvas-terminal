import { useRef, useCallback, useEffect, useState } from "react";
import { DrawingBoard } from "./components/canvas/DrawingBoard";
import { Toolbar } from "./components/canvas/Toolbar";
import { TerminalTabs } from "./components/terminal/TerminalTabs";
import { UpdateBanner } from "./components/UpdateBanner";
import { BrowserDrawer } from "./components/browser/BrowserDrawer";
import { useCanvasIntegration } from "./components/canvas/CanvasIntegration";
import { useKeyboardShortcuts } from "./hooks/useKeyboardShortcuts";
import { useCanvasStore } from "./stores/canvasStore";
import { useBrowserStore } from "./stores/browserStore";
import { clampDrawerWidth } from "./lib/drawerLayout";
import { checkForUpdates } from "./lib/updater";
import { getVersion } from "@tauri-apps/api/app";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";

export default function App() {
  const { exportToTerminal, importIntoCanvas, isWaitingForImport } = useCanvasIntegration();
  const drawerOpen = useCanvasStore((s) => s.drawerOpen);
  const browserDrawerOpen = useBrowserStore((s) => s.drawerOpen);
  const browserDrawerWidth = useBrowserStore((s) => s.drawerWidth);
  useKeyboardShortcuts();

  const [containerWidth, setContainerWidth] = useState(0);
  const [canvasWidth, setCanvasWidth] = useState(0);

  useEffect(() => {
    getVersion().then((version) => {
      getCurrentWindow().setTitle(`Canvas Terminal v${version}`);
    });
  }, []);

  // Auto-check for updates ~3s after mount so we don't compete with terminal
  // boot. The settings layer (auto_check_updates flag) gates this internally.
  useEffect(() => {
    const handle = window.setTimeout(() => {
      checkForUpdates({ manual: false });
    }, 3000);
    return () => window.clearTimeout(handle);
  }, []);

  // App menu "Check for Updates…" → manual update check
  useEffect(() => {
    const unlistenPromise = listen("menu-check-for-updates", () => {
      checkForUpdates({ manual: true });
    });
    return () => {
      unlistenPromise.then((unlisten) => unlisten());
    };
  }, []);

  // App menu "Open Dashboard" → lazy-start the localhost server and open
  // the token URL in the default browser. The token URL never crosses
  // the IPC boundary (see commands::dashboard::open_dashboard rationale).
  useEffect(() => {
    const unlistenPromise = listen("menu-open-dashboard", () => {
      invoke("open_dashboard").catch((err) => {
        console.error("[dashboard] open_dashboard failed:", err);
      });
    });
    return () => {
      unlistenPromise.then((unlisten) => unlisten());
    };
  }, []);

  const containerRef = useRef<HTMLDivElement>(null);
  const canvasPanelRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    dragging.current = true;

    const onMouseMove = (ev: MouseEvent) => {
      if (!dragging.current || !containerRef.current || !canvasPanelRef.current) return;
      const cw = containerRef.current.getBoundingClientRect().width;
      const browserW = browserDrawerOpen ? browserDrawerWidth : 0;
      // Shared two-drawer clamp (Phase-1 in-scope #10): reserve space for
      // the right-side browser drawer + 48px terminal minimum.
      const newWidth = clampDrawerWidth({
        proposedWidth: ev.clientX,
        containerWidth: cw,
        siblingDrawerWidth: browserW,
      });
      canvasPanelRef.current.style.width = `${newWidth}px`;
      setCanvasWidth(newWidth);
    };

    const onMouseUp = () => {
      dragging.current = false;
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
    };

    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
  }, [browserDrawerOpen, browserDrawerWidth]);

  // Track container width + canvas panel width so the browser drawer's
  // clamp math has accurate sibling-width info.
  useEffect(() => {
    const updateMeasurements = () => {
      if (containerRef.current) {
        setContainerWidth(containerRef.current.getBoundingClientRect().width);
      }
      if (canvasPanelRef.current && drawerOpen) {
        setCanvasWidth(canvasPanelRef.current.getBoundingClientRect().width);
      } else if (!drawerOpen) {
        setCanvasWidth(0);
      }
    };
    updateMeasurements();
    window.addEventListener("resize", updateMeasurements);
    return () => window.removeEventListener("resize", updateMeasurements);
  }, [drawerOpen]);

  return (
    <div className="flex flex-col h-screen w-screen overflow-hidden" style={{ background: "transparent" }}>
      <UpdateBanner />
      <div ref={containerRef} className="flex flex-1 min-h-0 overflow-hidden" style={{ background: "transparent" }}>
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

      {/* Terminal — always mounted, never re-created.
       *  overflow-hidden mirrors the canvas pane (above in this file)
       *  and the browser drawer (BrowserDrawer.tsx) — keeps terminal-tab
       *  content from painting into adjacent panel columns at width
       *  limits, when clampDrawerWidth's degraded-mode collapses the
       *  panel below the tab bar's intrinsic min-content size. Do not
       *  remove. */}
      <div className="flex-1 h-full min-w-0 bg-surface overflow-hidden">
        <TerminalTabs />
      </div>

      {/* Right-side browser drawer + its drag handle */}
      <BrowserDrawer
        canvasDrawerWidth={drawerOpen ? canvasWidth : 0}
        containerWidth={containerWidth}
      />
      </div>
    </div>
  );
}
