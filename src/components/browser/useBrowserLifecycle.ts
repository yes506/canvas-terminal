import { useEffect, useRef, RefObject } from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import {
  createBrowserWebview,
  destroyBrowserWebview,
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

/**
 * Drawer lifecycle: create-on-open, destroy-on-close, subscribe to nav-event
 * back-channel, subscribe to the menu-toggle accelerator. Phase-3 nodes
 * #18–#22.
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
          // Don't navigate yet — only seed currentUrl so create-on-open uses it.
          setCurrentUrl(s.browser_last_url);
        }
        lastPersistedRef.current = {
          browser_drawer_width: s.browser_drawer_width,
          browser_last_url: s.browser_last_url,
        };
      })
      .catch((err) => console.debug("[browser-drawer] get_settings failed:", err));
  }, [setDrawerWidth, setCurrentUrl]);

  // Nav-event back-channel subscription.
  useEffect(() => {
    const unlistens: Array<() => void> = [];
    listen<BrowserLoadingEvent>("browser-loading", (e) => {
      setLoading(true);
      setCurrentUrl(e.payload.url);
      setError(null);
    }).then((fn) => unlistens.push(fn));
    listen<BrowserLoadedEvent>("browser-loaded", (e) => {
      setLoading(false);
      setCurrentUrl(e.payload.url);
    }).then((fn) => unlistens.push(fn));
    listen<BrowserTitleChangedEvent>("browser-title-changed", (e) => {
      setPageTitle(e.payload.title);
    }).then((fn) => unlistens.push(fn));
    listen<BrowserErrorEvent>("browser-error", (e) => {
      setError(e.payload.reason);
      setLoading(false);
    }).then((fn) => unlistens.push(fn));
    return () => unlistens.forEach((fn) => fn());
  }, [setLoading, setCurrentUrl, setPageTitle, setError]);

  // Menu-toggle subscription (the native-menu accelerator path).
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    listen("menu-toggle-browser", () => toggle()).then(
      (fn) => (unlisten = fn),
    );
    return () => unlisten?.();
  }, [toggle]);

  // create-on-open / destroy-on-close. Depends on drawerOpen and the host
  // ref's existence (the rect can't be measured until React has mounted the
  // PageAreaHost).
  const previousOpenRef = useRef(false);
  useEffect(() => {
    if (drawerOpen === previousOpenRef.current) return;
    previousOpenRef.current = drawerOpen;

    if (drawerOpen) {
      // Wait one frame so PageAreaHost has been laid out, then measure
      // and create the webview.
      const handle = window.requestAnimationFrame(async () => {
        const host = hostRef.current;
        if (!host) return;
        const r = host.getBoundingClientRect();
        const rect: Rect = {
          x: r.left,
          y: r.top,
          width: r.width,
          height: r.height,
        };
        if (rect.width <= 0 || rect.height <= 0) return;

        const initialUrl = currentUrl || "about:blank";
        try {
          await createBrowserWebview(initialUrl, rect);
          setError(null);
        } catch (err) {
          // Could be "browser webview already exists" if a previous destroy
          // didn't complete; surface but continue.
          const msg = err instanceof Error ? err.message : String(err);
          setError(msg);
        }
      });
      return () => window.cancelAnimationFrame(handle);
    } else {
      destroyBrowserWebview().catch((err) =>
        console.debug("[browser-drawer] destroy on close failed:", err),
      );
    }
  }, [drawerOpen, hostRef, currentUrl, setError]);

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
