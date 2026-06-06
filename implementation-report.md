# Implementation report — korean-ime-dup-space

## Source

- Planner marker: `feature` from commit `d866424`
  (`feat(planner): merge korean-ime-dup-space (plan-feature, human-confirmed)`)
- Planner artifacts: `plan.md`, `plan.mmd`
- Source hash (sha256 of `plan.md` + `plan.mmd`): `a29896c8…39342`
- Implementer worktree: `.worktrees/implementer-korean-ime-dup-space-22384-82666-4366`
- Implementer branch: `implementer/korean-ime-dup-space-22384-82666-4366`
- Base branch: `dev`

## Work queue summary

- Total items: 5 (one impl + four tests)
- Completed: 5
- Blocked: 0

Plan node N6 (validation) is exercised in Phase 4 below. Plan node N7
(live macOS Tauri smoke + paste-immediately-after-commit smoke per
Success criterion #5 + Risks row 1) is deferred to the user as a
manual acceptance step — headless-test ceiling makes it
implementer-out-of-scope by construction (planner Constraints).

## Files changed

- `src/lib/xtermImeShim.ts` — +35 / -0 lines
  (multi-char prefix-strip dedup branch added before the existing
  length-1 branch in the `triggerDataEvent` wrapper)
- `src/lib/xtermImeShim.test.ts` — +188 / -0 lines
  (new `describe("attachKoreanImeShim — multi-char prefix strip", …)`
  block with four new `it(…)` cases)
- `implementation-report.md` — overwritten (prior cycle's
  `korean-ime-dup-period-arrow` report was the file at the repo
  root; replaced with this run's report)

## Validation

- Baseline exit (BASE_BRANCH HEAD, `dev`): `0` (clean)
- Final validation command: `npx tsc --noEmit && npm test`
- Final exit: `0` (both stages)
- Auto-fix attempts used: `0 / 3` (first run after implementation
  passed; no auto-fix needed)
- Final vitest tally (whole repo): `Test Files 14 passed (14)`,
  `Tests 283 passed (283)` (= 279 baseline + 4 new)
- `xtermImeShim.test.ts` `it(…)` count: `grep -cE '^  it\(' = 36`
  (= 32 baseline + 4 new — matches Success criterion #4's
  expected total)

Tail of final `npm test`:

```
 Test Files  14 passed (14)
      Tests  283 passed (283)
   Start at  14:21:48
   Duration  1.83s (transform 1.66s, setup 1.48s, import 3.50s, tests 600ms, environment 6.50s)
```

## Per-item outcomes

| item_id | status | files_touched | notes |
|---|---|---|---|
| WQ-1-N1 | completed | `src/lib/xtermImeShim.ts` | Multi-char prefix-strip branch inserted before the length-1 branch in the `triggerDataEvent` wrapper. Predicate matches the planner's N1 sketch verbatim (including the redundant `!isComposing` flag the plan calls out for postcondition-local readability). On match: `lastCompositionCommit = null; return;` — P6 FULL SUPPRESSION (drops both the composed prefix AND the trailing char, both of which have already been delivered via the direct PTY and xterm `_keyDown` paths under Order B). Preserves P1-P6 verbatim. |
| WQ-2-N2 | completed | `src/lib/xtermImeShim.test.ts` | T-space (positive repro). Full Order-B dispatch sequence: `fireInput/keydown(229)/compositionend("녕")` → `cs.triggerDataEvent(" ")` (synchronous `_keyDown`) → `cs.triggerDataEvent("녕 ")` (late `CompositionHelper` substring). Asserts `ptyWrites=["녕"]`, `origTriggerCalls=[" "]`, `onComposedFlush` called once with `("녕", null)`. |
| WQ-3-N3 | completed | `src/lib/xtermImeShim.test.ts` | T-digit (positive repro, ASCII generality). Same dispatch shape with `"2"` in place of `" "`. Asserts `ptyWrites=["녕"]`, `origTriggerCalls=["2"]`. |
| WQ-4-N4 | completed | `src/lib/xtermImeShim.test.ts` | T-non-matching-multi-char (over-suppression guard). After `"녕"` commits, fires `cs.triggerDataEvent("한자")`. Strip's `data.startsWith(live.text)` predicate rejects (`"한자".startsWith("녕")=false`); payload reaches `origTrigger` verbatim. Asserts `origTriggerCalls=["한자"]`, `ptyWrites=["녕"]`. |
| WQ-5-N5 | completed | `src/lib/xtermImeShim.test.ts` | T-replaced-token (defense-in-depth). First commit `"녕"`, second commit `"어"` (replaces live token + advances `imeFlushGen`). Then fire `cs.triggerDataEvent("녕 ")`. Strip rejects on prefix mismatch (`"녕 ".startsWith("어")=false`); payload reaches `origTrigger` verbatim. Asserts `origTriggerCalls=["녕 "]`, `ptyWrites=["녕","어"]`, `onComposedFlush` called twice. |

## Postcondition adherence (N1 sketch P1-P6)

- **P1 (prefix suppression)** — `return;` skips `origTrigger`; the
  committed text is PTY'd only by `onCompositionEnd`'s
  `invoke("write_to_pty")`. Verified by T-space / T-digit's
  `ptyWrites=["녕"]` + `origTriggerCalls=[" "]` / `["2"]`.
- **P2 (token consumption)** — `lastCompositionCommit = null;` before
  return. Covered transitively by the existing B4 T6
  "consume-on-suppress" pattern (line 1129) which continues to pass.
- **P3 (non-suppression on prefix mismatch)** — Verified by
  T-non-matching-multi-char (`"한자"` flows through `origTrigger`).
- **P4 (non-suppression on stale / replaced token)** — Verified by
  T-replaced-token (after second commit, stale-prefix `"녕 "` flows
  through `origTrigger`).
- **P5 (non-suppression during composition)** — Both the wrapper-level
  early-return at line 608 and the explicit `!isComposing` flag in the
  new predicate enforce this. Not exercised by a new dedicated test
  (planner left this as a local-readability hint, not a test
  obligation); covered transitively by the existing
  "Korean triggerDataEvent defer" tests (lines 576-615) which all
  continue to pass.
- **P6 (trailing-char suppression — FULL drop, NOT re-emit)** —
  Verified by T-space's `origTriggerCalls=[" "]` (one space, NOT
  `[" ", " "]` and NOT `[" ", "녕 "]`) and T-digit's
  `origTriggerCalls=["2"]`.

## Scope-discipline self-check

- [x] No new interfaces / files outside hints (only edited
      `src/lib/xtermImeShim.ts` and `src/lib/xtermImeShim.test.ts` —
      both in the planner's `files_hinted` set; no new source files
      created; `implementation-report.md` overwrites the prior cycle's
      stale report at the repo root)
- [x] No renames of committed public names (`KoreanImeShimHandle`,
      `AttachKoreanImeShimOptions`, `attachKoreanImeShim`,
      `onComposedFlush` all preserved verbatim — confirmed by the
      14 passing test files including the two subscriber check paths)
- [x] No signature changes on planner-committed methods
- [x] No edits to `validation_command` configuration (no changes to
      `package.json`, `tsconfig.json`, `vitest.config.ts`, or any
      lint/test config)
- [x] No edits to files outside the work queue's hint set
      (`package-lock.json` drift from `npm install` was discarded;
      see Notes)
- [x] No re-architecting of the IME state machine,
      `onCompositionEnd`, `onTextareaBlur`, `docInput`, `docKeyDown`,
      or the `isCursorHidden` descriptor swap (per planner
      Out-of-scope)
- [x] No widening of `KOREAN_CODEPOINT_RE` (per planner Out-of-scope)
- [x] No changes to the `onComposedFlush` terminator union (per
      planner Out-of-scope)
- [x] No new packages, version bumps, scaffold/config edits (per
      planner Constraints)

## Notes

- `package-lock.json` drift (version field `0.5.1 → 0.5.4`) from
  `npm install` in the worktree was reverted via `git checkout --
  package-lock.json` before commit — cosmetic install-tooling noise
  that is already correct on `dev` HEAD.
- Manual smoke acceptance (Success criterion #5 sequences
  `안녕<space>`, `안녕하<space>`, `안녕2`, `안녕하세요.`, plus
  Risks-row-1 paste-immediately-after-commit smoke) is deferred to
  the user — headless-test ceiling applies per planner Constraints.
  The paste-window edge documented in Risks row 1 (full-payload
  drop of a coincident-prefix paste within 40 ms) is an accepted
  trade-off for this cycle; if smoke surfaces the loss, escalate to
  the planner.
- Risks-row-5 (Order-Q token-consumption race) and Risks-row-2
  (false non-suppression beyond the 40 ms safety bound) remain
  headless-undetectable; live smoke is the authoritative check.

## Round-1 peer-review fold

Four reviewers (`@codex1`, `@claude2`, `@claude3`, `@codex3`)
reviewed commits `4753b16` + `2672d50`; reports live under
`session-1954/task-{20,21,22,23}-…review-….md`. **4 / 4 reviewer
convergence on APPROVE — no gating findings, no code-level
blockers.** This round produces no code change; only this fold
section is added to the report.

### Convergence table

| Reviewer | Verdict | Independent verification |
|---|---|---|
| `@codex1` (task-20) | APPROVE | Line-level diff read against N1 sketch + P1-P6 postconditions; dual-channel `ptyWrites` / `origTriggerCalls` test review; `git diff --check`, `npx tsc --noEmit`, `npx vitest run src/lib/xtermImeShim.test.ts` (36/36), `npm test` (283/283). |
| `@claude2` (task-21) | APPROVE | **Empirical baseline-FAIL verification** — reverted `src/lib/xtermImeShim.ts` to `dev` HEAD (`d866424`), re-ran the new test block, restored. Confirmed Success criterion #1 polarity split: positive repros (T-space / T-digit) FAIL on baseline, over-suppression guards (T-non-matching / T-replaced-token) PASS on baseline. Working tree restored clean. Full validation + diff-stat re-run. |
| `@claude3` (task-22) | APPROVE | Predicate trace against N1 sketch line-by-line; postcondition table walk-through; T-replaced-token `imeFlushGen++` post-increment lifecycle trace at `xtermImeShim.ts:482`; explicit prior-cycle B4 regression filter (`-t "B4 dedup token lifetime"` → 4/4); `grep -E "^(\+|\-)(export\|interface\|type\|function\|class)"` on diff returns empty (zero API drift). |
| `@codex3` (task-23) | APPROVE | Line-level diff read; planner-cross-reference of Success criterion #5 + Risks row 1 (`plan.md:202-208`, `plan.md:336`); same validation suite (vitest 36/36 + 283/283, tsc clean, diff-check clean). |

@claude2's revert-and-rerun is the strongest independent
verification of the round-1 F3 split-by-polarity claim and is
trace-concurred by @claude3's static analysis and by the
implementer's own pre-fold analysis (the planner's draft-3
correction predicted exactly this behavior).

### Folded findings (none — APPROVE)

No findings to fold. Every reviewer's predicate-, postcondition-,
and test-level checks converged on the same conclusion: the
implementation realizes the planner's v3 drop-trailing contract
verbatim. The implementer's report and predicate match the planner
sketch line-for-line; no reviewer requested any code edit.

### Not folded — out-of-scope / planner-acknowledged

- **Risks-row-1 paste-window edge** (cited by @claude2, @claude3,
  @codex3): the 40 ms coincident-prefix paste drop. Planner-
  acknowledged trade-off; routed to user via live smoke per
  `plan.md:336`. Not a fold action; documented in the Notes section
  above and in the implementer-report's Postcondition adherence.
- **Risks-row-5 Order-Q race** (cited by @claude2, @claude3):
  headless-undetectable; live smoke is authoritative per
  `plan.md:340`. Not a fold action.
- **Risks-row-2 long-tail false non-suppression** (cited by
  @claude3): same long-tail as the prior period-arrow cycle;
  planner-accepted.

### Round-1 closure summary

- 4/4 reviewers verified the N1 sketch shape against
  `src/lib/xtermImeShim.ts:607-643`.
- 4/4 reviewers verified P1-P6 postcondition adherence via the
  new test suite.
- 4/4 reviewers ran validation and reported
  `Test Files 14 passed (14)`, `Tests 283 passed (283)`,
  `tsc --noEmit` exit 0, `git diff --check` clean.
- 4/4 reviewers reported scope-discipline checks pass (no API
  drift, no signature changes, no `KOREAN_CODEPOINT_RE` widening,
  no terminator-union changes, no `package-lock.json` drift).
- 4/4 reviewers explicitly defer the final acceptance gate to live
  macOS WKWebView Korean IME smoke per planner Success criterion
  #5 (sequences `안녕<space>`, `안녕하<space>`, `안녕2`,
  `안녕하세요.`, and paste-immediately-after-commit).

No round-2 peer-review pass is required for this cycle: round-1
already achieved unanimous APPROVE across two independent agent
families (Claude × 2, Codex × 2), one of which performed an
empirical baseline-FAIL revert. The marginal value of additional
headless review rounds is zero given headless-test ceiling
documented in planner Constraints. The next non-trivial signal
must come from live smoke.
