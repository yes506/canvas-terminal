use serde::{Deserialize, Serialize};
use std::fs;
use std::io::Write;
use std::os::unix::fs::OpenOptionsExt;
use std::path::PathBuf;
use tauri::Manager;

use crate::state::AppState;

fn default_auto_check_updates() -> bool {
    true
}

#[derive(Serialize, Deserialize)]
pub struct Settings {
    #[serde(default = "default_auto_check_updates")]
    pub auto_check_updates: bool,
    #[serde(default)]
    pub last_skipped_version: Option<String>,
    /// Persisted browser-drawer width in CSS/logical pixels. None means
    /// "use default 35% on first launch".
    #[serde(default)]
    pub browser_drawer_width: Option<u32>,
    /// Persisted last URL the browser drawer was on. None means "load
    /// about:blank on first open".
    #[serde(default)]
    pub browser_last_url: Option<String>,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            auto_check_updates: true,
            last_skipped_version: None,
            browser_drawer_width: None,
            browser_last_url: None,
        }
    }
}

/// Partial patch for the browser-drawer fields only. `None` fields are
/// preserved unchanged in settings.json.
#[derive(Deserialize, Default)]
pub struct BrowserSettingsPatch {
    pub browser_drawer_width: Option<u32>,
    pub browser_last_url: Option<String>,
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

/// Read the settings file. Acquires `settings_io_lock` so a concurrent
/// truncate-and-write from `set_settings` / `set_browser_settings` can't
/// expose a partial file mid-read (impl-review codex2 P3 + codex3 medium).
#[tauri::command]
pub fn get_settings(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<Settings, String> {
    let _guard = state
        .settings_io_lock
        .lock()
        .map_err(|e| format!("settings_io_lock poisoned: {}", e))?;
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

/// Writes the full `Settings` struct atomically (truncate + write). Acquires
/// `AppState::settings_io_lock` to serialize against `set_browser_settings`
/// (Phase-3 Round-2 3-way convergent fix per @claude3 G1 / @codex2 P1 /
/// @codex3 #2 — without symmetric acquisition the partial update only
/// protects its half of the race).
#[tauri::command]
pub fn set_settings(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    settings: Settings,
) -> Result<(), String> {
    let _guard = state
        .settings_io_lock
        .lock()
        .map_err(|e| format!("settings_io_lock poisoned: {}", e))?;
    write_settings_file(&app, &settings)
}

/// Read the current settings file, merge browser-drawer fields from the
/// patch, write back. Acquires `AppState::settings_io_lock` for the full
/// read-modify-write cycle so a concurrent `set_settings` writer doesn't
/// lose updates (Phase-3 Round-2 G1 / codex2 P1 / codex3 #2).
#[tauri::command]
pub fn set_browser_settings(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    patch: BrowserSettingsPatch,
) -> Result<(), String> {
    let _guard = state
        .settings_io_lock
        .lock()
        .map_err(|e| format!("settings_io_lock poisoned: {}", e))?;

    // Read existing (or default if missing).
    let path = settings_path(&app)?;
    let mut current = if path.exists() {
        let s = fs::read_to_string(&path)
            .map_err(|e| format!("Cannot read settings: {}", e))?;
        serde_json::from_str::<Settings>(&s)
            .map_err(|e| format!("Cannot parse settings: {}", e))?
    } else {
        Settings::default()
    };

    // Merge only the patch fields that are Some(_).
    if let Some(w) = patch.browser_drawer_width {
        current.browser_drawer_width = Some(w);
    }
    if let Some(u) = patch.browser_last_url {
        current.browser_last_url = Some(u);
    }

    write_settings_file(&app, &current)
}

/// Atomically write the settings file via temp-file + rename. Avoids the
/// "partial JSON visible during truncate" failure mode that the old
/// truncate-and-write path admitted (impl-review codex2 P3 + codex3 medium).
/// `rename(2)` is atomic on POSIX when source and destination are on the
/// same filesystem (which they are by construction — both inside
/// `app_config_dir`).
///
/// Callers must hold `settings_io_lock` for the full read-modify-write
/// cycle; the atomic rename here is the second line of defense against
/// readers seeing a half-written file.
fn write_settings_file(app: &tauri::AppHandle, settings: &Settings) -> Result<(), String> {
    let path = settings_path(app)?;
    let tmp_path = path.with_extension("json.tmp");
    let json = serde_json::to_string_pretty(settings)
        .map_err(|e| format!("Cannot serialize settings: {}", e))?;

    // Write to a same-directory temp file first. O_NOFOLLOW preserved
    // for the security property the previous in-place writer carried.
    {
        let mut f = fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .custom_flags(libc::O_NOFOLLOW)
            .open(&tmp_path)
            .map_err(|e| format!("Cannot open settings tmp file: {}", e))?;
        f.write_all(json.as_bytes())
            .map_err(|e| format!("Cannot write settings tmp: {}", e))?;
        // Sync so the rename can't expose a zero-length file post-crash.
        let _ = f.sync_all();
    }

    fs::rename(&tmp_path, &path)
        .map_err(|e| format!("Cannot rename settings tmp into place: {}", e))?;
    Ok(())
}
