# Implementation report — korean-ime-dup-period-arrow

## Source

- Planner marker: **feature** from commit `daf9e89` (`feat(planner): merge korean-ime-dup-period-arrow (plan-feature, human-confirmed)`)
- Planner artifacts: `plan.md` (44 401 bytes), `plan.mmd` (1 934 bytes)
- Source hash (sha256, 16 hex): `8e4b9fc836cb9436`
- Implementation commit: `c833c8d`
- Base branch: `dev`
- Implementer branch: `implementer/korean-ime-dup-period-arrow-46880-19563-17468`

## Work queue summary

- Total items: **4**
- Completed: **4**
- Blocked: **0**

| ID | Item | Status |
|---|---|---|
| WQ-1 | Extend `fireKeydown` helper for modifier flags | completed |
| WQ-2 | Reproduce duplicate via T3 (case d locked) | completed |
| WQ-3 | Apply Shape B4 fix (post-compositionend defer dedup) | completed |
| WQ-4 | Add T1 / T2 / T4-shift / T4-meta tests | completed |

## Files changed

- `src/lib/xtermImeShim.ts` — +37 / −2 lines: declare `lastCompositionCommit:{text,gen}|null`; record post-`imeFlushGen++` in `onCompositionEnd` + `onTextareaBlur`; suppress matching deferred Korean re-emit in the `triggerDataEvent` wrapper.
- `src/lib/xtermImeShim.test.ts` — +267 / −1 line: extend `fireKeydown` for `shift/ctrl/alt/metaKey`; add T1 (compose → period), T2 (compose → arrow), T3 (compose → period → arrow, **case d full repro**), T4-shift, T4-meta.

## Validation

- Baseline exit (BASE_BRANCH `dev` HEAD): **0** (tsc 0, vitest 270/270, ≈ 6 s wall)
- Final validation command: `npx tsc --noEmit && npm test`
- Final exit: **0**
- Auto-fix attempts used: **0 / 3**
- Test totals post-fix: **14 files, 275 passed (270 baseline + 5 new)**, ≈ 5 s wall

Tail of the final vitest run (truncated):

```
 RUN  v4.1.5 .../implementer-korean-ime-dup-period-arrow-46880-19563-17468

 Test Files  14 passed (14)
      Tests  275 passed (275)
   Duration  1.66s (tests 600ms)
```

### Phase 0 negative-baseline (pre-fix proof)

Per `plan.md` Success Criterion #5, the implementer must prove the duplicate
reproduces against current `dev` HEAD before applying the fix:

```
npx vitest run src/lib/xtermImeShim.test.ts -t "T3"
…
AssertionError: expected [ '요' ] to deeply equal []
- Expected: []
+ Received: [ "요" ]
  src/lib/xtermImeShim.test.ts:782:49
    expect(origTriggerCalls.map((c) => c.data)).toEqual([])
```

`ptyWrites()` had one `"요"` (from `compositionend`'s `invoke`),
`origTriggerCalls` had one `"요"` (from the wrapper's deferred
`origTrigger`). Combined-channel duplicate per Success Criterion #5
**signal #2**. **Case (d)** locked: defer fire-after-compositionend race.

## Per-item outcomes

| Item | Status | Files touched | Notes |
|---|---|---|---|
| WQ-1 | completed | `src/lib/xtermImeShim.test.ts` | `fireKeydown` now passes `shiftKey/ctrlKey/altKey/metaKey` through (4 default-false flags). Required by T4. No existing-test breakage. |
| WQ-2 | completed | `src/lib/xtermImeShim.test.ts` | T3 written with `cs.triggerDataEvent("요", true)` after `fireCompositionEnd` (Phase 0 Step 5.3 candidate path 2; the JSDOM-viable case d reproduction per round-3 fold F3'). Period+arrow keystrokes included as user-flow noise. Negative-baseline run produced `origTriggerCalls=["요"]` against unmodified HEAD → case (d) locked + case-label header comment inserted. |
| WQ-3 | completed | `src/lib/xtermImeShim.ts` | Shape B4 applied. `lastCompositionCommit:{text,gen}\|null` declared in shim closure; written AFTER `imeFlushGen++` in `onCompositionEnd` (only when `written !== null`) and `onTextareaBlur` (defensive consistency). Wrapper's 20 ms-defer fire path checks `lastCompositionCommit` and suppresses `origTrigger` when `data === text && imeFlushGen === gen`. No signature changes; no new modules; PTY payload bit-identical to today. |
| WQ-4 | completed | `src/lib/xtermImeShim.test.ts` | T1 (compose → period, case b positive control), T2 (compose → arrow with synthetic CSI passthrough, case b positive control), T4-shift, T4-meta (both confirming `isModifier` check uses `e.key === "ArrowRight"` → modifier flag does NOT bypass node 7). Triple-channel assertions: `ptyWrites()`, `origTriggerCalls`, `onComposedFlush`. T4 as two `it()` blocks per round-2 fold (claude4 G4). |

## Variant selection rationale (Phase 0 Step 3)

WQ-2 reproduced the duplicate via case (d) (defer fire-after-compositionend).
Per `plan.md` Step 3, case (d) maps directly to **B4** — post-compositionend
defer dedup at the `triggerDataEvent` wrapper. B1 (node-7 no-write) was not
needed because the JSDOM reproduction's duplicate came entirely via
`origTriggerCalls` (the wrapper path), not via a second `ptyWrites()` entry.
The cross-variant rule (B1+B4 if both channels duplicate) did not apply.

Defensive extension: `onTextareaBlur` also writes `lastCompositionCommit` so
the blur-commit IME path gets the same dedup coverage as `onCompositionEnd`.
This is a single-variant generalization (still B4), not a multi-variant
combination — both call sites are commit paths that bump `imeFlushGen` and
fire to PTY via `invoke`, so the dedup invariant applies uniformly.

## Invariant non-regression (per `plan.md` "Stabilized invariants")

| Invariant | Test file location | Result |
|---|---|---|
| variant-(b) commit-boundary fix | `describe(... "variant (b) commit-boundary fix")` line 303 | passes |
| JP/ZH non-regression fixture floor (Node 10) | `describe(... "JP/ZH non-regression fixture floor")` line 451 | passes (both 3-event and 4-event pinned residuals) |
| `onComposedFlush` Enter/Esc/Tab + compositionend + blur emission contract | `describe(... "onComposedFlush emission")` line 348 | passes |
| 20 ms-defer single Korean codepoint with `imeFlushGen` check | `describe(... "Korean triggerDataEvent defer")` line 576 | passes (both defer-after-non-composing and defer-then-composition-cancels) |
| Dispose restoration (triggerDataEvent / isCursorHidden / cursorBlink / overlay / listeners) | `describe(... "dispose restoration")` line 616 | passes |

The B4 dedup is backward-compatible with both existing defer-path tests:
- "defers single Hangul characters by 20 ms when not composing" — no
  prior `compositionend` → `lastCompositionCommit === null` → suppression
  branch never entered → original `origTrigger` fires.
- "drops deferred Korean characters if composition starts before the
  20 ms timer fires" — `isComposing === true` at timer fire → existing
  outer guard returns before the B4 check is reached.

## Scope-discipline self-check

- [x] No new interfaces / files outside hints (only `src/lib/xtermImeShim.{ts,test.ts}` touched — same files listed in `plan.md` "In scope").
- [x] No renames of committed public names (`attachKoreanImeShim`, `onComposedFlush`, `KoreanImeShimHandle`, `AttachKoreanImeShimOptions` unchanged).
- [x] No signature changes on planner-committed methods (terminator union `"\r" | "\x1b" | "\t" | null` preserved verbatim; `attachKoreanImeShim(terminal, container, opts)` signature untouched).
- [x] No edits to `validation_command` configuration (`package.json` `scripts.test` unchanged; no test-skip flags introduced).
- [x] No edits to files outside the work queue's hint set (`AgentMiniTerminal.tsx`, `terminalManager.ts`, and all other consumers untouched).
- [x] No `console.log` instrumentation in committed code (per Phase 0 Step 6).
- [x] PTY payload bit-identical to pre-fix (per round-3 fold F2' on B3 — B4 keeps `invoke("write_to_pty", { sessionId, data: e.data })` shape unchanged; the dedup happens entirely in the JS-side wrapper closure).

## Phase 6 user-acceptance gate (per Constraint #6)

The live macOS WKWebView repro is the user's `confirm merge` falsification
gate. Run the three sequences from `plan.md` Success Criterion #1 against
the implementer branch and refuse merge if any duplicate `요` appears:

- **1a** `compose 안녕하세요 → .` → screen `안녕하세요.` (no trailing `요`).
- **1b** `compose 안녕하세요 → arrow` → screen `안녕하세요` with cursor moved.
- **1c** `compose 안녕하세요 → . → arrow` → screen `안녕하세요.` with cursor moved, no `요`.

## Blast-radius note (per round-3 fold F5')

Per `plan.md` case (d) "Blast-radius note": B4 may also close out other
unreported Korean-IME duplicates triggered by any "Korean syllable commit,
then no follow-up composition within 20 ms" scenario — not just the
period/arrow trigger family. The user's reported trigger family
(period/arrow) appears to be a visibility artifact (the duplicate exists
in the PTY byte stream regardless; the arrow forces a screen redraw
exposing it). If `confirm merge` validates 1a/1b/1c, watch for
incidental wins on other Korean-IME flows where users previously
reported subtle ghost characters.
