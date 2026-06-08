# Implementation report — agent-mini-terminal-visibility-restore

## Source

- Planner marker: **local** (chat-gate, same-session)
- Planner artifacts: none on disk — local lane is chat-only by contract
- Source hash: N/A — local-lane chat-gate; planner content lives in the
  same conversation transcript that invoked the implementer (the LWQ-1
  through LWQ-5 spec in the Phase 0.5 + plan-reflection blocks
  immediately preceding `confirm plan`; investigation report at
  `~/.cache/canvas-terminal/collab-memory/session-6801/task-1-investigation-claude1.md`
  used as the upstream root-cause document)
- Phase 0 note: inspector reported a stale `on-base-with-marker`
  (`feature` @ `8a46ddb`, `korean-ime-textarea-rewrite`) whose
  implementer marker already landed at `422a410`. The user typed
  `proceed` to acknowledge that the stale commit-based marker is for a
  different, already-implemented plan and to honor the chat-gate
  `(plan-local, human-confirmed)` for this run instead.

## Work queue summary

- Total items: 5
- Completed: 5
- Blocked: 0

## Files changed

- `src/components/collaborator/AgentMiniTerminal.tsx` — +60 / -0
- `src/components/collaborator/AgentMiniTerminal.test.ts` — +73 / -0
- `implementation-report.md` — overwritten (the worktree inherited the
  prior `mini-terminal-redraw-interval` run's report from `dev` HEAD at
  `a145699`; the prior content is preserved in `git log` on `dev` and
  is no longer the live document for this branch)

## Validation

- Baseline exit (BASE_BRANCH HEAD, prior to LWQ-* edits): 0
- Final validation command: `npx tsc --noEmit && npx vitest run src/components/collaborator/AgentMiniTerminal.test.ts`
- Final exit: 0
- Auto-fix attempts used: 0/3
- Tail of last run:

```
 RUN  v4.1.5 .../implementer-agent-mini-terminal-visibility-restore-08264-82512-27746

 Test Files  1 passed (1)
      Tests  26 passed (26)
   Start at  17:48:46
   Duration  1.25s (transform 137ms, setup 91ms, import 685ms, tests 20ms, environment 334ms)
```

(tsc step produced no diagnostics; only the vitest summary is shown above. Baseline was 19 tests; new visibility-restore suite contributes 7 = 26 total.)

## Per-item outcomes

| item_id | status | files_touched | notes |
|---|---|---|---|
| LWQ-1 | completed | src/components/collaborator/AgentMiniTerminal.tsx | Added `wasIntersecting = true` and `visibilityObserver: IntersectionObserver \| null = null` as effect-local `let` bindings immediately after the existing `lastPtyDataAt` / `refreshInterval` lets. Same idiom (plain lets, captured by closure into the IO callback and the cleanup return). Initial `wasIntersecting=true` prevents a spurious rAF on the mount-time IO entry (`!true && true = false`). |
| LWQ-2 | completed | src/components/collaborator/AgentMiniTerminal.tsx | Instantiated `visibilityObserver = new IntersectionObserver(...)` with `threshold: 0` immediately after the existing `observerRef.current = observer;` line (before the capture / pty-data listener wiring). Callback reads the last entry, gates on `isCurrentRun()`, computes `nowVisible`, branches on `!wasIntersecting && nowVisible` (hidden→visible only), bumps `lastPtyDataAt = Date.now()` to pulse the 500 ms refresh interval through the settle window, schedules one `requestAnimationFrame(...)` for the actual fit+refresh work, and unconditionally updates `wasIntersecting = nowVisible` at end. Observes `termRef.current` under the same truthy guard as the existing ResizeObserver site. |
| LWQ-3 | completed | src/components/collaborator/AgentMiniTerminal.tsx | rAF body re-checks `isCurrentRun()` (StrictMode dispose-mid-frame guard, same as LWQ-3 from the prior redraw-interval run), `el?.isConnected`, `el.offsetWidth <= 0 \|\| el.offsetHeight <= 0` (mirrors the 500 ms interval guards at lines 657-658 pre-edit), then calls `safeFit()` and `terminal.refresh(0, terminal.rows - 1)` under a `terminal.rows > 0` guard. Implemented as part of the same Edit as LWQ-2 since the rAF lives inside the IO callback closure. |
| LWQ-4 | completed | src/components/collaborator/AgentMiniTerminal.tsx | Added `if (visibilityObserver) { visibilityObserver.disconnect(); visibilityObserver = null; }` to the lifecycle cleanup return, immediately after the existing `refreshInterval` clear block. Same idiom — null-out the binding so a same-effect-instance re-entry sees a clean state. |
| LWQ-5 | completed | src/components/collaborator/AgentMiniTerminal.test.ts | Added a new `describe("visibility-restore IntersectionObserver", ...)` block at the end of the file (after the `shouldFitMiniTerminal` describe). Seven source-text assertions (mirroring the existing "default renderer" check at line ~286): (1) the two effect-local lets are declared, (2) `new IntersectionObserver(` is instantiated with `threshold: 0`, (3) the IO callback gates on `isCurrentRun`, (4) `!wasIntersecting && nowVisible` bumps `lastPtyDataAt = Date.now()`, (5) `requestAnimationFrame` wraps `safeFit()` + `terminal.refresh(0, terminal.rows - 1)`, (6) the rAF body guards on isCurrentRun + isConnected + offsetWidth/Height + terminal.rows, (7) cleanup disconnects + nulls `visibilityObserver`. Each assertion uses an anchored regex with `[\s\S]*?` between landmarks so harmless whitespace/comment edits don't false-fail. |

## Scope-discipline self-check

- [x] No new interfaces / files outside hints (only the two work-queue files touched plus this report; the prior `mini-terminal-redraw-interval` report is overwritten at the worktree root by virtue of the same file path — preserved in `dev`'s history)
- [x] No renames of committed public names
- [x] No signature changes on planner-committed methods (the lifecycle `useEffect` callback signature is unchanged; the new IO callback is local)
- [x] No edits to validation_command configuration (no `tsconfig.json` / `vitest.config.*` / `package.json` edits)
- [x] No edits to files outside the work queue's hint set
