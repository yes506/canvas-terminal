import { useRef, useCallback, useEffect, RefObject } from "react";
import { Globe, X } from "lucide-react";
import {
  useBrowserStore,
  selectActiveTitle,
  nextZoomStep,
  prevZoomStep,
  ZOOM_DEFAULT,
} from "../../stores/browserStore";
import { browserTabSetZoom } from "../../lib/browserIpc";
import { AddressBar } from "./AddressBar";
import { NavControls } from "./NavControls";
import { PageAreaHost } from "./PageAreaHost";
import { TabStrip } from "./TabStrip";
import { ZoomControls } from "./ZoomControls";
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
  const drawerRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef(false);

  // Drawer-scoped keyboard shortcuts for browser zoom (Cmd|Ctrl + =/+/-/0).
  //
  // Registered at document capture-phase so we beat the existing
  // `useKeyboardShortcuts.ts` window-bubble listener that binds the same
  // chords to terminal font size. When focus is inside drawer chrome
  // (AddressBar, toolbar buttons) we stopPropagation so the terminal
  // handler does NOT fire — browser wins. When focus is elsewhere
  // (terminal, canvas, document.body) we no-op and let the event bubble
  // to the terminal-font handler so its existing UX is preserved.
  //
  // Documented limitation: keystrokes that target the native WKWebView
  // page itself never reach the React tree, so the shortcuts won't fire
  // when the page has focus. The buttons in ZoomControls are always
  // available as the reliable path.
  useEffect(() => {
    if (!drawerOpen) return;
    const handler = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      const key = e.key;
      const isZoomKey =
        key === "=" || key === "+" || key === "-" || key === "0";
      if (!isZoomKey) return;
      const drawer = drawerRef.current;
      if (!drawer) return;
      const focused = document.activeElement;
      if (!(focused instanceof Node) || !drawer.contains(focused)) return;
      e.preventDefault();
      e.stopPropagation();
      const state = useBrowserStore.getState();
      const tabId = state.activeTabId;
      if (!tabId) return;
      const tab = state.tabs.find((t) => t.id === tabId);
      if (!tab) return;
      let level: number;
      if (key === "0") level = ZOOM_DEFAULT;
      else if (key === "-") level = prevZoomStep(tab.zoom);
      else level = nextZoomStep(tab.zoom); // '=' or '+' (shift-= and numpad-+)
      if (level === tab.zoom) return;
      void browserTabSetZoom(tabId, level).then(
        () => {
          useBrowserStore.getState().setTabZoom(tabId, level);
        },
        (err: unknown) => {
          const msg = String(err);
          if (msg.includes("not created")) return;
          useBrowserStore.getState().setTabError(tabId, msg);
        },
      );
    };
    document.addEventListener("keydown", handler, true);
    return () => document.removeEventListener("keydown", handler, true);
  }, [drawerOpen]);

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
        ref={drawerRef}
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
              <ZoomControls />
            </div>
            {/* Page area — Rust positions the active child webview over this rect */}
            <PageAreaHost ref={hostRef} />
          </>
        )}
      </div>
    </>
  );
}
