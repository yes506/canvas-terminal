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
