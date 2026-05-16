// Phase 5 interface skeleton — emitted by codebase-planner on
// 2026-05-17 for feature `browser-drawer`. Implementation must
// preserve every method's 9-field docstring and the type shapes.

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

/** Browser nav-event payloads, emitted from Rust → JS. */
export interface BrowserLoadingEvent {
  url: string;
}
export interface BrowserLoadedEvent {
  url: string;
}
export interface BrowserTitleChangedEvent {
  title: string;
}
export interface BrowserErrorEvent {
  url: string;
  reason: string;
}

/**
 * Frontend state cell for the browser drawer (the Zustand store's
 * snapshot shape). Public API surface for components subscribing
 * via selectors.
 */
export interface BrowserState {
  drawerOpen: boolean;
  drawerWidth: number;
  currentUrl: string;
  pageTitle: string;
  isLoading: boolean;
  error: string | null;
}

/** Partial-update patch for `set_browser_settings` IPC. */
export interface BrowserSettingsPatch {
  browser_drawer_width?: number;
  browser_last_url?: string;
}
