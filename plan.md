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
6. Implementer cannot meaningfully execute a live macOS WKWebView
   repro autonomously. `npm run tauri dev` is an interactive process
   that requires a human to observe the rendered terminal and type
   with a real Korean IME; the implementer skill has Bash access but
   cannot observe the rendered DOM or type Korean keystrokes headlessly.
   The live repro therefore moves to the Phase 6 user-acceptance gate
   at `confirm merge` time — the user reproduces the original bug
   sequence against the implementer's branch and refuses to merge if
   the duplicate persists. The implementer is permitted to select the
   Shape B sub-variant (B1 / B2 / B3 / B4) from architectural reasoning
   + the unit-test suite when the live trace is unavailable, with the
   user's Phase 6 manual repro as the falsification gate. This
   mirrors how the prior `korean-ime-dup-render` cycle resolved the
   same constraint.

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
5. **Negative-baseline reproducibility for T3**: with the fix
   temporarily reverted (e.g., `git stash` of the candidate fix
   edits), the T3 dispatch sequence must reproduce the duplicate
   syllable. **The exact duplicate signal is NOT pre-specified by
   the planner** — the round-2 peer review (5/5 reviewers) confirmed
   that the literal Phase 0 Step 2 dispatch sequence below cannot
   produce two direct `ptyWrites()` entries for `"요"` against the
   current source. The dispatch sequence below is therefore a
   **starting hypothesis** modeling case (b); the implementer's
   Phase 0 Step 5 explicitly requires extending or revising the
   sequence until the duplicate reproduces, then locking the
   discovered failing sequence into T3 with an updated case-label
   header comment. Acceptable duplicate signals (any one is
   sufficient):
   - `ptyWrites().filter(c => c.data === "요").length === 2`
     (two direct shim writes; matches case (b) if extended), OR
   - `ptyWrites().filter(c => c.data === "요").length === 1 AND
      origTriggerCalls.filter(c => c.data === "요").length === 1`
     (one direct shim write + one xterm pass-through; matches case
     (d) — defer-fire race after compositionend), OR
   - any other combined-channel observable that the implementer
     documents in the test header comment AND in the implementation
     report, with a passing post-fix run and a failing pre-fix run.
   If the implementer cannot construct ANY dispatch sequence that
   reproduces the duplicate against current `dev` HEAD, escalate
   back to the planner (the hypothesis tree may be incomplete).
   Do NOT apply a fix against a non-reproducing test — the fix's
   empirical grounding is broken without a failing baseline.

## Open questions

All Phase 1 open questions are resolved at the **plan** level; the
remaining ambiguity (the choice between Shape B sub-variants) is
deferred to the implementer's Phase 0 because it depends on the
empirical WKWebView event order, which the planner cannot capture
without running the app.

| # | Question | Resolution at plan level |
|---|---|---|
| Q1 | Shape A (widen terminator set) vs Shape B (tighten stale-fragment guard) | **Shape B** locked. Sub-variant (B1 / B2 / B3 / B4 — see "Implementer Phase 0 handoff" below) selected by implementer after Phase 0 dispatch-sequence reproduction. |
| Q2 | Physical keyboard vs synthesized helper-textarea | Live macOS WKWebView repro is the user's Phase 6 acceptance gate (per Constraint #6). Unit tests use the synthesized helper-textarea harness as the implementer's reproduction surface. |
| Q3 | Modifier-augmented arrow keys | **In scope** as test T4 (two `it()` blocks: T4-shift and T4-meta). |

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
| **7** | **stale-state catch-up (period/arrow)** | `src/lib/` | **CANDIDATE — case (b)** | `docKeyDown` else-branch with `isTerminating==false` (lines 528–558) — duplicate-write site under case (b). Co-equal with node 9 per round-2 case (d) hypothesis; not "primary" |
| 8 | blur flush | `src/lib/` | none | `onTextareaBlur` (lines 481–492) |
| **9** | **xterm data-event suppress/defer** | `src/lib/` | **CANDIDATE — case (d)** | `triggerDataEvent` wrapper (lines 567–582) — duplicate-write site under case (d) defer-fire race. Co-equal with node 7 per round-2 fold |
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
   builds a written hypothesis tree of upstream causes for the
   duplicate `"요"` write on macOS WKWebView:
   - **(a)** `compositionend` does not fire for the period at all
     (browser ends composition synchronously without dispatching).
     Under (a), node 7's stale-state catch-up at lines 528–558
     writes the duplicate. Affects sub-variant B2.
   - **(b)** `compositionend` fires AFTER the non-terminating
     keydown (the arrow), so shim state is stale at arrow time.
     Same write site as (a); B1's "no-write + trust compositionend"
     fits this case if `compositionend` actually arrives.
   - **(c)** `compositionend` fires with `e.data=""` — would NOT
     leave the bug (state clears unconditionally at line 476);
     likely ruled out, but the implementer documents the ruling.
   - **(d) [NEW per round-2 fold]** `compositionend("요")` fires
     normally and writes "요" via `invoke("write_to_pty")`, then
     **xterm's internal `CompositionHelper` calls
     `coreService.triggerDataEvent("요", true)` LATER** (after
     compositionend has run and `imeFlushGen` incremented). The
     `triggerDataEvent` wrapper at lines 567–582 captures
     `gen = imeFlushGen` (now post-increment), schedules the
     20 ms Korean defer, and the timer's `gen === imeFlushGen`
     check passes (no further increment in 20 ms) → `origTrigger("요")`
     fires → `"요"` lands a second time in the terminal via the
     `terminal.onData → PTY` path (different observable channel
     from node 7's direct `invoke`). This is the case the existing
     test §"Korean triggerDataEvent defer" at line 563 pins only
     in the inverse direction (defer-before-composition). Under
     (d), the **bug site is node 9 (`triggerDataEvent` wrapper),
     not node 7** — node 7's stale-state inner check fails because
     compositionend already cleared `isComposing`. Affects new
     sub-variant B4.
     **Blast-radius note**: case (d) would in principle fire on
     ANY "Korean syllable commit, then no follow-up composition
     within 20 ms" scenario, not just the period/arrow trigger
     specifically. If (d) is the validated mechanism, the user's
     reported trigger family (period/arrow) may be a visibility
     artifact (the duplicate exists but only becomes visible after
     the arrow forces a screen redraw), not the cause. B4 may
     therefore close out other unreported Korean-IME duplicates as
     a side effect — a positive outcome but worth documenting in
     the implementation report.

   The Phase 0 deliverable is to identify which case (a/b/c/d) the
   T1/T2/T3/T4 dispatch sequences actually reproduce against current
   source. The hypothesis tree is allowed to expand if needed
   (escalate-to-planner trigger documented in Step 5).
2. **Specify the test dispatch sequences explicitly** so each new
   test reproduces the failure mode (not merely an arbitrary
   user-level sequence). The load-bearing question is: does
   `compositionend` fire on the period keydown? If so, before or
   after the period's keydown event? AND: does xterm's
   `triggerDataEvent("요")` fire after compositionend
   (case d hypothesis)?

   ⚠ **Important — round-2 fold acknowledgment**: the test sequences
   below are **starting hypotheses (mostly case (b))**, NOT
   validated reproductions. 5/5 round-2 reviewers independently
   verified that these literal sequences do not reproduce a
   duplicate `"요"` against current `dev` HEAD (see trace below
   each sequence and Step 5 below). The implementer MUST extend
   each sequence in Step 5 until the negative baseline reproduces
   the duplicate, then lock the extended sequence into the test
   with an updated header comment naming the case it reproduces.

   **Important — `textarea.value` setup**: every `fireInput` in the
   test harness (test lines 78–90) only dispatches an `InputEvent`;
   it does NOT mutate `textarea.value`. Existing tests always
   assign `textarea.value = "..."` before `fireInput(...)` (see
   test lines 341–344, 369–371, 398–400, etc.). The sequences
   below include those assignments explicitly. The shim reads
   `textarea.value.substring(imeStartPos)` inside `showOverlay`
   (line 504) to set `imeFragment` (line 401); without the
   assignment, `imeFragment` collapses to `""` and the bug-site
   write at line 545 is suppressed by the `if (data)` guard.

   - **T1 (compose → period) starting hypothesis** (models case b):
     ```
     textarea.value = "요"
     fireInput(textarea, "insertText", "요")
     fireKeydown(textarea, { keyCode: 229 })            // shim: isComposing=true, imeFragment="요"
     fireKeydown(textarea, { keyCode: 190, key: ".", code: "Period", isComposing: true })
                                                        // browser still mid-compose at keydown time
     textarea.value = "요."
     fireInput(textarea, "insertText", ".")
     fireCompositionEnd(textarea, "요")                  // compositionend FOLLOWS the non-terminating keydown
     ```
     Target post-fix assertions: `ptyWrites().map(c=>c.data)` equals
     `["요"]` (one entry, not two); `onComposedFlush` fires once with
     `("요", null)`.
   - **T2 (compose → arrow only) starting hypothesis**:
     ```
     textarea.value = "요"
     fireInput(textarea, "insertText", "요")
     fireKeydown(textarea, { keyCode: 229 })
     fireKeydown(textarea, { keyCode: 39, key: "ArrowRight", isComposing: false })
                                                        // browser composition ended; shim still flagged composing
     // NO fireCompositionEnd here — staleness window
     cs.triggerDataEvent("\x1b[C", true)                // simulate xterm's post-keydown CSI emission
     ```
     Target post-fix assertions: `ptyWrites().map(c=>c.data)` equals
     `["요"]` (one entry only); `origTriggerCalls` contains
     `"\x1b[C"`; `onComposedFlush` fires once with `("요", null)`.
   - **T3 (compose → period → arrow, full repro) starting hypothesis**:
     ```
     textarea.value = "요"
     fireInput(textarea, "insertText", "요")
     fireKeydown(textarea, { keyCode: 229 })
     fireKeydown(textarea, { keyCode: 190, key: ".", code: "Period", isComposing: true })
     // NO textarea.value mutation here — keep "요" so docInput
     // does not repaint imeFragment to "요." (sub-issue c)
     fireKeydown(textarea, { keyCode: 39, key: "ArrowRight", isComposing: false })
                                                        // CRITICAL: NO fireCompositionEnd between period and arrow
     ```
     **Trace against current source (per round-2 reviewer verification)**:
     this sequence produces `ptyWrites() === ["요"]` (one entry,
     from node 7's stale-state write on the arrow keydown). The
     negative baseline at Success Criterion #5 requires TWO `"요"`
     emissions (across `ptyWrites` and/or `origTriggerCalls`) — so
     **this sequence is incomplete**. Phase 0 Step 5 extends it
     until the duplicate reproduces (likely by adding either
     `fireCompositionEnd(textarea, "요")` before the arrow to model
     case (b) + a stale-state shim write, or
     `cs.triggerDataEvent("요", true)` after the arrow to model
     case (d) — the defer-fire race).
   - **T4 (modifier-augmented arrow)** — two separate `it()`
     blocks, NOT `it.each` (matches existing test file style):
     - **T4-shift**: same as T2 with `shiftKey: true` on the
       ArrowRight keydown.
     - **T4-meta**: same as T2 with `metaKey: true` on the
       ArrowRight keydown.
     Both expect identical post-fix behavior to T2 — the modifier
     flag does NOT route around the fix because `docKeyDown`'s
     `isModifier` check at lines 529–533 examines `e.key`, which is
     `"ArrowRight"` (not `"Shift"` / `"Meta"`).
3. **Select** the Shape B sub-variant based on the hypothesis tree
   and the validated (Step 5) failing dispatch sequence. **All four
   sub-variants below are body-only inside `src/lib/xtermImeShim.ts`
   — Shape A remains rejected.**
   - **B1 — non-terminating no-write** (fix site: node 7,
     `docKeyDown` else-branch): in the non-terminating case, do NOT
     write `composed`. Just sync state (clear overlay, set
     `isComposing := false`, bump `imeFlushGen`). Trust
     `onCompositionEnd` to write via invoke. **Pick this if the
     validated failing sequence shows `compositionend` reliably
     FOLLOWS the non-terminating keydown for the same commit (case
     b validated).** ⚠ **Loss-of-syllable risk**: if `compositionend`
     does NOT fire for the period at all (case a) or fires only
     after the arrow keydown's stale state has already been cleared
     by `if (!isModifier) isComposing = false` at line 557, B1
     silently drops the syllable instead of duplicating it — a
     different bug, not a fix.
   - **B2 — conditional write with onCompositionEnd guard** (fix
     site: node 7 + node 5): write `composed` in the non-terminating
     case only when a per-keydown `compositionEndExpected` flag
     indicates `compositionend` will NOT fire afterward (flag set by
     `onCompositionEnd` itself or by an `imeFlushGen`-style sentinel).
     Pick this if cases (a) and (b) are mixed, OR if you want defense
     in depth against case (a). Recommended default when uncertain
     between case (a)/(b).
   - **B3 — internal last-commit dedup** (fix site: node 7 +
     shim-internal state only): keep the current
     `invoke("write_to_pty")` payload shape **bit-identical to today
     — the PTY bytes never change**. Add a shim-private
     `lastWrittenComposition: { text: string; gen: number } | null`
     field, updated in `onCompositionEnd` AFTER each successful
     `invoke("write_to_pty", { sessionId, data: e.data })` AND AFTER
     the `imeFlushGen++` increment (so the stored gen is the
     post-commit value). At the node-7 bug site, suppress the write
     when `composed === lastWrittenComposition?.text && imeFlushGen
     === lastWrittenComposition.gen` (i.e., `onCompositionEnd`
     already wrote this exact text and no new composition has
     started since to bump `imeFlushGen`). **No payload-tagging, no
     extra bytes through `write_to_pty`, no signature change on the
     Tauri IPC.** Most invasive of B1/B2/B3 because it requires new
     shim state with explicit lifecycle (must reset on dispose, on
     blur-flush, on new composition start), but the OUT-OF-SCOPE
     boundary stays intact. Structurally close to B4 — the two CAN
     share the same `lastWrittenComposition` state when applied
     together per the Cross-variant scope rule below. Pick only if
     B1/B2 cannot be made to work AND case (d) is ruled out so B4
     is not applicable.
   - **B4 [NEW per round-2 fold] — post-compositionend defer dedup**
     (fix site: node 9, the `triggerDataEvent` wrapper at lines
     567–582): track the last `onCompositionEnd`-committed payload
     in a shim-private `lastCompositionCommit: { text: string; gen:
     number } | null` field. **The store must happen AFTER the
     `imeFlushGen++` increment inside `onCompositionEnd`**, so the
     stored `gen` matches what subsequent deferred
     `triggerDataEvent` capture (which reads `gen = imeFlushGen` at
     defer-schedule time — also post-increment under case (d)).
     Pseudocode:
     ```ts
     // inside onCompositionEnd, after the existing body:
     clearOverlay();
     isComposing = false;
     imeFlushGen++;
     if (written !== null) {
       lastCompositionCommit = { text: written, gen: imeFlushGen }; // post-increment
       emitFlush(written, null);
     }
     ```
     In the 20 ms-defer Korean path inside the wrapper, suppress
     the deferred `origTrigger(data)` if `lastCompositionCommit
     !== null && data === lastCompositionCommit.text && imeFlushGen
     === lastCompositionCommit.gen` (i.e., no new composition has
     happened since the commit). **Pick this if the validated
     failing sequence shows the duplicate originating from xterm's
     `triggerDataEvent("요")` AFTER `compositionend("요")` ran (case
     d validated)** — the duplicate appears in `origTriggerCalls`,
     NOT in `ptyWrites()`. Preserves the existing defer-gen
     invariant for the inverse race (defer-then-composition)
     covered by test §"Korean triggerDataEvent defer" at line 563:
     in the inverse race, a new compositionend increments
     `imeFlushGen` past the deferred-capture's `gen`, so the
     `gen === lastCompositionCommit.gen` check intentionally
     becomes a no-op (no false suppression).

   ⚠ **Cross-variant scope rule**: if the validated failing sequence
   shows the duplicate appears in BOTH `ptyWrites()` AND
   `origTriggerCalls` (cases b and d are co-occurring), the
   implementer applies the matching pair (e.g., B1 + B4) inside the
   same edit. This is still body-only inside `xtermImeShim.ts` and
   does not violate the OUT-OF-SCOPE boundary.
4. **Encode the validated case-label** in a header comment block
   above each new test stating which hypothesis case (a/b/c/d, or a
   newly-discovered case) the dispatch sequence reproduces, so a
   future event-order shift in xterm.js or WKWebView documents
   itself when the test breaks.
5. **Negative-baseline reproduction loop** (round-2 fold — replaces
   the prior "single git stash check"):
   1. Take the Step 2 starting hypothesis for T3, add the
      `textarea.value` assignments, and run the unit test against
      current `dev` HEAD (no fix applied). Capture the actual
      `ptyWrites()` + `origTriggerCalls` + `onComposedFlush`
      values.
   2. If the duplicate reproduces (per any of the acceptable
      signals in Success Criterion #5), label the case (b/d/etc.),
      lock the dispatch sequence into T3 with the header comment
      from Step 4, and proceed to Step 3 (variant selection).
   3. If the duplicate does NOT reproduce, extend the dispatch
      sequence with one of the candidate additions:
      - ⚠ `fireCompositionEnd(textarea, "요")` BEFORE the arrow
        keydown — **NOT viable in JSDOM/happy-dom**:
        `dispatchEvent` is synchronous, and `onCompositionEnd`
        synchronously clears `imeFragment`, sets `isComposing :=
        false`, and increments `imeFlushGen` before returning. By
        the time the arrow keydown fires, node 7's inner `if
        (isComposing && !isModifier)` check returns false →
        no second write. Case (b)'s stale-state window only exists
        in real WKWebView (where `compositionend` may be
        asynchronous relative to keydown). Skip this candidate
        unless you introduce an async/microtask boundary in the
        test runtime to model that delay.
      - `cs.triggerDataEvent("요", true)` AFTER the arrow keydown
        (models case d — xterm's CompositionHelper batched the
        commit and emits it after compositionend). This IS
        reproducible in JSDOM because the wrapper's 20 ms-defer
        path uses `setTimeout`, which Vitest can drive
        synchronously via `vi.useFakeTimers()` + `vi.advanceTimersByTime(25)`
        (see existing test at lines 567–595 for the pattern).
      - **most likely path for synchronous test runtime**: model
        case (d) via the `cs.triggerDataEvent` candidate above.
      - if case (b) is the actually-validated production cause,
        Phase 6 user-acceptance repro will surface it — but the
        unit test for it requires async-aware dispatch and is
        deferred until then.
      Re-run the baseline. Iterate until the duplicate reproduces.
   4. If NO extension reproduces the duplicate against current
      `dev` HEAD, **escalate back to the planner** — the hypothesis
      tree is incomplete and the bug may live in a code path the
      plan does not cover. Do NOT apply a fix against a
      non-reproducing test.
   5. Once the baseline reproduces, document the exact dispatch
      sequence + observable values + case label in the
      implementation report. Then apply the matching sub-variant
      from Step 3, restore the fix, confirm the unit test now
      passes against the post-fix code.
   6. Apply the same loop to T1, T2, T4 (each may model a
      different case; that's expected — T1 likely models case b,
      T2 case b, T3 case b or d or both, T4 same as T2).
6. **No `console.log` instrumentation in committed code.** Any
   temporary logging used during local diagnostic runs MUST NOT land
   on `dev`. (Phase 6 user-acceptance repro is the live falsification
   gate; the implementer's confidence comes from the validated
   failing baseline + the unit test suite + the sub-variant chosen
   to match the case.)

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
| Plan coverage (Phase-1 goal → decomposition) | 4 | Each in-scope item maps to a node; success criteria 1–5 each map to a test, compile check, or user-acceptance gate; open questions Q1/Q2/Q3 are resolved or have an explicit handoff with four named sub-variants (B1/B2/B3/B4) and explicit dispatch sequences |

## Round-3 peer-review fold (5 reviewers — @codex2, @claude3, @codex3, @claude4, @codex4)

5/5 reviewers approve direction. Convergent consensus across rounds.
Three remaining items folded.

### Convergent (3/5) — F2' B3 wording authorizes PTY contract change

- **codex3 round-3 #1 (MEDIUM)** — B3's "adds payload-tagging to
  the shim/PTY contract" conflicts with the OUT-OF-SCOPE boundary.
- **codex4 round-3 Minor Note 2** — B3 should be planner-reopen
  territory unless implementer can keep token internal and prove
  PTY payload unchanged.
- **claude3 round-3 F2' (MEDIUM)** — three sub-traces verifying
  the violation; recommended specific internal-only rewrite.

Independently verified at `src/lib/xtermImeShim.ts:466` /
`xtermImeShim.ts:486` / `xtermImeShim.ts:546`: `data` is the
literal payload sent to PTY; any encoded token would corrupt the
user-visible terminal output.

**Folded**: B3 rewritten as "internal last-commit dedup" with
shim-private `lastWrittenComposition: { text, gen } | null` state.
PTY bytes are bit-identical to today. Cross-referenced with B4 —
the two can share the same internal state when applied together.

### Convergent (4/5) — F3' `fireCompositionEnd` before arrow not viable in JSDOM

- **claude4 round-3 H1 (Advisory)** — synchronous dispatch in
  JSDOM means `onCompositionEnd` clears `isComposing` before
  the arrow keydown runs.
- **claude3 round-3 F3' (LOW)** — same trace; recommended
  tightening Step 5.3.
- **codex2 round-3 (Medium)** — same trace; recommended removing
  or rewording.
- **codex4 round-3 Minor Note 1** — same observation.

Independently verified by tracing `fireCompositionEnd` (test
lines 108–115) which calls `target.dispatchEvent(e)` synchronously
→ `onCompositionEnd` body at `xtermImeShim.ts:463–479` synchronously
clears state → subsequent arrow keydown finds `isComposing=false`
→ node 7's inner check skipped.

**Folded**: Phase 0 Step 5.3 now marks the `fireCompositionEnd`
candidate with ⚠ "NOT viable in JSDOM/happy-dom" and steers the
implementer toward the `cs.triggerDataEvent("요", true)` candidate
(case d, JSDOM-reproducible via `vi.useFakeTimers()` per existing
test §"Korean triggerDataEvent defer" at line 567).

### Single-reviewer — B4 gen timing (codex2 Medium)

**Folded**: B4 description now includes explicit pseudocode placing
`lastCompositionCommit = { text: written, gen: imeFlushGen }`
AFTER the `imeFlushGen++` increment, with a paragraph explaining
how the post-increment value matches the deferred capture's `gen`
under case (d) AND how the inverse race (existing test line 563)
intentionally falls through B4's check without false suppression.

### Cosmetic (2/5) — F4' "three" → "four" sub-variants

**Folded**: rubric Plan-coverage cell now says "four named
sub-variants (B1/B2/B3/B4) and explicit dispatch sequences."

### Cosmetic (1) — H2 node 7 "PRIMARY" vs node 9 "maybe" asymmetry

**Folded**: decomposition table row 7 relabeled
"**CANDIDATE — case (b)**" with annotation "Co-equal with node 9
per round-2 case (d) hypothesis; not 'primary'"; row 9 relabeled
"**CANDIDATE — case (d)**".

### Single-reviewer observation (1) — F5' case (d) blast radius (claude3 LOW)

**Folded**: case (d) description now includes a "Blast-radius
note" — if (d) is the validated mechanism, B4 may close out other
unreported Korean-IME duplicates (Korean-syllable + pause + non-jamo
combinations beyond period/arrow); the user's reported trigger
family may be a visibility artifact. Worth documenting in the
implementation report.

### Architectural axis (unchanged across all 3 rounds — reviewer consensus)

- Scale lane: feature (Scope=1, Risk=2, Ambiguity=2)
- Bug sites: node 7 (case b) + node 9 (case d) — co-equal candidates
- Variant family: Shape B family (B1/B2/B3/B4) — all body-only
- OUT-OF-SCOPE boundary: terminator union frozen; consumers untouched
- Invariant inventory: 5 items from prior cycle, line-cited
- Rubric self-score: 4/4/3/4

@claude3 round-3 and @claude4 round-3 both stated explicitly that
no round-4 peer review is needed once the F2'/F3' folds land.
Phase 8 human-confirm gate is ready.

## Round-2 peer-review fold (5 reviewers — @codex2, @claude3, @codex3, @claude4, @codex4)

All 5 round-2 reviewers approved direction; 5/5 surfaced the same
convergent blocking finding around T3's negative-baseline
executability against the literal Phase 0 Step 2 dispatch sequence.
Folded.

### Convergent (5/5 reviewers) — F1' executability gap

- **claude4 G1 (Medium)** — dispatch sequences omit `textarea.value`
  mutations needed for `imeFragment` to be populated.
- **claude4 G2 (Medium)** — T3's `["요","요"]` baseline cannot be
  reached from the literal sequence; need a Step-5b safety net.
- **codex3 #1 (HIGH)** — same `textarea.value` omission.
- **codex3 #2 (HIGH)** — T3 sequence cannot produce two direct
  `ptyWrites()` entries.
- **codex3 #3 (MEDIUM)** — period input may repaint `imeFragment` to
  `"요."` if value mutation added naively.
- **codex4 (Major)** — same trace; recommended escalating exact
  sequence to implementer.
- **codex2 (Blocking)** — same trace; offered three resolution
  paths.
- **claude3 F1' (HIGH)** — three sub-issues (a) `textarea.value`
  missing, (b) baseline `length === 2` unreachable, (c) naive
  `textarea.value` repaints to `"요."`. Recommended Option A
  (escalate to implementer; planner provides hypothesis as starting
  point).

I independently traced the literal T3 sequence against
`src/lib/xtermImeShim.ts:528–558` and confirmed the duplicate cannot
be produced as specified. **Folded** Option A approach:

- Phase 0 Step 1 hypothesis tree extended with **case (d)** — defer-fire
  race in the `triggerDataEvent` wrapper after `compositionend`.
  Under (d), the duplicate appears in `origTriggerCalls`, not
  `ptyWrites()`. Adds new sub-variant B4 in Step 3.
- Phase 0 Step 2 dispatch sequences now include the required
  `textarea.value` mutations explicitly, AND state that the
  sequences are **starting hypotheses** (not validated
  reproductions), with the trace acknowledgment that they do not
  produce the duplicate as-written.
- Phase 0 Step 5 rewritten as a six-step **negative-baseline
  reproduction loop**: implementer takes the starting hypothesis,
  validates against current `dev`, extends with candidate additions
  (`fireCompositionEnd` before arrow, `cs.triggerDataEvent("요")`
  after arrow, or both) until the duplicate reproduces, locks the
  validated sequence into the test with a case label, then applies
  the matching sub-variant.
- Success Criterion #5 reframed: the exact duplicate signal is NOT
  pre-specified. Acceptable signals include direct `ptyWrites`
  doubling, OR `ptyWrites` + `origTriggerCalls` co-occurring, OR
  any other combined-channel observable documented by the
  implementer. Implementer must escalate back to the planner if NO
  extension reproduces the duplicate (hypothesis tree incomplete).

### Single-reviewer cosmetic (3 reviewers — Q2 consistency)

- **codex3 #4 (LOW)**, **codex2 (Minor)**, **claude3 LOW** — Q2
  table row still said "Manual `npm run tauri dev` repro on macOS
  required (Constraint #6)" but Constraint #6 was reframed in
  round-1. **Folded** — Q2 row now reads "Live macOS WKWebView repro
  is the user's Phase 6 acceptance gate (per Constraint #6). Unit
  tests use the synthesized helper-textarea harness as the
  implementer's reproduction surface."

### Single-reviewer additions

- **claude4 G3 (Minor)** — Constraint #6 mis-cited
  `disable-model-invocation` as the reason the implementer can't
  run `npm run tauri dev` autonomously. The real reason is
  interactive observability (headless Bash can't see the rendered
  DOM nor synthesize Korean keystrokes). **Folded** — Constraint #6
  reworded to "interactive process that requires a human to observe
  the rendered terminal and type with a real Korean IME."
- **claude4 G4 (Nit)** — T4 should specify two `it()` blocks (vs
  `it.each`). **Folded** — Phase 0 Step 2 T4 row now reads "two
  separate `it()` blocks, NOT `it.each` (matches existing test file
  style): T4-shift and T4-meta."
- **plan.mmd** updated — node 9 (`triggerDataEvent` wrapper, defer
  branch) now ALSO marked red as a candidate bug site under case
  (d). This is parallel to node 7 (case b), not a replacement.

### Architectural axis unchanged

Bug site identification (node 7 + node 9), variant choice (Shape B
family — B1/B2/B3/B4), OUT-OF-SCOPE boundary (terminator union
frozen), invariant inventory (5 items), rubric self-score
(4/4/3/4) — unchanged from round-1. The round-2 fold is purely
test-specification and hypothesis-tree work; the planner's
architectural commitments stand.

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
