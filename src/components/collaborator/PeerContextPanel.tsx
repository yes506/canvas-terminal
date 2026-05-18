// PeerContextPanel — frontend surface for cross-tool agent context surfacing.
//
// Renders a peer agent's mirrored transcript (active + last archive,
// ≤ 16 MB rolling window per T2) behind a visual fence (D1 — content is
// UNTRUSTED). Surfacing is human-mediated: NO auto-injection into reader
// prompts. Q4 truncation footer breadcrumb when archives beyond the
// visible window exist.

import type { NormalizedTurn, PeerContextSnapshot } from "../../types/peerContext";

export interface PeerContextPanelProps {
  /** Bare CT handle of the peer whose context to render — e.g. "claude3". */
  agentHandle: string;
  /** Whether the peer is currently publishing (drives the indicator). */
  isPublishing: boolean;
}

/**
 * Component entry point.
 *
 * Inputs: `props.agentHandle`, `props.isPublishing`.
 *
 * Returns: a React node — a fenced container with three sections:
 *   1. publish indicator + agent identity header
 *   2. fenced turn-list (`renderFenced`)
 *   3. truncation footer (`renderTruncationFooter`) when applicable
 *
 * Errors: schema-version mismatches surface a single-line refusal
 * message ("transcript schema version <N> unsupported; update Canvas
 * Terminal") instead of partial content (R3 forward-compat).
 *
 * Side effects: subscribes to the watcher via IPC on mount;
 * unsubscribes on unmount.
 *
 * Invariants: turns are rendered in source order; visual fence is
 * always present even for a single turn.
 *
 * Concurrency: standard React render lifecycle.
 *
 * Lifecycle: mounted when the user opens the panel for a specific peer.
 *
 * Test contract: mounting with `isPublishing=false` shows an empty-state
 * message and does not call `loadSnapshot`. Mounting with
 * `isPublishing=true` calls `loadSnapshot` exactly once on mount and
 * once per debounced fs-event.
 */
export function PeerContextPanel(_props: PeerContextPanelProps): JSX.Element {
  throw new Error("PeerContextPanel: not yet implemented (phase 6)");
}

/**
 * Render the snapshot's turns inside a visual fence.
 *
 * Inputs: `turns` from `PeerContextSnapshot.active_turns ++ last_archive_turns`.
 *
 * Returns: a React node wrapping the turn list in a fenced container
 * (D1 — markdown code-block or sandboxed renderer; never plain markdown
 * that could be injected as prompt).
 *
 * Errors: silently drops malformed records.
 *
 * Side effects: none.
 *
 * Invariants: every turn renders the bare `agent_handle` (no `@` prefix
 * in env-derived data; the visible display layer may add `@` for the
 * peer label but turn metadata is bare).
 *
 * Concurrency: pure.
 *
 * Lifecycle: called per render.
 *
 * Test contract: a turn with `text_visible == ""` MUST NOT appear in
 * the output (empty turns were already skipped at write-time per M6;
 * the reader still defends).
 */
export function renderFenced(_turns: NormalizedTurn[]): JSX.Element {
  throw new Error("renderFenced: not yet implemented (phase 6)");
}

/**
 * Q4 truncation footer breadcrumb.
 *
 * Inputs: `archivesBeyondWindow` from `PeerContextSnapshot`.
 *
 * Returns: a React node containing a single-line text breadcrumb
 * "History truncated — older turns at <session-dir>/contexts/<agent>.0..N-2.jsonl"
 * when `archivesBeyondWindow >= 1`; returns `null` otherwise.
 *
 * Errors: never.
 *
 * Side effects: none.
 *
 * Invariants: presence of the footer iff `archivesBeyondWindow >= 1`;
 * the path shown is exact and copy-pasteable.
 *
 * Concurrency: pure.
 *
 * Lifecycle: called per render of `PeerContextPanel`.
 *
 * Test contract: `0` returns null. `1` returns a node containing the
 * literal substring "History truncated". `5` shows the literal substring
 * "0..3" (oldest 4 archives — i.e. 5 minus the visible last archive).
 */
export function renderTruncationFooter(
  _agentHandle: string,
  _archivesBeyondWindow: number,
): JSX.Element | null {
  throw new Error("renderTruncationFooter: not yet implemented (phase 6)");
}

/**
 * Helper to combine active + last_archive into one render-ready list.
 *
 * Inputs: `snapshot`.
 *
 * Returns: archive-first-then-active concatenation so newest turns
 * appear last (matches scroll-to-bottom natural reading order).
 *
 * Errors: never.
 *
 * Side effects: none.
 *
 * Invariants: returns `last_archive_turns.concat(active_turns)` — the
 * archive's turns precede the active's (turn_index ordering implies this).
 *
 * Concurrency: pure.
 *
 * Lifecycle: called by `PeerContextPanel` before `renderFenced`.
 *
 * Test contract: with `last_archive_turns=[A,B]` and `active_turns=[C,D]`,
 * returns `[A,B,C,D]`.
 */
export function concatSnapshot(snapshot: PeerContextSnapshot): NormalizedTurn[] {
  return snapshot.last_archive_turns.concat(snapshot.active_turns);
}
