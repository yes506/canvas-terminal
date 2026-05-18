// Frontend reader helpers for cross-tool agent context surfacing.
//
// Wraps `read_memory_file` / `list_memory_files` Tauri IPC into a typed
// shape consumed by `PeerContextPanel`. Per Q3 the reader makes TWO
// separate `read_memory_file` calls (active + last archive), each ≤ 8 MB
// by rotation cap, well under the 10 MB read cap — concat happens
// client-side.

import type {
  AgentHandleReservation,
  NormalizedTurn,
  PeerContextSnapshot,
} from "../types/peerContext";
import type { ToolId } from "../types/collaborator";

/**
 * Reserve a fresh per-pane agent handle BEFORE spawning the PTY.
 *
 * Per K5/W2 (cumulative reviewer fold): the prior shape allocated the
 * handle inside `addAgent()` AFTER spawn succeeded, leaving
 * `AgentMiniTerminal` with no handle to inject at spawn-time. The
 * reservation pattern decouples ordinal allocation from agent activation
 * and supports rollback on spawn failure.
 *
 * Inputs:
 * - `collabSessionId`: the collaborator pane id, matching existing
 *   `nextOrdinal(collabSessionId, tool)` scoping in `collaboratorStore`.
 * - `tool`: ToolId for which to mint a handle.
 *
 * Returns:
 * - `AgentHandleReservation` with the locked-in bare handle (e.g. "claude3")
 *   and an opaque `reservationId`. Caller MUST eventually call either
 *   `consumeReservation` (on successful spawn + addAgent) or
 *   `releaseReservation` (on spawn failure) to avoid leaking the ordinal.
 *
 * Errors: throws if the underlying `nextOrdinal` overflows or if the
 * collabSessionId is unknown.
 *
 * Side effects: increments the per-(collabSessionId, tool) ordinal counter
 * via the existing `nextOrdinal` mechanism. The handle is reserved but
 * not yet associated with a running agent.
 *
 * Invariants: distinct reservations for the same (collabSessionId, tool)
 * pair produce distinct ordinals — the existing `nextOrdinal` policy is
 * preserved verbatim.
 *
 * Concurrency: serialized within `collaboratorStore`'s zustand action;
 * concurrent calls from React 18 strict-mode-double-render are safe.
 *
 * Lifecycle: called by `AgentMiniTerminal` BEFORE the spawn IPC. The
 * returned `reservationId` is kept in component state across the spawn
 * promise.
 *
 * Test contract: two reservations from the same pane + tool produce
 * distinct handles. A `releaseReservation` followed by a new reservation
 * MAY reuse the released ordinal — semantics match the existing
 * `nextOrdinal` ledger.
 */
export function reserveAgentHandle(
  _collabSessionId: string,
  _tool: ToolId,
): AgentHandleReservation {
  throw new Error("reserveAgentHandle: not yet implemented (phase 6)");
}

/**
 * Release a reservation on spawn failure.
 *
 * Inputs: `reservationId` returned by a prior `reserveAgentHandle`.
 *
 * Returns: void. Unknown reservation ids are silently ignored
 * (idempotent — mirrors `TranscriptWatcher::unwatch` Q6 discipline).
 *
 * Errors: never throws.
 *
 * Side effects: rolls back the ordinal increment so the next reservation
 * for the same (collabSessionId, tool) reuses this slot.
 *
 * Invariants: post-release, the reservation is invalid and consuming it
 * later is a no-op.
 *
 * Concurrency: serialized within `collaboratorStore`'s zustand action.
 *
 * Lifecycle: called from `AgentMiniTerminal` spawn-failure handler.
 *
 * Test contract: release of an unknown id is a no-op. Release followed by
 * a fresh reservation in the same pane/tool reuses the released ordinal.
 */
export function releaseReservation(_reservationId: string): void {
  throw new Error("releaseReservation: not yet implemented (phase 6)");
}

/**
 * Consume a reservation on successful spawn — promotes it into a running
 * `SpawnedAgent` record.
 *
 * Inputs: `reservationId`.
 *
 * Returns: void. The store's `addAgent()` is called internally with the
 * reserved handle.
 *
 * Errors: throws if the `reservationId` is unknown or has already been
 * consumed.
 *
 * Side effects: pushes a `SpawnedAgent` into the store's `agents` list;
 * unsets the reservation slot.
 *
 * Invariants: post-consume, the handle used cannot be reissued by a fresh
 * reservation (the agent now owns it for its lifetime). The agent's
 * `handle` field equals the reserved handle.
 *
 * Concurrency: serialized within `collaboratorStore`.
 *
 * Lifecycle: called from `AgentMiniTerminal` after the spawn IPC resolves
 * successfully.
 *
 * Test contract: consuming an unknown id throws. Consuming a previously-
 * released id throws (release is irreversible).
 */
export function consumeReservation(_reservationId: string): void {
  throw new Error("consumeReservation: not yet implemented (phase 6)");
}

/**
 * Derive whether the conditional `contexts/` breadcrumb belongs in the
 * prompt header.
 *
 * Per K2 (cumulative fold): the existing `list_memory_files()` IPC takes
 * no prefix arg; the conditional check is implemented client-side by
 * filtering the full file list. No new IPC needed.
 *
 * Returns: `Promise<boolean>` — true iff any file under `contexts/`
 * (i.e. `contexts/<agent>.jsonl` or any archive) exists in the current
 * session's memory dir. PeerContextPanel binds this to its visibility
 * indicator; `prependContextHeader` uses it to conditionally inject the
 * breadcrumb (matching the existing `context.md` conditional pattern).
 *
 * Errors: silent on IPC failure — returns `false` and lets the next
 * prompt-build retry.
 *
 * Side effects: one `list_memory_files` IPC call.
 *
 * Invariants: returning `true` is monotonic within a session lifetime
 * until the user clears the session.
 *
 * Concurrency: caching pattern is up to the caller — `prependContextHeader`
 * is fine with a per-prompt fresh check (cost is one IPC).
 *
 * Lifecycle: called from `prependContextHeader` before each header
 * assembly; from `PeerContextPanel` to decide whether to render at all.
 *
 * Test contract: empty session returns `false`; presence of
 * `contexts/<agent>.jsonl` returns `true`; presence of only
 * `contexts/<agent>.1.jsonl` (archive without active) still returns `true`.
 */
export async function hasContextsBreadcrumb(): Promise<boolean> {
  throw new Error("hasContextsBreadcrumb: not yet implemented (phase 6)");
}

/**
 * Load the active mirror file for a peer agent.
 *
 * Per Q3: this is a single `read_memory_file('contexts/<agent>.jsonl')`
 * call; the file is ≤ 8 MB by rotation cap (well under 10 MB read cap).
 *
 * Inputs: `agentHandle` — bare handle, e.g. "claude3".
 *
 * Returns: array of parsed `NormalizedTurn`. Empty array when the active
 * file does not exist yet.
 *
 * Errors: throws on IPC failure or on a normalized_schema_version higher
 * than the frontend constant (R3 — refuse-to-render policy).
 *
 * Side effects: one `read_memory_file` IPC call.
 *
 * Invariants: each parsed record's `agent_handle` equals the input;
 * records are returned in source order (turn_index ascending within file).
 *
 * Concurrency: idempotent reads; safe to call concurrently with appends
 * from the Rust watcher (the watcher's atomic-write pattern guarantees
 * no torn lines).
 *
 * Lifecycle: called by `PeerContextPanel` on mount and on each fs-event
 * debounce when the panel is visible.
 *
 * Test contract: a file containing turns at indices [0, 1, 3] (where 2
 * was M6-skipped) returns 3 records in order. A non-existent file
 * returns `[]`.
 */
export async function loadActive(
  _agentHandle: string,
): Promise<NormalizedTurn[]> {
  throw new Error("loadActive: not yet implemented (phase 6)");
}

/**
 * Load the most-recent rolled archive (`contexts/<agent>.<N>.jsonl`).
 *
 * Inputs: `agentHandle`, `archiveN` — the integer N selected by
 * `listArchives()`.
 *
 * Returns: array of parsed `NormalizedTurn`s from that archive. Empty if
 * the file does not exist (e.g. N was wrong).
 *
 * Errors: throws on IPC failure or schema-version mismatch.
 *
 * Side effects: one `read_memory_file` IPC call.
 *
 * Invariants: each record's `agent_handle` equals the input; ordering
 * matches source.
 *
 * Concurrency: see `loadActive`.
 *
 * Lifecycle: called by `PeerContextPanel` only when at least one archive
 * exists.
 *
 * Test contract: passing `archiveN` that does not exist returns `[]`.
 */
export async function loadLastArchive(
  _agentHandle: string,
  _archiveN: number,
): Promise<NormalizedTurn[]> {
  throw new Error("loadLastArchive: not yet implemented (phase 6)");
}

/**
 * Enumerate the archive indices on disk for `agentHandle`.
 *
 * Per K2: implemented via `list_memory_files()` + client-side filter.
 *
 * Inputs: `agentHandle`.
 *
 * Returns: sorted-ascending array of archive indices. Empty if no
 * archives yet.
 *
 * Errors: returns `[]` on IPC failure.
 *
 * Side effects: one `list_memory_files` IPC call.
 *
 * Invariants: parsed N values match the file-name regex
 * `^contexts/<agentHandle>\.(\d+)\.jsonl$`; ignores malformed names.
 *
 * Concurrency: idempotent.
 *
 * Lifecycle: called by `PeerContextPanel` on mount; used to pick the
 * `archiveN` for `loadLastArchive` and to compute `archivesBeyondWindow`
 * for the Q4 footer breadcrumb.
 *
 * Test contract: `[1, 2, 5]` is returned for archives 1, 2, 5 present —
 * gaps preserved. Sibling agents' archives are NOT returned.
 */
export async function listArchives(_agentHandle: string): Promise<number[]> {
  throw new Error("listArchives: not yet implemented (phase 6)");
}

/**
 * Compose the two-file snapshot used by PeerContextPanel.
 *
 * Helper that orchestrates `listArchives` + `loadActive` + `loadLastArchive`
 * into the `PeerContextSnapshot` shape the panel expects.
 *
 * Inputs: `agentHandle`.
 *
 * Returns: `PeerContextSnapshot`. `archivesBeyondWindow` is
 * `max(0, listArchives.length - 1)` — Q4 footer breadcrumb count.
 *
 * Errors: throws on schema-version mismatch; returns an empty snapshot
 * shape on IPC failure (graceful degradation).
 *
 * Side effects: 1 list + up to 2 reads, each ≤ 8 MB.
 *
 * Invariants: `last_archive_turns` is empty iff no archives exist. The
 * concatenated view (active + last_archive) covers ≤ 16 MB.
 *
 * Concurrency: stateless; multiple panel mounts can call this concurrently.
 *
 * Lifecycle: called by `PeerContextPanel` per refresh.
 *
 * Test contract: after rotation, snapshot's `last_archive_turns` is
 * non-empty and `archivesBeyondWindow` is 0. After 3 rotations,
 * `archivesBeyondWindow` is 2.
 */
export async function loadSnapshot(
  _agentHandle: string,
): Promise<PeerContextSnapshot> {
  throw new Error("loadSnapshot: not yet implemented (phase 6)");
}
