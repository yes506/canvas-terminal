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
import { clampDrawerWidth, resolveDrawerWidths } from "./lib/drawerLayout";
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
  // `canvasIntent` is the user's last-dragged canvas width in pixels, or
  // `null` if the user hasn't dragged the canvas drawer yet. Under the
  // null sentinel the canvas pane renders at CSS `width: 35%` (responsive
  // to the container before any drag); after first drag the intent is a
  // px value and the render path runs it through `resolveDrawerWidths`.
  // This separation keeps the user's intent stable across window resize:
  // shrinking the window narrows the rendered (effective) width via the
  // helper, but doesn't overwrite intent — expanding the window restores
  // the drawer toward the user's original drag value automatically.
  const [canvasIntent, setCanvasIntent] = useState<number | null>(null);

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
      if (!dragging.current || !containerRef.current) return;
      const cw = containerRef.current.getBoundingClientRect().width;
      const browserW = browserDrawerOpen ? browserDrawerWidth : 0;
      // Drag-time clamp mirrors resolveDrawerWidths's render-time handle
      // budget: 4 px for canvas's own handle (always present while dragging)
      // plus 4 px for the browser handle when that drawer is open. Without
      // this the drag would stop 8 px past where the panel actually renders,
      // leaving an 8 px cursor↔handle lag at max drag (caught by @claude3
      // H2 in peer review). Drag handler updates INTENT (React state); the
      // render path runs the same intent through resolveDrawerWidths.
      // Contrast with BrowserDrawer's drag handler, which uses a self-aware
      // sanitizer [280, containerWidth] because browser intent is persisted
      // by useBrowserTabsSettings's debounced settings writer — canvas
      // intent lives only in React state, so it doesn't need the same
      // persistence guard.
      const handleBudget = 4 + (browserDrawerOpen ? 4 : 0);
      const newWidth = clampDrawerWidth({
        proposedWidth: ev.clientX,
        containerWidth: cw,
        siblingDrawerWidth: browserW,
        terminalMinWidth: 48 + handleBudget,
      });
      setCanvasIntent(newWidth);
    };

    const onMouseUp = () => {
      dragging.current = false;
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
    };

    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
  }, [browserDrawerOpen, browserDrawerWidth]);

  // Track container width so `resolveDrawerWidths` recomputes both
  // effective drawer widths at render time as the window resizes. The
  // handler is measurement-only — it does NOT write back to any drawer
  // intent. That's the load-bearing property: intent stays stable across
  // resize (no lossy persistence, no drag-vs-resize race), and the
  // render path produces the right effective widths from current
  // container + stored intents.
  useEffect(() => {
    const updateMeasurements = () => {
      if (containerRef.current) {
        setContainerWidth(containerRef.current.getBoundingClientRect().width);
      }
    };
    updateMeasurements();
    window.addEventListener("resize", updateMeasurements);
    return () => window.removeEventListener("resize", updateMeasurements);
  }, []);

  // Materialize the canvas null sentinel into a concrete pixel value for
  // the helper. Pre-first-drag, intent is null; we substitute a sensible
  // default (max of selfMin and ~35% of container) so the helper has a
  // numeric sibling value when clamping the browser drawer. The CANVAS
  // RENDER below still uses CSS "35%" until first drag — the materialized
  // value only feeds the helper math.
  const materializedCanvasIntent =
    canvasIntent ?? Math.max(280, containerWidth * 0.35);
  const { canvasEffective, browserEffective } = resolveDrawerWidths({
    canvasIntent: materializedCanvasIntent,
    browserIntent: browserDrawerWidth,
    containerWidth,
    canvasOpen: drawerOpen,
    browserOpen: browserDrawerOpen,
  });

  return (
    <div className="flex flex-col h-screen w-screen overflow-hidden" style={{ background: "transparent" }}>
      <UpdateBanner />
      <div ref={containerRef} className="flex flex-1 min-h-0 overflow-hidden" style={{ background: "transparent" }}>
      {/* Canvas panel — always mounted, width controlled by React state.
       *  Pre-first-drag: intent is null → render at CSS "35%" so the
       *  panel scales responsively with the window. After first drag:
       *  intent is a px value → render at canvasEffective from
       *  resolveDrawerWidths, which re-clamps against the current
       *  container + browser intent on every render (auto-restores
       *  toward intent when the window grows back). */}
      <div
        ref={canvasPanelRef}
        className="flex flex-shrink-0 h-full overflow-hidden"
        style={{
          background: "transparent",
          width: !drawerOpen
            ? 0
            : canvasIntent === null
              ? "35%"
              : `${canvasEffective}px`,
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
        browserEffectiveWidth={browserEffective}
        containerWidth={containerWidth}
      />
      </div>
    </div>
  );
}
