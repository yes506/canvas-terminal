// Frontend reader helpers for cross-tool agent context surfacing.
//
// Wraps the scoped memory facade (`scopedMemoryIpc`) into a typed shape
// consumed by `PeerContextPanel`. Per Q3 the reader makes TWO separate
// `readMemoryFile` calls (active + last archive), each ≤ 8 MB by rotation
// cap, well under the 10 MB read cap — concat happens client-side.
//
// Session-scope: peer-context mirror files live at
// `session-<pid>/<collabSessionId>/contexts/<agent>.jsonl`. Every facade
// call is rooted at the session subtree by the RUST side (single source of
// truth for id sanitization), so the reader composes only session-RELATIVE
// `contexts/…` paths — the former TS `sanitizeCollabSessionId` mirror is
// deleted, eliminating the raw-vs-Rust sanitize drift surface entirely.

import {
  NORMALIZED_SCHEMA_VERSION,
  type AgentHandleReservation,
  type NormalizedTurn,
  type PeerContextSnapshot,
} from "../types/peerContext";
import type { ToolId } from "../types/collaborator";
import {
  reserveOrdinalForPeerContext,
  toolShortName,
} from "../stores/collaboratorStore";
import { scopedMemoryIpc } from "./scopedCollabMemory";

// ---------------------------------------------------------------------------
// Cluster F — reservation API
// ---------------------------------------------------------------------------
//
// The reservation registry is module-private (one per browser process); it
// holds the (handle, collabSessionId, tool) tuple between reserve and
// consume/release. Reservations are pre-spawn ephemera — they don't live
// in zustand state because (a) they're short-lived, (b) the actual
// SpawnedAgent push goes through `collaboratorStore.addAgent` after the
// spawn IPC resolves.

interface ReservationEntry {
  handle: string;
  collabSessionId: string;
  tool: ToolId;
}

const reservationRegistry = new Map<string, ReservationEntry>();

/**
 * Mint a fresh reservation id. Browser-side `crypto.randomUUID` is
 * available in all modern Chromium / WebKit; the WebView Tauri ships
 * with on macOS supports it.
 */
function mintReservationId(): string {
  return crypto.randomUUID();
}

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
  collabSessionId: string,
  tool: ToolId,
): AgentHandleReservation {
  const ordinal = reserveOrdinalForPeerContext(collabSessionId, tool);
  const short = toolShortName(tool);
  const handle = `${short}${ordinal}`;
  const reservationId = mintReservationId();
  reservationRegistry.set(reservationId, { handle, collabSessionId, tool });
  return { reservationId, handle, collabSessionId, tool };
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
export function releaseReservation(reservationId: string): void {
  // Idempotent: unknown id is a silent no-op.
  // Per docstring's "MAY reuse" — we don't roll back the ordinal counter
  // (the slot becomes a numbering gap, which is acceptable). Reusing
  // would require tracking "most recently issued" per (collabSessionId,
  // tool) and rolling back only if the released ordinal matches; the
  // gap-vs-strict-reuse trade-off is the simpler choice the docstring's
  // "MAY" permits.
  reservationRegistry.delete(reservationId);
}

/**
 * Consume a reservation on successful spawn — clears the reservation
 * slot and returns the reserved (handle, collabSessionId, tool) so the
 * caller can pass `handle` into `collaboratorStore.addAgent` (which
 * skips the `nextOrdinal` mint when `raw.handle` is present, keeping
 * the post-spawn store record aligned with the pre-spawn env-injected
 * `CT_AGENT_ID`).
 *
 * Inputs: `reservationId`.
 *
 * Returns: the `AgentHandleReservation` shape that `reserveAgentHandle`
 * originally returned. Cycle B widened this from `void` so the
 * follow-on `addAgent` call site has the reserved handle without
 * needing to thread it through component state separately.
 *
 * Errors: throws if the `reservationId` is unknown or has already been
 * consumed (release is irreversible).
 *
 * Side effects: removes the reservation entry from the module-private
 * registry. The actual `addAgent` push into `collaboratorStore.agents`
 * is still the calling code's responsibility — `consumeReservation`
 * doesn't have access to the post-spawn state (sessionId, status,
 * cwd) under the planner-committed input shape. Returning the
 * reservation data lets the caller build the SpawnedAgentInit with
 * the reserved handle in one expression.
 *
 * Invariants: post-consume, the handle used cannot be reissued by a
 * fresh reservation in the same pane/tool (the agent now owns it for
 * its lifetime). The agent's `handle` field equals the reserved handle.
 *
 * Concurrency: serialized within the JS event loop.
 *
 * Lifecycle: called from `AgentMiniTerminal` after the spawn IPC
 * resolves successfully.
 *
 * Test contract: consuming an unknown id throws. Consuming a previously-
 * released id throws. The returned object equals the
 * `AgentHandleReservation` value originally returned by
 * `reserveAgentHandle`.
 */
export function consumeReservation(
  reservationId: string,
): AgentHandleReservation {
  const entry = reservationRegistry.get(reservationId);
  if (!entry) {
    throw new Error(
      `consumeReservation: unknown or already-consumed reservationId ${reservationId}`,
    );
  }
  reservationRegistry.delete(reservationId);
  return {
    reservationId,
    handle: entry.handle,
    collabSessionId: entry.collabSessionId,
    tool: entry.tool,
  };
}

// ---------------------------------------------------------------------------
// Cluster E — reader helpers
// ---------------------------------------------------------------------------

/**
 * Parse a JSONL string into `NormalizedTurn[]`. Tolerant of trailing
 * newline; drops malformed lines silently (matches the Rust-side
 * adapter contract of "parse failures are still consumed" — readers
 * defend in symmetry). Enforces R3 forward-compat: any record whose
 * `normalized_schema_version` exceeds the frontend constant throws.
 */
function parseJsonlNormalizedTurns(text: string): NormalizedTurn[] {
  const out: NormalizedTurn[] = [];
  for (const rawLine of text.split("\n")) {
    if (rawLine.length === 0) continue;
    let obj: unknown;
    try {
      obj = JSON.parse(rawLine);
    } catch {
      continue;
    }
    if (typeof obj !== "object" || obj === null) continue;
    const turn = obj as NormalizedTurn;
    if (
      typeof turn.normalized_schema_version === "number" &&
      turn.normalized_schema_version > NORMALIZED_SCHEMA_VERSION
    ) {
      throw new Error(
        `transcript schema version ${turn.normalized_schema_version} unsupported; update Canvas Terminal`,
      );
    }
    out.push(turn);
  }
  return out;
}

/**
 * Derive whether the conditional `contexts/` breadcrumb belongs in the
 * prompt header.
 *
 * Per K2 (cumulative fold): the existing  * no prefix arg; the conditional check is implemented client-side by
 * filtering the full file list. No new IPC needed.
 *
 * Returns: `Promise<boolean>` — true iff any file under
 * `contexts/` (i.e. `contexts/<agent>.jsonl`
 * or any archive) exists in the current session's memory dir. PeerContextPanel
 * binds this to its visibility
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
 * Inputs: `collabSessionId` — scopes the check to THIS session's subdir.
 * `null` returns `false` (no session → nothing to surface). Without the
 * session segment a bare `startsWith("contexts/")` would cross-session
 * over-report any other session's mirror files, since `list_memory_files`
 * walks the memory dir recursively (plan N13/N14, claude3 finding).
 *
 * Test contract: empty session returns `false`; presence of
 * `contexts/<session>/<agent>.jsonl` returns `true`; presence of only
 * `contexts/<session>/<agent>.1.jsonl` (archive without active) still returns
 * `true`; a DIFFERENT session's `contexts/<other>/<agent>.jsonl` returns
 * `false`.
 */
export async function hasContextsBreadcrumb(
  collabSessionId: string | null,
): Promise<boolean> {
  if (!collabSessionId) return false;
  // The scoped list is already rooted at THIS session's subtree, so the
  // returned paths are session-relative — the mirror dir is plain
  // `contexts/` with no session segment to re-derive client-side.
  const prefix = "contexts/";
  try {
    const files = await scopedMemoryIpc.listMemoryFiles(collabSessionId);
    return files.some((f) => f.startsWith(prefix));
  } catch {
    return false;
  }
}

/**
 * Load the active mirror file for a peer agent.
 *
 * Per Q3: this is a single
 * `read_memory_file('contexts/<agent>.jsonl')` call; the file
 * is ≤ 8 MB by rotation cap (well under 10 MB read cap).
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
  agentHandle: string,
  collabSessionId: string,
): Promise<NormalizedTurn[]> {
  const relative = `contexts/${agentHandle}.jsonl`;
  const text = await scopedMemoryIpc.readMemoryFile(collabSessionId, relative);
  if (text === null) {
    return [];
  }
  return parseJsonlNormalizedTurns(text);
}

/**
 * Load the most-recent rolled archive
 * (`contexts/<agent>.<N>.jsonl`).
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
  agentHandle: string,
  archiveN: number,
  collabSessionId: string,
): Promise<NormalizedTurn[]> {
  const relative = `contexts/${agentHandle}.${archiveN}.jsonl`;
  const text = await scopedMemoryIpc.readMemoryFile(collabSessionId, relative);
  if (text === null) {
    return [];
  }
  return parseJsonlNormalizedTurns(text);
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
 * `^contexts/<agentHandle>\.(\d+)\.jsonl$`; ignores malformed
 * names.
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
export async function listArchives(
  agentHandle: string,
  collabSessionId: string,
): Promise<number[]> {
  let files: string[];
  try {
    files = await scopedMemoryIpc.listMemoryFiles(collabSessionId);
  } catch {
    return [];
  }
  // RegExp.escape isn't widely shipped; escape manually for the
  // backslash-and-dot characters that could appear in an agent handle
  // (in practice handles are `[a-z]+\d+` so this is defensive).
  const escapedHandle = agentHandle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // The scoped list is rooted at THIS session's subtree, so cross-session
  // matches are structurally impossible and the pattern needs no session
  // segment — sibling agents' archives are still excluded by the handle.
  const pattern = new RegExp(
    `^contexts/${escapedHandle}\\.(\\d+)\\.jsonl$`,
  );
  const indices: number[] = [];
  for (const f of files) {
    const m = f.match(pattern);
    if (m) {
      const n = parseInt(m[1], 10);
      if (Number.isFinite(n)) {
        indices.push(n);
      }
    }
  }
  indices.sort((a, b) => a - b);
  return indices;
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
  agentHandle: string,
  collabSessionId: string,
): Promise<PeerContextSnapshot> {
  const indices = await listArchives(agentHandle, collabSessionId);
  const activePromise = loadActive(agentHandle, collabSessionId);
  const lastArchivePromise =
    indices.length > 0
      ? loadLastArchive(agentHandle, indices[indices.length - 1], collabSessionId)
      : Promise.resolve<NormalizedTurn[]>([]);

  // Errors from either read (schema-version, IPC) propagate. Q3 contract:
  // both reads ≤ 8 MB by rotation cap, well under the 10 MB read cap.
  const [active_turns, last_archive_turns] = await Promise.all([
    activePromise,
    lastArchivePromise,
  ]);

  return {
    agent_handle: agentHandle,
    active_turns,
    last_archive_turns,
    archivesBeyondWindow: Math.max(0, indices.length - 1),
  };
}
