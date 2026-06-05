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
6. Implementer must reproduce the bug manually in `npm run tauri dev`
   on macOS BEFORE applying any code change — the unit test suite is
   necessary but not sufficient evidence for an event-ordering fix.

## Success criteria

1. Manual repro `"안녕하세요"` + `"."` + ArrowKey produces NO duplicate
   syllable on the visible terminal output (confirmed in
   `npm run tauri dev` on macOS WKWebView).
2. New unit tests **T1** (compose → period), **T2** (compose → arrow),
   **T3** (compose → period → arrow), **T4** (modifier-augmented arrow)
   all pass.
3. All existing tests in `src/lib/xtermImeShim.test.ts` still pass
   (zero regressions). Particular non-regression floors to confirm:
   - §"variant (b) commit-boundary fix" (line 290)
   - §"JP/ZH non-regression fixture floor (Node 10)" (line 438)
   - §"onComposedFlush emission" Enter/Esc/Tab cases (lines 364, 379, 393)
   - §"Korean triggerDataEvent defer" (line 563)
   - §"dispose restoration" (lines 603–678)
4. `tsc --noEmit` passes.

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
| T1 | regression: compose → period (no arrow) | `src/lib/` | NEW | new `it()` in §"onComposedFlush emission"; assert exactly one PTY write of the last syllable, exactly one PTY write of `.`, and `imeFragment` cleared |
| T2 | regression: compose → arrow (no period) | `src/lib/` | NEW | new `it()`; assert exactly one PTY write of the last syllable, no second write on arrow keydown, and arrow CSI sequence emitted via `triggerDataEvent` |
| T3 | regression: compose → period → arrow (full repro) | `src/lib/` | NEW | new `it()`; the canonical reproduction of the user-reported bug |
| T4 | regression: modifier-augmented arrow | `src/lib/` | NEW | Shift+Arrow, Cmd+Arrow during stale-state — confirm no duplicate, no premature flush |

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

The implementer **MUST** complete this before generating any code:

1. **Reproduce** the bug in `npm run tauri dev` on macOS WKWebView.
   Confirm exact trigger sequence and isolate whether the duplicate
   fires on:
   - period alone (after composition)
   - arrow alone (after composition without period)
   - period-then-arrow (full repro chain — the user's reported sequence)
2. **Instrument** `onCompositionEnd`, `docKeyDown` (both 229 and
   else-branches), and `docInput` with temporary `console.log` to
   capture the actual WKWebView event order across the trigger
   sequence. Note especially: whether `compositionend` fires at all
   on the period, and the relative ordering of `keydown` vs `input`
   vs `compositionend` for the arrow press.
3. **Select** the Shape B sub-variant based on the trace:
   - **B1 — non-terminating no-write**: in the `else-branch,
     non-terminating` case, do NOT write `composed`. Just sync state
     (clear overlay, set `isComposing := false`, bump `imeFlushGen`).
     Trust `onCompositionEnd` to write via invoke. Pick this if the
     trace shows `compositionend` reliably fires before the stale
     `docKeyDown` would re-emit.
   - **B2 — conditional write with onCompositionEnd guard**: write
     `composed` in the non-terminating case only when a per-keydown
     `compositionEndExpected` flag indicates `compositionend` will NOT
     fire afterward (the flag is set by `onCompositionEnd` itself or
     by an `imeFlushGen`-style sentinel). Pick this if the trace
     shows mixed orderings depending on the key.
   - **B3 — per-syllable dedup token**: keep the current write path
     but tag the payload with a syllable token; `onCompositionEnd`
     suppresses any tagged payload it sees second. Pick this only as
     a last resort — most invasive of the three.
4. **Remove** the instrumentation before merging. The temporary logs
   MUST NOT land on `dev`.

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
| Validation status | 3 | Phase 7 smoke-check passes; the harder validation (`tsc --noEmit` + Vitest) is intentionally deferred to the implementer per feature-lane spec; manual WKWebView repro is mandated as Constraint #6 |
| Plan coverage (Phase-1 goal → decomposition) | 4 | Each in-scope item maps to a node; success criteria 1–4 each map to a test or compile check; open questions Q1/Q2/Q3 are resolved or have an explicit handoff with three named sub-variants |
