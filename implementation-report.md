# Implementation report — peer-context-mirror (post-review revision)

## Source
- Planner marker: `system` from commit `e3a132e`
- Planner artifacts: `architecture.html` + `architecture.mmd` (both on `dev`)
- Plan ingestion: `~/.cache/canvas-terminal/collab-memory/session-2103/task-24-claude1-context-sharing-plan.md` (56-delta fold-in matrix, 4 review rounds × 4 reviewers)
- Peer reviews folded this revision: claude2 B1+B2+B3, claude3 I1+I2, codex2 Blockers 2-3, codex3 P0×2 + P1×2

## Status: **partial completion — recommend `keep`**

Validation passes (cargo check + tsc --noEmit + test fixture all green),
but only 9 of 37 methods carry real bodies. Earlier pass claimed 12,
but post-review revealed 3 of those (Tailer state I/O) had a critical
correctness bug (B1/P0: wrote `.state.json` into external transcript
dirs). Those 3 were reverted to `todo!()` with a planner-gap note.

## Work queue summary

- Total items: 37
- **Completed (real bodies, post-review-verified)**: 9
- **Stubbed (`todo!()` / `throw`)**: 28
- **Reverted post-review**: 3 (Tailer state I/O — needs planner gap fix before re-impl)

## Items completed (9)

| # | Method | File | Post-review state |
|---|---|---|---|
| 1 | `canonicalize_no_symlinks` | `commands/fs_safety/mod.rs` | **P0 fix** — walks original path before canonicalize |
| 2 | `add_private_alias` | `commands/fs_safety/mod.rs` | clean |
| 3 | `reject_symlink_in_walk` | `commands/fs_safety/mod.rs` | clean |
| 4 | `pty::apply_extra_env` | `commands/pty.rs` | helper exists; not yet wired to callers (B3/I3 deferred) |
| 5 | `check_transcript_root` | `commands/transcripts/fs_gate.rs` | **P1 fix** — root canonicalized before comparison |
| 6 | `Tailer::poll_new_bytes` | `commands/transcripts/tailer.rs` | kept (no state I/O — operates on source path only) |
| 7 | `ClaudeCodeAdapter::parse_native_lines` | `adapters/claude_code.rs` | chunk-relative offsets (callers add base — see note B4 below) |
| 8 | `CodexAdapter::parse_native_lines` | `adapters/codex.rs` | same |
| 9 | `GeminiAdapter::parse_native_lines` | `adapters/gemini.rs` | same |

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

## Items NOT implemented (28) — grouped by integration surface

### Cluster A — adapter `discover_session` × 3 (requires lsof / `/proc/<pid>/fd`)
### Cluster B — adapter `normalize` × 3 (schema-specific filtering)
### Cluster C — `TranscriptWatcher` × 8 (notify crate + Tauri `State<>`)
### Cluster D — `watcher.rs` × 2 (`notify::RecommendedWatcher` wiring + debounce)
### Cluster E — frontend reader helpers × 5 (Tauri `invoke()`)
### Cluster F — frontend reservation API × 3 (`collaboratorStore` integration)
### Cluster G — React component × 3 (hooks, useEffect, lifecycle)
### Cluster H — `AgentMiniTerminal` useEffect cleanup × 1
### Cluster X — Tailer state I/O × 3 (reverted; awaits planner touch-up)

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

- Baseline exit (BASE_BRANCH HEAD): 0
- Final validation command: `cargo check --manifest-path src-tauri/Cargo.toml && cargo test --test transcript_adapter_contract --manifest-path src-tauri/Cargo.toml && npx tsc --noEmit`
- Final exit: 0
- Auto-fix attempts used: 0 / 3
- cargo check tail:
  ```
  warning: `canvas-terminal` (lib) generated 32 warnings
      Finished `dev` profile target(s) in 7.66s
  ```
  (32 dead-code warnings — down from 42 after Tailer revert; expected.)
- Test fixture: `1 passed; 0 failed`
- `git grep -l -i aider -- 'src-tauri/src/**' 'src/**'` → 0 lines

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
be335f1 fix(implementer): fold post-review P0/P1 corrections from peer reviews
d2803c4 docs(implementer): self-verification report — partial (12/37 items)
7870575 feat(implementer): items 10-12 — TranscriptAdapter::parse_native_lines for claude_code/codex/gemini
6d8aaf7 feat(implementer): items 1-9 for peer-context-mirror
```

## Recommended response at Phase 6

**`keep`** — still the right call.

Reviewers' consensus (4/4): do NOT merge.
- 9 real implementations are now post-review-verified (P0 symlink order + P1 fs_gate root canonicalization both folded).
- Test fixture proves trait extensibility (compile + pass).
- 28 stubs panic at runtime (acceptable as long as runtime callers don't exercise them; not wired to call sites yet).
- 3 Tailer methods explicitly blocked on a **planner gap** (memory_dir access) — re-implementing requires the planner to land an additive `memory_dir` field on `TranscriptHandle` first.

A follow-up implementer cycle should:
1. **First** run `/codebase-planner` for a small touch-up: add
   `memory_dir: PathBuf` to `TranscriptHandle`, add `extra_env` arg to
   `spawn_shell`. These are tiny additive changes (plan-local or
   plan-feature lane) that unblock the Tailer cluster + the
   shell-fallback env propagation.
2. **Then** re-invoke `/codebase-implementer` to resume from the
   existing worktree's state. The remaining 28 items + Tailer cluster
   will have correct interfaces to integrate against.
