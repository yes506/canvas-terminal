mod commands;
mod dashboard;
mod state;

use std::sync::atomic::Ordering;

use dashboard::DashboardInfo;
use state::AppState;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{Emitter, Manager};

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
    let window_menu = Submenu::with_items(
        app,
        "Window",
        true,
        &[
            &PredefinedMenuItem::minimize(app, None)?,
            &PredefinedMenuItem::maximize(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &open_dashboard,
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
            commands::canvas::check_import_file,
            commands::canvas::read_import_file,
            commands::canvas::cleanup_import_file,
            commands::memory::init_memory_dir,
            commands::memory::write_memory_file,
            commands::memory::write_memory_file_atomic,
            commands::memory::read_memory_file,
            commands::memory::delete_memory_file,
            commands::memory::clear_memory_dir,
            commands::memory::list_memory_files,
            commands::memory::get_memory_file_mtime,
            commands::settings::get_settings,
            commands::settings::set_settings,
            commands::settings::open_external_url,
            commands::dashboard::open_dashboard,
            commands::dashboard::get_dashboard_info,
            commands::dashboard::copy_dashboard_url_with_token,
            // Worktree-isolation policy P1 backend (v5.1 implementation kickoff)
            commands::git::git_detect_repo,
            commands::git::git_worktree_create,
            commands::git::git_worktree_remove,
            commands::git::git_branch_force_delete,
            commands::git::git_worktree_list,
            commands::git::git_worktree_status,
            commands::git::git_diff_summary,
            commands::git::compute_worktree_path,
            // Worktree-isolation policy P2 backend — orchestrator-owned
            // approval commit + merge with file-lock + structured GitError
            commands::git::git_create_approval_commit,
            commands::git::git_merge_worktree,
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
                // Clean up temporary canvas files
                let _ = commands::canvas::cleanup_snapshot();
                let _ = commands::canvas::cleanup_import_file(None);
                // Wipe shared collaborator memory on window close
                let _ = commands::memory::clear_memory_dir();
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
