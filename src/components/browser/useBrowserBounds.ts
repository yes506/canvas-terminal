import { useEffect, useRef, RefObject } from "react";
import { listen, TauriEvent } from "@tauri-apps/api/event";
import { setBrowserTabBounds } from "../../lib/browserIpc";
import { useBrowserStore } from "../../stores/browserStore";
import type { Rect } from "../../types/browser";

// ---------------------------------------------------------------------------
// Per-tab bounds-op queue — shared between this hook and
// useBrowserTabsLifecycle's close branch. Serializes setBrowserTabBounds
// IPCs so a stale hide from a drawer-close can't land at Rust AFTER a
// fresh show from drawer-reopen.
//
// Tauri 2 runs commands on a multi-threaded tokio runtime: individual
// handlers can be picked up by different workers, so even though
// JS-side message dispatch is FIFO, handler-completion order isn't
// guaranteed under load. The JS-side chain forces each invoke to wait
// for the previous handler's `await invoke()` Promise to resolve
// (which fires when the Rust handler returns) before issuing the next.
// Combined with Tauri's FIFO message delivery, this makes the
// hide/show ordering deterministic.
//
// 2-way convergent r5 finding (codex2 + codex3).
// ---------------------------------------------------------------------------
const boundsOpQueue = new Map<string, Promise<void>>();

export function enqueueBoundsOp(
  tabId: string,
  op: () => Promise<void>,
): Promise<void> {
  const prev = boundsOpQueue.get(tabId) ?? Promise.resolve();
  // eslint-disable-next-line prefer-const
  let next: Promise<void>;
  next = prev
    .catch(() => undefined)
    .then(() => op().catch(() => undefined))
    .finally(() => {
      // Prune the map entry only if no newer op chained on top of us.
      // If a newer op was enqueued, its own `.finally` will run later
      // and handle the cleanup. 3-way convergent r6 finding
      // (claude3 r6 #1, codex2 #3, codex3) — prevents unbounded map
      // growth across long sessions with many created/closed tabs.
      if (boundsOpQueue.get(tabId) === next) {
        boundsOpQueue.delete(tabId);
      }
    });
  boundsOpQueue.set(tabId, next);
  return next;
}

/**
 * Observe the page-area host's DOM rect and forward it to Rust via
 * `set_browser_tab_bounds`. The ACTIVE tab gets the on-screen rect
 * with `visible: true`; INACTIVE tabs get the same rect with
 * `visible: false` so Rust places them off-screen (page keeps running,
 * preserving state across tab switches — Chrome-like).
 *
 * Sources of rect change:
 *   1. Window resize         — DOM `window.resize`
 *   1a. DPR / scale change   — `TauriEvent.WINDOW_SCALE_FACTOR_CHANGED`
 *   2. Browser drawer drag   — `ResizeObserver` on host
 *   3. Canvas drawer drag    — `ResizeObserver` on host
 *   4. Drawer open/close     — `ResizeObserver` on host
 *   5. Fullscreen / titlebar — `TauriEvent.WINDOW_RESIZED`
 *   6. UpdateBanner show/hide— `ResizeObserver` on host
 *   7. Active-tab switch     — store subscription on `activeTabId`
 *
 * rAF-debounced so rapid bursts collapse to one IPC per frame. On
 * active-tab switch, the OLD active tab is hidden and the NEW active
 * tab is shown in the SAME rAF tick (avoids one-frame off-screen
 * flicker — claude2 S4).
 */
export function useBrowserTabsBounds(
  hostRef: RefObject<HTMLDivElement>,
  enabled: boolean,
) {
  const rafIdRef = useRef<number | null>(null);
  // Per-tab "last sent rect" cache. Rust dedups again on its side, but
  // skipping the IPC entirely when nothing changed cuts redundant
  // marshalling on every RO tick.
  const lastSentRef = useRef<Map<string, Rect>>(new Map());
  // Last activeTabId we synced to. When this differs from the live
  // store value during a sync, we know it's an active-tab switch and
  // must hide the previous (in the same rAF, before showing the new).
  const lastActiveRef = useRef<string | null>(null);

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
        if (rect.width <= 0 || rect.height <= 0) return;

        const { tabs, activeTabId } = useBrowserStore.getState();
        if (tabs.length === 0 || activeTabId === null) return;

        // Detect active-tab switch — hide-prev + show-new same rAF.
        const previousActive = lastActiveRef.current;
        const switched = previousActive !== null && previousActive !== activeTabId;

        // Hide previous active (if any) FIRST.
        if (switched && previousActive) {
          const stillExists = tabs.some((t) => t.id === previousActive);
          if (stillExists) {
            // Serialized per-tab — combined with the close-branch's
            // enqueueBoundsOp use, ensures any stale hide for this
            // tab finishes before a subsequent show on tab switch.
            enqueueBoundsOp(previousActive, () =>
              setBrowserTabBounds(previousActive, rect, false).catch(
                (err) => {
                  const msg = typeof err === "string" ? err : String(err);
                  if (!msg.includes("not created")) {
                    console.debug("[browser-tabs] hide prev failed:", err);
                  }
                },
              ),
            );
          }
        }

        // Show new active.
        const last = lastSentRef.current.get(activeTabId);
        const unchanged =
          last &&
          last.x === rect.x &&
          last.y === rect.y &&
          last.width === rect.width &&
          last.height === rect.height &&
          !switched;
        if (!unchanged) {
          lastSentRef.current.set(activeTabId, rect);
          // Serialized: any pending hide for this tab (from a prior
          // drawer-close or active-tab-switch) drains first.
          enqueueBoundsOp(activeTabId, () =>
            setBrowserTabBounds(activeTabId, rect, true).catch((err) => {
              const msg = typeof err === "string" ? err : String(err);
              if (!msg.includes("not created")) {
                console.debug("[browser-tabs] set_bounds failed:", err);
              }
            }),
          );
        }

        lastActiveRef.current = activeTabId;
      });
    };

    // ResizeObserver covers sources 2-6 (host rect changes).
    const ro = new ResizeObserver(() => scheduleSync());
    ro.observe(host);

    window.addEventListener("resize", scheduleSync);

    // Subscribe to activeTabId changes so a tab switch triggers the sync
    // even when the host rect itself hasn't changed.
    const unsubStore = useBrowserStore.subscribe((s, prev) => {
      if (s.activeTabId !== prev.activeTabId) {
        scheduleSync();
      }
    });

    // Tauri 2 built-in events. Cancellation-safe pattern.
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
      unsubStore();
      if (rafIdRef.current !== null) {
        window.cancelAnimationFrame(rafIdRef.current);
        rafIdRef.current = null;
      }
      unlistenScale?.();
      unlistenResize?.();
      lastSentRef.current.clear();
      lastActiveRef.current = null;
    };
  }, [enabled, hostRef]);
}
