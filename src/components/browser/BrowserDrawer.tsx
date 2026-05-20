import { useRef, useCallback, RefObject } from "react";
import { Globe, X } from "lucide-react";
import {
  useBrowserStore,
  selectActiveTitle,
} from "../../stores/browserStore";
import { AddressBar } from "./AddressBar";
import { NavControls } from "./NavControls";
import { PageAreaHost } from "./PageAreaHost";
import { TabStrip } from "./TabStrip";
import { useBrowserTabsBounds } from "./useBrowserBounds";
import {
  useBrowserTabsLifecycle,
  useBrowserTabsSettings,
} from "./useBrowserLifecycle";
interface BrowserDrawerProps {
  /** Effective rendered width of THIS drawer in px, computed by App.tsx's
   *  call to `resolveDrawerWidths`. Cross-drawer / sibling-aware clamping
   *  happens there (one source of truth); this component only renders. */
  browserEffectiveWidth: number;
  /** Total container width (App.tsx ref). Used by the local drag handler's
   *  self-aware sanitizer to bound the persisted intent. */
  containerWidth: number;
}

export function BrowserDrawer({
  browserEffectiveWidth,
  containerWidth,
}: BrowserDrawerProps) {
  const drawerOpen = useBrowserStore((s) => s.drawerOpen);
  // `drawerWidth` (the user's intent) is no longer read here — the
  // effective rendered width comes via `browserEffectiveWidth` prop
  // (computed in App.tsx by `resolveDrawerWidths`). The setter is still
  // used by the drag handler to persist intent.
  const setDrawerWidth = useBrowserStore((s) => s.setDrawerWidth);
  const toggle = useBrowserStore((s) => s.toggle);
  const activeTitle = useBrowserStore(selectActiveTitle);

  const hostRef = useRef<HTMLDivElement>(null) as RefObject<HTMLDivElement>;
  const draggingRef = useRef(false);

  // Mount the three hooks: settings (restore/persist) → lifecycle
  // (per-tab create/destroy + event routing) → bounds (active visible,
  // others hidden, same-rAF switch).
  useBrowserTabsSettings();
  useBrowserTabsLifecycle(hostRef);
  useBrowserTabsBounds(hostRef, drawerOpen);

  // Drag handle on the LEFT edge of the right-side drawer.
  //
  // The drag handler stores the user's INTENT (the value they dragged to)
  // via `setDrawerWidth`. Cross-drawer / sibling-aware clamping is NOT
  // done here — that's centralized in App.tsx's `resolveDrawerWidths`
  // call at render time (so order-independence + intent-preservation
  // across window resize both hold).
  //
  // We still do a SELF-AWARE sanitizer here — clamping the raw mouse-
  // delta to [280, containerWidth] — to prevent absurd values from
  // being persisted by `useBrowserTabsSettings`'s debounced settings
  // write. The lower bound matches the drawer's own min-width (CSS
  // `min-width: 280px` below); the upper bound prevents negative or
  // larger-than-container values from leaking when the cursor exits the
  // window mid-drag.
  const handleDragStart = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      draggingRef.current = true;
      const onMouseMove = (ev: MouseEvent) => {
        if (!draggingRef.current) return;
        const proposed = containerWidth - ev.clientX;
        const sanitized = Math.max(280, Math.min(containerWidth, proposed));
        setDrawerWidth(sanitized);
      };
      const onMouseUp = () => {
        draggingRef.current = false;
        document.removeEventListener("mousemove", onMouseMove);
        document.removeEventListener("mouseup", onMouseUp);
      };
      document.addEventListener("mousemove", onMouseMove);
      document.addEventListener("mouseup", onMouseUp);
    },
    [containerWidth, setDrawerWidth],
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
          width: drawerOpen ? `${browserEffectiveWidth}px` : 0,
          minWidth: drawerOpen ? 280 : 0,
        }}
      >
        {drawerOpen && (
          <>
            {/* Row 0: Chrome-like tab strip. */}
            <TabStrip />
            {/* Row 1: title bar — Globe icon + active tab title + close. */}
            <div
              className="flex items-center gap-2 px-3 border-b border-surface-lighter flex-shrink-0"
              style={{ background: "#2a2a2a", minHeight: 32 }}
            >
              <Globe size={13} className="text-text-muted flex-shrink-0" />
              <span
                className="flex-1 min-w-0 text-[11px] text-text truncate"
                title={activeTitle || "Browser"}
              >
                {activeTitle || "Browser"}
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
            {/* Row 2: nav controls + address bar. */}
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
              }}
            >
              <NavControls />
              <AddressBar />
            </div>
            {/* Page area — Rust positions the active child webview over this rect */}
            <PageAreaHost ref={hostRef} />
          </>
        )}
      </div>
    </>
  );
}
