mod commands;
mod dashboard;
mod state;
pub mod worktree;

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
            // E24 — structured logging via `tracing`. Subscriber reads
            // RUST_LOG env (e.g. RUST_LOG=worktree=info). Idempotent —
            // try_init only succeeds the first time; subsequent calls
            // (e.g. test harnesses) are silently no-op. Replaces the
            // ad-hoc eprintln! pattern in heartbeat/monitor/drainer.
            let _ = tracing_subscriber::fmt()
                .with_env_filter(
                    tracing_subscriber::EnvFilter::try_from_default_env()
                        .unwrap_or_else(|_| {
                            tracing_subscriber::EnvFilter::new("warn,worktree=info")
                        }),
                )
                .try_init();

            let menu = build_menu(app)?;
            app.set_menu(menu)?;
            // Remove only stale session directories from dead processes.
            let _ = commands::memory::clear_stale_sessions();

            // F7 (Phase 2 verifier round): wire the worktree reaper
            // into the Tauri runtime. Without this, the reaper module
            // is well-tested but never runs in production. The reaper
            // is started ONLY when a managed root is configured (env
            // var or default user-config path); otherwise the worktree
            // subsystem is dormant per spec §6.1 lazy-acquisition.
            if let Some(root) = worktree::config::resolve_managed_root() {
                if worktree::managed_root::ensure_layout(&root).is_ok() {
                    // B12 — multi-process restart recovery: any lease in
                    // Working/Ready from a prior run has no live supervisor
                    // in this process. Transition them to Draining so the
                    // reaper picks them up immediately on first sweep.
                    let recovery_report = worktree::recovery::adopt_orphan_leases(&root);
                    if recovery_report.adopted > 0 {
                        tracing::info!(
                            target: "worktree::recovery",
                            adopted = recovery_report.adopted,
                            "adopted orphan lease(s) → Draining"
                        );
                    }
                    if !recovery_report.failures.is_empty() {
                        tracing::warn!(
                            target: "worktree::recovery",
                            failures = ?recovery_report.failures,
                            "some orphan leases could not be adopted"
                        );
                    }
                    let reaper = std::sync::Arc::new(
                        worktree::reaper::Reaper::new(root.clone()),
                    );
                    let drainer_root = root.clone();
                    tauri::async_runtime::spawn(async move {
                        let mut tick = tokio::time::interval(
                            std::time::Duration::from_secs(15),
                        );
                        loop {
                            tick.tick().await;
                            // Sweep result is best-effort; errors are
                            // logged via tracing.
                            if let Err(e) = reaper.sweep() {
                                tracing::warn!(
                                    target: "worktree::reaper",
                                    error = %e,
                                    "reaper sweep failed"
                                );
                            }
                        }
                    });

                    // **H3 fix per codex2 #1**: production drainer
                    // sweep loop. Without this, leases in `Draining`
                    // (set by Supervisor monitor on agent exit, by
                    // recovery on Tauri restart, or by the reaper on
                    // wedged/dead claim) never get processed unless
                    // the UI explicitly calls `release_worktree`. Now
                    // a periodic tick runs `Drainer::sweep_draining`
                    // alongside the reaper.
                    tauri::async_runtime::spawn(async move {
                        let drainer = worktree::drainer::Drainer::new(drainer_root);
                        let mut tick = tokio::time::interval(
                            std::time::Duration::from_secs(15),
                        );
                        loop {
                            tick.tick().await;
                            match drainer.sweep_draining() {
                                Ok(report) => {
                                    if !report.failures.is_empty() {
                                        tracing::warn!(
                                            target: "worktree::drainer",
                                            processed = report.processed,
                                            failures = ?report.failures,
                                            "sweep_draining had per-lease failures"
                                        );
                                    } else if report.processed > 0 {
                                        tracing::info!(
                                            target: "worktree::drainer",
                                            processed = report.processed,
                                            "sweep_draining completed"
                                        );
                                    }
                                }
                                Err(e) => {
                                    tracing::warn!(
                                        target: "worktree::drainer",
                                        error = %e,
                                        "sweep_draining errored"
                                    );
                                }
                            }
                        }
                    });
                }
            }

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
            commands::worktree::query_registry,
            commands::worktree::query_lease_by_agent_id,
            commands::worktree::provision_worktree,
            commands::worktree::query_agent_lease,
            commands::worktree::release_worktree,
            commands::worktree::force_close_worktree,
            commands::worktree::retry_preserve,
            commands::worktree::discard_artifact,
            commands::worktree::start_worktree_agent,
            commands::worktree::bulk_close_worktrees,
            commands::worktree::query_audit_log,
            commands::worktree::query_reaper_metrics,
            commands::worktree::query_supervisor_registry,
            commands::worktree::queue_merge,
            commands::worktree::query_merge_state,
            commands::worktree::approve_merge,
            commands::worktree::abort_merge,
            commands::worktree::retry_merge,
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
