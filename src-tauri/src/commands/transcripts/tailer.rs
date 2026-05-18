// Per-stream byte tailer with inode-anchored offset persistence.
//
// IMPLEMENTER NOTE (post-review B1/P0): the planner-skeleton signatures on
// `resume_from_state(handle: &TranscriptHandle)` and
// `persist_offset(state: &TailState)` cannot meet their docstring contract
// ("state lives at session-<pid>/contexts/.state.json via shared-memory
// atomic write") because neither carries a reference to the collab-memory
// dir. The earlier implementer pass mistakenly derived state paths from
// the EXTERNAL transcript-source dir (e.g. `~/.claude/projects/<slug>/`),
// which violates the rev. 3 plan's "read-only access; never writes external
// paths" CONSTRAINT.
//
// Resolving this correctly requires either:
//   (a) a small planner touch-up: extend `TranscriptHandle` with a
//       `memory_dir: PathBuf` field (additive — no signature drift on
//       any function), and have `discover_session` populate it from the
//       caller-supplied context, OR
//   (b) extending the function signatures to accept `memory_dir: &Path`
//       (a scope-violation per implementer skill).
//
// Until that planner touch-up lands, these functions stay `todo!()` so we
// don't ship a known-wrong state location. `poll_new_bytes` is kept as a
// real implementation because it operates ONLY on the external (source)
// path and doesn't touch state at all.

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

pub fn resume_from_state(handle: &TranscriptHandle) -> Result<TailState, WatcherError> {
    let _ = handle;
    // Reverted post-review: prior implementation wrote state into the
    // external transcript root (B1 / P0 — violates the plan's
    // never-write-external-paths constraint). Requires planner touch-up
    // to surface `memory_dir` to this function before re-implementing.
    todo!("blocked on planner gap: needs memory_dir access — see module-level comment")
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
    let _ = state;
    // Reverted post-review: prior implementation wrote `.state.*.json`
    // beside the external source file. The correct destination is under
    // `session-<pid>/contexts/.state.<agent>.json` via
    // `memory::write_memory_file_atomic`. Requires planner touch-up to
    // surface `memory_dir` (or a state-path-resolver callback) into this
    // signature — see module-level comment.
    todo!("blocked on planner gap: needs memory_dir access — see module-level comment")
}

pub fn handle_inode_change(handle: &TranscriptHandle) -> Result<TailState, WatcherError> {
    let _ = handle;
    // Reverted post-review: depends on `persist_offset`, which is itself
    // gated on the planner touch-up. Until that lands, this stays `todo!()`.
    todo!("blocked on planner gap: depends on persist_offset — see module-level comment")
}

pub const MAX_POLL_BYTES: usize = 1 * 1024 * 1024;
