// FSEvents / inotify wiring layer.
//
// Owns notify-crate subscriptions and routes file-change events through to
// the Tailer. `TranscriptWatcher::start_if_needed` creates exactly one
// `RecommendedWatcher` per app process; this module manages registration
// of paths on that watcher.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};

use super::{Inner, NormalizeContext, TranscriptHandle, WatcherError};

/// Process-wide handle to the `TranscriptWatcher`'s `Inner` so this module's
/// free functions (whose signatures are committed by the planner and don't
/// take a `TranscriptWatcher` parameter) can reach the shared mutable state.
/// Installed exactly once by `TranscriptWatcher::start_if_needed`; cleared
/// only by process exit (the `Arc` keeps the `Inner` alive, but
/// `Inner.shutdown=true` after `shutdown()` short-circuits everything).
static WATCHER_INNER: OnceLock<Arc<Mutex<Inner>>> = OnceLock::new();

/// Install the `Inner` handle. Called once from
/// `TranscriptWatcher::start_if_needed`; subsequent calls are silent
/// no-ops (`OnceLock::set` is idempotent). Visibility: `pub(super)`
/// so the parent module (`transcripts`) can call it; not exported.
pub(super) fn install_inner(inner: Arc<Mutex<Inner>>) {
    let _ = WATCHER_INNER.set(inner);
}

// Debounce floor — coalesces FSEvents that fire within this window. macOS
// FSEvents has a documented ~250-1000ms native coalesce; this 100ms floor
// catches the rare per-line bursts during sustained appends without
// blowing past the P95 < 2s latency criterion.
const DEBOUNCE_MS: u128 = 100;

/// Opaque subscription handle returned by `subscribe_fsevents`. Stored by
/// `TranscriptWatcher` next to the `WatchToken` so unwatch can release it.
pub struct Subscription(pub u64);

/// Subscribe FSEvents to the transcript file's parent directory.
///
/// Per NB2: the underlying `notify::RecommendedWatcher` is held by
/// `TranscriptWatcher`; this function only registers a new path on it.
///
/// # Inputs
/// `handle`: the (PID, path) binding from `discover_session`.
///
/// # Returns
/// `Subscription` token to pass to `on_fs_event` routing tables.
///
/// # Errors
/// `WatcherError::Io` on inotify add / FSEvents start.
///
/// # Side effects
/// Registers a per-path callback on the shared `RecommendedWatcher`.
///
/// # Invariants
/// Subscribed path is the *parent directory* of `handle.source_path`, not
/// the file itself — JSONL writes via atomic-rename cause the watched inode
/// to change, which a file-level subscription misses on macOS.
///
/// # Concurrency
/// Internally synchronized via the watcher's notify mutex.
///
/// # Lifecycle
/// Called once per `TranscriptWatcher::watch`. Paired with
/// `TranscriptWatcher::unwatch` for de-registration.
///
/// # Test contract
/// Subscribing twice to overlapping parent dirs is allowed and results in
/// two distinct `Subscription` tokens. Each unsubscribe is independent.
pub fn subscribe_fsevents(handle: &TranscriptHandle) -> Result<Subscription, WatcherError> {
    let inner = WATCHER_INNER
        .get()
        .ok_or(WatcherError::NotStarted)?;

    // Watch the PARENT dir, not the file itself — per the docstring
    // invariant: JSONL writes via atomic-rename change the watched inode,
    // and file-level FSEvents subscriptions miss the new file under macOS.
    let parent = handle
        .source_path
        .parent()
        .ok_or_else(|| {
            WatcherError::Io(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "source_path has no parent",
            ))
        })?
        .to_path_buf();

    let mut g = inner.lock().map_err(|_| WatcherError::NotStarted)?;
    if g.shutdown {
        return Err(WatcherError::NotStarted);
    }

    g.next_id += 1;
    let sub_id = g.next_id;

    // Ref-count: only the first subscription for a given parent dir
    // actually invokes notify::Watcher::watch. Two adapters whose JSONLs
    // share a parent dir (e.g. two Claude Code agents in the same
    // project) share one notify registration but get distinct
    // Subscription tokens (matching the docstring's test contract).
    let prev = g.parent_dir_refs.get(&parent).copied().unwrap_or(0);
    g.parent_dir_refs.insert(parent.clone(), prev + 1);

    if prev == 0 {
        let watcher = g
            .watcher
            .as_mut()
            .ok_or(WatcherError::NotStarted)?;
        use notify::Watcher;
        // NonRecursive — JSONL writes happen directly in the parent dir;
        // recursive would inflate the event volume for adapter roots that
        // contain nested project dirs (Codex's date hierarchy in
        // particular).
        watcher
            .watch(&parent, notify::RecursiveMode::NonRecursive)
            .map_err(|e| {
                // Roll back the ref-count on failure so a future
                // subscribe_fsevents on the same parent doesn't think
                // notify is already listening.
                let cur = g.parent_dir_refs.get(&parent).copied().unwrap_or(1);
                let rolled = cur.saturating_sub(1);
                if rolled == 0 {
                    g.parent_dir_refs.remove(&parent);
                } else {
                    g.parent_dir_refs.insert(parent.clone(), rolled);
                }
                WatcherError::Io(std::io::Error::new(
                    std::io::ErrorKind::Other,
                    e.to_string(),
                ))
            })?;
    }

    Ok(Subscription(sub_id))
}

/// Callback invoked when notify reports activity on a subscribed path.
///
/// # Inputs
/// - `subscription`: which registration this event belongs to.
/// - `event_path`: path the event was for (may be sibling files in the
///   same parent dir — the routing layer filters).
///
/// # Returns
/// Unit; routes asynchronously to the Tailer.
///
/// # Errors
/// Cannot fail (errors are logged and swallowed; tailer poll retries).
///
/// # Side effects
/// Pokes the per-`Subscription` Tailer to call `poll_new_bytes`. Routing
/// is debounced internally to amortize FSEvents coalescing under macOS
/// (the documented ~250-1000ms floor — see P95 < 2s success criterion).
///
/// # Invariants
/// `event_path` events for files NOT matching the bound `source_path`
/// are filtered out. Only the bound file's events trigger Tailer activity.
///
/// # Concurrency
/// Invoked on the notify thread; routing handoff is non-blocking.
///
/// # Lifecycle
/// One call per kernel FSEvents notification after subscription.
///
/// # Test contract
/// Activity on a sibling file under the same parent dir MUST NOT
/// trigger a poll on the bound path. Activity on the bound path MUST
/// debounce: two events within 100ms result in one poll.
pub fn on_fs_event(subscription: &Subscription, event_path: &PathBuf) {
    // `subscription` is a contextual hint per the docstring ("which
    // registration this event belongs to"); routing is by `event_path`
    // matching `entry.handle.source_path` because notify reports the
    // affected path, not the original subscription id. The id is kept
    // in the signature for future indexed routing (an entries-by-sub-id
    // map could speed the linear scan below when N_agents > ~10).
    let _ = subscription;

    let inner = match WATCHER_INNER.get() {
        Some(i) => i,
        None => return,
    };

    // Phase 1 under the lock: identify the matching entry + check
    // debounce. Reconstruct the few values we need for the heavy IO work
    // before releasing. `TranscriptHandle` doesn't derive Clone (planner-
    // committed shape); we field-by-field rebuild to avoid the derive.
    let (token_id, handle, offset, turn_index, adapter): (
        u64,
        TranscriptHandle,
        u64,
        u64,
        &'static dyn super::TranscriptAdapter,
    ) = {
        let mut g = match inner.lock() {
            Ok(g) => g,
            Err(_) => return,
        };
        if g.shutdown {
            return;
        }
        let now = std::time::Instant::now();
        let mut hit: Option<u64> = None;
        for (token_id, entry) in g.entries.iter_mut() {
            // Cycle F: pending entries have no source_path to match
            // against — skip them. Events fired against the parent
            // dir before discovery completes are not relevant.
            let Some(handle) = entry.handle.as_ref() else {
                continue;
            };
            if &handle.source_path == event_path {
                let should_process = match entry.last_event_at {
                    Some(prev) if now.duration_since(prev).as_millis() < DEBOUNCE_MS => false,
                    _ => true,
                };
                if should_process {
                    entry.last_event_at = Some(now);
                    hit = Some(*token_id);
                }
                break;
            }
        }
        let token_id = match hit {
            Some(t) => t,
            None => return, // sibling-file event or debounced — drop.
        };
        let entry = g.entries.get(&token_id).expect("entry just located");
        // The `hit` filter only fires on populated entries, so handle
        // and tail_state are guaranteed Some here.
        let handle_ref = entry
            .handle
            .as_ref()
            .expect("populated entry has handle (filtered above)");
        let tail_state_ref = entry
            .tail_state
            .as_ref()
            .expect("populated entry has tail_state (filtered above)");
        (
            token_id,
            TranscriptHandle {
                agent_handle: handle_ref.agent_handle.clone(),
                adapter_id: handle_ref.adapter_id,
                source_path: handle_ref.source_path.clone(),
                source_inode: handle_ref.source_inode,
                pid: handle_ref.pid,
                memory_dir: handle_ref.memory_dir.clone(),
            },
            tail_state_ref.byte_offset,
            tail_state_ref.last_normalized_turn_index,
            entry.adapter,
        )
    };

    // Phase 2 (lock-released): poll + parse + normalize.
    let new_bytes = match super::tailer::poll_new_bytes(&handle, offset) {
        Ok(b) => b,
        Err(super::WatcherError::SourceRotation) => {
            // R2 recovery: source rotated under us (CLI /clear, Codex
            // rollout switch, plain mv). Re-stat the source via
            // handle_inode_change — it returns a fresh TailState with
            // the new inode + byte_offset=0 AND persists it to
            // .state.json for crash resume. Update the in-memory entry
            // so the next event polls from the new file at the right
            // offset; without this update, the next event reads the
            // stale tail_state from entries and the fix is silently
            // undone. handle_inode_change failures (e.g. source genuinely
            // gone) leave the entry untouched and the next event will
            // retry through the same path.
            if let Ok(new_state) = super::tailer::handle_inode_change(&handle) {
                if let Ok(mut g) = inner.lock() {
                    if let Some(entry) = g.entries.get_mut(&token_id) {
                        entry.tail_state = Some(new_state);
                    }
                }
            }
            return;
        }
        Err(_) => return, // tailer poll-failure: retry on next event.
    };
    if new_bytes.is_empty() {
        return;
    }

    let (raw_turns, consumed) = adapter.parse_native_lines(&new_bytes);
    let adapter_version = adapter.adapter_version();
    let mut next_turn_index = turn_index;

    // Build a fresh TranscriptWatcher façade for the append step. We
    // can't reach the Tauri State<> from this thread, but we own an
    // Arc clone of the same Inner that powers the live watcher — so
    // a temporary TranscriptWatcher pointing at the same Arc behaves
    // identically. (The Drop on this temporary doesn't touch Inner.)
    let façade = super::TranscriptWatcher {
        inner: inner.clone(),
    };
    let token = super::WatchToken(token_id);

    for raw in raw_turns {
        let chunk_relative = raw.source_offset;
        let ctx = NormalizeContext {
            agent_handle: &handle.agent_handle,
            adapter_version,
            turn_index: next_turn_index,
        };
        if let Some(mut turn) = adapter.normalize(raw, ctx) {
            // Translate chunk-relative offset → absolute file offset
            // per touch-up D contract. Caller of normalize() (us) adds
            // the current TailState.byte_offset.
            turn.source_offset = offset + chunk_relative;
            let _ = façade.append_normalized_turn(&token, turn);
        }
        next_turn_index += 1;
    }

    // Phase 3 (lock + state persist): advance byte_offset and turn_index,
    // persist .state.json for crash resume.
    let new_state = super::tailer::TailState {
        path: handle.source_path.clone(),
        inode: handle.source_inode,
        byte_offset: offset + consumed as u64,
        last_normalized_turn_index: next_turn_index,
    };
    let _ = super::tailer::persist_offset(&new_state);
    if let Ok(mut g) = inner.lock() {
        if let Some(entry) = g.entries.get_mut(&token_id) {
            entry.tail_state = Some(new_state);
        }
    }
}

/// Internal helper that lets `on_fs_event`'s façade pattern stay tidy
/// (the public function takes `&PathBuf` per the trait; this private
/// variant takes `&Path` so callers within this module can pass either).
#[allow(dead_code)]
fn _path_compat(_p: &Path) {}
