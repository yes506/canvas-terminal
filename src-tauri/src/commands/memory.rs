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

/// Sanitize a collaborator-session id into a single safe path segment.
///
/// SINGLE SOURCE OF TRUTH for the whole crate: retain only `[A-Za-z0-9_-]`,
/// drop every other character. `transcripts::sanitize_collab_session_id`
/// delegates here, and the TS side never composes session-root paths from
/// raw ids (it always round-trips through `get_memory_session_dir`), so a
/// raw-vs-sanitized divergence cannot arise across the IPC boundary.
pub(crate) fn sanitize_collab_session_id(raw: &str) -> String {
    raw.chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '-')
        .collect()
}

/// Resolve (and lazily create) the per-collab-session memory subtree
/// `session-<pid>/<sanitized-id>/` — the root every scoped memory command
/// resolves paths under.
///
/// An id that sanitizes to empty is an ERROR, never a fallback to the
/// process-level `session-<pid>/` root: falling back would silently merge
/// two panes' files back into the shared root this feature exists to split.
pub(crate) fn get_memory_session_root(collab_session_id: &str) -> Result<PathBuf, String> {
    let segment = sanitize_collab_session_id(collab_session_id);
    if segment.is_empty() {
        return Err("Invalid collab session id".to_string());
    }
    let dir = get_memory_dir()?.join(segment);
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("Failed to create collab session memory directory: {}", e))?;
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

/// Resolve (and lazily create) the absolute path of THIS collab session's
/// memory subtree. Scoped successor of the removed `init_memory_dir`: it is
/// the source of every path printed into agent prompts, so it MUST resolve
/// to the per-session subtree — leaving it root-scoped would keep inviting
/// agents into the mixed `session-<pid>/` root.
#[tauri::command]
pub fn get_memory_session_dir(collab_session_id: String) -> Result<String, String> {
    let dir = get_memory_session_root(&collab_session_id)?;
    Ok(dir.to_string_lossy().to_string())
}

/// Write a file inside one collab session's memory subtree.
/// Returns the absolute path of the written file.
#[tauri::command]
pub fn write_memory_file(
    collab_session_id: String,
    relative_path: String,
    content: String,
) -> Result<String, String> {
    validate_relative_path(&relative_path)?;
    let dir = get_memory_session_root(&collab_session_id)?;
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
pub fn write_memory_file_atomic(
    collab_session_id: String,
    relative_path: String,
    content: String,
) -> Result<String, String> {
    let dir = get_memory_session_root(&collab_session_id)?;
    write_file_atomic_under(&dir, &relative_path, &content)
}

/// Atomic-write engine shared by the scoped `write_memory_file_atomic` IPC
/// command and the transcript tailer's `.state.json` persistence (the tailer
/// resolves its own scoped base directory from the watch handle rather than
/// re-deriving it from a raw collab-session id).
pub(crate) fn write_file_atomic_under(
    dir: &std::path::Path,
    relative_path: &str,
    content: &str,
) -> Result<String, String> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;

    validate_relative_path(relative_path)?;
    let final_path = dir.join(relative_path);

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
    let mut walk = dir.to_path_buf();
    for component in std::path::Path::new(relative_path).components() {
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

/// Read a file from one collab session's memory subtree.
/// Returns None if the file doesn't exist (missing-vs-error distinction is
/// load-bearing for context.md probing).
#[tauri::command]
pub fn read_memory_file(
    collab_session_id: String,
    relative_path: String,
) -> Result<Option<String>, String> {
    validate_relative_path(&relative_path)?;
    let dir = get_memory_session_root(&collab_session_id)?;
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

/// Delete a file from one collab session's memory subtree.
/// Returns true if the file was deleted, false if it didn't exist.
/// Empty-parent pruning stops at the SESSION root — the session directory
/// itself is never removed by this command.
#[tauri::command]
pub fn delete_memory_file(
    collab_session_id: String,
    relative_path: String,
) -> Result<bool, String> {
    validate_relative_path(&relative_path)?;
    let dir = get_memory_session_root(&collab_session_id)?;
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

/// Remove ONE collab session's memory subtree and recreate it empty.
/// Scoping is the isolation guarantee: sibling session subtrees and the
/// process-level root are untouched. Used by `/memory clear` and per-session
/// teardown (`killAllAgents`).
#[tauri::command]
pub fn clear_memory_dir(collab_session_id: String) -> Result<(), String> {
    let dir = get_memory_session_root(&collab_session_id)?;
    if dir.exists() {
        std::fs::remove_dir_all(&dir).map_err(|e| e.to_string())?;
        // Recreate the empty directory
        std::fs::create_dir_all(&dir)
            .map_err(|e| format!("Failed to recreate collab session memory directory: {}", e))?;
    }
    Ok(())
}

/// Remove the ENTIRE current-process memory root `session-<pid>/` (every
/// collab session's subtree at once). Internal, non-IPC: this is the
/// window-close wipe called from `lib.rs`'s `WindowEvent::Destroyed` arm.
/// The scoped IPC `clear_memory_dir` above only ever clears one session
/// subtree — exposing a process-wide wipe over IPC would hand any pane a
/// way to delete its siblings' files, defeating the isolation.
pub fn clear_process_memory_root() -> Result<(), String> {
    let dir = get_memory_dir()?;
    if dir.exists() {
        std::fs::remove_dir_all(&dir).map_err(|e| e.to_string())?;
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
pub fn get_memory_file_mtime(
    collab_session_id: String,
    relative_path: String,
) -> Result<u64, String> {
    validate_relative_path(&relative_path)?;
    let dir = get_memory_session_root(&collab_session_id)?;
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

/// List all files in one collab session's memory subtree (recursive).
/// Returns session-relative paths. Structurally cannot cross sessions: the
/// walk is rooted at the session subtree, so sibling sessions' files and
/// root-level files never appear in the result.
#[tauri::command]
pub fn list_memory_files(collab_session_id: String) -> Result<Vec<String>, String> {
    let dir = get_memory_session_root(&collab_session_id)?;
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

/// Reject any existing symlink among the relative path's components (parents)
/// or at the final path itself. Shared by the quarantine + report-inspect
/// commands so neither can be redirected outside the session subtree by a
/// planted symlink, mirroring the walk in `write_file_atomic_under`.
fn reject_symlinked_path(dir: &std::path::Path, relative_path: &str) -> Result<PathBuf, String> {
    validate_relative_path(relative_path)?;
    let mut walk = dir.to_path_buf();
    for component in std::path::Path::new(relative_path).components() {
        if let std::path::Component::Normal(seg) = component {
            walk.push(seg);
            if let Ok(meta) = std::fs::symlink_metadata(&walk) {
                if meta.is_symlink() {
                    return Err(format!(
                        "Refusing to follow symlinked path component: {}",
                        walk.display()
                    ));
                }
            }
        }
    }
    Ok(dir.join(relative_path))
}

/// Quarantine a bad completion-signal file by renaming it to a collision-safe
/// `<name>.<pid>.<nanos>.bad` sibling (no-clobber). The `.bad` suffix removes it
/// from the `*.done.json` scan filter, breaking the silent re-fail loop, while
/// preserving the original bytes as forensic evidence. Both endpoints are
/// path-validated and the whole component chain is symlink-guarded (defense in
/// depth at every entry point — the destination is derived, not caller-supplied,
/// but validated regardless). Same parent → the rename is atomic on one fs.
/// Returns the absolute destination path.
#[tauri::command]
pub fn quarantine_memory_file(
    collab_session_id: String,
    relative_path: String,
) -> Result<String, String> {
    let dir = get_memory_session_root(&collab_session_id)?;
    quarantine_under(&dir, &relative_path)
}

pub(crate) fn quarantine_under(
    dir: &std::path::Path,
    relative_path: &str,
) -> Result<String, String> {
    use std::os::unix::fs::OpenOptionsExt;

    let source = reject_symlinked_path(dir, relative_path)?;

    // Source must be an existing REGULAR file — reject symlink, directory, AND
    // every other non-regular node (FIFO, socket, device): `is_file()` is the
    // positive check, stricter than "not symlink && not dir".
    let meta = std::fs::symlink_metadata(&source)
        .map_err(|e| format!("quarantine stat {}: {}", relative_path, e))?;
    if !meta.is_file() {
        return Err("Refusing to quarantine a non-regular file".to_string());
    }

    let basename = source
        .file_name()
        .ok_or_else(|| "Source has no basename".to_string())?
        .to_string_lossy()
        .to_string();
    let parent = source
        .parent()
        .ok_or_else(|| "Source has no parent".to_string())?;

    // Exclusive-reservation no-clobber (portable — macOS lacks
    // RENAME_NOREPLACE): atomically CREATE_NEW (O_EXCL) a unique `.bad`
    // destination so the name is provably ours before we rename into it. If the
    // name collides (astronomically unlikely with pid+nanos), bump the counter
    // and retry. This guarantees no EARLIER forensic `.bad` artifact is ever
    // overwritten by the subsequent rename (it would have a different name).
    let mut dest = parent.join(String::new());
    let mut reserved = false;
    for attempt in 0..64u32 {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|e| e.to_string())?
            .as_nanos();
        let candidate = parent.join(format!(
            "{}.{}.{}.{}.bad",
            basename,
            std::process::id(),
            nanos,
            attempt
        ));
        match std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .custom_flags(libc::O_NOFOLLOW)
            .open(&candidate)
        {
            Ok(_) => {
                dest = candidate;
                reserved = true;
                break;
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(format!("quarantine reserve: {}", e)),
        }
    }
    if !reserved {
        return Err("quarantine: could not reserve a destination name".to_string());
    }

    // Rename replaces our just-created empty reservation with the source bytes;
    // atomic within the same parent directory. On failure (e.g. the source
    // vanished via TOCTOU between the is_file() stat and here), unlink the empty
    // reservation so it does not leak.
    if let Err(e) = std::fs::rename(&source, &dest) {
        let _ = std::fs::remove_file(&dest);
        return Err(format!("quarantine rename {}: {}", relative_path, e));
    }
    Ok(dest.to_string_lossy().to_string())
}

/// Structural facts about a report file, discovered WITHOUT following symlinks.
/// `camelCase` so the Tauri-serialized shape matches the TS `ReportFileInfo`
/// (`{exists, isRegular, sizeBytes}`).
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReportFileInfo {
    pub exists: bool,
    pub is_regular: bool,
    pub size_bytes: u64,
}

/// Inspect a completion report reference without ever following a symlink.
///
/// The generic `read_memory_file`/`get_memory_file_mtime` commands follow
/// symlinks by design; a completion `report_path` is agent-influenced, so it
/// needs a no-follow inspector. Uses `symlink_metadata` on the final path and
/// rejects any symlinked parent component. Returns `{exists,is_regular,size}`;
/// the scanner stores only a reference and never reads report content, so a
/// stat is sufficient. A symlinked target/parent is an Err — the caller treats
/// that as an unsafe reference (soft-fail: terminalize, drop the reference).
#[tauri::command]
pub fn inspect_report_file(
    collab_session_id: String,
    relative_path: String,
) -> Result<ReportFileInfo, String> {
    let dir = get_memory_session_root(&collab_session_id)?;
    inspect_report_under(&dir, &relative_path)
}

pub(crate) fn inspect_report_under(
    dir: &std::path::Path,
    relative_path: &str,
) -> Result<ReportFileInfo, String> {
    let full_path = reject_symlinked_path(dir, relative_path)?;
    match std::fs::symlink_metadata(&full_path) {
        Err(_) => Ok(ReportFileInfo {
            exists: false,
            is_regular: false,
            size_bytes: 0,
        }),
        Ok(meta) => {
            if meta.is_symlink() {
                return Err("Refusing to inspect a symlinked report".to_string());
            }
            Ok(ReportFileInfo {
                exists: true,
                is_regular: meta.is_file(),
                size_bytes: meta.len(),
            })
        }
    }
}

#[cfg(test)]
mod scoped_memory_tests {
    //! Per-collab-session isolation coverage: the sanitizer contract, the
    //! empty-after-sanitize refusal (never a root fallback), and structural
    //! cross-session denial for the scoped commands. Session ids are unique
    //! per test because every test in the process shares one
    //! `session-<pid>/` root.
    use super::*;

    #[test]
    fn sanitize_keeps_allowed_drops_others() {
        assert_eq!(sanitize_collab_session_id("session-1-123"), "session-1-123");
        assert_eq!(sanitize_collab_session_id("a/b\\c..d e"), "abcde");
        assert_eq!(sanitize_collab_session_id("../../etc/passwd"), "etcpasswd");
        assert_eq!(sanitize_collab_session_id("foo_bar-9"), "foo_bar-9");
    }

    #[test]
    fn empty_after_sanitize_is_error_never_root() {
        // Pure-stripped ids must refuse — a root fallback would silently
        // merge two panes back into the shared session-<pid>/ root.
        assert!(get_memory_session_root("").is_err());
        assert!(get_memory_session_root("///").is_err());
        assert!(get_memory_session_root("..").is_err());
        assert!(get_memory_session_dir(String::new()).is_err());
        assert!(clear_memory_dir(String::from("//")).is_err());
        assert!(list_memory_files(String::from(".")).is_err());
    }

    #[test]
    fn session_root_is_nested_under_process_dir() {
        let sid = "session-mem-nest-1";
        let root = get_memory_session_root(sid).unwrap();
        let process_dir = get_memory_dir().unwrap();
        assert_eq!(root, process_dir.join(sid));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn traversal_session_id_cannot_reach_sibling() {
        // A hostile id carrying path syntax sanitizes to a flat, distinct
        // segment — the '/' and '.' bytes are dropped, so it can never
        // resolve to a parent dir or a sibling's subtree.
        let victim = "session-mem-victim-1";
        write_memory_file(victim.into(), "secret.md".into(), "s".into()).unwrap();

        let hostile = format!("x/../{}", victim);
        let root = get_memory_session_root(&hostile).unwrap();
        let process_dir = get_memory_dir().unwrap();
        assert_eq!(root, process_dir.join(format!("x{}", victim)));
        assert!(list_memory_files(hostile.clone()).unwrap().is_empty());

        let _ = std::fs::remove_dir_all(get_memory_session_root(victim).unwrap());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn scoped_read_write_list_cross_session_denial() {
        let a = "session-mem-iso-a";
        let b = "session-mem-iso-b";
        write_memory_file(a.into(), "notes/x.md".into(), "hello-a".into()).unwrap();

        // Same relative path in session B: absent.
        assert_eq!(read_memory_file(b.into(), "notes/x.md".into()).unwrap(), None);
        // B's listing structurally cannot contain A's file.
        assert!(list_memory_files(b.into()).unwrap().is_empty());
        // A sees its own file, session-relative.
        assert_eq!(
            list_memory_files(a.into()).unwrap(),
            vec!["notes/x.md".to_string()]
        );
        // Traversal out of the session subtree is rejected at input.
        assert!(read_memory_file(b.into(), format!("../{}/notes/x.md", a)).is_err());
        assert!(delete_memory_file(b.into(), format!("../{}/notes/x.md", a)).is_err());

        let _ = std::fs::remove_dir_all(get_memory_session_root(a).unwrap());
        let _ = std::fs::remove_dir_all(get_memory_session_root(b).unwrap());
    }

    #[test]
    fn scoped_clear_leaves_sibling_intact() {
        let a = "session-mem-clear-a";
        let b = "session-mem-clear-b";
        write_memory_file(a.into(), "f.md".into(), "a".into()).unwrap();
        write_memory_file(b.into(), "f.md".into(), "b".into()).unwrap();

        clear_memory_dir(a.into()).unwrap();

        // A is empty but recreated; B untouched.
        assert!(list_memory_files(a.into()).unwrap().is_empty());
        assert_eq!(
            read_memory_file(b.into(), "f.md".into()).unwrap().as_deref(),
            Some("b")
        );

        let _ = std::fs::remove_dir_all(get_memory_session_root(a).unwrap());
        let _ = std::fs::remove_dir_all(get_memory_session_root(b).unwrap());
    }

    #[test]
    fn delete_prunes_parents_but_never_session_root() {
        let sid = "session-mem-prune-1";
        write_memory_file(sid.into(), "deep/nested/f.md".into(), "x".into()).unwrap();
        assert!(delete_memory_file(sid.into(), "deep/nested/f.md".into()).unwrap());
        let root = get_memory_session_root(sid).unwrap();
        // Empty parents pruned…
        assert!(!root.join("deep").exists());
        // …but the session root itself survives.
        assert!(root.exists());
        // Idempotent second delete.
        assert!(!delete_memory_file(sid.into(), "deep/nested/f.md".into()).unwrap());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn atomic_write_lands_inside_session_subtree() {
        let sid = "session-mem-atomic-1";
        let abs = write_memory_file_atomic(sid.into(), "agents-x.json".into(), "{}".into()).unwrap();
        let root = get_memory_session_root(sid).unwrap();
        assert!(std::path::Path::new(&abs).starts_with(&root));
        assert_eq!(
            read_memory_file(sid.into(), "agents-x.json".into()).unwrap().as_deref(),
            Some("{}")
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn quarantine_renames_to_bad_and_stops_matching_scan() {
        let sid = "session-mem-quar-1";
        write_memory_file(sid.into(), "task-1.done.json".into(), "garbage".into()).unwrap();
        let dest = quarantine_memory_file(sid.into(), "task-1.done.json".into()).unwrap();
        assert!(dest.ends_with(".bad"));
        // Original name gone; a `.bad` artifact remains and is excluded from
        // the `.done.json` scan filter (breaks the re-fail loop).
        let listed = list_memory_files(sid.into()).unwrap();
        assert!(!listed.iter().any(|f| f == "task-1.done.json"));
        assert!(listed.iter().any(|f| f.ends_with(".bad")));
        let _ = std::fs::remove_dir_all(get_memory_session_root(sid).unwrap());
    }

    #[test]
    fn quarantine_is_no_clobber_across_repeated_calls() {
        let sid = "session-mem-quar-2";
        let root = get_memory_session_root(sid).unwrap();
        write_memory_file(sid.into(), "task-2.done.json".into(), "a".into()).unwrap();
        let d1 = quarantine_memory_file(sid.into(), "task-2.done.json".into()).unwrap();
        write_memory_file(sid.into(), "task-2.done.json".into(), "b".into()).unwrap();
        let d2 = quarantine_memory_file(sid.into(), "task-2.done.json".into()).unwrap();
        assert_ne!(d1, d2, "second quarantine must not clobber the first artifact");
        assert!(std::path::Path::new(&d1).exists());
        assert!(std::path::Path::new(&d2).exists());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn quarantine_rejects_symlink_source() {
        let sid = "session-mem-quar-sym";
        let root = get_memory_session_root(sid).unwrap();
        std::fs::create_dir_all(&root).unwrap();
        let link = root.join("task-3.done.json");
        std::os::unix::fs::symlink("/etc/hosts", &link).unwrap();
        assert!(quarantine_memory_file(sid.into(), "task-3.done.json".into()).is_err());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn quarantine_rejects_non_regular_fifo() {
        let sid = "session-mem-quar-fifo";
        let root = get_memory_session_root(sid).unwrap();
        std::fs::create_dir_all(&root).unwrap();
        let fifo = root.join("task-4.done.json");
        let c = std::ffi::CString::new(fifo.to_string_lossy().as_bytes()).unwrap();
        let rc = unsafe { libc::mkfifo(c.as_ptr(), 0o644) };
        if rc == 0 {
            // A FIFO is not a regular file → must be refused (is_file() gate).
            assert!(quarantine_memory_file(sid.into(), "task-4.done.json".into()).is_err());
        }
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn inspect_report_reports_regular_missing_and_rejects_symlink() {
        let sid = "session-mem-inspect-1";
        let root = get_memory_session_root(sid).unwrap();
        // regular file
        write_memory_file(sid.into(), "task-1-report.md".into(), "hello".into()).unwrap();
        let info = inspect_report_file(sid.into(), "task-1-report.md".into()).unwrap();
        assert!(info.exists && info.is_regular);
        assert_eq!(info.size_bytes, 5);
        // missing file
        let miss = inspect_report_file(sid.into(), "nope.md".into()).unwrap();
        assert!(!miss.exists && !miss.is_regular);
        // symlinked report → error (soft-fail path in the caller)
        std::fs::create_dir_all(&root).unwrap();
        std::os::unix::fs::symlink("/etc/hosts", root.join("evil.md")).unwrap();
        assert!(inspect_report_file(sid.into(), "evil.md".into()).is_err());
        // traversal / absolute rejected by validate_relative_path
        assert!(inspect_report_file(sid.into(), "../escape.md".into()).is_err());
        let _ = std::fs::remove_dir_all(&root);
    }
}
