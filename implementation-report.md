# Implementation report — notify-mutex-split

(Prior `implementation-report.md` on `dev` documented
`codex-gemini-schema-fix`. Overwritten with this local-lane report;
historical content reachable via `git log -- implementation-report.md`.)

## Source

- Planner marker: `local` (chat-only, this conversation) —
  `scale: local   marker: (plan-local, human-confirmed)`
- Planner artifacts: none (local lane is chat-only per skill contract)
- Investigation context: `task-11-claude2-deadlock-found.md` +
  `task-12-claude2-bug2-decoupled.md` in shared collab-memory

## Work queue summary

- Total items: 6 (NM1 through NM6)
- Completed: 6
- Blocked: 0

## Files changed

| File | Lines (Δ) |
|---|---|
| `src-tauri/src/commands/transcripts/mod.rs` | +197 / -95 |
| `src-tauri/src/commands/transcripts/watcher.rs` | +94 / -29 |
| **Total** | **+291 / -124** |

## Validation

- Baseline exit (`dev@945d167`): 0 (cargo + tsc + vitest all green;
  17 adapter fixture tests pass)
- Final validation command:
  `cd src-tauri && cargo test --lib commands::transcripts::adapters && cargo check && cd .. && npx tsc --noEmit && npm test`
- Final exit: 0
- Auto-fix attempts used: 0 / 3

Tail of last `cargo test`:

```
test result: ok. 17 passed; 0 failed; 0 ignored; 0 measured; 20 filtered out; finished in 0.00s
```

Tail of last vitest:

```
 Test Files  12 passed (12)
      Tests  216 passed (216)
   Start at  13:51:51
   Duration  1.42s
```

Cargo: 9 warnings (baseline-equivalent).

## Per-item outcomes

| Item | Status | Files touched | Notes |
|---|---|---|---|
| NM1 | completed | `mod.rs` | Moved `notify::RecommendedWatcher` from `Inner.watcher` to a new `TranscriptWatcher.notify_watcher: Arc<Mutex<Option<RecommendedWatcher>>>` field. Updated `new()` to initialize both Inner and notify_watcher. Added lock-ordering invariant docstring on TranscriptWatcher (Inner first, then notify_watcher; FSEvents callback locks ONLY Inner). |
| NM2 | completed | `mod.rs:start_if_needed` | Split the shutdown check (Inner mutex) from the already-installed check (notify_watcher mutex). Race-recheck on shutdown survives via Inner; race-recheck on already-installed survives via notify_watcher. New watcher is installed under the notify_watcher mutex; if shutdown raced between checks, the freshly-built watcher is dropped (Drop stops FSEvents thread). |
| NM3 | completed | `watcher.rs:subscribe_fsevents` | Refactored to Phase A (Inner lock for next_id + parent_dir_refs pre-increment) → DROP → Phase B (notify_watcher lock for notify::Watcher::watch). On notify::watch failure, Phase C briefly re-acquires Inner to roll back the ref-count. Added `WATCHER_NOTIFY` static + `install_notify_watcher` helper paralleling the existing WATCHER_INNER pattern. |
| NM4 | completed | `mod.rs:unwatch` (THE deadlock fix) | Refactored to capture `parent_to_unwatch: Option<PathBuf>` while holding Inner (for entries.remove + parent_dir_refs decrement + discovery_task.abort), DROP Inner, then call notify::Watcher::unwatch under the separate notify_watcher mutex. Abort of discovery_task stays inside Inner (no notify interaction). This is THE fix for the user-reported "infinite pending on close after contexts file created" deadlock. |
| NM5 | completed | `mod.rs:populate_entry` rollback path | Same pattern as NM4 for the unwatch-race rollback branch. Decrement parent_dir_refs under Inner, capture `release_parent: Option<PathBuf>`, drop Inner, then notify::unwatch via `watcher::notify_watcher_handle()` helper (new accessor on watcher.rs that borrows the static OnceLock-installed Arc). Used a small local enum `PopulateOutcome` to thread the three states (Populated / RaceRollback / LockPoisoned) cleanly across the lock boundary. |
| NM6 | completed | `mod.rs:shutdown` | Inner first: sets shutdown=true (any in-flight on_fs_event observes and bails), aborts discovery tasks, clears entries + parent_dir_refs. DROP Inner. Then notify_watcher mutex: set to None to drop the RecommendedWatcher (Drop signals FSEvents thread to stop). Order matters: shutdown=true is set BEFORE we drop the watcher so the FSEvents thread fires its last callback (if any) into a flagged Inner that bails. |

Also touched (forced by NM1's struct change):
- `watcher.rs:on_fs_event` — the `TranscriptWatcher` façade construction
  now also clones the notify_watcher Arc (via WATCHER_NOTIFY.get())
  so the struct literal type-checks. append_normalized_turn /
  rotate_if_needed don't call into notify, so the field is unused by
  the façade path, but the wiring is forward-compat.

## Scope-discipline self-check

- [x] No new interfaces / files outside hints — only the two files named in the plan
- [x] No renames of committed public names — `TranscriptWatcher` / `Inner` / `subscribe_fsevents` / `on_fs_event` / `WatchToken` / `Entry` all unchanged externally
- [x] No signature changes on planner-committed methods — `watch`, `unwatch`, `start_if_needed`, `shutdown`, `subscribe_fsevents`, `on_fs_event` all keep their existing signatures
- [x] No edits to validation_command configuration
- [x] No edits to files outside the work queue's hint set (only mod.rs + watcher.rs)
- [x] No `git push`, force-push, reset --hard, or other destructive ops
- [x] No `--no-verify` or hook bypass

## Notes for reviewer

1. **Lock-ordering invariant is the load-bearing contract**. The
   `TranscriptWatcher` docstring documents it in detail; every call
   site that needs both mutexes follows the pattern: lock Inner →
   bookkeeping → DROP → lock notify_watcher → notify call. Future
   contributors who add new code touching either mutex MUST honor this
   ordering or the deadlock comes back.

2. **`populate_entry` enum was a deliberate choice**. The previous
   inline `let populated = match ... { true / false }` couldn't carry
   the rollback's `Option<PathBuf>` cleanly across the lock release.
   A 3-variant enum (`Populated` / `RaceRollback(Option<PathBuf>)` /
   `LockPoisoned`) makes the three states explicit and lets the
   notify::unwatch fire OUTSIDE the lock without re-entering it.

3. **Bug 2 (U+25AF rectangles) NOT addressed here**. Per task-12,
   Bug 2 is confirmed pre-existing on main (independent of cycle F).
   This fix only addresses Bug 1's deadlock. Bug 2 follows in its own
   investigation cycle.

4. **No new fixture tests**. The deadlock requires concurrent FSEvents
   firings, which can't be reproduced in a unit test without a real
   filesystem watcher running. The manual smoke test below is the
   actual contract; documented as a follow-up consideration in task-11.

5. **Manual smoke test (THE actual contract for this fix)**:
   - Stop the running `npm run tauri dev` (if any), restart
   - Spawn one Claude Code agent
   - Send `hello` and wait for the response — verify
     `~/.cache/canvas-terminal/collab-memory/session-<pid>/contexts/claude1.jsonl`
     materializes (proves FSEvents is firing for the source JSONL)
   - Click X on the agent terminal
   - **Expected**: terminal pane disappears within ~1s; the agent
     record is removed from `useCollaboratorStore.getState().agents`
   - **NOT expected**: infinite pending / terminal stays visible /
     no DevTools logs
   - Repeat for Codex + Gemini agents
   - If Bug 1 is fixed, retest Bug 2 (right-arrow continuously in
     each terminal). If U+25AF rectangles still appear, file a fresh
     task — Bug 2 is decoupled from this fix per task-12.

## Bug-chain context (cycle F merge → today)

| Commit | Marker | What it fixed |
|---|---|---|
| `b6921a9` | impl-feature cycle-f-always-on-rearm | Cycle F always-on watcher |
| `dd3f817` | impl-local cycle-f-hotfix | Eye disabled + tokio runtime panic |
| `0fd3928` | impl-micro cli-id-aliases | adapter_for accepting codex_cli/gemini_cli |
| `945d167` | impl-local codex-gemini-schema-fix | normalize bodies + 17 fixture tests |
| **this**  | **impl-local notify-mutex-split** | **task-11 deadlock fix — Bug 1** |

Bug 2 stays as a documented follow-up. This commit is the **5th and
hopefully final fix** in the post-cycle-F bug chain.
