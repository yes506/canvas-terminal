# Implementation report — mini-term-column-floor

## Source
- Planner marker: `local` from chat-gate (same-session)
  - Planner block emitted in this conversation with classification `scale: local` after Round-2 peer-review convergence.
  - User typed `confirm plan` after the planner block, then the planner emitted `marker: (plan-local, human-confirmed)`.
- Planner artifacts: none on disk (chat-only contract for the local lane).
- Source hash: n/a (chat-only inputs).

Note on inspector finding: the implementer inspector reported an unrelated past planner marker (`b035a9cb feat(planner): merge cycle-f-always-on-rearm`) under a different slug whose implementation is already merged. The chat-based local gate for THIS project slug (`mini-term-column-floor`) was honored independently.

## Work queue summary
- Total items: 7
- Completed: 7
- Blocked: 0

| Item | Title | Status | Files touched |
|---|---|---|---|
| WQ-1 | MIN_AGENT_TILE_WIDTH_PX constant + load-bearing comment | completed | `src/components/collaborator/CollaboratorPane.tsx` |
| WQ-2 | Column floor on both grid branches + data-testid | completed | `src/components/collaborator/CollaboratorPane.tsx` |
| WQ-3 | MIN_TERMINAL_COLS=20 / MIN_TERMINAL_ROWS=6 exported | completed | `src/components/collaborator/AgentMiniTerminal.tsx` |
| WQ-4 | Exported pure `shouldFitMiniTerminal` helper | completed | `src/components/collaborator/AgentMiniTerminal.tsx` |
| WQ-5 | `safeFit()` wrapper at 4 fit sites + skip-no-scroll + L860 asymmetry comment | completed | `src/components/collaborator/AgentMiniTerminal.tsx` |
| WQ-6 | 12 unit tests for `shouldFitMiniTerminal` | completed | `src/components/collaborator/AgentMiniTerminal.test.ts` |
| WQ-7 | Source-level regression guard on `gridTemplateColumns` (both branches) | completed | `src/components/collaborator/CollaboratorPane.test.tsx` |

## Files changed
- `src/components/collaborator/CollaboratorPane.tsx` — constant + comment + grid template + data-testid
- `src/components/collaborator/CollaboratorPane.test.tsx` — regression guard describe block
- `src/components/collaborator/AgentMiniTerminal.tsx` — constants + helper + safeFit wrapper + 4 site updates + font-size asymmetry comment
- `src/components/collaborator/AgentMiniTerminal.test.ts` — 12 unit tests + import line

Total: **4 files, +222 / -18 lines.**

## Validation
- Baseline exit (BASE_BRANCH HEAD, dev @ f209444): **0** (tsc 0 errors; vitest 234/234 pass)
- Final validation command: `npx tsc --noEmit && npm run test`
- Final exit: **0**
- Auto-fix attempts used: 0/3
- Tail of last run:

```
 Test Files  13 passed (13)
      Tests  247 passed (247)
   Start at  03:55:22
   Duration  1.53s (transform 1.44s, setup 1.22s, import 2.98s, tests 526ms, environment 5.04s)
```

Delta: 234 → 247 passing (+13 = 12 `shouldFitMiniTerminal` cases + 1 column-floor regression guard).

## Per-item outcomes

| item_id | status | files_touched | notes |
|---|---|---|---|
| WQ-1 | completed | CollaboratorPane.tsx | Constant lives above the component; docstring covers cascade, b261437 mirror, 360px↔20cols cell-width relation, and the large-fontSize edge. |
| WQ-2 | completed | CollaboratorPane.tsx | Both `spawns.length === 1` and multi-agent branches now apply `minmax(${MIN}px, 1fr)`; data-testid="agent-grid" added for future render tests. |
| WQ-3 | completed | AgentMiniTerminal.tsx | Constants are `export const` at module scope so the test file can import them. |
| WQ-4 | completed | AgentMiniTerminal.tsx | Helper rejects undefined / missing-field / non-number / NaN / Infinity / non-positive / below-floor. Takes optional `floors` override to keep callers' policies tunable without re-exporting constants. |
| WQ-5 | completed | AgentMiniTerminal.tsx | Wrapper `safeFit()` lives inside `initTerminal` closure (binds to local `fitAddon`), used at initial, RAF, ResizeObserver. The font-size subscriber is outside that closure, so it calls the exported `shouldFitMiniTerminal` against `fitAddonRef.current?.proposeDimensions()` inline. Skip path no longer invokes `scrollToBottom`. Comment at the font-size site documents the intentional asymmetry per claude3's review N4. |
| WQ-6 | completed | AgentMiniTerminal.test.ts | 12 cases covering all rejection branches plus the documented boundary `cols=20, rows=6`. |
| WQ-7 | completed | CollaboratorPane.test.tsx | Source-level rather than DOM-render because the existing test file mocks `AgentToolbar` (which owns the spawn-trigger button), so rendering a populated grid in jsdom would require unwinding that mock. Source assertion mirrors the precedent at AgentMiniTerminal.test.ts (WebGL-renderer absence check). |

## Scope-discipline self-check
- [x] No new tracked files outside hints — exactly the 4 hinted files modified, plus this report. The worktree also carries an untracked `node_modules` symlink (`-> ../../node_modules`) created at Phase 2 to share the parent install for `tsc`/`vitest`. It is `.gitignore`-matched (the root `node_modules/` entry), not in the commit, and must be removed before `git worktree remove` per `git`'s safety check (see "Worktree cleanup" below).
- [x] No renames of committed public names — only additions (`MIN_TERMINAL_COLS`, `MIN_TERMINAL_ROWS`, `shouldFitMiniTerminal`).
- [x] No signature changes on planner-committed methods — `handlePtyExit`, `AgentMiniTerminal`, `CollaboratorPane` props all unchanged.
- [x] No edits to `validation_command` configuration — `package.json`, `vitest.config.ts`, `tsconfig.json` untouched.
- [x] No edits to files outside the work queue's hint set — Rust `pty.rs` left alone per plan (4/4 reviewer consensus to keep `resize_pty` unchanged).
- [x] No `--no-verify`, no force ops — incremental commits on the implementer branch, no amend.

## Worktree cleanup (merge gate)
After `confirm merge`, the parent skill will offer to `git worktree remove .worktrees/implementer-mini-term-column-floor-03031-83265-22119`. Because git refuses to remove a worktree with untracked files, the `node_modules` symlink (created during Phase 2 for validation reuse) must be removed first:

```bash
rm /Users/donghyeon/Desktop/development/my-private-develoment/dev-utils/canvas-terminal/.worktrees/implementer-mini-term-column-floor-03031-83265-22119/node_modules
```

The symlink is the only untracked artifact in the worktree.

## Known limitations (documented for the merge gate)
- **Pre-existing narrow scrollback is not repaired.** The fix prevents future narrowing; lines emitted as hard newlines while the pane was narrow remain narrow in the buffer. User workaround: Ctrl-L (clear) after re-expanding. This was an explicit Round-2 review acknowledgment, not a regression.
- **Large terminal fontSize (≥16px) edges close to the floor.** 360px maps to ~16-18 cols at 16-22px font cells. Above FitAddon's `MINIMUM_COLS=2` but cramped for Claude/Codex prompt frames. Constant is documented as tunable in the source.

## Manual repro (post-merge user verification)
1. Launch the app: `npm run tauri dev`.
2. Spawn ≥2 agents in the collaborator pane.
3. Drag the collaborator pane width below 360px → horizontal scroll bar should appear; columns must NOT shrink below 360px each.
4. Spawn-then-close back to one agent → same 360px floor should hold (single-agent branch).
5. Widen the pane again → press Ctrl-L in a mini terminal → type a prompt → new output should fill the now-wider width without 1-char-wide breaks.
6. Bump terminal font size in settings → fit may be skipped that cycle; this is the intended asymmetry.

---

(Prior `implementation-report.md` content for `browser-zoom` is reachable via `git log -- implementation-report.md`.)
