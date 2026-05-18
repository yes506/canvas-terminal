// Per-stream byte tailer with inode-anchored offset persistence.

use std::io::{Read, Seek, SeekFrom};
use std::os::unix::fs::MetadataExt;
use std::path::PathBuf;

use super::{TranscriptHandle, WatcherError};

#[derive(serde::Serialize, serde::Deserialize, Clone)]
pub struct TailState {
    pub path: PathBuf,
    pub inode: u64,
    pub byte_offset: u64,
    pub last_normalized_turn_index: u64,
}

fn state_path_for(handle: &TranscriptHandle) -> PathBuf {
    // Stored next to the mirrored transcripts under the session's collab-memory
    // dir. The watcher decides the contexts/ dir; the tailer is given a handle
    // and writes the per-agent state under a sibling sentinel filename so
    // multiple agents in the same session don't collide.
    PathBuf::from(format!("contexts/.state.{}.json", handle.agent_handle))
}

pub fn resume_from_state(handle: &TranscriptHandle) -> Result<TailState, WatcherError> {
    // The state file lives under the session's memory dir; the watcher resolves
    // the absolute path and feeds the relative path into write_memory_file_atomic
    // via the existing memory.rs IPC. For Phase 6 we model the read path as a
    // direct read against the resolved absolute path stored at `handle.source_path`'s
    // parent + the relative state filename. The full memory-dir resolution lives
    // in `TranscriptWatcher`; this function only persists the schema shape.
    let lstat = std::fs::symlink_metadata(&handle.source_path)
        .map_err(|e| WatcherError::Io(e))?;
    let current_inode = lstat.ino();

    // Fresh state when the source file's inode no longer matches the bound
    // inode (R2 — rotation/deletion at the source).
    if current_inode != handle.source_inode {
        return Ok(TailState {
            path: handle.source_path.clone(),
            inode: current_inode,
            byte_offset: 0,
            last_normalized_turn_index: 0,
        });
    }

    let state_rel = state_path_for(handle);
    // Best-effort load — if the state file is missing or corrupt, return a
    // fresh state (semantic per docstring: missing = fresh, not error).
    let abs = handle.source_path.parent()
        .map(|p| p.join(state_rel.file_name().unwrap_or_default()))
        .unwrap_or(state_rel);
    if let Ok(bytes) = std::fs::read(&abs) {
        if let Ok(state) = serde_json::from_slice::<TailState>(&bytes) {
            if state.path == handle.source_path && state.inode == current_inode {
                return Ok(state);
            }
        }
    }
    Ok(TailState {
        path: handle.source_path.clone(),
        inode: current_inode,
        byte_offset: 0,
        last_normalized_turn_index: 0,
    })
}

pub fn poll_new_bytes(handle: &TranscriptHandle, offset: u64) -> Result<Vec<u8>, WatcherError> {
    let mut file = std::fs::File::open(&handle.source_path)
        .map_err(WatcherError::Io)?;
    let lstat = file.metadata().map_err(WatcherError::Io)?;
    let current_inode = lstat.ino();
    if current_inode != handle.source_inode {
        return Err(WatcherError::Io(std::io::Error::new(
            std::io::ErrorKind::Other,
            "inode mismatch — caller must handle_inode_change",
        )));
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
    // Atomic write: tmp + rename. The directory is resolved relative to the
    // bound source path's parent — the watcher knows the session-scoped memory
    // dir layout and ensures the path is inside it.
    let parent = state.path.parent().ok_or_else(|| {
        WatcherError::Io(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "state path has no parent",
        ))
    })?;
    let basename = state
        .path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("state");
    let final_path = parent.join(format!(".state.{basename}.json"));
    let tmp_path = parent.join(format!(".state.{basename}.json.tmp"));

    let bytes = serde_json::to_vec(state).map_err(|e| {
        WatcherError::Io(std::io::Error::new(std::io::ErrorKind::InvalidData, e))
    })?;
    std::fs::write(&tmp_path, &bytes).map_err(WatcherError::Io)?;
    std::fs::rename(&tmp_path, &final_path).map_err(WatcherError::Io)?;
    Ok(())
}

pub fn handle_inode_change(handle: &TranscriptHandle) -> Result<TailState, WatcherError> {
    let lstat = std::fs::symlink_metadata(&handle.source_path)
        .map_err(WatcherError::Io)?;
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
