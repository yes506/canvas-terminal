# Implementation report — codex-gemini-schema-fix

(Prior `implementation-report.md` on `dev` documented `cli-id-aliases`.
Overwritten with this local-lane report; historical content reachable
via `git log -- implementation-report.md`.)

## Source

- Planner marker: `local` (chat-only, this conversation) —
  `scale: local   marker: (plan-local, human-confirmed)`
- Planner artifacts: none (local lane is chat-only per skill contract)
- Investigation context: `task-9-claude2-adapter-schema-mismatch.md`
  in shared collab-memory

## Work queue summary

- Total items: 2 (S1, S2)
- Completed: 2
- Blocked: 0

## Files changed

| File | Lines (Δ) |
|---|---|
| `src-tauri/src/commands/transcripts/adapters/codex.rs` | +179 / -51 |
| `src-tauri/src/commands/transcripts/adapters/gemini.rs` | +180 / -34 |
| **Total** | **+359 / -85** |

Split per item:
- codex.rs: `normalize` body rewrite (~40 lines) + `#[cfg(test)] mod tests` (~110 lines, 9 tests)
- gemini.rs: `normalize` body rewrite (~35 lines) + `#[cfg(test)] mod tests` (~125 lines, 8 tests)

## Validation

- Baseline exit (`dev@0fd3928`): 0 (cargo + tsc + vitest all green; 0 pre-existing adapter tests)
- Final validation command:
  `cd src-tauri && cargo test --lib commands::transcripts::adapters && cargo check && cd .. && npx tsc --noEmit && npm test`
- Final exit: 0
- Auto-fix attempts used: 0 / 3

Tail of last `cargo test` run:

```
running 17 tests
test commands::transcripts::adapters::codex::tests::user_message_event_normalizes_to_user_role ... ok
test commands::transcripts::adapters::codex::tests::agent_message_event_normalizes_to_assistant_role ... ok
test commands::transcripts::adapters::codex::tests::session_meta_returns_none ... ok
test commands::transcripts::adapters::codex::tests::turn_context_returns_none ... ok
test commands::transcripts::adapters::codex::tests::response_item_returns_none ... ok
test commands::transcripts::adapters::codex::tests::task_started_event_returns_none ... ok
test commands::transcripts::adapters::codex::tests::token_count_event_returns_none ... ok
test commands::transcripts::adapters::codex::tests::empty_user_message_returns_none ... ok
test commands::transcripts::adapters::codex::tests::missing_timestamp_falls_back_to_ct_source ... ok
test commands::transcripts::adapters::gemini::tests::user_turn_with_content_array_normalizes_to_user_role ... ok
test commands::transcripts::adapters::gemini::tests::user_turn_with_multi_block_content_joins_text_only ... ok
test commands::transcripts::adapters::gemini::tests::gemini_turn_with_content_string_normalizes_to_assistant_role ... ok
test commands::transcripts::adapters::gemini::tests::gemini_turn_with_empty_content_returns_none ... ok
test commands::transcripts::adapters::gemini::tests::session_header_returns_none ... ok
test commands::transcripts::adapters::gemini::tests::set_state_update_returns_none ... ok
test commands::transcripts::adapters::gemini::tests::unknown_type_returns_none ... ok
test commands::transcripts::adapters::gemini::tests::missing_timestamp_falls_back_to_ct_source ... ok

test result: ok. 17 passed; 0 failed; 0 ignored; 0 measured; 20 filtered out; finished in 0.00s
```

Tail of last `vitest` run:

```
 Test Files  12 passed (12)
      Tests  216 passed (216)
   Start at  12:12:31
   Duration  1.56s
```

Cargo: 9 warnings (baseline-equivalent).

## Per-item outcomes

| Item | Status | Files touched | Notes |
|---|---|---|---|
| S1 | completed | `src-tauri/src/commands/transcripts/adapters/codex.rs` | Normalize body rewritten to accept `top.type=event_msg` with `payload.type=user_message|agent_message` and `payload.message` as plain string. Skips response_item (avoids double-emission), session_meta, turn_context, and all non-message event_msg subtypes. Docstring + inline comments updated with the real schema citations from task-9's investigation. 9 fixture tests added covering: user_message → User role, agent_message → Assistant role, all skip paths, empty message, missing timestamp fallback. |
| S2 | completed | `src-tauri/src/commands/transcripts/adapters/gemini.rs` | Normalize body rewritten to accept `top.type=user|gemini` (was incorrectly `role` field with `user|model`) and read `content` as either array-of-blocks (user shape) or plain string (gemini shape). Skips `thoughts` (reasoning trace), session header (no `type`), `$set` state updates (no `type`). 8 fixture tests added covering: user with array content, multi-block joining (skip non-text blocks), gemini with string content, empty content → None, session header → None, $set → None, unknown type → None, missing timestamp fallback. |

## Scope-discipline self-check

- [x] No new interfaces / files outside hints — only the two files in the plan
- [x] No renames of committed public names — `normalize` / `TranscriptAdapter` trait / `NormalizedTurn` / etc. all unchanged
- [x] No signature changes on planner-committed methods — `normalize(raw, ctx) -> Option<NormalizedTurn>` signature unchanged; only body rewritten
- [x] No edits to validation_command configuration
- [x] No edits to files outside the work queue's hint set
- [x] No `git push`, force-push, reset --hard, or other destructive ops
- [x] No `--no-verify` or hook bypass

## Notes for reviewer

1. **Disk schema unchanged**: `source_tool` in normalized output stays
   `"codex"` / `"gemini"` (from `tool_id()`), matching cli-id-aliases'
   contract. `fs_gate::ALLOWED_ROOTS` unchanged. `<handle>.jsonl`
   format identical — only the rate of valid entries changes from
   zero to "matches actual CLI output."

2. **Codex response_item dedup choice**: per user's plan-time
   decision, the adapter processes ONLY `event_msg` events.
   `response_item.message` carries paired duplicates of
   `agent_message` content; skipping it prevents the same assistant
   turn from being emitted twice. If a future Codex version emits
   `response_item.message` WITHOUT a paired `event_msg.agent_message`
   (e.g. internal-only message events), that content would be
   silently dropped — explicit trade-off per task-9 + plan
   conversation.

3. **Gemini content shape inversion**: user turns use
   `content: [{text: ...}]` (array). Gemini turns use
   `content: "..."` (plain string). The "if array else if string"
   fallback handles both shapes independently — if a future variant
   ever flips this, both paths remain functional.

4. **Fixture provenance**: both `#[cfg(test)] mod tests` blocks
   document where the line samples came from ("captured 2026-05-20
   from `~/.codex/sessions/2026/05/19/rollout-...jsonl`" /
   "captured 2026-05-20 from `~/.gemini/tmp/donghyeon/chats/session-...jsonl`").
   Future regressions where Codex / Gemini drift their schema
   surface as fixture-test failures with the provenance line
   pointing at when the assumption was last verified.

5. **Manual smoke test (the actual contract)**:
   - Stop the running `npm run tauri dev` (PID 93366)
   - Restart: `npm run tauri dev`
   - Spawn one agent each of Claude Code + Codex + Gemini
   - Send "hello" to each
   - Expected: all three
     `~/.cache/canvas-terminal/collab-memory/session-<pid>/contexts/<handle>.jsonl`
     appear within ~6s with valid normalized turns (`role`,
     `text_visible`, `ts_iso8601`, etc.)
   - The Eye icon should already be in the publishing state at spawn
     (cycle F + cycle-f-hotfix contract)
   - If any agent's contexts file is missing OR contains zero/wrong
     content, that's a new bug — open as a follow-up.

6. **Bug-count summary** (chain of follow-ups starting from cycle F merge):
   - task-6: Eye disabled at spawn (cycle F planner gap) — fixed in cycle-f-hotfix
   - task-7: tokio panic on Eye-toggle (cycle F impl bug; my error) — fixed in cycle-f-hotfix
   - task-8: tool-id mismatch (pre-existing) — fixed in cli-id-aliases
   - task-9: codex/gemini normalize schemas wrong (pre-existing, this fix) — **fixed here**
   - This is the FOURTH and final bug in the chain. The new fixture
     tests close the lesson-loop: the next adapter regression will
     fail at `cargo test`, not at smoke-test time.
