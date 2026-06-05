# Feature plan — korean-ime-dup-period-arrow

## Goal

Eliminate the Korean-IME last-syllable duplicate that surfaces after a
composition is committed by typing a period (`.`) or pressing an arrow /
direction key. Visible repro:

```
Step 1: type "안녕하세요"                       → screen: "안녕하세요"        (overlay shows "요")
Step 2: type "."                                → screen: "안녕하세요."       (correct)
Step 3: press an arrow key (←/→/↑/↓)            → screen: "안녕하세요.요"    (BUG: "요" duplicated)
```

The duplicate appears on the arrow-key press (Step 3), not on the
period (Step 2). The exact event-ordering on macOS WKWebView that
allows the shim's `isComposing` flag to stay stale into the arrow-key
keydown must be confirmed empirically before any code change.

## In scope

- `src/lib/xtermImeShim.ts` — body changes inside `docKeyDown`
  (else-branch with `isTerminating==false`) and, conditionally on
  the empirical event-order finding, `onCompositionEnd` or the
  `triggerDataEvent` wrapper. **Primary fix site is node 7
  (the duplicate-write site marked red in `plan.mmd`).**
- `src/lib/xtermImeShim.test.ts` — regression tests **T1** (compose →
  period), **T2** (compose → arrow), **T3** (compose → period → arrow,
  the full repro chain), **T4** (modifier-augmented arrow keys —
  Shift+Arrow, Cmd+Arrow).
- `src/lib/xtermImeShim.test.ts` — extend the `fireKeydown` helper
  (currently `{keyCode, key, code, isComposing}` at test lines 92–106)
  to also pass through `shiftKey | ctrlKey | altKey | metaKey` so T4
  can synthesize modifier-augmented arrow keydowns. This is a
  test-harness extension within the same file, not a new module.

## Out of scope

- `src/components/collaborator/AgentMiniTerminal.tsx` and
  `src/lib/terminalManager.ts`. They subscribe to
  `onComposedFlush(committedText, terminator)`; the terminator union
  `"\r" | "\x1b" | "\t" | null` is **frozen**. No signature change.
- Browser-pane / canvas-pane IME flows (separate code paths).
- Korean IME issues outside the period / arrow-key trigger family
  (composition cancel, re-composition mid-fragment, etc.).
- The `localfile://` URL-scheme three-way invariant (unrelated subsystem).
- Japanese / Chinese IME feature support — preserved as non-regression
  only (per the prior cycle's intent envelope).

## Constraints

1. Single-file logic change inside `xtermImeShim.ts`; no new modules;
   no signature changes on `attachKoreanImeShim` or the
   `onComposedFlush` callback.
2. Preserve the terminator union `"\r" | "\x1b" | "\t" | null`. Period
   and arrow keys do NOT become new terminators (Shape A is rejected —
   it would ripple to the OUT-OF-SCOPE consumers).
3. `tsc --noEmit` must pass.
4. Vitest suite (existing + new T1–T4) must pass in full.
5. The `docKeyDown` capture-phase performance characteristics must not
   degrade (no new sync DOM reads inside the hot path).
6. Implementer cannot launch `npm run tauri dev` autonomously
   (skill is `disable-model-invocation`). The live macOS WKWebView
   repro therefore moves to the Phase 6 user-acceptance gate at
   `confirm merge` time — the user reproduces the original bug
   sequence against the implementer's branch and refuses to merge if
   the duplicate persists. The implementer is permitted to select the
   B1/B2/B3 sub-variant from architectural reasoning + the unit-test
   suite when the live trace is unavailable, with the user's Phase 6
   manual repro as the falsification gate. This mirrors how the prior
   `korean-ime-dup-render` cycle resolved the same constraint
   (see commit `0c289f1` implementation-report ≈ "live WKWebView
   gate deferred to Phase 6").

## Success criteria

1. **Manual user-acceptance repro** at the Phase 6 `confirm merge`
   gate (executed by the human user, not the implementer — see
   Constraint #6). Three distinct sequences must each produce no
   duplicate syllable on the visible terminal output:
   - **1a** — `compose → period`: type `안녕하세요`, then `.`. Screen
     shows `안녕하세요.` exactly once (the trailing `.요` regression
     pattern reported in the bug must not appear).
   - **1b** — `compose → arrow`: type `안녕하세요`, then press an arrow
     key (←/→/↑/↓). Screen shows `안녕하세요` and the arrow navigates
     the shell cursor without producing a trailing `요`.
   - **1c** — `compose → period → arrow` (full original repro chain):
     `안녕하세요` → `.` → arrow. Final screen: `안녕하세요.` with no
     duplicate `요` appended.
2. New unit tests **T1** (compose → period), **T2** (compose → arrow),
   **T3** (compose → period → arrow), **T4** (modifier-augmented arrow)
   all pass. Each test's dispatch sequence is specified explicitly in
   "Implementer Phase 0 handoff" below; the asserted observables are
   triple-tracked across `ptyWrites()` (direct shim writes via
   `invoke("write_to_pty")`), `origTriggerCalls` (xterm data-event
   passthrough), and `onComposedFlush` emissions.
3. All existing tests in `src/lib/xtermImeShim.test.ts` still pass
   (zero regressions). Particular non-regression floors to confirm:
   - §"variant (b) commit-boundary fix" (line 290)
   - §"JP/ZH non-regression fixture floor (Node 10)" (line 438)
   - §"onComposedFlush emission" Enter/Esc/Tab cases (lines 364, 379, 393)
   - §"Korean triggerDataEvent defer" (line 563)
   - §"dispose restoration" (lines 603–678)
4. `tsc --noEmit` passes.
5. **Negative-baseline assertion for T3**: with the fix temporarily
   reverted (e.g., `git stash` of node-7 edits), the T3 dispatch
   sequence must reproduce the duplicate — i.e., `ptyWrites().filter(c
   => c.data === "요").length === 2`. If T3 passes without the fix,
   the test is invalid and the fix's success is not empirically
   grounded. The implementer documents this baseline run in the
   implementation report. (Same discipline the prior
   `korean-ime-dup-render` round-2 fold installed for variant-(b).)

## Open questions

All Phase 1 open questions are resolved at the **plan** level; the
remaining ambiguity (the choice between Shape B sub-variants) is
deferred to the implementer's Phase 0 because it depends on the
empirical WKWebView event order, which the planner cannot capture
without running the app.

| # | Question | Resolution at plan level |
|---|---|---|
| Q1 | Shape A (widen terminator set) vs Shape B (tighten stale-fragment guard) | **Shape B** locked. Sub-variant (B1 / B2 / B3 — see "Implementer Phase 0 handoff" below) selected by implementer after empirical capture. |
| Q2 | Physical keyboard vs synthesized helper-textarea | Manual `npm run tauri dev` repro on macOS required (Constraint #6). |
| Q3 | Modifier-augmented arrow keys | **In scope** as test T4. |

## Package layout

No new packages introduced — feature lives in `src/lib/`
(`xtermImeShim.ts` is a leaf module; `xtermImeShim.test.ts` is its
test sibling). Both consumers (`AgentMiniTerminal.tsx`,
`terminalManager.ts`) remain untouched.

```
src/
└── lib/
    ├── xtermImeShim.ts          (EDIT — body changes only)
    └── xtermImeShim.test.ts     (EDIT — append T1–T4 regression tests)
```

## Decomposition

The "pipeline" here is the in-shim IME event handler chain. Each node
is one handler function or sub-branch. The same nodes appear in
`plan.mmd`.

| Node # | Stage | Belongs to package | Change | Notes |
|---|---|---|---|---|
| 1 | shim install | `src/lib/` | none | `attachKoreanImeShim` entry |
| 2 | helper-textarea bind | `src/lib/` | none | `bindHelperTextarea` |
| 3 | compose / jamo update | `src/lib/` | none | `docKeyDown` (keyCode==229 branch, lines 518–527) |
| 4 | overlay paint on input | `src/lib/` | none | `docInput` (lines 496–506) |
| 5 | composition commit | `src/lib/` | maybe | `onCompositionEnd` (lines 463–479) — may need guard for late commits |
| 6 | terminator flush (Enter/Esc/Tab) | `src/lib/` | none | `docKeyDown` else-branch with `isTerminating==true` |
| **7** | **stale-state catch-up (period/arrow)** | `src/lib/` | **PRIMARY** | `docKeyDown` else-branch with `isTerminating==false` (lines 528–558) — the duplicate-write site |
| 8 | blur flush | `src/lib/` | none | `onTextareaBlur` (lines 481–492) |
| 9 | xterm data-event suppress/defer | `src/lib/` | maybe | `triggerDataEvent` wrapper (lines 567–582) |
| 10 | overlay paint / clear | `src/lib/` | none | `showOverlay` / `clearOverlay` |
| 11 | subscriber dispatch | `src/lib/` | none | `emitFlush` |
| T1 | regression: compose → period (no arrow) | `src/lib/` | NEW | Triple-channel assertion: `ptyWrites()` contains exactly one entry for the committed last syllable (the `invoke("write_to_pty")` direct path); `.` flows through xterm and is captured in `origTriggerCalls` (NOT in `ptyWrites()` — different observable channel per test lines 41–46 / 127–137); `onComposedFlush` fires once with `(text, null)`. Dispatch sequence per Phase 0 handoff. |
| T2 | regression: compose → arrow (no period) | `src/lib/` | NEW | Same triple-channel discipline. The arrow CSI sequence is NOT emitted by the shim's DOM `keydown` handler itself — it would be emitted by xterm's internal `_handleKey` calling `coreService.triggerDataEvent` downstream. If T2 needs to verify pass-through, it simulates xterm's post-keydown path with an explicit synthetic `cs.triggerDataEvent("\x1b[D", true)` call (matching the existing test pattern at lines 466–482 / 517–555). Assert: `ptyWrites()` shows one syllable entry, no second entry on arrow; `origTriggerCalls` shows the synthesized CSI passthrough; `onComposedFlush` fires once with `(text, null)`. |
| T3 | regression: compose → period → arrow (full repro) | `src/lib/` | NEW | Canonical reproduction of the user-reported bug. Dispatch sequence per Phase 0 handoff — **MUST NOT** fire `compositionend` between period and arrow keydowns (that's the staleness window). Negative-baseline assertion per Success Criterion #5. |
| T4 | regression: modifier-augmented arrow | `src/lib/` | NEW | T4 expects **identical** behavior to T2 — `Shift+Arrow` / `Cmd+Arrow` have `e.key === "ArrowLeft/Right/etc."` (not `"Shift"`/`"Meta"`), so `docKeyDown`'s `isModifier` check at lines 529–533 returns false and the event enters the same node-7 path as plain arrow. T4 confirms the modifier flag does NOT route around the fix. Requires the `fireKeydown` helper extension noted in "In scope" to pass `shiftKey`/`metaKey` through. |

## Stabilized invariants to preserve

These were established by the prior `korean-ime-dup-render` cycle
(merge 95651d2). Any fix at node 7 must leave them green:

- variant-(b) commit-boundary fix (test §"variant (b)", line 290 —
  `imeStartPos` re-anchored at composition start so the next
  `keydown(229)` doesn't repaint the already-committed prefix)
- JP/ZH non-regression fixture floor (test §"Node 10", line 438 —
  3-event sequence with exactly one PTY write; the 4-event pinned
  residual at line 517 must remain pinned)
- `onComposedFlush` emission contract: `(text, null)` on
  `compositionend` / blur; `(text, "\r" | "\x1b" | "\t")` on
  Enter/Esc/Tab mid-composition (lines 335–406)
- 20ms-defer for single Korean codepoint with `imeFlushGen` check
  (test §"Korean triggerDataEvent defer", line 563)
- Dispose restoration (test §"dispose restoration", lines 603–678) —
  document-level listeners removed, `triggerDataEvent` restored,
  `isCursorHidden` descriptor restored, `cursorBlink` restored

## Implementer Phase 0 handoff

The implementer is autonomous (Constraint #6: cannot launch
`npm run tauri dev` itself). Phase 0 therefore captures the
information the unit test suite needs, not live WKWebView traces.
The user's Phase 6 manual repro at `confirm merge` is the
falsification gate.

1. **Read** the committed `intent.korean-ime-dup-render` archive at
   `backup/intent.korean-ime-dup-render.md` and the merged prior fix
   `src/lib/xtermImeShim.ts` lines 463–582 (the `onCompositionEnd`,
   `docKeyDown` else-branches, and `triggerDataEvent` wrapper). The
   bug branches off the prior cycle's variant-(b) work — Phase 0
   builds a written hypothesis tree of three upstream causes of
   stale-`isComposing` state on macOS WKWebView:
   - **(a)** `compositionend` does not fire for the period at all
     (browser ends composition synchronously without dispatching).
   - **(b)** `compositionend` fires AFTER the next keydown (the
     arrow), so shim state is stale at arrow time.
   - **(c)** `compositionend` fires with `e.data=""` — would NOT
     leave the bug (state clears unconditionally at line 476);
     likely ruled out, but the implementer documents the ruling.
2. **Specify the test dispatch sequences explicitly** so each new
   test reproduces the failure mode (not merely an arbitrary
   user-level sequence). The load-bearing question is: does
   `compositionend` fire on the period keydown? If so, before or
   after the period's keydown event? The test sequences below model
   case **(b)** above — the most likely production race — and the
   implementer MUST verify in Step 5 that without the fix applied,
   the sequence reproduces the duplicate.
   - **T1 (compose → period)** dispatch order (model case b):
     ```
     fireInput(textarea, "insertText", "요")
     fireKeydown(textarea, { keyCode: 229 })            // shim: isComposing=true, imeFragment="요"
     fireKeydown(textarea, { keyCode: 190, key: ".", code: "Period", isComposing: true })
                                                        // browser still mid-compose at keydown time
     fireInput(textarea, "insertText", ".")
     fireCompositionEnd(textarea, "요")                  // compositionend FOLLOWS the non-terminating keydown
     ```
     Assertions: `ptyWrites().map(c=>c.data)` equals `["요"]` (one
     entry, not two); `origTriggerCalls` contains no synthetic
     `cs.triggerDataEvent(".")` from the shim (test does not
     simulate xterm's post-keydown path for `.`); `onComposedFlush`
     fires once with `("요", null)`.
   - **T2 (compose → arrow only)** dispatch order:
     ```
     fireInput(textarea, "insertText", "요")
     fireKeydown(textarea, { keyCode: 229 })
     fireKeydown(textarea, { keyCode: 39, key: "ArrowRight", isComposing: false })
                                                        // browser composition ended; shim still flagged composing
     // NO fireCompositionEnd here — staleness window
     cs.triggerDataEvent("\x1b[C", true)                // simulate xterm's post-keydown CSI emission
     ```
     Assertions: `ptyWrites().map(c=>c.data)` equals `["요"]` (one
     entry only); `origTriggerCalls` contains `"\x1b[C"`;
     `onComposedFlush` fires once with `("요", null)`.
   - **T3 (compose → period → arrow, full repro)** dispatch order:
     ```
     fireInput(textarea, "insertText", "요")
     fireKeydown(textarea, { keyCode: 229 })
     fireKeydown(textarea, { keyCode: 190, key: ".", code: "Period", isComposing: true })
     fireInput(textarea, "insertText", ".")
     fireKeydown(textarea, { keyCode: 39, key: "ArrowRight", isComposing: false })
                                                        // CRITICAL: NO fireCompositionEnd between period and arrow
     ```
     Assertions: `ptyWrites().map(c=>c.data)` equals `["요"]` (the
     canonical anti-regression — exactly one syllable write); the
     duplicate `["요", "요"]` is what the bug produces and what the
     test MUST reject when the fix is applied. Negative-baseline
     per Success Criterion #5.
   - **T4 (modifier-augmented arrow)** dispatch order: same as T2
     with `shiftKey: true` (one variant) and `metaKey: true` (a
     second variant); both expect identical behavior to T2.
3. **Select** the Shape B sub-variant based on the hypothesis tree
   and the test sequences above:
   - **B1 — non-terminating no-write**: in the `else-branch,
     non-terminating` case, do NOT write `composed`. Just sync state
     (clear overlay, set `isComposing := false`, bump `imeFlushGen`).
     Trust `onCompositionEnd` to write via invoke. **Pick this if
     the trace (or unit-test-encoded hypothesis) shows
     `compositionend` reliably FOLLOWS the non-terminating keydown
     for the same commit.** ⚠ **Loss-of-syllable risk**: if
     `compositionend` does NOT fire for the period at all (case (a)
     above) or fires only after the arrow keydown's stale state has
     already been cleared by `if (!isModifier) isComposing = false`
     at line 557, B1 silently drops the syllable instead of
     duplicating it — a different bug, not a fix. Verify case (a)
     is ruled out (via the hypothesis tree in Step 1 + the unit
     test failures one would see without compositionend) before
     selecting B1.
   - **B2 — conditional write with onCompositionEnd guard**: write
     `composed` in the non-terminating case only when a per-keydown
     `compositionEndExpected` flag indicates `compositionend` will NOT
     fire afterward (the flag is set by `onCompositionEnd` itself or
     by an `imeFlushGen`-style sentinel). Pick this if the
     hypothesis tree shows mixed orderings depending on the key, OR
     if you want defense in depth against case (a). Recommended
     default when uncertain.
   - **B3 — per-syllable dedup token**: keep the current write path
     but tag the payload with a syllable token; `onCompositionEnd`
     suppresses any tagged payload it sees second. Pick this only as
     a last resort — most invasive of the three and adds a new
     payload-tagging concern to the shim/PTY contract.
4. **Encode the case-(b) ordering** in a header comment block above
   each new test stating which hypothesis case (a/b/c) the dispatch
   sequence models, so a future event-order shift in xterm.js or
   WKWebView documents itself when the test breaks.
5. **Negative-baseline check** before declaring the fix complete:
   temporarily revert the node-7 edit (`git stash` of the
   `docKeyDown` change is sufficient) and re-run T3. With the fix
   reverted, T3's assertion MUST fail with `ptyWrites().filter(...)`
   length 2 (the duplicate reproduced). Document the baseline output
   in the implementation report, then restore the fix and confirm
   the assertion passes.
6. **No `console.log` instrumentation in committed code.** Any
   temporary logging used during local diagnostic runs MUST NOT land
   on `dev`. (Phase 6 user-acceptance repro is the live falsification
   gate; the implementer's confidence comes from the case-(b)
   hypothesis + the negative-baseline check + the unit test suite.)

## Validation

- Phase 6 (compile check on emitted skeletons) is skipped — no
  skeletons emitted (feature lane, no cross-boundary contract). See
  the `feature-lane.md` skeletons-skipped branch.
- Phase 7 smoke-check (run before commit):
  - `plan.md` non-empty, contains `## Goal`, `## Package layout`,
    `## Decomposition` headers. ✓
  - `plan.mmd` first line is `flowchart TD`. ✓
- The full `tsc --noEmit` + Vitest validation happens in the
  implementer's Phase 5 (post-edit validation loop), not here.

## Rubric self-score (feature lane, 4 criteria × 4 levels)

| Criterion | Score (1–4) | Reasoning |
|---|---|---|
| Decomposition completeness | 4 | All 11 existing handlers inventoried; primary fix site (node 7) explicitly named; 4 test nodes (T1–T4) cover the trigger family + Q3 |
| Dependency direction | 4 | `xtermImeShim.ts` is a leaf module; consumers untouched; OUT-OF-SCOPE boundary is enforced by the "preserve terminator union" constraint |
| Validation status | 3 | Phase 7 smoke-check passes; the harder validation (`tsc --noEmit` + Vitest) is intentionally deferred to the implementer per feature-lane spec; live macOS WKWebView repro is the user's Phase 6 acceptance gate per Constraint #6 |
| Plan coverage (Phase-1 goal → decomposition) | 4 | Each in-scope item maps to a node; success criteria 1–5 each map to a test, compile check, or user-acceptance gate; open questions Q1/Q2/Q3 are resolved or have an explicit handoff with three named sub-variants and explicit dispatch sequences |

## Round-1 peer-review fold (5 reviewers — @codex2, @claude3, @codex3, @claude4, @codex4)

All 5 reviewers approved direction; all requested revisions before
the human-confirmed gate emits. Convergent findings (3+ reviewers):

- **F-A — B1 selection criterion was reversed** (claude4 F1, codex3 #1, codex4 #3, claude3 F2 implicit). Verified against source `xtermImeShim.ts` lines 463–479 vs 528–558: if `onCompositionEnd` fires first, `isComposing` is already false at the bug-site check; the bug only manifests when `compositionend` follows the non-terminating keydown. **Folded into** Step 3 / B1 — re-worded to "compositionend reliably FOLLOWS the non-terminating keydown for the same commit." Added explicit loss-of-syllable warning (claude3 F2 medium) for case (a) where `compositionend` never fires.
- **F-B — Test channel confusion (`ptyWrites` vs `origTriggerCalls`)** (claude4 F2, codex3 #2, codex4 #2, codex2 Low, claude3 implicit). Verified `xtermImeShim.test.ts` lines 41–46 (mock terminal's `triggerDataEvent` → `origTriggerCalls`) and 127–137 (`ptyWrites()` filters for `invoke("write_to_pty")`). **Folded into** T1/T2/T3/T4 row text and Phase 0 Step 2 dispatch sequences — assertions now triple-track `ptyWrites()`, `origTriggerCalls`, and `onComposedFlush`. Plus codex2's "DOM keydown does not itself emit xterm CSI; simulate downstream with synthetic `cs.triggerDataEvent`" — folded into T2's dispatch.
- **F-C — T4 helper extension + concrete semantics** (claude4 F3, codex3 #3, codex4 #4, claude3 F5 implicit). Verified `fireKeydown` at test lines 92–106 only passes through `{keyCode, key, code, isComposing}`. **Folded into** In-scope ("extend `fireKeydown` to pass `shiftKey | ctrlKey | altKey | metaKey`") and T4 row ("expects identical behavior to T2 — modifier flag does NOT route around the fix").
- **F-D — Encode WKWebView event order in test dispatch sequences** (claude4 F4, codex4 #1, claude3 F1 HIGH). **Folded into** Phase 0 Step 2 — each T1/T2/T3/T4 now has an explicit `fireInput`/`fireKeydown`/`fireCompositionEnd` sequence. Plus header-comment requirement (Step 4) and negative-baseline check (Step 5 + Success Criterion #5).

Single-reviewer findings folded:

- **codex2 Medium — manual repro should enumerate period-alone, arrow-alone, period+arrow.** Folded into Success Criterion #1 (1a / 1b / 1c).
- **claude3 F4 LOW — Constraint #6 not enforceable for autonomous implementer.** Folded — Constraint #6 reframed: live repro moves to Phase 6 user-acceptance gate; implementer selects B1/B2/B3 from architectural reasoning + unit tests when live trace is unavailable. References prior cycle's resolution.
- **claude3 F1 HIGH — period-vs-compositionend ordering is the load-bearing question.** Folded into Phase 0 Step 2 ("The load-bearing question is: does compositionend fire on the period keydown? If so, before or after?") and Step 1 hypothesis tree cases (a/b/c).

Cosmetic finding folded:

- **claude3 F3 — Mermaid label "writes composed alone" technically writes `composed + empty suffix`.** Folded into `plan.mmd` Bug-node label.

Not folded (cosmetic only, source-of-truth is committed plan.md):

- **claude4 F5 — collab Phase-3 message claimed 14 rows; plan.md has 15.** No action — the historic collab message is not the source of truth.
