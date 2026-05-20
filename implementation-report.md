# Implementation report — drawer-resize-reclamp

(Prior `implementation-report.md` on `dev` documented
`frame-collision-clip` and before that `capture-fix-injection`.
Overwritten with this local-lane report; historical content reachable
via `git log -- implementation-report.md`.)

## Source

- **Planner marker**: `scale: local` (chat-only per CLAUDE.md)
- **Confirmation token**: `confirm plan` typed in this session after
  the v5 marker emit
- **Convergence**: 5 plan iterations (v1 → v5), 5 review rounds
  (rounds 11–14). v5 ratified by 4/4 reviewers in round 14 with one
  convergent guardrail folded in (browser drag sanitizer).
- **Cross-reference**: task-59 investigation report (origin of the
  resize-reclamp need); the round-11→14 plan iteration history is in
  tasks 64, 69, 74, 79 (planner reflections).

## Work-queue summary

- Total items: **4**
- Completed: **4**
- Blocked: **0**

## Files changed

```
 src/App.tsx                                  | ~45 lines (state + helper call + render path)
 src/components/browser/BrowserDrawer.tsx     | ~30 lines (prop rename + sanitizer + drop local clamp)
 src/lib/drawerLayout.ts                      | +74 lines (new resolveDrawerWidths helper + doc comment)
 src/lib/drawerLayout.test.ts                 | +124 lines (7 new tests for the helper)
 4 files changed, 274 insertions(+), 35 deletions(-)
```

(The 274/35 totals from `git diff --shortstat dev..HEAD` include the
comment blocks accompanying each change; the load-bearing logic is
~30-40 lines as predicted by v5.)

## Validation

- **Baseline exit** (worktree HEAD = `dev` at `c6bc25e`):
  `tsc --noEmit` = 0, `vitest run src/lib/drawerLayout.test.ts` =
  8/8 passing
- **Final validation command**: `cd <worktree> && npx tsc --noEmit && npx vitest run src/lib/drawerLayout.test.ts`
- **Final exit**: 0
- **Auto-fix attempts used**: **1 / 3** — one test assertion was
  using `.toBe(490)` against `Math.max(280, 0.35 * 1400)` which
  IEEE 754 produces as `489.99999999999994`. Fixed by switching to
  `.toBeCloseTo(490, 5)`. **Pure test bug**; the helper math is
  unchanged.
- Final test run: 15/15 passing (8 existing `clampDrawerWidth` + 7
  new `resolveDrawerWidths`).

## Per-item outcomes

| Item | Description | Status | File | Notes |
|---|---|---|---|---|
| 1 | Add `resolveDrawerWidths` helper | completed | `src/lib/drawerLayout.ts` | Pure function. Inputs: `canvasIntent`, `browserIntent`, `containerWidth`, `canvasOpen`, `browserOpen`, optional `canvasMin`/`browserMin`/`terminalMin`/`handleWidth`. Outputs: `{canvasEffective, browserEffective}`. Handle count computed internally from open flags × `handleWidth` (default 4). Sibling = OTHER drawer's INTENT (not effective) → order-independent. ~20 px asymmetric-allocation note in inline comment per @claude3 F1. |
| 2 | Add 7 unit tests for helper | completed | `src/lib/drawerLayout.test.ts` | normal / squeeze@800 / expand-back / null-fallback materialized / single-drawer / no-drawer / handle-width override. All pass after the one auto-fix. |
| 3 | App.tsx: state + helper call + render + drop DOM-write | completed | `src/App.tsx` | New `canvasIntent: number \| null` state. Drag handler updates intent (no DOM mutation). Resize handler measurement-only (just `setContainerWidth`). Materializes null → `Math.max(280, 0.35 * containerWidth)` inline before helper call. Canvas panel renders `"35%"` when `canvasIntent === null`, otherwise `canvasEffective`. Pass `browserEffectiveWidth` to BrowserDrawer (replaces `canvasDrawerWidth`). |
| 4 | BrowserDrawer.tsx: new prop + sanitizer + drop local clamp | completed | `src/components/browser/BrowserDrawer.tsx` | New `browserEffectiveWidth: number` prop (replaces `canvasDrawerWidth`). Drag handler drops sibling-aware clamp; adds self-aware sanitizer `Math.max(280, Math.min(containerWidth, proposed))` so absurd raw deltas don't leak to settings via `useBrowserTabsSettings`'s debounced persist. Removed unused `drawerWidth` selector (read happens via the prop now). |

## Scope-discipline self-check

- [x] No new interfaces / files outside the plan's hint set — same 4 files predicted by v5
- [x] No renames of committed public names — `clampDrawerWidth` and its signature are unchanged
- [x] No signature changes on planner-committed methods — `clampDrawerWidth` is additive (new helper is a composition)
- [x] No edits to `validation_command` configuration — `package.json`, `tsconfig.json` untouched
- [x] No edits to files outside the work queue's hint set — diff is exactly the 4 named files
- [x] BGRA → RGBA channel swap (capture.rs from prior runs) — untouched
- [x] Native capture command — untouched
- [x] Frame-collision `overflow-hidden` on terminal panel — untouched (still in place at App.tsx:158)
- [x] `clampDrawerWidth`'s "give up at selfMin when upperBound < selfMin" degraded mode — preserved (it's what makes the squeeze graceful)
- [x] No z-index changes
- [x] No `tauri.conf.json` `minWidth` change
- [x] No `package.json` / Cargo.toml / capability JSON changes

## Notes for the manual acceptance pass

`tsc --noEmit` + `vitest` validate types and helper math but **cannot exercise live layout** during window resize. The runtime AC is the only way to verify the user-visible UX change.

1. **AC §1 — reproduce the user's snapshot scenario**: open at 1400×900, drag canvas to ~490 and browser to ~600. Shrink window to 800 px. **Expect**: terminal panel ≥ ~48 px (visible strip); both drawers auto-shrunk to 280 (degraded mode); terminal absorbs the rest (~232 px after handle budget). Pre-fix: terminal at 0.
2. **AC §2 — no drag regression**: at 1400 px, drag each drawer in turn. **Expect**: drag stops at 280 px floor; no jitter; same feel as before this fix.
3. **AC §3 — resize back up (free UX win from intent/effective separation)**: after AC §1's shrink, expand window back to 1400. **Expect**: drawers automatically restore toward their original intents (canvas back to 490, browser back to 600). **No re-drag needed.** This was explicitly out-of-scope in v1; v3+ design makes it free.
4. **AC §4 — one drawer only**: open just the canvas drawer at 700 px. Shrink window past canvas+terminal threshold. **Expect**: canvas shrinks; terminal stays visible. Expand: canvas restores to 700.
5. **AC §5 — no drawer open**: shrink aggressively. Terminal fills available space. No regressions.
6. **AC §6 — rapid resize gesture**: drag window corner over 2-3 seconds. Drawer widths track smoothly without stutter or jump-oscillation. (Should pass for free under React batching.)
7. **AC §7 — persistence**: after AC §1's shrink, wait > 800 ms (the `useBrowserTabsSettings` debounce). Verify the persisted browser `drawerWidth` in settings storage **still reflects the user's intent (600)**, not the shrunk effective (280). Confirms the intent/effective separation prevents lossy persistence.
8. **AC §8 — toggle-during-resize**: close one drawer (e.g. canvas toggle off) → shrink window aggressively → re-open canvas. **Expect**: canvas drawer renders at its remembered intent value (or CSS `35%` if never dragged), not at a stale clamped value.
9. **AC §9 — drag at narrow window**: at minWidth=800, with canvas intent=490, attempt to drag browser drawer wider. **Expect**: drag tracks cursor up to the helper's effective max; no visible snap-back; terminal stays at ≥ 48 px throughout. Confirms the (A) option works in practice (drop local drag clamp + render-time effective).
10. **AC §10 — sanitizer (drag past window edge)**: at any window size, drag the browser handle past the left edge of the application window (so cursor goes "outside"). After releasing the drag, inspect the persisted `drawerWidth` in settings: it must be **≥ 280** (not 0 or negative). Confirms the `Math.max(280, ...)` sanitizer prevents nonsense persistence.

## Process note — final iteration in the 14-round arc

This commit closes the four-layer arc that started with the original
`Capture Full Window` bug:

1. **L1 architecture** (caught by planning rounds): html2canvas can't see Tauri webviews → `native-window-capture` (impl-local, `3da8c54`).
2. **L2 IPC** (caught by Tauri-source reads): `WebviewWindow` arg-injector fails under multi-webview → `capture-fix-injection` (impl-micro, `2503e08`).
3. **L3 live UI paint** (caught by user runtime AC): terminal panel missing panel-level clip → `frame-collision-clip` (impl-micro, `c6bc25e`).
4. **L4 live UI layout reflow** (caught by user runtime AC): stale drag widths persist through resize → `drawer-resize-reclamp` (impl-local, this commit).

Each layer had a distinct failure mode and surfaced from a distinct
verification surface. The vault's `observation-20260502-v4-verification-pattern`
maps cleanly: build-sanity gates catch architecture and types;
manual AC catches IPC injection and layout behavior; runtime use
catches each remaining layer.

Also worth pinning: **convergent reviewer signal repeatedly simplified
the design over rounds 11→14**. Drop C1 sub-floor (round 11). Adopt
intent/effective separation (round 11). Extract pure helper (round 12).
Drop local drag clamp (round 13). Add sanitizer (round 14). Each
removal made the plan smaller and the invariant cleaner. **Pattern
worth pinning for future planners**: when 3+ of 4 reviewers'
concerns converge on the architecture's *shape* (not just edge
cases), treat it as a redesign signal, not five orthogonal refinements.
