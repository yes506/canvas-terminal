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
      style={{ background: "#0a0a0a" }}
    />
  );
});
