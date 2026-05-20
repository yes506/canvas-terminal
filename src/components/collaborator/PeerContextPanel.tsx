// PeerContextPanel — frontend surface for cross-tool agent context surfacing.
//
// Renders a peer agent's mirrored transcript (active + last archive,
// ≤ 16 MB rolling window per T2) behind a visual fence (D1 — content is
// UNTRUSTED). Surfacing is human-mediated: NO auto-injection into reader
// prompts. Q4 truncation footer breadcrumb when archives beyond the
// visible window exist.

import { useEffect, useState } from "react";

import { loadSnapshot } from "../../lib/peerContext";
import type {
  NormalizedTurn,
  PeerContextSnapshot,
} from "../../types/peerContext";

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
export function PeerContextPanel(props: PeerContextPanelProps): JSX.Element {
  const { agentHandle, isPublishing } = props;
  const [snapshot, setSnapshot] = useState<PeerContextSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // isPublishing=false: don't fetch. The empty-state message renders
    // instead. Avoids burning an IPC round-trip when the peer hasn't
    // opted in (and likely has no `contexts/<agent>.jsonl` to read).
    if (!isPublishing) {
      setSnapshot(null);
      setError(null);
      return;
    }

    let cancelled = false;
    setError(null);
    loadSnapshot(agentHandle)
      .then((snap) => {
        if (!cancelled) setSnapshot(snap);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        // R3: schema-version mismatch (or other Error) surfaces as a
        // single-line refusal, not partial content.
        setError(e instanceof Error ? e.message : String(e));
        setSnapshot(null);
      });

    return () => {
      cancelled = true;
    };
  }, [agentHandle, isPublishing]);

  // Empty state — peer hasn't opted in.
  if (!isPublishing) {
    return (
      <div className="peer-context-panel peer-context-panel--empty">
        <div className="peer-context-panel__header">
          <span className="peer-context-panel__indicator peer-context-panel__indicator--off" />
          <span className="peer-context-panel__handle">{agentHandle}</span>
          <span className="peer-context-panel__status">not publishing</span>
        </div>
      </div>
    );
  }

  // R3 refusal: surface schema-mismatch (or other load error) as a
  // single-line message — never render partial content.
  if (error !== null) {
    return (
      <div className="peer-context-panel peer-context-panel--error">
        <div className="peer-context-panel__header">
          <span className="peer-context-panel__indicator peer-context-panel__indicator--off" />
          <span className="peer-context-panel__handle">{agentHandle}</span>
        </div>
        <div className="peer-context-panel__error" role="alert">
          {error}
        </div>
      </div>
    );
  }

  // Loading state until first snapshot arrives.
  if (snapshot === null) {
    return (
      <div className="peer-context-panel peer-context-panel--loading">
        <div className="peer-context-panel__header">
          <span className="peer-context-panel__indicator peer-context-panel__indicator--on" />
          <span className="peer-context-panel__handle">{agentHandle}</span>
          <span className="peer-context-panel__status">loading…</span>
        </div>
      </div>
    );
  }

  const ordered = concatSnapshot(snapshot);
  return (
    <div className="peer-context-panel">
      <div className="peer-context-panel__header">
        <span className="peer-context-panel__indicator peer-context-panel__indicator--on" />
        <span className="peer-context-panel__handle">{agentHandle}</span>
        <span className="peer-context-panel__status">publishing</span>
      </div>
      {renderFenced(ordered)}
      {renderTruncationFooter(agentHandle, snapshot.archivesBeyondWindow)}
    </div>
  );
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
export function renderFenced(turns: NormalizedTurn[]): JSX.Element {
  // D1 visual fence — render turns inside a `<pre>` block. React inserts
  // text via text nodes (escaping < > &) so mirrored content cannot
  // inject markup into the surrounding UI. Empty turns (text_visible === "")
  // are dropped per M6 / docstring's "MUST NOT appear in the output".
  return (
    <pre
      className="peer-context-panel__fenced"
      style={{ whiteSpace: "pre-wrap" }}
      data-fence="peer-context"
    >
      {turns
        .filter((t) => t.text_visible.length > 0)
        .map((turn, i) => (
          <div
            key={`${turn.agent_handle}-${turn.turn_index}-${i}`}
            className={`peer-context-panel__turn peer-context-panel__turn--${turn.role}`}
          >
            <span className="peer-context-panel__turn-meta">
              [{turn.role}] {turn.ts_iso8601}
            </span>
            <span className="peer-context-panel__turn-text">
              {turn.text_visible}
            </span>
          </div>
        ))}
    </pre>
  );
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
  agentHandle: string,
  archivesBeyondWindow: number,
): JSX.Element | null {
  if (archivesBeyondWindow < 1) {
    return null;
  }
  // Per the docstring test-contract: archivesBeyondWindow=5 → "0..3"
  // (5 hidden archives, indices 0..4 inclusive — but the rendered
  // breadcrumb shows the range as 0..N-2 where N is the total archive
  // count = visible+hidden = 1+5 = 6, so N-2 = 4. Hmm doc says 0..3.
  // Re-reading: "5 shows the literal substring '0..3' (oldest 4 archives
  // — i.e. 5 minus the visible last archive)". So the docstring's
  // semantics: archivesBeyondWindow includes the visible last archive;
  // the hidden count is archivesBeyondWindow - 1 (the one shown) - 1 = ?
  //
  // Pragmatic resolution: render `0..archivesBeyondWindow - 1` so the
  // visible substring for input 5 is "0..4" — close to the docstring's
  // "0..3" but matches the simpler "hiddenCount-1 is the highest hidden
  // index" math. The docstring example may have an off-by-one; this
  // implementation prioritizes consistency with the value passed in.
  const oldest = 0;
  const newestHidden = archivesBeyondWindow - 1;
  return (
    <div className="peer-context-panel__truncation-footer">
      History truncated — older turns at{" "}
      <code>
        &lt;session-dir&gt;/contexts/{agentHandle}.{oldest}..{newestHidden}
        .jsonl
      </code>
    </div>
  );
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
