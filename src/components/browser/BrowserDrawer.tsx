import { useRef, useCallback, RefObject } from "react";
import { Globe, X } from "lucide-react";
import { useBrowserStore } from "../../stores/browserStore";
import { AddressBar } from "./AddressBar";
import { NavControls } from "./NavControls";
import { PageAreaHost } from "./PageAreaHost";
import { useBrowserBounds } from "./useBrowserBounds";
import { useBrowserLifecycle } from "./useBrowserLifecycle";
import { clampDrawerWidth } from "../../lib/drawerLayout";

interface BrowserDrawerProps {
  /** Width of the canvas drawer on the LEFT (0 when closed). Used by the
   *  clamp math so dragging this drawer reserves space for canvas + terminal. */
  canvasDrawerWidth: number;
  /** Total container width (App.tsx ref). */
  containerWidth: number;
}

export function BrowserDrawer({
  canvasDrawerWidth,
  containerWidth,
}: BrowserDrawerProps) {
  const drawerOpen = useBrowserStore((s) => s.drawerOpen);
  const drawerWidth = useBrowserStore((s) => s.drawerWidth);
  const setDrawerWidth = useBrowserStore((s) => s.setDrawerWidth);
  const toggle = useBrowserStore((s) => s.toggle);
  const pageTitle = useBrowserStore((s) => s.pageTitle);

  const hostRef = useRef<HTMLDivElement>(null) as RefObject<HTMLDivElement>;
  const draggingRef = useRef(false);

  // Subscribe rect changes + lifecycle.
  useBrowserBounds(hostRef, drawerOpen);
  useBrowserLifecycle(hostRef);

  // Drag handle on the LEFT edge of the right-side drawer.
  const handleDragStart = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      draggingRef.current = true;
      const onMouseMove = (ev: MouseEvent) => {
        if (!draggingRef.current) return;
        const proposed = containerWidth - ev.clientX;
        const clamped = clampDrawerWidth({
          proposedWidth: proposed,
          containerWidth,
          siblingDrawerWidth: canvasDrawerWidth,
        });
        setDrawerWidth(clamped);
      };
      const onMouseUp = () => {
        draggingRef.current = false;
        document.removeEventListener("mousemove", onMouseMove);
        document.removeEventListener("mouseup", onMouseUp);
      };
      document.addEventListener("mousemove", onMouseMove);
      document.addEventListener("mouseup", onMouseUp);
    },
    [canvasDrawerWidth, containerWidth, setDrawerWidth],
  );

  return (
    <>
      {drawerOpen && (
        <div
          className="w-1 flex-shrink-0 bg-surface-lighter hover:bg-accent cursor-col-resize transition-colors"
          onMouseDown={handleDragStart}
          aria-label="Resize browser drawer"
          role="separator"
        />
      )}
      <div
        className="flex flex-col flex-shrink-0 h-full bg-surface-light border-l border-surface-lighter overflow-hidden"
        style={{
          width: drawerOpen ? `${drawerWidth}px` : 0,
          minWidth: drawerOpen ? 280 : 0,
        }}
      >
        {drawerOpen && (
          <>
            {/* Row 1: title bar — Globe icon + page title + close button.
                Inline bg color (rather than Tailwind class) matches the
                canvas drawer's pattern and guarantees the row renders
                visibly above the OS-layer child webview regardless of
                Tailwind purge state. Taller rows + explicit minHeight
                so chrome can't collapse below visible height. */}
            <div
              className="flex items-center gap-2 px-3 border-b border-surface-lighter flex-shrink-0"
              style={{ background: "#2a2a2a", minHeight: 32 }}
            >
              <Globe size={13} className="text-text-muted flex-shrink-0" />
              <span
                className="flex-1 min-w-0 text-[11px] text-text truncate"
                title={pageTitle || "Browser"}
              >
                {pageTitle || "Browser"}
              </span>
              <button
                type="button"
                className="p-1 text-text-muted hover:text-red-400 hover:bg-surface-lighter rounded transition-colors flex-shrink-0"
                onClick={toggle}
                title="Close Browser (Cmd+Shift+B)"
                aria-label="Close browser drawer"
              >
                <X size={15} />
              </button>
            </div>
            {/* Row 2: nav controls + address bar. ALL inline styles
                (no Tailwind) — round-5-UX investigation showed that
                Row 2's contents weren't rendering even after the
                AddressBar input was converted to inline styles. The
                bright blue border is a TEMP DIAGNOSTIC to confirm the
                row is in the DOM at all; will be reverted in the
                next fix. */}
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "0 12px",
                background: "#1a1a1a",
                minHeight: 44,
                flexShrink: 0,
                borderBottom: "1px solid #3a3a3a",
                borderTop: "2px solid #00aaff", // TEMP DIAG
              }}
            >
              <NavControls />
              <AddressBar />
            </div>
            {/* Page area — the rect that Rust positions the child webview over */}
            <PageAreaHost ref={hostRef} />
          </>
        )}
      </div>
    </>
  );
}
