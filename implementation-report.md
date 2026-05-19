# Implementation report — cluster-h-agent-lifecycle

## Source

- Planner marker: **feature** from commit `da578b2` (`(plan-feature, human-confirmed)`)
- Planner artifacts: `plan.md` + `plan.mmd` on `dev`
- Source hash: based on the 11486-byte `plan.md` + 721-byte `plan.mmd`
  at `da578b2`; not re-extracted within this run

(Prior `implementation-report.md` on `dev@854341b` documented
`cluster-h-prep-rust-bridge` cycle A. Overwritten with this cycle B
report; historical content reachable via git log on the prior merge.)

## Work queue summary

- Total items: 10 (decomposition table in `plan.md`)
- Completed: 10
- Blocked: 0

## Files changed

- `src/types/collaborator.ts` (+25 / -1) — `SpawnedAgentInit.handle?`, `SpawnedAgentInit.publishOptedIn?`, `SpawnedAgent.publishOptedIn?` (matched optional)
- `src/stores/collaboratorStore.ts` (+50 / -10) — `setPublishOptedIn` action interface + impl, `addAgent` handle-override + publishOptedIn-default branch
- `src/lib/peerContext.ts` (+20 / -8) — `consumeReservation` return type widened from void → AgentHandleReservation, body returns the reservation data
- `src/components/collaborator/AgentMiniTerminal.tsx` (+95 / -10) — reservation lifecycle + extraEnv injection + watch useEffect

## Validation

- Baseline exit (BASE_BRANCH HEAD `dev@da578b2`): 0
- Final validation command: `npx tsc --noEmit && npm test`
- Final exit: 0
- **Auto-fix attempts used: 1 / 3**
  - Attempt 1: 20 TS type errors in `collaboratorStore.test.ts` —
    test fixtures construct `SpawnedAgent` literals directly
    (bypassing `addAgent`), so the initially-required
    `publishOptedIn` on the materialized type broke them. Resolved
    by relaxing `SpawnedAgent.publishOptedIn` to optional, with
    reader-side `=== true` discipline (matches the
    `publishOptedIn ?? false` semantic). Validation cleared on the
    retry.
- `tsc --noEmit`: exit 0, no errors
- `npm test`: **216 / 216 pass** in 12 test files, 1.57s
  - `collaboratorStore.test.ts`'s 15+ `SpawnedAgent`-literal fixtures
    unchanged — the optional-on-materialized type lets them compile
    without `publishOptedIn: false` boilerplate

## Per-item outcomes

| item_id | status | files_touched | notes |
|---|---|---|---|
| T1 | completed | `types/collaborator.ts` | Both `handle?` and `publishOptedIn?` are optional on init AND on materialized record (auto-fix attempt 1 made the latter optional too). Reader-side discipline: check `=== true` for opt-in. |
| S2 | completed | `collaboratorStore.ts` | `setPublishOptedIn` action with reference-equality preservation (skip set when value matches) to avoid React rerenders on idempotent writes. |
| S3 | completed | `collaboratorStore.ts` | `addAgent` extracts ordinal from trailing digits of `raw.handle` when present (defensive fallback to `nextOrdinal` if handle doesn't end in digits); defaults `publishOptedIn` to `false` when omitted from init. |
| P4 | completed | `lib/peerContext.ts` | `consumeReservation` return type void → `AgentHandleReservation`; body returns the entry's data after removing from registry. |
| L5 | completed | `AgentMiniTerminal.tsx` | `reserveAgentHandle(collabSessionId, tool.id)` called BEFORE the spawn IPC; synchronous-throw path renders the existing "Failed to reserve handle" message. |
| L6 | completed | `AgentMiniTerminal.tsx` | `extraEnv = { [ENV_AGENT_ID]: reservation.handle, [ENV_COLLAB_SESSION_ID]: collabSessionId }` using imported constants; passed to both `spawn_process` and `spawn_shell` invokes. |
| L7 | completed | `AgentMiniTerminal.tsx` | `consumeReservation(reservation.reservationId)` returns the reserved data; `addAgent` called with `handle: claimed.handle, publishOptedIn: false`. Guarded by the existing `isCurrentRun()` pattern; on StrictMode-dispose-mid-flight, calls `releaseReservation` before bailing. |
| L8 | completed | `AgentMiniTerminal.tsx` | `releaseReservation(reservation.reservationId)` in two places: shell-fallback catch block AND the `isCurrentRun()`-false bail after spawn-success. |
| W9 | completed | `AgentMiniTerminal.tsx` | New useEffect reactive on `(sessionId, agentHandle, isRunning, isPublishing, toolId)`. When all conditions hold, `invoke('watch_transcript', { sessionId, agentHandle, tool: toolId, spawnedAtUnixMs: Date.now() })` and stash returned token in `watchTokenRef`. |
| W10 | completed | `AgentMiniTerminal.tsx` | Same useEffect's cleanup unwatches stashed token. Handles the promise-resolves-after-cleanup race via an `unmounted` flag in the `.then()` callback (releases the late-arriving token immediately). |

## Scope-discipline self-check

- [x] No new interfaces / files outside hints — touched only the 4 files the planner-decomposition table named
- [x] No renames of committed public names — all changes are additive (`handle?`, `publishOptedIn?` on init/agent types; new `setPublishOptedIn` action; `consumeReservation` return-type WIDENING — backward compatible for callers that ignored the previous `void` return)
- [x] No signature changes on planner-committed methods — `consumeReservation` signature change WAS planner-committed in `plan.md`'s In-scope section (item P4)
- [x] No edits to `validation_command` configuration — `package.json`/`tsconfig.json` untouched
- [x] No edits to files outside the work queue's hint set — diff stat confirms exactly 4 files
- [x] Test fixture migration via type-relax (vs. mass test-edit) honors the planner's "tests pass unchanged" promise

## Architecture-pattern notes

- **isCurrentRun() guard everywhere a stale closure could mutate
  shared state**: the spawn-lifecycle now has 3 guarded checkpoints
  (pre-spawn after reserveAgentHandle, post-spawn before addAgent,
  inside addAgent's own pre-flight). Cleanup of stale reservations
  on dispose prevents the strictmode-fix's "dup agent" pattern from
  also producing leaked reservation slots.
- **Watch useEffect is a separate effect** (no `isCurrentRun()`
  required). React's mount→cleanup→mount ordering for separate
  effects with shared dependencies handles StrictMode correctly: the
  cleanup fires unwatch_transcript before the remount's
  watch_transcript fires. Idempotency of the Rust-side
  TranscriptWatcher::unwatch (Q6 contract) makes any minor races
  harmless.
- **Reference-equality preservation in `setPublishOptedIn`** matters
  for React performance: cycle C will wire a click handler that may
  re-fire with the same value (e.g. user clicks "on" while already
  "on"); without the early-return, every click would trigger a
  re-render of every component reading the agents array.

## Bug history (for the audit trail)

- **Planner's "tests pass unchanged" promise**: held with one
  modification — `SpawnedAgent.publishOptedIn` had to become
  optional too (in addition to `SpawnedAgentInit.publishOptedIn`).
  The planner reasoned that since `addAgent` would default the value,
  no caller would need to specify it. The planner missed that 15+
  test fixtures construct `SpawnedAgent` literals DIRECTLY (bypassing
  `addAgent`), where the materialized-record type's required field
  bites them. Auto-fix attempt 1 made the field optional on the
  materialized record too — production paths still set it (false at
  spawn; true/false via `setPublishOptedIn`), but the type allows
  `undefined` for fixture flexibility.
- **`reservation` variable scope**: the original spawn flow had
  `spawnedViaShell` declared at function scope but I needed
  `reservation` available across the success and failure code paths.
  Used `let reservation: ... | undefined` with explicit
  `reservation = ...` inside the try-block initializer per TS
  flow-narrowing — works cleanly.

## Commits on `implementer/cluster-h-agent-lifecycle-50550-28068-9344`

```
6a60d11 feat(implementer): items T1-W10 — cycle B AgentMiniTerminal lifecycle + reservation wiring
```

Branched off `dev@da578b2`.

## Recommended response at Phase 6

**`confirm merge`** — the fix completes the cycle B plan, validates
cleanly (216/216 tests pass), and unblocks cycle C (publish-toggle
UI + PeerContextPanel mount + breadcrumb wiring — all pure UI work
on top of the now-real lifecycle).

After merge, downstream marker `(impl-feature, human-confirmed)`
lands. The peer-context-mirror feature is then **runtime-wired
end-to-end** modulo only the missing UI affordance — a DevTools
`setPublishOptedIn(sessionId, true)` call after spawn will trigger
real transcript mirroring into
`~/.cache/canvas-terminal/collab-memory/session-<PID>/contexts/<handle>.jsonl`.
