import { forwardRef } from "react";

/**
 * Empty positioned `<div>` whose DOM rect the OS-layer child webview
 * overlays. `useBrowserBounds` observes its bounding box and forwards
 * the rect to `set_browser_webview_bounds`.
 *
 * The element has explicit `min-height: 0` so flex parents don't expand
 * it past the available space — the rect must reflect the actual layout
 * box, not the content size.
 */
export const PageAreaHost = forwardRef<HTMLDivElement>(function PageAreaHost(
  _props,
  ref,
) {
  return (
    <div
      ref={ref}
      className="flex-1 min-h-0 w-full bg-surface-light"
      data-browser-page-area
      // Background visible briefly between webview destroy and create;
      // matches the canvas drawer's empty-state shade.
    />
  );
});
