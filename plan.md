# Feature plan — browser-tabs

> Supersedes the prior `browser-drawer` cycle plan (preserved in git
> history at commits `8d92453`, `d439f0a`, `3a57d55`). This cycle adds
> multi-tab support and fixes link-navigation + live-resize regressions
> on top of the merged browser-drawer baseline.

## Goal

Repair the built-in browser drawer in canvas-terminal: fix link-click
navigation (B1), confirm/ensure live resize of webview content with the
drawer/window (F1), and add Chrome-like multi-tab support inside the
drawer (F2).

## In scope

- **B1** — Diagnose and fix all-link-clicks-broken inside the embedded child webview.
- **F1** — Confirm + ensure webview live-resizes with drawer separator and window edge dragging.
- **F2** — Multi-tab strip with manual `+` button (max 10 tabs), per-tab Chrome-like state, last-tab-close keeps one blank tab.

## Out of scope

- `target="_blank"` / `window.open` spawning new in-app tabs.
- Middle-click / Cmd+click new-tab.
- Persistence of tab list across app restarts.
- Tab drag-reordering, thumbnails, pinning, favicons.
- Bookmarks, history, downloads (already deferred in prior browser-drawer scope).

## Constraints

- Tauri 2 + `macos-private-api` child webview model (`Window::add_child`) — unchanged.
- Each child webview needs a UNIQUE label (Tauri rejects duplicates); per-tab label scheme `browser-tab-<uuid>` required.
- Existing race-condition fixes (close-during-create generation tracking, settings-restore race, listener cleanup, in-flight op chain) must be preserved or replicated PER TAB.
- macOS title-bar offset compensation must continue to apply to whichever tab is active.
- Capability config scopes to `windows: [main]`; multi-tab does not change this.
- Tauri config CSP applies only to the Tauri-served frontend, not the child browser webview.

## Success criteria

- **SC1** — On any http/https page, clicking an in-page link navigates the webview.
- **SC2** — Dragging the drawer separator or the OS window edge resizes the active webview live; its content reflows.
- **SC3** — Click `+` opens a new about:blank tab and switches to it; switching tabs preserves each tab's URL/history; closing a tab destroys its webview; closing the last tab leaves one blank tab open; no leaked webviews; all prior single-tab race guarantees still hold per tab.
- **SC4** — Tab count is capped at 10; the `+` button is disabled at the cap.

## Resolved open questions (from Phase 1)

- **Q1** — Last-tab-close: keep one blank tab open (drawer stays open).
- **Q2** — Max tabs: 10.
- **Q3** — New-tab default URL: `about:blank`.
- **Q4** — Per-tab state model: Chrome-like — each tab owns url/title/loading/error/history; URL bar + nav buttons + drawer title reflect the active tab only.

## Open investigations (not blockers — resolved during implementation)

- **B1 root cause** — Four hypotheses (target=_blank new-window event unhandled / validator false-reject / bounds drift / DOM click intercept). First step is reproduction in dev with diagnostic logging in `on_navigation`. See `bug_investigations` in `.planner-state.json`.

## Package layout

No new packages introduced. The feature lives entirely in existing
locations:

```
src/
├── components/browser/
│   ├── AddressBar.tsx           (modified)
│   ├── BrowserDrawer.tsx        (modified)
│   ├── NavControls.tsx          (modified)
│   ├── PageAreaHost.tsx         (unchanged)
│   ├── TabStrip.tsx             (NEW)
│   ├── useBrowserBounds.ts      (modified → useBrowserTabsBounds)
│   └── useBrowserLifecycle.ts   (modified → useBrowserTabsLifecycle)
├── lib/browserIpc.ts            (modified — per-tab wrappers)
├── stores/browserStore.ts       (modified — tabs slice)
└── types/browser.ts             (modified — Tab + BrowserTabsState)

src-tauri/src/
├── commands/browser.rs          (modified — 9 per-tab commands)
├── lib.rs                       (modified — handler registration + RunEvent::Exit)
└── state.rs                     (modified — BrowserSlot → HashMap<TabId, BrowserSlot>)
```

Only new file: `src/components/browser/TabStrip.tsx`.

## Decomposition

| # | Stage | Interface | Method | Belongs to | Notes |
|---|---|---|---|---|---|
| 1 | Reserve per-tab create slot | `BrowserTabsState` | `try_reserve_for_create(tab_id) -> CreateGuard` | `src-tauri/src/state.rs` | per-tab CreateGuard with generation tracking |
| 2 | Look up tab webview | `BrowserTabsState` | `clone_tab(tab_id)`, `take_tab(tab_id)` | `src-tauri/src/state.rs` | mirrors current `clone_webview` / `take_webview` |
| 3 | Build webview label | `BrowserTabsState` | `label_for(tab_id) -> String` | `src-tauri/src/state.rs` | `browser-tab-<uuid>` |
| 4 | Create webview per tab | `BrowserTabCommands` | `create_browser_tab(tab_id, url, rect)` | `src-tauri/src/commands/browser.rs` | wires `on_navigation` / `on_page_load` / `on_document_title_changed`; emits per-tab events |
| 5 | Set tab bounds | `BrowserTabCommands` | `set_browser_tab_bounds(tab_id, rect, visible)` | `src-tauri/src/commands/browser.rs` | `visible=false` → off-screen position |
| 6 | Navigate a tab | `BrowserTabCommands` | `navigate_browser_tab(tab_id, url)` | `src-tauri/src/commands/browser.rs` | re-validates URL |
| 7 | Tab history nav | `BrowserTabCommands` | `browser_tab_go_back / go_forward / reload / stop(tab_id)` | `src-tauri/src/commands/browser.rs` | 4 methods, identical shape |
| 8 | Destroy single tab | `BrowserTabCommands` | `destroy_browser_tab(tab_id)` | `src-tauri/src/commands/browser.rs` | idempotent |
| 9 | Destroy all tabs | `BrowserTabCommands` | `destroy_all_browser_tabs()` | `src-tauri/src/commands/browser.rs` | called from drawer-close + `RunEvent::Exit` |
| 10 | Emit per-tab nav events | helper | `emit_tab_event(tab_id, kind, payload)` | `src-tauri/src/commands/browser.rs` | payload includes `tab_id` |
| 11 | **Repair link-click nav (B1)** | investigation node | TBD — fix lives in `create_browser_tab` (likely `on_navigation` closure or a new-window handler) | `src-tauri/src/commands/browser.rs` | hypotheses in `.planner-state.json::bug_investigations[B1]` |
| 12 | Tab-aware bounds sync | `useBrowserTabsBounds` | `useBrowserTabsBounds(hostRef, enabled)` — replaces `useBrowserBounds` | `src/components/browser/useBrowserBounds.ts` | active visible, others off-screen |
| 13 | **Verify live resize (F1)** | `useBrowserTabsBounds` | verification gate against ResizeObserver firing during drag | `src/components/browser/useBrowserBounds.ts` | see `verification_plans[F1]` |
| 14 | New TS types | (type definitions) | `Tab`, `BrowserTabsState` | `src/types/browser.ts` | `Tab = {id, url, title, isLoading, error}` |
| 15 | TS IPC wrappers | `BrowserTabsIpc` | `createBrowserTab / setBrowserTabBounds / navigateBrowserTab / browserTab{GoBack,GoForward,Reload,Stop} / destroyBrowserTab / destroyAllBrowserTabs` | `src/lib/browserIpc.ts` | replaces old single-webview wrappers |
| 16 | Zustand tabs slice | `BrowserStore` | shape `{drawerOpen, drawerWidth, tabs: Tab[], activeTabId}` + selectors | `src/stores/browserStore.ts` | replaces single `currentUrl / pageTitle / isLoading / error` |
| 17 | `newTab` | `BrowserStore` | `newTab()` | `src/stores/browserStore.ts` | enforce ≤ 10 cap; push blank Tab; set active |
| 18 | `closeTab` | `BrowserStore` | `closeTab(id)` | `src/stores/browserStore.ts` | last-tab-close → replace with one blank |
| 19 | `setActiveTab` | `BrowserStore` | `setActiveTab(id)` | `src/stores/browserStore.ts` | triggers bounds re-sync |
| 20 | Per-tab field setters | `BrowserStore` | `setTabUrl / setTabTitle / setTabLoading / setTabError` | `src/stores/browserStore.ts` | called by `browser-tab-*` event handlers |
| 21 | Tab strip UI | `TabStrip` | `TabStrip()` | `src/components/browser/TabStrip.tsx` (NEW) | tab buttons + close × + `+` (disabled at 10) |
| 22 | Drawer chrome integration | `BrowserDrawer` | mounts `TabStrip` above existing Row 2; chrome title = `activeTitle` | `src/components/browser/BrowserDrawer.tsx` | layout: Row 0 TabStrip / Row 1 title / Row 2 nav+addr / Body Host |
| 23 | Per-tab lifecycle | `useBrowserTabsLifecycle` | per-tab create-on-add / destroy-on-remove; nav event routing by `tab_id` | `src/components/browser/useBrowserLifecycle.ts` | replaces `useBrowserLifecycle`; preserves race-fix invariants per tab |
| 24 | Nav controls → active tab | `NavControls` | onClick handlers use `activeTabId` + per-tab IPC | `src/components/browser/NavControls.tsx` | small change |
| 25 | Address bar → active tab | `AddressBar` | onSubmit uses `activeTabId` + `navigateBrowserTab` | `src/components/browser/AddressBar.tsx` | small change |
| 26 | Handler registration | (binding) | register 9 new commands; remove 8 old single-webview commands | `src-tauri/src/lib.rs` | inside `tauri::generate_handler!` |
| 27 | App-quit cleanup | (binding) | `RunEvent::Exit` calls `destroy_all_browser_tabs_impl` | `src-tauri/src/lib.rs` | replaces `destroy_browser_webview_impl` |

### Cohesion grouping

- **`BrowserTabsState`** (#1–#3) — share Rust state (`HashMap<TabId, BrowserSlot<R>>`) and lifecycle (Empty→Creating→Ready per slot).
- **`BrowserTabCommands`** (#4–#10) — share collaboration boundary (`tauri::generate_handler!`) and failure domain (all need `BrowserTabsState`).
- **`BrowserStore` actions** (#16–#20) — share state (tabs slice) and lifecycle.
- **`useBrowserTabsLifecycle`** (#23) — orchestrates per-tab create/destroy + event subscription with race-fix invariants.
- **`useBrowserTabsBounds`** (#12, #13) — observes host rect, dispatches active-tab visible / inactive hidden.

### Cross-boundary contracts

Yes — the 9 new Tauri commands (#4–#10) are TS↔Rust IPC contracts. Per
feature-lane spec, skeleton emission is optional and was **skipped** at
user direction. The IPC shapes are documented in this plan and will live
in `src/lib/browserIpc.ts` and `src-tauri/src/commands/browser.rs` upon
implementation.

## Dependency direction

```
Rust state (1-3)
  -> Rust commands (4-10)
  -> handler registration (26, 27)

Rust commands (4-10)
  -> TS IPC wrappers (15)
  -> TS hooks (12, 23)
  -> React UI (21, 22, 24, 25)

TS types (14)
  -> TS store (16-20)
  -> React UI + hooks
```

One-way fan-out. No cycles. See `plan.mmd` (Mermaid `graph LR`) for the
inter-interface DAG.

## Interfaces emitted

N/A — feature lane, skeletons skipped at user direction. The 10 interfaces
above are described in this plan and exist as cohesion groupings, not as
emitted source files at this phase.

## Validation

Smoke-check (Phase 7, feature-lane skeletons-skipped path):

- `plan.md` non-empty with required headers (`## Goal`, `## Package layout`, `## Decomposition`). ✅
- `plan.mmd` parses as valid Mermaid (`head -1` returns `graph`). ✅
- DAG is acyclic (verified by inspection — strict fan-out from Rust state to React UI). ✅

Full compile validation (`tsc --noEmit` + `cargo check --manifest-path src-tauri/Cargo.toml`)
is gated to the implementation phase — out of scope for the planner.

## Rubric (Phase 7 — 4-criterion feature-lane variant)

| Criterion | Score | Notes |
|---|---|---|
| Decomposition completeness | 4 | Every E2E stage from Phase 1 has a method node; B1 and F1 are first-class nodes (#11, #13). |
| Dependency direction | 4 | Acyclic: Rust state → Rust commands → TS IPC → TS store → React UI + hooks. |
| Validation status | 3 | Smoke-check only (no skeletons emitted). Full `tsc` + `cargo check` runs at implementation time. |
| Plan coverage | 4 | Every Phase-1 in-scope item (B1, F1, F2) has dedicated decomposition nodes; every interface traces back to a feature. |

Total: **15 / 16**.

## Reviewer checklist

Please verify each before typing `confirm plan`:

- [ ] The decomposition table covers every Phase-1 in-scope item (B1, F1, F2).
- [ ] No interface looks like a grab-bag of unrelated methods (cohesion test passes).
- [ ] `plan.mmd` (Mermaid `graph LR`) is acyclic.
- [ ] Out-of-scope items are correctly excluded (target=_blank, middle-click, persistence, etc.).
- [ ] The resolved Q1–Q4 answers reflect what you actually want.
- [ ] B1 hypothesis list is reasonable; you're OK with the investigate-then-fix approach (root cause TBD until reproduction).

Below-bar comments (REQUIRED if any box unchecked):
