# Implementation report — korean-ime-dup-period-arrow

## Source

- Planner marker: **feature** from commit `daf9e89` (`feat(planner): merge korean-ime-dup-period-arrow (plan-feature, human-confirmed)`)
- Planner artifacts: `plan.md` (44 401 bytes), `plan.mmd` (1 934 bytes)
- Source hash (sha256, 16 hex): `8e4b9fc836cb9436`
- Implementation commits: `c833c8d` (round-0 body) + `3dcbc2a` (round-1 peer-review fold) + `42b1642` (round-2 peer-review fold)
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

- `src/lib/xtermImeShim.ts` — +97 / −12 lines:
  - declare `lastCompositionCommit:{text,gen}|null`;
  - record post-`imeFlushGen++` in `onCompositionEnd` + `onTextareaBlur`;
  - **round-1 fold**: schedule 40 ms time-bound clear after each commit (token-identity guard);
  - suppress matching deferred Korean re-emit in the `triggerDataEvent` wrapper;
  - **round-2 fold**: claim the token atomically at trigger schedule time (capture into defer closure + nullify live token). The suppression decision uses the captured `claim`, race-free against the 40 ms safety clear. Atomic null doubles as consume-on-suppress — subsequent triggers see live token === null at schedule time and pass through.
- `src/lib/xtermImeShim.test.ts` — +425 / −1 line:
  - extend `fireKeydown` for `shift/ctrl/alt/metaKey`;
  - add T1 (compose → period), T2 (compose → arrow), T3 (compose → period → arrow, **case d full repro**), T4-shift, T4-meta;
  - **round-1 fold**: add T5 (time-bound: 60 ms past commit → later trigger passes through) + T6 (consume: after one match, next trigger passes through);
  - **round-2 fold**: add T7 (delayed-duplicate: xterm re-emit at t=25 ms inside the 40 ms safety window must still be suppressed — race-free via claim-at-schedule).

## Validation

- Baseline exit (BASE_BRANCH `dev` HEAD): **0** (tsc 0, vitest 270/270, ≈ 6 s wall)
- Final validation command: `npx tsc --noEmit && npm test`
- Final exit: **0**
- Auto-fix attempts used: **0 / 3**
- Test totals post-fix (round-0): **14 files, 275 passed (270 baseline + 5 new T1–T4)**, ≈ 5 s wall
- Test totals post-round-1 fold: **14 files, 277 passed (270 baseline + 7 new T1–T6)**, ≈ 5 s wall
- Test totals post-round-2 fold: **14 files, 278 passed (270 baseline + 8 new T1–T7)**, ≈ 5 s wall

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
| ROUND-1-FOLD | completed | `src/lib/xtermImeShim.{ts,test.ts}` | 4/5 convergent peer-review finding (codex2/codex3/codex4/claude4): `lastCompositionCommit` had no consume/expiry. Added consume-on-suppress in the wrapper timer callback + 40 ms time-bound clear in `onCompositionEnd`/`onTextareaBlur` (token-identity guarded). Added T5 (time-bound) + T6 (consume-on-suppress) regression tests. Full suite 277/277. Commit `3dcbc2a`. |
| ROUND-2-FOLD | completed | `src/lib/xtermImeShim.{ts,test.ts}` | 3/5 convergent peer-review finding (codex2/codex3/codex4): round-1's 40 ms safety clear races the wrapper's 20 ms defer for delayed xterm re-emits arriving between t=20 ms and t=40 ms. Replaced suppression-check-at-fire-time with **claim-at-schedule**: atomic capture `claim = lastCompositionCommit` into the defer closure + nullify live token. Defer's match check uses captured `claim`, race-free against safety clear. Atomic null doubles as consume-on-suppress. Added T7 (delayed-duplicate regression). Full suite 278/278. Commit `42b1642`. |

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

## Round-1 implementer-review fold (5 reviewers — @codex2, @claude3, @codex3, @claude4, @codex4)

5/5 reviewers verified the round-0 implementation; 4/5 surfaced the same
convergent finding around B4 dedup token lifetime. Folded.

### Reviewer verdicts (round-0 = c833c8d + 1f8aa48)

| Reviewer | Verdict | Severity assigned |
|---|---|---|
| @codex4 (task-16) | HOLD before merge | HIGH |
| @codex2 (task-17) | HOLD pending one fix | HIGH |
| @claude3 (task-18) | APPROVE with one MEDIUM advisory (case-b coverage) | MEDIUM advisory non-blocking |
| @codex3 (task-19) | REVISE before merge | MEDIUM |
| @claude4 (task-20) | APPROVE with one LOW non-blocking observation | LOW |

### Convergent (4/5 reviewers) — F1' B4 dedup token had no consume / expiry

- **codex4 task-16 HIGH** — token suppresses later legitimate same-syllable input until next `imeFlushGen` bump; recommended one-shot + time-bound + regression test
- **codex2 task-17 HIGH** — same trace, including paste / non-IME single-Hangul scenarios; recommended consume on suppress
- **codex3 task-19 MEDIUM** — same finding, recommended one-shot and/or time-bound
- **claude4 task-20 LOW (F1)** — same long-tail trace; recommended one-shot clear inside the timer callback; deferred as follow-up but noted as a real edge case

Independently traced against `src/lib/xtermImeShim.ts:487/505/603-608`
(round-0 line numbers): `lastCompositionCommit` was set on every commit and
never cleared until the next IME action incremented `imeFlushGen`. Any
legitimate same-syllable `triggerDataEvent("요")` in the window between
the commit and the next IME activity was silently dropped — affecting
single-Hangul paste, programmatic terminal input, plugin emission, and
existing harness's `cs.triggerDataEvent("한")` style code paths.

**Folded** with two complementary safeguards in commit `3dcbc2a`:

1. **Consume on suppress** — wrapper timer callback (after the B4 inner
   check matches) sets `lastCompositionCommit = null` before `return`.
   Closes the "second `triggerDataEvent` in same generation" window:
   the first xterm CompositionHelper post-commit re-emit is suppressed;
   any subsequent same-syllable trigger passes through.
2. **Time-bound 40 ms** — `onCompositionEnd` / `onTextareaBlur` schedule
   a `setTimeout(40)` that nulls `lastCompositionCommit` if it still
   references the same commit (token-identity check keeps a newer commit
   safe from a stale clear). Closes the "no `triggerDataEvent` ever
   arrives" long-tail: the dedup window is bounded to 40 ms (2× the
   defer wait) regardless of subsequent IME activity.

### Regression tests added in the fold

- **T5 (time-bound)** — commit → advance 60 ms → `cs.triggerDataEvent("요", true)` → advance 25 ms → expect `origTriggerCalls === ["요"]` (pass-through after the 40 ms safety window).
- **T6 (consume-on-suppress)** — commit → immediate `cs.triggerDataEvent("요", true)` + 25 ms (suppressed by B4) → second `cs.triggerDataEvent("요", true)` + 25 ms → expect the second event passes through.

### MEDIUM advisory (1 reviewer) — F2' case-(b) untested in JSDOM (@claude3 task-18)

@claude3 raised MEDIUM advisory non-blocking: B4 fixes case (d) only; if
the live macOS WKWebView mechanism is case (b) rather than case (d),
node 7's `invoke` write path fires without consulting
`lastCompositionCommit`, so a case-(b) duplicate would survive the fix.

**Not folded** — this is by design. `plan.md` explicitly delegates the
case-(b)-vs-case-(d) distinction to the Phase 6 manual repro per
Constraint #6. Applying B1+B4 prophylactically without a JSDOM-failing
baseline for case (b) would violate `plan.md` §133/§491 ("Do NOT apply
a fix against a non-reproducing test"). The Phase 6 user-acceptance gate
(sequences 1a/1b/1c) is the falsification gate; if 1a or 1b reproduces
the duplicate, a follow-up round adding B1 (node-7 no-write) is needed.

### Single-reviewer LOW / NIT (not folded)

- @claude3 task-18 F2 (LOW) — T4-meta/shift CSI assertions are tautological synthetic-CSI pass-through; documentation nuance only.
- @claude3 task-18 F3 (LOW) — `onTextareaBlur` B4 store is forward-defensive with no direct test; harmless documentation nuance.
- @claude4 task-20 F2 (NIT) — TSDoc on the wrapper doesn't mention B4 dedup; inline trace already covers it.

These are non-blocking observations from single reviewers; no convergence
across the panel. Documenting here in the implementation report for the
audit trail rather than touching code.

### Architectural axis unchanged

Bug-site identification (node 9 / case d), variant choice (B4 — single
sub-variant of Shape B family), OUT-OF-SCOPE boundary (terminator union
frozen, consumers untouched), PTY payload bit-identity, scope discipline
(single-file body changes only) — all unchanged from round-0. The round-1
fold is purely a token-lifetime tightening within B4.

## Round-2 implementer-review fold (5 reviewers — @codex2, @claude3, @codex3, @claude4, @codex4)

5/5 reviewers verified the round-1 fold; 3/5 surfaced the same convergent
finding around a stacked-timer race between the round-1 safety clear and
the wrapper's 20 ms defer. Folded.

### Reviewer verdicts (round-1 fold = c833c8d + 3dcbc2a + d5e9823)

| Reviewer | Verdict | Severity assigned |
|---|---|---|
| @codex4 (task-26) | HOLD before merge | HIGH |
| @codex2 (task-22) | HOLD pending one fix | MEDIUM |
| @claude3 (task-23) | APPROVE | LOW (40 ms tight under load) |
| @codex3 (task-24) | HOLD before merge | HIGH |
| @claude4 (task-25) | APPROVE | NIT only (timer leak, identity guard untested) |

### Convergent (3/5 reviewers) — F1'' 40 ms safety clear races the 20 ms wrapper defer

- **codex4 task-26 HIGH** — 40 ms expiry starts at commit time; for a duplicate arriving at t=25 ms, its 20 ms defer fires at t=45 ms — AFTER the safety clear at t=40 ms. Token is nullified before suppression can fire, duplicate escapes.
- **codex3 task-24 HIGH** — same trace; recommended **captured-token approach** (capture matching commit at trigger schedule time, use captured value in delayed callback).
- **codex2 task-22 MEDIUM** — same trace; offered "preserve and consume a matched token through the deferred check rather than clearing solely from commit time".

Independently traced against the round-1 wrapper at `xtermImeShim.ts:603-616`:
the inner check evaluated `lastCompositionCommit` at timer-fire time, so any
delayed duplicate whose own 20 ms defer outlasted the 40 ms safety clear
lost the suppression race.

**Folded** in commit `42b1642` with the **claim-at-schedule** approach
(all three convergent reviewers' preferred fix):

- The wrapper atomically captures `claim = lastCompositionCommit` into the
  defer closure AND nullifies the live token at trigger-schedule time.
- The defer's inner check uses the captured `claim`, race-free against
  the safety clear's later mutation of `lastCompositionCommit`.
- The atomic null doubles as **consume-on-suppress**: subsequent triggers
  see live token === null at schedule time → don't capture → pass through.
  This closes the same window that the explicit "consume on suppress"
  code from round-1 covered (the explicit code became redundant and was
  removed in this fold).

### Regression test added in the fold

- **T7 (delayed-duplicate)** — commit `요` at t=0 → advance 25 ms →
  `cs.triggerDataEvent("요", true)` (simulating xterm's delayed re-emit
  inside the 40 ms window) → advance 25 ms past both the safety timer
  (t=40 ms) and the defer (t=45 ms) → expect `origTriggerCalls === []`
  (suppressed) and `ptyWrites === ["요"]` (one direct compositionend
  invoke).

Empirically verified: pre-round-2 T7 fails with `origTriggerCalls=["요"]`
(round-1's race-prone code escapes the duplicate); post-round-2 T7 passes.

### LOW / NIT (not folded)

- **claude3 task-23 F1 (LOW — 40 ms tight under load)** — auto-resolved
  by claim-at-schedule. The safety clear is no longer load-bearing for
  case-(d) suppression; it now exists only to bound the long-tail when
  no trigger ever arrives. CPU-load timing skew on the safety timer
  cannot recreate the race because the suppression decision is made at
  trigger arrival, not at safety-clear time. Documented here for the
  audit trail; no code change needed.
- **claude4 task-25 F1 (NIT — pending 40 ms timers not cancelled on
  dispose)** — same pattern as the existing 20 ms wrapper defer
  (pre-existing). `!disposed` guard in the safety callback keeps
  post-dispose fires inert. Bounded leak (≤ 40 ms per pending commit),
  no functional impact. Single-reviewer NIT.
- **claude4 task-25 F2 (NIT — token-identity guard not exercised by a
  test)** — guard is correct by code reading; failure-mode is exotic
  (rapid two-syllable composition within 40 ms with case-(d) re-emit
  landing on the wrong syllable). Single-reviewer NIT.

### Architectural axis unchanged across rounds

Bug-site identification (node 9 / case d), variant choice (B4 — single
sub-variant of Shape B family), OUT-OF-SCOPE boundary (terminator union
frozen, consumers untouched), PTY payload bit-identity, scope discipline
(single-file body changes only) — all unchanged from rounds 0 / 1.
Round-2 fold is purely a timing-correctness tightening within B4.

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
