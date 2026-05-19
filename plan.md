# Feature plan — cluster-h-agent-lifecycle

Wires AgentMiniTerminal's spawn-and-publish lifecycle to the
peer-context-mirror infrastructure built in sessions 1-6 + cycle A.
After this lands, an agent that flips `publishOptedIn=true` will
have its CLI transcript actually mirrored into the
`~/.cache/canvas-terminal/collab-memory/session-<pid>/contexts/<handle>.jsonl`
path the Rust runtime already supports.

This is **cycle B** of the Cluster H follow-up — pure TypeScript;
no Rust changes. Cycle A (`854341b`) cleared the Rust prerequisites
(`watch_transcript` takes `session_id`, `spawn_shell` body wires
`extra_env`). Cycle C (publish-toggle UI + PeerContextPanel mount +
breadcrumb wiring) is the final piece after this.

## Goal

Convert the existing peer-context-mirror infrastructure from "built
but unwired" to "wired and exercised". Specifically: every
AgentMiniTerminal spawn flows through the reservation lifecycle
(`reserveAgentHandle` → spawn with `extra_env` → `consumeReservation`
or `releaseReservation`), and every agent record carries a
`publishOptedIn` flag that gates whether a transcript watch is active.

## In scope

- **types/collaborator.ts** — add `publishOptedIn: boolean` to
  `SpawnedAgent`; add optional `handle?: string` to `SpawnedAgentInit`
  (overrides the store's `nextOrdinal` mint when present, required
  for reservation-pre-minted handles).
- **collaboratorStore.ts** —
  - `addAgent`: skip `nextOrdinal` when `raw.handle` is present; use
    the supplied handle directly. Backward compatible for callers
    that omit the field.
  - New action `setPublishOptedIn(sessionId: string, value: boolean): void`
    that flips the flag on the matching `SpawnedAgent` record. The
    UI in cycle C consumes this; cycle B just provides the action.
- **src/lib/peerContext.ts::consumeReservation** — change return type
  from `void` to `AgentHandleReservation` (the same shape
  `reserveAgentHandle` returned). Closes session 6's documented
  "aspirational" deviation: the docstring's intent was for
  consumeReservation to enable the agent push, and returning the
  reservation data accomplishes that without coupling peerContext
  directly to the store.
- **AgentMiniTerminal.tsx** — spawn-lifecycle refactor:
  - BEFORE invoke('spawn_process')/invoke('spawn_shell'):
    `const reservation = reserveAgentHandle(collabSessionId, tool.id)`.
  - Build `extraEnv = { [ENV_AGENT_ID]: reservation.handle,
    [ENV_COLLAB_SESSION_ID]: collabSessionId }` (using the typed
    constants from `types/peerContext.ts`) and pass to BOTH
    spawn_process and spawn_shell invoke args. Both now accept
    `extra_env` end-to-end (cycle A wired spawn_shell's body).
  - On spawn success: `const claimed = consumeReservation(
    reservation.reservationId)` → `addAgent({ sessionId, tool: tool.id,
    status: "spawning", collabSessionId, handle: claimed.handle,
    publishOptedIn: false })`. Wrap the addAgent call in the existing
    `isCurrentRun()` guard (StrictMode race protection from
    fix-strictmode-agent-dup).
  - On spawn failure (caught Err from invoke):
    `releaseReservation(reservation.reservationId)`. Two paths today:
    the shell-fallback catch (`spawnedViaShell = true` then catch
    `shellErr`) AND the upstream invoke('spawn_process') Err. Both
    must call release before returning.
- **AgentMiniTerminal.tsx** — watch-lifecycle useEffect (new):
  Reactive on `(sessionId, agent?.handle, agent?.publishOptedIn,
  agent?.status)`. When `status === "running" && publishOptedIn ===
  true` → `invoke('watch_transcript', { sessionId, agentHandle:
  agent.handle, tool: tool.id, spawnedAtUnixMs: Date.now() })` →
  store returned token (u64 number) in a `useRef<number | null>`.
  On dependency change to "should not be watching" OR on unmount →
  `invoke('unwatch_transcript', { token: storedToken })`. Both
  invokes `.catch(() => {})` per the watcher's idempotent contract.
  Guard with `isCurrentRun()` (the same per-effect-run pattern
  fix-strictmode-agent-dup introduced).

## Out of scope

- **Publish-toggle UI** — the visual control that calls
  `setPublishOptedIn`. Cycle C decides UX placement (header? menu?
  hover?).
- **PeerContextPanel mount point** — where in the UI peers' contexts
  surface. Cycle C.
- **`hasContextsBreadcrumb` wiring** into the prompt-header builder.
  Cycle C.
- **Migration of existing `addAgent` callers in tests
  (`collaboratorStore.test.ts`)** — they currently omit `handle`,
  which becomes the no-op default behavior; tests pass unchanged.
- **Rust changes** — already done in cycle A.

## Constraints

- `publishOptedIn` defaults to **false** per architecture success
  criterion "Default visibility OFF on session start".
- `extraEnv` keys use the EXACT constants from `types/peerContext.ts`
  (`ENV_AGENT_ID = "CT_AGENT_ID"`, `ENV_COLLAB_SESSION_ID =
  "CT_COLLAB_SESSION_ID"`). Don't hardcode the literals; import them.
- The watch useEffect MUST be guarded by `isCurrentRun()` so
  StrictMode's double-mount doesn't race on watch/unwatch calls
  (would leak tokens or fire duplicate watches).
- `reserveAgentHandle` is synchronous and runs BEFORE the spawn IPC.
  On synchronous throw (e.g. unknown collabSessionId), spawn doesn't
  fire and the existing "spawn failed" error path renders naturally.
- `consumeReservation`'s new return type requires updating its own
  internal docstring + the 1 call site (which doesn't exist yet —
  this is the first caller).
- `addAgent`'s new `handle?` optional field: when present, skip the
  `nextOrdinal` mint. Don't fall back to `nextOrdinal` if the
  caller's handle conflicts with an existing handle in the store —
  surface as a no-op (sessionId idempotency from
  fix-strictmode-agent-dup already prevents duplicate inserts) or
  log a warning.

## Success criteria

- `tsc --noEmit` exits 0 after the implementer cycle lands.
- `npm test` exits 0 with the existing **216-test suite passing
  unchanged**. The new `addAgent.handle` optional field is
  backward-compatible (existing tests omit it).
- Manual smoke after cycle B + a temporary DevTools-driven toggle:
  - Spawn a Claude agent in a collab pane. Observe
    `useCollaboratorStore.getState().agents` — the new record has
    `publishOptedIn: false, handle: "claudeN"` (handle minted by
    `reserveAgentHandle` pre-spawn; matches what `nextOrdinal` would
    have produced).
  - From DevTools: `useCollaboratorStore.getState()
    .setPublishOptedIn(<sessionId>, true)`. Observe a new file
    appearing at
    `~/.cache/canvas-terminal/collab-memory/session-<PID>/contexts/claudeN.jsonl`
    within a few seconds of CLI activity.
  - Flip back to `false`. Observe no further writes to that file.
- Spawned CLI process inherits `CT_AGENT_ID=<handle>` and
  `CT_COLLAB_SESSION_ID=<collabSessionId>` in its env (verifiable via
  the CLI dumping env, or by `lsof -p <child_pid>` showing the env
  vars).
- Toggle works across React.StrictMode dev double-mount without
  duplicate watch tokens or token leaks (`isCurrentRun` guard
  catches stale closures).

## Open questions

None requiring user input. All design decisions are settled:
- `publishOptedIn` default = false (architecture criterion)
- `extraEnv` constants imported from `types/peerContext.ts`
- `consumeReservation` return type change is the cleanest path to
  close the session-6 docstring deviation
- `addAgent` handle-skip-mint shape is backward compatible

## Package layout

No new packages introduced — feature lives entirely in existing
files within `src/`.

```
src/
├── types/collaborator.ts                   [MODIFIED] +2 fields (publishOptedIn, handle?)
├── stores/collaboratorStore.ts             [MODIFIED] +setPublishOptedIn, addAgent handle branch
├── lib/peerContext.ts                      [MODIFIED] consumeReservation return type
└── components/collaborator/
    └── AgentMiniTerminal.tsx               [MODIFIED] spawn-lifecycle refactor + watch useEffect
```

Dependency direction (already in shape; cycle B just adds usage edges):

```
AgentMiniTerminal.tsx → peerContext.ts (reserve / consume / release)
                     → collaboratorStore.ts (addAgent, setPublishOptedIn)
                     → tauri.invoke (watch_transcript / unwatch_transcript)
peerContext.ts       → collaboratorStore.ts (reserveOrdinalForPeerContext)
collaboratorStore.ts → types/collaborator.ts (SpawnedAgent, SpawnedAgentInit)
```

No new circular dependencies.

## Decomposition

| Node # | Stage | Interface / Module | Method / Function / Action | Belongs to package |
|---|---|---|---|---|
| 1 | Type extension | `types/collaborator.ts` | `SpawnedAgent.publishOptedIn` + `SpawnedAgentInit.handle?` | `src/types/` |
| 2 | Store action: opt-in flag setter | `collaboratorStore.ts` | `setPublishOptedIn(sessionId, value)` | `src/stores/` |
| 3 | Store action: addAgent with pre-minted handle | `collaboratorStore.ts` | `addAgent` (modified — skip `nextOrdinal` when `raw.handle` present) | `src/stores/` |
| 4 | Reservation consumer return shape | `src/lib/peerContext.ts` | `consumeReservation` (modified — return `AgentHandleReservation`) | `src/lib/` |
| 5 | Spawn-lifecycle: pre-spawn reservation | `AgentMiniTerminal.tsx` spawn useEffect | `reserveAgentHandle(collabSessionId, tool.id)` BEFORE invoke('spawn_*') | `src/components/collaborator/` |
| 6 | Spawn-lifecycle: extra_env injection | `AgentMiniTerminal.tsx` spawn useEffect | Build `extraEnv = { CT_AGENT_ID, CT_COLLAB_SESSION_ID }` and pass to both spawn_process and spawn_shell invokes | `src/components/collaborator/` |
| 7 | Spawn-lifecycle: consume on success | `AgentMiniTerminal.tsx` spawn useEffect | `consumeReservation` → `addAgent({..., handle, publishOptedIn: false})` (guarded by `isCurrentRun()`) | `src/components/collaborator/` |
| 8 | Spawn-lifecycle: release on failure | `AgentMiniTerminal.tsx` spawn useEffect catch blocks | `releaseReservation(reservation.reservationId)` in shell-fallback failure AND outer catch | `src/components/collaborator/` |
| 9 | Watch-lifecycle: start | `AgentMiniTerminal.tsx` new useEffect | `invoke('watch_transcript', { sessionId, agentHandle, tool, spawnedAtUnixMs })` → store token in `useRef`; guarded by `isCurrentRun()` + `agent.publishOptedIn && agent.status==='running'` | `src/components/collaborator/` |
| 10 | Watch-lifecycle: stop | `AgentMiniTerminal.tsx` new useEffect cleanup + on flag flip | `invoke('unwatch_transcript', { token })` on unmount, on `publishOptedIn` flip false, or on status leaving 'running' | `src/components/collaborator/` |

See `plan.mmd` for the DAG visualization.

## Interfaces emitted

This feature lane run does **not** emit interface skeletons (per the
user's `confirm scale` without `emit skeletons`). The interface
changes (additive field on `SpawnedAgent`/`SpawnedAgentInit`,
additive action on store, return-type change on
`consumeReservation`) are documented in the In-scope section above
and implemented directly during the downstream `/codebase-implementer`
run.

## Validation

Phase 6 was skipped (no compile target for plan-only feature lane).
Phase 7 smoke check:

- `plan.md` is non-empty and contains `## Goal`, `## Package layout`,
  `## Decomposition` headers
- `plan.mmd` first line is `graph LR` (valid Mermaid)

Both pass — see Phase 8 below.

Downstream implementer validation command:
`tsc --noEmit && npm test`
Expected: exit 0, all 216 tests pass.
