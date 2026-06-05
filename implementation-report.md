# Implementation report — korean-ime-dup-render

> **Round-1 peer-review fold (2026-06-05)**: 5 cold reviewers (claude2,
> claude3, codex1, codex2, codex3) produced 3 verdicts of APPROVE
> (claude2 with non-blocking note; claude3 with one narrow revision;
> codex3 with acceptance caveats) and 2 of REVISE (codex1 Major on F1;
> codex2 High on live WKWebView gate + Medium on F2). After empirical
> verification (each finding reproduced against the code at HEAD
> `81ea147`), 4 unique findings were folded:
>
> - **F1** (codex1 Major, claude3 Medium, claude2 non-blocker): the
>   Node 10 JP/ZH fixture floor did not exercise the
>   `input → triggerDataEvent → keydown(229) → compositionend`
>   ordering. Added a test that pins the **pre-existing residual
>   duplicate-write** for JP/ZH (xterm's non-Korean
>   `triggerDataEvent` falls through immediately while
>   `compositionend` also direct-writes). Out-of-scope for
>   korean-ime-dup-render; fix would require widening the 20ms-defer
>   to all single-codepoint CJK ranges.
> - **F2** (claude3 Low, codex2 Medium): the Failure-modes TSDoc
>   claimed "no-op shim" but the impl only skipped overlay attach
>   (`triggerDataEvent`/`isCursorHidden`/listeners still patched).
>   Refactored overlay attach into a `tryAttachOverlay()` function
>   that `rebind()` also retries — degraded-overlay mode now
>   genuinely recoverable. Docstring tightened to match. Added test.
> - **F3** (claude3 Low, hardening): `onComposedFlush` callback is
>   synchronous-only — async subscribers must wrap their own
>   `try/catch`. Documented in TSDoc.
> - **Cosmetic** (claude2 Low): test comment said `reKorean`; the
>   helper uses `KOREAN_CODEPOINT_RE`. Aligned.
>
> Live WKWebView gate (codex2 High, codex3 Caveat 1, claude2/claude3
> concurring framing): preserved as Phase 6 acceptance — the
> autonomous loop has no Korean IME / WKWebView access. The fold did
> NOT change the variant-(b) default; trace falsification at Phase 6
> still escalates back to planner per plan Constraint #3.
>
> Test diff after fold: 268 → **270** tests (+1 JP/ZH residual pin,
> +1 rebind() overlay retry). `tsc --noEmit` and full vitest both
> exit 0.
>
> **Round-2 peer-review fold (2026-06-05)**: 5 cold reviewers
> (claude2 task-118, claude3 task-71 r2, codex1 task-111 updated,
> codex2 task-119, codex3 task-120) re-reviewed HEAD `29f01fc`.
> Verdicts: 3 APPROVE (claude2, claude3, codex2 for Phase 6) + 2
> REVISE (codex1, codex3) split on interpretation of the round-1
> JP/ZH residual-pin test vs `plan.md`'s Node 10 fixture text.
> Verified empirically: `plan.md:33` and `plan.md:79(b)` specify the
> fixture as a **3-event sequence** (`keydown(229)` +
> `insertReplacementText/insertText` + `compositionend`) — xterm's
> internal `triggerDataEvent` is NOT in that list. The pre-existing
> 3-event test PASSES with one PTY write (Node 10 floor satisfied);
> the round-1 supplementary 4-event test pins a sequence the plan
> did not enumerate. Round-2 fold: (a) refresh stale validation
> tables to post-fold numbers, (b) make the 3-event-vs-4-event
> distinction explicit in WQ-2 description + the new
> "Plan-conformance note on Node 10" section below, (c) surface
> the codex1/codex3 alternative reading for the user's Phase 6
> decision — the implementer does NOT unilaterally widen the
> helper's behavior (would exceed body-generation scope; planner
> committed Korean-only defer at `KOREAN_CODEPOINT_RE`).


## Source

- Planner marker: `(plan-feature, human-confirmed)` from commit `0523fa8a` on `dev`
- Planner artifacts: `plan.md`, `plan.mmd`
- Source hash (sha256, first 16): `b734b3abf67b14b4`
- Scale lane: **feature**
- Variant chosen: **(b)** — `isComposing = false` in `onCompositionEnd` (planner-preferred default)

## Work queue summary

| ID | Plan node(s) | Status | Files touched |
|---|---|---|---|
| WQ-1 | N3 + N4 | completed | `src/lib/xtermImeShim.ts` |
| WQ-2 | N5 + N10 floor | completed | `src/lib/xtermImeShim.test.ts` |
| WQ-3 | N6 | completed | `src/lib/terminalManager.ts` |
| WQ-4 | N7 | completed | `src/components/collaborator/AgentMiniTerminal.tsx` |

- Total items: 4
- Completed: 4
- Blocked: 0

## Files changed (post-round-1 fold)

| File | Lines |
|---|---|
| `src/lib/xtermImeShim.ts` | +444 / −34 (skeleton → body + round-1 fold: tryAttachOverlay, F2/F3 TSDoc) |
| `src/lib/xtermImeShim.test.ts` | +668 / −0 (new file; +2 tests in round-1 fold: F1 residual pin, F2 rebind retry) |
| `src/lib/terminalManager.ts` | +45 / −361 (315-line IME block → 22-line shim call + onComposedFlush) |
| `src/components/collaborator/AgentMiniTerminal.tsx` | +35 / −278 (252-line IME block → 16-line shim call + onComposedFlush) |
| **Total** | **+1192 / −673** (`implementation-report.md` not counted) |

## Validation

- Baseline exit on `dev` HEAD: `0` (tsc + vitest, 247/247)
- Final validation command: `node_modules/.bin/tsc --noEmit && node_modules/.bin/vitest run`
- Final exit: `0`
- Auto-fix attempts used: 0/3
- Test result diff: 13 → **14** test files (+`xtermImeShim.test.ts`); 247 → **270** tests (+23 new: 21 initial + 2 round-1 fold)

Tail of last validation run (post-round-1 fold):

```
 Test Files  14 passed (14)
      Tests  270 passed (270)
   Duration  1.69s
```

## Per-item outcomes

### WQ-1 — `attachKoreanImeShim` body (plan N3 + N4)

- Removed `export declare` skeleton; emitted full body preserving the
  committed signature `(terminal, container, options) => KoreanImeShimHandle`.
- **Variant (b) fix** (plan N4 preferred default): `onCompositionEnd`
  now sets `isComposing = false` and calls `clearOverlay()` at the
  syllable boundary, so the next `keydown(229)` re-enters the
  `if (!isComposing)` branch that anchors
  `imeStartPos = textarea.value.length - 1`. Previous inline shims
  left `isComposing = true`, causing `showOverlay(value.substring(stale_start))`
  to repaint the already-committed prefix.
- **`dispose()` contract** (skeleton TSDoc): full restoration —
  document `keydown`/`input` listeners removed, original
  `triggerDataEvent` reference restored (raw, not bound — captured at
  attach as `origTriggerRaw`), original `isCursorHidden` property
  descriptor restored via `Object.defineProperty`, overlay removed
  from DOM, `cursorBlink` restored to its pre-attach value, helper
  textarea `compositionend`/`blur`/`focus` listeners removed, `focus`
  patch unpatched. Idempotent on the same handle.
- **`onComposedFlush` emission**: fires after all 3 PTY write paths
  (`compositionend` commit / `blur` flush / terminator-flush) with
  `(committedText, terminator)`. Subscriber exceptions are swallowed.
- **`webgl` option**: signature preserved (`void options.webgl;`)
  matching the planner contract checklist item.

### WQ-2 — Unit tests (plan N5 + N10 floor)

**23 tests across 6 `describe` blocks** (post-round-1 fold; 21 initial + 2 fold):

1. **attach lifecycle** (5) — TypeError on missing `_core.coreService`;
   `.xterm-screen` attach path; container fallback; **degraded-overlay
   mode when container detached and no `.xterm-screen` (still patches
   triggerDataEvent etc.)**; **`rebind()` retries overlay attach after
   the container becomes reachable** (last two added by round-1 F2 fold).
2. **variant (b) commit-boundary fix** (1) — full Korean composition
   sequence `ㅎ→하→한` followed by `compositionend("한")` then new
   composition `ㄱ`: asserts overlay shows ONLY "ㄱ", not "한ㄱ" (the
   bug fix invariant).
3. **`onComposedFlush` emission** (6) — `(text, null)` on
   `compositionend`, `(text, null)` on blur, `(text, "\r")` on Enter
   mid-composition with atomic `text+terminator` PTY write,
   `(text, "\x1b")` on Escape, `(text, "\t")` on Tab, subscriber
   exception swallow.
4. **Node 10 JP/ZH non-regression fixture floor** (3) —
   (a) the **plan's literal 3-event fixture** (`keydown(229) +
   input(insertReplacementText) + compositionend`): exactly **one PTY
   write**, no drop, overlay rendered exactly once, `onComposedFlush`
   fires once — **the plan's success criterion 5 / Node 10 (b) IS
   SATISFIED**; (b) non-Korean single characters NOT 20ms-deferred
   through `triggerDataEvent`; (c) **round-1 fold supplementary**:
   pins the production-adjacent 4-event ordering (`input +
   triggerDataEvent + keydown(229) + compositionend`) which falls
   outside the plan's 3-event fixture text — see "Plan-conformance
   note on Node 10 (round-2 review)" below.
5. **Korean 20ms defer** (2) — defers single Hangul chars by 20ms;
   drops the deferred char if composition starts within the window.
6. **`dispose()` restoration** (6) — `triggerDataEvent` reference
   restored; `isCursorHidden` property descriptor restored; overlay
   removed from DOM; document listeners removed (no PTY writes after
   dispose); `cursorBlink` restored; idempotent.

Test setup uses `happy-dom` (project default). One synthesis quirk:
`CompositionEvent` constructor in happy-dom does NOT honor `data` from
the init dictionary, so the test helper force-sets it via
`Object.defineProperty(e, "data", { value })`. WKWebView's
`input`-before-`keydown` order is preserved by helper-fire ordering.

### WQ-3 — PTY pane substitution (plan N6)

- `ManagedTerminal` interface: dropped 5 fields
  (`imeHandlers`/`rebindIme`/`docKeyDown`/`docInput`/`imeOverlayEl`)
  → single `imeHandle: KoreanImeShimHandle | null`.
- 327-line IME block (terminalManager.ts:342–668) replaced with
  22-line `attachKoreanImeShim(...)` call.
- **`onComposedFlush` subscription** (Node 8b sub-case (i) fix):
  Korean compositions DO NOT mutate `lineBuffer`. Terminator `\r`
  resets `lineBuffer = ""` (mirrors `terminal.onData`'s `\r` branch).
  Other terminators are no-ops on `lineBuffer`. This means a
  Korean → IME-off → ASCII `collaborator\r` sequence leaves `lineBuffer
  === "collaborator"` at the `\r` check → spawn fires correctly.
  Baseline ASCII `collaborator\r` regression unaffected (sub-case (ii)).
- `reparentTo`: `s.rebindIme?.()` → `s.imeHandle?.rebind()` (both
  call sites updated).
- `ensureGlobalSubscriptions` font-size handler:
  `s.imeOverlayEl.style.fontSize` → `s.imeHandle?.overlayEl?.style.fontSize`.
- `cleanupManaged`: 3 manual cleanup blocks (docInput/docKeyDown
  removeEventListener + imeHandlers focus unpatch) → single
  `s.imeHandle?.dispose()` + `s.imeHandle = null`. **No parallel
  manual cleanup**, per plan's codex1-High fold.

### WQ-4 — Collab pane substitution (plan N7)

- React refs: dropped 4
  (`imeHandlersRef`/`docKeyDownRef`/`docInputRef`/`imeOverlayRef`)
  → single `imeHandleRef: useRef<KoreanImeShimHandle | null>`.
- 252-line IME block (AgentMiniTerminal.tsx:448–699) replaced with
  16-line `attachKoreanImeShim(...)` call.
- **`onComposedFlush` subscription** (plan node 7 Medium #2):
  every flushed composition calls `terminal.scrollToBottom()` —
  closes the scroll-snap gap where Korean composes bypassed
  `terminal.onData` and lost the "user-input intent" viewport snap
  that ASCII typing gets.
- `defaultFontSize: 10` (mini terminals use a smaller default than
  the PTY pane's 12).
- Font-size effect (line ~679):
  `imeOverlayRef.current.style.fontSize` →
  `imeHandleRef.current?.overlayEl?.style.fontSize`.
- Unmount cleanup: 3 manual cleanup blocks → single
  `imeHandleRef.current?.dispose()` + `imeHandleRef.current = null`.

## Scope-discipline self-check

- [x] No new interfaces / files outside hints (helper module +
      test file were both planned in `plan.md::Package layout`).
- [x] No renames of committed public names (`attachKoreanImeShim`,
      `AttachKoreanImeShimOptions`, `KoreanImeShimHandle` preserved
      verbatim from skeleton commit `7f4675b`).
- [x] No signature changes on planner-committed methods (skeleton's
      `export declare function attachKoreanImeShim(...)` →
      same `(terminal, container, options) => KoreanImeShimHandle`,
      including the contract-preserved `webgl?` option).
- [x] No edits to `validation_command` configuration
      (`package.json` scripts unchanged).
- [x] No edits to files outside the work queue's hint set (4 files
      total, all in `plan.md::Package layout`).

## Deferred to human acceptance smoke (Phase 6)

These plan nodes require live WKWebView + Korean (and optionally JP)
IME input and cannot be exercised by the autonomous loop. They are
acceptance gates the user runs at Phase 6 before `confirm merge`:

- **N1 — Controlled keystroke trace capture**: type "안녕하세요" + "한국어
  입력 테스트" on both surfaces, capture visible buffer + cursorX/Y +
  `textarea.value` + overlay text per step.
- **N2 — buffer/PTY hypothesis verification**: dump
  `terminal.buffer.active` mid-composition + PTY transcript. If
  trace falsifies the render-only hypothesis (buffer contains the
  duplicate too), escalate back to planner per plan Constraint #3.
  Planner pre-committed variant (b) as the default; my Node 1/2
  deferral inherits that default.
- **N8 — Korean accept smoke**: both surfaces, "안녕하세요" + "한국어
  입력 테스트", every intermediate composition/commit state renders
  the current Hangul text (committed + composing) exactly once, no
  arrow-key cleanup required.
- **N8b — Korean → ASCII `collaborator` transition acceptance**:
  - (i) "안녕" via Korean IME → IME off → "collaborator\r" → spawn
    fires (lineBuffer-sync invariant from WQ-3's `onComposedFlush`).
  - (ii) Baseline ASCII "collaborator\r" without prior Korean →
    spawn fires (no regression on the existing path).
- **N9 — non-IME regression + dispose restoration smoke**: ASCII,
  paste, arrow keys, Ctrl+C/R, Tab completion, shell history (↑/↓),
  Shift+Enter (CSI u), Cmd shortcuts on both surfaces. Plus React
  StrictMode remount + terminal reparenting: after `dispose()`,
  verify ① `triggerDataEvent` restored, ② `isCursorHidden` property
  descriptor restored, ③ document listeners removed, ④ helper
  textarea `focus` patch reverted, ⑤ overlay DOM removed.
  The `dispose()` restoration items (5/5) are unit-tested in WQ-2
  (`describe("dispose restoration")`); the integration-level
  StrictMode remount path is acceptance-only.
- **N10 manual JP IME ceiling**: **`JP/ZH manual smoke: skipped — JP
  IME not installed in implementer environment` (the autonomous loop
  has no live WKWebView / IME access for any language).** User Phase
  6 acceptance: install JP IME and type a JP syllable on both
  surfaces; verify no duplicate render, no drop. The Node 10
  **fixture floor** (jsdom `keydown(229) + insertReplacementText +
  compositionend` sequence) IS automated in WQ-2 and passing. The
  Round-1 fold also added an explicit **residual-pin test** for the
  `input → triggerDataEvent → keydown(229) → compositionend`
  ordering — see `xtermImeShim.test.ts` for the test name "pins
  residual duplicate-write behavior for JP/ZH..." — documenting that
  JP/ZH currently has a 2x PTY-write residual via the xterm
  `triggerDataEvent` fall-through path. Same as the pre-refactor
  inline shims; out-of-scope for korean-ime-dup-render.

## Plan-conformance note on Node 10 (round-2 review)

Round-2 reviewers split on whether the round-1 supplementary 4-event
test for JP/ZH (the "residual pin") constitutes a Node 10 plan-gate
failure. Empirical re-read of the plan text (verified at `plan.md:33`
and `plan.md:79(b)` in the merged branch `0523fa8`):

> success criterion 5: *"비한글 `keydown(229)` + `insertReplacementText/insertText`
> + `compositionend` **시퀀스** → 중복 flush 없음 / drop 없음 / overlay 1회 렌더"*
>
> Node 10 (b): *"Node 5 fixture가 비한글 `keydown(229)` + `inputType=insertReplacementText`
> + `compositionend` **시퀀스**를 헬퍼에 통과시켜 ① 중복 flush 없음, ② drop 없음,
> ③ 오버레이 1회 렌더 검증"*

The plan literally enumerates a **3-event sequence**:
`keydown(229) + insertReplacementText/insertText + compositionend`.
xterm.js's internal `coreService.triggerDataEvent` is NOT part of
that enumeration — it is xterm's own forwarding mechanism, not a
user-dispatched DOM event.

| Test | Sequence | PTY writes observed | Plan-conformance |
|---|---|---|---|
| existing Node 10 (a) — "processes JP-like..." | `keydown(229) → input → compositionend` (3 events) | **1** | **satisfied** ✓ |
| round-1 fold supplementary — "pins residual..." | `input → triggerDataEvent → keydown(229) → compositionend` (4 events) | 2 (1 origTrigger + 1 direct) | NOT in plan's fixture text |

**The plan's literal 3-event fixture floor PASSES with no duplicate.**
The round-1 supplementary 4-event test pins a different ordering the
plan did not specify. The Round-1 fold preamble's wording "pins
pre-existing residual duplicate-write" was honest about the
behavior but ambiguous about scope; this round-2 fold clarifies
that the residual sits *outside* the plan's fixture floor, not
within it.

**Reviewer split** (round-2):
- @claude2, @claude3, @codex2 — APPROVE the round-1 fold (no plan
  violation; pre-existing inline shims had identical behavior →
  non-regression OOS bar from `intent.korean-ime-dup-render.md` is
  satisfied).
- @codex1, @codex3 — REVISE: read Node 10 to cover any non-Korean
  ordering including the production-adjacent 4-event one. Under
  that reading, the implementer must either (a) widen
  `KOREAN_CODEPOINT_RE` to all single-codepoint CJK ranges so the
  4-event ordering also produces 1 PTY write, OR (b) escalate to
  the planner to formally re-scope Node 10.

**Implementer's position** (3/5 + plan literalism + body-generation
scope):
- The plan's fixture is a 3-event sequence; the 3-event test passes
  with no duplicate. Plan-conformance for Node 10's literal text is
  unambiguously satisfied.
- The 4-event ordering's behavior matches the **pre-refactor inline
  shims** (`reKorean`-only check carried verbatim to
  `KOREAN_CODEPOINT_RE`). This is non-regression — the OOS gate from
  `intent.korean-ime-dup-render.md::Out of scope`
  ("일본어/중국어 IME 기능 지원 ... non-regression만 acceptance 게이트") is
  satisfied.
- Widening `KOREAN_CODEPOINT_RE` to all single-codepoint CJK ranges
  would change the helper's externally-observable behavior on JP/ZH
  beyond the planner's committed contract — that is **outside
  body-generation scope** per the implementer skill's forbidden
  actions ("don't add unrequested features"). The implementer does
  NOT unilaterally fold this code change.

**User decision at Phase 6**:
- **Option A** (accept implementer position): leave the residual pin
  as documentation, mark plan-conformance satisfied, proceed to
  `confirm merge`. Recommended default given 3/5 reviewer consensus
  and the plan's literal text.
- **Option B** (accept codex1/codex3 reading): the implementer
  cannot fold this unilaterally; user must either (b1) re-run the
  planner with explicit "widen CJK defer" scope, OR (b2) accept the
  residual as a documented limitation in the planner's success
  criteria and re-emit `plan.md`. Both paths re-open the planner
  gate.

If the user picks Option B, the implementer worktree stays at
`29f01fc`; the planner re-run produces a new `plan.md` and a new
implementer cycle picks up from there. The current implementer's
WQ-1..WQ-4 code is unaffected by either choice (the round-1 fold
is supplementary).

## Notes for reviewers

- The skeleton's TSDoc `Failure-modes` clause about
  `TypeError` on missing `_core.coreService` was honored: the helper
  throws synchronously at attach. Tests pin this behavior.
- The `webgl` option is intentionally read-then-discarded
  (`void options.webgl;`) — per plan node H8b's `webgl?` fold,
  signature preserved for future renderer-asymmetric tweaks.
- A previously documented leak (the inline shims never restored
  `triggerDataEvent`) is now closed by the helper. Reviewers running
  React StrictMode dev mode should see one less leaked listener
  set per terminal mount.
- The `// FIXME: 20ms empirically tuned for WKWebView` comment from
  plan N3's round-1 N4 fold is carried into the helper body.
