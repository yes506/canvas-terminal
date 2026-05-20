# Implementation report — frame-collision-clip

(Prior `implementation-report.md` on `dev` documented
`capture-fix-injection` and before that `native-window-capture`.
Overwritten with this micro-lane report; historical content reachable
via `git log -- implementation-report.md`.)

## Source

- **Planner marker**: `scale: micro` (chat-only per CLAUDE.md; no
  commit-based marker for micro lane)
- **Confirmation token**: `confirm plan` typed in this session after
  the v2 marker emit
- **Convergence**: 1 planning round + 1 review round; v2 plan ratified
  by 4/4 reviewers in round 9
- **Cross-reference**: task-48 investigation report names this as the
  long-deferred live-UI cousin of @claude2's round-1 Concern #1 on
  `native-window-capture` (the capture-side artifact landed at
  `3da8c54`; this is the matching real-UI fix)

## Work-queue summary

- Total items: **1**
- Completed: **1**
- Blocked: **0**

## Files changed

```
 src/App.tsx | 9 ++++++++-
 1 file changed, 7 insertions(+), 2 deletions(-)
```

Single file, 7-line insertion (1 Tailwind class + 5-line preserve-
comment + closing-bracket newline), 2-line deletion (the prior
single-line comment + the prior className line).

## Validation

- **Baseline exit** (worktree HEAD = `dev` at `2503e08`):
  `npx tsc --noEmit` = 0
- **Final validation command**: `cd <worktree> && npx tsc --noEmit`
- **Final exit**: 0
- **Auto-fix attempts used**: **0 / 3** (validation passed on first
  attempt; no type-surface change)
- Tail of final tsc run: no output (clean compile)

The `cargo check` Rust validation is **not relevant** for this lane —
the change is TypeScript only, the `Cargo.toml` build manifest lives
under `src-tauri/` (a subdirectory, not a root build file), and the
project's primary root build manifest is `tsconfig.json`.

## Per-item outcomes

| Item | Description | Status | File | Notes |
|---|---|---|---|---|
| 1 | Add `overflow-hidden` to terminal panel container's className + insert 5-line preserve-comment | completed | `src/App.tsx` | Tailwind class lands inline at L158 (was L152 pre-change); preserve-comment names the canvas/browser-drawer parallel + the `clampDrawerWidth` degraded-mode condition that triggers the collision. Future contributors should not strip the class as "surplus". |

## Scope-discipline self-check

- [x] No new interfaces / files outside the plan's hint set — only `src/App.tsx` touched
- [x] No renames of committed public names — only one Tailwind class added to existing JSX
- [x] No signature changes on planner-committed methods — no methods involved (CSS-class change only)
- [x] No edits to `validation_command` configuration — `package.json`, `tsconfig.json`, build scripts all untouched
- [x] No edits to files outside the work queue's hint set — exactly one file
- [x] BGRA → RGBA channel swap (capture.rs from prior `impl-local`) — untouched
- [x] Native capture permission flow — untouched
- [x] `WebglAddon(false)` in terminalManager.ts — untouched
- [x] `clampDrawerWidth` math — untouched (intentional degraded mode per task-48 §"Why the clamp math is not in scope")
- [x] `TerminalTabs.tsx` — untouched (Option B explicitly deferred; tab-bar `overflow-hidden` would clip the drag preview which is `position: absolute` inside the bar)
- [x] No z-index changes — z-stack is correct; the bug was about clipping, not stacking
- [x] No `BrowserDrawer.tsx` changes — already clips at its panel box
- [x] No `package.json` / `tauri.conf.json` / capability JSON changes

## Notes for the manual acceptance pass

`tsc --noEmit` validates types but cannot exercise layout behavior.
Required runtime checks (full text in the v2 plan + task-48 report):

1. **AC §1**: Shrink window to ~580 px with both drawers open at
   min-widths. Terminal panel collapses; **no terminal tabs render
   visibly inside the browser-drawer column**.
2. **AC §2**: Open 3+ terminal tabs and repeat AC §1. Tabs visible
   only within the terminal panel.
3. **AC §3 — drag affordances (three sub-conditions)**:
   - (i) Insertion indicators at tab boundaries (lines 252/291)
     render as full 1-px accent lines, not bisected.
   - (ii) Floating drag preview (line 316+) follows the cursor
     **without clipping** while the cursor is inside the terminal
     panel.
   - (iii) When the cursor crosses into the browser-drawer column,
     the preview is **expected to clip** at the panel edge. This is
     Option A intended behavior — verify the drag still **completes
     correctly** (releases at the cursor position; tab reorders). If
     product finds the clip intrusive, the follow-up is a **React
     portal to `document.body`** for the preview, NOT removing the
     panel-level `overflow-hidden`.
4. **AC §4 — regression check (not the primary capture fix; that
   landed at `3da8c54`)**: Re-test Capture Full Window. The native
   capture sees what the user sees, so the live-UI fix reflects in
   screenshots automatically.
5. **AC §5 — recovery from squeeze**: Shrink window to ~580 px, then
   **expand back to 1200 px**. Terminal panel recovers to full width
   with no stuck-clipping artifact. Confirms `overflow-hidden` ×
   `flex-shrink-0` siblings interact cleanly.

## Residual-risk note (per @codex2; out of scope)

If a user reports terminal tabs overlapping with **in-bar controls**
(`CollaboratorButton` / `BrowserToggleButton` at the right of the tab
bar), the App-level clip alone won't catch that — those buttons live
inside the tab bar, so overflow within the bar would still paint over
them. That would require Option B (clipping the tab bar) PLUS a portal
for the drag preview — a separate `local` ticket if the AC reveals it.

## Process note

This is the third micro/local fix in the chain
(native-window-capture → capture-fix-injection → frame-collision-clip).
Each surfaced a different failure mode in the same `Capture Full
Window` / panel-layout area:
- `native-window-capture`: html2canvas can't see Tauri webviews.
- `capture-fix-injection`: Tauri `WebviewWindow` arg-injector fails
  under multi-webview layout.
- `frame-collision-clip`: terminal panel lacks panel-level clip.

The first two were caught by code review + Tauri-source reads; this
one needed user runtime AC. Each verification layer has a distinct
failure mode — this pattern is the vault's
`observation-20260502-v4-verification-pattern` working as designed.
