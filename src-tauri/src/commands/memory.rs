use std::io::{Read, Write};
use std::os::unix::fs::OpenOptionsExt;
use std::path::PathBuf;

/// Maximum memory file size (10 MB)
const MAX_MEMORY_FILE_SIZE: u64 = 10 * 1024 * 1024;

fn get_memory_dir() -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or("Cannot determine home directory")?;
    let dir = home.join(".cache").join("canvas-terminal").join("collab-memory");
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("Failed to create memory directory: {}", e))?;
    Ok(dir)
}

/// Validate that a relative path doesn't escape the memory directory.
fn validate_relative_path(relative: &str) -> Result<(), String> {
    if relative.is_empty() {
        return Err("Path cannot be empty".to_string());
    }
    // Reject path traversal
    for component in std::path::Path::new(relative).components() {
        match component {
            std::path::Component::ParentDir => {
                return Err("Path traversal (..) is not allowed".to_string());
            }
            std::path::Component::RootDir | std::path::Component::Prefix(_) => {
                return Err("Absolute paths are not allowed".to_string());
            }
            _ => {}
        }
    }
    Ok(())
}

/// Ensure the memory directory exists and return its absolute path.
#[tauri::command]
pub fn init_memory_dir() -> Result<String, String> {
    let dir = get_memory_dir()?;
    Ok(dir.to_string_lossy().to_string())
}

/// Write a file to the shared memory directory.
/// Returns the absolute path of the written file.
#[tauri::command]
pub fn write_memory_file(relative_path: String, content: String) -> Result<String, String> {
    validate_relative_path(&relative_path)?;
    let dir = get_memory_dir()?;
    let full_path = dir.join(&relative_path);

    // Create parent directories
    if let Some(parent) = full_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create directory: {}", e))?;
    }

    // Reject existing symlinks
    if let Ok(meta) = std::fs::symlink_metadata(&full_path) {
        if meta.is_symlink() {
            return Err("Refusing to write through a symlink".to_string());
        }
    }

    // Write with O_NOFOLLOW
    let file = match std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .custom_flags(libc::O_NOFOLLOW)
        .open(&full_path)
    {
        Ok(f) => f,
        Err(e) => {
            if e.raw_os_error() == Some(libc::ELOOP) {
                return Err("Refused to follow symlink at target path".to_string());
            }
            std::fs::File::create(&full_path)
                .map_err(|e2| format!("Failed to create file: {}", e2))?
        }
    };

    let mut writer = std::io::BufWriter::new(file);
    writer
        .write_all(content.as_bytes())
        .map_err(|e| e.to_string())?;
    writer.flush().map_err(|e| e.to_string())?;

    Ok(full_path.to_string_lossy().to_string())
}

/// Read a file from the shared memory directory.
/// Returns None if the file doesn't exist.
#[tauri::command]
pub fn read_memory_file(relative_path: String) -> Result<Option<String>, String> {
    validate_relative_path(&relative_path)?;
    let dir = get_memory_dir()?;
    let full_path = dir.join(&relative_path);

    if !full_path.exists() {
        return Ok(None);
    }

    let metadata = std::fs::metadata(&full_path).map_err(|e| e.to_string())?;
    if metadata.len() > MAX_MEMORY_FILE_SIZE {
        return Err(format!("Memory file too large: {} bytes", metadata.len()));
    }

    let mut file = std::fs::File::open(&full_path).map_err(|e| e.to_string())?;
    let mut contents = String::new();
    file.read_to_string(&mut contents)
        .map_err(|e| e.to_string())?;

    Ok(Some(contents))
}

/// Delete a file from the shared memory directory.
/// Returns true if the file was deleted, false if it didn't exist.
#[tauri::command]
pub fn delete_memory_file(relative_path: String) -> Result<bool, String> {
    validate_relative_path(&relative_path)?;
    let dir = get_memory_dir()?;
    let full_path = dir.join(&relative_path);

    if !full_path.exists() {
        return Ok(false);
    }

    // Only delete regular files — refuse to delete directories or symlinks
    let meta = std::fs::symlink_metadata(&full_path).map_err(|e| e.to_string())?;
    if meta.is_symlink() {
        return Err("Refusing to delete a symlink".to_string());
    }
    if meta.is_dir() {
        return Err("Cannot delete a directory with this command".to_string());
    }

    std::fs::remove_file(&full_path).map_err(|e| e.to_string())?;

    // Clean up empty parent directories up to the memory root
    let mut parent = full_path.parent();
    while let Some(p) = parent {
        if p == dir {
            break;
        }
        if std::fs::read_dir(p).map(|mut d| d.next().is_none()).unwrap_or(false) {
            let _ = std::fs::remove_dir(p);
        } else {
            break;
        }
        parent = p.parent();
    }

    Ok(true)
}

/// Remove the entire shared memory directory (all files).
#[tauri::command]
pub fn clear_memory_dir() -> Result<(), String> {
    let dir = get_memory_dir()?;
    if dir.exists() {
        std::fs::remove_dir_all(&dir).map_err(|e| e.to_string())?;
        // Recreate the empty directory
        std::fs::create_dir_all(&dir)
            .map_err(|e| format!("Failed to recreate memory directory: {}", e))?;
    }
    Ok(())
}

/// List all files in the shared memory directory (recursive).
/// Returns relative paths.
#[tauri::command]
pub fn list_memory_files() -> Result<Vec<String>, String> {
    let dir = get_memory_dir()?;
    let mut files = Vec::new();

    fn walk(base: &std::path::Path, current: &std::path::Path, out: &mut Vec<String>) {
        if let Ok(entries) = std::fs::read_dir(current) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_dir() {
                    walk(base, &path, out);
                } else if let Ok(relative) = path.strip_prefix(base) {
                    out.push(relative.to_string_lossy().to_string());
                }
            }
        }
    }

    walk(&dir, &dir, &mut files);
    files.sort();
    Ok(files)
}
