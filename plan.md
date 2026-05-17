# Feature plan — browser-tabs

> Supersedes the prior `browser-drawer` cycle plan (preserved in git
> history at commits `8d92453`, `d439f0a`, `3a57d55`). This cycle adds
> multi-tab support and fixes link-navigation + live-resize regressions
> on top of the merged browser-drawer baseline.

## Revision history

- **r1** (`a718491`) — Initial Phase 7 artifacts (browser-tabs decomposition).
- **r2** (`7cac8da`) — Cohort-feedback patch. Convergent issues addressed:
  stale `plan-detail.mmd` removed (claude2/codex2/claude3/codex3); settings
  restore + persistence decomposed into a new `BrowserTabsSettings` hook
  (claude3/codex3); dependency-direction prose aligned to mmd arrows
  (all 4); `last_bounds` / `generation` granularity pinned (claude2 M1);
  B1 H1 fix path scope clarified vs out-of-scope (claude2 M2); drawer-close
  wipes-all-tabs invariant made explicit (claude2 M3); event-rename intent
  stated explicitly (claude3 #5); B1 verification target tightened (codex2 #3);
  active-tab switch flicker guard noted (claude2 S4); UUID source picked
  (claude2 S2); `browser_last_url` semantics defined (claude2 S3).
- **r3** (`947d88e`) — r2 cohort-feedback polish. Convergent minor items:
  added `BrowserDrawer → NavControls/AddressBar` edges to plan.mmd
  (claude2 P1 + claude3 N1); corrected edge count 17→20 + relabeled
  toposort to strict longest-path (claude3 N2 + claude2 P2); inlined B1
  hypotheses + verification targets + investigation steps into plan.md
  so it's self-contained for the downstream gate (codex3 #1 + codex2
  note). Individual items: pinned BrowserTabsSettings file decision to
  co-locate in `useBrowserLifecycle.ts` (codex3 #2); resolved
  Rust/TS name collision by keeping TS shape as `BrowserState`
  (extended), Rust owns `BrowserTabsState` exclusively (claude2 P3a);
  added `Tab` history-lives-in-OS-layer note (claude2 P3b); rephrased
  row #30 to remove "per-tab keyed by tab_id but scoped to first tab"
  tension (claude3 N3).
- **r4** (`2735ed7`) — r3 polish tail. Two residual nits closed:
  package-layout block now says `Tab + BrowserState [extended]` to
  match the r3 name-collision fix (claude3 N4 + codex2 nit, 2-way
  convergent); dependency-direction prose now names both
  `BrowserStore` (L2) and `BrowserTabsState` (L4) as sinks rather
  than calling only `BrowserTabsState` the "single ultimate sink"
  (codex3 low).
- **post-merge amendment** (this commit, recorded after the merged
  `(plan-feature, human-confirmed)` gate) — **spec change**
  authorized via the local-lane planner cycle (chat-only
  `(plan-local, human-confirmed)` marker, conversation transcript
  in `~/.cache/canvas-terminal/collab-memory/session-1844/`): the
  **"Drawer-close wipes all tabs"** Constraint below is superseded.
  New behavior: drawer-close HIDES every tab webview off-screen via
  `setBrowserTabBounds(tabId, _, visible=false)` and preserves the
  tabs slice + active-tab id; per-tab page state (URL, scroll,
  forms, history) is retained for the next drawer-open within the
  same app session. Full destroy of every tab now happens only on
  `RunEvent::Exit` (app quit) and `WindowEvent::Destroyed`
  (macOS red-traffic-light close). App-restart persistence remains
  out of scope: on next cold start, `useBrowserTabsSettings` seeds
  one fresh first tab from `browser_last_url`. Bounds IPCs are
  serialized per-tab via `enqueueBoundsOp` to eliminate the tokio-
  worker hide/show ordering race (2-way convergent r6 finding).

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

- **Spawning a new in-app tab** from `target="_blank"` / `window.open`. (See B1-scope-clarification below — wiring a new-window handler that *routes the click to the active tab's navigate* OR *no-ops with a warning event* is the in-scope fix path for H1; spawning a fresh in-app tab is what stays out.)
- Middle-click / Cmd+click new-tab.
- Persistence of the *tab list* across app restarts. (Single-URL persistence via `browser_last_url` is preserved — see Constraints below.)
- Tab drag-reordering, thumbnails, pinning, favicons.
- Bookmarks, history, downloads (already deferred in prior browser-drawer scope).

## Constraints

- Tauri 2 + `macos-private-api` child webview model (`Window::add_child`) — unchanged.
- Each child webview needs a UNIQUE label (Tauri rejects duplicates); per-tab label scheme `browser-tab-<uuid>` required.
- **Tab IDs are generated via `crypto.randomUUID()`** on the frontend (no new dependency required; available in Tauri's WebView2/WKWebView). Same string is used as the Rust webview label suffix.
- Existing race-condition fixes (close-during-create generation tracking, settings-restore race, listener cleanup, in-flight op chain) must be preserved or replicated PER TAB.
- **Rust state granularity**: `BrowserTabsState` holds `tabs: Mutex<HashMap<TabId, BrowserSlot<R>>>`; `last_bounds: Mutex<HashMap<TabId, Rect>>` (per-tab — singleton would thrash on every active-tab switch); `generation: AtomicU64` stays **global monotonic** (each tab's `CreateGuard` captures its slot generation independently from a shared counter).
- ~~**Drawer-close wipes all tabs**: closing the drawer (Cmd+Shift+B or X button) calls `destroy_all_browser_tabs` and clears the tabs slice. Reopen creates a fresh blank tab seeded from `browser_last_url` (or `about:blank`). State preservation across drawer-close is **out of scope** for this cycle.~~ **— SUPERSEDED by post-merge amendment (see Revision history).** Current behavior: drawer-close HIDES each tab webview off-screen and preserves the tabs slice; full destroy only on app-quit / window-destroy. Cold-start still seeds one fresh tab from `browser_last_url`.
- **`browser_last_url` persistence semantics under multi-tab**: only the **active tab's URL** is persisted (debounced 800ms), and only when it is not `about:blank`. On next drawer-open, the **first tab** is seeded with the persisted URL.
- **Event surface migration**: all old singleton events (`browser-loading`, `browser-loaded`, `browser-title-changed`, `browser-error`) are **removed and replaced** with `browser-tab-loading / -loaded / -title-changed / -error`, each carrying `{ tab_id, ...payload }`. No parallel deprecation period — frontend subscribers update in lockstep with the Rust emitter rename.
- macOS title-bar offset compensation must continue to apply to whichever tab is active.
- Capability config scopes to `windows: [main]`; multi-tab does not change this.
- Tauri config CSP applies only to the Tauri-served frontend, not the child browser webview.

### B1 scope clarification (cohort M2)

`bug_investigations[B1].H1` proposes wiring a new-window event handler.
That handler is **in scope** *only if* it forwards the requested URL to
the **active tab's** `navigate` OR no-ops + emits a warning event.
Spawning a brand-new in-app tab from `target="_blank"` is **out of
scope** for this cycle. The plan keeps H1 as a candidate root cause for
"all link clicks broken" without expanding feature scope.

## Success criteria

- **SC1** — On any http/https page, clicking an in-page link navigates the webview.
- **SC2** — Dragging the drawer separator or the OS window edge resizes the active webview live; its content reflows.
- **SC3** — Click `+` opens a new about:blank tab and switches to it; switching tabs preserves each tab's URL/history; closing a tab destroys its webview; closing the last tab leaves one blank tab open; no leaked webviews; all prior single-tab race guarantees still hold per tab.
- **SC4** — Tab count is capped at 10; the `+` button is disabled at the cap.
- **SC5** — Settings restore + persistence: on cold start, the **first tab** is seeded with the persisted `browser_last_url`; the drawer width is restored; thereafter the active tab's non-blank URL and the drawer width are persisted with the existing 800ms debounce.

## Resolved open questions (from Phase 1)

- **Q1** — Last-tab-close: keep one blank tab open (drawer stays open).
- **Q2** — Max tabs: 10.
- **Q3** — New-tab default URL: `about:blank`.
- **Q4** — Per-tab state model: Chrome-like — each tab owns url/title/loading/error/history; URL bar + nav buttons + drawer title reflect the active tab only.

## Open investigations (not blockers — resolved during implementation)

### B1 — All link clicks broken inside child webview

**Hypotheses** (root cause TBD until reproduction):

- **H1** — `target="_blank"` / `window.open` links fire a new-window
  request that the WebviewBuilder does not currently subscribe to; the
  click silently no-ops. Fix path (in-scope per the B1-scope-
  clarification below): wire a new-window handler that **routes the
  requested URL to the active tab's `navigate`**, OR **no-ops and emits
  a warning event**. Spawning a brand-new in-app tab from this handler
  is **out of scope**.
- **H2** — `on_navigation` returning `false` on URLs the validator
  rejects (e.g. `mailto:`, `tel:`, scheme-less forms WebKit forwards).
  Fix: enumerate URL shapes Tauri actually delivers; route
  `mailto:`/`tel:` via the existing `open_external_url` command;
  tighten or relax the validator with a rationale comment that mirrors
  the TS-side `classifyScheme`.
- **H3** — z-order / bounds drift causes link-area clicks to miss the
  OS-layer webview's bounds (titlebar offset miscompensation, scale
  factor change, fullscreen toggle). Fix: confirm visually with a
  temporary diagnostic overlay; correct the offset path in
  `compute_macos_titlebar_offset` if drifted.
- **H4** — DOM-layer click handler intercepts events before they reach
  the OS-layer webview. Implausible since the child webview is OS-layer
  not DOM, but verify if H3 turns out not to be the cause.

**Verification targets** (must hit both during repro):

- `https://en.wikipedia.org/wiki/Main_Page` — many in-page same-window
  links of varied shapes (positive test for SC1).
- `https://github.com` — many `target="_blank"` links (no-regression
  boundary; H1 fix path must not spawn new in-app tabs).

**Investigation steps:**

1. Reproduce: open drawer, load Wikipedia, click an in-page link;
   observe `browser-tab-loading` / `-loaded` / `-title-changed` /
   `-error` events in the dev console.
2. Add a temporary `println!` in the `on_navigation` closure to log
   every `nav_url` and the validator outcome.
3. If `on_navigation` never fires for the click → H1; add new-window
   handling per the scope clarification.
4. If it fires but returns `false` → H2; relax the validator for the
   specific shape with a one-line rationale.
5. Smoke-test GitHub for no-regression: `target="_blank"` link clicks
   should follow the B1 scope clarification semantics.
6. Land the minimum fix; keep diagnostic logs gated behind
   `#[cfg(debug_assertions)]` so they don't leak into release builds.

## Package layout

No new packages introduced. The feature lives entirely in existing
locations:

```
src/
├── components/browser/
│   ├── AddressBar.tsx              (modified)
│   ├── BrowserDrawer.tsx           (modified)
│   ├── NavControls.tsx             (modified)
│   ├── PageAreaHost.tsx            (unchanged)
│   ├── TabStrip.tsx                (NEW)
│   ├── useBrowserBounds.ts         (modified → useBrowserTabsBounds)
│   └── useBrowserLifecycle.ts      (modified → useBrowserTabsLifecycle
│                                    + co-located BrowserTabsSettings sub-hook
│                                    — single file, no new file beyond TabStrip.tsx)
├── lib/browserIpc.ts               (modified — per-tab wrappers; preserves setBrowserSettings)
├── stores/browserStore.ts          (modified — tabs slice)
└── types/browser.ts                (modified — Tab + BrowserState [extended])

src-tauri/src/
├── commands/browser.rs             (modified — 9 per-tab commands; per-tab event emitters)
├── lib.rs                          (modified — handler registration + RunEvent::Exit)
└── state.rs                        (modified — singleton → HashMap<TabId, BrowserSlot> + per-tab last_bounds)
```

Only new file: `src/components/browser/TabStrip.tsx`.

## Decomposition

| # | Stage | Interface | Method | Belongs to | Notes |
|---|---|---|---|---|---|
| 1 | Reserve per-tab create slot | `BrowserTabsState` | `try_reserve_for_create(tab_id) -> CreateGuard` | `src-tauri/src/state.rs` | per-tab CreateGuard with generation tracking from a shared `AtomicU64` |
| 2 | Look up tab webview | `BrowserTabsState` | `clone_tab(tab_id)`, `take_tab(tab_id)` | `src-tauri/src/state.rs` | mirrors current `clone_webview` / `take_webview` |
| 3 | Build webview label | `BrowserTabsState` | `label_for(tab_id) -> String` | `src-tauri/src/state.rs` | `browser-tab-<uuid>` |
| 4 | Create webview per tab | `BrowserTabCommands` | `create_browser_tab(tab_id, url, rect)` | `src-tauri/src/commands/browser.rs` | wires `on_navigation` / `on_page_load` / `on_document_title_changed` (+ new-window handler per B1 scope clarification); emits per-tab events |
| 5 | Set tab bounds | `BrowserTabCommands` | `set_browser_tab_bounds(tab_id, rect, visible)` | `src-tauri/src/commands/browser.rs` | `visible=false` → off-screen position; per-tab `last_bounds` dedup |
| 6 | Navigate a tab | `BrowserTabCommands` | `navigate_browser_tab(tab_id, url)` | `src-tauri/src/commands/browser.rs` | re-validates URL |
| 7 | Tab history nav | `BrowserTabCommands` | `browser_tab_go_back / go_forward / reload / stop(tab_id)` | `src-tauri/src/commands/browser.rs` | 4 methods, identical shape |
| 8 | Destroy single tab | `BrowserTabCommands` | `destroy_browser_tab(tab_id)` | `src-tauri/src/commands/browser.rs` | idempotent; clears per-tab `last_bounds` |
| 9 | Destroy all tabs | `BrowserTabCommands` | `destroy_all_browser_tabs()` | `src-tauri/src/commands/browser.rs` | called from drawer-close + `RunEvent::Exit` |
| 10 | Emit per-tab nav events | helper | `emit_tab_event(tab_id, kind, payload)` | `src-tauri/src/commands/browser.rs` | payload includes `tab_id`; emits `browser-tab-{loading,loaded,title-changed,error}` (old singleton names removed) |
| 11 | **Repair link-click nav (B1)** | investigation node | TBD — fix lives in `create_browser_tab` (likely `on_navigation` closure or a new-window handler scoped per the B1 scope clarification above) | `src-tauri/src/commands/browser.rs` | hypotheses + verification targets + investigation steps inlined in the "## Open investigations" section above |
| 12 | Tab-aware bounds sync | `useBrowserTabsBounds` | `useBrowserTabsBounds(hostRef, enabled)` — replaces `useBrowserBounds` | `src/components/browser/useBrowserBounds.ts` | active visible, others off-screen; on active-tab switch hide-prev + show-new in the **same rAF tick** (claude2 S4 — avoids one-frame off-screen flicker) |
| 13 | **Verify live resize (F1)** | `useBrowserTabsBounds` | verification gate against ResizeObserver firing during drag | `src/components/browser/useBrowserBounds.ts` | see `verification_plans[F1]` |
| 14 | New TS types | (type definitions) | `Tab`, `BrowserState` (extended) | `src/types/browser.ts` | `Tab = {id, url, title, isLoading, error}` (per-tab history lives in the OS-layer webview, not the TS shape); extend the existing `BrowserState` to `{ drawerOpen, drawerWidth, tabs: Tab[], activeTabId: string \| null }`. Name reuse intentional — TS shape keeps `BrowserState` to avoid colliding with Rust's `BrowserTabsState` struct |
| 15 | TS IPC wrappers | `BrowserTabsIpc` | `createBrowserTab / setBrowserTabBounds / navigateBrowserTab / browserTab{GoBack,GoForward,Reload,Stop} / destroyBrowserTab / destroyAllBrowserTabs` + preserved `setBrowserSettings` | `src/lib/browserIpc.ts` | replaces 8 old single-webview wrappers; `setBrowserSettings` kept |
| 16 | Zustand tabs slice | `BrowserStore` | shape `{drawerOpen, drawerWidth, tabs: Tab[], activeTabId}` + selectors `activeTab() / activeUrl() / activeTitle() / activeLoading() / activeError()` | `src/stores/browserStore.ts` | replaces single `currentUrl / pageTitle / isLoading / error` |
| 17 | `newTab` | `BrowserStore` | `newTab()` | `src/stores/browserStore.ts` | enforce ≤ 10 cap; push blank Tab; set active; id = `crypto.randomUUID()` |
| 18 | `closeTab` | `BrowserStore` | `closeTab(id)` | `src/stores/browserStore.ts` | last-tab-close → replace with one blank |
| 19 | `setActiveTab` | `BrowserStore` | `setActiveTab(id)` | `src/stores/browserStore.ts` | triggers bounds re-sync |
| 20 | Per-tab field setters | `BrowserStore` | `setTabUrl / setTabTitle / setTabLoading / setTabError` | `src/stores/browserStore.ts` | called by `browser-tab-*` event handlers |
| 21 | Tab strip UI | `TabStrip` | `TabStrip()` | `src/components/browser/TabStrip.tsx` (NEW) | tab buttons + close × + `+` (disabled at 10) |
| 22 | Drawer chrome integration | `BrowserDrawer` | mounts `TabStrip` above existing Row 2; chrome title = `activeTitle`; mounts lifecycle + bounds + settings hooks | `src/components/browser/BrowserDrawer.tsx` | layout: Row 0 TabStrip / Row 1 title / Row 2 nav+addr / Body Host |
| 23 | Per-tab lifecycle | `useBrowserTabsLifecycle` | per-tab create-on-add / destroy-on-remove; nav event routing by `tab_id`; replicates race-fix invariants per tab (CreateGuard generation, in-flight op chain per slot, listener cleanup with cancellation flag) | `src/components/browser/useBrowserLifecycle.ts` | replaces `useBrowserLifecycle` |
| 24 | Nav controls → active tab | `NavControls` | onClick handlers use `activeTabId` + per-tab IPC | `src/components/browser/NavControls.tsx` | small change |
| 25 | Address bar → active tab | `AddressBar` | onSubmit uses `activeTabId` + `navigateBrowserTab` | `src/components/browser/AddressBar.tsx` | small change |
| 26 | Handler registration | (binding) | register 9 new commands; remove 8 old single-webview commands | `src-tauri/src/lib.rs` | inside `tauri::generate_handler!` |
| 27 | App-quit cleanup | (binding) | `RunEvent::Exit` calls `destroy_all_browser_tabs_impl` | `src-tauri/src/lib.rs` | replaces `destroy_browser_webview_impl` |
| 28 | Restore drawer width on mount | `BrowserTabsSettings` | `restoreDrawerWidth()` | settings sub-hook | `get_settings` → `BrowserStore.setDrawerWidth` |
| 29 | Seed first tab URL on mount | `BrowserTabsSettings` | `seedFirstTabUrl()` | settings sub-hook | if `tabs` empty: push one Tab with url = settings.browser_last_url ?? 'about:blank' |
| 30 | Guard settings-restore-during-create | `BrowserTabsSettings` | `guardSettingsRestoreDuringCreate()` | settings sub-hook | applies only to the **first tab** created via `seedFirstTabUrl` — that's the single path that can race the cold-start `get_settings` resolve against a webview build. Subsequent user-`+` tab creates need no guard (no settings restore is in flight at that point). Mirrors the current R2/R3/R4 race fix |
| 31 | Persist active-tab URL (debounced) | `BrowserTabsSettings` | `persistActiveTabUrl()` | settings sub-hook | 800ms debounce; only when activeTab.url !== 'about:blank' AND changed |
| 32 | Persist drawer width (debounced) | `BrowserTabsSettings` | `persistDrawerWidth()` | settings sub-hook | 800ms debounce; only when changed |

### Cohesion grouping

- **`BrowserTabsState`** (#1–#3) — share Rust state (`HashMap<TabId, BrowserSlot<R>>` + per-tab `last_bounds`) and lifecycle (Empty→Creating→Ready per slot).
- **`BrowserTabCommands`** (#4–#10) — share collaboration boundary (`tauri::generate_handler!`) and failure domain (all need `BrowserTabsState`).
- **`BrowserStore` actions** (#16–#20) — share state (tabs slice) and lifecycle.
- **`useBrowserTabsLifecycle`** (#23) — orchestrates per-tab create/destroy + event subscription with race-fix invariants.
- **`useBrowserTabsBounds`** (#12, #13) — observes host rect, dispatches active-tab visible / inactive hidden (same-rAF switch).
- **`BrowserTabsSettings`** (#28–#32, NEW after cohort feedback) — restore + persist drawer width and active-tab URL; preserves the settings-restore-during-create race guard scoped to first tab.

### Cross-boundary contracts

Yes — the 9 new Tauri commands (#4–#10) are TS↔Rust IPC contracts. Per
feature-lane spec, skeleton emission is optional and was **skipped** at
user direction. The IPC shapes are documented in this plan and will live
in `src/lib/browserIpc.ts` and `src-tauri/src/commands/browser.rs` upon
implementation.

## Dependency direction

`plan.mmd` uses **"X depends-on Y"** arrows (consumer → collaborator),
which is the Mermaid convention from the renderer. Reading the DAG:

```
BrowserDrawer    depends on  BrowserStore, TabStrip, NavControls,
                             AddressBar, useBrowserTabsLifecycle,
                             useBrowserTabsBounds, BrowserTabsSettings
TabStrip         depends on  BrowserStore
NavControls      depends on  BrowserTabsIpc, BrowserStore
AddressBar       depends on  BrowserTabsIpc, BrowserStore
useBrowserTabsLifecycle / useBrowserTabsBounds / BrowserTabsSettings
                 depends on  BrowserTabsIpc, BrowserStore
BrowserTabsIpc   depends on  BrowserTabCommands  (IPC contract)
BrowserTabCommands
                 depends on  BrowserTabsState
```

**Strict longest-path toposort** (sources → sinks of the depends-on relation;
20 edges, 11 nodes — verified post-r3-mmd-rerender):

```
L0 (single source, no incoming):  BrowserDrawer
L1 (longest-path = 1):            TabStrip, NavControls, AddressBar,
                                   useBrowserTabsLifecycle,
                                   useBrowserTabsBounds,
                                   BrowserTabsSettings
L2 (longest-path = 2):            BrowserTabsIpc, BrowserStore
L3 (longest-path = 3):            BrowserTabCommands
L4 (longest-path = 4; sinks,
    no outgoing):                  BrowserTabsState
```

Note: `BrowserStore` lives at L2 by strict longest-path (its longest
incoming chain is `BrowserDrawer (L0) → L1 hook → BrowserStore`).
Earlier revisions placed it at L4 alongside `BrowserTabsState` because
both are "leaf state sinks" semantically — that grouping is intuitive
but not strict toposort. Corrected in r3 per claude3 N2 / claude2 P2.

No cycles. Acyclicity verifiable by inspection (single source
`BrowserDrawer`; two no-outgoing sinks `BrowserStore` at L2 and
`BrowserTabsState` at L4, with `BrowserTabsState` the deepest by
longest-path; fan-in/fan-out structure elsewhere). See `plan.mmd` for
the literal Mermaid graph.

## Interfaces emitted

N/A — feature lane, skeletons skipped at user direction. The 11 interfaces
above are described in this plan and exist as cohesion groupings, not as
emitted source files at this phase.

## Validation

Smoke-check (Phase 7, feature-lane skeletons-skipped path):

- `plan.md` non-empty with required headers (`## Goal`, `## Package layout`, `## Decomposition`). ✅
- `plan.mmd` parses as valid Mermaid (`head -1` returns `graph`). ✅
- DAG is acyclic (toposort succeeds — 5 longest-path levels, 11 nodes, **20 edges**; verified by inspection). ✅
- `plan-detail.mmd` removed (stale snapshot of prior cycle; cohort-feedback blocker resolved). ✅
- B1 hypotheses + verification targets + investigation steps inlined in `plan.md` (no dependence on gitignored `.planner-state.json` for downstream contract). ✅

Full compile validation (`tsc --noEmit` + `cargo check --manifest-path src-tauri/Cargo.toml`)
is gated to the implementation phase — out of scope for the planner.

## Rubric (Phase 7 — 4-criterion feature-lane variant)

| Criterion | Score | Notes |
|---|---|---|
| Decomposition completeness | **4** | r2 closed the settings restore/persistence gap (rows #28–#32); every E2E stage now has a method node. B1 and F1 remain first-class. |
| Dependency direction | **4** | Acyclic, 5-level toposort. r2 reconciled prose with mmd arrow convention. |
| Validation status | **3** | Smoke-check only (no skeletons emitted). Full `tsc` + `cargo check` runs at implementation time. |
| Plan coverage | **4** | Every Phase-1 in-scope item (B1, F1, F2) + every Constraint (race-fix preservation, settings restore, event rename, drawer-close wipe) has a decomposition row or explicit constraint statement. |

Total: **15 / 16**.

## Reviewer checklist

Please verify each before typing `confirm plan`:

- [ ] The decomposition table covers every Phase-1 in-scope item (B1, F1, F2) AND every Constraint (settings restore, drawer-close wipe, event rename).
- [ ] No interface looks like a grab-bag of unrelated methods (cohesion test passes — `BrowserTabsSettings` is a coherent restore-and-persist boundary).
- [ ] `plan.mmd` (Mermaid `graph LR`) is acyclic.
- [ ] `plan-detail.mmd` is removed (no stale per-method DAG from the prior cycle floating in the worktree).
- [ ] Out-of-scope items are correctly excluded (target=_blank in-app new-tab, middle-click, tab-list persistence, etc.); B1-scope-clarification reads OK.
- [ ] The resolved Q1–Q4 answers reflect what you actually want.
- [ ] B1 hypothesis list + verification targets (Wikipedia + GitHub) are reasonable; you're OK with the investigate-then-fix approach (root cause TBD until reproduction).
- [ ] Tab IDs via `crypto.randomUUID()` is acceptable (no new dependency required).
- [ ] `BrowserTabsSettings` co-located in `useBrowserLifecycle.ts` (single file, no new file beyond `TabStrip.tsx`) is acceptable.
- [ ] TS type collision avoided: TS shape is `BrowserState` (extended); Rust owns `BrowserTabsState` exclusively.

Below-bar comments (REQUIRED if any box unchecked):
