# Implementation report — cycle-f-always-on-rearm

(Prior `implementation-report.md` on `dev` documented cycle E
`cycle-e-mtime-discovery`. Overwritten with this cycle F report;
historical content reachable via `git log -- implementation-report.md`.)

## Source

- Planner marker: `feature` from commit `b035a9c` —
  `feat(planner): merge cycle-f-always-on-rearm (plan-feature, human-confirmed)`
- Planner artifacts: `plan.md`, `plan.mmd`
- Source hash: `d800a648d30d`

## Work queue summary

- Total items: 7 (F1, F2, F3, F4, F5, F6, F7)
- Completed: 7
- Blocked: 0

## Files changed

| File | Lines (Δ) |
|---|---|
| `src-tauri/src/commands/transcripts/adapters/claude_code.rs` | +9 / -7 |
| `src-tauri/src/commands/transcripts/adapters/codex.rs` | +12 / -8 |
| `src-tauri/src/commands/transcripts/adapters/gemini.rs` | +17 / -10 |
| `src-tauri/src/commands/transcripts/adapters/mod.rs` | +252 / -90 |
| `src-tauri/src/commands/transcripts/mod.rs` | +345 / -121 |
| `src-tauri/src/commands/transcripts/watcher.rs` | +24 / -6 |
| `src/stores/collaboratorStore.ts` | +7 / -5 |
| `src/types/collaborator.ts` | +12 / -11 |
| **Total** | **+691 / -247** |

## Validation

- Baseline exit (`dev@b035a9c`): 0 (cargo + tsc + vitest all green)
- Final validation command: `cd src-tauri && cargo check && cd .. && npx tsc --noEmit && npm test`
- Final exit: 0
- Auto-fix attempts used: 0 / 3

Tail of last vitest run:

```
 Test Files  12 passed (12)
      Tests  216 passed (216)
   Start at  17:04:26
   Duration  1.57s
```

Cargo: 9 warnings (one fewer than baseline — `WatcherError::GateRejected`
is now never constructed because `populate_entry` logs+returns instead of
bubbling up; the variant is retained for future code).

## Per-item outcomes

| Item | Status | Files touched | Notes |
|---|---|---|---|
| F1 | completed | `src/stores/collaboratorStore.ts` | `publishOptedIn` default flipped `false → true` at `addAgent` (line ~1351); inline comment rewritten from "Default visibility OFF on session start" → "Default visibility ON; Eye toggle remains as per-agent opt-out". |
| F2 | completed | `src/types/collaborator.ts` | Both `SpawnedAgentInit.publishOptedIn` and `SpawnedAgent.publishOptedIn` docstrings reflect always-on default. Reader contract preserved — `=== true` strict check still safe; only direct-construction test fixtures get `undefined`. |
| F3 | completed | `src-tauri/src/commands/transcripts/adapters/mod.rs` | New `discover_pid_start_time(pid) -> io::Result<i64>` with three cfg branches (macOS `ps -o etime=`, Linux `/proc/<pid>/stat` field 22 + `/proc/uptime` + `libc::sysconf(_SC_CLK_TCK)`, other = `Unsupported`). `parse_ps_etime` helper handles all three etime formats (`MM:SS`, `HH:MM:SS`, `DD-HH:MM:SS`). |
| F4 | completed | `src-tauri/src/commands/transcripts/adapters/mod.rs` | `discover_by_mtime` signature changes `spawned_at_unix_ms → pid`. Threshold = `start_unix_secs * 1000` (no slack). 5×500ms retry loop removed → single-shot scan. `MTIME_DISCOVERY_MAX_ATTEMPTS`, `MTIME_DISCOVERY_RETRY_INTERVAL_MS`, `MTIME_THRESHOLD_SLACK_MS` deleted. Returned handle now has `pid: pid` (was `pid: 0`) — pass-through aligned with docstring intent. |
| F5 | completed | `claude_code.rs`, `codex.rs`, `gemini.rs`, `mod.rs` (trait docstring) | All three adapters now pass `pid` to `discover_by_mtime`. The `spawned_at_unix_ms` parameter is bound to `_spawned_at_unix_ms` (still in the trait signature for backward compat). Codex's `let _ = pid;` removed. Trait docstring on `TranscriptAdapter::discover_session` annotated: "ignored as of cycle F." |
| F6 | completed | `src-tauri/src/commands/transcripts/mod.rs`, `watcher.rs` | New `watch` signature: `(adapter, agent_handle, pid, spawned_at_unix_ms)`. Inserts PENDING `Entry` (handle/subscription_id/tail_state Optional), spawns `discovery_loop` tokio task. `discovery_loop` polls `adapter.discover_session` every 5s with shutdown / unwatch exit checks. `populate_entry` runs fs_gate + resume_from_state + subscribe_fsevents under two-phase commit with rollback on `unwatch` race. `on_fs_event` skips entries with `handle == None`. IPC `watch_transcript` rewritten to the new call shape — discovery moves inside `watch`. |
| F7 | completed | `src-tauri/src/commands/transcripts/mod.rs` | `unwatch` aborts `entry.discovery_task` before the existing ref-count decrement. Idempotent — abort on completed task is a no-op. Pending entries skip the FSEvents ref-count decrement because they never subscribed. `shutdown()` also iterates `entries.values_mut()` and aborts every `discovery_task` before clearing — required because `Drop` on `AbortHandle` does NOT cancel the task. |

## Scope-discipline self-check

- [x] No new interfaces / files outside hints (all changes are to files listed in the plan's IN-SCOPE block)
- [x] No renames of committed public names (`watch` / `unwatch` / `TranscriptWatcher` / `Entry` / `TranscriptHandle` / `TranscriptAdapter` all unchanged)
- [x] No signature changes on planner-committed methods (trait `TranscriptAdapter::discover_session` signature unchanged; `TranscriptWatcher::watch` signature changed per plan F6's explicit redesign)
- [x] No edits to validation_command configuration
- [x] No edits to files outside the work queue's hint set
- [x] No `git push`, force-push, reset --hard, or other destructive ops
- [x] No `--no-verify` or hook bypass

## Notes for reviewer

1. **Cycle F's IPC threshold parameter is intentionally kept.** Plan
   Out-of-scope: "Removing the `spawned_at_unix_ms` IPC parameter — kept
   for backward compatibility per cycle B's commitment." `watch_transcript`
   IPC still accepts it and threads it through; all three adapters
   ignore it under cycle F.

2. **`TranscriptHandle.pid` now flows the actual PID** (was hardcoded to
   `0` under cycle E). The cycle E code-comment claimed pass-through but
   the implementation hardcoded `0`. Cycle F's F4 uses `pid` for the
   threshold and naturally aligns the handle's `pid` field with the
   docstring intent. This is body-generation polish within F4's scope.

3. **Async runtime resolution**: `tokio::spawn` is called from inside the
   synchronous `watch_transcript` Tauri command. Tauri v2's command pool
   runs on the tokio runtime, so `tokio::spawn` succeeds. If a future
   refactor moves the command outside a tokio runtime context, the
   spawn would panic — convert `watch_transcript` to `async fn` at that
   point.

4. **`WatcherError::GateRejected` is now dead code** (1 of 9 dead-code
   warnings). The cycle E `watch` constructed it on fs_gate failure;
   cycle F's `populate_entry` logs + returns instead. Variant retained
   in the enum for future use — removing it is out-of-scope for cycle F
   per "no scope expansion" rule.

5. **Async / sync mutex**: the `Inner` mutex remains a `std::sync::Mutex`.
   The `discovery_loop` async task acquires it synchronously between
   sleeps — never across an `.await` point — so the std mutex is safe.
   Switching to `tokio::sync::Mutex` would ripple through all callers
   and is out-of-scope.

6. **Always-on UX**: per plan Risks section, users who don't read release
   notes may not realize transcripts now propagate. The Eye icon
   (Eye/EyeOff) is the visible opt-out affordance. CLAUDE.md docs
   follow-up explicitly deferred per plan.
