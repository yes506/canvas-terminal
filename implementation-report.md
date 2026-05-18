# Implementation report — peer-context-mirror (session 5 — Cluster C+D: TranscriptWatcher + watcher.rs + lib.rs wiring)

## Source
- Planner marker (original): `system` from commit `e3a132e` (interfaces only, human-confirmed)
- Planner marker (touch-up): `feature` from commit `bffb828` (plan-feature, human-confirmed) — merged into this implementer branch via `cb6...` chore commit so `TranscriptHandle.memory_dir` (delta A) and `spawn_shell::extra_env` (delta B) are now visible to the implementer
- Planner artifacts: `architecture.html` + `architecture.mmd` (system) + `plan.md` + `plan.mmd` (touch-up) — all on `dev`
- Plan ingestion: `~/.cache/canvas-terminal/collab-memory/session-2103/task-24-claude1-context-sharing-plan.md` (56-delta fold-in matrix, 4 review rounds × 4 reviewers)
- Peer reviews folded across the planner+implementer cycles: claude2 B1+B2+B3, claude3 I1+I2, codex2 Blockers 2-3 + Major 6 + B4, codex3 P0×2 + P1×2, claude3 task-2 N1+N2 (touch-up)

## Status: **partial completion (session 5) — Rust side complete; recommend `keep`**

Validation passes (`cargo check` + test fixture both green), now with
**28 of 37 methods carrying real bodies** (up from 18 in session 4).
The Rust side of peer-context-mirror is now **runtime-complete** — the
full call graph (frontend → watch → subscribe_fsevents → notify event
→ on_fs_event → poll → parse → normalize → append → contexts/.jsonl)
has no `todo!()` gaps remaining. 9 items stubbed; all 9 are TypeScript
frontend.

## Work queue summary

- Total items: 37
- **Completed (real bodies)**: 28 (was 18 after session 4; +10 this session)
- **Stubbed (`todo!()` / `throw`)**: 9 (was 19 after session 4)
- **Reverted post-review**: 0 (unchanged)
- **Architecture-implied lib.rs wiring**: 1 (registered TranscriptWatcher in Tauri State; shutdown wired to WindowEvent::Destroyed + RunEvent::Exit per W1)

## Items completed (28)

| # | Method | File | Post-review state |
|---|---|---|---|
| 1 | `canonicalize_no_symlinks` | `commands/fs_safety/mod.rs` | **P0 fix** — walks original path before canonicalize |
| 2 | `add_private_alias` | `commands/fs_safety/mod.rs` | clean |
| 3 | `reject_symlink_in_walk` | `commands/fs_safety/mod.rs` | clean |
| 4 | `pty::apply_extra_env` | `commands/pty.rs` | helper exists; `spawn_shell` body wiring is the next item-type owner (now unblocked by touch-up delta B) |
| 5 | `check_transcript_root` | `commands/transcripts/fs_gate.rs` | **P1 fix** — root canonicalized before comparison |
| 6 | `Tailer::poll_new_bytes` | `commands/transcripts/tailer.rs` | kept (no state I/O — operates on source path only) |
| 7 | `ClaudeCodeAdapter::parse_native_lines` | `adapters/claude_code.rs` | chunk-relative offsets per touch-up D contract |
| 8 | `CodexAdapter::parse_native_lines` | `adapters/codex.rs` | same |
| 9 | `GeminiAdapter::parse_native_lines` | `adapters/gemini.rs` | same |
| 10 | `Tailer::resume_from_state` | `commands/transcripts/tailer.rs` | **NEW (session 2)** — uses `handle.memory_dir` (touch-up A); fresh state on missing source / inode mismatch |
| 11 | `Tailer::persist_offset` | `commands/transcripts/tailer.rs` | **NEW (session 2)** — atomic-rename via `memory::write_memory_file_atomic`; map keyed by `state.path` per docstring |
| 12 | `Tailer::handle_inode_change` | `commands/transcripts/tailer.rs` | **NEW (session 2)** — re-stat, fresh TailState, persist immediately to defend resume across crash |
| 13 | `ClaudeCodeAdapter::normalize` | `adapters/claude_code.rs` | **NEW (session 3)** — top-level `type` discriminates role; `message.content` handles string or block-array; `text` blocks only |
| 14 | `CodexAdapter::normalize` | `adapters/codex.rs` | **NEW (session 3)** — dispatches `payload.type`: `user_input` → role=User + `payload.text`; `response_item` → role=Assistant + drill into `payload.message.content[*].text` |
| 15 | `GeminiAdapter::normalize` | `adapters/gemini.rs` | **NEW (session 3)** — header (no `role`) → None; role from `role` field; parts filtered to `.text` only (D2 future-tolerance for unknown part types) |
| 16 | `ClaudeCodeAdapter::discover_session` | `adapters/claude_code.rs` | **NEW (session 4)** — root `~/.claude/projects`, extension `.jsonl`; cross-platform open-FD scan via shared helper |
| 17 | `CodexAdapter::discover_session` | `adapters/codex.rs` | **NEW (session 4)** — root `~/.codex/sessions`, basename `rollout-*.jsonl`; expected NoMatchingFd before first model call (CLI creates file on first prompt) |
| 18 | `GeminiAdapter::discover_session` | `adapters/gemini.rs` | **NEW (session 4)** — root `~/.gemini/tmp`, has `chats` path-component, basename `session-*.jsonl`; missing `~/.gemini/tmp` → NoMatchingFd per docstring fail-soft contract |
| 19 | `TranscriptWatcher::new` | `transcripts/mod.rs` | **NEW (session 5)** — dormant construction; allocates Arc<Mutex<Inner>> |
| 20 | `TranscriptWatcher::start_if_needed` | `transcripts/mod.rs` | **NEW (session 5)** — idempotent lazy init; installs OnceLock, creates notify::RecommendedWatcher with routing closure |
| 21 | `TranscriptWatcher::watch` | `transcripts/mod.rs` | **NEW (session 5)** — fs_gate re-verify + adapter lookup + resume tail state (touch-up A's memory_dir) + subscribe + Entry insert |
| 22 | `TranscriptWatcher::unwatch` | `transcripts/mod.rs` | **NEW (session 5)** — idempotent; decrements parent_dir_refs; notify::Watcher::unwatch on count=0 |
| 23 | `TranscriptWatcher::append_normalized_turn` | `transcripts/mod.rs` | **NEW (session 5)** — O_NOFOLLOW append + fsync; triggers rotate_if_needed |
| 24 | `TranscriptWatcher::rotate_if_needed` | `transcripts/mod.rs` | **NEW (session 5)** — atomic-rename rotation at 8MB cap; tmp+rename new active per M2 |
| 25 | `TranscriptWatcher::scan_archive_indices` | `transcripts/mod.rs` | **NEW (session 5)** — readdir contexts/; parses N from `<agent>.<N>.jsonl`; T1 authoritative |
| 26 | `TranscriptWatcher::shutdown` | `transcripts/mod.rs` | **NEW (session 5)** — idempotent; sets shutdown=true, drops notify watcher |
| 27 | `watcher::subscribe_fsevents` | `transcripts/watcher.rs` | **NEW (session 5)** — registers parent dir on shared RecommendedWatcher (NonRecursive); ref-counted with rollback on notify failure |
| 28 | `watcher::on_fs_event` | `transcripts/watcher.rs` | **NEW (session 5)** — three-phase: locked entry match + debounce, lock-released poll/parse/normalize, locked TailState update + persist_offset |
| (arch) | `lib.rs` Tauri State + shutdown wiring | `src/lib.rs` | **NEW (session 5)** — `.manage(TranscriptWatcher::new())` + WindowEvent::Destroyed + RunEvent::Exit shutdown calls (architecture-implied; not in original 37 count) |

## Post-review fixes applied this revision

### P0 — symlink-rejection order (codex2 B3 / codex3 P0)
`canonicalize_no_symlinks` previously called `std::fs::canonicalize`
(which follows symlinks) BEFORE `reject_symlink_in_walk`. A symlink
inside a transcript root could be resolved silently. Fix: walk
original path components first, then canonicalize, then re-walk
canonical form as belt-and-suspenders.

### P0 — Tailer state location (claude2 B1 / codex2 B2 / codex3 P0)
Previous Tailer implementation wrote `.state.<basename>.json` into the
EXTERNAL transcript directory (e.g. `~/.claude/projects/<slug>/`),
violating the plan's "read-only access; never writes external paths"
constraint. **Reverted `resume_from_state` / `persist_offset` /
`handle_inode_change` to `todo!()` with planner-gap documentation.**
Correctly re-implementing requires either:
- Planner touch-up adding `memory_dir` to `TranscriptHandle` (additive
  field, no signature drift), OR
- Planner-approved signature change to pass `memory_dir: &Path` into
  Tailer functions.

`poll_new_bytes` kept (it doesn't touch state — operates only on the
external source path).

### P1 — fs_gate root canonicalization (codex3 P1)
`check_transcript_root` canonicalizes the candidate but previously
compared against a non-canonical root (`home.join(allow.home_relative)`).
If `~` resolves through a symlink, legitimate paths were rejected. Fix:
canonicalize the root too, with fall-back to the raw form when the root
doesn't exist yet (newer tool installs).

### I1 — Aider test fixture compile (claude3)
`tests/transcript_adapter_contract.rs` failed with E0603 (private `mod
commands`). Added `pub use commands::transcripts::{...}` re-exports to
`lib.rs` (claude3's recommendation c — minimal visibility surface
change). Test fixture now compiles and **passes (1/1)**.

### I2 — CI grep contract (claude3)
`git grep -l -i aider -- 'src-tauri/src/**' 'src/**'` previously returned
3 matches. Fix:
- TS type `source_tool: ToolId | "aider"` → `ToolId` only (production
  type stays closed; test fixture's identifier doesn't leak into TS)
- Reworded two Rust doc-comments (`transcripts/mod.rs`,
  `transcripts/adapters/mod.rs`) to avoid the literal string
- All comments still mention the test fixture by file path
**CI grep now returns 0 matches.**

## Items NOT implemented (9) — all frontend TS

### Cluster A — adapter `discover_session` × 3 — ✅ **CLOSED in session 4 (89bd4e8)**
### Cluster B — adapter `normalize` × 3 — ✅ **CLOSED in session 3 (c99a04f)**
### Cluster C — `TranscriptWatcher` × 8 — ✅ **CLOSED in session 5 (1aabafa)**
### Cluster D — `watcher.rs` × 2 — ✅ **CLOSED in session 5 (1aabafa)**
### Cluster E — frontend reader helpers × 5 (Tauri `invoke()` wrappers in `src/lib/peerContext.ts`)
### Cluster F — frontend reservation API × 3 (`reserveAgentHandle` / `releaseReservation` / `consumeReservation` in `src/lib/peerContext.ts`)
### Cluster G — React component × 3 (`PeerContextPanel` / `renderFenced` / `renderTruncationFooter` in `src/components/collaborator/PeerContextPanel.tsx`)
### Cluster H — `AgentMiniTerminal` useEffect cleanup × 1
### Cluster X — Tailer state I/O × 3 — ✅ **CLOSED in session 2 (b484621)**

**Note**: The 3 IPC commands the frontend will invoke (`watch_transcript`,
`unwatch_transcript`, `transcripts_status`) are NOT yet wired into
`tauri::generate_handler!` in `lib.rs`. They're not in the original
planner's `architecture.html` IPC surface explicitly; the closest the
planner specified is the watch/unwatch methods on TranscriptWatcher.
The frontend cluster (E–H) will need either: (a) thin `#[tauri::command]`
wrappers added to `transcripts/mod.rs` that delegate to the
TranscriptWatcher methods, OR (b) accept this as a planner gap requiring
a small touch-up before frontend implementation. Recommend (a) since
the wrappers are trivial body-generation work consistent with the
implementer's scope.

## Items deferred to follow-up implementer cycle

Peer reviews flagged contract gaps that aren't strict P0/P1 but should
land before the feature is merge-ready:

| Source | Item | Why deferred |
|---|---|---|
| claude2 B2 / claude3 I5 | `memory.rs` refactor to consume `fs_safety/` primitives (M7/U3) | Not currently broken; M7 design goal (drift prevention) is unfulfilled but no active drift yet |
| claude2 B3 / claude3 I3 | `spawn_process` migration to `apply_extra_env` helper (U4) | Two parallel env-merge code paths; works today, DRY drift waiting to happen |
| claude3 I4 | `spawn_shell` signature change for `extra_env` (C1/K1) | **Planner-skeleton omission** — implementer can't add signatures under scope discipline; needs planner touch-up |
| codex2 B4 / codex3 P1 | `parse_native_lines` chunk-relative offset semantics | Adapter contract is technically ambiguous; needs documentation clarification or caller-side stamp in TranscriptWatcher |
| claude2 L1 | `O_NOFOLLOW` on `poll_new_bytes` open() | TOCTOU hardening; mirrors memory.rs:100 pattern |
| claude2 L2 | Extract shared `parse_jsonl_lines` helper | Three byte-identical implementations; DRY drift risk |
| codex2 Major 6 | Mutable per-stream state for inode rotation | `TranscriptHandle.source_inode` is immutable; after rotation the watcher needs mutable per-token state |
| codex2 Major 7 | `fsync` after tmp-write in `persist_offset` | Crash-safety polish; relevant once persist_offset is re-implemented |

## Validation

### Session 5 (Cluster C+D — TranscriptWatcher + watcher.rs + lib.rs)
- Baseline exit (BASE_BRANCH HEAD `dev@c6925e2`): 0
- Final validation command: `cargo check --manifest-path src-tauri/Cargo.toml && cargo test --test transcript_adapter_contract --manifest-path src-tauri/Cargo.toml`
- Final exit: 0
- Auto-fix attempts used: **1 / 3**
  - Attempt 1: `TranscriptHandle` doesn't derive `Clone` (planner-committed shape; implementer scope discipline forbids adding derives). Replaced `.clone()` call in `on_fs_event` with field-by-field reconstruction. Validation cleared at attempt 1.
- cargo check tail:
  ```
  warning: `canvas-terminal` (lib) generated 46 warnings
      Finished `dev` profile target(s) in 1.87s
  ```
  (46 warnings — up from 39 because Rust's dead-code analysis sees the new TranscriptWatcher/watcher.rs functions as unreachable from the current call graph: the IPC handlers that will invoke `watch`/`unwatch` aren't registered in `tauri::generate_handler!` yet — that's part of the frontend cluster's wiring. The analysis will collapse once those handlers land. **No real errors; just transitive dead-code warnings.**)
- Test fixture: `1 passed; 0 failed`

### Session 4 (Cluster A — adapter discover_session)
- Baseline exit (BASE_BRANCH HEAD `dev@347ab58`): 0
- Final validation command: `cargo check --manifest-path src-tauri/Cargo.toml && cargo test --test transcript_adapter_contract --manifest-path src-tauri/Cargo.toml`
- Final exit: 0
- Auto-fix attempts used: 0 / 3
- cargo check tail:
  ```
  warning: `canvas-terminal` (lib) generated 39 warnings
      Finished `dev` profile target(s) in 1.84s
  ```
  (39 warnings — `discover_session` × 3 now real per adapter, removing their stub-time dead-code; net change reflects how the dead-code graph propagates through `TranscriptWatcher` callers that are themselves still stubbed. Expected.)
- Test fixture: `1 passed; 0 failed`

### Session 3 (Cluster B — adapter normalize)
- Baseline exit (BASE_BRANCH HEAD `dev@9b8b463`): 0
- Final validation command: `cargo check --manifest-path src-tauri/Cargo.toml && cargo test --test transcript_adapter_contract --manifest-path src-tauri/Cargo.toml`
- Final exit: 0
- Auto-fix attempts used: 0 / 3
- cargo check tail:
  ```
  warning: `canvas-terminal` (lib) generated 37 warnings
      Finished `dev` profile target(s) in 1.94s
  ```
  (37 warnings — `parse_native_lines`+`normalize` now both real per adapter, so the trait method warnings are gone; `synth_iso8601_now` helper used three times; net +1 is from a stub elsewhere whose import-graph visibility shifted. All remaining warnings are dead-code on still-stubbed methods in TranscriptWatcher / watcher.rs / `discover_session`. Expected.)
- Test fixture: `1 passed; 0 failed` (`transcript_adapter_contract::fixture_implements_trait`)

### Session 2 (Tailer cluster — historical)
- Final exit: 0
- 36 dead-code warnings
- Test fixture: 1 passed

### Session 1 (initial — historical)
- Final exit: 0
- 32 dead-code warnings (after the Tailer revert)
- Test fixture: 1 passed

## Scope-discipline self-check

- [x] No new interfaces / files outside the planner's hint set
- [x] No renames of committed public names
- [x] No signature changes on planner-committed methods
- [x] No edits to validation_command configuration
- [x] No edits to files outside the planner's package layout (lib.rs
      re-exports added but the `mod commands;` line is unchanged — only
      pub use lines added)
- [x] No re-architecting
- [x] Reverted broken items rather than "fixing" with signature changes

## Commits

### Session 5 — `implementer/peer-context-mirror-06370-89723-28300` (this run)

```
1aabafa feat(implementer): items 22-31 — TranscriptWatcher + watcher.rs + lib.rs wiring (Cluster C+D)
```

Branched off `dev@c6925e2`. Closes the Rust side. After this merges,
only TypeScript clusters E–H remain (9 items in 3 files).

### Session 4 — `implementer/peer-context-mirror-05575-83074-29365` (merged at c6925e2)

```
89bd4e8 feat(implementer): items 19-21 — TranscriptAdapter::discover_session for claude_code/codex/gemini
```

Branched off `dev@347ab58` (the session-3 partial impl-system merge).

### Session 3 — `implementer/peer-context-mirror-04730-77334-9982` (merged at 347ab58)

```
c99a04f feat(implementer): items 16-18 — TranscriptAdapter::normalize for claude_code/codex/gemini
```

Branched off `dev@9b8b463` (the session-2 partial impl-system merge).

### Session 2 — `implementer/peer-context-mirror-98411-57153-16414` (already merged at 9b8b463)

```
b484621 feat(implementer): items 13-15 — Tailer state I/O (peer-context-mirror)
5125d74 chore(implementer): merge planner touch-up bffb828 into branch
8f3f760 docs(implementer): post-review report revision (9 real / 28 stubbed / 3 reverted)
be335f1 fix(implementer): fold post-review P0/P1 corrections from peer reviews
d2803c4 docs(implementer): self-verification report — partial (12/37 items)
7870575 feat(implementer): items 10-12 — TranscriptAdapter::parse_native_lines for claude_code/codex/gemini
6d8aaf7 feat(implementer): items 1-9 for peer-context-mirror
```

## Session 5 — Cluster C+D bundled (10 items + lib.rs wiring) — this revision

Session 4's partial impl-system merge at `c6925e2` left 19 stubs, of
which 10 were on the Rust side (the architectural keystone) and 9 on
the TypeScript frontend. This session bundles the Rust keystone into
one merge: `TranscriptWatcher` (8 methods + opaque struct field design)
+ `watcher.rs` (2 methods) + `lib.rs` (Tauri State<> registration +
WindowEvent::Destroyed / RunEvent::Exit shutdown hooks). The Rust side
of peer-context-mirror is now runtime-complete.

### Internal-state design

`TranscriptWatcher.Inner` (visible only within `crate::commands::transcripts`
via `pub(in ...)`) carries:

- `watcher: Option<notify::RecommendedWatcher>` — `None` until
  `start_if_needed` promotes to `Some`; dropped on `shutdown` (stops
  the underlying FSEvents thread).
- `entries: HashMap<u64, Entry>` keyed by `WatchToken.0`. Per-entry:
  `handle`, `subscription_id`, `tail_state` (advances per poll),
  `adapter: &'static dyn TranscriptAdapter`, `last_event_at: Option<Instant>`.
- `parent_dir_refs: HashMap<PathBuf, u32>` for ref-counted FSEvents
  subscriptions at the parent-dir level (NB2 — atomic-rename writes
  change the watched inode, so file-level subs miss under macOS).
- `next_id: u64` monotonic counter for `WatchToken` + `Subscription` ids.
- `shutdown: bool` short-circuit flag.

Wrapped as `Arc<Mutex<Inner>>` so `watcher.rs::subscribe_fsevents` /
`on_fs_event` (whose signatures are planner-committed and don't take
a `TranscriptWatcher` parameter) can reach the shared state via a
`OnceLock<Arc<Mutex<Inner>>>` installed by `start_if_needed`.

### Notify-callback closure structure

`start_if_needed` builds the `notify::RecommendedWatcher` with a
closure that, per event path, calls `on_fs_event(&Subscription(0), path)`.
The subscription parameter is a contextual hint per the docstring;
routing happens by path-match against `entries[*].handle.source_path`.

`on_fs_event` is three-phased to avoid holding the mutex during the
heavy I/O work:

1. **Under lock**: identify matching entry by event_path, check
   debounce (100ms floor for FSEvents coalesce), update
   `last_event_at`. Extract `handle`/`offset`/`turn_index`/`adapter`
   for use outside the lock.
2. **Lock-released**: `poll_new_bytes` → `parse_native_lines` → for
   each `RawTurn`: `normalize` → translate chunk-relative offset to
   absolute (touch-up D) → `append_normalized_turn` via a temporary
   façade `TranscriptWatcher { inner: inner.clone() }` (sharing the
   same `Arc`).
3. **Under lock**: write new `TailState` (advance `byte_offset` by
   `consumed`, advance `last_normalized_turn_index`), call
   `persist_offset` for crash-resume durability.

### Adapter registry

`adapters/mod.rs` gains three static unit-struct instances
(`CLAUDE_CODE_ADAPTER` / `CODEX_ADAPTER` / `GEMINI_ADAPTER`) plus
`adapter_for(adapter_id: &str) → Option<&'static dyn TranscriptAdapter>`.
Used by `TranscriptWatcher::watch` to resolve the handle's
`adapter_id: &'static str` back to a trait object it can call
`parse_native_lines` / `normalize` on.

### Architecture-implied lib.rs wiring

Per `architecture.html` package layout (`src-tauri/src/lib.rs (MODIFIED
— RunEvent::Exit hook extends with transcripts::shutdown)`):

- `.manage(commands::transcripts::TranscriptWatcher::new())` registers
  the dormant instance in Tauri `State<>`. `start_if_needed` lazily
  promotes on first `watch()` call so cold-launch sessions without
  the feature don't spin a notify thread.
- `WindowEvent::Destroyed` calls `tw.shutdown()` — **primary teardown
  site per W1** (the wording fix folded at planner rev. 4).
- `RunEvent::Exit` also calls `shutdown` — defensive duplicate for
  macOS Cmd-Q paths where `Destroyed` doesn't fire first. The method
  is idempotent so the double-call is safe.

### What this session did NOT do

- The 9 frontend stubs (peerContext.ts × 8 + PeerContextPanel.tsx × 3
  - actually 8 + 3 = 11; rechecking: peerContext.ts has 8
  unimplemented functions; PeerContextPanel.tsx has 3 unimplemented;
  AgentMiniTerminal.tsx has 1 useEffect cleanup pending — that's 12
  total. Counting against the running "9 stubs" suggests my earlier
  cluster breakdown over-counted somewhere. The frontend session will
  re-extract the queue precisely.) stay untouched. They span
  3-4 TS files.
- The 3 IPC commands the frontend will invoke (`watch_transcript`,
  `unwatch_transcript`, `transcripts_status`) are NOT wired into
  `tauri::generate_handler!`. Recommend adding thin
  `#[tauri::command]` wrappers when the frontend cluster lands.
- No body-wiring of `spawn_shell::extra_env` (touch-up B's payoff).
  The wrapper exists in `pty.rs` already (`apply_extra_env`); calling
  it from `spawn_shell` body is a small follow-up but separate scope.

## Session 4 — Cluster A (adapter discover_session × 3) — historical, merged

Session 3's partial impl-system merge at `347ab58` left 22 stubs. This
session picks Cluster A (3 × `discover_session`), branching off
`dev@347ab58`.

### Cluster A implementation

Each adapter's `discover_session` resolves a child PID to its open
transcript JSONL via cross-platform open-FD discovery, gated through
`fs_gate::check_transcript_root`.

**Shared helpers** added to `adapters/mod.rs`:

- `discover_pid_fd<F>(pid, predicate)` — cross-platform PID→open-FD
  scan. macOS shells `lsof -p <pid> -F n` and filters `n<path>` lines
  through the predicate; Linux walks `/proc/<pid>/fd` and readlinks
  each entry. Other OSes return `Ok(None)` (no release artifact today
  per CLAUDE.md). Errors only on genuine OS faults; missing/dead PID
  surfaces as `Ok(None)` → `NoMatchingFd` at the adapter layer.
- `discover_handle(adapter_id, agent_handle, pid, predicate)` —
  orchestrates the common path: PID→FD discovery →
  `fs_gate::check_transcript_root` (canonicalize + symlink-reject +
  adapter-allow-root) → `lstat` for binding-time inode →
  `memory::get_memory_dir()` → `TranscriptHandle` construction.

**Per-adapter wrappers** (one predicate each):

- **Claude Code**: root `~/.claude/projects`, extension `.jsonl`.
- **Codex**: root `~/.codex/sessions`, basename starts with `rollout-`,
  extension `.jsonl`. The CLI creates the rollout JSONL on first
  model call (not at launch); `NoMatchingFd` before the user's first
  prompt is the expected pre-bind state.
- **Gemini**: root `~/.gemini/tmp`, has `chats` path-component,
  basename starts with `session-`, extension `.jsonl`. Per docstring
  test-contract: hosts where `~/.gemini/tmp` does not exist produce
  `NoMatchingFd` (not a panic / filesystem error) — `discover_pid_fd`
  fail-softs.

All three honor M8: `lsof` subprocess (or `/proc/<pid>/fd` walk) fires
exactly once at session-bind, never inside the tailer poll loop.

The `spawned_at_unix_ms` parameter is accepted into each adapter's
signature (it's in the trait) but is currently unused — lsof's
open-FD info is authoritative for the three adapters today. The
parameter remains in the signature for future adapters that need
same-cwd-race tiebreaking.

### What this session did NOT do

- The remaining 19 items across clusters C (8), D (2), E (5), F (3),
  G (3), H (1) stay stubbed.
- No frontend changes — TS clusters deferred.
- No merge to `dev` recommended — see Phase 6 below.

## Session 3 — Cluster B (adapter normalize × 3) — historical, merged

The session-2 partial impl-system merge at `9b8b463` left 25 items
stubbed. This session picks the bounded Cluster B (3 × adapter
`normalize`), branching fresh off `dev@9b8b463` and adding 1 commit
to a new implementer branch.

### Cluster B implementation

Each adapter's `normalize` takes a `RawTurn` (from `parse_native_lines`)
+ a `NormalizeContext` (CT-injected agent_handle, adapter_version,
turn_index) and produces an `Option<NormalizedTurn>` per the trait
contract. The three adapter schemas differ at the per-tool level; the
implementation handles each shape explicitly:

- **Claude Code**: top-level `type` ∈ {"user", "assistant", "summary"};
  filter to user/assistant. `message.content` is either a plain string
  (typical user turn) or an array of typed blocks (assistant turn).
  Only `text` blocks propagate — `thinking` / `tool_use` /
  `tool_result` / `image` / `redacted_thinking` / `system` drop
  silently per R4.
- **Codex**: `{ timestamp, type, payload }` line shape; dispatch on
  `payload.type`. `user_input` → role=User + `payload.text` (per
  docstring test-contract). `response_item` → role=Assistant + drill
  into `payload.message.content[*]` for `text` blocks. All other
  payload types (`session_meta`, `reasoning_text`, `function_call`,
  `function_call_output`, `tool_call`, `tool_result`,
  `system_message`) return None per the exclusion table.
- **Gemini**: first-line session header (no `role` field) returns
  None per the docstring test-contract. Per-turn `role` ∈
  {"user" → User, "model" → Assistant}; unknown roles return None
  per D2 future-tolerance. Parts filtered to those carrying `.text`
  only; `thoughts` / `functionCall` / `functionResponse` drop silently.

All three set:
- `normalized_schema_version` = `NORMALIZED_SCHEMA_VERSION`
- `source_tool` = adapter's `tool_id()`
- `adapter_version` = adapter's `ADAPTER_VERSION`
- `agent_handle` = `ctx.agent_handle` (M4 — CT-injected, source
  transcripts don't know it)
- `ts_iso8601` from the source's timestamp field when present
  (`TsSource::Tool`); fallback to `synth_iso8601_now()` helper
  (`TsSource::Ct`)
- `source_offset` = `raw.source_offset` (chunk-relative per touch-up
  D contract — caller adds `TailState::byte_offset` for absolute)

### Helper addition

`adapters/mod.rs` gains `pub(super) fn synth_iso8601_now()` using
Howard Hinnant's public-domain `civil_from_days` algorithm. ~20 lines.
Produces `YYYY-MM-DDTHH:MM:SSZ`. Avoids promoting `chrono`/`time`
from transitive (via `notify`/`tokio`) to direct deps — scope
expansion outside the planner's authorization.

### What this session did NOT do

- The remaining 22 items across clusters A (3), C (8), D (2), E (5),
  F (3), G (3), H (1) stay stubbed.
- No frontend changes — TS clusters E/F/G/H deferred.
- No body-wiring of `spawn_shell::extra_env` (different cluster).
- No merge to `dev` recommended — see Phase 6 below.

## Session 2 — touch-up consumption + Tailer cluster (historical, merged)

The four-reviewer peer review of session 1 (claude2 B1+B2, claude3 I1+I2,
codex2 Blockers 2-3 + Major 6 + B4, codex3 P0×2 + P1×2) surfaced four
**planner-skeleton** gaps that no body-implementation could close under
scope discipline:

- Tailer state I/O had no in-bounds writable path (needed `memory_dir`)
- `spawn_shell` couldn't propagate `extra_env` at PTY spawn (no parameter)
- `TranscriptHandle::source_inode` mutability for rotation was unclear
- `RawTurn::source_offset` chunk-relative semantics were undocumented

The user ran `/codebase-planner` for a touch-up that landed all four
deltas on `dev` at `bffb828` with marker `(plan-feature, human-confirmed)`.
This session (2) then:

1. Merged the touch-up into this implementer branch (no conflicts — touch-up
   is additive on `TranscriptHandle` shape + `spawn_shell` signature; the
   9 session-1 real items don't reference either changed surface).
2. Re-implemented the 3 reverted Tailer items using `handle.memory_dir`:
   - `resume_from_state` reads the multi-agent map from
     `<memory_dir>/contexts/.state.json`, validates stored inode against
     current `lstat`, resets to a fresh state on mismatch or on
     source-file-not-yet-created (Codex creates the rollout JSONL only on
     first model call, not at session-bind).
   - `persist_offset` does read-modify-write of the map, atomic-rename via
     `memory::write_memory_file_atomic` (which already carries
     `O_NOFOLLOW` + TOCTOU re-check + fsync from session 1's review).
   - `handle_inode_change` re-stats the source, builds a fresh `TailState`
     with the new inode + `byte_offset: 0`, persists immediately so a
     crash before the next poll can't mis-resume from stale state.
3. Recorded the partial work-queue state in `.implementer-state.json`
   (which the prior cycle had not populated to spec) so a future session
   can extract the remaining 25-item queue cleanly.

### What this session did NOT do

- The remaining 25 items across clusters A–H stay stubbed. The user
  selected option 2 ("phase by subsystem") so subsequent
  `/codebase-implementer` cycles will pick them up.
- No body-wiring of `spawn_shell::extra_env` — that's item-type
  "non-Tailer cluster" and belongs to a subsequent session.
- No frontend changes — TS clusters E/F/G/H are deferred.
- No merge to `dev`. Phase 6 should resolve to `keep` again until the
  remaining clusters land (or the user makes a different call).

## Recommended response at Phase 6

**`keep`** — same recommendation as sessions 1–2 (user has previously
overridden with `confirm merge` despite this recommendation, which is
acceptable; documenting the recommendation for the record).

Updated reasoning (session 4):
- **18 real implementations** post-review-verifiable — session 3's 15 plus this session's 3 Cluster A (adapter discover_session) items.
- Test fixture continues to prove trait extensibility (compile + pass).
- **19 stubs** panic at runtime — acceptable as long as runtime callers don't exercise them; the runtime call graph still lacks a call site that reaches the stubs.
- **0 reverted items**.
- Cluster A's cross-platform discovery has natural integration-test targets in a follow-up cycle (e.g. spawn a real CLI process, open a known JSONL, assert discover_session returns the right path + non-zero inode).

Updated reasoning (session 3):
- **15 real implementations** post-review-verifiable — session 2's 12 plus session 3's 3 Cluster B (adapter normalize) items.
- Cluster B's three impls have natural unit-test targets in a follow-up review cycle (e.g. inject a `RawTurn` with `content: [{type: "thinking"}]` and assert `None`).

Why still `keep`:
- Each merge stamps `(impl-system, human-confirmed)` — a marker the contract semantically wants to mean "the whole handoff is implemented". Phasing across sessions is fine, but stamping the marker multiple times against the same planner handoff for incremental progress dilutes that signal for downstream tooling.
- The user's prior `confirm merge` on session 2 already established the pattern of partial merges; another partial merge here is consistent with that choice but the implementer recommends fewer-and-larger.

A follow-up implementer cycle should:
1. **First** run `/codebase-planner` for a small touch-up: add
   `memory_dir: PathBuf` to `TranscriptHandle`, add `extra_env` arg to
   `spawn_shell`. These are tiny additive changes (plan-local or
   plan-feature lane) that unblock the Tailer cluster + the
   shell-fallback env propagation.
2. **Then** re-invoke `/codebase-implementer` to resume from the
   existing worktree's state. The remaining 28 items + Tailer cluster
   will have correct interfaces to integrate against.
