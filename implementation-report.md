# Implementation report — cli-id-aliases

(Prior `implementation-report.md` on `dev` documented `cycle-f-hotfix`.
Overwritten with this micro-fix report; historical content reachable
via `git log -- implementation-report.md`.)

## Source

- Planner marker: `micro` (chat-only, this conversation) —
  `scale: micro   marker: (plan-micro, human-confirmed)`
- Planner artifacts: none (micro lane is chat-only per skill contract)
- Investigation context: `task-8-claude2-tool-id-mismatch.md` in shared
  collab-memory

## Work queue summary

- Total items: 1 (M1)
- Completed: 1
- Blocked: 0

## Files changed

| File | Lines (Δ) |
|---|---|
| `src-tauri/src/commands/transcripts/adapters/mod.rs` | +12 / -2 |
| **Total** | **+12 / -2** |

## Validation

- Baseline exit (`dev@dd3f817`): 0
- Final validation command: `cd src-tauri && cargo check && cd .. && npx tsc --noEmit && npm test`
- Final exit: 0
- Auto-fix attempts used: 0 / 3

Tail of last vitest run:

```
 Test Files  12 passed (12)
      Tests  216 passed (216)
   Start at  17:44:15
   Duration  1.57s
```

Cargo: 9 warnings (baseline-equivalent — same dead-code set).

## Per-item outcomes

| Item | Status | Files touched | Notes |
|---|---|---|---|
| M1 | completed | `src-tauri/src/commands/transcripts/adapters/mod.rs` | Extended `adapter_for`'s two affected match arms with `\|`-alternative patterns so both the canonical adapter `tool_id()` form (`"codex"` / `"gemini"`) AND the frontend `TOOL_CONFIGS` form (`"codex_cli"` / `"gemini_cli"`) route to the same `'static` adapter. Updated the doc-comment to explain the dual-id acceptance and pin the source of each form (canonical = `tool_id()`, frontend = `TOOL_CONFIGS.id`). On-disk schema unchanged: `source_tool` field still records the canonical form. |

## Scope-discipline self-check

- [x] No new interfaces / files outside hints — only the one file named in the plan was touched
- [x] No renames of committed public names — `adapter_for` signature unchanged
- [x] No signature changes on planner-committed methods — pure match-arm extension
- [x] No edits to validation_command configuration
- [x] No edits to files outside the work queue's hint set
- [x] No `git push`, force-push, reset --hard, or other destructive ops
- [x] No `--no-verify` or hook bypass

## Notes for reviewer

1. **Why `|`-alternative over a HashMap lookup**: idiomatic Rust for
   a 3-way exhaustive match; the compiler verifies all variants are
   handled at zero runtime cost. A HashMap would also work but adds
   allocation, hashing, and is harder to skim.

2. **Canonical-vs-alias contract**: the `tool_id()` trait method on
   each adapter still returns the canonical form (`"codex"`,
   `"gemini"`). `TranscriptHandle.adapter_id` is populated from
   `tool_id()` at discovery, so the on-disk `.state.json` and the
   `source_tool` field in `<handle>.jsonl` records always carry the
   canonical form regardless of which alias the caller used. This
   keeps the disk schema stable and `fs_gate::ALLOWED_ROOTS`
   unchanged.

3. **Next step (manual smoke test)**:
   - Stop the running `npm run tauri dev` (PID 85126)
   - Restart: `npm run tauri dev`
   - Spawn one agent each of Claude Code + Codex + Gemini
   - Send "hello" to each
   - Expected: all three `~/.cache/canvas-terminal/collab-memory/session-<pid>/contexts/<handle>.jsonl` appear within ~6s, no Eye click required
   - The Eye icon should already be in the publishing state at spawn
     (cycle F + hotfix contract)

4. **Follow-up worth considering** (out of scope, lesson from the
   three-bug debugging session): add a vitest+mock-Tauri-IPC contract
   test asserting `adapter_for(tool.id) === Some` for every entry in
   `TOOL_CONFIGS`. Would catch this class of bug as a unit test rather
   than relying on smoke tests. Mock the `invoke` boundary with
   a typed assertion table.
