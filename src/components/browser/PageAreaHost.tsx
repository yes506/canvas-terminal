import { forwardRef } from "react";

/**
 * Empty positioned `<div>` whose DOM rect the OS-layer child webview
 * overlays. `useBrowserBounds` observes its bounding box and forwards
 * the rect to `set_browser_webview_bounds`.
 *
 * Dark background so when the webview hasn't yet been positioned or has
 * been destroyed, the area is unambiguously empty (a different color
 * than the chrome rows above it).
 */
export const PageAreaHost = forwardRef<HTMLDivElement>(function PageAreaHost(
  _props,
  ref,
) {
  return (
    <div
      ref={ref}
      className="flex-1 min-h-0 w-full"
      data-browser-page-area
      // TEMP DIAGNOSTIC (impl-review round 5-UX): bright red background
      // so the user can visually see WHERE the host element is, which
      // is also where the OS-layer webview is positioned. If red is
      // visible above the URL input row, the rect/coordinate is wrong
      // and the webview is covering Row 2. If red is only visible
      // below Row 2, the rect is correct and the input invisibility
      // has a different root cause.
      style={{ background: "#ff0000" }}
    />
  );
});
