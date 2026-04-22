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
pub fn export_snapshot(base64_data: String) -> Result<String, String> {
    // Pre-flight size estimate
    let estimated_size = (base64_data.len() / 4) * 3;
    if estimated_size > MAX_BINARY_SIZE {
        return Err(format!(
            "Snapshot too large: ~{} bytes exceeds {} byte limit",
            estimated_size, MAX_BINARY_SIZE
        ));
    }

    let bytes = base64::engine::general_purpose::STANDARD
        .decode(&base64_data)
        .map_err(|e| format!("Invalid base64: {}", e))?;

    if bytes.len() > MAX_BINARY_SIZE {
        return Err(format!(
            "Decoded snapshot too large: {} bytes exceeds {} byte limit",
            bytes.len(), MAX_BINARY_SIZE
        ));
    }

    // Validate PNG magic bytes
    if bytes.len() < 8 || &bytes[..8] != b"\x89PNG\r\n\x1a\n" {
        return Err("Data is not a valid PNG file".to_string());
    }

    let home = get_home_dir()?;
    let cache_dir = home.join(".cache").join("canvas-terminal");
    std::fs::create_dir_all(&cache_dir)
        .map_err(|e| format!("Failed to create cache directory: {}", e))?;

    let snapshot_path = cache_dir.join("snapshot.png");

    let file = create_file_no_follow(&snapshot_path)?;
    let mut writer = std::io::BufWriter::new(file);
    writer.write_all(&bytes).map_err(|e| e.to_string())?;

    Ok(snapshot_path.to_string_lossy().to_string())
}

fn get_import_path(suffix: Option<&str>) -> Result<std::path::PathBuf, String> {
    let home = get_home_dir()?;
    let cache_dir = home.join(".cache").join("canvas-terminal");
    std::fs::create_dir_all(&cache_dir)
        .map_err(|e| format!("Failed to create cache directory: {}", e))?;
    match suffix {
        Some(s) => {
            // Validate suffix to prevent path traversal
            if s.contains('/') || s.contains('\\') || s.contains("..") || s.is_empty() {
                return Err("Invalid import suffix".to_string());
            }
            Ok(cache_dir.join(format!("import-{}", s)))
        }
        None => Ok(cache_dir.join("import")),
    }
}

/// Returns (absolute_path, modified_epoch_ms) for the import file, or (path, null) if it doesn't exist.
/// Optional `suffix` allows per-agent import paths for multi-agent concurrent imports.
#[tauri::command]
pub fn check_import_file(suffix: Option<String>) -> Result<(String, Option<u64>), String> {
    let import_path = get_import_path(suffix.as_deref())?;
    let path_str = import_path.to_string_lossy().to_string();

    match std::fs::metadata(&import_path) {
        Ok(meta) => {
            let mtime = meta
                .modified()
                .map_err(|e| e.to_string())?
                .duration_since(std::time::UNIX_EPOCH)
                .map_err(|e| e.to_string())?
                .as_millis() as u64;
            Ok((path_str, Some(mtime)))
        }
        Err(_) => Ok((path_str, None)),
    }
}

/// Reads the import file and returns (format, content).
/// format: "png" → content is a data:image/png;base64 URL
/// format: "text" → content is raw text (markdown, SVG, HTML, plain text, etc.)
#[tauri::command]
pub fn read_import_file(suffix: Option<String>) -> Result<(String, String), String> {
    let import_path = get_import_path(suffix.as_deref())?;

    let metadata = std::fs::metadata(&import_path).map_err(|e| e.to_string())?;
    if metadata.len() > MAX_IMAGE_READ_SIZE {
        return Err(format!("Import file too large: {} bytes", metadata.len()));
    }

    let mut file = std::fs::File::open(&import_path).map_err(|e| e.to_string())?;
    let mut buf = Vec::new();
    file.read_to_end(&mut buf).map_err(|e| e.to_string())?;

    // Check PNG magic bytes
    if buf.len() >= 8 && &buf[..8] == b"\x89PNG\r\n\x1a\n" {
        let b64 = base64::engine::general_purpose::STANDARD.encode(&buf);
        return Ok(("png".to_string(), format!("data:image/png;base64,{}", b64)));
    }

    // Check JPEG magic bytes
    if buf.len() >= 3 && &buf[..3] == b"\xff\xd8\xff" {
        let b64 = base64::engine::general_purpose::STANDARD.encode(&buf);
        return Ok(("png".to_string(), format!("data:image/jpeg;base64,{}", b64)));
    }

    // Otherwise treat as text
    let text = String::from_utf8_lossy(&buf).to_string();
    Ok(("text".to_string(), text))
}

/// Remove the snapshot file after the AI tool has read it.
pub fn cleanup_snapshot() -> Result<(), String> {
    let home = get_home_dir()?;
    let snapshot_path = home.join(".cache").join("canvas-terminal").join("snapshot.png");
    if snapshot_path.exists() {
        std::fs::remove_file(&snapshot_path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Remove the import file after it has been read onto the canvas.
#[tauri::command]
pub fn cleanup_import_file(suffix: Option<String>) -> Result<(), String> {
    let import_path = get_import_path(suffix.as_deref())?;
    if import_path.exists() {
        std::fs::remove_file(&import_path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn read_document_as_base64(path: String) -> Result<String, String> {
    let safe_path = validate_read_path(&path)?;

    // Allow document formats
    let ext = safe_path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();
    let allowed = [
        "pdf", "docx", "xlsx", "xls", "csv", "tsv", "hwp", "hwpx",
    ];
    if !allowed.contains(&ext.as_str()) {
        return Err(format!("Document type not permitted: {}", ext));
    }

    let metadata = std::fs::metadata(&safe_path).map_err(|e| e.to_string())?;
    if metadata.len() > MAX_IMAGE_READ_SIZE {
        return Err(format!("Document too large: {} bytes", metadata.len()));
    }

    let mut file = std::fs::File::open(&safe_path).map_err(|e| e.to_string())?;
    let mut buf = Vec::new();
    file.read_to_end(&mut buf).map_err(|e| e.to_string())?;

    let b64 = base64::engine::general_purpose::STANDARD.encode(&buf);
    Ok(b64)
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
