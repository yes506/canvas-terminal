# Feature plan — browser-drawer

A built-in browser drawer for Canvas Terminal, modelled after cmux. Lives
as a sibling of the existing canvas drawer (canvas slides out from the
left, browser slides out from the right; terminal stays in the middle).
One Tauri 2 child webview overlaid on the main window's DOM rect, with
the IPC contract owned by Rust commands.

This file is the planner's tracked output for downstream implementers.
Full rationale per phase is in shared memory under
`task-30-claude1-plan-phase{1,2,2-verification,3,4,5}.md`; this is the
trimmed version per `feature-lane.md`.

Marker on the merged branch: `(plan-feature, human-confirmed)`.

---

## Goal

Add a built-in browser drawer at the same App-level as the canvas
drawer, sliding out from the right. The browser AUGMENTS the user's
external browser for quick in-context lookup — not a Chrome/Safari
replacement. Single Tauri 2 child webview, no internal tabs, Rust-owned
lifecycle and navigation, persistence via the existing settings.json
command surface.

## In scope

- New top-level right-side drawer in `App.tsx`, mirroring the canvas
  drawer's open/closed/width pattern.
- One Tauri 2 child webview overlaid on the drawer's page-area DOM rect
  (via `Window::add_child` — requires `unstable` feature in
  `Cargo.toml`).
- Drawer chrome: address bar, back / forward / reload / stop, loading
  state, page title.
- Bounds-sync from 7 sources: window resize, scale-factor change,
  drawer drag (browser + canvas), drawer open/close, fullscreen/title-
  bar, UpdateBanner show/hide, minimize/restore.
- Native-menu accelerator `CmdOrCtrl+Shift+B` to toggle the drawer
  (works regardless of which webview has focus on all 3 desktop OSes).
- Tear-down on drawer close AND on app quit (RunEvent::Exit hooked).
- Single GLOBAL browser drawer instance (shared across terminal tabs).
- Shared two-drawer width clamp math in `src/lib/drawerLayout.ts`.
- Capability isolation — 4 layered protections (see Constraints).
- Persistence of last URL + drawer width via the existing
  `commands::settings` surface, extended with two `Option<T>` fields.
- New TS Zustand `browserStore` for frontend state.
- New Rust `BrowserCommands` IPC trait + `validate_browser_url`
  defense-in-depth validator.

## Out of scope

- Multiple browser tabs / tab strip inside the drawer.
- Bookmarks UI, history UI, downloads tracking, extensions.
- Per-pane cookie partitioning (uses Tauri/native webview's default app
  data store).
- DevTools UI surface (right-click dev-tools in dev builds only).
- Browser as a tab kind or pane kind inside `PaneTree` (drawer pattern
  only — scope=2 lock).
- html2canvas / screenshot-into-canvas of the browser drawer (OS-layer
  surface, not React DOM).
- AI / collaborator integration with browser content (no IPC bridge in
  v1).
- In-page find (Cmd+F inside the rendered page).
- `canGoBack` / `canGoForward` state tracking (Tauri 2 has no reliable
  source; buttons always-enabled in v1).
- Per-tab browser drawers.

## Constraints

- Tauri 2.10.3 (`macos-private-api` + `unstable` features); React 18;
  Zustand 5; TypeScript strict.
- Browser engine = Tauri 2 platform-native webview only (WKWebView /
  WebView2 / WebKitGTK). No CEF / Servo / embedded engine.
- Main-window CSP is NOT relaxed (the child webview has its own
  browsing context).
- Capability isolation — 4 layered protections:
  - **(a)** `tauri.conf.json` keeps `withGlobalTauri: false` (the
    global default).
  - **(b)** Browser child created WITHOUT preload / init scripts
    (`WebviewBuilder::initialization_script` not called).
  - **(c)** No new `core:webview:*` permissions added to
    `capabilities/default.json` — Rust-owned commands don't need
    frontend capability grants. Layer (c) achieved by exclusion.
  - **(d)** Phase-6 smoke test asserts `typeof window.__TAURI__ ===
    "undefined"` inside the child webview at runtime.
- URL-scheme address-bar policy:
  - ALLOW: `http:`, `https:`, `about:blank`.
  - FILTER at the input layer: `javascript:`, `tauri:`, `tauri-localhost:`,
    `data:` (XSS / scheme-handler vectors).
  - DENY: `file:` (local-file disclosure).
- Keyboard focus contract: native-menu accelerator
  (`CmdOrCtrl+Shift+B`) handles toggle for all OS-focus states; DOM
  keydown path NOT added (dead code on macOS).
- Lock-order convention: `last_bounds` BEFORE `webview` slot (no node
  currently locks both simultaneously; documented for future
  regression prevention).
- CONCURRENCY INVARIANT: the `webview` Mutex MUST be released before
  any blocking Tauri call. Enforced via two state-cell primitives
  (`clone_webview` for non-destroy, `take_webview` for destroy) plus
  a slot-reservation primitive (`try_reserve_for_create`) returning a
  RAII `CreateGuard` for the create race.

## Success criteria

- Toggle button or `CmdOrCtrl+Shift+B` → drawer slides out from the
  right, child webview loads `about:blank` (Q2 default) within ~1s on
  a warm app; first typed URL navigates within a further ~1s.
- URL bar accepts a typed URL + Enter → webview navigates; address
  bar updates on follow-on navigations.
- Drag handle resizes drawer smoothly; webview tracks the rect each
  frame without visible lag > 1 frame.
- Closing the drawer destroys the webview; reopening creates a fresh
  one on the persisted last URL.
- Both drawers open simultaneously → terminal shrinks between them,
  both drawers track their bounds correctly.
- Browser child webview has NO `__TAURI__` / IPC injection.
- `tsc --noEmit` clean; `cargo check` clean.

## Open questions

All Phase-1 Q1–Q10 resolved with explicit defaults (kept here for
implementer awareness, not for re-asking):

- Q1 toggle shortcut: `CmdOrCtrl+Shift+B` (native-menu accelerator).
- Q2 default homepage: `about:blank`.
- Q3 both drawers at <600px: canvas wins clamp; shared math in
  `src/lib/drawerLayout.ts`.
- Q4 persistence: extend `commands::settings::Settings` with
  `browser_drawer_width: Option<u32>` + `browser_last_url: Option<String>`.
- Q5 URL policy: ALLOW http(s)+about:blank; FILTER javascript: /
  tauri: / tauri-localhost: / data:; DENY file:.
- Q6 cookies persist via engine default profile (NOT necessarily
  shared with the OS user's Safari profile — Phase 4-Impl verifies
  per-platform).
- Q7 screenshot-into-canvas: out of v1 (OS-layer surface).
- Q8 Tauri plugin needed: NO — `tauri::webview::WebviewBuilder` core
  API is sufficient. Cargo.toml needs `"unstable"` feature.
- Q9 page crash / hang: surface inline banner on nav error.
- Q10 menu-accelerator vs DOM keydown: native-menu only (DOM path
  dropped per Phase-3 Round-1).

---

## Package layout

```
src/
├── App.tsx                        [MODIFIED] right-side drawer panel
├── stores/
│   └── browserStore.ts            [NEW] Zustand state
├── components/
│   └── browser/                   [NEW package, mirrors canvas/]
│       ├── BrowserDrawer.tsx
│       ├── AddressBar.tsx
│       ├── NavControls.tsx
│       ├── PageAreaHost.tsx
│       ├── useBrowserBounds.ts
│       └── useBrowserLifecycle.ts
├── hooks/
│   └── useKeyboardShortcuts.ts    [UNCHANGED — DOM-path toggle dropped]
├── lib/
│   ├── urlScheme.ts               [NEW] scheme classifier (skeleton)
│   ├── urlScheme.test.ts          [NEW] Vitest spec (implementation)
│   ├── drawerLayout.ts            [NEW] shared clamp (skeleton)
│   └── browserIpc.ts              [NEW] invoke wrappers (skeleton)
└── types/
    └── browser.ts                 [NEW] type definitions (skeleton)

src-tauri/
├── Cargo.toml                     [MODIFIED] add "unstable" to tauri features
├── tauri.conf.json                [VERIFIED] withGlobalTauri stays false
├── capabilities/
│   └── default.json               [UNCHANGED] no new core:webview:* perms
└── src/
    ├── lib.rs                     [MODIFIED] build_menu + on_menu_event arm
    │                              + run() RunEvent::Exit handler
    ├── state.rs                   [MODIFIED] BrowserWebviewState struct +
    │                              BrowserStateOps trait + AppState.settings_io_lock
    ├── commands/
    │   ├── mod.rs                 [MODIFIED] pub mod browser;
    │   ├── browser.rs             [NEW] BrowserCommands trait (skeleton)
    │   │                          + validate_browser_url signature
    │   └── settings.rs            [MODIFIED] Settings struct +2 fields +
    │                              set_browser_settings partial-update command
    └── (no new menu.rs file)      Existing build_menu extended in-place
```

Dependency direction (one line):
`App.tsx → components/browser → browserStore → browserIpc → invoke → BrowserCommands → BrowserStateOps → BrowserSlot/last_bounds`.

---

## Decomposition

46 nodes across 15 interface groups. Full table + per-method
reasoning is in `task-30-claude1-plan-phase3.md` (shared memory);
condensed here for implementer reference:

| Group | Nodes | Role |
|---|---|---|
| A. browserStore | #1–#7 | Zustand state actions (toggle, setters) |
| B. BrowserDrawer | #8–#9 | Drawer container + drag handler |
| C. AddressBar | #10–#11 | URL input + submit handler |
| D. NavControls | #12 | Back/fwd/reload/stop buttons + spinner + title |
| E. PageAreaHost | #13 | Empty rect-reporting `<div>` |
| F. useBrowserBounds | #14–#17 | Subscribe scale-factor / resize / ResizeObserver + rAF sync |
| G. useBrowserLifecycle | #18–#22 | createOnOpen / destroyOnClose / nav-event subscribe / menu-toggle subscribe / persistSettings |
| H. useKeyboardShortcuts | (#23 DROPPED) | DOM-path toggle dropped; menu accelerator handles all OSes |
| I. urlScheme | #24 | Pure classifier (TS) |
| J. commands::browser | #25–#34c | 9 Tauri commands + `on_page_load` / `on_document_title_changed` / `on_navigation` callbacks |
| K. BrowserWebviewState | #35, #36a–#36d | new + clone_webview + take_webview + try_reserve_for_create + AppState.settings_io_lock |
| L. commands::settings | #37, #38, #44 | +2 struct fields + modified set_settings (lock acquisition) + new set_browser_settings partial-update |
| M. lib.rs::build_menu | #39, #40 | toggle_browser MenuItem + on_menu_event arm emitting `menu-toggle-browser` |
| N. lib.rs::run | #41 | RunEvent::Exit handler invoking destroy_browser_webview_impl |
| O. New nodes (Phase-3 revision-2/3) | #42, #43, #43-test, #44 | clampDrawerWidth (pure TS), validate_browser_url (Rust defense-in-depth) + Rust unit-test, set_browser_settings (partial-update command) |

Cross-boundary IPC contract:

- **Frontend → Rust invoke (10 commands):** `create_browser_webview`,
  `set_browser_webview_bounds`, `navigate_browser`,
  `browser_go_back/forward/reload/stop`, `destroy_browser_webview`,
  `set_browser_settings`, `get_settings` (existing).
- **Rust → Frontend events (5):** `menu-toggle-browser`,
  `browser-loading`, `browser-loaded`, `browser-title-changed`,
  `browser-error`.
- **Built-in Tauri events consumed (2):** `tauri://resize`,
  `tauri://scale-change`.

DAG: see `plan.mmd` in this directory (sibling file). The DAG is
acyclic; every edge is justified by a `Collaborators` field in the
emitted skeleton's 9-field docstring.

---

## Interfaces emitted

Phase 5 ran because the user typed `emit skeletons`. Six files, 19
methods with 9-field docstrings, both validations green.

| File | Kind | Methods (with 9-field docstring) | Source path |
|---|---|---|---|
| `src/types/browser.ts` | TS types | 0 (type definitions: `Rect`, `SchemeClassification`, 4 event payloads, `BrowserState`, `BrowserSettingsPatch`) | `src/types/browser.ts` |
| `src/lib/urlScheme.ts` | TS interface | 1: `classifyScheme` | `src/lib/urlScheme.ts` |
| `src/lib/drawerLayout.ts` | TS interface | 1: `clampDrawerWidth` | `src/lib/drawerLayout.ts` |
| `src/lib/browserIpc.ts` | TS interface | 9: `createBrowserWebview`, `setBrowserWebviewBounds`, `navigateBrowser`, `browserGoBack`, `browserGoForward`, `browserReload`, `browserStop`, `destroyBrowserWebview`, `setBrowserSettings` | `src/lib/browserIpc.ts` |
| `src-tauri/src/commands/browser.rs` | Rust trait + module-level type alias | 9 trait methods + 1 `ValidateBrowserUrlSignature` type alias | `src-tauri/src/commands/browser.rs` |
| `src-tauri/src/commands/mod.rs` | Rust module declaration | 0 (one-line edit adding `pub mod browser;`) | `src-tauri/src/commands/mod.rs` |

Round-1 reviewer cohort caught a 3-way convergent IPC contract
asymmetry on `set_browser_settings` (initially Rust-skeleton was
8 methods, TS was 9). Round-1 patch commit `8b18503` fixed this plus
5 other items. See `task-30-claude1-plan-phase5.md` for the full
reflection.

Deferred-to-implementation (documented in `commands/browser.rs`
trailing `//` block):

- `BrowserSlot<R> { Empty, Creating, Ready(Webview<R>) }` enum
- `BrowserWebviewState<R> { slot: Mutex<...>, last_bounds: Mutex<...> }`
- `BrowserStateOps` trait (clone_webview / take_webview /
  try_reserve_for_create primitives)
- `CreateGuard<'a, R>` RAII guard with `finalize(Webview<R>)`
- `AppState::settings_io_lock: Mutex<()>` field addition

---

## Validation

| Stack | Command | Result | When |
|---|---|---|---|
| TypeScript | `npx tsc --noEmit` | PASS (no output) | Phase 6 inline + re-run after Round-1 patch |
| Rust | `cargo check --offline --manifest-path src-tauri/Cargo.toml` | PASS (`Finished dev profile in 1.22s`) | Phase 6 inline + re-run after Round-1 patch |
| Headers smoke-check (Phase 7) | `grep -c "^## " plan.md` | PASS (>= 9 required headers: Goal, In scope, Out of scope, Constraints, Success criteria, Open questions, Package layout, Decomposition, Validation) | this artifact |
| Mermaid smoke-check (Phase 7) | `head -1 plan.mmd` returns `flowchart` | PASS (first line is `flowchart LR`) | this artifact |

Phase 6 inline validation already passed cleanly on the Phase 5
skeleton commit and again after the Phase 5 Round-1 patch. Plan
artifacts (this file + `plan.mmd`) pass the feature-lane smoke check.

---

## Implementation prerequisites

The planner's Cargo.toml is NOT touched by this plan. Implementation
must apply the following before any compilation that depends on the
browser feature:

1. **`src-tauri/Cargo.toml`** — add `"unstable"` to Tauri features:
   ```toml
   tauri = { version = "2", features = ["macos-private-api", "unstable"] }
   ```
   Rationale: `Window::add_child` is `#[cfg(all(desktop, feature =
   "unstable"))]` per `tauri-2.10.3/src/window/mod.rs:1052`.
2. **`url` crate** — promote from transitive Tauri dep to direct dep
   if `validate_browser_url` uses `Result<url::Url, String>`. Or use
   the `tauri::Url` re-export at `tauri/src/lib.rs:82` (cleaner;
   matches the Phase-5 skeleton's `ValidateBrowserUrlSignature` type
   alias).
3. **State types** — materialize `BrowserSlot`, `BrowserWebviewState`,
   `BrowserStateOps`, `CreateGuard`, `AppState.settings_io_lock`. The
   trailing `//` block in `commands/browser.rs` enumerates the
   expected shapes.

---

## Self-verification rubric (6 criteria, full system-lane set per `emit skeletons`)

| Criterion | Score | Notes |
|---|---|---|
| Decomposition completeness | 4 | Every Phase-1 in-scope feature (#1–#11) maps to at least one node in the 46-node decomposition. Verified in mapping table (Phase-3 revision 3). |
| Docstring quality | 4 | All 19 emitted methods carry all 9 fields with substantive content. claude2 Round-1 spot-checked `create_browser_webview`: Failure-modes enumerates 4 distinct error variants; Postconditions calls out the lock-order invariant. |
| Interface cohesion | 4 | `BrowserCommands` (9 methods) is cohesive — all 9 are Tauri commands operating on the browser webview's lifecycle / navigation / persistence. `BrowserIpc` mirrors it on the TS side. No god-interface; no grab-bags. |
| Dependency direction | 4 | DAG (`plan.mmd`) is acyclic. The toggle convergence point (`browserStore.toggle()`) prevents a double-write race. Lock-order convention prevents Mutex inversions. Slot-reservation eliminates the create TOCTOU. |
| Validation status | 4 | Phase 6 (`tsc --noEmit` + `cargo check`) passed cleanly first run; passed again after Round-1 patch. Phase 7 header/Mermaid smoke-check: PASS. |
| Plan coverage | 4 | Every Phase-1 in-scope bullet has a named owner file in the Package layout. Every emitted interface traces back to a Phase-1 feature. |

**Total: 24 / 24.** No criterion below "Excellent". No Phase-7
failure-handling step required (would trigger only on a "1
(Beginning)" score).

---

## Human-confirmation checklist

```
Reviewer checklist — please verify each:

[ ] The decomposition table in Phase 3 matches the interfaces actually
    emitted in Phase 5 (9 TS + 8 Rust + 1 Rust module decl + 1 Rust
    type alias = 19 docstrings)
[ ] Every method has all 9 docstring fields (skim 3 random methods to
    spot-check)
[ ] No interface looks like a grab-bag of unrelated methods
[ ] The Mermaid DAG (plan.mmd) is acyclic
[ ] No method body has been written (interface-only) — TS uses
    `interface` / `declare const` patterns; Rust trait methods end
    with `;`; `validate_browser_url` is a `pub type` alias, not a
    free `pub fn`
[ ] The validation command (Phase 6) passed — see
    .planner-state.json: phase_6_validation
[ ] The Cargo.toml `"unstable"` feature requirement is recorded as an
    implementation prerequisite (NOT applied in the planner worktree)

Above-bar comments (optional):
Below-bar comments (REQUIRED if any box unchecked):
```

---

## Round-1 reviewer cohort summary (shared-memory pointers)

| Phase | Rounds | Reviewer files | Net |
|---|---|---|---|
| Phase 1 | 5 (R1 absence + 4 substantive) | 16 review files (4 reviewers × ~4 rounds) | Compression curve: 15→10→3→1→0 |
| Phase 2 | 4 rounds | 16 review files | Compression curve: 15→10→3 (textual) →1 (cosmetic) →0 |
| Phase 2.5 | inline | 1 verification file + Phase-3 R1 correction (unstable gate) | Phase-2.5 #1/#2-residual/#3 resolved cleanly with one simplification (custom scale-factor bridge dropped) |
| Phase 3 | 3 rounds | 12 review files | Round-1 caught Phase-2.5 unstable-feature gap; Round-2 fixed slot-reservation + settings_io_lock + stale nav-state |
| Phase 4 | 1 round | (no review) | Worktree created cleanly; SKILL Phase 4 step list followed |
| Phase 5 | 1 round + 1 patch | 4 review files | 3-way convergent IPC asymmetry caught; patch commit fixed 6 items |

All cohort artifacts live in `/Users/donghyeon/.cache/canvas-terminal/collab-memory/session-1844/`.

---

Next: Phase 8 (human gate + merge) — see `task-30-claude1-plan-phase4.md`
for the SKILL contract. On `confirm plan` the planner-branch merges to
`feat/browser-integration` with marker `(plan-feature, human-confirmed)`.
