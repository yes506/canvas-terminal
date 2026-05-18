// Per-stream byte tailer with inode-anchored offset persistence.
//
// One `Tailer` per active `WatchToken`. Reads bounded chunks of new bytes
// from the bound JSONL, hands them to the adapter's `parse_native_lines`,
// and persists the resulting offset+inode to `.state.json` via
// `write_memory_file_atomic`.

use std::path::PathBuf;

use super::{TranscriptHandle, WatcherError};

/// Resumable tail state — written to and read from
/// `session-<pid>/contexts/.state.json` per agent.
#[derive(serde::Serialize, serde::Deserialize, Clone)]
pub struct TailState {
    pub path: PathBuf,
    /// `lstat` inode at last successful poll. Compared on resume to detect
    /// rotation/deletion at the source (R2).
    pub inode: u64,
    /// Bytes consumed so far. `parse_native_lines` returns how many bytes
    /// to advance — partial trailing lines are NOT consumed.
    pub byte_offset: u64,
    /// Last `turn_index` minted by `normalize` (independent of skip filter
    /// — increments even when the turn produced `None`).
    pub last_normalized_turn_index: u64,
}

/// Read the persisted state, validate inode against current `lstat`, and
/// return either the resumable state or a fresh-start state.
///
/// # Inputs
/// `handle`: the binding that identifies which `.state.json` entry to read.
///
/// # Returns
/// `Ok(TailState)` ready to drive the next poll. If `.state.json` has no
/// entry for this handle OR the stored inode differs from `lstat(path)`'s
/// current inode (R2: source rotation/deletion), returns a fresh
/// `TailState { byte_offset: 0, last_normalized_turn_index: 0, ... }`.
///
/// # Errors
/// - `WatcherError::Io` if `.state.json` cannot be read AND a fresh state
///   cannot be created.
/// - `WatcherError::StateCorrupted` if `.state.json` parses but its schema
///   is unknown.
///
/// # Side effects
/// One read of `.state.json` (cached after first read per session).
///
/// # Invariants
/// On `Ok`, returned `TailState::path` equals `handle.source_path`. If the
/// inode mismatch path was taken, `byte_offset` is 0.
///
/// # Concurrency
/// Safe to call concurrently across handles; per-handle state is keyed
/// by `agent_handle`.
///
/// # Lifecycle
/// Called once per `TranscriptWatcher::watch` immediately after
/// subscription registration.
///
/// # Test contract
/// Stored state with `inode=42`, current `lstat` returning `inode=99` MUST
/// reset offset to 0 and emit no error. Missing `.state.json` entry MUST
/// produce a fresh state, not an error.
pub fn resume_from_state(handle: &TranscriptHandle) -> Result<TailState, WatcherError> {
    let _ = handle;
    todo!()
}

/// Read up to `MAX_POLL_BYTES` of new bytes from `path` starting at `offset`.
///
/// # Inputs
/// - `handle`: identifies the bound transcript.
/// - `offset`: byte offset to read from (matches `TailState::byte_offset`).
///
/// # Returns
/// `Ok(Vec<u8>)` containing the bytes read. May be empty if the source
/// hasn't grown since the last poll. May end mid-line — the adapter's
/// `parse_native_lines` handles partial trailing lines.
///
/// # Errors
/// `WatcherError::Io` on read failure or if the inode at `path` no longer
/// matches the bound inode (caller must call `handle_inode_change`).
///
/// # Side effects
/// One `pread`-style read on the source file.
///
/// # Invariants
/// Returned bytes have length ≤ `MAX_POLL_BYTES`. The source file's read
/// position is NOT advanced (we use offset-based reads, not stateful fds).
///
/// # Concurrency
/// One poll in flight per handle; the watcher serializes them per token.
///
/// # Lifecycle
/// Called by `on_fs_event` routing layer after debounce.
///
/// # Test contract
/// Polling at `offset == file_size` returns empty `Vec`, not error.
/// Polling after the source file's inode changed (detected by mismatched
/// `lstat`) returns `WatcherError::Io`.
pub fn poll_new_bytes(handle: &TranscriptHandle, offset: u64) -> Result<Vec<u8>, WatcherError> {
    let _ = (handle, offset);
    todo!()
}

/// Persist updated `TailState` to `.state.json` via atomic write.
///
/// # Inputs
/// `state`: the post-poll state to persist.
///
/// # Returns
/// `Ok(())` once the new state is visible to readers.
///
/// # Errors
/// `WatcherError::Io` on write failure.
///
/// # Side effects
/// Single call to `memory.rs::write_memory_file_atomic` against the
/// `.state.json` path (rename-based, fsync'd — N2).
///
/// # Invariants
/// Readers never see a half-written `.state.json` (atomic-rename
/// guarantee). If the prior state had a higher `byte_offset`, writing a
/// lower one is allowed (rotation reset case — caller handles inode bump).
///
/// # Concurrency
/// Concurrent writes for distinct agents are independent — keyed by
/// `state.path` inside the JSON document. The atomic-rename pattern means
/// concurrent writers will race for the final rename, last-writer-wins;
/// the watcher serializes within an agent.
///
/// # Lifecycle
/// Called after each successful `poll_new_bytes` + `parse_native_lines`
/// pass, with `byte_offset` advanced by the parser's `consumed_bytes`.
///
/// # Test contract
/// Crash between tmp-write and rename leaves the prior `.state.json`
/// intact (atomic-rename invariant). After crash recovery, `resume_from_state`
/// returns the pre-crash state.
pub fn persist_offset(state: &TailState) -> Result<(), WatcherError> {
    let _ = state;
    todo!()
}

/// Reset offset to 0 and re-bind inode on detected source rotation.
///
/// # Inputs
/// `handle`: the binding whose inode mismatch was detected.
///
/// # Returns
/// `Ok(TailState)` with byte_offset=0 and the freshly-read inode.
///
/// # Errors
/// `WatcherError::Io` if `lstat` on the new file fails.
///
/// # Side effects
/// Calls `persist_offset` with the reset state. Does NOT replay any
/// content from before the rotation point — pre-rotation turns are
/// considered "already mirrored" for any prior tailer pass, and are
/// not re-mirrored from the new source file.
///
/// # Invariants
/// After return, the new `TailState::inode` matches `lstat(path).inode`
/// at the moment of return.
///
/// # Concurrency
/// Mutually exclusive with `poll_new_bytes` on the same handle.
///
/// # Lifecycle
/// Called from `poll_new_bytes` when it detects an inode mismatch, OR
/// called from `resume_from_state` on the same condition at startup.
///
/// # Test contract
/// Inducing a `mv source other; touch source` between two polls MUST
/// cause this function to fire on the second poll and reset offset
/// to 0. The new `byte_offset` MUST be 0.
pub fn handle_inode_change(handle: &TranscriptHandle) -> Result<TailState, WatcherError> {
    let _ = handle;
    todo!()
}

/// Read-bound for a single poll. Mirrors the choice in `memory.rs` —
/// callers chunk under this to avoid blocking on huge appends.
pub const MAX_POLL_BYTES: usize = 1 * 1024 * 1024;
