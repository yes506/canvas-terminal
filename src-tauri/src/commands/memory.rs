use std::io::{Read, Write};
use std::os::unix::fs::OpenOptionsExt;
use std::path::PathBuf;

/// Maximum memory file size (10 MB)
const MAX_MEMORY_FILE_SIZE: u64 = 10 * 1024 * 1024;

pub(crate) fn get_memory_root() -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or("Cannot determine home directory")?;
    let dir = home
        .join(".cache")
        .join("canvas-terminal")
        .join("collab-memory");
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("Failed to create memory directory: {}", e))?;
    Ok(dir)
}

pub(crate) fn get_memory_dir() -> Result<PathBuf, String> {
    let root = get_memory_root()?;
    let dir = root.join(format!("session-{}", std::process::id()));
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("Failed to create session memory directory: {}", e))?;
    Ok(dir)
}

fn parse_session_pid(path: &std::path::Path) -> Option<u32> {
    let name = path.file_name()?.to_str()?;
    let pid = name.strip_prefix("session-")?;
    pid.parse::<u32>().ok()
}

fn is_process_alive(pid: u32) -> bool {
    if pid == std::process::id() {
        return true;
    }
    // kill(pid, 0) checks for process existence without sending a signal.
    let rc = unsafe { libc::kill(pid as i32, 0) };
    rc == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

/// Validate that a relative path doesn't escape the memory directory.
///
/// `pub(crate)` so the dashboard module's raw-file endpoint can reuse the same
/// invariants without re-deriving them. See `dashboard::server` for the HTTP
/// caller; `validate_relative_path` is the single source of truth for path
/// safety.
pub(crate) fn validate_relative_path(relative: &str) -> Result<(), String> {
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

/// Atomically write a file to the shared memory directory.
///
/// Visibility-atomic: the reader sees old content or new content, never a
/// half-written or zero-byte file. Used for the dashboard's roster sidecar
/// (`agents-{collabId}.json`), which the dashboard server polls via SSE
/// during periods that overlap the truncate-then-write window of
/// `write_memory_file`.
///
/// Crash-durability is best-effort: this fsyncs the temp file but not the
/// parent directory, so a power loss between `rename` and the next fsync of
/// the parent is not guaranteed survivable.
///
/// Implementation notes (v5 §3.1):
///  - Tmp file lives in the SAME parent directory as the final path so the
///    rename is atomic on one filesystem.
///  - Tmp filename: `.{basename}.{pid}.{nanos}.tmp` — leading dot keeps it
///    out of generic listings; pid+nanos defeats the same-process collision
///    on `O_EXCL` and the self-perpetuating orphan-tmp leak that an earlier
///    plan revision was vulnerable to.
///  - Pre-clean of `tmp_path` is defense in depth; with the nanos suffix
///    the collision rate is effectively zero, but the cleanup is free.
///  - Final-path symlink is rejected both before write and immediately
///    before rename (TOCTOU mitigation).
///
/// Known limitation: the per-component symlink walk runs once before
/// `create_dir_all` and `open(tmp_path)`. A symlink introduced AFTER the
/// walk but BEFORE the temp-file open could still redirect the temp path.
/// Acceptable for the current local single-user threat model; a stronger
/// defense would require directory-fd-based traversal (`openat`) or a
/// post-create canonical-parent re-check. Tracked for Day 2 hardening
/// alongside the atomic-write fixture tests.
#[tauri::command]
pub fn write_memory_file_atomic(relative_path: String, content: String) -> Result<String, String> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;

    validate_relative_path(&relative_path)?;
    let dir = get_memory_dir()?;
    let final_path = dir.join(&relative_path);

    // Reject existing symlink or directory at final path.
    if let Ok(meta) = std::fs::symlink_metadata(&final_path) {
        if meta.is_symlink() {
            return Err("Refusing to write through a symlink".to_string());
        }
        if meta.is_dir() {
            return Err("Refusing to overwrite a directory".to_string());
        }
    }

    // Walk the relative path components and reject any component that
    // is an existing symlink. This matters when the helper is reused for
    // nested paths — a planted symlink at a parent directory could redirect
    // writes outside the memory tree even though the final-path symlink
    // check passed. Cheap to do for every write.
    let mut walk = dir.clone();
    for component in std::path::Path::new(&relative_path).components() {
        if let std::path::Component::Normal(seg) = component {
            walk.push(seg);
            if let Ok(meta) = std::fs::symlink_metadata(&walk) {
                if meta.is_symlink() {
                    return Err(format!(
                        "Refusing to write through symlinked path component: {}",
                        walk.display()
                    ));
                }
            }
        }
    }

    // Create parent directories so atomic writes work for nested paths.
    if let Some(parent) = final_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create directory: {}", e))?;
    }

    let parent = final_path
        .parent()
        .ok_or_else(|| "Final path has no parent".to_string())?;
    let basename = final_path
        .file_name()
        .ok_or_else(|| "Final path has no basename".to_string())?
        .to_string_lossy()
        .to_string();
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_nanos();
    let tmp_name = format!(".{}.{}.{}.tmp", basename, std::process::id(), nanos);
    let tmp_path = parent.join(&tmp_name);

    // Pre-clean any orphan at this exact tmp path. Effectively never collides
    // because of the nanos suffix, but free defense against future call-pattern
    // changes that drop the suffix.
    let _ = std::fs::remove_file(&tmp_path);

    let file_result = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .custom_flags(libc::O_NOFOLLOW)
        .open(&tmp_path);

    let file = match file_result {
        Ok(f) => f,
        Err(e) => {
            let _ = std::fs::remove_file(&tmp_path);
            return Err(format!("Failed to create tmp file: {}", e));
        }
    };

    let mut writer = std::io::BufWriter::new(file);
    if let Err(e) = writer.write_all(content.as_bytes()) {
        let _ = std::fs::remove_file(&tmp_path);
        return Err(format!("Failed to write tmp file: {}", e));
    }
    if let Err(e) = writer.flush() {
        let _ = std::fs::remove_file(&tmp_path);
        return Err(format!("Failed to flush tmp file: {}", e));
    }
    let file = match writer.into_inner() {
        Ok(f) => f,
        Err(e) => {
            let _ = std::fs::remove_file(&tmp_path);
            return Err(format!("Failed to unwrap writer: {}", e));
        }
    };
    if let Err(e) = file.sync_all() {
        let _ = std::fs::remove_file(&tmp_path);
        return Err(format!("Failed to fsync tmp file: {}", e));
    }

    // TOCTOU re-check immediately before rename.
    if let Ok(meta) = std::fs::symlink_metadata(&final_path) {
        if meta.is_symlink() {
            let _ = std::fs::remove_file(&tmp_path);
            return Err("Refusing to rename over a symlink".to_string());
        }
    }

    if let Err(e) = std::fs::rename(&tmp_path, &final_path) {
        let _ = std::fs::remove_file(&tmp_path);
        return Err(format!("Failed to rename tmp into place: {}", e));
    }

    Ok(final_path.to_string_lossy().to_string())
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
        if std::fs::read_dir(p)
            .map(|mut d| d.next().is_none())
            .unwrap_or(false)
        {
            let _ = std::fs::remove_dir(p);
        } else {
            break;
        }
        parent = p.parent();
    }

    Ok(true)
}

/// Remove the current app process's shared memory directory (all files).
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

/// Remove session directories whose owning process is no longer alive.
/// Called on app launch to clean up stale dirs from previous/crashed processes
/// without touching live app instances.
pub fn clear_stale_sessions() -> Result<(), String> {
    let root = get_memory_root()?;
    if !root.exists() {
        return Ok(());
    }

    let entries = std::fs::read_dir(&root).map_err(|e| e.to_string())?;
    for entry in entries {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let Some(pid) = parse_session_pid(&path) else {
            continue;
        };
        if is_process_alive(pid) {
            continue;
        }
        std::fs::remove_dir_all(&path).map_err(|e| e.to_string())?;
    }

    Ok(())
}
/// Get a memory file's last-modified time as Unix epoch milliseconds.
///
/// Returns `Err` for missing files (the JS caller treats absence and
/// stat-error identically — distinct from `read_memory_file`'s
/// `Ok(None)` shape, which returns `Option` because its caller needs to
/// distinguish "missing" from "stat-error" while this caller does not).
///
/// Used by `scanForTaskCompletions` to gate orphan `.done.json` deletion
/// behind a 24-hour grace period so cold-boot session-load races can't
/// mis-classify recently-written completions.
///
/// Filesystems that don't support `mtime` (some overlay/tmpfs mounts in
/// container environments) propagate an `Err`; the JS caller skips those
/// files, leaving them in place. Matches pre-orphan-cleanup behavior on
/// such filesystems.
#[tauri::command]
pub fn get_memory_file_mtime(relative_path: String) -> Result<u64, String> {
    validate_relative_path(&relative_path)?;
    let dir = get_memory_dir()?;
    let full_path = dir.join(&relative_path);
    // `metadata` follows symlinks intentionally — consistent with
    // `read_memory_file`, which also follows. `write_memory_file` and
    // `delete_memory_file` reject symlinks at write/delete time, and
    // `validate_relative_path` blocks `..`/absolute traversal at input,
    // so a symlink can't be planted via this code path.
    let metadata =
        std::fs::metadata(&full_path).map_err(|e| format!("stat {}: {}", relative_path, e))?;
    let modified = metadata.modified().map_err(|e| e.to_string())?;
    let ms = modified
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_millis() as u64;
    Ok(ms)
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
