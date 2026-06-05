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

## Files changed

| File | Lines |
|---|---|
| `src/lib/xtermImeShim.ts` | +406 / −24 (skeleton → body) |
| `src/lib/xtermImeShim.test.ts` | +558 / −0 (new file) |
| `src/lib/terminalManager.ts` | +45 / −361 (315-line IME block → 22-line shim call + onComposedFlush) |
| `src/components/collaborator/AgentMiniTerminal.tsx` | +35 / −278 (252-line IME block → 16-line shim call + onComposedFlush) |
| **Total** | **+1044 / −663** |

## Validation

- Baseline exit on `dev` HEAD: `0` (tsc + vitest, 247/247)
- Final validation command: `node_modules/.bin/tsc --noEmit && node_modules/.bin/vitest run`
- Final exit: `0`
- Auto-fix attempts used: 0/3
- Test result diff: 13 → 14 test files (+`xtermImeShim.test.ts`); 247 → 268 tests (+21 new)

Tail of last validation run:

```
 Test Files  14 passed (14)
      Tests  268 passed (268)
   Start at  11:21:07
   Duration  1.85s
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

21 tests across 6 `describe` blocks:

1. **attach lifecycle** (4) — TypeError on missing `_core.coreService`;
   `.xterm-screen` attach path; container fallback; no-op handle for
   detached container.
2. **variant (b) commit-boundary fix** (1) — full Korean composition
   sequence `ㅎ→하→한` followed by `compositionend("한")` then new
   composition `ㄱ`: asserts overlay shows ONLY "ㄱ", not "한ㄱ" (the
   bug fix invariant).
3. **`onComposedFlush` emission** (6) — `(text, null)` on
   `compositionend`, `(text, null)` on blur, `(text, "\r")` on Enter
   mid-composition with atomic `text+terminator` PTY write,
   `(text, "\x1b")` on Escape, `(text, "\t")` on Tab, subscriber
   exception swallow.
4. **Node 10 JP/ZH non-regression fixture floor** (2) — JP-like
   `keydown(229) + input(insertReplacementText) + compositionend`
   sequence: exactly one PTY write, no drop, overlay rendered exactly
   once, `onComposedFlush` fires once; non-Korean single characters
   NOT 20ms-deferred through `triggerDataEvent`.
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
