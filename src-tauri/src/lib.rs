mod commands;
mod state;

use state::AppState;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{Emitter, Manager};

/// Build a custom app menu that maps Cmd+W to "Close Tab" instead of the
/// default "Close Window".  This prevents the native menu from closing the
/// entire Tauri window when the user presses Cmd+W.
fn build_menu(app: &tauri::App) -> Result<Menu<tauri::Wry>, tauri::Error> {
    let app_menu = Submenu::with_items(
        app,
        "Canvas Terminal",
        true,
        &[
            &PredefinedMenuItem::about(app, None, None)?,
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

    let window_menu = Submenu::with_items(
        app,
        "Window",
        true,
        &[
            &PredefinedMenuItem::minimize(app, None)?,
            &PredefinedMenuItem::maximize(app, None)?,
        ],
    )?;

    Menu::with_items(app, &[&app_menu, &file_menu, &edit_menu, &window_menu])
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState::new())
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
            commands::memory::read_memory_file,
            commands::memory::delete_memory_file,
            commands::memory::clear_memory_dir,
            commands::memory::list_memory_files,
            commands::memory::get_memory_file_mtime,
        ])
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
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
