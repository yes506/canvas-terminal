# Implementation report — capture-fix-injection

(Prior `implementation-report.md` on `dev` documented
`native-window-capture` and before that `collab-protocol-rule2`.
Overwritten with this micro-lane report; historical content reachable
via `git log -- implementation-report.md`.)

## Source

- **Planner marker**: `scale: micro` (chat-only per CLAUDE.md; no
  commit-based marker for micro lane)
- **Confirmation token**: `confirm plan` typed in this session after
  the v2 marker emit
- **Convergence**: 4 planning rounds on the original
  `native-window-capture` work + 2 review rounds on this micro
  follow-up; v2 plan ratified by 4/4 reviewers in round 8
- **Empirical verification**: 4 independent Tauri 2.10.3 source reads
  (codex2, codex3, claude3, claude1) confirmed the
  `is_webview_window` predicate and its effect on
  `get_webview_window`

## Work-queue summary

- Total items: **3** (constant declaration, command signature swap +
  resolver insertion, `capture_macos` signature swap)
- Completed: **3**
- Blocked: **0**

## Files changed

```
 src-tauri/src/commands/capture.rs | 38 ++++++++++++++++++++++++++++--------
 1 file changed, 35 insertions(+), 3 deletions(-)
```

Single file. Predicted ~5 lines of pure code change; total diff is
larger because each change carries explanatory comments naming the
predicate trap so future readers understand why `get_window` (not
`get_webview_window`) is correct.

## Validation

- **Baseline exit** (worktree HEAD = `dev` at `3da8c54`):
  `cargo check --locked` = 0 (with 9 pre-existing warnings in
  `commands/transcripts/fs_gate.rs` — not in scope; identical to the
  prior implementer run's baseline)
- **Final validation command**: `cd src-tauri && cargo check --locked`
- **Final exit**: 0
- **Auto-fix attempts used**: **0 / 3** (validation passed on first
  attempt)
- Tail of final cargo run (all pre-existing; zero new from this run):

```
warning: `canvas-terminal` (lib) generated 9 warnings
    Finished `dev` profile [unoptimized + debuginfo] target(s) in 7.00s
```

## Per-item outcomes

| Item | Description | Status | File | Notes |
|---|---|---|---|---|
| 1 | Local `const MAIN_WINDOW_LABEL: &str = "main";` declaration | completed | `src-tauri/src/commands/capture.rs` | Comment explicitly names the duplication-vs-promote tradeoff and the rule-of-three threshold for centralization (per @claude2 + @codex3 round-7 consensus). Sharing with `browser.rs:19` would require flipping its `pub(crate)` visibility — scope creep for a micro lane. |
| 2 | `capture_main_window_png(window: WebviewWindow)` → `(app: AppHandle)`; macOS cfg branch resolves via `Manager::get_window` and calls `capture_macos(window)`; non-macOS branch takes `let _ = app;` | completed | same file | Resolver lives **inside the macOS `#[cfg]` branch** with function-local `use tauri::Manager;` (per @claude3 round-8 stylistic refinement) — keeps the Manager trait import out of the non-macOS path. Comment block names the `is_webview_window` predicate and why `get_window` (not `get_webview_window`) is the correct choice. |
| 3 | `capture_macos(window: WebviewWindow)` → `(window: tauri::Window)` | completed | same file | Body byte-identical — both `tauri::Window` and `tauri::WebviewWindow` expose `.ns_window()` and `.scale_factor()` on macOS via `WindowExtMacOS`/`Manager` traits (verified against Tauri 2.10.3 source at `window/mod.rs:1384` and `:1543`). |

## Scope-discipline self-check

- [x] No new interfaces / files outside the plan's hint set — the only
  change is inside the existing `src-tauri/src/commands/capture.rs`
- [x] No renames of committed public names — the IPC command
  `capture_main_window_png` keeps its name; the JS-side `invoke<{
  pngBase64, sourceScale }>("capture_main_window_png")` call is
  unchanged
- [x] No signature changes on planner-committed methods beyond the
  command's Tauri-arg signature, which is **the exact fix the planner
  spec'd**
- [x] No edits to `validation_command` configuration — `Cargo.toml`,
  `tauri.conf.json`, build scripts, capability JSON all untouched
- [x] No edits to files outside the work queue's hint set — diff is
  exactly one file
- [x] BGRA → RGBA channel swap preserved (capture.rs:160–175 from the
  prior commit — untouched by this fix)
- [x] Permission preflight + request flow preserved
- [x] 50 MB cap matching `export_snapshot` preserved
- [x] `{ pngBase64, sourceScale }` return shape preserved
- [x] Multi-display `source_scale` capture timing (read **before** the
  framebuffer read) preserved
- [x] Non-macOS `#[cfg]` stub preserved (symmetric `let _ = app;` for
  the new signature)
- [x] No frontend changes (`DrawingBoard.tsx` untouched)
- [x] No `package.json` / `tauri.conf.json` / `capabilities/default.json` changes

## Notes for the manual acceptance pass

`cargo check --locked` validates the type system but does not exercise
the Tauri command-argument injector at runtime — same structural limit
that hid the original bug through 6 rounds of planning + 2 rounds of
implementation review.

Re-run the original failing scenario to confirm the fix:

1. Run the dev build: `cd <repo-root> && npm run tauri dev`.
2. **Open the browser drawer** and load **at least one tab** (e.g.
   the Figma URL from the original repro). This is the critical
   precondition — child webviews with labels `browser-tab-<id>`
   attached to the main window are what flipped
   `is_webview_window()` to false. Testing without a tab open would
   falsely pass.
3. Click the "Capture Full Window" button (`MonitorDown` icon in the
   canvas action bar).
4. Expected: the Fabric canvas receives a screenshot **showing the
   live page content** in the browser drawer area — no black
   rectangle, no tab-strip collision.

Then continue with the runtime AC criteria the prior run deferred to
manual:

- AC §3 — Retina sizing via the IPC-returned `sourceScale` looks
  proportionate.
- AC §4a — Permission-denied path (deny in TCC settings; click capture)
  shows the structured toast without freezing.
- AC §4b — Grant permission → Cmd+Q → relaunch → click capture →
  success on first try.

## Process note (future planner input)

The 2-round review cycle on this micro fix re-validated the vault's
`observation-20260502-v4-verification-pattern`: when 2 reviewers
recommend an approach based on API-name reasoning and 2 reviewers
recommend the opposite based on reading the actual registry source,
**the empirical source-read pair wins**. Both name-based reviewers
(@claude2, @claude3) logged self-corrections in round 8. For future
planner inputs that touch the Tauri command surface (or any
plugin-mediated ACL), the planner ACs should require at least one
runtime smoke-test before the impl marker lands — `cargo build
--release` links the IPC symbol but does not invoke it, and AC6 is a
build-sanity gate, not a runtime gate. Out of scope for this micro
fix; logged here for the next planning round.
