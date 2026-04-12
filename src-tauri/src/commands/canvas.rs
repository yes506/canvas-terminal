use std::io::{Read, Write};
use std::os::unix::fs::OpenOptionsExt;
use std::path::Path;
use base64::Engine;

/// Maximum decoded binary file size (50 MB) to prevent memory exhaustion
const MAX_BINARY_SIZE: usize = 50 * 1024 * 1024;

/// Maximum image file size for reading (20 MB)
const MAX_IMAGE_READ_SIZE: u64 = 20 * 1024 * 1024;

/// Maximum canvas JSON file size for reading (100 MB)
const MAX_CANVAS_READ_SIZE: u64 = 100 * 1024 * 1024;

fn get_home_dir() -> Result<std::path::PathBuf, String> {
    dirs::home_dir().ok_or_else(|| "Cannot determine home directory".to_string())
}

fn validate_save_path(path: &str) -> Result<std::path::PathBuf, String> {
    let home = get_home_dir()?;
    let p = Path::new(path);

    let parent = p
        .parent()
        .ok_or_else(|| "Invalid path: no parent directory".to_string())?;

    let canonical_parent = std::fs::canonicalize(parent).map_err(|e| {
        format!("Cannot resolve parent directory: {}", e)
    })?;

    if !canonical_parent.starts_with(&home) {
        return Err(format!(
            "Path is outside home directory: {}",
            canonical_parent.display()
        ));
    }

    let file_name = p
        .file_name()
        .ok_or_else(|| "Invalid path: no filename".to_string())?;

    let full_path = canonical_parent.join(file_name);

    // Reject existing symlinks — check with symlink_metadata (does not follow links)
    if let Ok(meta) = std::fs::symlink_metadata(&full_path) {
        if meta.is_symlink() {
            // Resolve the symlink target and re-check boundary
            let resolved = std::fs::canonicalize(&full_path).map_err(|e| {
                format!("Cannot resolve symlink: {}", e)
            })?;
            if !resolved.starts_with(&home) {
                return Err(format!(
                    "Symlink target is outside home directory: {}",
                    resolved.display()
                ));
            }
            return Ok(resolved);
        }
    }

    Ok(full_path)
}

fn validate_read_path(path: &str) -> Result<std::path::PathBuf, String> {
    let home = get_home_dir()?;
    let canonical = std::fs::canonicalize(path)
        .map_err(|e| format!("Cannot resolve path: {}", e))?;

    if !canonical.starts_with(&home) {
        return Err(format!(
            "Read path is outside home directory: {}",
            canonical.display()
        ));
    }

    Ok(canonical)
}

/// Open a file for writing with O_NOFOLLOW to prevent symlink attacks.
/// Only falls back to regular create when the error is NOT a symlink detection (ELOOP).
fn create_file_no_follow(path: &std::path::Path) -> Result<std::fs::File, String> {
    match std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .custom_flags(libc::O_NOFOLLOW)
        .open(path)
    {
        Ok(f) => Ok(f),
        Err(e) => {
            // ELOOP means a symlink was encountered — reject the write
            if e.raw_os_error() == Some(libc::ELOOP) {
                return Err("Refused to follow symlink at target path".to_string());
            }
            // Other errors (e.g., O_NOFOLLOW unsupported) — fall back
            std::fs::File::create(path)
                .map_err(|e2| format!("Failed to create file: {}", e2))
        }
    }
}

#[tauri::command]
pub fn save_canvas(path: String, data: String) -> Result<(), String> {
    let safe_path = validate_save_path(&path)?;
    let file = create_file_no_follow(&safe_path)?;
    let mut writer = std::io::BufWriter::new(file);
    writer.write_all(data.as_bytes())
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn load_canvas(path: String) -> Result<String, String> {
    let safe_path = validate_read_path(&path)?;

    // Check file size before reading
    let metadata = std::fs::metadata(&safe_path).map_err(|e| e.to_string())?;
    if metadata.len() > MAX_CANVAS_READ_SIZE {
        return Err(format!("Canvas file too large: {} bytes", metadata.len()));
    }

    let mut file = std::fs::File::open(&safe_path).map_err(|e| e.to_string())?;
    let mut contents = String::new();
    file.read_to_string(&mut contents)
        .map_err(|e| e.to_string())?;
    Ok(contents)
}

#[tauri::command]
pub fn save_binary_file(path: String, base64_data: String) -> Result<(), String> {
    let safe_path = validate_save_path(&path)?;

    // Pre-flight size estimate (ceiling; never under-estimates)
    let estimated_size = (base64_data.len() / 4) * 3;
    if estimated_size > MAX_BINARY_SIZE {
        return Err(format!(
            "Payload too large: ~{} bytes exceeds {} byte limit",
            estimated_size, MAX_BINARY_SIZE
        ));
    }

    let bytes = base64::engine::general_purpose::STANDARD
        .decode(&base64_data)
        .map_err(|e| e.to_string())?;

    // Post-decode size check for precision
    if bytes.len() > MAX_BINARY_SIZE {
        return Err(format!(
            "Decoded payload too large: {} bytes exceeds {} byte limit",
            bytes.len(), MAX_BINARY_SIZE
        ));
    }

    let file = create_file_no_follow(&safe_path)?;
    let mut writer = std::io::BufWriter::new(file);
    writer.write_all(&bytes).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn read_image_as_data_url(path: String) -> Result<String, String> {
    let safe_path = validate_read_path(&path)?;

    // Validate extension (SVG excluded to prevent XSS in WebView)
    let ext = safe_path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();
    let allowed = ["png", "jpg", "jpeg", "gif", "webp"];
    if !allowed.contains(&ext.as_str()) {
        return Err(format!("File type not permitted: {}", ext));
    }

    // Check file size before reading
    let metadata = std::fs::metadata(&safe_path).map_err(|e| e.to_string())?;
    if metadata.len() > MAX_IMAGE_READ_SIZE {
        return Err(format!("Image too large: {} bytes", metadata.len()));
    }

    let mut file = std::fs::File::open(&safe_path).map_err(|e| e.to_string())?;
    let mut buf = Vec::new();
    file.read_to_end(&mut buf).map_err(|e| e.to_string())?;

    let mime = match ext.as_str() {
        "jpg" | "jpeg" => "image/jpeg",
        "png" => "image/png",
        "gif" => "image/gif",
        "webp" => "image/webp",
        _ => "image/png",
    };

    let b64 = base64::engine::general_purpose::STANDARD.encode(&buf);
    Ok(format!("data:{};base64,{}", mime, b64))
}
