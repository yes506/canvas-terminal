# Implementation report — cycle-d-discover-walk-and-drain

(Prior `implementation-report.md` on `dev` documented cycle C
`cycle-c-publish-toggle`. Overwritten with this cycle D report;
historical content reachable via `git log -- implementation-report.md`.)

## Source
- Planner marker: `local` from chat-gate `(plan-local, human-confirmed)` (same-session)
- Planner artifacts: chat-only (lightweight lane — no committed plan.md)
- Source hash: n/a (chat-only handoff)

## Work queue summary
- Total items: 2
- Completed: 2
- Blocked: 0

## Files changed
- `src-tauri/src/commands/transcripts/adapters/mod.rs` (+138 / -8)
- `src-tauri/src/commands/transcripts/mod.rs` (+49 / -19)

## Validation
- Baseline exit (BASE_BRANCH HEAD `dev@9992041`): 0
- Final validation command: `cd src-tauri && cargo check && cd .. && npx tsc --noEmit && npm test`
- Final exit: 0
- Auto-fix attempts used: 0/3
- `cargo check`: 10 warnings (all pre-existing — same set as baseline, no new ones)
- `tsc --noEmit`: exit 0, no errors
- `npm test`: **216 / 216 pass** in 12 test files, 1.64s
  ```
  Test Files  12 passed (12)
       Tests  216 passed (216)
    Duration  1.64s
  ```

## Per-item outcomes

| item_id  | status    | files_touched                                              | notes |
|----------|-----------|-----------------------------------------------------------|-------|
| bullet-1 | completed | `src-tauri/src/commands/transcripts/adapters/mod.rs`     | Refactored `discover_pid_fd` into `discover_pid_fd` (BFS orchestrator) + `scan_one_pid` (single-PID lsof/proc walk, preserves original logic verbatim) + `list_children` (macOS pgrep / Linux /proc/<pid>/task/*/children union). BFS capped at depth=4 (const `DESCENDANT_WALK_DEPTH_CAP`), breadth=32 per level (const `DESCENDANT_WALK_BREADTH_CAP`). Error policy: input-PID scan failure propagates as `Err(io)`; per-descendant scan errors and `list_children` failures silently degrade to empty/skip. No signature change. |
| bullet-2 | completed | `src-tauri/src/commands/transcripts/mod.rs`              | `TranscriptWatcher::watch` now clones `handle.source_path` before the entry consumes `handle`, scopes the lock acquire/insert/release into a `{ ... }` block, then calls `watcher::on_fs_event(&watcher::Subscription(0), &source_path_for_drain)` after the lock drops. The synthesized event re-acquires Inner, finds the entry by `event_path == handle.source_path`, bypasses the debounce (`last_event_at = None`), and runs the existing poll+parse+normalize+persist pipeline from `byte_offset = 0`. No new lock-ordering concern (the synthesized event uses the same code path notify uses). |

## Scope-discipline self-check
- [x] No new interfaces / files — touched only the 2 files the plan named
- [x] No renames of committed public names — `discover_pid_fd` keeps its signature `(pid: i32, predicate: F) -> io::Result<Option<PathBuf>>`; `TranscriptWatcher::watch` unchanged
- [x] No signature changes on planner-committed methods — the new helpers (`scan_one_pid`, `list_children`) are private to the module
- [x] No edits to `validation_command` configuration — `Cargo.toml`/`package.json`/`tsconfig.json` untouched
- [x] No edits to files outside the work queue's hint set — diff stat confirms exactly 2 files
- [x] Existing public docstrings preserved; new doc comments only on the new helpers and the new BFS caps const block

## Architecture-pattern notes

- **BFS-from-input-PID instead of "lsof on all descendants in one shot"**: a single recursive `lsof -p <root>` doesn't exist; even `lsof -R` (repeated mode) doesn't walk descendants. BFS is the portable choice and keeps the per-PID scan logic reusable on each node. The depth/breadth caps mean discovery cost is bounded — at most 4 × 32 = 128 lsof invocations on a pathological tree, but typical 2-level shell→cli trees cost 2 invocations + 1 pgrep.
- **Per-descendant error skip vs. fail-fast**: silently skipping per-descendant errors is the correct policy because the goal is "find any matching FD anywhere in the tree". A dead intermediate (zombie reaped between `list_children` and `scan_one_pid`) shouldn't poison sibling branches. Only the input-PID scan failure propagates — that's the bound PID and a real OS error there is the caller's problem.
- **Initial drain reuses `on_fs_event`, doesn't duplicate poll-loop logic**: `on_fs_event` already does the full pipeline (lock → debounce → poll → parse → normalize → append → persist), and its return type `()` with internal error-swallowing matches what we want for a best-effort drain. The synthesized call observes the same invariants the production notify-thread call observes — including the debounce, which is correct: if a real FSEvent arrives between `entries.insert` and our synthesized call, whichever runs first sets `last_event_at`, and the other no-ops.
- **`source_path_for_drain` clone**: necessary because `handle` is moved into the `Entry` inside the lock scope. The clone happens before the lock, costs one `Vec<u8>` allocation per `watch()` call (cheap), and lets the synthesized `on_fs_event` look the entry up by path without re-acquiring `handle` from the map.

## Commits on `implementer/cycle-d-discover-walk-and-drain-58122-38567-26207`

```
3818eec feat(implementer): cycle D — discover_pid_fd descendant walk + watch() initial drain
```

Branched off `dev@9992041`.

## Smoke-test plan (post-merge, user-driven)

The cycle D fixes target a runtime path that has no unit-test coverage
(Rust transcripts module has no `#[cfg(test)]` hits). Verification is by
manual smoke:

1. After merge: `npm run tauri dev` (forces cargo rebuild so the new
   binary picks up the Rust changes).
2. Spawn a Claude Code agent through the mini-terminal. The
   `spawn_shell` fallback path is the most diagnostic — pick a tool
   whose bare command isn't on Tauri's `spawn_process` PATH (the user
   already confirmed this is the normal path for `claude` in their
   environment).
3. Send one or two chat turns to populate the source JSONL.
4. Click the Eye toggle on the mini-terminal header.
5. Immediately check `~/.cache/canvas-terminal/collab-memory/session-<APP_PID>/contexts/` — the directory should now appear with a `<handle>.jsonl` file containing the pre-existing turns (initial drain working).
6. Send another chat turn; the `<handle>.jsonl` should grow within ~2s (FSEvents debounce + tailer poll — existing path, sanity-only).
7. Edge case: click Eye BEFORE the agent has produced any output. After the agent's first reply, `contexts/<handle>.jsonl` should appear (descendant walk found the CLI PID for the post-spawn lsof retry that on_fs_event triggers).

## Recommended response at Phase 6

**`confirm merge`** — cycle D closes the discovery + initial-drain gap
the user surfaced during cycle C's verification. Both fixes are narrow,
backwards-compatible (input-PID scan error policy preserved; existing
public signatures unchanged), and validated without auto-fix
intervention.

After merge, downstream marker `(impl-local, human-confirmed)` lands on
`dev`. The peer-context-mirror feature should then be runtime-verifiable
end-to-end without any DevTools workaround — Eye-toggle alone surfaces
context.
