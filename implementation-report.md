# Implementation report — native-window-capture

(Prior `implementation-report.md` on `dev` documented
`collab-protocol-rule2` and before that `inputprompt-c0-strip`.
Overwritten with this local-lane report; historical content
reachable via `git log -- implementation-report.md`.)

## Source

- Planner marker: `scale: local` (chat-gate, current session)
- Marker text: `scale: local   marker: (plan-local, human-confirmed)`
- Planner artifacts (in collab-memory, not part of this repo):
  - `task-6-claude1-bug-investigation.md` (root-cause)
  - `task-11-claude1-updated-plan.md` (v2)
  - `task-16-claude1-updated-plan-v3.md` (v3)
  - `task-21-claude1-updated-plan-v4.md` (v4, ratified)
- Confirmation token: `confirm plan` after the v4 marker emit
- Convergence rounds: 4 (peer reviewers @claude2, @codex2, @claude3, @codex3 in each round)

## Work-queue summary

- Total items: **7** (plus 2 review-round fixes — B1, B2 — folded in after the round-5 peer review on `861976d`)
- Completed: **7**
- Blocked: **0**

## Review-round fixes (commit `8279c66`)

Two reviewers (@codex2 + @codex3) independently flagged the same two issues on the first implementation commit. Both fixed:

- **B1 — `src-tauri/Cargo.lock` was dirty + uncommitted.** The first commit added direct macOS deps to `Cargo.toml` but did not include the matching lockfile update (version bump 0.4.0 → 0.5.0 + new direct/transitive packages). Releases and CI `--locked` builds would have been unreproducible. Lockfile now committed.
- **B2 — Toast renderer mislabeled capture messages as "Copied to clipboard:".** The renderer auto-prefixed every non-`Saved:` message with `Copied to clipboard:`. After the swap, that meant rationale / `PERMISSION_DENIED` / "Capture failed" toasts rendered with the wrong prefix — directly undermining v3 D5's load-bearing permission UX. Refactored so each setter passes the full intended display string and the renderer is unconditional.

Also folded @claude2 #4: stale comment on `addCapturedScreenshotToCanvas` still referenced "`dpr*2` for html2canvas" — updated to name the new Rust-returned `sourceScale` flow.

## Files changed

```
 src-tauri/Cargo.toml                   |  12 ++
 src-tauri/Cargo.lock                   | 100+ ±  (added by 8279c66 — direct deps + transitive closure)
 src-tauri/Info.plist                   |   8 ++  (new)
 src-tauri/src/commands/capture.rs      | 206 ++  (new)
 src-tauri/src/commands/mod.rs          |   1 +
 src-tauri/src/lib.rs                   |   1 +
 src/components/canvas/DrawingBoard.tsx | ~140 ±  (the swap + B2 toast refactor + #4 comment)
 src/lib/terminalManager.ts             |  18 ±
```

## Validation

- **Baseline exit** (worktree HEAD = `dev`): `tsc --noEmit` = 0, `cargo check` = 0 (with 9 pre-existing warnings in `commands/transcripts/fs_gate.rs` — not in scope).
- **Final validation command**: `cd <worktree> && npx tsc --noEmit && (cd src-tauri && cargo check)`
- **Final exit**: `tsc --noEmit` = 0, `cargo check` = 0
- **Auto-fix attempts used**: **0 / 3** (validation passed on first attempt)
- Tail of last cargo run (all pre-existing warnings; zero new from this run):

```
warning: fields `adapter_id` and `candidate` are never read
  --> src/commands/transcripts/fs_gate.rs:18:19
...
warning: `canvas-terminal` (lib) generated 9 warnings
    Finished `dev` profile [unoptimized + debuginfo] target(s) in 19.40s
```

## Per-item outcomes

| Item | Description | Status | Files | Notes |
|---|---|---|---|---|
| 1 | `src-tauri/Info.plist` with `NSScreenCaptureUsageDescription` | completed | `src-tauri/Info.plist` | Tauri auto-discovers next to `tauri.conf.json` per schema; no `tauri.conf.json` change. Belt-and-suspenders — the in-app rationale toast carries the load-bearing UX (v3 D5). |
| 2 | macOS-only Cargo deps | completed | `src-tauri/Cargo.toml` | `core-graphics 0.25`, `objc2 0.6`, `objc2-app-kit 0.3` (`NSWindow` feature), `image 0.25` (`default-features=false, features=["png"]`). Versions match the transitive copies already in `Cargo.lock`. |
| 3 | `capture_main_window_png` Tauri command | completed | `src-tauri/src/commands/capture.rs` (new) | Sync `pub fn` (not async). `CGPreflightScreenCaptureAccess` + `CGRequestScreenCaptureAccess`. `NSWindow.windowNumber()` via `objc2-app-kit`. Safe `core_graphics::window::create_image` wrapper. `kCGWindowImageBoundsIgnoreFraming`. **BGRA→RGBA channel swap** before PNG encoding (v4 E2 — would silently produce blue/red-swapped PNGs otherwise). 50 MB cap matching `export_snapshot`. Non-macOS `#[cfg]` stub. |
| 4 | `pub mod capture;` registration | completed | `src-tauri/src/commands/mod.rs` | Alphabetical position between `canvas` and `dashboard`. |
| 5 | Add to `generate_handler!` | completed | `src-tauri/src/lib.rs` | Adjacent to `commands::canvas::export_snapshot` since the two share PNG/50 MB precedent. |
| 6 | Swap `handleCaptureFullWindow` body | completed | `src/components/canvas/DrawingBoard.tsx` | Dropped `html2canvas` import (this file only — 4 other callers remain), `document.fonts.ready`, `onclone`, `dpr*2`. Destructures `{ pngBase64, sourceScale }`. One-time rationale toast with `RATIONALE_KEY` localStorage flag set only on success/non-`PERMISSION_DENIED` outcomes (v4 Δ3 — so first-attempt deny still re-shows the rationale on retry). |
| 7 | `WebglAddon(true)` → `WebglAddon(false)` | completed | `src/lib/terminalManager.ts` | `preserveDrawingBuffer` was only needed for html2canvas drawImage. Inline comment names the future opt-back-in path for OCR / search-highlight pixel readback (v4 Δ12). |

## Scope-discipline self-check

- [x] No new interfaces / files outside the plan's hint set — only `Info.plist` + `capture.rs` are new, both explicit in v3/v4
- [x] No renames of committed public names
- [x] No signature changes on planner-committed methods — `addCapturedScreenshotToCanvas` signature unchanged; only the second arg's value source changes
- [x] No edits to validation_command configuration — `package.json` build scripts unchanged; `Cargo.toml` only gains a new `[target.'cfg(...)'.dependencies]` table
- [x] No edits to files outside the work queue's hint set
- [x] No `overflow-hidden` on `TerminalTabs.tsx` (4/4 reviewers' "things NOT to fix" list, all 4 rounds)
- [x] No `BrowserDrawer` layout changes
- [x] No removal of `html2canvas` from `package.json` (4 other runtime callers in `documentRenderer.ts` + `responseRenderer.ts` remain)
- [x] No `src-tauri/capabilities/default.json` edit (v3 R8 / v4: Tauri 2 custom commands via `generate_handler!` need no capability entry)

## Notes for the manual acceptance pass (planner AC6)

The implementer loop ran only `tsc --noEmit` + `cargo check`. Before merging, run the planner's AC6 build-sanity gate manually:

```bash
cd <repo-root>
npm run build           # tsc + vite for app and dashboard
cd src-tauri && cargo build --release    # validates macOS deps + cfg gates
```

Then exercise the runtime acceptance criteria:

1. Open browser drawer with Figma (or any non-trivial page) → click capture → resulting Fabric image **shows the live page content** (not a black rectangle).
2. 3+ terminal tabs + 2+ browser tabs open → captured image has **no overlapping tab strips**.
3. Retina display (DPR=2) → inserted image's CSS width is reasonable (≤900 px); optional: drag to a 1× display and capture again to exercise the `sourceScale` multi-display path.
4. **4a** — Screen Recording **not** granted at boot → click capture → rationale toast appears ~3.5 s and auto-clears → macOS system prompt appears → if user denies, `PERMISSION_DENIED` toast appears; UI does not freeze; second click re-shows the rationale toast (per Δ3 localStorage gating).
5. **4b** — Grant permission in System Settings → **Cmd+Q** Canvas Terminal → wait for dock icon to disappear → click app icon to relaunch → click capture → success on first try. (Window-close via the red "X" does NOT trigger TCC re-read on most macOS versions.)
6. Build sanity: `npm run build` + `cd src-tauri && cargo build --release` both pass on macOS; `cargo build` passes on Linux/Windows CI via the `#[cfg]` stub.

## Implementer-time spike points (v4 carry-forward)

Not blockers — may surface during the AC pass:

- **`kCGWindowImageBoundsIgnoreFraming` with `transparent: true`** (v3 R9 / v4 E8): may clip the titlebar in some macOS versions. If AC manual test shows clipping, swap to `kCGWindowImageDefault` — single-line change in `capture.rs`.
- **Toast → invoke transition timing** (v4 E6): if the rationale toast clearing into the system prompt feels abrupt, add a ~500 ms grace inside `try { ... }`.
