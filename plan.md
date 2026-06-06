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
  block:
  - **T-space (positive)**: the validated repro from
    `task-1-claude1-report.md`. Assert `directWrites` ≡ `["녕"]`
    (the `invoke("write_to_pty")` channel), `indirectWrites` ≡
    `[" "]` (the `origTrigger` channel — note: `" "` only,
    **NOT** `"녕 "`).
  - **T-digit (positive)**: same dispatch shape with `"2"` as the
    trailing char in place of `" "`. Confirms the strip generalizes
    across ASCII-trailing chars, not just space.
  - **T-non-matching-multi-char (negative control)**: emission of
    `"한자"` after a `"녕"` commit. The strip MUST NOT fire (text
    does not start with `"녕"`); `"한자"` flows through `origTrigger`
    verbatim. Prevents over-suppression of legitimate multi-char
    pastes / IME emissions.
  - **T-stale-gen (negative control)**: after the commit's token is
    set, a new composition starts (incrementing `imeFlushGen`)
    before xterm's `setTimeout(0)` fires. When the multi-char
    arrival reaches the wrapper, gen mismatch → fall through →
    no strip. Prevents spurious suppression after the dedup window
    has logically closed.
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
- Must not regress any of the **19 existing tests** in
  `xtermImeShim.test.ts`, including the T1–T4 regression suite from
  `korean-ime-dup-period-arrow` (commit `116ede7`, 5 peer-review
  rounds).
- High regression sensitivity — same code path as the just-merged
  prior cycle. Implementer is expected to run a multi-round
  peer-review fold consistent with that history (number of rounds
  not constrained by this planner; defer to implementer skill).
- Headless-test ceiling: real macOS Tauri + Korean IME smoke is the
  only authoritative acceptance for WKWebView behavior. Plan node 7
  (live smoke) applies; passing all four new tests + the 19
  pre-existing tests is necessary but not sufficient.
- No new dependencies; no version bumps; no scaffold/config edits.

## Success criteria

1. **Negative baseline locked**: each of T-space, T-digit,
   T-non-matching-multi-char, T-stale-gen fails on the
   pre-implementer `dev` HEAD; passes after the implementer's
   change.
2. **Non-regression**: all 19 pre-existing Vitest cases in
   `xtermImeShim.test.ts` continue to pass.
3. **Compile clean**: `tsc --noEmit` exits 0.
4. **Test runner clean**: `npm run test` exits 0.
5. **Live smoke (manual, Phase 7 ceiling)**: real Tauri build, macOS
   Korean IME, type the sequences
   `안녕<space>`, `안녕하<space>`, `안녕2`, `안녕하세요.` —
   no visible duplicate syllables.
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
| N5 | T-stale-gen (negative control) | `src/lib/xtermImeShim.test.ts` | same describe block | N1 |
| N6 | Validation | repo root | `npm run test` (Vitest, 19 + 4) and `tsc --noEmit` | N1, N2, N3, N4, N5 |
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
  data.length > live.text.length &&        // strict: strip yields non-empty trailing
  data.startsWith(live.text) &&
  !isComposing                              // a new composition must not be active
) {
  lastCompositionCommit = null;             // token consumed
  const trailing = data.substring(live.text.length);
  origTrigger(trailing, wasUserInput);
  return;
}
```

Postconditions the implementer must preserve:

- **P1 (suppression)**: when the conditions match, the composed
  prefix is NOT emitted via `origTrigger` (the direct
  `invoke("write_to_pty")` in `onCompositionEnd` is the sole
  emission of the committed text).
- **P2 (token consumption)**: a successful strip nulls
  `lastCompositionCommit`, so a subsequent length-1 re-arrival of
  the same Korean codepoint within the same gen falls through (no
  double suppression).
- **P3 (non-suppression on mismatch)**: a multi-char arrival whose
  text does NOT start with the live token's text must leave the
  token intact (so a later length-1 duplicate can still claim it
  via the existing branch).
- **P4 (non-suppression on stale gen)**: when `imeFlushGen` has
  advanced past `live.gen` (a new composition started), the strip
  does not fire; fall through.
- **P5 (non-suppression during composition)**: when `isComposing`
  is true (the early-return guard above this block at line 608
  already covers the typical case, but the explicit
  `!isComposing` condition makes the postcondition local-readable
  for implementer review).
- **P6 (no trailing-char drop)**: the trailing characters
  (`data.substring(live.text.length)`) are emitted exactly once
  via `origTrigger`, with the original `wasUserInput` flag
  forwarded.

The strict `data.length > live.text.length` (NOT `>=`) means an
exact-equal arrival (the length-1 case, e.g. `"녕" === "녕"`) is
intentionally **not** handled by this branch — the existing
length-1 branch at line 610 already covers it (with the 20 ms
defer). Two branches, two clean responsibilities.

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| Over-suppression of a legitimate user paste that coincidentally starts with the just-committed syllable (e.g. user types 녕, syllable commits, immediately pastes `녕을 입력하세요`) | The live token is bounded by (a) `imeFlushGen` (resets on any new composition or terminator-flush), (b) the 40 ms safety-clear timer in `onCompositionEnd`, and (c) consumption on first match. A paste arrives via `origTrigger` (xterm input handler), and within the 40 ms window the user-paste WOULD have the syllable prefix stripped. This is a real edge case; the 40 ms safety bound makes it narrow but non-zero. **Live smoke must specifically test paste-immediately-after-commit**; implementer adds a smoke-noted case if it surfaces. |
| False non-suppression: xterm emits `"녕 "` AFTER the 40 ms safety clear has nulled the token | The setTimeout(0) in xterm's CompositionHelper fires within milliseconds; 40 ms is comfortably outside the worst-case latency. If WKWebView ever delays the setTimeout past 40 ms (unlikely; node event loop), the duplicate slips through and the user sees `안녕녕` (no trailing space). This is the **same long-tail risk** the round-2 period-arrow fold accepted; not novel. |
| New describe-block test name collision | The new `describe` block name is unique (`"attachKoreanImeShim — multi-char prefix strip"`). Vitest does not enforce uniqueness; the implementer verifies the new block is appended at the end of the file, after the existing T1-T4 block. |
| TypeScript strict-mode drift | `tsc --noEmit` runs in CI per `npm run build`. The strip path uses no new types; it reads from the existing `lastCompositionCommit` shape. No drift expected. |

## Open questions

- **Q1**: should the prefix-strip proactively cover the period case
  (re-validate that T1 at `xtermImeShim.test.ts:723` accurately
  models production)? **Proposal**: NO new T1 revision in this
  plan — the same prefix-strip path covers period **by
  construction** (the live token catches `"요"` prefix on a `"요."`
  multi-char re-emit). Existing T1 should continue to pass; live
  smoke covers any residual. Implementer may add a one-line note
  to the implementation report if a period repro surfaces in
  smoke.
- **Q2**: should the strip emit the trailing chars via a single
  `origTrigger` call or split per-character? **Proposal**: single
  call. `origTrigger` is an emit relay, not a key-press
  dispatcher; xterm has no notion of "this is the space portion
  of an IME re-emit" and treats the data as opaque PTY bytes.
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
