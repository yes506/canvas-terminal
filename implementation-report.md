# Implementation report — wire-inode-rotation-recovery

## Source

- Planner marker: `local` (chat-gate) — `(plan-local, human-confirmed)`
  emitted by `/codebase-planner` in this session, followed by user
  `confirm plan`. Chat-only per the planner contract; no on-disk
  artifacts.
- Source: 3-bullet planner reflection block.

(Prior `implementation-report.md` on `dev@fb78cd0` documented the
`fix-strictmode-agent-dup` local run; this file is overwritten with
the inode-rotation-recovery report. Historical content reachable via
`git log` on the prior `(impl-local, human-confirmed)` merge.)

## Work queue summary

- Total items: 3 (chat bullets)
- Completed: 3
- Blocked: 0
- Source hash: N/A (chat-only planner output)

## Files changed

- `src-tauri/src/commands/transcripts/mod.rs` (+10 / -0) — `WatcherError::SourceRotation` variant added
- `src-tauri/src/commands/transcripts/tailer.rs` (+5 / -4) — `poll_new_bytes` returns typed variant
- `src-tauri/src/commands/transcripts/watcher.rs` (+20 / -0) — `on_fs_event` recovery arm + in-memory state update

## Validation

- Baseline exit (BASE_BRANCH HEAD `dev@fb78cd0`): 0
- Final validation command: `cargo check --manifest-path src-tauri/Cargo.toml && cargo test --test transcript_adapter_contract --manifest-path src-tauri/Cargo.toml`
- Final exit: 0
- Auto-fix attempts used: **0 / 3** (clean first pass)
- cargo check tail:
  ```
  warning: `canvas-terminal` (lib) generated 10 warnings
      Finished `dev` profile target(s) in 3.79s
  ```
  (10 warnings — down from 11 baseline. **The `handle_inode_change is never used` warning is gone**, confirming the wiring took effect.)
- transcript_adapter_contract fixture: 1 passed; 0 failed

## Per-item outcomes

| item_id | status | files_touched | notes |
|---|---|---|---|
| bullet-1 | completed | `mod.rs` | Added `WatcherError::SourceRotation` (no payload) alongside existing variants. Per-variant docstring documents the R2 contract that callers should invoke `handle_inode_change` on this error. |
| bullet-2 | completed | `tailer.rs` | `poll_new_bytes` inode-mismatch return changed from `Err(WatcherError::Io(io::Error::new(Other, "inode mismatch — caller must handle_inode_change")))` to `Err(WatcherError::SourceRotation)`. Magic string removed; the receiver discriminates via typed pattern match. |
| bullet-3 | completed | `watcher.rs` | `on_fs_event` Phase 2 poll match gains `Err(WatcherError::SourceRotation)` arm: invoke `handle_inode_change` → on success update `entries[token_id].tail_state = new_state` under the inner lock. In-memory update is essential — `handle_inode_change` persists the new TailState to `.state.json` but without the entries-map update, the next event would read the stale tail_state and the fix would silently undo. Existing `Err(_) => return` catch-all preserved for non-rotation Io errors. |

## Scope-discipline self-check

- [x] No new interfaces / files outside hints — touched only the 3 files the planner bullets named
- [x] No renames of committed public names — `WatcherError` keeps existing variants; `SourceRotation` is additive
- [x] No signature changes on planner-committed methods — `poll_new_bytes` / `handle_inode_change` signatures unchanged
- [x] No edits to `validation_command` configuration — `Cargo.toml` / `package.json` untouched
- [x] No edits to files outside the work queue's hint set — diff stat confirms exactly 3 files
- [x] Pattern restores the original docstring contract — `poll_new_bytes`'s prior magic-string error message ("caller must handle_inode_change") was the contract; this fix actualizes that contract via a typed variant

## Bug history (for the audit trail)

- **Long-standing wiring gap**: the `handle_inode_change` function has
  been correctly implemented since session 2 (commit `b484621`,
  merged at `9b8b463`), but no caller ever invoked it. The
  `poll_new_bytes` error message even told callers what to do
  (`"caller must handle_inode_change"`) but `watcher.rs::on_fs_event`
  swallowed all errors generically.
- **Dev-only manifestation today**: the gap only matters when the
  watcher actually fires on real agent transcripts. Cluster H
  (AgentMiniTerminal useEffect wiring) is still deferred, so the
  watcher hasn't been activated end-to-end in production-shaped
  flow. This fix is preparatory — once Cluster H ships, rotation
  recovery works from day one.
- **Discovered via**: the `npm run tauri dev` build log surfaced the
  `function 'handle_inode_change' is never used` warning. The user
  flagged the warnings; investigation traced the wiring gap to its
  exact two-file source.

## Commits on `implementer/wire-inode-rotation-recovery-47872-13635-1638`

```
11497c3 fix(implementer): wire handle_inode_change via typed WatcherError::SourceRotation variant
```

Branched off `dev@fb78cd0`.

## Recommended response at Phase 6

**`confirm merge`** — the fix is minimal (3 edits, ~30 lines), restores
the previously-untyped error-handling contract via a clean enum variant,
passes cargo check + fixture, and removes one of the two non-cosmetic
warnings on `dev` (the `handle_inode_change unused` one — the
`Entry::subscription_id` warning remains; that one is orthogonal).

After merge, the downstream marker `(impl-local, human-confirmed)`
lands and the watcher's rotation-recovery path becomes complete.
