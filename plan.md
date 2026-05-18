# Feature plan — peer-context-mirror-touchup

Plans a four-delta touch-up to the `peer-context-mirror` planner output
landed on `dev` at commit `e3a132e` (marker `(interfaces only, human-confirmed)`).
The touch-up closes the four skeleton gaps the prior implementer cycle's
four-reviewer peer-review surfaced (claude2 B1+B2, claude3 I1+I2, codex2
B2+B3+B4+Major-6, codex3 P0×2+P1×2). See
`.worktrees/implementer-peer-context-mirror-98411-57153-16414/implementation-report.md`
for the source review.

## Goal

Make four additive changes to committed planner skeletons so a follow-on
`/codebase-implementer` run can complete the **Tailer state I/O cluster**
(3 reverted items), the **shell-fallback env propagation** (K1/C1
reviewer-folded), and offer post-rotation inode tracking + chunk-relative
offset contracts that the prior cycle's adapter bodies already assumed
implicitly.

## In scope

- **A.** Add `pub memory_dir: PathBuf` field to `TranscriptHandle`
  (`src-tauri/src/commands/transcripts/mod.rs`). Populated by
  `TranscriptWatcher::watch` from `memory::get_memory_dir()` so Tailer
  state I/O writes `.state.json` inside `~/.cache/canvas-terminal/collab-memory/session-<pid>/`
  — never inside the external transcript root.
- **B.** Add `extra_env: Option<HashMap<String, String>>` parameter to
  `spawn_shell` (`src-tauri/src/commands/pty.rs`). Matches
  `spawn_process`'s existing shape. Body wiring (calling
  `apply_extra_env`) is the implementer's job.
- **C.** Tighten `TranscriptHandle.source_inode` docstring: "FROZEN at
  binding-time; the LIVE inode lives in `Tailer::TailState::inode`.
  Post-bind, never re-read source_inode." Resolves codex2 Major 6
  without struct-shape change.
- **D.** Tighten `TranscriptAdapter::parse_native_lines` + `RawTurn.source_offset`
  docstrings: "CHUNK-RELATIVE — measured from the start of the `bytes`
  slice passed in this call. Callers add `TailState::byte_offset` for
  absolute." Resolves codex2 B4 / codex3 P1, matches the implementation
  the prior cycle already shipped in all three adapters.

## Out of scope

- Implementation bodies for the remaining 28 stubbed methods + 3
  reverted Tailer methods (next `/codebase-implementer` cycle).
- `memory.rs` internal-helper delegation to `fs_safety/*` primitives
  (claude2 B2 / claude3 I5 — M7/U3 design goal; not blocking).
- `spawn_process` migration to call `apply_extra_env` (claude2 B3 / claude3
  I3 — DRY refactor; not blocking).
- `O_NOFOLLOW` on `poll_new_bytes` `open()` (claude2 L1 — TOCTOU polish).
- Shared `parse_jsonl_lines` helper extraction (claude2 L2 — DRY refactor).
- `fsync` after tmp-write in `persist_offset` (codex2 Major 7 — folds
  into the Tailer body when the implementer re-tackles those items).
- Frontend changes (no TS files touched in this run).

## Constraints

- **Additive only.** No signature drift on the 9 already-real items in
  `.worktrees/implementer-peer-context-mirror-98411-57153-16414`.
- **`TranscriptHandle.memory_dir` is `pub`** — visible to Tailer
  implementations in `tailer.rs`.
- **`spawn_shell` new parameter is `Option<HashMap<...>>`** — TS callers
  that omit the field receive `None` on the Rust side; backward-compatible
  for both Tauri JS callers and the existing `apply_baseline_env` path.
- **No body generation in this run.** Planner discipline: emit signatures
  + 9-field docstrings (where applicable), defer wiring to implementer.
- **C and D are docstring-only** — no shape change. The 9-field structure
  is preserved on `parse_native_lines`; we add to the existing fields,
  do not invent new ones.

## Success criteria

- `cargo check --manifest-path src-tauri/Cargo.toml` passes on the
  modified skeletons. (**Met**: 0 errors, 41 dead-code warnings expected
  on remaining planner stubs.)
- `TranscriptHandle` exposes `memory_dir: PathBuf` — Tailer state I/O
  in the next implementer cycle has a writable in-bounds path.
- `spawn_shell` accepts `extra_env: Option<HashMap<String, String>>`
  matching `spawn_process`.
- `TranscriptHandle.source_inode` docstring explicitly forbids
  post-bind re-reads; `TailState::inode` is named as the live-inode
  authority.
- `TranscriptAdapter::parse_native_lines` docstring explicitly states
  `RawTurn::source_offset` is chunk-relative; `RawTurn`'s own field
  docstring matches.

## Open questions

None remaining after Phase 1 confirmation. (All four deltas are named
verbatim in the prior implementer cycle's reviewer-folded report.)

## Package layout

No new packages introduced — touch-up lives entirely in two existing
files within `src-tauri/src/commands/`.

```
src-tauri/src/commands/
├── transcripts/
│   └── mod.rs       [MODIFIED] +1 field on TranscriptHandle (A)
│                                + docstring tightening on
│                                  TranscriptHandle.source_inode (C)
│                                + docstring tightening on
│                                  TranscriptAdapter::parse_native_lines (D)
│                                + docstring tightening on
│                                  RawTurn.source_offset (D)
└── pty.rs           [MODIFIED] +1 parameter on spawn_shell (B)
                                 + new 9-field docstring on spawn_shell
```

Dependency direction is unchanged from `architecture.mmd` on `dev`:
`TranscriptWatcher → TranscriptAdapter → TranscriptFsGate → FsSafety`.
This touch-up adds no nodes, no edges.

## Decomposition

| Node # | Stage | Node | Method / Field | Belongs to package | Notes |
|---|---|---|---|---|---|
| 1 | Session-binding fact | `TranscriptHandle` | `memory_dir: PathBuf` (new field) | `commands/transcripts/` | A — additive `pub` field; populated by `TranscriptWatcher::watch` |
| 2 | Session-binding fact | `TranscriptHandle` | `source_inode: u64` (existing field) | `commands/transcripts/` | C — docstring tightening; FROZEN contract surfaces |
| 3 | Transcript parsing | `TranscriptAdapter::parse_native_lines` | trait method docstring | `commands/transcripts/` | D — chunk-relative offset semantics surfaced |
| 4 | Transcript parsing | `RawTurn::source_offset` | field docstring | `commands/transcripts/` | D — matching chunk-relative contract on the field itself |
| 5 | PTY spawn (shell-fallback) | `spawn_shell` | function signature | `commands/pty.rs` | B — additive `extra_env: Option<HashMap<String, String>>` parameter + new 9-field docstring |

## Interfaces emitted

This run modified four touch-up targets on **existing** committed
skeletons; no new interfaces were introduced.

| Target | File | Kind | Lines changed |
|---|---|---|---|
| `TranscriptHandle` (struct) | `src-tauri/src/commands/transcripts/mod.rs` | shape + docstring | +28 / -8 |
| `RawTurn` (struct) | `src-tauri/src/commands/transcripts/mod.rs` | docstring | +9 / -1 |
| `TranscriptAdapter::parse_native_lines` (trait method) | `src-tauri/src/commands/transcripts/mod.rs` | docstring | +21 / -1 |
| `spawn_shell` (Tauri command) | `src-tauri/src/commands/pty.rs` | signature + docstring | +54 / -0 |

## Validation

- Phase 6 command: `cargo check --manifest-path src-tauri/Cargo.toml`
- Exit code: **0** — `Finished dev profile target(s) in 37.68s`
- Warnings: 41 (all `unused`/`dead_code` on remaining planner stubs in
  `transcripts/mod.rs`, `tailer.rs`, `watcher.rs`, and the three
  adapters — expected; baseline was 32 before this touch-up's stubs
  inherited additional dead-code visibility).
- Errors: 0

## Downstream contract

- Marker: `(plan-feature, human-confirmed)` (set by Phase 8 merge).
- Artifacts on `dev` after merge: `plan.md`, `plan.mmd`, plus the
  modified Rust skeleton files committed in `99086e5`.
- The next `/codebase-implementer` run targeting either this touch-up
  marker OR the original `(interfaces only, human-confirmed)` marker
  (`e3a132e`) should consume the updated `TranscriptHandle` shape +
  `spawn_shell` signature when wiring the remaining 28 stubs + 3
  reverted Tailer items.
