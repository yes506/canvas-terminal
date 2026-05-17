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

export function destroyBrowserTab(tabId: string): Promise<void> {
  return invoke<void>("destroy_browser_tab", { tabId });
}

export function destroyAllBrowserTabs(): Promise<void> {
  return invoke<void>("destroy_all_browser_tabs");
}

export function setBrowserSettings(patch: BrowserSettingsPatch): Promise<void> {
  return invoke<void>("set_browser_settings", { patch });
}
