// FSEvents / inotify wiring layer.
//
// Owns notify-crate subscriptions and routes file-change events through to
// the Tailer. `TranscriptWatcher::start_if_needed` creates exactly one
// `RecommendedWatcher` per app process; this module manages registration
// of paths on that watcher.

use std::path::PathBuf;

use super::{TranscriptHandle, WatcherError};

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
    let _ = handle;
    todo!()
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
    let _ = (subscription, event_path);
    todo!()
}
