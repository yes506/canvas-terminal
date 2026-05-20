# Implementation report — browser-zoom

(Prior `implementation-report.md` on `dev` documented
`drawer-resize-reclamp` and before that several feature cycles.
Overwritten with this local-lane report; historical content reachable
via `git log -- implementation-report.md`.)

## Source
- Planner marker: `local` (chat-only, same-session)
- Planner artifact: `task-85-claude1-updated-plan-v4.md` (collab-memory session-2526)
- Plan-confirm token: user typed `confirm plan` in chat after the v4 plan block
- Scale: local

## Work queue summary
- Total items: 9
- Completed: 9
- Blocked: 0

## Files changed

| File | Change | Net lines |
|---|---|---|
| `src/types/browser.ts` | Add `zoom: number` field to `Tab` | +2 |
| `src/stores/browserStore.ts` | `ZOOM_STEPS` ladder, `nextZoomStep`/`prevZoomStep`, `ZOOM_DEFAULT`, `setTabZoom` action, `selectActiveZoom`, `makeBlankTab` zoom default | +46 |
| `src/stores/browserStore.test.ts` (NEW) | Vitest cases for step helpers | +78 |
| `src/lib/browserIpc.ts` | `browserTabSetZoom` IPC wrapper | +9 |
| `src-tauri/src/commands/browser.rs` | `clamp_zoom` helper + Rust unit test + `browser_tab_set_zoom` command | +52 |
| `src-tauri/src/lib.rs` | Register `browser_tab_set_zoom` in `invoke_handler!` | +1 |
| `src-tauri/tauri.conf.json` | Bump `minimumSystemVersion` `10.15` → `11.0` | ±1 |
| `src/components/browser/ZoomControls.tsx` (NEW) | Three-button zoom group + IPC-first click handler | +109 |
| `src/components/browser/BrowserDrawer.tsx` | Add `drawerRef` on outer `<div>`, render `<ZoomControls />` after `<AddressBar />`, drawer-scoped capture-phase keydown handler with focus-inside-drawer guard | +60 |

## Validation
- Baseline exit (BASE_BRANCH HEAD `dev`): **0**
- Final validation command: `npm run build && npm test -- --run && cargo check --manifest-path src-tauri/Cargo.toml`
- Final exit: **0**
- Auto-fix attempts used: **0/3**
- Final test counts:
  - Vitest: **234 passed** (was 223 → +11 from new step-helper cases)
  - Cargo `--lib`: **38 passed** (was 37 → +1 `clamp_zoom_bounds`)
  - `cargo check`: 9 warnings, all pre-existing dead-code lints (no new warnings introduced)

## Per-item outcomes

| Item | Status | Files touched | Notes |
|---|---|---|---|
| q1 types-tab-zoom | completed | `src/types/browser.ts` | Mandatory field; forces every `Tab` literal to include it. |
| q2 store-helpers | completed | `src/stores/browserStore.ts` | `ZOOM_STEPS`/`ZOOM_DEFAULT` exported; helpers snap to nearest-bracketing-step. |
| q3 store-tests | completed | `src/stores/browserStore.test.ts` | Exact, floor, ceil, mid-step snap, absurd-input clamp. |
| q4 browser-ipc-wrapper | completed | `src/lib/browserIpc.ts` | Maps 1:1 to `browser_tab_set_zoom` Rust command. |
| q5 rust-zoom-cmd | completed | `src-tauri/src/commands/browser.rs` | Clamp `[0.25, 5.0]`; NaN collapses to 1.0; `webview.set_zoom(clamped)`. |
| q6 rust-register | completed | `src-tauri/src/lib.rs` | Registered in `invoke_handler!`. |
| q7 tauri-minver | completed | `src-tauri/tauri.conf.json` | macOS floor `11.0` (required for WKWebView `setPageZoom:`). |
| q8 zoom-controls | completed | `src/components/browser/ZoomControls.tsx` | IPC-first; "not created" silent no-op; other err → `setTabError`. |
| q9 browser-drawer-wiring | completed | `src/components/browser/BrowserDrawer.tsx` | `drawerRef` on outer `<div>`; `<ZoomControls />` after `<AddressBar />`; document-capture keydown handler with `stopPropagation` to preempt the existing window-bubble terminal-font handler at `useKeyboardShortcuts.ts:232-246` when focus is inside drawer chrome. |

## Plan-AC coverage

| AC | Status | Notes |
|---|---|---|
| 1 Zoom affects only page content; shell UI unchanged | covered | Rust `set_zoom` is per-tab WKWebView only; React DOM untouched. |
| 2 `http(s)://` and `localfile://` zoom alike | covered | `set_zoom` operates on the webview regardless of URL scheme. |
| 3 Per-tab isolation | covered | `Tab.zoom` is per-tab; each call carries a `tabId`. |
| 4 Tab-switch percent display tracks active tab | covered | `selectActiveZoom` reads from `activeTabId`. |
| 5 Reload + in-tab navigation preserve zoom | covered | Native sticky via wry `setPageZoom`. |
| 6 New blank tab renders at 100% | covered | `makeBlankTab` returns `zoom: ZOOM_DEFAULT = 1.0`. |
| 7 280px drawer remains usable | covered | Zoom buttons (~24px each) + `100%` label (~40px, tabular-nums) ≈ 88px after AddressBar; AddressBar (`flex:1; minWidth:0`) truncates rather than breaking. |
| 8 Build / tests / cargo check all pass; helper tests cover floor/ceil/mid-step | covered | See validation block; new test file exercises `nextZoomStep`/`prevZoomStep`. |
| 9 Shortcuts focus-scoped; terminal font preserved | covered | Capture-phase `document.addEventListener('keydown', ..., true)` + `drawerRef.contains(document.activeElement)` + `stopPropagation`. |
| 10 Drawer close→reopen preserves zoom | covered | Child webviews persist (`useBrowserLifecycle.ts:74`); zoom is OS-level sticky. |
| 11 Transient create-race no divergence | covered | IPC-first: `setTabZoom` only fires after `browserTabSetZoom` resolves OK. |
| 12 IPC failures surface via `setTabError` | covered | Click handler + keydown handler share the same error path. |
| 13 macOS <11 blocked at install | covered | `tauri.conf.json::minimumSystemVersion = "11.0"`. |

## Scope-discipline self-check
- [x] No new interfaces / files outside hints (only `ZoomControls.tsx`, `browserStore.test.ts` — both listed in plan v4)
- [x] No renames of committed public names
- [x] No signature changes on planner-committed methods
- [x] No edits to validation_command configuration
- [x] No edits to files outside the work queue's hint set (`NavControls.tsx` deliberately NOT touched per v4 §"Files NOT touched"; `useBrowserLifecycle.ts` deliberately NOT touched per v4 §"Files NOT touched")
- [x] No re-architecting or scale re-classification

## Reviewer "NOT adopted" items — confirmation kept

Both rejected pinpoints from earlier reviewer rounds remain unadopted:
- **Post-create apply hook** in `useBrowserLifecycle.ts` — IPC-first ordering eliminates the create-race divergence path; no behavioral need for the hook. Implementation matches v4.
- **Rust IPC returning clamped value** — TS-side `ZOOM_STEPS` always feeds in-range values; the Rust clamp is defense-in-depth (verified by `clamp_zoom_bounds` covering 0.25/5.0/NaN/INF/negative). Implementation matches v4.

## Notes for reviewers
- Native zoom (`Webview::set_zoom`) is sticky per-webview across navigation and reload, so no `browser-tab-loaded` re-apply hook was added. Verified at `~/.cargo/registry/.../wry-0.54.4/src/wkwebview/mod.rs:933-941` (`setPageZoom:`).
- Manual smoke (not run from this implementer, listed for the merge gate): `npm run tauri dev` → open browser drawer → navigate to a real page → `+` enlarges content, `−` shrinks, `100%` resets; reload preserves zoom; per-tab isolation by zooming on tab A and switching to tab B.

## Round-4 peer-review fold (post-impl)

All four reviewers (@claude2 task-97, @claude3 task-92-impl, @codex2
task-98, @codex3 task-99) ratified the code (13/13 ACs, plan-v4
file-by-file fidelity, no code-level blockers). All four flagged the
same merge-hygiene blocker:

**Dirty `package-lock.json`** in the worktree, version field synced
from 0.3.8 → 0.5.0 by the baseline `npm install` (because the prior
release cycle's `scripts/bump-version.sh` didn't re-sync the lockfile
on `dev`). Not part of any feature commit; would leave `dev` with a
stale lockfile post-merge and meant validation ran on a tree
different from the merge tree.

**Folded via commit `b845aa3`**: `chore(implementer): sync
package-lock.json to package.json 0.5.0` — 2-line metadata-only
diff, no behavioral impact. Worktree now clean. Re-validation against
the committed tree: `npm run build` ✓, vitest 234/234 ✓,
`cargo test --lib` 38/38 ✓.

Two **non-blocking** observations from @claude2 (task-97) explicitly
declined per CLAUDE.md "Don't add features, refactor, or introduce
abstractions beyond what the task requires":
1. Duplicated `applyZoom` logic across `ZoomControls` and
   `BrowserDrawer` keydown — below the abstraction-payoff threshold;
   two ~10-line copies are within tolerance.
2. Autorepeat keydown doesn't deduplicate in-flight IPCs — functionally
   idempotent (same value → same `set_zoom`); Chrome/Safari exhibit
   the same one-press-one-step model. Not coding around in v1.
