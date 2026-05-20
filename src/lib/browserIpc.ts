import { invoke } from "@tauri-apps/api/core";
import type { Rect, BrowserSettingsPatch } from "../types/browser";

/**
 * Typed wrappers around `invoke` for the browser-tabs IPC surface.
 * Each fn maps 1:1 to a Rust `#[tauri::command]` in
 * `src-tauri/src/commands/browser.rs` (+ `set_browser_settings` in
 * `commands/settings.rs`).
 *
 * Errors bubble up as rejected promises with the Err string from Rust
 * (e.g. "browser tab '<id>' not created",
 * "filter: javascript: URLs blocked"). Callers should catch and
 * surface via the per-tab error field on `BrowserStore`.
 */

export function createBrowserTab(
  tabId: string,
  url: string,
  rect: Rect,
): Promise<void> {
  return invoke<void>("create_browser_tab", { tabId, url, rect });
}

export function setBrowserTabBounds(
  tabId: string,
  rect: Rect,
  visible: boolean,
): Promise<void> {
  return invoke<void>("set_browser_tab_bounds", { tabId, rect, visible });
}

export function navigateBrowserTab(tabId: string, url: string): Promise<void> {
  return invoke<void>("navigate_browser_tab", { tabId, url });
}

export function browserTabGoBack(tabId: string): Promise<void> {
  return invoke<void>("browser_tab_go_back", { tabId });
}

export function browserTabGoForward(tabId: string): Promise<void> {
  return invoke<void>("browser_tab_go_forward", { tabId });
}

export function browserTabReload(tabId: string): Promise<void> {
  return invoke<void>("browser_tab_reload", { tabId });
}

export function browserTabStop(tabId: string): Promise<void> {
  return invoke<void>("browser_tab_stop", { tabId });
}

/**
 * Set the per-tab WKWebView zoom level. Rust clamps `zoom` to
 * `[0.25, 5.0]` as defense-in-depth before forwarding to
 * `Webview::set_zoom`. Native sticky across navigations on macOS 11+.
 */
export function browserTabSetZoom(tabId: string, zoom: number): Promise<void> {
  return invoke<void>("browser_tab_set_zoom", { tabId, zoom });
}

export function destroyBrowserTab(tabId: string): Promise<void> {
  return invoke<void>("destroy_browser_tab", { tabId });
}

export function destroyAllBrowserTabs(): Promise<void> {
  return invoke<void>("destroy_all_browser_tabs");
}

export function setBrowserSettings(patch: BrowserSettingsPatch): Promise<void> {
  return invoke<void>("set_browser_settings", { patch });
}

/**
 * Mint a localfile token bound to (tabId, picked path). Returns a
 * 22-char URL-safe-base64 token the caller embeds in a
 * `localfile://localhost/<token>` URL (C9 path-based shape) and passes
 * to `navigateBrowserTab`.
 *
 * Rejects with the Err string from Rust on any validation failure
 * (`"symlinks rejected"`, `"path under deny-prefix: <prefix>"`,
 * `"canonicalize failed: ..."`, etc.). Callers should catch and
 * surface via the per-tab error field on BrowserStore.
 */
export function mintLocalFileToken(
  tabId: string,
  path: string,
): Promise<string> {
  return invoke<string>("mint_localfile_token", { tabId, path });
}
