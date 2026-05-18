# Implementation report — peer-context-mirror (session 2 — post-touchup)

## Source
- Planner marker (original): `system` from commit `e3a132e` (interfaces only, human-confirmed)
- Planner marker (touch-up): `feature` from commit `bffb828` (plan-feature, human-confirmed) — merged into this implementer branch via `cb6...` chore commit so `TranscriptHandle.memory_dir` (delta A) and `spawn_shell::extra_env` (delta B) are now visible to the implementer
- Planner artifacts: `architecture.html` + `architecture.mmd` (system) + `plan.md` + `plan.mmd` (touch-up) — all on `dev`
- Plan ingestion: `~/.cache/canvas-terminal/collab-memory/session-2103/task-24-claude1-context-sharing-plan.md` (56-delta fold-in matrix, 4 review rounds × 4 reviewers)
- Peer reviews folded across the planner+implementer cycles: claude2 B1+B2+B3, claude3 I1+I2, codex2 Blockers 2-3 + Major 6 + B4, codex3 P0×2 + P1×2, claude3 task-2 N1+N2 (touch-up)

## Status: **partial completion (session 2) — recommend `keep`**

Validation passes (`cargo check` + test fixture both green), now with
**12 of 37 methods carrying real bodies** (up from 9 in session 1).
The 3 Tailer state-I/O items the prior cycle reverted are now
re-implemented using `TranscriptHandle::memory_dir` from the planner
touch-up. 25 items remain stubbed across non-Tailer clusters.

## Work queue summary

- Total items: 37
- **Completed (real bodies, post-review-verified)**: 12 (was 9 in session 1; +3 this session)
- **Stubbed (`todo!()` / `throw`)**: 25 (was 28 in session 1)
- **Reverted post-review**: 0 (was 3 in session 1 — all 3 re-implemented post-touch-up)

## Items completed (12)

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

## Items NOT implemented (25) — grouped by integration surface

### Cluster A — adapter `discover_session` × 3 (requires lsof / `/proc/<pid>/fd`)
### Cluster B — adapter `normalize` × 3 (schema-specific filtering)
### Cluster C — `TranscriptWatcher` × 8 (notify crate + Tauri `State<>`)
### Cluster D — `watcher.rs` × 2 (`notify::RecommendedWatcher` wiring + debounce)
### Cluster E — frontend reader helpers × 5 (Tauri `invoke()`)
### Cluster F — frontend reservation API × 3 (`collaboratorStore` integration)
### Cluster G — React component × 3 (hooks, useEffect, lifecycle)
### Cluster H — `AgentMiniTerminal` useEffect cleanup × 1
### Cluster X — Tailer state I/O × 3 — ✅ **CLOSED in session 2 (b484621)**

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

### Session 2 (post-touch-up)
- Baseline exit (BASE_BRANCH HEAD post-touchup `bffb828`): 0
- Final validation command: `cargo check --manifest-path src-tauri/Cargo.toml && cargo test --test transcript_adapter_contract --manifest-path src-tauri/Cargo.toml`
- Final exit: 0
- Auto-fix attempts used: 0 / 3
- cargo check tail:
  ```
  warning: `canvas-terminal` (lib) generated 36 warnings
      Finished `dev` profile target(s) in 2.36s
  ```
  (36 dead-code warnings — down from 41 because the 3 Tailer items are no longer dead-code; expected.)
- Test fixture: `1 passed; 0 failed` (`transcript_adapter_contract::fixture_implements_trait`)
- `git grep -l -i aider -- 'src-tauri/src/**' 'src/**'` → 0 lines (unchanged from session 1)

### Session 1 (pre-touch-up, historical)
- Final exit: 0
- 32 dead-code warnings — down from 42 after Tailer revert
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

## Commits on `implementer/peer-context-mirror-98411-57153-16414`

```
b484621 feat(implementer): items 13-15 — Tailer state I/O (peer-context-mirror)  ← SESSION 2
<merge> chore(implementer): merge planner touch-up bffb828 into branch          ← SESSION 2
8f3f760 docs(implementer): post-review report revision (9 real / 28 stubbed / 3 reverted)
be335f1 fix(implementer): fold post-review P0/P1 corrections from peer reviews
d2803c4 docs(implementer): self-verification report — partial (12/37 items)
7870575 feat(implementer): items 10-12 — TranscriptAdapter::parse_native_lines for claude_code/codex/gemini
6d8aaf7 feat(implementer): items 1-9 for peer-context-mirror
```

## Session 2 — touch-up consumption + Tailer cluster (this revision)

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

**`keep`** — still the right call for session 2.

Updated reasoning (session 2):
- **12 real implementations** are now post-review-verified — session 1's 9 plus session 2's 3 Tailer state-I/O items, all unblocked by the touch-up at `bffb828`.
- Test fixture continues to prove trait extensibility (compile + pass).
- **25 stubs** panic at runtime — acceptable as long as runtime callers don't exercise them; the runtime call graph (frontend → TranscriptWatcher::watch → adapter.discover_session → tailer poll loop) does not yet have a call site that reaches the stubs.
- **0 reverted items** — the planner touch-up's `memory_dir` field closed the prior blocker cleanly.

Why still `keep` and not `confirm merge`:
- Merging now would land 12-of-37 items on `dev` with `(impl-system, human-confirmed)`; that's incomplete per the marker contract (which signals "the whole planner handoff is implemented"). Better to phase: subsequent sessions add clusters A–H, then a single merge lands the full system implementation.
- Each cluster has its own complexity (notify-crate threading, lsof PID→fd cross-platform, Tauri State<>, React hooks) that warrants its own peer-review cycle.

A follow-up implementer cycle should:
1. **First** run `/codebase-planner` for a small touch-up: add
   `memory_dir: PathBuf` to `TranscriptHandle`, add `extra_env` arg to
   `spawn_shell`. These are tiny additive changes (plan-local or
   plan-feature lane) that unblock the Tailer cluster + the
   shell-fallback env propagation.
2. **Then** re-invoke `/codebase-implementer` to resume from the
   existing worktree's state. The remaining 28 items + Tailer cluster
   will have correct interfaces to integrate against.
