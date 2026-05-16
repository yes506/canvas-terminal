import type { Rect, BrowserSettingsPatch } from "../types/browser";

/**
 * Typed wrapper interface around `@tauri-apps/api/core::invoke`
 * for the browser-drawer's IPC surface. The 10 Phase-3 commands
 * are enumerated here so TS callers don't pass loose `invoke` args.
 *
 * Implementation is downstream — this file is the interface
 * skeleton emitted at Phase 5.
 */

export interface BrowserIpc {
  /**
   * Responsibility: Create the singleton browser child webview
   * overlaid on the main window's DOM rect.
   *
   * Pipeline-position:
   *   useBrowserLifecycle.createOnOpen → THIS → (Rust)
   *   commands::browser::create_browser_webview → on success,
   *   on_page_load / on_document_title_changed / on_navigation
   *   callbacks are installed.
   *
   * Inputs:
   *   - url: string — initial URL. Must have already passed
   *     `classifyScheme` → "allow" on the frontend; Rust-side
   *     `validate_browser_url` re-validates (defense-in-depth).
   *   - rect: Rect — initial OS-layer position+size (logical px).
   *
   * Outputs: Promise<void> — resolves on successful slot
   *   transition Empty → Creating → Ready(webview); rejects on
   *   URL validation failure or slot-already-occupied.
   *
   * Side-effects: Creates one OS-layer webview, installs three
   *   Rust-side callbacks, writes the handle into BrowserSlot.
   *   Network: implicit (the webview begins loading `url`).
   *
   * Preconditions: BrowserSlot is currently Empty (otherwise the
   *   Rust slot-reservation rejects with "browser webview already
   *   exists"). `url` is a string the user has typed or come from
   *   persisted settings.
   *
   * Postconditions: BrowserSlot becomes Ready(webview). The
   *   webview begins async-loading `url`. Nav-state events
   *   (browser-loading then browser-loaded) follow.
   *
   * Failure-modes:
   *   - Promise rejects with "browser webview already exists" if
   *     the slot is Creating or Ready.
   *   - Promise rejects with the validate_browser_url Err string
   *     ("filter:...", "deny:...") if the URL fails Rust policy.
   *   - Promise rejects with Tauri-layer build errors if
   *     `Window::add_child` fails (e.g., the `unstable` feature
   *     is not enabled — caught at compile-time normally, but
   *     surfaced at runtime if a downstream change breaks it).
   *
   * Collaborators: Rust commands::browser::create_browser_webview
   *   (transitively: validate_browser_url, BrowserStateOps::
   *   try_reserve_for_create, finalize).
   */
  createBrowserWebview(url: string, rect: Rect): Promise<void>;

  /**
   * Responsibility: Update the OS-layer webview's bounds to match
   * the current DOM rect of the page-area host.
   *
   * Pipeline-position:
   *   useBrowserBounds.syncBounds (rAF-debounced) → THIS → (Rust)
   *   commands::browser::set_browser_webview_bounds → dedup-check
   *   against last_bounds → Webview::set_bounds.
   *
   * Inputs:
   *   - rect: Rect — target bounds in CSS / logical pixels.
   *
   * Outputs: Promise<void> — resolves after Rust's dedup-check
   *   and (if not skipped) the OS-layer set_bounds call.
   *
   * Side-effects: Moves/resizes the OS-layer webview surface.
   *   On dedup hit (rect === last_bounds), no OS call is made.
   *
   * Preconditions: BrowserSlot is Ready (clone_webview returns
   *   Some). If Empty/Creating, the Rust command returns Err
   *   immediately.
   *
   * Postconditions: The webview's logical-pixel rect equals `rect`
   *   (Tauri 2 handles DPR scaling internally). last_bounds cache
   *   is updated.
   *
   * Failure-modes:
   *   - Rejects with "browser webview not created" if slot is not
   *     Ready.
   *   - Tauri-layer errors from Webview::set_bounds (rare).
   *
   * Collaborators: commands::browser::set_browser_webview_bounds,
   *   BrowserStateOps::clone_webview, last_bounds Mutex.
   */
  setBrowserWebviewBounds(rect: Rect): Promise<void>;

  /**
   * Responsibility: Navigate the browser webview to a new URL.
   *
   * Pipeline-position:
   *   AddressBar.handleSubmit (after classifyScheme=allow) → THIS
   *   → (Rust) commands::browser::navigate_browser →
   *   validate_browser_url → Webview::navigate → on_page_load
   *   callback emits browser-loading/-loaded events.
   *
   * Inputs:
   *   - url: string — already classified ALLOW by frontend
   *     classifyScheme; Rust re-validates.
   *
   * Outputs: Promise<void> — resolves when the navigate IPC is
   *   issued (NOT when the page finishes loading; that's signaled
   *   by `browser-loaded` event back-channel).
   *
   * Side-effects: Triggers webview navigation. Network I/O begins
   *   asynchronously. The Webview history stack is extended.
   *
   * Preconditions: BrowserSlot is Ready. `url` parses to a valid
   *   URL with an allowed scheme.
   *
   * Postconditions: The webview begins loading `url`. browser-
   *   loading event fires within milliseconds.
   *
   * Failure-modes:
   *   - Rejects with validate_browser_url Err if Rust policy fails
   *     (defense-in-depth even after frontend allow).
   *   - Rejects with "browser webview not created" if not Ready.
   *   - URL parse errors surface as Err("invalid URL: ...").
   *
   * Collaborators: validate_browser_url, BrowserStateOps::
   *   clone_webview, Webview::navigate.
   */
  navigateBrowser(url: string): Promise<void>;

  /**
   * Responsibility: Trigger `window.history.back()` inside the
   * browser webview.
   *
   * Pipeline-position:
   *   NavControls (back button click) → THIS → (Rust)
   *   commands::browser::browser_go_back → Webview::eval
   *   ("window.history.back()") → fire-and-forget async.
   *
   * Inputs: None.
   *
   * Outputs: Promise<void> — resolves after the IPC dispatch.
   *   Does NOT await the resulting navigation; if back is at the
   *   history boundary, the call is a no-op in the webview.
   *
   * Side-effects: May trigger navigation in the webview (the
   *   resulting load fires `browser-loading` then `browser-loaded`
   *   events back to JS).
   *
   * Preconditions: BrowserSlot is Ready.
   *
   * Postconditions: An async JS eval has been dispatched to the
   *   webview. Cannot wait for completion (Tauri 2 `eval` is
   *   fire-and-forget; the response is not returned to Rust).
   *
   * Failure-modes: Rejects with "browser webview not created" if
   *   slot is not Ready. Tauri-layer eval-dispatch errors (rare).
   *
   * Collaborators: BrowserStateOps::clone_webview, Webview::eval.
   */
  browserGoBack(): Promise<void>;

  /**
   * Responsibility: Trigger `window.history.forward()` inside the
   * browser webview.
   *
   * Pipeline-position: Same shape as browserGoBack.
   *
   * Inputs: None.
   * Outputs: Promise<void> — same fire-and-forget shape as back.
   * Side-effects: Same as back.
   * Preconditions: BrowserSlot is Ready.
   * Postconditions: Async JS eval dispatched.
   * Failure-modes: Same as back.
   * Collaborators: Same as back.
   */
  browserGoForward(): Promise<void>;

  /**
   * Responsibility: Reload the current page in the browser
   * webview.
   *
   * Pipeline-position:
   *   NavControls (reload button) → THIS → (Rust)
   *   commands::browser::browser_reload → Webview::reload.
   *
   * Inputs: None.
   *
   * Outputs: Promise<void> — resolves after Rust dispatches the
   *   reload call.
   *
   * Side-effects: Triggers a fresh GET to the current URL. Network
   *   I/O begins; nav-event back-channel emits browser-loading.
   *
   * Preconditions: BrowserSlot is Ready.
   *
   * Postconditions: The webview begins reloading. Loading state
   *   re-asserts via the event back-channel.
   *
   * Failure-modes: Rejects with "browser webview not created" if
   *   slot is not Ready. Tauri layer errors (rare).
   *
   * Collaborators: BrowserStateOps::clone_webview, Webview::reload.
   */
  browserReload(): Promise<void>;

  /**
   * Responsibility: Stop the current page load in the browser
   * webview (equivalent to clicking the browser's stop button).
   *
   * Pipeline-position:
   *   NavControls (stop button) → THIS → (Rust)
   *   commands::browser::browser_stop → Webview::eval
   *   ("window.stop()").
   *
   * Inputs: None.
   *
   * Outputs: Promise<void> — resolves after IPC dispatch.
   *
   * Side-effects: Aborts the current page load. May leave the
   *   page in a partially-rendered state.
   *
   * Preconditions: BrowserSlot is Ready.
   *
   * Postconditions: Async JS eval dispatched. browser-loaded
   *   event does NOT fire (load is aborted); next nav-event fires
   *   when the user navigates again.
   *
   * Failure-modes: Rejects with "browser webview not created" if
   *   slot is not Ready.
   *
   * Collaborators: BrowserStateOps::clone_webview, Webview::eval.
   */
  browserStop(): Promise<void>;

  /**
   * Responsibility: Destroy the browser child webview and
   * transition BrowserSlot Ready → Empty.
   *
   * Pipeline-position:
   *   useBrowserLifecycle.destroyOnClose (drawer-close half) OR
   *   lib.rs RunEvent::Exit handler (app-quit half) → (both call)
   *   commands::browser::destroy_browser_webview → impl helper →
   *   BrowserStateOps::take_webview → Webview::close.
   *
   * Inputs: None.
   *
   * Outputs: Promise<void> — resolves after `Webview::close()`
   *   returns on the Rust side.
   *
   * Side-effects: Destroys the OS-layer webview surface; the
   *   handle is dropped (reference count decremented). Cookies/
   *   localStorage persist via the engine profile (Phase 1 Q6).
   *
   * Preconditions: None — calling on an Empty slot is a no-op
   *   that returns Ok(()).
   *
   * Postconditions: BrowserSlot is Empty. The webview surface is
   *   gone. No more nav-events will fire from this instance.
   *
   * Failure-modes: Tauri-layer close errors (rare); slot was
   *   already Empty (returns Ok). Idempotent.
   *
   * Collaborators: BrowserStateOps::take_webview, Webview::close.
   */
  destroyBrowserWebview(): Promise<void>;

  /**
   * Responsibility: Partially update the persisted settings file
   * with browser-drawer fields, serialized against the existing
   * `set_settings` writer via the AppState.settings_io_lock.
   *
   * Pipeline-position:
   *   useBrowserLifecycle.persistSettings (debounced) → THIS →
   *   (Rust) commands::settings::set_browser_settings → acquire
   *   settings_io_lock → read settings.json → merge browser fields
   *   → write settings.json → release lock.
   *
   * Inputs:
   *   - patch: BrowserSettingsPatch — at least one of
   *     `browser_drawer_width` (Option<u32>) or `browser_last_url`
   *     (Option<String>) should be set. Unset fields are NOT
   *     written.
   *
   * Outputs: Promise<void> — resolves after the file write
   *   completes and the lock is released.
   *
   * Side-effects: One read + one write of `app_config_dir/
   *   settings.json`. Holds settings_io_lock for the full
   *   read-modify-write cycle.
   *
   * Preconditions: AppState.settings_io_lock is registered in the
   *   Tauri app's managed state. NOTE (Phase-5 Round-1 codex2 P2):
   *   Phase 5 skeleton only DOCUMENTS this requirement; the field
   *   itself is materialized during implementation (per
   *   `.planner-state.json::implementation_prerequisites::
   *   state_types_to_materialize`).
   *
   * Postconditions: The two browser fields in settings.json
   *   reflect the patch values; other fields (auto_check_updates,
   *   last_skipped_version) are preserved unchanged. The file is
   *   atomically replaced (write-temp-and-rename is the
   *   recommended downstream implementation, but Phase-3 doesn't
   *   commit to it).
   *
   * Failure-modes:
   *   - Rejects on settings.json read errors (file missing,
   *     malformed JSON, permission denied).
   *   - Rejects on write errors (disk full, permission denied).
   *
   * Collaborators: AppState.settings_io_lock,
   *   commands::settings::Settings struct, std::fs.
   */
  setBrowserSettings(patch: BrowserSettingsPatch): Promise<void>;
}
