use serde::{Deserialize, Serialize};
use std::fs;
use std::io::Write;
use std::os::unix::fs::OpenOptionsExt;
use std::path::PathBuf;
use tauri::Manager;

fn default_auto_check_updates() -> bool {
    true
}

#[derive(Serialize, Deserialize)]
pub struct Settings {
    #[serde(default = "default_auto_check_updates")]
    pub auto_check_updates: bool,
    #[serde(default)]
    pub last_skipped_version: Option<String>,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            auto_check_updates: true,
            last_skipped_version: None,
        }
    }
}

fn settings_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("Cannot resolve app_config_dir: {}", e))?;
    fs::create_dir_all(&dir).map_err(|e| format!("Cannot create config dir: {}", e))?;
    let path = dir.join("settings.json");
    if cfg!(debug_assertions) {
        eprintln!("[settings] resolved path: {}", path.display());
    }
    Ok(path)
}

#[tauri::command]
pub fn get_settings(app: tauri::AppHandle) -> Result<Settings, String> {
    let path = settings_path(&app)?;
    if !path.exists() {
        return Ok(Settings::default());
    }
    let s = fs::read_to_string(&path).map_err(|e| format!("Cannot read settings: {}", e))?;
    serde_json::from_str(&s).map_err(|e| format!("Cannot parse settings: {}", e))
}

/// Open an HTTPS URL on the canvas-terminal GitHub repo in the default browser.
///
/// Defense in depth: only allows HTTPS URLs whose host is github.com. The only
/// call site today is the UpdateBanner's "Open releases page" button when a
/// signature verification fails, so the allowlist is strict on purpose.
#[tauri::command]
pub fn open_external_url(url: String) -> Result<(), String> {
    if !url.starts_with("https://github.com/") {
        return Err("Refused to open non-allowlisted URL".to_string());
    }
    std::process::Command::new("open")
        .arg(&url)
        .spawn()
        .map_err(|e| format!("Failed to open URL: {}", e))?;
    Ok(())
}

#[tauri::command]
pub fn set_settings(app: tauri::AppHandle, settings: Settings) -> Result<(), String> {
    let path = settings_path(&app)?;
    let json = serde_json::to_string_pretty(&settings)
        .map_err(|e| format!("Cannot serialize settings: {}", e))?;

    // O_NOFOLLOW so a symlink at the target path doesn't redirect us. Settings is
    // a fixed path the user never chooses, so unlike canvas.rs we don't need full
    // canonicalize+boundary validation.
    let mut f = fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .custom_flags(libc::O_NOFOLLOW)
        .open(&path)
        .map_err(|e| format!("Cannot open settings file: {}", e))?;
    f.write_all(json.as_bytes())
        .map_err(|e| format!("Cannot write settings: {}", e))?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Cross-restart persistence (claude2 task-103 critical fix)
// ---------------------------------------------------------------------------
//
// The existing `commands::memory` module writes to a per-PID session dir
// (`~/.cache/canvas-terminal/collab-memory/session-<PID>/`) and runs
// `clear_stale_sessions()` at app startup which deletes all dirs whose
// owning PID is no longer alive. That makes it unsuitable for state
// that needs to survive restarts (LB3 ack persistence, future global
// policy state).
//
// These commands target `app_config_dir()` instead, matching the
// existing `settings.json` pattern. On macOS this resolves to
// `~/Library/Application Support/canvas-terminal/`, on Linux to
// `~/.config/canvas-terminal/`, and on Windows to
// `%APPDATA%\canvas-terminal\`. None of those are touched by the
// session-cleanup pass.

/// Validate a relative path used by app-config persistence. Same shape
/// as the memory module's validator: must be relative, no traversal,
/// no leading slash, no `..`, no NUL.
fn validate_app_config_relative_path(p: &str) -> Result<(), String> {
    if p.is_empty() {
        return Err("relative path is empty".to_string());
    }
    if p.starts_with('/') {
        return Err("relative path must not start with '/'".to_string());
    }
    if p.contains("..") {
        return Err("relative path must not contain '..'".to_string());
    }
    if p.contains('\0') {
        return Err("relative path must not contain NUL".to_string());
    }
    Ok(())
}

fn app_config_file_path(app: &tauri::AppHandle, relative_path: &str) -> Result<PathBuf, String> {
    validate_app_config_relative_path(relative_path)?;
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("Cannot resolve app_config_dir: {}", e))?;
    fs::create_dir_all(&dir).map_err(|e| format!("Cannot create config dir: {}", e))?;
    Ok(dir.join(relative_path))
}

/// Read a file from the app config dir. Returns `None` when the file
/// doesn't exist (matches `read_memory_file`'s shape so callers can
/// share the same null-handling). Reads up to 4 MiB; errors out for
/// pathologically large files (defense in depth — the only intended
/// caller is the LB3 acks file, which should be a few KB at most).
#[tauri::command]
pub fn read_app_config_file(
    app: tauri::AppHandle,
    relative_path: String,
) -> Result<Option<String>, String> {
    let path = app_config_file_path(&app, &relative_path)?;
    if !path.exists() {
        return Ok(None);
    }
    let metadata = fs::metadata(&path).map_err(|e| e.to_string())?;
    if metadata.len() > 4 * 1024 * 1024 {
        return Err(format!(
            "App config file too large: {} bytes",
            metadata.len()
        ));
    }
    fs::read_to_string(&path)
        .map(Some)
        .map_err(|e| e.to_string())
}

/// Write content to a file in the app config dir. Atomic-ish: writes
/// to a unique `<name>.tmp.<pid>.<nanos>` sibling then renames over
/// the target so a crash mid-write doesn't truncate the existing file.
///
/// Round-25 P5 polish (claude2 task-118 carry-over: cross-process
/// tmp-file race + claude3 task-117 O2: fsync hardening):
///
/// 1. **Unique per (process, nanos) tmp name**: prevents two
///    concurrent canvas-terminal processes from corrupting each
///    other's tmp file. Without this, both processes would open the
///    same `<name>.tmp` with O_TRUNC and interleave writes.
///
/// 2. **fsync(tmp) before rename**: ensures the tmp file's content
///    is durable on disk before publication. Without this, a system
///    crash between rename and OS-buffer-flush could publish empty
///    or partial content.
///
/// 3. **fsync(parent dir) after rename**: ensures the rename's
///    metadata change is durable. Without this, a crash could lose
///    the rename even though the tmp file content was fsynced.
///    Best-effort — failure is logged via `let _` because the
///    rename succeeded and the data is durable on the tmp file's
///    inode at minimum.
///
/// O_NOFOLLOW on the tmp file open protects against symlink
/// redirection at the temp target. The rename target inherits any
/// symlink at `path` from the parent directory; that's outside the
/// scope of this function (settings_path/app_config_dir is owned by
/// Tauri).
#[tauri::command]
pub fn write_app_config_file(
    app: tauri::AppHandle,
    relative_path: String,
    content: String,
) -> Result<(), String> {
    let path = app_config_file_path(&app, &relative_path)?;
    // Round-25: unique tmp name per (process, nanosecond) so two
    // concurrent canvas-terminal processes don't race on the same
    // tmp file. Pattern mirrors `commands::memory::write_memory_
    // file_atomic`.
    let pid = std::process::id();
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let tmp_path = path.with_extension(format!(
        "{}.tmp.{}.{}",
        path.extension().and_then(|s| s.to_str()).unwrap_or("dat"),
        pid,
        nanos,
    ));
    {
        // Round-26 P5 (codex1 round-13 #4): use `create_new(true)`
        // instead of `create(true).truncate(true)` so the OS
        // ENFORCES tmp-file uniqueness via O_EXCL. PID+nanos already
        // makes collision practically negligible, but `create_new`
        // turns the negligible-probability assumption into a hard
        // invariant: if the unique tmp path somehow exists from a
        // prior crashed process or stale dir contents, the write
        // surfaces as an error rather than silently appending to /
        // truncating someone else's content.
        let mut f = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .custom_flags(libc::O_NOFOLLOW)
            .open(&tmp_path)
            .map_err(|e| format!("Cannot open temp file: {}", e))?;
        f.write_all(content.as_bytes())
            .map_err(|e| format!("Cannot write temp file: {}", e))?;
        // Round-25: fsync the tmp file before rename so the content
        // is durable on disk before publication.
        f.sync_all()
            .map_err(|e| format!("Cannot fsync temp file: {}", e))?;
    }
    fs::rename(&tmp_path, &path).map_err(|e| format!("Cannot rename temp file: {}", e))?;
    // Round-25: best-effort fsync of the parent dir so the rename's
    // metadata change is durable. Failure here is non-fatal — the
    // rename has already succeeded at the OS level and the data is
    // safe on the tmp file's inode.
    if let Some(parent) = path.parent() {
        if let Ok(dir) = fs::File::open(parent) {
            let _ = dir.sync_all();
        }
    }
    Ok(())
}
