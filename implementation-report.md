# Implementation report — fix-strictmode-agent-dup

## Source

- Planner marker: `local` (chat-gate) — emitted in this session by
  `/codebase-planner` immediately followed by user `confirm plan`. The
  `(plan-local, human-confirmed)` marker lives in chat history only,
  per the planner contract; no commit-based marker for local lane.
- Planner artifacts: chat — no on-disk artifacts under the local lane.
- Source: planner reflection block emitted by `/codebase-planner` in
  this session, two bullets:
  - bullet-1: `AgentMiniTerminal.tsx` — restore `initRunRef` +
    `isCurrentRun()` per-effect-run guard
  - bullet-2: `collaboratorStore.ts::addAgent` — `sessionId`
    idempotency

(Note: the prior `implementation-report.md` on `dev@5fdefab` documented
the peer-context-mirror feature's session 6. This run is a separate
local-lane bug fix, so this file is overwritten with the fix-specific
report. The peer-context-mirror narrative is preserved in `git log` on
the implementer-system merges `9b8b463`…`5fdefab` and their individual
session reports.)

## Work queue summary

- Total items: 2 (chat bullets)
- Completed: 2
- Blocked: 0
- Source-hash: N/A (chat-only planner output)

## Files changed

- `src/components/collaborator/AgentMiniTerminal.tsx` (+41 / -14)
- `src/stores/collaboratorStore.ts` (+13 / -0)

## Validation

- Baseline exit (BASE_BRANCH HEAD `dev@5fdefab`): 0
- Final validation command: `npx tsc --noEmit && npm test`
- Final exit: 0
- Auto-fix attempts used: **0 / 3** (clean first pass)
- `tsc --noEmit`: exit 0, no errors
- `npm test`: **216 / 216 pass** in 12 test files, 1.58s
  - `collaboratorStore.test.ts` already exercises `addAgent` ordinal
    minting in three places (lines 2593, 2617, 2623). All pass — the
    new dedup early-return never fires on legitimate calls because
    each test uses a distinct sessionId.

## Per-item outcomes

| item_id | status | files_touched | notes |
|---|---|---|---|
| bullet-1 | completed | `AgentMiniTerminal.tsx` | Added `initRunRef = useRef(0)` declaration. At spawn useEffect entry: `const runId = ++initRunRef.current;` BEFORE `disposed.current = false;` (order load-bearing — see commit message). Defined `const isCurrentRun = () => !disposed.current && initRunRef.current === runId;`. Converted all 14 post-await `disposed.current` checks inside the spawn useEffect to `isCurrentRun()` (with appropriate negation). Added explicit `if (!isCurrentRun()) return;` guard immediately BEFORE the `addAgent` call site at the bug's source. Changed `handlePtyExit({disposed: ...})` opts.disposed to `!isCurrentRun()` so stale pty-exit listeners bail with correct semantics. Cleanup's `disposed.current = true;` at the bottom of the effect kept as-is — together with the runId bump on next effect entry, that's the full disposal signal. |
| bullet-2 | completed | `collaboratorStore.ts` | Added `if (get().agents.some(a => a.sessionId === raw.sessionId)) return;` at the top of `addAgent`. Defense in depth — protects against any future caller, not just the StrictMode path. Also avoids burning an extra `nextOrdinal` slot on the duplicate call (which would create a numbering gap). |

## Scope-discipline self-check

- [x] No new interfaces / files outside hints — touched only the two files the planner bullets named
- [x] No renames of committed public names — `addAgent` signature unchanged; `isCurrentRun` is a local closure helper
- [x] No signature changes on planner-committed methods — N/A (local lane; not a method-body fill)
- [x] No edits to validation_command configuration — `package.json` / `tsconfig.json` untouched
- [x] No edits to files outside the work queue's hint set — diff stat confirms exactly 2 files
- [x] Pattern matches pre-`69ca18b` shipping code — `git log -L` shows the exact `initRunRef`/`isCurrentRun()` shape we just restored

## Bug history (for the audit trail)

- **Pre-existing**: the duplicate-agent race was not introduced by the
  recent peer-context-mirror merges (sessions 1–6, commits
  `9b8b463…5fdefab`). My session-6 added
  `reserveOrdinalForPeerContext` to `collaboratorStore.ts` but did not
  touch `AgentMiniTerminal.tsx`; the StrictMode race has existed
  since commit `69ca18b` ("Revert worktree feature") collaterally
  removed the runId guard along with the worktree-feature revert.
- **Dev-only symptom**: production builds (`npm run tauri:build`)
  don't run StrictMode's double-mount. Only `npm run tauri dev`
  exposes the race. End users running shipped releases were never
  affected; only contributors running locally would see the
  duplicate panes.
- **Why I caught it now**: the user reported `[Process exited]` +
  `bug` symptoms; investigation revealed that "duplicate mini-agents"
  was the actual surface. The git archaeology via `git log -L
  109,113:src/components/collaborator/AgentMiniTerminal.tsx` pointed
  directly at `69ca18b` as the regression-introducing commit.

## Commits on `implementer/fix-strictmode-agent-dup-08978-7591-14679`

```
c071745 fix(implementer): restore StrictMode runId guard + addAgent idempotency for duplicate-mini-agent bug
```

Branched off `dev@5fdefab`.

## Recommended response at Phase 6

**`confirm merge`** — the fix is small, targeted, restores a
previously-shipping pattern visible in git history, passes both
type-check and the full 216-test suite, and addresses a concrete
reported bug.

After merge, downstream marker `(impl-local, human-confirmed)` will
land in `git log` and the duplicate-agent dev-only race is closed.
