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
        // Right-side drawer: cursor X from the right of the container is
        // the proposed width.
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
      {/* Drag handle — visible only when drawer is open */}
      {drawerOpen && (
        <div
          className="w-1 flex-shrink-0 bg-surface-lighter hover:bg-accent cursor-col-resize transition-colors"
          onMouseDown={handleDragStart}
          aria-label="Resize browser drawer"
          role="separator"
        />
      )}
      {/* Drawer panel — always mounted, width controlled by CSS */}
      <div
        className="flex flex-col flex-shrink-0 h-full bg-surface-light border-l border-surface-lighter overflow-hidden"
        style={{
          width: drawerOpen ? `${drawerWidth}px` : 0,
          minWidth: drawerOpen ? 280 : 0,
        }}
      >
        {drawerOpen && (
          <>
            {/* Chrome row: nav buttons + address bar + close */}
            <div className="flex items-center gap-1 px-2 py-1 border-b border-surface-lighter bg-surface flex-shrink-0">
              <Globe size={12} className="text-text-muted flex-shrink-0" />
              <NavControls />
              <AddressBar />
              <button
                type="button"
                className="p-1 text-text-muted hover:text-red-400 hover:bg-surface-lighter rounded transition-colors flex-shrink-0"
                onClick={toggle}
                title="Close Browser"
                aria-label="Close browser drawer"
              >
                <X size={14} />
              </button>
            </div>
            {/* Page area host — the rect that Rust positions the child webview over */}
            <PageAreaHost ref={hostRef} />
          </>
        )}
      </div>
    </>
  );
}
