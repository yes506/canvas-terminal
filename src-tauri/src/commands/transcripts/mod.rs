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

use std::collections::{HashMap, HashSet};
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
    /// Collaborator-session id, sanitized to a single path segment. Namespaces
    /// the mirror path so two collab sessions that each spawn a `claude1`
    /// write to distinct files:
    /// `contexts/<collab_session_id>/<agent_handle>.jsonl`.
    ///
    /// WATCHER-OWNED, NOT adapter-derived: `discover_session` constructs the
    /// handle with an empty placeholder; `populate_entry` overwrites it (after
    /// sanitizing) with the value threaded down from the `watch_transcript`
    /// IPC. Adapters never see it — discovery only locates the source
    /// transcript; namespacing is a CT-side identity concern (plan N4/N6,
    /// codex2/claude3 convergence). NEVER persisted to `.state.json` (resume
    /// rebuilds the mirror path from this handle field — see
    /// `tailer::resume_from_state`).
    pub collab_session_id: String,
}

/// Sanitize a collaborator-session id into a single safe path segment.
///
/// SINGLE SHARED RULE with the TS reader
/// (`src/lib/peerContext.ts::sanitizeCollabSessionId`): retain only
/// `[A-Za-z0-9_-]`, drop every other character. Writer (this side) and reader
/// (TS) MUST apply the identical filter or the agent's grep path diverges from
/// the on-disk write path and collaboration deadlocks (plan "sanitize contract").
/// In practice collab ids are `session-<n>-<ts>` so the filter is a no-op; it
/// exists as defense-in-depth.
pub fn sanitize_collab_session_id(raw: &str) -> String {
    raw.chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '-')
        .collect()
}

/// Opaque registration token returned by `TranscriptWatcher::watch`. Passed
/// back to `unwatch` to release the registration.
pub struct WatchToken(pub u64);

/// Canonical mirrored record format. One per accepted turn in
/// `session-<pid>/contexts/<collab_session_id>/<agent>.jsonl`.
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
    /// - `spawned_at_unix_ms`: **ignored as of cycle F.** All three
    ///   production adapters resolve the spawn-time threshold server-side
    ///   from `pid` via `discover_pid_start_time` (process-start time
    ///   from `ps -o etime=` on macOS or `/proc/<pid>/stat` field 22 on
    ///   Linux). The trait parameter is retained for backward
    ///   compatibility with the `watch_transcript` IPC contract; adapters
    ///   conventionally bind it to `_spawned_at_unix_ms`. Future
    ///   adapters MAY consult it but should prefer `discover_by_mtime`'s
    ///   server-side threshold for cross-provider correctness.
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
    ///
    /// # Defense-2 parameters (plan N4/N5/N19)
    /// - `claimed_paths`: canonical `source_path`s already bound to other live
    ///   handles. The adapter forwards these to `discover_by_mtime` so an
    ///   already-mirrored transcript is excluded from this binding's candidate
    ///   set (Defense-2B — prevents two handles binding the same source).
    ///   Adapters do NOT own `collab_session_id` (that is watcher-owned and
    ///   attached at populate time); they own only source discovery.
    /// - `allow_unmarked_fallback`: when `false`, the adapter MUST return
    ///   `NoMatchingFd` if no candidate carries the `You are @<agent_handle>`
    ///   identity marker (Defense-2A strict mode — the discovery loop retries,
    ///   waiting for the agent's first marked turn to flush). When `true`
    ///   (after the loop's finite marker-wait budget is exhausted), the adapter
    ///   MAY fall back to the newest unclaimed candidate with a warning so a
    ///   tool that never writes the marker (e.g. codex) still binds (N19).
    fn discover_session(
        &self,
        agent_handle: &str,
        pid: i32,
        spawned_at_unix_ms: i64,
        claimed_paths: &HashSet<PathBuf>,
        allow_unmarked_fallback: bool,
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
///
/// Cycle F lifecycle: `watch()` inserts a PENDING entry (handle /
/// subscription_id / tail_state all `None`, `discovery_task = Some(...)`).
/// The discovery task asynchronously calls `discover_session`; on success
/// it populates the trio and clears `discovery_task`. `on_fs_event` skips
/// entries with `handle == None` so pending entries never get polled.
pub(in crate::commands::transcripts) struct Entry {
    /// Resolved transcript binding. `None` until `discovery_loop` succeeds.
    pub(in crate::commands::transcripts) handle: Option<TranscriptHandle>,
    /// FSEvents subscription id (parent-dir scope). `None` until the
    /// discovery task subscribes during populate.
    pub(in crate::commands::transcripts) subscription_id: Option<u64>,
    /// Tailer resume state. `None` until populate.
    pub(in crate::commands::transcripts) tail_state: Option<tailer::TailState>,
    /// Adapter trait object — known immediately from `watch()` inputs and
    /// safe to populate at entry-insert time (no IO required).
    pub(in crate::commands::transcripts) adapter: &'static dyn TranscriptAdapter,
    /// Abort handle for the async discovery task. `Some` while the task
    /// is in flight; cleared once the task completes (success or abort).
    /// `unwatch` (F7) aborts via this handle whether or not the task has
    /// already populated the entry — abort on an already-completed task
    /// is a no-op.
    pub(in crate::commands::transcripts) discovery_task: Option<tokio::task::AbortHandle>,
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
///
/// NOTE: the `notify::RecommendedWatcher` is INTENTIONALLY held on
/// `TranscriptWatcher::notify_watcher` rather than on this struct, to
/// avoid a deadlock where `notify::Watcher::{watch,unwatch}` (called
/// while holding this Inner mutex) waits for FSEvents callback thread
/// synchronization, but the FSEvents thread is itself blocked acquiring
/// this Inner mutex inside `on_fs_event`. See `TranscriptWatcher`
/// docstring for the lock-ordering invariant.
pub(in crate::commands::transcripts) struct Inner {
    /// `WatchToken.0` → Entry. Mutable per-token state lives here.
    pub(in crate::commands::transcripts) entries: HashMap<u64, Entry>,
    /// Parent-dir → subscription ref-count. FSEvents subscribes at the
    /// parent dir (NB2 — JSONL writes via atomic-rename change the
    /// watched inode), so multiple agents whose JSONLs share a parent
    /// dir share one notify registration. Decrementing to zero triggers
    /// a `notify::Watcher::unwatch` via the SEPARATE `notify_watcher`
    /// mutex on `TranscriptWatcher`.
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
///
/// # Lock-ordering invariant
///
/// `Inner` and `notify_watcher` are SEPARATE mutexes by deliberate
/// design (task-11 deadlock fix). The FSEvents callback thread
/// (`watcher::on_fs_event`) acquires ONLY `Inner` — never
/// `notify_watcher`. User-side code that calls `notify::Watcher::watch`
/// or `notify::Watcher::unwatch` MUST drop `Inner` first (capturing any
/// state it needs in locals), then acquire `notify_watcher` for the
/// notify-API call. Locking BOTH at once is forbidden because notify's
/// FSEvents implementation synchronizes with the callback thread
/// internally; if `Inner` is also held, `on_fs_event` can't acquire it
/// and notify's API hangs waiting for the callback to ack → deadlock.
///
/// Quick reference:
/// - `on_fs_event`: locks `Inner` only.
/// - `subscribe_fsevents` / `TranscriptWatcher::unwatch` / `populate_entry`
///   rollback: brief `Inner` lock for bookkeeping → DROP → then
///   `notify_watcher` lock for the notify call.
/// - `start_if_needed`: lazily installs the `RecommendedWatcher` via
///   `notify_watcher`; consults `Inner.shutdown` separately.
/// - `shutdown`: locks `Inner` first (sets shutdown=true, drains
///   entries), DROPS, then locks `notify_watcher` to drop the
///   `RecommendedWatcher` (stops FSEvents thread).
pub struct TranscriptWatcher {
    pub(in crate::commands::transcripts) inner: Arc<Mutex<Inner>>,
    /// notify-crate watcher held in its own mutex so notify-API calls
    /// (which synchronize with the FSEvents callback thread) can never
    /// contend with `on_fs_event`'s `Inner` locking. See the
    /// lock-ordering invariant above.
    pub(in crate::commands::transcripts) notify_watcher:
        Arc<Mutex<Option<notify::RecommendedWatcher>>>,
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
                entries: HashMap::new(),
                parent_dir_refs: HashMap::new(),
                next_id: 0,
                shutdown: false,
            })),
            notify_watcher: Arc::new(Mutex::new(None)),
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
        // Fast-path: shutdown check (Inner) — already-installed check
        // (notify_watcher). The two checks use different mutexes per the
        // lock-ordering invariant.
        {
            let g = self
                .inner
                .lock()
                .map_err(|_| WatcherError::NotStarted)?;
            if g.shutdown {
                return Err(WatcherError::NotStarted);
            }
        }
        {
            let nw = self
                .notify_watcher
                .lock()
                .map_err(|_| WatcherError::NotStarted)?;
            if nw.is_some() {
                return Ok(());
            }
        }

        // Install OnceLocks so watcher.rs free functions can reach both
        // mutexes from the notify-thread closure context. Inner powers
        // on_fs_event; notify_watcher powers subscribe_fsevents'
        // notify::Watcher::watch call without contending with Inner.
        watcher::install_inner(self.inner.clone());
        watcher::install_notify_watcher(self.notify_watcher.clone());

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

        // Install under the notify_watcher mutex with a race recheck.
        // Re-verify shutdown didn't race ahead via the Inner mutex too;
        // if it did, drop the freshly-built RecommendedWatcher (its Drop
        // halts its FSEvents thread).
        {
            let g = self
                .inner
                .lock()
                .map_err(|_| WatcherError::NotStarted)?;
            if g.shutdown {
                return Err(WatcherError::NotStarted);
            }
        }
        let mut nw = self
            .notify_watcher
            .lock()
            .map_err(|_| WatcherError::NotStarted)?;
        if nw.is_some() {
            return Ok(());
        }
        *nw = Some(new_watcher);
        Ok(())
    }

    /// Register a new (agent, transcript) binding. Cycle F: discovery is
    /// async; this call inserts a PENDING entry and returns immediately.
    ///
    /// # Inputs
    /// - `adapter`: trait object for the agent's tool (cycle F pre-resolves
    ///   it at the IPC boundary so the watcher never re-looks-up by id).
    /// - `agent_handle`: bare collab handle (e.g. `"claude3"`).
    /// - `pid`: child PID returned by the PTY spawn.
    /// - `spawned_at_unix_ms`: legacy IPC threshold; ignored by all three
    ///   production adapters per cycle F's process-start-time pivot but
    ///   threaded through verbatim for trait-signature backward compat.
    ///
    /// # Returns
    /// `WatchToken` to pass to `unwatch` for teardown. The token is valid
    /// IMMEDIATELY (before discovery completes); `unwatch` works correctly
    /// in both pending and populated states.
    ///
    /// # Errors
    /// - `WatcherError::NotStarted` if `shutdown()` has been called or the
    ///   FSEvents subsystem cannot initialize. Errors that happen INSIDE
    ///   the async discovery loop (`NoMatchingFd`, `Io`, etc.) are logged
    ///   and retried every 5s until `unwatch` aborts the task.
    ///
    /// # Side effects
    /// Reserves a token id under the Inner mutex. Spawns one tokio task
    /// per call (long-lived, until `unwatch` or successful population).
    /// FSEvents subscription + tail-state resumption happen INSIDE the
    /// task, only on successful discovery.
    ///
    /// # Invariants
    /// After `Ok(token)`, the watcher is committed to surfacing the
    /// agent's transcript as soon as the CLI tool writes its first
    /// session JSONL. The token's `unwatch` is idempotent and aborts
    /// the discovery task whether or not population has completed.
    ///
    /// # Concurrency
    /// Safe to call concurrently. The async discovery task uses
    /// `tokio::time::sleep` so it never holds the Inner mutex across an
    /// await point. The Inner mutex remains a `std::sync::Mutex` — the
    /// async task acquires it synchronously between sleeps.
    ///
    /// # Lifecycle
    /// One call per agent-opt-in-publish event. Cycle F always-on:
    /// publishOptedIn defaults to `true`, so this fires automatically at
    /// agent spawn time. The discovery task survives arbitrary
    /// spawn-to-first-write delays via 5s polling.
    ///
    /// # Test contract
    /// Two `watch` calls on the same `pid` produce distinct
    /// `WatchToken`s. Each token's `unwatch` aborts its own discovery
    /// task and (if populated) decrements its own ref-count
    /// independently.
    pub fn watch(
        &self,
        adapter: &'static dyn TranscriptAdapter,
        agent_handle: String,
        pid: i32,
        spawned_at_unix_ms: i64,
        collab_session_id: String,
    ) -> Result<WatchToken, WatcherError> {
        // Lazily start FSEvents on first watch().
        self.start_if_needed()?;

        // Reserve token id and insert PENDING entry. Subscription /
        // tail_state / handle stay None until the async task populates.
        let token_id = {
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
                    handle: None,
                    subscription_id: None,
                    tail_state: None,
                    adapter,
                    discovery_task: None,
                    last_event_at: None,
                },
            );
            token_id
        };

        // Spawn the discovery polling task. The task owns its own Arc
        // clone of Inner so it can re-acquire the lock between sleeps
        // without touching the Tauri State<>.
        //
        // Use `tauri::async_runtime::spawn` (not raw `tokio::spawn`):
        // the Tauri wrapper enters the managed runtime
        // (`let _guard = r.enter()`) before delegating to tokio.
        // Sync `#[tauri::command]` handlers (like `watch_transcript`)
        // run on a worker pool that does NOT have a tokio runtime in
        // task-local context — bare `tokio::spawn` panics with "no
        // reactor running" there. The codebase precedent
        // (`localfile.rs::serve_localfile`, `dashboard/server.rs`) uses
        // `tauri::async_runtime::spawn` for the same reason.
        let inner_for_task = self.inner.clone();
        let agent_handle_for_task = agent_handle.clone();
        let collab_session_id_for_task = collab_session_id.clone();
        let join = tauri::async_runtime::spawn(async move {
            Self::discovery_loop(
                inner_for_task,
                token_id,
                adapter,
                agent_handle_for_task,
                pid,
                spawned_at_unix_ms,
                collab_session_id_for_task,
            )
            .await;
        });

        // Store the abort handle on the entry. If `unwatch` has already
        // raced ahead of this lock (removing the entry), abort the
        // freshly-spawned task immediately so it doesn't run.
        //
        // `tauri::async_runtime::JoinHandle` wraps `tokio::task::JoinHandle`
        // but does NOT expose `.abort_handle()` directly — only `.abort()`
        // and `.inner()`. We call `.inner().abort_handle()` to get the raw
        // `tokio::task::AbortHandle` that `Entry.discovery_task` is typed
        // as. `.abort()` on the wrapper is still safe for the race-rollback
        // path below (it delegates to the inner tokio handle).
        {
            let mut g = self
                .inner
                .lock()
                .map_err(|_| WatcherError::NotStarted)?;
            if let Some(entry) = g.entries.get_mut(&token_id) {
                entry.discovery_task = Some(join.inner().abort_handle());
            } else {
                join.abort();
            }
        }

        Ok(WatchToken(token_id))
    }

    /// Async polling loop for `watch`'s discovery task. Calls the adapter's
    /// `discover_session` every 5s until success, abort, or watcher
    /// shutdown.
    ///
    /// On success: invokes `populate_entry` which acquires the fs_gate +
    /// tail_state + FSEvents subscription and stores them on the entry.
    /// The initial-drain `on_fs_event` synthesize-call also lives in
    /// `populate_entry` so any content already on disk replays as soon
    /// as discovery resolves.
    ///
    /// On `NoMatchingFd`: sleeps 5s and retries. This is the common case
    /// for the cold-spawn flow — the CLI tool has not yet created its
    /// session JSONL.
    ///
    /// On other errors (`Io`, `Gated`, `Unsupported`): logs to stderr and
    /// retries the same way. Genuinely-permanent errors (a `Gated` from
    /// a misconfigured root) will retry every 5s indefinitely but the
    /// CPU cost is negligible (one syscall per retry).
    ///
    /// Exits cleanly when:
    /// - the entry has been removed (via `unwatch`)
    /// - the watcher has been shut down (`shutdown()`)
    /// - the task is aborted (`AbortHandle::abort()`)
    async fn discovery_loop(
        inner: std::sync::Arc<std::sync::Mutex<Inner>>,
        token_id: u64,
        adapter: &'static dyn TranscriptAdapter,
        agent_handle: String,
        pid: i32,
        spawned_at_unix_ms: i64,
        collab_session_id: String,
    ) {
        const POLL_INTERVAL: tokio::time::Duration = tokio::time::Duration::from_secs(5);
        // Defense-2A termination policy (N19): for the first
        // MARKER_WAIT_ATTEMPTS polls, require the `You are @<handle>` identity
        // marker (strict mode) so a freshly-spawned agent binds to ITS OWN
        // transcript even if a same-cwd sibling's file is momentarily newer.
        // After the budget is exhausted, allow the newest-unclaimed fallback
        // (with a warning) so a tool that never writes the marker (codex's
        // rollout has no CT-injected identity line) still binds rather than
        // spinning forever. ~5s per poll → ~15s of marker-wait before fallback.
        const MARKER_WAIT_ATTEMPTS: u32 = 3;
        let mut attempt: u32 = 0;
        loop {
            // Exit-condition check + claimed-path snapshot (N9, 2B select
            // stage) under ONE Inner lock acquisition. The snapshot is the
            // set of canonical source_paths already bound to OTHER live
            // populated handles; discover_session excludes them so two handles
            // never bind the same transcript. NB: this snapshot is necessary
            // but NOT sufficient — concurrent pending discoveries can both
            // pass it, so populate_entry re-checks atomically under the lock
            // (N17).
            let claimed_paths: HashSet<PathBuf> = {
                let g = match inner.lock() {
                    Ok(g) => g,
                    Err(_) => return,
                };
                if g.shutdown || !g.entries.contains_key(&token_id) {
                    return;
                }
                g.entries
                    .iter()
                    .filter(|(id, _)| **id != token_id)
                    .filter_map(|(_, e)| e.handle.as_ref())
                    .map(|h| h.source_path.clone())
                    .collect()
            };

            let allow_unmarked_fallback = attempt >= MARKER_WAIT_ATTEMPTS;
            attempt = attempt.saturating_add(1);

            let result = adapter.discover_session(
                &agent_handle,
                pid,
                spawned_at_unix_ms,
                &claimed_paths,
                allow_unmarked_fallback,
            );
            match result {
                Ok(handle) => {
                    // Populate re-checks entry presence under the lock and
                    // atomically re-checks for a dup source_path (N17). It
                    // returns `true` when it bound the handle (we're done) and
                    // `false` when it rolled back (entry vanished via unwatch,
                    // or another handle raced to the same source_path). On
                    // `false` we keep polling: the next discover_session sees
                    // the now-claimed path in the snapshot and either picks a
                    // different transcript or returns NoMatchingFd.
                    if Self::populate_entry(&inner, token_id, handle, collab_session_id.clone()) {
                        return;
                    }
                }
                Err(DiscoveryError::NoMatchingFd) => {
                    // Common path: tool hasn't created its JSONL yet, OR (under
                    // strict marker mode) no candidate carries the identity
                    // marker yet. Silent retry.
                }
                Err(e) => {
                    // Less-common path: an Io / Gated / Unsupported.
                    // Log so the user can debug, then retry — most
                    // such errors are transient (CLI subprocess race,
                    // /proc read of a momentarily-gone pid, etc).
                    eprintln!(
                        "transcripts: discovery error for token {} ({}): {:?}",
                        token_id, agent_handle, e
                    );
                }
            }

            tokio::time::sleep(POLL_INTERVAL).await;
        }
    }

    /// Apply a successful `discover_session` result to a PENDING entry.
    ///
    /// Two-phase commit:
    /// - Phase A: under the lock, verify the entry still exists. If
    ///   `unwatch` has raced ahead, exit silently.
    /// - Phase B: outside the lock, perform fs_gate + resume_from_state
    ///   + subscribe_fsevents. These are IO-bound and we don't want to
    ///   serialize them behind the watcher mutex.
    /// - Phase C: re-acquire the lock. Re-check entry presence. If gone,
    ///   undo the FSEvents subscription (decrement ref-count). If
    ///   present, populate the trio.
    /// - Initial drain (outside the lock): synthesize an on_fs_event so
    ///   any content already on disk replays into
    ///   `contexts/<collab_session_id>/<agent>.jsonl` without waiting for the
    ///   next FSEvents notification.
    ///
    /// Returns `true` when the handle was bound (discovery is done); `false`
    /// when it rolled back — either the entry vanished (unwatch raced) or
    /// another live handle already owns this `source_path` (N17 dup-source
    /// race). On `false` the caller (`discovery_loop`) keeps polling; its
    /// next exit-condition check tears the watch down if the entry is gone,
    /// otherwise the next `discover_session` excludes the now-claimed path.
    fn populate_entry(
        inner: &std::sync::Arc<std::sync::Mutex<Inner>>,
        token_id: u64,
        mut handle: TranscriptHandle,
        collab_session_id: String,
    ) -> bool {
        // Attach the watcher-owned, sanitized collab_session_id BEFORE any
        // claim comparison or storage. This is the ONLY site that fills the
        // field — adapters construct handles with an empty placeholder (plan
        // N6: collab_session_id is watcher-owned, not adapter-derived).
        handle.collab_session_id = sanitize_collab_session_id(&collab_session_id);

        // Phase A: cheap presence check.
        {
            let g = match inner.lock() {
                Ok(g) => g,
                Err(_) => return false,
            };
            if g.shutdown || !g.entries.contains_key(&token_id) {
                return false;
            }
        }

        // Phase B: outside-lock IO.
        let canonical_result =
            fs_gate::check_transcript_root(handle.adapter_id, &handle.source_path);
        if let Err(e) = canonical_result {
            eprintln!(
                "transcripts: fs_gate rejected populated handle for token {}: {:?}",
                token_id, e
            );
            return false;
        }

        let tail_state = match tailer::resume_from_state(&handle) {
            Ok(s) => s,
            Err(e) => {
                eprintln!(
                    "transcripts: tail_state resume failed for token {}: {:?}",
                    token_id, e
                );
                return false;
            }
        };

        let subscription = match watcher::subscribe_fsevents(&handle) {
            Ok(s) => s,
            Err(e) => {
                eprintln!(
                    "transcripts: FSEvents subscribe failed for token {}: {:?}",
                    token_id, e
                );
                return false;
            }
        };

        let source_path_for_drain = handle.source_path.clone();
        let parent_for_rollback = handle.source_path.parent().map(|p| p.to_path_buf());

        // Phase C: re-acquire Inner lock + populate or schedule rollback.
        // Lock-ordering invariant (task-11): no notify::Watcher::unwatch
        // call inside this section. Capture rollback intent here; do the
        // actual notify::unwatch outside the lock.
        enum PopulateOutcome {
            Populated,
            RaceRollback(Option<PathBuf>), // Some(parent) = release notify too
            LockPoisoned,
        }
        let outcome = match inner.lock() {
            Ok(mut g) => {
                // N17: atomic dup-source recheck. The N9 snapshot the loop
                // took before discovery is necessary-but-NOT-sufficient — two
                // pending discoveries for the same source can both pass it,
                // then both arrive here. Under this single lock, refuse to
                // bind a `source_path` already owned by another live populated
                // handle. Both `source_path`s are fs_gate-canonical, so `==`
                // is a canonical comparison (plan N17 canonical-compare
                // constraint). On a dup we take the SAME rollback path as the
                // unwatch race, but the entry stays PENDING so the loop retries
                // and the next discovery excludes this (now-claimed) path.
                let dup_source = g.entries.iter().any(|(id, e)| {
                    *id != token_id
                        && e.handle
                            .as_ref()
                            .map_or(false, |h| h.source_path == handle.source_path)
                });
                if dup_source {
                    let mut release_parent: Option<PathBuf> = None;
                    if let Some(parent) = &parent_for_rollback {
                        let cur = g.parent_dir_refs.get(parent).copied().unwrap_or(0);
                        let next = cur.saturating_sub(1);
                        if next == 0 {
                            g.parent_dir_refs.remove(parent);
                            release_parent = Some(parent.clone());
                        } else {
                            g.parent_dir_refs.insert(parent.clone(), next);
                        }
                    }
                    eprintln!(
                        "transcripts: token {} discovered an already-claimed source_path \
                         ({:?}); rolling back and retrying discovery (N17 dup-source guard)",
                        token_id, handle.source_path
                    );
                    PopulateOutcome::RaceRollback(release_parent)
                } else if let Some(entry) = g.entries.get_mut(&token_id) {
                    entry.handle = Some(handle);
                    entry.subscription_id = Some(subscription.0);
                    entry.tail_state = Some(tail_state);
                    entry.discovery_task = None;
                    PopulateOutcome::Populated
                } else {
                    // Entry vanished between Phase A and Phase C —
                    // `unwatch` raced. Roll back the FSEvents
                    // subscription so parent_dir_refs doesn't leak.
                    // Decrement under Inner; capture whether the ref-count
                    // hit zero so the notify::unwatch call can fire
                    // OUTSIDE this lock.
                    let mut release_parent: Option<PathBuf> = None;
                    if let Some(parent) = &parent_for_rollback {
                        let cur = g.parent_dir_refs.get(parent).copied().unwrap_or(0);
                        let next = cur.saturating_sub(1);
                        if next == 0 {
                            g.parent_dir_refs.remove(parent);
                            release_parent = Some(parent.clone());
                        } else {
                            g.parent_dir_refs.insert(parent.clone(), next);
                        }
                    }
                    PopulateOutcome::RaceRollback(release_parent)
                }
            }
            Err(_) => {
                // Lock-poisoning: best-effort no-op. Subscription leaks
                // until shutdown(); acceptable because lock-poison means
                // we already panicked somewhere and are in a degraded
                // process state.
                PopulateOutcome::LockPoisoned
            }
        };  // <-- Inner lock DROPPED here

        // Phase D (no Inner held): if the unwatch race triggered a
        // parent-dir release, perform the notify::unwatch outside the
        // Inner lock per the lock-ordering invariant.
        if let PopulateOutcome::RaceRollback(Some(parent)) = &outcome {
            if let Some(notify_watcher) = watcher::notify_watcher_handle() {
                if let Ok(mut nw) = notify_watcher.lock() {
                    if let Some(w) = nw.as_mut() {
                        use notify::Watcher;
                        let _ = w.unwatch(parent);
                    }
                }
            }
        }

        if !matches!(outcome, PopulateOutcome::Populated) {
            // RaceRollback (entry-gone OR N17 dup-source) and LockPoisoned
            // both report "not bound" so the loop keeps polling / exits on its
            // next presence check.
            return false;
        }

        // Initial drain: synthesize one on_fs_event so any content
        // already present in the source JSONL replays into
        // contexts/<collab_session_id>/<agent>.jsonl without waiting for the
        // next FSEvents notification. Outside-lock: on_fs_event re-acquires
        // the lock internally.
        watcher::on_fs_event(&watcher::Subscription(0), &source_path_for_drain);
        true
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
        //
        // Lock-ordering invariant (task-11 deadlock fix): Inner lock is
        // held BRIEFLY for entries+parent_dir_refs bookkeeping, then
        // DROPPED before any notify::Watcher::unwatch call. Holding
        // Inner across notify::unwatch causes deadlock when the
        // FSEvents callback thread is mid-on_fs_event waiting on the
        // same Inner mutex.
        let parent_to_unwatch: Option<PathBuf> = {
            let mut g = match self.inner.lock() {
                Ok(g) => g,
                Err(_) => return,
            };
            let entry = match g.entries.remove(&token.0) {
                Some(e) => e,
                None => return,
            };

            // Cycle F (F7): abort the discovery task whether or not the entry
            // ever populated. `AbortHandle::abort` is a no-op for tasks that
            // have already completed, so this is safe regardless of state.
            // This does NOT call into notify, so it's safe under Inner.
            if let Some(task) = entry.discovery_task {
                task.abort();
            }

            // Decrement parent_dir_refs only for POPULATED entries. Pending
            // entries (handle == None) never subscribed to FSEvents — there
            // is no ref-count to decrement.
            if let Some(handle) = entry.handle.as_ref() {
                if let Some(parent) = handle.source_path.parent() {
                    let parent_path = parent.to_path_buf();
                    let prev = g
                        .parent_dir_refs
                        .get(&parent_path)
                        .copied()
                        .unwrap_or(0);
                    let next = prev.saturating_sub(1);
                    if next == 0 {
                        g.parent_dir_refs.remove(&parent_path);
                        // Capture parent path for the post-lock-release
                        // notify::unwatch call. The mirror file in
                        // `contexts/<collab_session_id>/<agent>.jsonl` (if any) stays on disk;
                        // clean-up is the user's call, matching the
                        // session-lifetime retention default.
                        Some(parent_path)
                    } else {
                        g.parent_dir_refs.insert(parent_path, next);
                        None
                    }
                } else {
                    None
                }
            } else {
                None
            }
        };  // <-- Inner lock DROPPED here

        // Phase B (notify_watcher lock, no Inner held): the actual
        // notify::Watcher::unwatch call. Best-effort: errors are
        // swallowed (the path may already be unwatched if FSEvents
        // detected the dir disappear). Critically, this can no longer
        // deadlock with on_fs_event because on_fs_event only locks
        // Inner, never notify_watcher.
        if let Some(parent) = parent_to_unwatch {
            if let Ok(mut nw) = self.notify_watcher.lock() {
                if let Some(w) = nw.as_mut() {
                    use notify::Watcher;
                    let _ = w.unwatch(&parent);
                }
            }
        }
    }

    /// Persist one normalized turn to `contexts/<collab_session_id>/<agent>.jsonl`.
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
        // Resolve agent_handle + collab_session_id under the lock; release
        // before the file IO so a slow disk doesn't block concurrent
        // watch/unwatch. `collab_session_id` is already sanitized (filled at
        // populate time) — it namespaces the mirror path per the collision fix.
        let (agent_handle, collab_session_id) = {
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
            // Cycle F: pending entries (handle == None) never reach here —
            // on_fs_event filters them out before the pipeline. If we do
            // arrive without a handle, fail loudly so the bug surfaces.
            let handle = entry.handle.as_ref().ok_or_else(|| {
                WatcherError::Io(std::io::Error::new(
                    std::io::ErrorKind::Other,
                    "append_normalized_turn called on pending entry",
                ))
            })?;
            (handle.agent_handle.clone(), handle.collab_session_id.clone())
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
        let full_path = dir
            .join("contexts")
            .join(&collab_session_id)
            .join(format!("{}.jsonl", agent_handle));
        // mkdir -p the session-scoped contexts dir (one extra level deeper
        // than the legacy flat layout).
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

    /// Rotate `contexts/<collab_session_id>/<agent>.jsonl` if it exceeds the active-file cap.
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
        let (agent_handle, collab_session_id) = {
            let g = self
                .inner
                .lock()
                .map_err(|_| WatcherError::NotStarted)?;
            let entry = match g.entries.get(&token.0) {
                Some(e) => e,
                None => return Ok(()),
            };
            // Cycle F: pending entries have nothing to rotate (no
            // mirror file exists yet). Silent no-op matches the
            // docstring's "rotation happens or not" semantic.
            let handle = match entry.handle.as_ref() {
                Some(h) => h,
                None => return Ok(()),
            };
            (handle.agent_handle.clone(), handle.collab_session_id.clone())
        };

        let dir = super::memory::get_memory_dir().map_err(|e| {
            WatcherError::Io(std::io::Error::new(std::io::ErrorKind::Other, e))
        })?;
        // Session-scoped active path — same rule as append (N6) so rotation
        // operates on the file the appends actually wrote.
        let contexts_dir = dir.join("contexts").join(&collab_session_id);
        let active_path = contexts_dir.join(format!("{}.jsonl", agent_handle));

        let size = match std::fs::metadata(&active_path) {
            Ok(m) => m.len(),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(e) => return Err(WatcherError::Io(e)),
        };
        if size <= ACTIVE_FILE_BYTE_CAP {
            return Ok(());
        }

        // Scan archive indices (T1: directory listing is authoritative).
        let indices = self.scan_archive_indices(&agent_handle, &collab_session_id);
        let next_n = indices.iter().max().copied().unwrap_or(0) + 1;
        let archive_path = contexts_dir.join(format!("{}.{}.jsonl", agent_handle, next_n));

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
        let tmp_active = contexts_dir.join(format!("{}.jsonl.tmp", agent_handle));
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
    /// `contexts/<collab_session_id>/<agent>.<N>.jsonl` files. Empty if no
    /// archives yet.
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
    pub fn scan_archive_indices(&self, agent_handle: &str, collab_session_id: &str) -> Vec<u32> {
        // T1: dir-listing is authoritative for "next archive N" — never
        // substitute a state-file cache. The state cache can lag a
        // successful rename and produce a colliding N on the next rotate.
        // Scan the session-scoped contexts dir so two collab sessions' archive
        // numbering never collides. Sanitize defensively (the handle already
        // stores a sanitized id, but this method is pub).
        let scope = sanitize_collab_session_id(collab_session_id);
        let dir = match super::memory::get_memory_dir() {
            Ok(d) => d.join("contexts").join(&scope),
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
        //
        // Lock-ordering invariant (task-11): lock Inner FIRST (sets the
        // shutdown flag so any in-flight on_fs_event observes it and
        // bails), then DROP Inner, then lock notify_watcher to drop the
        // RecommendedWatcher (whose Drop signals the FSEvents callback
        // thread to stop). Locking both at once would re-introduce the
        // notify-vs-on_fs_event deadlock.
        {
            let mut g = match self.inner.lock() {
                Ok(g) => g,
                Err(_) => return,
            };
            g.shutdown = true;
            // Cycle F (F6/F7): abort every pending discovery task before
            // dropping the entries map. Dropping an AbortHandle without
            // calling .abort() does NOT cancel the task — it would keep
            // polling against the Inner Arc (which survives shutdown via
            // the OnceLock) and would log retry errors forever.
            for entry in g.entries.values_mut() {
                if let Some(task) = entry.discovery_task.take() {
                    task.abort();
                }
            }
            g.entries.clear();
            g.parent_dir_refs.clear();
        }  // <-- Inner lock DROPPED here

        // Drop the notify::RecommendedWatcher — its Drop impl stops the
        // FSEvents thread. Per the docstring's invariant: no further
        // callbacks fire after this returns. By this point any in-flight
        // on_fs_event has either already returned, or it sees
        // shutdown=true (set above) and bails fast.
        if let Ok(mut nw) = self.notify_watcher.lock() {
            *nw = None;
        }
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

/// Tauri IPC: resolve a (session_id, tool, agent_handle) tuple to a
/// running transcript watch. The frontend (AgentMiniTerminal) doesn't
/// have direct access to the child PID — PTY spawning happens entirely
/// inside Rust and the PID is only on `PtySession.child`. So this
/// command takes `session_id` (which the frontend already has) and
/// resolves the PID server-side via `AppState.sessions`, then runs
/// the standard `adapter.discover_session` + `TranscriptWatcher::watch`
/// pipeline.
///
/// Single-call design (vs. a separate `get_pty_pid` IPC followed by
/// this one): avoids a TOCTOU window where the PTY could die between
/// PID resolution and watch registration. Both happen under one
/// command invocation; if the PTY dies mid-flight, `discover_session`
/// or `watch` surfaces the failure as a single error to the frontend.
#[tauri::command]
pub fn watch_transcript(
    transcript: tauri::State<'_, TranscriptWatcher>,
    app: tauri::State<'_, crate::state::AppState>,
    session_id: String,
    agent_handle: String,
    tool: String,
    spawned_at_unix_ms: i64,
    collab_session_id: String,
) -> Result<u64, String> {
    // Extract PID under a minimal lock scope so downstream lsof /
    // fs_gate / etc. don't gate behind the sessions mutex. Mirrors
    // the pattern in `pty.rs::get_pty_cwd`.
    let pid: i32 = {
        let sessions = app.sessions.lock().map_err(|e| e.to_string())?;
        let session = sessions
            .get(&session_id)
            .ok_or_else(|| format!("Session not found: {}", session_id))?;
        session
            .child
            .process_id()
            .ok_or("Cannot get child PID")? as i32
    };

    let adapter = adapters::adapter_for(tool.as_str())
        .ok_or_else(|| format!("unknown tool: {}", tool))?;
    // Cycle F: discovery is no longer sync at the IPC boundary. `watch`
    // inserts a PENDING entry and spawns the polling task; the token is
    // valid immediately and unwatch is idempotent in both pending and
    // populated states. spawned_at_unix_ms is passed through so the
    // trait signature stays stable (adapters ignore it under cycle F).
    let token = transcript
        .watch(adapter, agent_handle, pid, spawned_at_unix_ms, collab_session_id)
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

#[cfg(test)]
mod sanitize_tests {
    //! Plan N20: the sanitize contract is a SINGLE shared rule across the Rust
    //! writer and the TS reader (`peerContext.ts::sanitizeCollabSessionId`).
    //! These assertions mirror `src/lib/peerContext.test.ts` so the two never
    //! drift (a drift would make the agent's grep path diverge from the write
    //! path → collaboration deadlock).
    use super::sanitize_collab_session_id;

    #[test]
    fn keeps_allowed_drops_others() {
        assert_eq!(sanitize_collab_session_id("session-1-123"), "session-1-123");
        assert_eq!(sanitize_collab_session_id("a/b\\c..d e"), "abcde");
        assert_eq!(sanitize_collab_session_id("../../etc/passwd"), "etcpasswd");
        assert_eq!(sanitize_collab_session_id("foo_bar-9"), "foo_bar-9");
    }

    #[test]
    fn is_idempotent() {
        let once = sanitize_collab_session_id("we!rd/id");
        assert_eq!(sanitize_collab_session_id(&once), once);
    }
}
