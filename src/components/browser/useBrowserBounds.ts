import { useEffect, useRef, RefObject } from "react";
import { listen, TauriEvent } from "@tauri-apps/api/event";
import { setBrowserWebviewBounds } from "../../lib/browserIpc";
import type { Rect } from "../../types/browser";

/**
 * Observe the page-area host's DOM rect and forward it to Rust via
 * `set_browser_webview_bounds`. Covers Phase-1 in-scope #4 (7 sources):
 *
 *   1.  Window resize         — DOM `window.resize`
 *   1a. DPR / scale change    — built-in `TauriEvent.WINDOW_SCALE_FACTOR_CHANGED`
 *   2.  Browser drawer drag   — `ResizeObserver` on host
 *   3.  Canvas drawer drag    — `ResizeObserver` on host
 *   4.  Drawer open/close     — `ResizeObserver` on host
 *   5.  Fullscreen / titlebar — covered by `WINDOW_RESIZED` (tauri://resize)
 *   6.  UpdateBanner show/hide — `ResizeObserver` on host
 *   7.  Minimize → restore     — `WINDOW_RESIZED` (smoke-test on macOS)
 *
 * rAF-debounced so rapid bursts collapse to one IPC per frame. Rust-side
 * `last_bounds` dedup is the second line of defense (skips OS calls when
 * the rect is unchanged).
 */
export function useBrowserBounds(
  hostRef: RefObject<HTMLDivElement>,
  enabled: boolean,
) {
  const rafIdRef = useRef<number | null>(null);
  const lastRectRef = useRef<Rect | null>(null);

  useEffect(() => {
    if (!enabled || !hostRef.current) return;
    const host = hostRef.current;

    const scheduleSync = () => {
      if (rafIdRef.current !== null) return;
      rafIdRef.current = window.requestAnimationFrame(() => {
        rafIdRef.current = null;
        const r = host.getBoundingClientRect();
        const rect: Rect = {
          x: r.left,
          y: r.top,
          width: r.width,
          height: r.height,
        };
        // Frontend-side dedup; Rust does another dedup against last_bounds.
        const last = lastRectRef.current;
        if (
          last &&
          last.x === rect.x &&
          last.y === rect.y &&
          last.width === rect.width &&
          last.height === rect.height
        ) {
          return;
        }
        lastRectRef.current = rect;
        if (rect.width > 0 && rect.height > 0) {
          setBrowserWebviewBounds(rect).catch((err) => {
            // "browser webview not created" is an expected race: the
            // initial sync fires before createBrowserWebview finalizes
            // (or during close). The Rust side seeds last_bounds on
            // create so the next ResizeObserver tick reconciles. Drop
            // that message; surface anything else.
            const msg = typeof err === "string" ? err : String(err);
            if (!msg.includes("not created")) {
              console.debug("[browser-drawer] set_bounds failed:", err);
            }
          });
        }
      });
    };

    // ResizeObserver covers sources 2-6 (host rect changes).
    const ro = new ResizeObserver(() => scheduleSync());
    ro.observe(host);

    // Window resize / fullscreen / minimize-restore.
    window.addEventListener("resize", scheduleSync);

    // Tauri 2 built-in events. Cancellation-safe pattern (impl-review
    // claude2 I1 + codex3 low) — unlisten even if cleanup runs before
    // the listen() promise resolves.
    let cancelled = false;
    let unlistenScale: (() => void) | null = null;
    let unlistenResize: (() => void) | null = null;
    listen(TauriEvent.WINDOW_SCALE_FACTOR_CHANGED, scheduleSync).then((fn) => {
      if (cancelled) fn();
      else unlistenScale = fn;
    });
    listen(TauriEvent.WINDOW_RESIZED, scheduleSync).then((fn) => {
      if (cancelled) fn();
      else unlistenResize = fn;
    });

    // Initial sync once mounted/enabled.
    scheduleSync();

    return () => {
      cancelled = true;
      ro.disconnect();
      window.removeEventListener("resize", scheduleSync);
      if (rafIdRef.current !== null) {
        window.cancelAnimationFrame(rafIdRef.current);
        rafIdRef.current = null;
      }
      unlistenScale?.();
      unlistenResize?.();
    };
  }, [enabled, hostRef]);
}
