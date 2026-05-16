import { useEffect, useRef, RefObject } from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import {
  createBrowserWebview,
  destroyBrowserWebview,
  navigateBrowser,
  setBrowserSettings,
} from "../../lib/browserIpc";
import { useBrowserStore } from "../../stores/browserStore";
import type {
  BrowserErrorEvent,
  BrowserLoadingEvent,
  BrowserLoadedEvent,
  BrowserTitleChangedEvent,
  Rect,
} from "../../types/browser";

interface SettingsSnapshot {
  browser_drawer_width?: number;
  browser_last_url?: string;
}

// Standard pattern (impl-review @claude2 I1 + @codex3 low):
// listen()'s returned unlisten function arrives via a Promise. If the
// effect's cleanup runs before the Promise resolves, we must unlisten
// once it does. This helper covers all 7 listener sites.
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

/**
 * Drawer lifecycle: create-on-open, destroy-on-close, subscribe to nav-event
 * back-channel, subscribe to the menu-toggle accelerator.
 *
 * Race fixes folded in (impl-review Round-1):
 *   - close-during-create ghost webview (codex3 high #1): handled in Rust
 *     via generation-tracked CreateGuard; this hook surfaces the
 *     "cancelled by destroy" Err and reacts to it.
 *   - currentUrl-cancels-rAF (codex3 high #2): create-on-open effect
 *     does NOT depend on currentUrl; reads it inside the rAF via
 *     useBrowserStore.getState().
 *   - settings-restore race (codex2 P2): when settings resolves AFTER
 *     the drawer is already open with about:blank, navigate the
 *     existing webview to the restored URL.
 *   - listener cleanup race (claude2 I1, codex3 low): all 7 listen()
 *     sites use subscribeWithCleanup with a cancelled flag.
 *   - fast close/reopen (codex2 P1): a single in-flight create operation
 *     awaits any pending destroy via an inFlightOp promise chain.
 */
export function useBrowserLifecycle(hostRef: RefObject<HTMLDivElement>) {
  const drawerOpen = useBrowserStore((s) => s.drawerOpen);
  const drawerWidth = useBrowserStore((s) => s.drawerWidth);
  const currentUrl = useBrowserStore((s) => s.currentUrl);
  const setCurrentUrl = useBrowserStore((s) => s.setCurrentUrl);
  const setPageTitle = useBrowserStore((s) => s.setPageTitle);
  const setLoading = useBrowserStore((s) => s.setLoading);
  const setError = useBrowserStore((s) => s.setError);
  const toggle = useBrowserStore((s) => s.toggle);
  const setDrawerWidth = useBrowserStore((s) => s.setDrawerWidth);

  const initialLoadDoneRef = useRef(false);
  const lastPersistedRef = useRef<SettingsSnapshot>({});
  // Serialized op chain: any create awaits any pending destroy and vice-versa.
  const inFlightOpRef = useRef<Promise<void>>(Promise.resolve());
  // Track whether the *currently visible* webview was initially seeded with
  // about:blank because settings hadn't loaded yet. If so, when settings
  // resolves with a non-default browser_last_url, navigate it.
  const initialLoadIsBlankRef = useRef(false);
  // True only between successful createBrowserWebview() return and the
  // next destroyOnClose. Gates whether a settings-resolve-during-create
  // can navigate immediately or must defer (impl-review R2 codex2 P2 +
  // codex3 medium #1).
  const webviewReadyRef = useRef(false);
  // If settings resolves WHILE create is in flight, store the restored
  // URL here. The create callback navigates to it after createBrowserWebview
  // returns successfully. Cleared on destroy.
  const pendingRestoredUrlRef = useRef<string | null>(null);

  // Initial settings load — restores drawer width + last URL.
  useEffect(() => {
    if (initialLoadDoneRef.current) return;
    initialLoadDoneRef.current = true;
    invoke<SettingsSnapshot>("get_settings")
      .then((s) => {
        if (typeof s.browser_drawer_width === "number" && s.browser_drawer_width > 0) {
          setDrawerWidth(s.browser_drawer_width);
        }
        if (s.browser_last_url) {
          setCurrentUrl(s.browser_last_url);
          // Settings-restore race fix (impl-review R1 codex2 P2 + R2
          // codex2 P2 / codex3 medium #1): the navigate path depends on
          // whether the webview is already Ready or still being built.
          if (
            useBrowserStore.getState().drawerOpen &&
            initialLoadIsBlankRef.current
          ) {
            if (webviewReadyRef.current) {
              // Webview already Ready → navigate now.
              navigateBrowser(s.browser_last_url).catch((err) => {
                console.debug(
                  "[browser-drawer] post-restore navigate failed:",
                  err,
                );
              });
              initialLoadIsBlankRef.current = false;
            } else {
              // Webview still being built; the create callback will
              // navigate to this URL once createBrowserWebview returns.
              pendingRestoredUrlRef.current = s.browser_last_url;
            }
          }
        }
        lastPersistedRef.current = {
          browser_drawer_width: s.browser_drawer_width,
          browser_last_url: s.browser_last_url,
        };
      })
      .catch((err) => console.debug("[browser-drawer] get_settings failed:", err));
  }, [setDrawerWidth, setCurrentUrl]);

  // Nav-event back-channel subscription. 4 listeners with cancellation-safe cleanup.
  useEffect(() => {
    const unsubs = [
      subscribeWithCleanup<BrowserLoadingEvent>("browser-loading", (e) => {
        setLoading(true);
        setCurrentUrl(e.payload.url);
        setError(null);
      }),
      subscribeWithCleanup<BrowserLoadedEvent>("browser-loaded", (e) => {
        setLoading(false);
        setCurrentUrl(e.payload.url);
      }),
      subscribeWithCleanup<BrowserTitleChangedEvent>("browser-title-changed", (e) => {
        setPageTitle(e.payload.title);
      }),
      subscribeWithCleanup<BrowserErrorEvent>("browser-error", (e) => {
        setError(e.payload.reason);
        setLoading(false);
      }),
    ];
    return () => unsubs.forEach((fn) => fn());
  }, [setLoading, setCurrentUrl, setPageTitle, setError]);

  // Menu-toggle subscription (the native-menu accelerator path).
  useEffect(() => {
    return subscribeWithCleanup<unknown>("menu-toggle-browser", () => toggle());
  }, [toggle]);

  // create-on-open / destroy-on-close. Depends ONLY on drawerOpen (NOT
  // currentUrl — that's read inside the rAF) so unrelated URL updates
  // don't cancel an in-flight create (impl-review codex3 high #2 fix).
  const previousOpenRef = useRef(false);
  useEffect(() => {
    if (drawerOpen === previousOpenRef.current) return;
    previousOpenRef.current = drawerOpen;

    if (drawerOpen) {
      // Chain create after any pending destroy so fast close/reopen doesn't
      // race (impl-review codex2 P1 + codex3 high #1 fix).
      let cancelled = false;
      inFlightOpRef.current = inFlightOpRef.current
        .catch(() => undefined)
        .then(
          () =>
            new Promise<void>((resolve) => {
              if (cancelled) return resolve();
              window.requestAnimationFrame(async () => {
                if (cancelled) return resolve();
                const host = hostRef.current;
                if (!host) return resolve();
                const r = host.getBoundingClientRect();
                const rect: Rect = {
                  x: r.left,
                  y: r.top,
                  width: r.width,
                  height: r.height,
                };
                if (rect.width <= 0 || rect.height <= 0) return resolve();

                // Read latest store values INSIDE the rAF (codex3 #2 fix).
                const initialUrl =
                  useBrowserStore.getState().currentUrl || "about:blank";
                initialLoadIsBlankRef.current = initialUrl === "about:blank";
                try {
                  await createBrowserWebview(initialUrl, rect);
                  // Round-3 hygiene (impl-review @codex3 minor): the user
                  // may have closed the drawer mid-build. If so, the queued
                  // destroy will close the webview; don't mutate
                  // Ready-related refs since they'd lie about the actual
                  // state.
                  if (cancelled || !useBrowserStore.getState().drawerOpen) {
                    resolve();
                    return;
                  }
                  webviewReadyRef.current = true;
                  setError(null);
                  // Drain any URL deferred by the settings-resolve-during-
                  // create race (impl-review R2 codex2 P2 + codex3 #1).
                  //
                  // Round-4 fix (impl-review R4 codex2 P1 + codex3 high,
                  // 2-way convergent): the R3 manual-nav guard of
                  // `currentUrl === "about:blank"` was too aggressive.
                  // The settings-restore handler itself calls
                  // setCurrentUrl(restored) BEFORE queuing
                  // pendingRestoredUrlRef, so by the time we reach this
                  // drain check, currentUrl is ALREADY the restored URL
                  // — not the user manually navigating away. The R3
                  // check discarded the pending URL in exactly the
                  // scenario R2 was trying to fix.
                  //
                  // Correct "no manual nav" check: currentUrl is either
                  // still about:blank (no writes since create started)
                  // OR equals the pending restored URL (settings-restore
                  // wrote it; that's the only writer that could have
                  // fired during the create-in-flight window because
                  // manual nav via navigateBrowser would have failed
                  // with "browser webview not created").
                  if (
                    pendingRestoredUrlRef.current &&
                    initialUrl === "about:blank" &&
                    useBrowserStore.getState().drawerOpen
                  ) {
                    const restored = pendingRestoredUrlRef.current;
                    const current = useBrowserStore.getState().currentUrl;
                    const noManualNav =
                      current === "about:blank" || current === restored;
                    if (noManualNav) {
                      pendingRestoredUrlRef.current = null;
                      try {
                        await navigateBrowser(restored);
                        initialLoadIsBlankRef.current = false;
                      } catch (e) {
                        console.debug(
                          "[browser-drawer] deferred post-restore navigate failed:",
                          e,
                        );
                      }
                    } else {
                      // currentUrl is neither blank nor the pending URL
                      // → user manually navigated (only possible if a
                      // browser-loading event already fired, which
                      // requires the slot to have been Ready). Discard
                      // pending so the later open doesn't surprise.
                      pendingRestoredUrlRef.current = null;
                    }
                  }
                } catch (err) {
                  const msg = err instanceof Error ? err.message : String(err);
                  // Surface to browserStore.error (rendered in the
                  // AddressBar error span when the drawer is open) AND
                  // log explicitly so the failure is visible in the
                  // dev console even if the AddressBar isn't rendering
                  // (impl-review R5-UX). The user's earlier "set_bounds
                  // failed: browser webview not created" was the
                  // downstream symptom; this prints the root cause.
                  console.error(
                    "[browser-drawer] createBrowserWebview FAILED:",
                    msg,
                  );
                  setError(msg);
                }
                resolve();
              });
            }),
        );

      return () => {
        cancelled = true;
      };
    } else {
      // Reset the ready flag + drop any pending restore URL before the
      // destroy command runs; the next create will re-seed them.
      webviewReadyRef.current = false;
      pendingRestoredUrlRef.current = null;
      inFlightOpRef.current = inFlightOpRef.current
        .catch(() => undefined)
        .then(() =>
          destroyBrowserWebview().catch((err) =>
            console.debug("[browser-drawer] destroy on close failed:", err),
          ),
        );
    }
  }, [drawerOpen, hostRef, setError]);

  // Persist drawer width + last URL (debounced).
  useEffect(() => {
    const timer = window.setTimeout(() => {
      const patch: SettingsSnapshot = {};
      if (drawerWidth !== lastPersistedRef.current.browser_drawer_width) {
        patch.browser_drawer_width = Math.round(drawerWidth);
      }
      if (
        currentUrl &&
        currentUrl !== "about:blank" &&
        currentUrl !== lastPersistedRef.current.browser_last_url
      ) {
        patch.browser_last_url = currentUrl;
      }
      if (
        patch.browser_drawer_width === undefined &&
        patch.browser_last_url === undefined
      ) {
        return;
      }
      setBrowserSettings(patch)
        .then(() => {
          lastPersistedRef.current = {
            ...lastPersistedRef.current,
            ...patch,
          };
        })
        .catch((err) =>
          console.debug("[browser-drawer] persist settings failed:", err),
        );
    }, 800);
    return () => window.clearTimeout(timer);
  }, [drawerWidth, currentUrl]);
}
