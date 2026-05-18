// Per-stream byte tailer with inode-anchored offset persistence.
//
// State storage layout: a single JSON file at
// `<session-memory-dir>/contexts/.state.json` holding a map keyed by the
// source-path string (per `persist_offset`'s explicit
// "keyed by `state.path` inside the JSON document" contract). Each value
// is a `TailState` carrying path / inode / byte_offset /
// last_normalized_turn_index. The store is read-modify-write per persist
// — the watcher serializes calls per-token, so concurrent writers race
// only on distinct keys at worst, and the atomic-rename underlying
// `memory::write_memory_file_atomic` makes the final visibility atomic.
//
// In-bounds writable path is supplied via `TranscriptHandle::memory_dir`
// (planner touch-up `bffb828` delta A): the external transcript root is
// strictly read-only by the peer-context-mirror "one-way mirror" rule;
// state lives inside `collab-memory/session-<pid>/contexts/`.

use std::collections::HashMap;
use std::io::{Read, Seek, SeekFrom};
use std::os::unix::fs::MetadataExt;
use std::path::PathBuf;

use super::super::memory;
use super::{TranscriptHandle, WatcherError};

/// Resumable tail state — written to and read from
/// `session-<pid>/contexts/.state.json` per agent (multi-agent map keyed
/// by source-path string).
#[derive(serde::Serialize, serde::Deserialize, Clone)]
pub struct TailState {
    pub path: PathBuf,
    pub inode: u64,
    pub byte_offset: u64,
    pub last_normalized_turn_index: u64,
}

/// `relative_path` argument used with `memory::write_memory_file_atomic` and
/// equivalent direct reads. Single source of truth so resume / persist /
/// inode-change agree on layout.
const STATE_FILE_RELPATH: &str = "contexts/.state.json";

/// Compute the absolute on-disk path of the multi-agent `.state.json`.
///
/// Uses `handle.memory_dir` (populated by `TranscriptWatcher::watch` from
/// `memory::get_memory_dir()` at watch-registration time). In-process this
/// equals `memory::get_memory_dir()`; on the write side `persist_offset`
/// calls `memory::write_memory_file_atomic` which re-derives the same dir
/// — by construction the read and write target the same file.
fn state_file_path(handle: &TranscriptHandle) -> PathBuf {
    handle.memory_dir.join(STATE_FILE_RELPATH)
}

/// Read the multi-agent state map from disk. Absent file returns an empty
/// map (fresh-session semantics). Malformed JSON returns
/// `WatcherError::StateCorrupted` so the caller can surface a diagnostic
/// rather than silently clobber the file.
fn read_state_map(path: &std::path::Path) -> Result<HashMap<String, TailState>, WatcherError> {
    match std::fs::read_to_string(path) {
        Ok(contents) => serde_json::from_str(&contents).map_err(|e| {
            WatcherError::StateCorrupted(format!("parse {}: {}", path.display(), e))
        }),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(HashMap::new()),
        Err(e) => Err(WatcherError::Io(e)),
    }
}

/// Key the per-handle entry by the source-path string (matches
/// `persist_offset`'s docstring "keyed by `state.path` inside the JSON
/// document"). Lossy conversion is acceptable: transcript roots are
/// adapter-pinned ASCII (`~/.claude/projects/...`, `~/.codex/sessions/...`,
/// `~/.gemini/tmp/...`); non-UTF-8 components don't occur in practice.
fn key_for(path: &std::path::Path) -> String {
    path.to_string_lossy().to_string()
}

pub fn resume_from_state(handle: &TranscriptHandle) -> Result<TailState, WatcherError> {
    let stored = read_state_map(&state_file_path(handle))?
        .remove(&key_for(&handle.source_path));

    // Current inode for rotation detection (R2). Source file may not exist
    // yet — Codex creates the rollout JSONL only on first model call, not
    // at session-bind — so NotFound here is normal and yields a fresh
    // state using the binding-time inode placeholder.
    let current_inode = match std::fs::metadata(&handle.source_path) {
        Ok(m) => m.ino(),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Ok(TailState {
                path: handle.source_path.clone(),
                inode: handle.source_inode,
                byte_offset: 0,
                last_normalized_turn_index: 0,
            });
        }
        Err(e) => return Err(WatcherError::Io(e)),
    };

    Ok(match stored {
        Some(s) if s.inode == current_inode => s,
        // Stored inode differs (rotation since last persist) OR no stored
        // entry — fresh start. R2 contract: byte_offset and turn_index
        // reset to 0.
        _ => TailState {
            path: handle.source_path.clone(),
            inode: current_inode,
            byte_offset: 0,
            last_normalized_turn_index: 0,
        },
    })
}

pub fn poll_new_bytes(handle: &TranscriptHandle, offset: u64) -> Result<Vec<u8>, WatcherError> {
    let mut file = std::fs::File::open(&handle.source_path)
        .map_err(WatcherError::Io)?;
    let lstat = file.metadata().map_err(WatcherError::Io)?;
    let current_inode = lstat.ino();
    if current_inode != handle.source_inode {
        // R2: source-file rotation. Return the typed SourceRotation
        // variant so `watcher::on_fs_event` can distinguish this from
        // other I/O errors and route into `handle_inode_change` for
        // rebind-and-retry instead of the catch-all swallow-and-wait.
        return Err(WatcherError::SourceRotation);
    }
    let size = lstat.len();
    if offset >= size {
        return Ok(Vec::new());
    }
    file.seek(SeekFrom::Start(offset)).map_err(WatcherError::Io)?;
    let to_read = std::cmp::min((size - offset) as usize, MAX_POLL_BYTES);
    let mut buf = vec![0u8; to_read];
    let n = file.read(&mut buf).map_err(WatcherError::Io)?;
    buf.truncate(n);
    Ok(buf)
}

pub fn persist_offset(state: &TailState) -> Result<(), WatcherError> {
    // Read-modify-write. memory::write_memory_file_atomic uses
    // memory::get_memory_dir() (process-scoped session-<pid>); in-process
    // this agrees with the handle.memory_dir resume_from_state read from,
    // so the round-trip is consistent.
    let dir = memory::get_memory_dir()
        .map_err(|e| WatcherError::Io(std::io::Error::new(std::io::ErrorKind::Other, e)))?;
    let full_path = dir.join(STATE_FILE_RELPATH);

    let mut map = read_state_map(&full_path)?;
    map.insert(key_for(&state.path), state.clone());

    let serialized = serde_json::to_string(&map).map_err(|e| {
        WatcherError::Io(std::io::Error::new(std::io::ErrorKind::InvalidData, e))
    })?;

    memory::write_memory_file_atomic(STATE_FILE_RELPATH.to_string(), serialized)
        .map_err(|e| WatcherError::Io(std::io::Error::new(std::io::ErrorKind::Other, e)))?;

    Ok(())
}

pub fn handle_inode_change(handle: &TranscriptHandle) -> Result<TailState, WatcherError> {
    // R2: source rotated (current inode differs from previously-tracked
    // inode). Reset offset to 0 and re-bind the TailState entry to the new
    // inode. Persist immediately — a crash between this and the next poll
    // would otherwise allow the watcher to mis-resume from a stale state.
    let lstat = std::fs::metadata(&handle.source_path).map_err(WatcherError::Io)?;
    let new_state = TailState {
        path: handle.source_path.clone(),
        inode: lstat.ino(),
        byte_offset: 0,
        last_normalized_turn_index: 0,
    };
    persist_offset(&new_state)?;
    Ok(new_state)
}

pub const MAX_POLL_BYTES: usize = 1 * 1024 * 1024;
