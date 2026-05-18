// Cross-tool agent context surfacing — feature root.
//
// Mirrors each collaborator agent's tool-persisted transcript (Claude Code
// JSONL / Codex rollout / Gemini chat) into the shared collab-memory layer,
// normalized to a tool-agnostic `NormalizedTurn` record. Real-time tailing
// via notify/fsevents; one-way (tool → shared memory). Adapter trait is the
// system-lane deliverable; per K3 the production adapter set is fixed
// (Claude Code + Codex CLI + Gemini CLI). Extensibility is proven by a
// test-only fixture at `src-tauri/tests/transcript_adapter_contract.rs`.

pub mod adapters;
pub mod fs_gate;
pub mod tailer;
pub mod watcher;

use std::collections::HashMap;
use std::io::Write;
use std::os::unix::fs::OpenOptionsExt;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

/// Canonical form version emitted in every `NormalizedTurn`. Bump on any
/// breaking field change. Frontend refuses to render records with a higher
/// version than it knows (forward-compat insurance per R3).
pub const NORMALIZED_SCHEMA_VERSION: u32 = 1;

/// Soft cap on the active mirror file before rotation fires.
/// Sits comfortably under `memory.rs::MAX_MEMORY_FILE_SIZE` (10 MB) so the
/// reader IPC can always single-call.
pub const ACTIVE_FILE_BYTE_CAP: u64 = 8 * 1024 * 1024;

/// Stable across-restart identifier for a (PID, transcript file) binding.
/// Returned by `TranscriptAdapter::discover_session`.
///
/// All fields are filed at binding-time and are immutable for the life of the
/// handle. Mutable per-stream state that evolves with the source file (live
/// inode after rotation, current byte offset) lives in `Tailer::TailState`,
/// NOT here. See `source_inode` invariant below.
pub struct TranscriptHandle {
    /// Bare CT handle — e.g. "claude3". Display layer adds `@` (W4).
    pub agent_handle: String,
    /// Adapter `tool_id()` value — `"claude_code"` / `"codex"` / `"gemini"`.
    pub adapter_id: &'static str,
    /// Absolute path to the tool's native JSONL.
    pub source_path: PathBuf,
    /// `lstat` inode at discovery — **FROZEN at binding-time**. Compared
    /// on resume to detect rotation at the source (Claude Code `/clear`,
    /// Codex rollout switch). The LIVE inode after rotation is tracked by
    /// `Tailer::TailState::inode`; post-bind callers MUST NOT re-read this
    /// field. Resolves codex2 Major 6: rotation mutability lives in
    /// TailState, not on the Handle.
    pub source_inode: u64,
    /// CLI process id — discovered via `lsof -p` (macOS) / `/proc/<pid>/fd`
    /// (Linux) one-time at session-bind (M8).
    pub pid: i32,
    /// Session memory directory the Tailer writes its `.state.json` into.
    /// Populated by `TranscriptWatcher::watch` from `memory::get_memory_dir()`
    /// at watch-registration time — e.g.
    /// `~/.cache/canvas-terminal/collab-memory/session-<pid>`.
    ///
    /// Invariant: Tailer state I/O (`resume_from_state`, `persist_offset`,
    /// `handle_inode_change`) MUST write inside this directory, NEVER inside
    /// `source_path`'s parent (the external transcript root is read-only by
    /// the peer-context-mirror "one-way mirror" rule). Resolves claude2 B1 /
    /// codex2 B2 / codex3 P0 — the prior implementer cycle reverted three
    /// Tailer items because the trait offered no in-bounds writable path.
    pub memory_dir: PathBuf,
}

/// Opaque registration token returned by `TranscriptWatcher::watch`. Passed
/// back to `unwatch` to release the registration.
pub struct WatchToken(pub u64);

/// Canonical mirrored record format. One per accepted turn in
/// `session-<pid>/contexts/<agent>.jsonl`.
#[derive(serde::Serialize, serde::Deserialize)]
pub struct NormalizedTurn {
    pub normalized_schema_version: u32,
    pub source_tool: String,
    pub source_tool_version: Option<String>,
    pub adapter_version: String,
    pub agent_handle: String,
    pub ts_iso8601: String,
    pub ts_source: TsSource,
    pub role: TurnRole,
    pub text_visible: String,
    pub turn_index: u64,
    pub source_offset: u64,
}

#[derive(serde::Serialize, serde::Deserialize)]
pub enum TsSource {
    /// Timestamp lifted from the source tool's own JSONL field.
    Tool,
    /// Timestamp captured by Canvas Terminal at normalize-time because the
    /// source line carried no usable timestamp.
    Ct,
}

#[derive(serde::Serialize, serde::Deserialize)]
pub enum TurnRole {
    User,
    Assistant,
}

/// Per-adapter native-block inclusion policy. R4 default: include only
/// definitively user-or-assistant visible text; exclude `thinking`,
/// `tool_use`, `tool_result`, `image`, `redacted_thinking`, `system`.
pub struct ContentBlockTable {
    pub include: &'static [&'static str],
    pub exclude: &'static [&'static str],
}

/// One raw turn parsed from the native JSONL; pre-normalize.
pub struct RawTurn {
    pub raw_payload: serde_json::Value,
    /// **CHUNK-RELATIVE** offset — measured from the start of the `bytes`
    /// slice that `TranscriptAdapter::parse_native_lines` was called with.
    /// Callers (`Tailer` / `TranscriptWatcher`) MUST add their current
    /// `TailState::byte_offset` to translate to an absolute file offset.
    /// Adapters are stateless about their caller's accumulated file
    /// position; the absolute-offset translation lives one layer up.
    /// Resolves codex2 B4 / codex3 P1.
    pub source_offset: u64,
}

/// Context injected into `normalize()` by the watcher; carries the CT-side
/// identity that source transcripts cannot know (M4).
pub struct NormalizeContext<'a> {
    pub agent_handle: &'a str,
    pub adapter_version: &'a str,
    pub turn_index: u64,
}

/// Errors during `discover_session`.
#[derive(Debug)]
pub enum DiscoveryError {
    /// fs_gate rejected the candidate path (escape, symlink, wrong root).
    Gated(String),
    /// `lsof -p` / `/proc/<pid>/fd` returned no open file matching this
    /// adapter's path pattern.
    NoMatchingFd,
    /// IO error invoking lsof or walking /proc.
    Io(std::io::Error),
}

/// Errors during watcher operations.
#[derive(Debug)]
pub enum WatcherError {
    GateRejected(String),
    Io(std::io::Error),
    StateCorrupted(String),
    NotStarted,
    /// Source-file rotation detected mid-poll (the inode of
    /// `source_path` no longer matches the inode the `TranscriptHandle`
    /// was bound to at discovery time). R2 recovery: the caller should
    /// invoke `tailer::handle_inode_change` to re-stat the source,
    /// rebind to the new inode, reset `byte_offset` to 0, and persist
    /// the fresh `TailState`. Distinct from `Io` because the receiver
    /// (`watcher::on_fs_event`) takes a different code path for rotation
    /// — rebind-and-retry rather than swallow-and-wait.
    SourceRotation,
}

/// Contract for mirroring one CLI tool's persisted transcripts.
///
/// SUCCESS CRITERION: adding a transcript adapter for an EXISTING registered
/// tool requires zero changes outside the new `adapters/<tool>.rs` file.
/// Watching, rotation, and IPC live on `TranscriptWatcher`; adapters carry
/// only per-tool source-format concerns (Q5 layering).
pub trait TranscriptAdapter: Send + Sync {
    /// Stable identifier for this adapter.
    ///
    /// # Returns
    /// `&'static str` such as `"claude_code"`. Used as the path key in
    /// `fs_gate.rs` allow-list and as `TranscriptHandle::adapter_id`.
    ///
    /// # Errors
    /// Cannot fail.
    ///
    /// # Side effects
    /// None.
    ///
    /// # Invariants
    /// Value is unique across all registered adapters; never collides with
    /// `ToolId` from `src/types/collaborator.ts`. Match-by-equality on this
    /// value is safe across processes.
    ///
    /// # Concurrency
    /// Pure; thread-safe.
    ///
    /// # Lifecycle
    /// Called by `TranscriptWatcher::watch` and `fs_gate::check_transcript_root`.
    ///
    /// # Test contract
    /// Returns the same value across calls within one process. Distinct from
    /// the same trait method on every other adapter.
    fn tool_id(&self) -> &'static str;

    /// Adapter implementation version. Independent of `source_tool_version`.
    ///
    /// # Returns
    /// `&'static str` matching the adapter file's `ADAPTER_VERSION` constant.
    /// Bumped when normalization rules / inclusion table / discovery
    /// behavior changes (T3).
    ///
    /// # Errors
    /// Cannot fail.
    ///
    /// # Side effects
    /// None.
    ///
    /// # Invariants
    /// Semver-like string; never `null` (per X4, source_tool_version may be
    /// null but adapter_version is always present).
    ///
    /// # Concurrency
    /// Pure; thread-safe.
    ///
    /// # Lifecycle
    /// Stamped into every `NormalizedTurn` produced by `normalize()`.
    ///
    /// # Test contract
    /// Same value across all calls in one process; format parseable as
    /// `MAJOR.MINOR.PATCH`.
    fn adapter_version(&self) -> &'static str;

    /// Locate which transcript file the given child PID has open.
    ///
    /// # Inputs
    /// - `agent_handle`: bare CT handle (`"claude3"`); never the `@`-prefixed
    ///   display form.
    /// - `pid`: child PID returned by the PTY spawn. For shell-fallback
    ///   launches this is already the CLI (the typed command uses `exec`,
    ///   K6) so a direct fd lookup is sufficient.
    /// - `spawned_at_unix_ms`: tiebreaker for the rare race where two
    ///   simultaneous sessions in the same project dir create JSONLs of
    ///   the same inode bucket.
    ///
    /// # Returns
    /// `TranscriptHandle` carrying the resolved path + inode + adapter id.
    ///
    /// # Errors
    /// - `DiscoveryError::NoMatchingFd` if the PID has no open file matching
    ///   the adapter's pattern (e.g. CLI hasn't created a session yet).
    /// - `DiscoveryError::Gated` if the resolved path is outside the
    ///   adapter's allow-root.
    /// - `DiscoveryError::Io` for OS-layer failures.
    ///
    /// # Side effects
    /// One-time call to `lsof -p` (macOS) / read of `/proc/<pid>/fd` (Linux)
    /// per binding. Result is cached by `TranscriptWatcher::watch` — must
    /// NEVER be called inside the tailer loop (M8).
    ///
    /// # Invariants
    /// The returned `source_path` is canonicalized via `fs_safety` and
    /// inside the adapter's allow-list root.
    ///
    /// # Concurrency
    /// Forks a subprocess on macOS; expensive. Callers that hold locks
    /// should drop them before calling.
    ///
    /// # Lifecycle
    /// Called once at agent opt-in publish (or on explicit re-bind). NEVER
    /// inside the tailer poll loop.
    ///
    /// # Test contract
    /// Given a PID with no open fds matching the pattern, returns
    /// `NoMatchingFd` rather than guessing by mtime. Returned `source_inode`
    /// matches `lstat(source_path)` at call time.
    fn discover_session(
        &self,
        agent_handle: &str,
        pid: i32,
        spawned_at_unix_ms: i64,
    ) -> Result<TranscriptHandle, DiscoveryError>;

    /// Static table describing which native content blocks propagate.
    ///
    /// # Returns
    /// Reference to a `'static` table. Default per R4: include only
    /// definitively user-or-assistant visible text blocks; exclude
    /// `thinking`, `tool_use`, `tool_result`, `image`, `redacted_thinking`,
    /// `system`. Adapters MAY tighten the include set but MUST NOT relax
    /// the exclude set (the listed types are policy, not adapter choice).
    ///
    /// # Errors
    /// Cannot fail.
    ///
    /// # Side effects
    /// None.
    ///
    /// # Invariants
    /// Returned reference outlives the adapter instance (`'static`).
    ///
    /// # Concurrency
    /// Pure; thread-safe.
    ///
    /// # Lifecycle
    /// Consulted by `normalize()` for every raw turn.
    ///
    /// # Test contract
    /// Returned `exclude` slice CONTAINS `"thinking"`, `"tool_use"`,
    /// `"tool_result"`, `"image"`, `"redacted_thinking"`, `"system"`.
    /// Adapter-specific include set is documented in the adapter's
    /// module-level docstring.
    fn inclusion_table(&self) -> &ContentBlockTable;

    /// Parse new bytes from a JSONL append, partial-line aware.
    ///
    /// # Inputs
    /// `bytes`: raw bytes since the last successful parse (may end mid-line).
    ///
    /// # Returns
    /// Tuple `(turns, consumed_bytes)`. `turns` is every fully-parsed line
    /// (one `RawTurn` per JSONL line that succeeded). `consumed_bytes` is the
    /// number of bytes the caller should advance the read offset by — partial
    /// trailing lines are NOT consumed and will be re-presented on the next
    /// poll.
    ///
    /// **`RawTurn.source_offset` is CHUNK-RELATIVE** — measured from the start
    /// of the `bytes` slice passed in this call (not from the start of the
    /// source file). Callers (`Tailer` / `TranscriptWatcher`) MUST add their
    /// current `TailState::byte_offset` to obtain the absolute file offset
    /// when persisting to `NormalizedTurn::source_offset`. The trait keeps
    /// adapters stateless about their caller's accumulated file position;
    /// the absolute-offset translation lives one layer up. Resolves codex2
    /// B4 / codex3 P1 (chunk-relative-vs-absolute ambiguity that the prior
    /// implementer cycle implemented but did not document).
    ///
    /// # Errors
    /// Per-line parse failures are silent: malformed lines are skipped and
    /// their bytes are still marked consumed (otherwise we'd loop forever on
    /// a poisoned line). Adapter implementations MAY emit a tracing event;
    /// they MUST NOT propagate the error.
    ///
    /// # Side effects
    /// None (pure parsing).
    ///
    /// # Invariants
    /// `consumed_bytes <= bytes.len()`. If `bytes` ends with a complete line
    /// (newline terminator), `consumed_bytes == bytes.len()`. If `bytes` is
    /// empty, returns `(vec![], 0)`. Each `RawTurn::source_offset` lies in
    /// the half-open range `[0, consumed_bytes)` (chunk-relative; see
    /// Returns).
    ///
    /// # Concurrency
    /// Pure; thread-safe.
    ///
    /// # Lifecycle
    /// Called by the Tailer after each `poll_new_bytes` returns non-empty.
    /// The Tailer is responsible for adding its `byte_offset` to each
    /// `RawTurn::source_offset` before forwarding to `normalize` /
    /// `append_normalized_turn`.
    ///
    /// # Test contract
    /// Input ending with `"...partial` (no newline) MUST result in
    /// `consumed_bytes < bytes.len()` so the next poll re-reads. Malformed
    /// JSON on line N MUST NOT prevent line N+1 from being parsed. For a
    /// two-line input where line 1 ends at byte 50 and line 2 ends at byte
    /// 100, `RawTurn[0].source_offset` is 0 and `RawTurn[1].source_offset`
    /// is 51 (chunk-start of each line) — NOT the absolute file offset.
    fn parse_native_lines(&self, bytes: &[u8]) -> (Vec<RawTurn>, usize);

    /// Convert a raw turn into a `NormalizedTurn` ready for mirroring.
    ///
    /// # Inputs
    /// - `raw`: one parsed JSONL line from this adapter's source.
    /// - `ctx`: CT-injected identity (agent_handle, adapter_version,
    ///   turn_index). M4: source transcripts don't know CT's handle layer.
    ///
    /// # Returns
    /// `Some(NormalizedTurn)` when the raw turn produces non-empty
    /// `text_visible` after applying the inclusion table.
    /// `None` (M6 SKIP) when the turn's content was entirely in the
    /// exclude set (e.g. a Claude turn whose only block was `tool_use`).
    /// `turn_index` still increments per-call regardless of return value
    /// so consumers can detect gaps.
    ///
    /// # Errors
    /// Adapter implementations choose whether to be lenient on missing
    /// fields. The contract is: never panic; either return `None` or a
    /// best-effort `NormalizedTurn` with `ts_source = Ct` and a synthesized
    /// timestamp.
    ///
    /// # Side effects
    /// None (pure transformation).
    ///
    /// # Invariants
    /// Returned `NormalizedTurn::normalized_schema_version` equals
    /// `NORMALIZED_SCHEMA_VERSION`. `text_visible` is non-empty if returned.
    /// `agent_handle` equals `ctx.agent_handle`.
    ///
    /// # Concurrency
    /// Pure; thread-safe.
    ///
    /// # Lifecycle
    /// Called per `RawTurn` produced by `parse_native_lines`.
    ///
    /// # Test contract
    /// A raw turn whose content is exclusively `thinking` blocks returns
    /// `None`. A raw turn with `text` blocks returns `Some` whose
    /// `text_visible` is the concatenation of those text blocks.
    fn normalize(&self, raw: RawTurn, ctx: NormalizeContext<'_>) -> Option<NormalizedTurn>;
}

/// Per-token state record stored inside the watcher's internal map.
/// Lives behind `Inner`'s `Mutex`; mutability is at the entry level
/// (e.g. `tail_state.byte_offset` advances on each successful poll;
/// `last_event_at` updates on each fired notification for debounce).
pub(in crate::commands::transcripts) struct Entry {
    pub(in crate::commands::transcripts) handle: TranscriptHandle,
    pub(in crate::commands::transcripts) subscription_id: u64,
    pub(in crate::commands::transcripts) tail_state: tailer::TailState,
    pub(in crate::commands::transcripts) adapter: &'static dyn TranscriptAdapter,
    /// Last-fired debounce timestamp. None until the first event arrives;
    /// after that, on_fs_event refuses to re-poll within 100ms of this
    /// stamp (coalesces FSEvents under macOS's ~250-1000ms floor — see
    /// watcher.rs::on_fs_event docstring).
    pub(in crate::commands::transcripts) last_event_at: Option<std::time::Instant>,
}

/// Internal mutable state of `TranscriptWatcher`. Held behind one `Mutex`
/// inside an `Arc` so `watcher.rs::subscribe_fsevents` / `on_fs_event`
/// can hold their own clone via `OnceLock` (the notify callback runs on
/// the notify thread, which doesn't have direct access to the Tauri
/// `State<TranscriptWatcher>`).
pub(in crate::commands::transcripts) struct Inner {
    /// notify-crate watcher. `None` until `start_if_needed` promotes to
    /// `Some`; cleared on `shutdown()` (drops the underlying FSEvents
    /// thread).
    pub(in crate::commands::transcripts) watcher: Option<notify::RecommendedWatcher>,
    /// `WatchToken.0` → Entry. Mutable per-token state lives here.
    pub(in crate::commands::transcripts) entries: HashMap<u64, Entry>,
    /// Parent-dir → subscription ref-count. FSEvents subscribes at the
    /// parent dir (NB2 — JSONL writes via atomic-rename change the
    /// watched inode), so multiple agents whose JSONLs share a parent
    /// dir share one notify registration. Decrementing to zero
    /// `notify::Watcher::unwatch`-es the path.
    pub(in crate::commands::transcripts) parent_dir_refs: HashMap<PathBuf, u32>,
    /// Monotonic counter for both `WatchToken` and `Subscription` ids.
    pub(in crate::commands::transcripts) next_id: u64,
    /// Set to true by `shutdown()`. After this, new `watch()` calls
    /// return `WatcherError::NotStarted`; outstanding tokens'
    /// `unwatch` becomes a silent no-op (the entries map is cleared).
    pub(in crate::commands::transcripts) shutdown: bool,
}

/// Centralized watcher owning the lifecycle of every active mirror stream.
///
/// Per Q5: lifecycle is on this struct, not on `TranscriptAdapter`. Adapters
/// supply per-tool normalization; the watcher owns FSEvents subscriptions,
/// rotation, `.state.json`, and the unwatch teardown path. Stored in
/// Tauri `State<>`; single instance per app.
///
/// Internal state lives in `Inner` behind `Arc<Mutex<>>` so the
/// `watcher.rs` callback (which runs on the notify thread) can access
/// it via a `OnceLock` installed at `start_if_needed` time. Without
/// this indirection the notify closure would have no way back to the
/// `TranscriptWatcher` (Tauri `State<>` is only available with an
/// `AppHandle`, and the notify thread doesn't carry one).
pub struct TranscriptWatcher {
    pub(in crate::commands::transcripts) inner: Arc<Mutex<Inner>>,
}

impl TranscriptWatcher {
    /// Construct a new instance. Does NOT start FSEvents — `start_if_needed`
    /// does that lazily.
    ///
    /// # Inputs
    /// None.
    ///
    /// # Returns
    /// A `TranscriptWatcher` in the dormant state.
    ///
    /// # Errors
    /// Cannot fail at construction.
    ///
    /// # Side effects
    /// Allocates internal collections but performs no IO and starts no
    /// background threads.
    ///
    /// # Invariants
    /// Initial ref-count is 0; no FSEvents handles registered.
    ///
    /// # Concurrency
    /// Construction is synchronous and single-threaded by definition.
    ///
    /// # Lifecycle
    /// Called from `lib.rs::setup` and stored in Tauri `State<>`.
    ///
    /// # Test contract
    /// Calling `shutdown()` immediately after `new()` is a no-op.
    pub fn new() -> Self {
        Self {
            inner: Arc::new(Mutex::new(Inner {
                watcher: None,
                entries: HashMap::new(),
                parent_dir_refs: HashMap::new(),
                next_id: 0,
                shutdown: false,
            })),
        }
    }

    /// Lazy-start the FSEvents thread on first opt-in publish. Idempotent.
    ///
    /// # Inputs
    /// None.
    ///
    /// # Returns
    /// `Ok(())` whether already started or just started.
    ///
    /// # Errors
    /// `WatcherError::Io` if FSEvents/inotify init fails.
    ///
    /// # Side effects
    /// On first call only: spawns the FSEvents subscription thread and
    /// allocates the notify crate's `RecommendedWatcher`.
    ///
    /// # Invariants
    /// After `Ok` returns, the FSEvents thread is running and ready to
    /// receive `watch()` registrations. Calling again is a no-op.
    ///
    /// # Concurrency
    /// Internally synchronized; safe to call from multiple Tauri IPC
    /// handlers concurrently.
    ///
    /// # Lifecycle
    /// Called by `watch()`. Frontend never calls this directly.
    ///
    /// # Test contract
    /// Two concurrent first-time calls result in exactly one FSEvents
    /// thread (test by inspecting thread-name count).
    pub fn start_if_needed(&self) -> Result<(), WatcherError> {
        // Fast-path: already started or shut down.
        {
            let g = self
                .inner
                .lock()
                .map_err(|_| WatcherError::NotStarted)?;
            if g.shutdown {
                return Err(WatcherError::NotStarted);
            }
            if g.watcher.is_some() {
                return Ok(());
            }
        }

        // Install OnceLock so watcher.rs::subscribe_fsevents / on_fs_event
        // can reach the Inner from the notify-thread closure context.
        watcher::install_inner(self.inner.clone());

        // notify's RecommendedWatcher invokes its callback on its own
        // background thread. We route each event path through on_fs_event,
        // which scans entries for a matching source_path and triggers the
        // poll→parse→normalize→append pipeline. Subscription(0) is a
        // placeholder — on_fs_event routes by event_path, not by id.
        let new_watcher = notify::recommended_watcher(
            move |res: notify::Result<notify::Event>| {
                if let Ok(event) = res {
                    for path in &event.paths {
                        watcher::on_fs_event(&watcher::Subscription(0), path);
                    }
                }
                // Errors are logged-and-swallowed per the watcher.rs
                // on_fs_event docstring: tailer poll retries on next event.
            },
        )
        .map_err(|e| {
            WatcherError::Io(std::io::Error::new(
                std::io::ErrorKind::Other,
                e.to_string(),
            ))
        })?;

        let mut g = self
            .inner
            .lock()
            .map_err(|_| WatcherError::NotStarted)?;
        // Race recheck: between the fast-path lock and now another caller
        // might have installed a watcher. Drop ours if so (the just-built
        // RecommendedWatcher is dropped, halting its FSEvents thread).
        if g.watcher.is_some() {
            return Ok(());
        }
        g.watcher = Some(new_watcher);
        Ok(())
    }

    /// Register a new (agent, transcript) binding. Increments ref-count.
    ///
    /// # Inputs
    /// `handle`: result of `TranscriptAdapter::discover_session`.
    ///
    /// # Returns
    /// `WatchToken` to pass to `unwatch` for teardown.
    ///
    /// # Errors
    /// - `WatcherError::GateRejected` if the handle's path no longer passes
    ///   `fs_gate::check_transcript_root` (e.g. file removed between
    ///   discovery and watch).
    /// - `WatcherError::Io` on FSEvents subscribe failure.
    ///
    /// # Side effects
    /// Calls `subscribe_fsevents`; increments internal ref-count; allocates
    /// per-handle tailer state under `session-<pid>/contexts/.state.json`.
    ///
    /// # Invariants
    /// After `Ok(token)`, the watcher is monitoring `handle.source_path` and
    /// will route file events through the Tailer + Adapter pipeline.
    ///
    /// # Concurrency
    /// Safe to call concurrently; internally serialized at the ref-count
    /// and FSEvents-registry critical sections.
    ///
    /// # Lifecycle
    /// One call per agent-opt-in-publish event. Token is owned by the
    /// frontend (via Tauri IPC) and returned on unwatch.
    ///
    /// # Test contract
    /// Two `watch` calls on the same `source_path` produce distinct
    /// `WatchToken`s. Each token's `unwatch` decrements ref-count
    /// independently.
    pub fn watch(&self, handle: TranscriptHandle) -> Result<WatchToken, WatcherError> {
        // Lazily start FSEvents on first watch().
        self.start_if_needed()?;

        // Re-verify the path through fs_gate (handle was issued earlier by
        // discover_session; the file may have been removed between
        // discovery and this watch call — gate spec X1 calls this out).
        let _canonical = fs_gate::check_transcript_root(handle.adapter_id, &handle.source_path)
            .map_err(|e| WatcherError::GateRejected(format!("{:?}", e)))?;

        // Resolve adapter_id → trait object. Unknown id is GateRejected
        // (rather than Io) — caller's adapter registry has drifted from
        // the production trio.
        let adapter = adapters::adapter_for(handle.adapter_id).ok_or_else(|| {
            WatcherError::GateRejected(format!("unknown adapter_id: {}", handle.adapter_id))
        })?;

        // Resume TailState (touch-up A: uses handle.memory_dir for the
        // .state.json read; inode mismatch resets byte_offset to 0).
        let tail_state = tailer::resume_from_state(&handle)?;

        // Register the parent dir on the RecommendedWatcher via
        // subscribe_fsevents. The Subscription's id is stored on the
        // Entry so unwatch can decrement the parent_dir_refs ref-count.
        let subscription = watcher::subscribe_fsevents(&handle)?;

        let mut g = self
            .inner
            .lock()
            .map_err(|_| WatcherError::NotStarted)?;
        if g.shutdown {
            return Err(WatcherError::NotStarted);
        }
        g.next_id += 1;
        let token_id = g.next_id;
        g.entries.insert(
            token_id,
            Entry {
                handle,
                subscription_id: subscription.0,
                tail_state,
                adapter,
                last_event_at: None,
            },
        );
        Ok(WatchToken(token_id))
    }

    /// Unregister a previously-issued token. Decrements ref-count.
    ///
    /// # Inputs
    /// `token`: value returned by a prior `watch()`.
    ///
    /// # Returns
    /// Unit. Unknown tokens are silently ignored (idempotent — Q6).
    ///
    /// # Errors
    /// Cannot fail.
    ///
    /// # Side effects
    /// Unsubscribes the FSEvents handle for the bound path if no other token
    /// references it. Does NOT delete the mirror file in `contexts/`.
    /// Does NOT drop the watcher instance even when ref-count hits zero
    /// (per W1 + claude2 Q5 — the instance lives until `shutdown()`).
    ///
    /// # Invariants
    /// After return, the token is invalid; passing it again is a no-op.
    ///
    /// # Concurrency
    /// Safe to call concurrently with `watch`; internally serialized.
    ///
    /// # Lifecycle
    /// Called from `AgentMiniTerminal`'s `useEffect` cleanup automatically
    /// when the agent unmounts, irrespective of whether the user toggled
    /// publish OFF first (Q6 — ref-count must auto-decrement on teardown).
    ///
    /// # Test contract
    /// Calling `unwatch` twice with the same token is a no-op the second
    /// time. After the last `unwatch` for a path, no further FSEvents
    /// callbacks fire for that path.
    pub fn unwatch(&self, token: WatchToken) {
        // Idempotent: unknown / already-removed token is a silent no-op
        // per the trait docstring (Q6). Lock-poisoning is also silent —
        // we're in a teardown path that shouldn't panic.
        let mut g = match self.inner.lock() {
            Ok(g) => g,
            Err(_) => return,
        };
        let entry = match g.entries.remove(&token.0) {
            Some(e) => e,
            None => return,
        };

        // Decrement parent_dir_refs. When the count hits zero, no other
        // agent shares this parent dir — unregister the FSEvents
        // subscription. The mirror file in `contexts/<agent>.jsonl`
        // stays on disk (clean-up is the user's call; matches the
        // session-lifetime retention default).
        if let Some(parent) = entry.handle.source_path.parent() {
            let parent_path = parent.to_path_buf();
            let prev = g
                .parent_dir_refs
                .get(&parent_path)
                .copied()
                .unwrap_or(0);
            let next = prev.saturating_sub(1);
            if next == 0 {
                g.parent_dir_refs.remove(&parent_path);
                if let Some(w) = g.watcher.as_mut() {
                    use notify::Watcher;
                    // Best-effort: errors are swallowed (the path may
                    // already be unwatched if FSEvents detected the dir
                    // disappear).
                    let _ = w.unwatch(&parent_path);
                }
            } else {
                g.parent_dir_refs.insert(parent_path, next);
            }
        }
    }

    /// Persist one normalized turn to `contexts/<agent>.jsonl`.
    ///
    /// # Inputs
    /// - `token`: identifies which agent stream this turn belongs to.
    /// - `turn`: the normalized record produced by an adapter.
    ///
    /// # Returns
    /// `Ok(())` when the line is durable on disk.
    ///
    /// # Errors
    /// - `WatcherError::Io` if write fails.
    /// - `WatcherError::NotStarted` if the watcher has not been
    ///   `start_if_needed`-ed.
    ///
    /// # Side effects
    /// Atomic append: writes line via `memory.rs::write_memory_file_atomic`
    /// pattern. May trigger `rotate_if_needed` if the active file crosses
    /// the 8 MB cap after the append.
    ///
    /// # Invariants
    /// Each line is one complete JSON record terminated by `\n`. Readers
    /// never see a partial line.
    ///
    /// # Concurrency
    /// One in-flight write per token; concurrent writes on the same token
    /// are serialized internally.
    ///
    /// # Lifecycle
    /// Called once per `Some(NormalizedTurn)` returned by `normalize`.
    ///
    /// # Test contract
    /// Crash between writing the line and fsync MUST leave either the full
    /// line or no line — never a partial line.
    pub fn append_normalized_turn(
        &self,
        token: &WatchToken,
        turn: NormalizedTurn,
    ) -> Result<(), WatcherError> {
        // Resolve agent_handle under the lock; release before the file
        // IO so a slow disk doesn't block concurrent watch/unwatch.
        let agent_handle = {
            let g = self
                .inner
                .lock()
                .map_err(|_| WatcherError::NotStarted)?;
            if g.shutdown {
                return Err(WatcherError::NotStarted);
            }
            let entry = g.entries.get(&token.0).ok_or_else(|| {
                WatcherError::Io(std::io::Error::new(
                    std::io::ErrorKind::NotFound,
                    "unknown WatchToken",
                ))
            })?;
            entry.handle.agent_handle.clone()
        };

        // Serialize to one line, terminated by \n. Readers split on '\n';
        // never partially-readable per the docstring invariant.
        let mut line = serde_json::to_string(&turn).map_err(|e| {
            WatcherError::Io(std::io::Error::new(std::io::ErrorKind::InvalidData, e))
        })?;
        line.push('\n');

        let dir = super::memory::get_memory_dir().map_err(|e| {
            WatcherError::Io(std::io::Error::new(std::io::ErrorKind::Other, e))
        })?;
        let full_path = dir.join("contexts").join(format!("{}.jsonl", agent_handle));
        if let Some(parent) = full_path.parent() {
            std::fs::create_dir_all(parent).map_err(WatcherError::Io)?;
        }

        // O_NOFOLLOW + append + create. memory.rs's `write_memory_file_atomic`
        // is rename-based (overwrite semantics) and doesn't fit the per-line
        // append pattern; we open with `append(true)` and fsync after each
        // line. Crash-safety: write_all + sync_data leaves either the full
        // line or nothing — never a partial line (POSIX guarantees
        // append-write atomicity within a single write() syscall for
        // payloads under PIPE_BUF, which our serialized turns satisfy).
        let mut file = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .custom_flags(libc::O_NOFOLLOW)
            .open(&full_path)
            .map_err(WatcherError::Io)?;
        file.write_all(line.as_bytes()).map_err(WatcherError::Io)?;
        file.sync_data().map_err(WatcherError::Io)?;
        drop(file);

        // Check for rotation after the append.
        self.rotate_if_needed(token)?;
        Ok(())
    }

    /// Rotate `contexts/<agent>.jsonl` if it exceeds the active-file cap.
    ///
    /// # Inputs
    /// `token`: stream to check.
    ///
    /// # Returns
    /// `Ok(())` whether rotation happened or not.
    ///
    /// # Errors
    /// `WatcherError::Io` on rename/fsync failure.
    ///
    /// # Side effects
    /// On rotation (size > `ACTIVE_FILE_BYTE_CAP`):
    /// 1. Compute next N via `scan_archive_indices` (dir-listing — state
    ///    cache is NOT authoritative for N, per T1).
    /// 2. `fsync` current active.
    /// 3. `rename` active → `<agent>.<N>.jsonl` (POSIX atomic).
    /// 4. Create `<agent>.jsonl.tmp` empty; fsync; `rename` to active.
    ///
    /// # Invariants
    /// After rotation, no reader sees a missing active file (atomic-rename
    /// pattern from M2). The crash recovery rule: if active is absent on
    /// startup but archives exist, do NOT auto-promote — next write creates
    /// a fresh active. The brief read-side gap is accepted over double-rename
    /// risk.
    ///
    /// # Concurrency
    /// Rotation is mutually exclusive with appends on the same token.
    ///
    /// # Lifecycle
    /// Called automatically by `append_normalized_turn` after each append.
    /// Never called directly by frontend.
    ///
    /// # Test contract
    /// Inducing a crash between step (3) and (4) above MUST leave the
    /// archive present and the active missing — the recovery path's
    /// "no auto-promote" rule MUST then create a fresh active on the
    /// next write.
    pub fn rotate_if_needed(&self, token: &WatchToken) -> Result<(), WatcherError> {
        let agent_handle = {
            let g = self
                .inner
                .lock()
                .map_err(|_| WatcherError::NotStarted)?;
            let entry = match g.entries.get(&token.0) {
                Some(e) => e,
                None => return Ok(()),
            };
            entry.handle.agent_handle.clone()
        };

        let dir = super::memory::get_memory_dir().map_err(|e| {
            WatcherError::Io(std::io::Error::new(std::io::ErrorKind::Other, e))
        })?;
        let active_path = dir.join("contexts").join(format!("{}.jsonl", agent_handle));

        let size = match std::fs::metadata(&active_path) {
            Ok(m) => m.len(),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(e) => return Err(WatcherError::Io(e)),
        };
        if size <= ACTIVE_FILE_BYTE_CAP {
            return Ok(());
        }

        // Scan archive indices (T1: directory listing is authoritative).
        let indices = self.scan_archive_indices(&agent_handle);
        let next_n = indices.iter().max().copied().unwrap_or(0) + 1;
        let archive_path = dir
            .join("contexts")
            .join(format!("{}.{}.jsonl", agent_handle, next_n));

        // 1. fsync current active before renaming.
        {
            let f = std::fs::File::open(&active_path).map_err(WatcherError::Io)?;
            f.sync_all().map_err(WatcherError::Io)?;
        }
        // 2. Atomic rename active → archive.
        std::fs::rename(&active_path, &archive_path).map_err(WatcherError::Io)?;

        // 3. Create new empty active via tmp + rename so readers never see
        //    a missing active (atomic-rename pattern from M2). Crash
        //    between steps 2 and 3 leaves archive present and active
        //    missing — the docstring's "no auto-promote" recovery rule
        //    relies on the next append's O_CREAT to materialize active.
        let tmp_active = dir
            .join("contexts")
            .join(format!("{}.jsonl.tmp", agent_handle));
        let f = std::fs::File::create(&tmp_active).map_err(WatcherError::Io)?;
        f.sync_all().map_err(WatcherError::Io)?;
        drop(f);
        std::fs::rename(&tmp_active, &active_path).map_err(WatcherError::Io)?;
        Ok(())
    }

    /// List the archive indices currently on disk for `agent_handle`.
    ///
    /// # Inputs
    /// `agent_handle`: bare CT handle.
    ///
    /// # Returns
    /// Sorted ascending vector of integer N values from existing
    /// `contexts/<agent>.<N>.jsonl` files. Empty if no archives yet.
    ///
    /// # Errors
    /// Cannot fail (returns empty vec on directory missing or read errors).
    ///
    /// # Side effects
    /// One `readdir` on the contexts directory.
    ///
    /// # Invariants
    /// AUTHORITATIVE for "next archive N" — must not be substituted by a
    /// state-file cache (T1: state cache can lag a successful rename).
    ///
    /// # Concurrency
    /// Thread-safe but subject to filesystem TOCTOU; callers performing
    /// rotation hold the rotation lock for the full sequence.
    ///
    /// # Lifecycle
    /// Called by `rotate_if_needed` immediately before the rename.
    ///
    /// # Test contract
    /// Returns `[]` when no archives exist. Returns `[1, 2, 5]` when
    /// `<agent>.{1,2,5}.jsonl` exist — gaps are preserved, not filled.
    pub fn scan_archive_indices(&self, agent_handle: &str) -> Vec<u32> {
        // T1: dir-listing is authoritative for "next archive N" — never
        // substitute a state-file cache. The state cache can lag a
        // successful rename and produce a colliding N on the next rotate.
        let dir = match super::memory::get_memory_dir() {
            Ok(d) => d.join("contexts"),
            Err(_) => return Vec::new(),
        };
        let prefix = format!("{}.", agent_handle);
        let mut out = Vec::new();
        if let Ok(entries) = std::fs::read_dir(&dir) {
            for entry in entries.flatten() {
                if let Some(name) = entry.file_name().to_str() {
                    if let Some(rest) = name.strip_prefix(&prefix) {
                        if let Some(num) = rest.strip_suffix(".jsonl") {
                            if let Ok(n) = num.parse::<u32>() {
                                out.push(n);
                            }
                        }
                    }
                }
            }
        }
        out.sort();
        out
    }

    /// Drop the watcher: unsubscribe every FSEvents handle, stop the thread.
    ///
    /// # Inputs
    /// None.
    ///
    /// # Returns
    /// Unit.
    ///
    /// # Errors
    /// Cannot fail (cleanup is best-effort; FSEvents un-subscribe errors
    /// are logged and swallowed).
    ///
    /// # Side effects
    /// Stops the notify thread, drops the watcher's internal collections,
    /// invalidates all outstanding `WatchToken`s.
    ///
    /// # Invariants
    /// After return, no further FSEvents callbacks fire. Outstanding tokens
    /// passed to `unwatch` become silent no-ops.
    ///
    /// # Concurrency
    /// Idempotent; safe to call multiple times.
    ///
    /// # Lifecycle
    /// Hooked into Tauri's `RunEvent::Exit` (lib.rs:229 — defensive) and
    /// `WindowEvent::Destroyed` (primary). NOT called from
    /// `clear_stale_sessions` — that runs at app startup BEFORE the
    /// watcher exists (W1 corrects M1 wording).
    ///
    /// # Test contract
    /// Calling `shutdown()` then issuing a new `watch()` call returns
    /// `WatcherError::NotStarted` until `start_if_needed` is called again.
    pub fn shutdown(&self) {
        // Idempotent — multiple calls (RunEvent::Exit + WindowEvent::Destroyed
        // both fire on macOS in some configurations per claude2 r5 O1).
        // Lock-poisoning is silent: shutdown is best-effort.
        let mut g = match self.inner.lock() {
            Ok(g) => g,
            Err(_) => return,
        };
        g.shutdown = true;
        g.entries.clear();
        g.parent_dir_refs.clear();
        // Drop the notify::RecommendedWatcher — its Drop impl stops the
        // FSEvents thread. Per the docstring's invariant: no further
        // callbacks fire after this returns. The OnceLock-installed
        // Arc<Mutex<Inner>> remains live (its strong-count drops by 1
        // here; the OnceLock holds the other), but with `shutdown=true`
        // any in-flight on_fs_event observes the flag and bails.
        g.watcher = None;
    }
}

// =====================================================================
// Tauri IPC wrappers
// =====================================================================
//
// Thin `#[tauri::command]` adapters that expose `TranscriptWatcher::watch`
// and `unwatch` to the frontend. The frontend cluster (`peerContext.ts` +
// `AgentMiniTerminal.tsx`) invokes these via `invoke()`. Returning
// `WatchToken`'s inner `u64` directly produces a cleaner JSON shape than
// serializing the tuple-struct.
//
// Architecture-implied; the planner's `architecture.html` IPC surface
// committed `TranscriptWatcher::watch` / `unwatch` as the public methods
// but didn't explicitly enumerate Tauri commands. These are the natural
// frontend-facing exposure. See lib.rs's `tauri::generate_handler!`
// invocation for handler registration.

/// Tauri IPC: resolve a (PID, tool, agent_handle) tuple to a running
/// transcript watch. Wraps `TranscriptAdapter::discover_session` +
/// `TranscriptWatcher::watch` for the frontend's `useEffect` on
/// `AgentMiniTerminal` mount.
#[tauri::command]
pub fn watch_transcript(
    state: tauri::State<'_, TranscriptWatcher>,
    agent_handle: String,
    pid: i32,
    tool: String,
    spawned_at_unix_ms: i64,
) -> Result<u64, String> {
    let adapter = adapters::adapter_for(tool.as_str())
        .ok_or_else(|| format!("unknown tool: {}", tool))?;
    let handle = adapter
        .discover_session(&agent_handle, pid, spawned_at_unix_ms)
        .map_err(|e| format!("discover_session: {:?}", e))?;
    let token = state
        .watch(handle)
        .map_err(|e| format!("watch: {:?}", e))?;
    Ok(token.0)
}

/// Tauri IPC: release a previously-issued watch token. Idempotent —
/// unknown tokens are silent no-ops per `TranscriptWatcher::unwatch`'s
/// Q6 contract.
#[tauri::command]
pub fn unwatch_transcript(state: tauri::State<'_, TranscriptWatcher>, token: u64) {
    state.unwatch(WatchToken(token));
}
