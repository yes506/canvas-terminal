mod commands;
mod dashboard;
mod state;

// Re-export the TranscriptAdapter contract surface so external tests
// (e.g. `tests/transcript_adapter_contract.rs`) can implement the trait
// without needing `commands` itself to be `pub`. Per claude3 r4 I1
// recommendation (c): minimal visibility surface change — only the named
// types become public to the crate's external API.
pub use commands::transcripts::{
    ContentBlockTable, DiscoveryError, NormalizeContext, NormalizedTurn, RawTurn,
    TranscriptAdapter, TranscriptHandle,
};

use std::sync::atomic::Ordering;

use dashboard::DashboardInfo;
use state::AppState;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{Emitter, Manager, RunEvent};

/// Build a custom app menu that maps Cmd+W to "Close Tab" instead of the
/// default "Close Window".  This prevents the native menu from closing the
/// entire Tauri window when the user presses Cmd+W.
fn build_menu(app: &tauri::App) -> Result<Menu<tauri::Wry>, tauri::Error> {
    let check_for_updates = MenuItem::with_id(
        app,
        "check_for_updates",
        "Check for Updates…",
        true,
        None::<&str>,
    )?;
    let app_menu = Submenu::with_items(
        app,
        "Canvas Terminal",
        true,
        &[
            &PredefinedMenuItem::about(app, None, None)?,
            &check_for_updates,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::hide(app, None)?,
            &PredefinedMenuItem::hide_others(app, None)?,
            &PredefinedMenuItem::show_all(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::quit(app, None)?,
        ],
    )?;

    // "Close Tab" replaces the default "Close Window" (Cmd+W)
    let close_tab = MenuItem::with_id(app, "close_tab", "Close Tab", true, Some("CmdOrCtrl+W"))?;
    let file_menu = Submenu::with_items(app, "File", true, &[&close_tab])?;

    let edit_menu = Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &PredefinedMenuItem::undo(app, None)?,
            &PredefinedMenuItem::redo(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &PredefinedMenuItem::select_all(app, None)?,
        ],
    )?;

    let open_dashboard = MenuItem::with_id(
        app,
        "open_dashboard",
        "Open Dashboard",
        true,
        Some("CmdOrCtrl+Shift+D"),
    )?;
    let toggle_browser = MenuItem::with_id(
        app,
        "toggle_browser",
        "Toggle Browser",
        true,
        Some("CmdOrCtrl+Shift+B"),
    )?;
    let window_menu = Submenu::with_items(
        app,
        "Window",
        true,
        &[
            &PredefinedMenuItem::minimize(app, None)?,
            &PredefinedMenuItem::maximize(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &open_dashboard,
            &toggle_browser,
        ],
    )?;

    Menu::with_items(app, &[&app_menu, &file_menu, &edit_menu, &window_menu])
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(AppState::new())
        .manage(DashboardInfo::new())
        .manage(state::BrowserTabsState::<tauri::Wry>::new())
        .manage(state::LocalFileTokenRegistry::new())
        // Peer-context-mirror: TranscriptWatcher is single-instance per app
        // per Q5; constructed dormant. start_if_needed lazily promotes it
        // (first opt-in publish) so no FSEvents thread spins up on cold
        // launches that don't use the feature. Shutdown lives in
        // WindowEvent::Destroyed (primary) + RunEvent::Exit (defensive)
        // below, matching the W1 lifecycle wording.
        .manage(commands::transcripts::TranscriptWatcher::new())
        .register_asynchronous_uri_scheme_protocol(
            "localfile",
            commands::localfile::localfile_protocol_handler,
        )
        .setup(|app| {
            let menu = build_menu(app)?;
            app.set_menu(menu)?;
            // Remove only stale session directories from dead processes.
            let _ = commands::memory::clear_stale_sessions();
            Ok(())
        })
        .on_menu_event(|app, event| {
            if event.id() == "close_tab" {
                // Forward to the frontend so it can close the active tab
                let _ = app.emit("menu-close-tab", ());
            } else if event.id() == "check_for_updates" {
                // Frontend listens and runs a manual update check
                let _ = app.emit("menu-check-for-updates", ());
            } else if event.id() == "open_dashboard" {
                // Frontend listens and calls invoke('open_dashboard')
                let _ = app.emit("menu-open-dashboard", ());
            } else if event.id() == "toggle_browser" {
                // Frontend listens and calls browserStore.toggle()
                let _ = app.emit("menu-toggle-browser", ());
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::pty::bootstrap_env,
            commands::pty::spawn_shell,
            commands::pty::spawn_process,
            commands::pty::write_to_pty,
            commands::pty::resize_pty,
            commands::pty::kill_pty,
            commands::pty::get_pty_cwd,
            commands::pty::inject_into_pty,
            commands::pty::list_directory,
            commands::canvas::save_canvas,
            commands::canvas::load_canvas,
            commands::canvas::read_image_as_data_url,
            commands::canvas::read_document_as_base64,
            commands::canvas::save_binary_file,
            commands::canvas::export_snapshot,
            commands::capture::capture_main_window_png,
            commands::canvas::check_import_file,
            commands::canvas::read_import_file,
            commands::canvas::cleanup_import_file,
            commands::memory::get_memory_session_dir,
            commands::memory::write_memory_file,
            commands::memory::write_memory_file_atomic,
            commands::memory::read_memory_file,
            commands::memory::delete_memory_file,
            commands::memory::clear_memory_dir,
            commands::memory::list_memory_files,
            commands::memory::get_memory_file_mtime,
            commands::settings::get_settings,
            commands::settings::set_settings,
            commands::settings::set_browser_settings,
            commands::settings::open_external_url,
            commands::dashboard::open_dashboard,
            commands::dashboard::get_dashboard_info,
            commands::dashboard::copy_dashboard_url_with_token,
            commands::browser::create_browser_tab,
            commands::browser::set_browser_tab_bounds,
            commands::browser::navigate_browser_tab,
            commands::browser::browser_tab_go_back,
            commands::browser::browser_tab_go_forward,
            commands::browser::browser_tab_reload,
            commands::browser::browser_tab_stop,
            commands::browser::browser_tab_set_zoom,
            commands::browser::destroy_browser_tab,
            commands::browser::destroy_all_browser_tabs,
            commands::localfile::mint_localfile_token,
            commands::transcripts::watch_transcript,
            commands::transcripts::unwatch_transcript,
        ])
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                // SESSION_ALIVE = false is the FIRST statement of the destroy
                // arm (v4 §3.4 / v5 §3.6) — it MUST run before any cleanup so
                // the dashboard server's in-flight handlers see "session
                // ended" instead of racing partial filesystem deletion.
                if let Some(info) = window.try_state::<DashboardInfo>() {
                    info.session_alive.store(false, Ordering::SeqCst);
                    // Trigger graceful shutdown of the axum server if it is
                    // running. We use try_lock instead of lock to avoid
                    // blocking the destroy closure on a contended mutex —
                    // if a Tauri command (open_dashboard etc.) is currently
                    // mid-await holding the Mutex, try_lock returns Err and
                    // the notify_waiters() call is silently skipped. In that
                    // case the axum server is killed by process exit
                    // (graceful shutdown becomes ungraceful but still
                    // happens). Acceptable for MVP because process exit
                    // follows main-window destroy on macOS; revisit if the
                    // app ever supports multi-window where window-destroy
                    // ≠ process-exit.
                    if let Ok(guard) = info.running.try_lock() {
                        if let Some(running) = guard.as_ref() {
                            running.shutdown.notify_waiters();
                        }
                    }
                }

                // Main window destroyed — full cleanup
                if let Some(state) = window.try_state::<AppState>() {
                    if let Ok(mut sessions) = state.sessions.lock() {
                        sessions.clear();
                    }
                }
                // Browser tabs: defensive cleanup on window-destroy. On
                // macOS, the red traffic-light close fires
                // WindowEvent::Destroyed but NOT RunEvent::Exit (app
                // stays alive in the dock). Without this, BrowserTabsState
                // would hold dead webview handles until app-quit. F8
                // requires the localfile registry be cleared at the same
                // point so no stale token-to-path mappings survive.
                if let (Some(browser_state), Some(localfile_registry)) = (
                    window.try_state::<state::BrowserTabsState<tauri::Wry>>(),
                    window.try_state::<state::LocalFileTokenRegistry>(),
                ) {
                    let _ = commands::browser::destroy_all_browser_tabs_impl(
                        &browser_state,
                        &localfile_registry,
                    );
                }
                // Clean up temporary canvas files
                let _ = commands::canvas::cleanup_snapshot();
                let _ = commands::canvas::cleanup_import_file(None);
                // Peer-context-mirror: tear down the transcript watcher
                // (drop notify::RecommendedWatcher → stops FSEvents thread;
                // invalidate outstanding WatchTokens; clear entries +
                // parent_dir_refs). Primary teardown site per W1.
                if let Some(tw) = window.try_state::<commands::transcripts::TranscriptWatcher>() {
                    tw.shutdown();
                }
                // Wipe shared collaborator memory on window close. This is
                // the process-wide wipe (every collab session's subtree at
                // once) — the scoped IPC `clear_memory_dir(collab_session_id)`
                // only ever clears one session subtree.
                let _ = commands::memory::clear_process_memory_root();
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            if let RunEvent::Exit = event {
                // App-quit cleanup: destroy every browser tab webview that
                // may still be open + clear the localfile token registry
                // (F8). JS useEffect cleanup isn't reliable on hard quit;
                // this is the Rust-side tear-down.
                let browser_state =
                    app_handle.state::<state::BrowserTabsState<tauri::Wry>>();
                let localfile_registry =
                    app_handle.state::<state::LocalFileTokenRegistry>();
                let _ = commands::browser::destroy_all_browser_tabs_impl(
                    &browser_state,
                    &localfile_registry,
                );
                // Peer-context-mirror: defensive shutdown for hard-quit
                // paths where WindowEvent::Destroyed didn't fire (e.g.
                // macOS Cmd-Q without traffic-light close first).
                // shutdown() is idempotent so the double-call from both
                // teardown hooks is safe.
                let tw = app_handle.state::<commands::transcripts::TranscriptWatcher>();
                tw.shutdown();
            }
        });
}
