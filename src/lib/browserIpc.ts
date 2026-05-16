import { invoke } from "@tauri-apps/api/core";
import type { Rect, BrowserSettingsPatch } from "../types/browser";

/**
 * Typed wrappers around `invoke` for the browser-drawer's IPC surface.
 * Each fn maps 1:1 to a Rust `#[tauri::command]` in
 * `src-tauri/src/commands/browser.rs` (+ set_browser_settings in
 * `commands/settings.rs`).
 *
 * Errors bubble up as rejected promises with the Err string from Rust
 * (e.g. "browser webview not created", "filter: javascript: URLs blocked").
 * Callers should catch and surface via browserStore.setError.
 */

export function createBrowserWebview(url: string, rect: Rect): Promise<void> {
  return invoke<void>("create_browser_webview", { url, rect });
}

export function setBrowserWebviewBounds(rect: Rect): Promise<void> {
  return invoke<void>("set_browser_webview_bounds", { rect });
}

export function navigateBrowser(url: string): Promise<void> {
  return invoke<void>("navigate_browser", { url });
}

export function browserGoBack(): Promise<void> {
  return invoke<void>("browser_go_back");
}

export function browserGoForward(): Promise<void> {
  return invoke<void>("browser_go_forward");
}

export function browserReload(): Promise<void> {
  return invoke<void>("browser_reload");
}

export function browserStop(): Promise<void> {
  return invoke<void>("browser_stop");
}

export function destroyBrowserWebview(): Promise<void> {
  return invoke<void>("destroy_browser_webview");
}

export function setBrowserSettings(patch: BrowserSettingsPatch): Promise<void> {
  return invoke<void>("set_browser_settings", { patch });
}
