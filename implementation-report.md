# Implementation report — inputprompt-c0-strip

(Prior `implementation-report.md` on `dev` documented
`inputprompt-arrow-tofu`. Overwritten with this micro-lane report;
historical content reachable via `git log -- implementation-report.md`.)

## Source
- Planner marker: micro (chat-gate, current session, planner round 2)
- Marker text: `scale: micro   marker: (plan-micro, human-confirmed)`
- Planner artifacts: none (chat-only per micro-lane contract)

## Why a second round
Round 1's `inputprompt-arrow-tofu` (merged at `5707b85`) added an IME
composition guard on Arrow{Left,Right}, on the working theory that the
tofu glyphs were Hangul Jamo committed by macOS Korean IME on arrow
navigation. Empirical DevTools probe by the user after merge revealed
two facts that falsified that hypothesis:

1. The bug reproduces in **English mode too**, where the guard never
   fires (`isComposing` is false and `keyCode !== 229`).
2. The actual codepoints inserted are `U+001C` (File Separator) on
   ArrowLeft and `U+001D` (Group Separator) on ArrowRight — ASCII C0
   controls, **not** Hangul Jamo. These correspond to the legacy
   "Information Separator" quartet (FS=Left, GS=Right, RS=Up, US=Down)
   that macOS WKWebView surfaces as raw text-insert events instead of
   routing to NSResponder cursor-navigation action methods.

Round 1's guard remains in place — it's defensive against the original
IME-Jamo edge case which is plausible in principle even if it wasn't
the bug actually being reported. The real bug fix is this round.

## Work queue summary
- Total items: 1
- Completed: 1
- Blocked: 0

## Files changed
- `src/components/collaborator/InputPrompt.tsx` — +12 / −0
  (new `onBeforeInput` handler; no other lines touched)

## Validation
- Baseline exit (BASE_BRANCH HEAD = `5707b85`): build 0, test 0 (216/216)
- Final validation command: `npm run build && npm run test`
- Final exit: build 0, test 0 (216/216)
- Auto-fix attempts used: 0/3

```
 Test Files  12 passed (12)
      Tests  216 passed (216)
   Start at  15:49:04
   Duration  1.54s (transform 1.40s, setup 1.14s, import 2.78s, tests 530ms, environment 5.16s)
```

## Per-item outcomes

| item_id | status | files_touched | notes |
|---|---|---|---|
| 1 | completed | src/components/collaborator/InputPrompt.tsx | Added `onBeforeInput` that rejects ASCII C0 controls (`[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]`). Tab/LF/CR intentionally kept. Implicitly covers paste-of-control-chars (beforeinput fires for paste). |

## Scope-discipline self-check

- [x] No new interfaces / files outside hints
- [x] No renames of committed public names
- [x] No signature changes
- [x] No edits to validation_command configuration
- [x] No edits to files outside the work queue's hint set
- [x] Round-1 IME guard preserved (no scope creep into "polish")

## Manual QA (to confirm after merge)

Run `npm run tauri dev`, focus the Collaborator `>` prompt, then:

1. English IME (영) — hold ArrowRight a few seconds → cursor moves, no tofu inserted.
2. English IME (영) — hold ArrowLeft a few seconds → same.
3. Korean IME (한) — same checks.
4. Cmd+Arrow / Shift+Arrow / Option+Arrow — modifier-arrow combos still
   work natively (we only filter character-insert events, not key events).
5. Tab key → still inserts a tab.
6. Shift+Enter → still inserts a newline.

DevTools-verifiable: after step 1 or 2, in Console:

```js
const ta = [...document.querySelectorAll('textarea')]
  .find(t => /help|status|canvas-export|target/.test(t.placeholder || ''));
[...(ta?.value ?? '')].map(c => 'U+' + c.codePointAt(0).toString(16).padStart(4,'0').toUpperCase())
```

…should return `[]` (clean), not `["U+001C", "U+001C", ...]`.
