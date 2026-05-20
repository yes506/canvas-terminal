// Browser-tabs cycle types. Per-tab Chrome-like state.

/**
 * Rect — DOM/CSS-pixel rectangle relative to the parent window.
 * Logical pixels (≡ Tauri 2's `LogicalPosition`/`LogicalSize`);
 * Tauri 2 handles DPR translation internally when forwarded to
 * `Webview::set_bounds`.
 */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * URL-scheme classification result, returned by
 * `classifyScheme(input)`. Tagged union so the UI can show a
 * specific reason on filter/deny without re-parsing the input.
 */
export type SchemeClassification =
  | { action: "allow"; normalizedUrl: string }
  | { action: "filter"; reason: string }
  | { action: "deny"; reason: string };

/**
 * Per-tab state. `history` is owned by the OS-layer WKWebView (not the
 * TS shape) — `browserTabGoBack` / `browserTabGoForward` eval against
 * the live history stack inside that webview.
 */
export interface Tab {
  id: string;
  url: string;
  title: string;
  isLoading: boolean;
  error: string | null;
  /** WKWebView per-tab page zoom (1.0 = 100%). Native sticky across navigations. */
  zoom: number;
}

/**
 * Rust → JS event payloads. Every per-tab event carries `tabId` so
 * frontend subscribers route to the matching Tab in the tabs slice.
 */
export interface BrowserTabLoadingEvent {
  tabId: string;
  url: string;
}
export interface BrowserTabLoadedEvent {
  tabId: string;
  url: string;
}
export interface BrowserTabTitleChangedEvent {
  tabId: string;
  title: string;
}
export interface BrowserTabErrorEvent {
  tabId: string;
  url: string;
  reason: string;
}

/**
 * Frontend state cell for the browser drawer (the Zustand store's
 * snapshot shape). Extended from the prior single-webview shape with
 * a tabs slice. `activeTabId` is `null` only before the very first
 * drawer-open of an app session (cold-start, before
 * `seedInitialTab` runs); once seeded it stays non-null across
 * subsequent drawer close→reopen cycles per the r4 spec amendment.
 */
export interface BrowserState {
  drawerOpen: boolean;
  drawerWidth: number;
  tabs: Tab[];
  activeTabId: string | null;
}

/** Partial-update patch for `set_browser_settings` IPC (unchanged). */
export interface BrowserSettingsPatch {
  browser_drawer_width?: number;
  browser_last_url?: string;
}
