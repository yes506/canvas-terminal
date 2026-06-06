# Feature plan — korean-ime-dup-space

## Goal

Eliminate the Korean-IME last-syllable duplicate that surfaces in
canvas-terminal's xterm panes when a non-Korean character (space,
digit, ASCII punctuation that does not end composition before xterm's
internal `setTimeout(0)` fires) is typed mid-composition. User-visible
symptom:

```
state: "안녕"   user input: <space>   observed: "안녕 녕 "   expected: "안녕 "
```

This is the **same case (d)** mechanism the round-2 planner fold for
`korean-ime-dup-period-arrow` (merged at `116ede7`, 24 h ago)
documented in its blast-radius note — but the period-arrow fix only
deduped **single-codepoint** Korean re-emits. xterm's
`CompositionHelper._finalizeComposition(true)` schedules a
`setTimeout(0)` that reads `textarea.value.substring(start)` (no
`end`) and emits the result via `triggerDataEvent`. When the user
presses a non-Korean key mid-composition, the substring is
`<composed>+<trailing-char>` (e.g. `"녕 "`). That string is
**length > 1**, bypassing the `data.length === 1` branch in
`xtermImeShim.ts` that holds `lastCompositionCommit` for dedup.

## In-scope

- **Multi-char prefix-strip dedup path** in
  `attachKoreanImeShim`'s `triggerDataEvent` wrapper
  (`src/lib/xtermImeShim.ts:607-656`). When the arriving `data`
  starts with `lastCompositionCommit.text`, the gen matches, AND we
  are NOT currently composing, suppress the prefix and re-emit only
  the trailing characters via `origTrigger`.
- **Token-identity discipline preserved verbatim** from the round-3
  period-arrow fold: claim only when text-prefix AND gen match;
  non-matching multi-char events must leave the live token intact so
  a later length-1 duplicate can still claim it. The existing 40 ms
  safety-clear in `onCompositionEnd` remains the long-tail bound.
- **Four new Vitest cases** under
  `src/lib/xtermImeShim.test.ts`, in a new
  `describe("attachKoreanImeShim — multi-char prefix strip", ...)`
  block. Each test encodes the **full event sequence** (both
  `triggerDataEvent` calls under Order B), not just the final
  channel assertion, per @codex3's finding:

  - **T-space (positive repro)**: the validated repro from
    `task-1-claude1-report.md`. Dispatch sequence (mirrors task-1
    lines 40–47):
    ```ts
    textarea.value = "녕"
    fireInput(textarea, "insertText", "녕")
    fireKeydown(textarea, { keyCode: 229 })
    fireCompositionEnd(textarea, "녕")
    textarea.value = "녕 "
    cs.triggerDataEvent(" ", true)        // xterm._keyDown — ASCII space
    cs.triggerDataEvent("녕 ", true)      // xterm.CompositionHelper setTimeout(0)
    ```
    Assert `directWrites` ≡ `["녕"]` (the `invoke("write_to_pty")`
    channel) AND `indirectWrites` ≡ `[" "]` (the `origTrigger`
    channel — exactly one space, NOT `[" ", " "]` and NOT
    `[" ", "녕 "]`).

  - **T-digit (positive repro, generality across ASCII trailing
    chars)**: same dispatch shape with `"2"` replacing `" "` in
    both the `_keyDown` emission and the late substring. Assert
    `indirectWrites` ≡ `["2"]`.

  - **T-non-matching-multi-char (over-suppression guard)**:
    after a `"녕"` commit (lastCompositionCommit set), simulate
    an emission of `"한자"` via `cs.triggerDataEvent("한자", true)`
    — for example, a paste landing during the dedup window. The
    strip MUST NOT fire (text does not start with `"녕"`);
    `"한자"` flows through `origTrigger` verbatim → `indirectWrites
    ≡ ["한자"]`. Prevents over-suppression of legitimate
    multi-char pastes / IME emissions.

  - **T-replaced-token (defense-in-depth for token-identity
    discipline)** — renamed from T-stale-gen per @codex1 /
    @claude2 / @claude3 convergence on the `imeFlushGen`
    lifecycle. Setup: after a `"녕"` commit, drive a second
    composition that commits `"어"` (this advances `imeFlushGen`
    AND replaces `lastCompositionCommit.text` to `"어"`). Then
    fire `cs.triggerDataEvent("녕 ", true)` — the stale prefix
    `"녕"` is no longer the live token's text. The strip MUST
    NOT fire (prefix check fails first; the gen check is
    defense-in-depth that would also catch it if `lastCompositionCommit`
    ever decoupled from `imeFlushGen` in a future refactor).
    Assert `"녕 "` reaches `origTrigger` verbatim.

  Note on `imeFlushGen` mechanics: `imeFlushGen++` happens at
  composition END / blur / terminator flush (`xtermImeShim.ts:482,
  514, 587`), **not** at composition START (line 564, which only
  sets `isComposing=true`). T-replaced-token therefore exercises
  the replaced-token path that actually exists, not a hypothetical
  "started-but-not-committed" gen increment.
- **Preserve the length-1 Korean dedup path** (existing 20 ms defer
  at `xtermImeShim.ts:610-656`) unchanged — the multi-char strip is
  a **prepended** branch that returns early on match; the length-1
  branch runs only when the prepended branch does not claim.
- **Preserve JP/ZH non-Korean fall-through** pinned at
  `xtermImeShim.test.ts:530`. Multi-char non-Korean strings continue
  to pass through unchanged — the strip fires only when the live
  token's Korean text is a prefix of the arriving data.
- **Preserve blur / Enter / Escape / Tab terminator paths**. The
  `onComposedFlush` terminator union (`"\r" | "\x1b" | "\t" | null`)
  is unchanged; space is NOT a terminator.

## Out-of-scope

- Widening `KOREAN_CODEPOINT_RE` to include other CJK ranges.
  `intent.korean-ime-dup-render.md`'s out-of-scope clause still
  applies; the JP/ZH residual duplicate stays a documented pin at
  `xtermImeShim.test.ts:530`.
- Changing the `onComposedFlush` terminator union or adding space
  to the terminator family.
- Refactoring the 40 ms safety-clear lifecycle or the round-3
  token-identity discipline. The new path **inherits** both; it
  does not replace either.
- Touching anything outside `src/lib/xtermImeShim.ts` and its test
  file. The two subscribers (`src/lib/terminalManager.ts`,
  `src/components/collaborator/AgentMiniTerminal.tsx`) read
  `onComposedFlush` and `KoreanImeShimHandle`; both contracts are
  preserved unchanged.
- Re-architecting the IME state machine, `onCompositionEnd`,
  `onTextareaBlur`, the `docInput` / `docKeyDown` handlers, or the
  `isCursorHidden` descriptor swap.

## Constraints

- Stack: TypeScript; compile gate `tsc --noEmit`; unit tests Vitest
  (`npm run test`). Both must pass clean.
- Must not regress any of the **32 existing tests** in
  `xtermImeShim.test.ts` (verified: `grep -cE '^  it\(' = 32`).
  Breakdown: attach=5, variant-(b)=1, onComposedFlush=6, JP/ZH=3,
  Korean defer=2, dispose=6, T1=1, T2=1, T3=1, T4 (shift+meta)=2,
  round-1 fold B4=4 — total 32. The regression suite from
  `korean-ime-dup-period-arrow` (commit `116ede7`, 5 peer-review
  rounds) is specifically **T1, T2, T3, T4-shift, T4-meta + B4
  T5/T6/T7/T8 = 9 tests** (not 4 as an earlier draft said).
- High regression sensitivity — same code path as the just-merged
  prior cycle. Implementer is expected to run a multi-round
  peer-review fold consistent with that history (number of rounds
  not constrained by this planner; defer to implementer skill).
- Headless-test ceiling: real macOS Tauri + Korean IME smoke is the
  only authoritative acceptance for WKWebView behavior. Plan node 7
  (live smoke) applies; passing all four new tests + the 32
  pre-existing tests (total **36**) is necessary but not sufficient.
- **Order-B IME-event assumption** (added per @claude3 review): this
  plan assumes the WKWebView "Order B" sequence — `compositionend`
  fires BEFORE the trailing key's `_keyDown` `triggerDataEvent`.
  That makes "drop trailing" safe because the trailing character is
  already PTY'd via the synchronous `_keyDown` path. A hypothetical
  "Order A" host (where the trailing keydown fires while
  `event.isComposing=true` and is therefore suppressed by xterm's
  CompositionHelper gate) would lose the trailing char under full
  suppression. Canvas Terminal targets macOS Tauri (WKWebView), and
  task-1 validated Order B as the production behavior. **Re-validate
  on any future non-WKWebView Tauri webview backend** (CEF,
  webview-rs, Linux WebKitGTK port).
- No new dependencies; no version bumps; no scaffold/config edits.

## Success criteria

1. **Negative baseline locked, split by polarity** (corrected per
   @codex1 / @codex2 / @claude2 / @claude3 convergence — the
   negative controls do not exist on baseline and therefore cannot
   fail there):
   - **Positive repros** (`T-space`, `T-digit`): MUST FAIL on
     pre-implementer `dev` HEAD (current code emits the duplicate);
     MUST PASS after the implementer's change.
   - **Over-suppression guards** (`T-non-matching-multi-char`,
     `T-replaced-token`): MUST PASS on `dev` HEAD AND after the fix.
     On baseline, the strip path does not exist, so the multi-char
     payloads `"한자"` / `"녕 "` (after a replaced token) already
     fall through to `origTrigger` verbatim — which is precisely
     what these tests assert. After the fix, the strip's prefix /
     gen check rejects the same payloads, preserving fall-through.
     This proves the fix does not over-suppress.
2. **Non-regression**: all **32** pre-existing Vitest cases in
   `xtermImeShim.test.ts` continue to pass (test count verified;
   prior draft said 19, that was wrong).
3. **Compile clean**: `tsc --noEmit` exits 0.
4. **Test runner clean**: `npm run test` exits 0 — total
   **36 passing** (32 pre-existing + 4 new).
5. **Live smoke (manual, Phase 7 ceiling)**: real Tauri build, macOS
   Korean IME, type the sequences
   `안녕<space>`, `안녕하<space>`, `안녕2`, `안녕하세요.` —
   no visible duplicate syllables AND no visible duplicate trailing
   characters (specifically: `안녕<space>` produces `안녕<one
   space>`, NOT `안녕<two spaces>`). The trailing-char
   non-duplication check is the load-bearing live-smoke acceptance
   for the "drop trailing" correction in P6.
6. **Implementer Phase 7 plan-conformance self-check**: every
   in-scope item is either implemented, validated by an
   implementer-emitted test, or explicitly deferred with a documented
   reason in `implementation-report.md`.

## Package layout

No new packages introduced — feature lives in the existing
`src/lib/` package. Both modified files (`xtermImeShim.ts`,
`xtermImeShim.test.ts`) are already there.

Dependency direction (unchanged after this plan):

```
src/lib/xtermImeShim.ts
  ← src/lib/terminalManager.ts                       (subscriber via onComposedFlush)
  ← src/components/collaborator/AgentMiniTerminal.tsx (subscriber via onComposedFlush)
```

Neither subscriber is modified. The `KoreanImeShimHandle` and
`AttachKoreanImeShimOptions` contracts are preserved verbatim.

## Decomposition

One implementation node + four test nodes + two validation nodes.
See `plan.mmd` for the DAG.

| Node # | Stage | Site | Method/Site | Depends on |
|---|---|---|---|---|
| N1 | Add multi-char prefix-strip dedup path | `src/lib/xtermImeShim.ts` | inside the `triggerDataEvent` wrapper at lines 607–656, **before** the existing `data.length === 1 && KOREAN_CODEPOINT_RE.test(data)` branch | — |
| N2 | T-space regression (positive) | `src/lib/xtermImeShim.test.ts` | new `it()` under `describe("attachKoreanImeShim — multi-char prefix strip", ...)` | N1 |
| N3 | T-digit regression (positive) | `src/lib/xtermImeShim.test.ts` | same describe block | N1 |
| N4 | T-non-matching-multi-char (negative control) | `src/lib/xtermImeShim.test.ts` | same describe block | N1 |
| N5 | T-replaced-token (over-suppression guard, defense-in-depth) | `src/lib/xtermImeShim.test.ts` | same describe block | N1 |
| N6 | Validation | repo root | `npm run test` (Vitest, **32 + 4 = 36 passing**) and `tsc --noEmit` | N1, N2, N3, N4, N5 |
| N7 | Live acceptance smoke (manual) | running app | macOS Tauri + Korean IME | N6 |

## N1 — Implementer guidance (body sketch, not the body itself)

The implementer authors the exact code; the planner pins the
**shape** so the implementer's body-generation stays inside the
contract. Sketch (illustrative, not authoritative — implementer may
reorder identifiers or restructure as long as the postconditions
hold):

```ts
// inside the triggerDataEvent wrapper, BEFORE the existing
// `if (data.length === 1 && KOREAN_CODEPOINT_RE.test(data))` branch:

const live = lastCompositionCommit;
if (
  live !== null &&
  imeFlushGen === live.gen &&
  data.length > live.text.length &&        // strict: trailing exists
  data.startsWith(live.text) &&
  !isComposing                              // a new composition must not be active
) {
  lastCompositionCommit = null;             // token consumed
  return;                                   // FULL SUPPRESSION — see P6
}
```

**Why full suppression (drop trailing too) — the load-bearing
correction from peer review.** Under the validated Order B sequence
in `task-1-claude1-report.md:40-47`, the trailing character (e.g.
the space in `"녕 "`) has ALREADY been emitted via xterm's
`_keyDown` synchronous path before xterm's `CompositionHelper`
setTimeout(0) fires the late substring. Re-emitting the trailing
via `origTrigger(trailing, wasUserInput)` would land it at the PTY
a second time — visible `"안녕  "` (two trailing spaces) instead
of the user-expected `"안녕 "`. The shim must drop the entire
multi-char late emit: both the composed prefix (already invoke'd
in `onCompositionEnd`) AND the trailing char (already emitted via
`_keyDown`) are duplicates. xterm's own `_dataAlreadySent`
deduction (`CompositionHelper.ts:159-160`) does not protect us
here because `_handleAnyTextareaChanges` did not populate it for
the case-(d) path — that's precisely the bug's root mechanism.

Postconditions the implementer must preserve:

- **P1 (prefix suppression)**: when the conditions match, the
  composed prefix is NOT emitted via `origTrigger` (the direct
  `invoke("write_to_pty")` in `onCompositionEnd` is the sole
  emission of the committed text).
- **P2 (token consumption)**: a successful strip nulls
  `lastCompositionCommit`, so a subsequent length-1 re-arrival of
  the same Korean codepoint within the same gen falls through (no
  double suppression via the existing length-1 branch).
- **P3 (non-suppression on prefix mismatch)**: a multi-char
  arrival whose text does NOT start with the live token's text
  must leave the token intact (so a later length-1 duplicate can
  still claim it via the existing branch).
- **P4 (non-suppression on stale token)**: when `lastCompositionCommit`
  has been replaced (or `imeFlushGen` has advanced) due to a
  subsequent commit, the strip does not fire; fall through.
- **P5 (non-suppression during composition)**: when `isComposing`
  is true (the early-return guard above this block at line 608
  already covers the typical case, but the explicit
  `!isComposing` condition makes the postcondition local-readable
  for implementer review).
- **P6 (trailing-char suppression — FULL drop, NOT re-emit)**:
  the trailing characters (`data.substring(live.text.length)`) are
  NOT re-emitted by this branch. They have already been delivered
  via xterm's `_keyDown` synchronous path under Order B (see
  Constraints "Order-B IME-event assumption"). The branch returns
  after `lastCompositionCommit = null`.

The strict `data.length > live.text.length` (NOT `>=`) means an
exact-equal arrival is intentionally **not** handled by this
branch — for the typical case `live.text.length === 1`, the
existing length-1 branch at line 610 already covers it (with the
20 ms defer). Two branches, two clean responsibilities.

**Known gap accepted as out-of-scope for this cycle** (per
@claude3 P2): when `live.text.length > 1` (a hypothetical batched
multi-syllable commit, e.g. `live.text === "안녕"` with an
equal-length late substring `data === "안녕"`), strict `>` fails
AND the length-1 branch's `length === 1` check fails — the
payload falls through to `origTrigger`. In practice macOS WKWebView
Korean IME commits one syllable per `compositionend`, so the gap
is unobserved. Documented here so a future widening does not
silently expand the predicate.

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| Over-suppression of a legitimate user paste that coincidentally starts with the just-committed syllable (e.g. user types 녕, syllable commits, immediately pastes `녕을 입력하세요` within 40 ms) | The live token is bounded by (a) `imeFlushGen` (resets on commit / blur / terminator flush), (b) the 40 ms safety-clear timer in `onCompositionEnd`, and (c) consumption on first match. With **full suppression (P6 corrected)**, a coincident-prefix paste within 40 ms drops the **entire** paste payload (`녕을 입력하세요`) — strictly worse than the original re-emit-trailing variant for this edge case. The 40 ms bound makes it narrow but non-zero. **Live smoke must specifically test paste-immediately-after-commit (`타이핑:녕` then paste `녕을 입력하세요` within 40 ms)**. If the smoke surfaces the loss, implementer escalates back to planner — the candidate mitigation is to consume only the prefix match if the strict `==` (full payload) condition is detected, but that re-introduces the trailing-duplicate. Accepted trade-off for this cycle: bug fix takes priority over a 40 ms-window paste edge. |
| False non-suppression: xterm emits `"녕 "` AFTER the 40 ms safety clear has nulled the token | The setTimeout(0) in xterm's CompositionHelper fires within milliseconds; 40 ms is comfortably outside the worst-case latency. If WKWebView ever delays the setTimeout past 40 ms (unlikely; node event loop), the duplicate slips through and the user sees `안녕녕` (no trailing space). This is the **same long-tail risk** the round-2 period-arrow fold accepted; not novel. |
| New describe-block test name collision | The new `describe` block name is unique (`"attachKoreanImeShim — multi-char prefix strip"`). Vitest does not enforce uniqueness; the implementer verifies the new block is appended at the end of the file, after the existing T1-T4 block. |
| TypeScript strict-mode drift | `tsc --noEmit` runs in CI per `npm run build`. The strip path uses no new types; it reads from the existing `lastCompositionCommit` shape. No drift expected. |

## Open questions

- **Q1 (resolved post-fold)**: should the prefix-strip proactively
  cover the period case? **Resolution**: YES, by construction —
  with the P6 correction (drop trailing), the live token catches
  `"요"` prefix on a `"요."` multi-char late emit, the entire
  payload is dropped, and the `.` is delivered via xterm's
  `_keyDown` path (same as space). Existing T1 at
  `xtermImeShim.test.ts:723` does NOT model the late `"요."` emit
  (per @claude3 P3 — task-1's evidence gap), so T1 will continue
  to pass on baseline AND after the fix without exercising the
  new strip path for period. Live smoke (success criterion #5
  sequence `안녕하세요.`) is the authoritative period-case check.
  Implementer MAY extend T1 to include the late `"요."` emit as a
  defense-in-depth assertion; not gating.
- **Q2 (dissolved post-fold)**: the strip does NOT re-emit
  trailing chars (see P6 correction). xterm's `_keyDown` already
  delivered them under Order B. The "single call vs split"
  question no longer applies.
- **Q3**: implementer peer-review round count? **Proposal**:
  defer to implementer skill. The prior period-arrow cycle ran 3
  implementer rounds + 5 reviewers per round; planner does not
  constrain that schedule here.

## Sources

- `[1]` file: `/Users/donghyeon/.cache/canvas-terminal/collab-memory/session-1954/task-1-claude1-report.md`
  (single source; no cross-source conflict policy exercised)
- Prior cycle reference (read-only, not modified): commit
  `daf9e89` (`plan-feature, human-confirmed` for
  `korean-ime-dup-period-arrow`) and `116ede7` (`impl-feature,
  human-confirmed` for same).

## Round-1 peer-review fold

Five reviewers (`@codex1`, `@claude2`, `@codex2`, `@claude3`,
`@codex3`) reviewed the v1 plan; their reports live under
`session-1954/task-{8,9,10,11,12}-*.md`. Convergence summary:

### Gating (P0 / P1) — all folded into v2

| ID | Severity | Convergence | Verdict | Fold action |
|---|---|---|---|---|
| **F1** N1 sketch + P6 re-emit trailing produces duplicate trailing char under Order B (`indirectWrites=[" ", " "]` not `[" "]`) | P0 | **4/5** (codex1, claude2, claude3, codex3; codex2 missed this) | Verified by tracing seed task-1's Order B sequence + xterm `_keyDown`/`CompositionHelper.ts:165-171` source. Re-emitting trailing produces visible `안녕  ` not `안녕 `. | **N1 sketch rewritten to `return;`**; P6 reworded "FULL drop, NOT re-emit"; Q2 dissolved; load-bearing rationale added under the sketch. |
| **F2** Test count is 32, not 19 | P1 | **2/5** (claude2, claude3) | Verified: `grep -cE '^  it\(' src/lib/xtermImeShim.test.ts` = 32. | **Three sites updated** (Constraints, Success criterion #2, N6 row). Total post-fix budget: 36. |
| **F3** Success criterion #1 incorrectly requires negative controls to fail on baseline | P1 | **4/5** (codex1, codex2, claude2, claude3) | Verified by trace: on baseline (no strip path) `"한자"` and the replaced-token `"녕 "` already fall through, which the negative tests assert → they pass on baseline. | **Criterion #1 split by polarity**: positive repros must fail on baseline; over-suppression guards must pass on baseline and after fix. |
| **F4** Regression suite label "T1–T4 (4 tests)" inaccurate — actual is T1, T2, T3, T4-shift, T4-meta + B4 T5/T6/T7/T8 = 9 tests | P1 | 1/5 (claude3) | Verified by per-describe breakdown. | **Constraints section corrected** to list the 9-test suite explicitly. |

### Non-gating (P2 / P3) — folded selectively into v2

| ID | Severity | Convergence | Verdict | Fold action |
|---|---|---|---|---|
| **F5** T-stale-gen mechanism description ("new composition starts (incrementing `imeFlushGen`)") doesn't match `imeFlushGen` lifecycle — gen only advances at composition END / blur / terminator | P2 | **3/5** (codex1, claude2, claude3) | Verified by reading `xtermImeShim.ts:482,514,557,564,587`. Starting a composition sets `isComposing=true` but does NOT increment gen. | **T-stale-gen renamed → T-replaced-token** with corrected setup ("after the live token has been replaced by a subsequent commit"). Mechanism note added clarifying the gen lifecycle. |
| **F6** Order-A vs Order-B IME-event-order sensitivity — drop-trailing is safe only under Order B | P2 | 1/5 (claude3) | Production behavior is Order B per task-1's WebKit Korean IME analysis. Order A is forward-looking (future Tauri webview backend). | **Order-B assumption added to Constraints** as a load-bearing line with a re-validate-on-port note. |
| **F7** Strict `>` predicate has a multi-syllable equal-length gap — `live.text==="안녕"` with `data==="안녕"` falls through | P2 | 1/5 (claude3) | Real but unobserved (Korean IME commits one syllable per `compositionend` on macOS WKWebView). | **Documented as known out-of-scope** under the N1 sketch, with note explaining why a future widening should NOT silently expand the predicate. |
| **F8** T-digit event-sequence shape needs to be explicit (codex3 wanted full dispatch, not just final channel assertion) | P2 | 1/5 (codex3) | Reasonable for implementer clarity. | **All four new test descriptions rewritten** to encode the full dispatch sequence, not just the final assertion. |
| **F9** Q1 (period-by-construction) interacts with P0 — wrong under v1 sketch (would emit `요..`), correct under v2 (full suppression). | P3 | 2/5 (claude2, claude3) | Verified by trace. | **Q1 reworded post-fold** to explicitly note the period case is covered by the same drop-trailing mechanism; T1 evidence gap acknowledged; live smoke is the authoritative period check; implementer MAY extend T1 as defense-in-depth (non-gating). |
| **F10** False-positive paste window risk got STRICTLY WORSE under full suppression (drops entire paste payload, not just prefix) | P3 | implicit (codex2 advisory; claude2 caveat) | The mitigation candidate (suppress prefix only on full-payload match) re-introduces the trailing duplicate. | **Risk table updated** with the new failure shape; live smoke MUST cover paste-immediately-after-commit; if it surfaces, escalate to planner. |

### Not folded — out of scope or disputed

- **codex3 Finding 2** (T-digit "same dispatch shape" is ambiguous):
  partially folded into F8. The "single-emission `녕2`" path codex3
  asked about is not validated by any seed; not added as a separate
  test case. Implementer may add one if it surfaces in smoke.
- **codex2's "claim only on `{text-prefix, gen, !isComposing}`,
  consume the token on successful strip, and forward the trailing
  bytes once via `origTrigger`"**: NOT folded — this is the
  pre-revision v1 shape that the other 4 reviewers showed produces
  the trailing duplicate. The v2 sketch with `return;` is correct.
  codex2's review missed the F1 contradiction; the convergence
  with the other 4 reviewers + verified trace + the seed task-1
  expected output (`indirectWrites=[" "]`) all point to drop-trailing.
