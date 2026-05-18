import { useEffect, useRef, RefObject } from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import {
  createBrowserTab,
  destroyBrowserTab,
  navigateBrowserTab,
  setBrowserTabBounds,
  setBrowserSettings,
} from "../../lib/browserIpc";
import { enqueueBoundsOp } from "./useBrowserBounds";
import {
  useBrowserStore,
  selectActiveTab,
} from "../../stores/browserStore";
import type {
  BrowserTabLoadingEvent,
  BrowserTabLoadedEvent,
  BrowserTabTitleChangedEvent,
  BrowserTabErrorEvent,
  Rect,
} from "../../types/browser";

interface SettingsSnapshot {
  browser_drawer_width?: number;
  browser_last_url?: string;
}

// Module-level handoff between `useBrowserTabsSettings` (the producer)
// and `useBrowserTabsLifecycle` (the drain). Keyed by tab id so that
// when `get_settings` resolves WHILE a first-tab's webview is still in
// `Creating` state, the resolved URL is parked here; the lifecycle hook
// drains it immediately after `createBrowserTab` returns Ok. Mirrors
// the prior-cycle R4 race fix, scoped to a per-tab map for multi-tab.
// 4-way convergent post-impl-review fix (Finding B).
const pendingRestoreByTab = new Map<string, string>();

// Standard cancellation-safe `listen()` wrapper — survives an unmount
// before the listen() Promise resolves.
function subscribeWithCleanup<T>(
  eventName: string,
  handler: (e: { payload: T }) => void,
): () => void {
  let cancelled = false;
  let unlistenFn: (() => void) | null = null;
  listen<T>(eventName, handler).then((fn) => {
    if (cancelled) {
      fn();
    } else {
      unlistenFn = fn;
    }
  });
  return () => {
    cancelled = true;
    unlistenFn?.();
  };
}

// ---------------------------------------------------------------------------
// useBrowserTabsLifecycle — plan.md row #23
//
// Per-tab create-on-add / destroy-on-remove. Subscribes to browser-tab-*
// events once and routes payloads by tab_id to the matching Tab in the
// store. Race-fix invariants:
//  - CreateGuard generation tracking lives on the Rust side
//    (`BrowserTabsState.try_reserve_for_create`). The frontend just
//    surfaces the "cancelled by destroy" Err if it happens.
//  - In-flight op chain is now PER TAB (not global) — fast close/reopen
//    of one tab doesn't block parallel ops on a sibling tab.
//  - All four event listeners use `subscribeWithCleanup` with a
//    cancellation flag for unmount-before-resolve safety.
//  - Closing the drawer HIDES every tab webview off-screen (r4
//    local-lane spec change — preserves per-tab state across
//    close→reopen). Full destroy only happens on `RunEvent::Exit`
//    and `WindowEvent::Destroyed` in `src-tauri/src/lib.rs`.
// ---------------------------------------------------------------------------
export function useBrowserTabsLifecycle(hostRef: RefObject<HTMLDivElement>) {
  const drawerOpen = useBrowserStore((s) => s.drawerOpen);

  const setTabUrl = useBrowserStore((s) => s.setTabUrl);
  const setTabTitle = useBrowserStore((s) => s.setTabTitle);
  const setTabLoading = useBrowserStore((s) => s.setTabLoading);
  const setTabError = useBrowserStore((s) => s.setTabError);
  const toggle = useBrowserStore((s) => s.toggle);

  // Tabs whose Rust webview has been (or is being) created.
  const trackedTabsRef = useRef<Set<string>>(new Set());
  // Per-tab in-flight chain (serializes create/destroy for the same tab id).
  const inFlightByTabRef = useRef<Map<string, Promise<void>>>(new Map());

  // 1. Per-tab event subscriptions — wire ONCE, route by tab_id.
  useEffect(() => {
    const unsubs = [
      subscribeWithCleanup<BrowserTabLoadingEvent>("browser-tab-loading", (e) => {
        setTabLoading(e.payload.tabId, true);
        setTabUrl(e.payload.tabId, e.payload.url);
        setTabError(e.payload.tabId, null);
      }),
      subscribeWithCleanup<BrowserTabLoadedEvent>("browser-tab-loaded", (e) => {
        setTabLoading(e.payload.tabId, false);
        setTabUrl(e.payload.tabId, e.payload.url);
      }),
      subscribeWithCleanup<BrowserTabTitleChangedEvent>(
        "browser-tab-title-changed",
        (e) => {
          setTabTitle(e.payload.tabId, e.payload.title);
        },
      ),
      subscribeWithCleanup<BrowserTabErrorEvent>("browser-tab-error", (e) => {
        setTabError(e.payload.tabId, e.payload.reason);
        setTabLoading(e.payload.tabId, false);
      }),
    ];
    return () => unsubs.forEach((fn) => fn());
  }, [setTabUrl, setTabTitle, setTabLoading, setTabError]);

  // 2. Menu-toggle subscription (native menu accelerator path).
  useEffect(() => {
    return subscribeWithCleanup<unknown>("menu-toggle-browser", () => toggle());
  }, [toggle]);

  // 3. Diff tabs[] against trackedTabsRef on every render; queue
  //    create for new ids, destroy for removed ids.
  //
  //    We subscribe to the whole store so unmount + tab additions both
  //    trigger this effect. The shallow `tabs` selector is replaced by a
  //    custom equality check on length + ids.
  const tabs = useBrowserStore((s) => s.tabs);
  useEffect(() => {
    const liveIds = new Set(tabs.map((t) => t.id));
    const tracked = trackedTabsRef.current;
    const inFlight = inFlightByTabRef.current;

    // CREATE side — for each new tab, chain create after any pending
    // destroy for the same id.
    for (const tab of tabs) {
      if (tracked.has(tab.id)) continue;
      tracked.add(tab.id);

      const prev = inFlight.get(tab.id) ?? Promise.resolve();
      // eslint-disable-next-line prefer-const
      let next: Promise<void>;
      next = prev
        .catch(() => undefined)
        .then(
          () =>
            new Promise<void>((resolve) => {
              window.requestAnimationFrame(async () => {
                // Helper to clean up tracking on any early-return path
                // so the next diff fire (e.g. drawer reopen) can re-queue
                // create instead of treating this id as "already tracked".
                // Fix per codex3 r4 #1.
                const abandonAndResolve = () => {
                  tracked.delete(tab.id);
                  resolve();
                };

                const host = hostRef.current;
                if (!host) return abandonAndResolve();
                if (!useBrowserStore.getState().drawerOpen) {
                  return abandonAndResolve();
                }
                // Tab might have been closed mid-rAF.
                const tabStillLive = useBrowserStore
                  .getState()
                  .tabs.some((t) => t.id === tab.id);
                if (!tabStillLive) return abandonAndResolve();

                const r = host.getBoundingClientRect();
                const rect: Rect = {
                  x: r.left,
                  y: r.top,
                  width: r.width,
                  height: r.height,
                };
                if (rect.width <= 0 || rect.height <= 0) {
                  return abandonAndResolve();
                }

                const url =
                  useBrowserStore
                    .getState()
                    .tabs.find((t) => t.id === tab.id)?.url ?? "about:blank";

                try {
                  await createBrowserTab(tab.id, url, rect);

                  // Post-create drawer-close race fix (4-way convergent
                  // r4 finding G1): drawer may have closed while WRY
                  // was building the webview. The close-effect couldn't
                  // hide this tab because it was still in Creating state
                  // (clone_tab returned None). Now that we're Ready,
                  // hide immediately so the user doesn't see a stranded
                  // webview at the original on-screen rect.
                  if (!useBrowserStore.getState().drawerOpen) {
                    // Serialized via the bounds-op queue so a fresh
                    // reopen-show can't land before this hide.
                    enqueueBoundsOp(tab.id, () =>
                      setBrowserTabBounds(
                        tab.id,
                        { x: 0, y: 0, width: 1, height: 1 },
                        false,
                      ).catch(() => {
                        /* webview may have been destroyed by
                           RunEvent::Exit or WindowEvent::Destroyed; safe
                           to ignore. */
                      }),
                    );
                    resolve();
                    return;
                  }

                  // Drain any settings-restore URL that landed in
                  // `pendingRestoreByTab` while we were Creating.
                  // Per the plan's settings-restore-during-create race
                  // fix: only drain if the user hasn't manually navigated
                  // since we started — i.e. current url is still
                  // about:blank OR is already the pending value (the
                  // settings handler may have optimistically called
                  // navigateBrowserTab in parallel; either way we want
                  // exactly one navigation to the restored URL).
                  const restoreUrl = pendingRestoreByTab.get(tab.id);
                  if (restoreUrl) {
                    pendingRestoreByTab.delete(tab.id);
                    const current = useBrowserStore
                      .getState()
                      .tabs.find((t) => t.id === tab.id)?.url;
                    const noManualNav =
                      current === "about:blank" || current === restoreUrl;
                    if (noManualNav) {
                      try {
                        await navigateBrowserTab(tab.id, restoreUrl);
                      } catch (e) {
                        console.debug(
                          "[browser-tabs] deferred post-restore navigate failed:",
                          e,
                        );
                      }
                    }
                  }
                } catch (err) {
                  const msg = err instanceof Error ? err.message : String(err);
                  console.error(
                    "[browser-tabs] createBrowserTab FAILED for tab",
                    tab.id,
                    ":",
                    msg,
                  );
                  setTabError(tab.id, msg);
                  pendingRestoreByTab.delete(tab.id);
                  // Forget so we don't re-attempt forever on this tab.
                  // (User can close and reopen the drawer to recover.)
                }
                resolve();
              });
            }),
        )
        .finally(() => {
          // Prune entry only if no newer op chained on top of us — mirrors
          // the boundsOpQueue prune pattern (claude2 r7 H1).
          if (inFlight.get(tab.id) === next) {
            inFlight.delete(tab.id);
          }
        });
      inFlight.set(tab.id, next);
    }

    // DESTROY side — for each tracked id no longer in tabs[], destroy.
    const toRemove: string[] = [];
    tracked.forEach((id) => {
      if (!liveIds.has(id)) toRemove.push(id);
    });
    for (const id of toRemove) {
      tracked.delete(id);
      const prev = inFlight.get(id) ?? Promise.resolve();
      // eslint-disable-next-line prefer-const
      let next: Promise<void>;
      next = prev
        .catch(() => undefined)
        .then(() =>
          destroyBrowserTab(id).catch((err) =>
            console.debug("[browser-tabs] destroyBrowserTab failed:", err),
          ),
        )
        .finally(() => {
          if (inFlight.get(id) === next) {
            inFlight.delete(id);
          }
        });
      inFlight.set(id, next);
    }
    // drawerOpen is in the dep array so that a drawer-reopen re-runs the
    // diff. After codex3 r4 #1, an early-return path (host null, drawer
    // closing during the rAF gap, zero-rect host) cleans `tracked`; on
    // reopen this effect re-fires and re-queues create for tabs that
    // are in tabs[] but missing from tracked.
  }, [tabs, hostRef, setTabError, drawerOpen]);

  // 4. Drawer close → hide every tab webview off-screen instead of
  //    destroying. Preserves per-tab page state (URL, scroll, forms,
  //    history) for the next drawer-open. App-quit and window-destroy
  //    still wipe everything via RunEvent::Exit / WindowEvent::Destroyed
  //    in src-tauri/src/lib.rs — close→reopen persistence is intentional;
  //    app-restart persistence is not (user's local-lane spec change).
  const previousOpenRef = useRef(false);
  useEffect(() => {
    const wasOpen = previousOpenRef.current;
    previousOpenRef.current = drawerOpen;

    if (wasOpen && !drawerOpen) {
      // Hide every existing tab webview via the visible=false path.
      // Rect is ignored when visible=false (Rust positions at
      // HIDDEN_TAB_Y); pass a minimal placeholder. Serialize per-tab
      // via enqueueBoundsOp so a subsequent drawer-reopen's show IPC
      // is forced to wait for the matching hide to finish — closes
      // the 2-way convergent r5 hide/show ordering race (codex2 +
      // codex3).
      const placeholder: Rect = { x: 0, y: 0, width: 1, height: 1 };
      const { tabs } = useBrowserStore.getState();
      for (const t of tabs) {
        enqueueBoundsOp(t.id, () =>
          setBrowserTabBounds(t.id, placeholder, false).catch((err) => {
            const msg = typeof err === "string" ? err : String(err);
            if (!msg.includes("not created")) {
              console.debug("[browser-tabs] hide-on-close failed:", err);
            }
          }),
        );
      }
      // Defensive: any settings-restore URL parked during this session
      // should not survive a drawer cycle (the resolver fires only on
      // cold-start, but clearing is cheap and prevents stale entries
      // if a future code path enqueues during a reopen).
      pendingRestoreByTab.clear();

      // INTENTIONALLY NOT cleared: trackedTabsRef, inFlightByTabRef,
      // useBrowserStore.tabs, activeTabId. The Rust webviews are still
      // alive; the lifecycle diff effect must continue to recognise
      // them as "already tracked" on reopen so no duplicate creates
      // fire.
    }
  }, [drawerOpen]);
}

// ---------------------------------------------------------------------------
// BrowserTabsSettings sub-hook — plan.md rows #28-#32 (co-located here
// per the planner decision; no new file).
//
// Restores drawer width + seeds first tab URL from `browser_last_url` on
// mount. Persists drawer width + active-tab URL (non-blank) via
// debounced `set_browser_settings` patch. Settings-restore-during-create
// race guard is scoped to the first tab — that's the single path that
// can race the cold-start `get_settings` resolve against a webview build.
// ---------------------------------------------------------------------------
export function useBrowserTabsSettings() {
  const drawerOpen = useBrowserStore((s) => s.drawerOpen);
  const drawerWidth = useBrowserStore((s) => s.drawerWidth);
  const tabs = useBrowserStore((s) => s.tabs);
  const setDrawerWidth = useBrowserStore((s) => s.setDrawerWidth);
  const seedInitialTab = useBrowserStore((s) => s.seedInitialTab);

  const initialLoadDoneRef = useRef(false);
  // Single source of truth for both (a) the "what did we last persist"
  // dedup AND (b) the "what URL should we seed the first tab with on
  // drawer-open" lookup. Seeded by cold-start `get_settings` AND
  // updated by every successful `persistActiveTabUrl`, so it always
  // reflects the freshest `browser_last_url`. (Earlier r2 introduced
  // a separate `restoredFirstTabUrlRef` that froze on cold-start and
  // produced stale-seed reopens; 4-way-convergent r3 fix dropped it
  // in favor of this single ref.)
  const lastPersistedRef = useRef<SettingsSnapshot>({});

  // 1. Restore drawer width + record `browser_last_url` on first mount.
  //    `get_settings` is async. Two handling paths depending on whether
  //    a first tab already exists when settings resolves:
  //    - tabs[].length === 0 → just stash the URL for next drawer-open.
  //    - tabs[0] exists with url=about:blank → park URL in
  //      `pendingRestoreByTab` (cross-hook handoff) AND optimistically
  //      try `navigateBrowserTab`. If the webview is still Creating,
  //      the IPC will fail; the lifecycle hook drains the pending entry
  //      after `createBrowserTab` succeeds. (Mirrors prior cycle's R4.)
  useEffect(() => {
    if (initialLoadDoneRef.current) return;
    initialLoadDoneRef.current = true;

    invoke<SettingsSnapshot>("get_settings")
      .then((s) => {
        if (
          typeof s.browser_drawer_width === "number" &&
          s.browser_drawer_width > 0
        ) {
          setDrawerWidth(s.browser_drawer_width);
        }

        const restoredUrl = s.browser_last_url;
        if (restoredUrl) {
          const state = useBrowserStore.getState();
          if (state.tabs.length > 0) {
            const firstTab = state.tabs[0];
            if (firstTab && firstTab.url === "about:blank") {
              // Park the pending URL FIRST so the lifecycle drain has a
              // chance even if the optimistic navigate below races a
              // still-Creating slot.
              pendingRestoreByTab.set(firstTab.id, restoredUrl);
              navigateBrowserTab(firstTab.id, restoredUrl)
                .then(() => {
                  // Success — drain the pending so the lifecycle doesn't
                  // double-navigate after createBrowserTab finalizes.
                  pendingRestoreByTab.delete(firstTab.id);
                })
                .catch((err) => {
                  // Expected when the slot is still Creating; the
                  // lifecycle's post-create drain will fire later.
                  const msg = typeof err === "string" ? err : String(err);
                  if (!msg.includes("not created")) {
                    console.debug(
                      "[browser-tabs] post-restore navigate failed:",
                      err,
                    );
                  }
                });
            }
          }
        }

        lastPersistedRef.current = {
          browser_drawer_width: s.browser_drawer_width,
          browser_last_url: s.browser_last_url,
        };
      })
      .catch((err) =>
        console.debug("[browser-tabs] get_settings failed:", err),
      );
  }, [setDrawerWidth]);

  // 2. On every drawer-open: seed the first tab (if missing) using the
  //    last-known `browser_last_url` (or `about:blank` fallback). This
  //    fires on first-ever open AND on every subsequent reopen — fixes
  //    Finding B (subsequent reopens didn't re-seed in r1 impl).
  const previousOpenRef = useRef(false);
  useEffect(() => {
    const wasOpen = previousOpenRef.current;
    previousOpenRef.current = drawerOpen;

    if (!wasOpen && drawerOpen) {
      const state = useBrowserStore.getState();
      if (state.tabs.length === 0) {
        // Single source of truth: lastPersistedRef is seeded by
        // cold-start get_settings AND updated by every successful
        // persist, so it always reflects the freshest browser_last_url.
        const seedUrl =
          lastPersistedRef.current.browser_last_url ?? "about:blank";
        seedInitialTab(seedUrl);
      }
    }
  }, [drawerOpen, seedInitialTab]);

  // 3. Persist drawer width (debounced) when changed.
  useEffect(() => {
    const timer = window.setTimeout(() => {
      const rounded = Math.round(drawerWidth);
      if (rounded === lastPersistedRef.current.browser_drawer_width) return;
      setBrowserSettings({ browser_drawer_width: rounded })
        .then(() => {
          lastPersistedRef.current = {
            ...lastPersistedRef.current,
            browser_drawer_width: rounded,
          };
        })
        .catch((err) =>
          console.debug("[browser-tabs] persist width failed:", err),
        );
    }, 800);
    return () => window.clearTimeout(timer);
  }, [drawerWidth]);

  // 4. Persist active-tab URL (debounced) — only when non-blank and changed.
  const activeUrl = useBrowserStore((s) => selectActiveTab(s)?.url) ?? "";
  useEffect(() => {
    if (!activeUrl || activeUrl === "about:blank") return;
    if (activeUrl === lastPersistedRef.current.browser_last_url) return;

    const timer = window.setTimeout(() => {
      setBrowserSettings({ browser_last_url: activeUrl })
        .then(() => {
          lastPersistedRef.current = {
            ...lastPersistedRef.current,
            browser_last_url: activeUrl,
          };
        })
        .catch((err) =>
          console.debug("[browser-tabs] persist last_url failed:", err),
        );
    }, 800);
    return () => window.clearTimeout(timer);
  }, [activeUrl]);

  // tabs is intentionally consumed to keep the hook reactive across tab
  // changes (e.g. the seed effect re-runs on drawer toggle).
  void tabs;
}
