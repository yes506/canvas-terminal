// Canonical record format mirrored into session-<pid>/contexts/<agent>.jsonl
//
// Source-of-truth Rust definition lives in
// `src-tauri/src/commands/transcripts/mod.rs::NormalizedTurn`.
// This TS twin exists so PeerContextPanel can render typed records.
// Schema drift between the two MUST be caught at Phase 6 by a contract
// test (e.g. JSON-schema round-trip).

import type { ToolId } from "./collaborator";

/**
 * Bumped when the canonical record format changes in a way that breaks
 * existing readers. PeerContextPanel refuses to render records whose
 * `normalized_schema_version` exceeds this constant (R3 forward-compat).
 */
export const NORMALIZED_SCHEMA_VERSION = 1 as const;

/** Whether `ts_iso8601` came from the source tool or from CT-side fallback. */
export type TsSource = "tool" | "ct";

export type TurnRole = "user" | "assistant";

/**
 * One normalized turn mirrored from a tool's persisted transcript.
 *
 * Lifecycle: written by Rust watcher, read by `PeerContextPanel`.
 * `agent_handle` is CT-injected (M4 — source transcripts don't know it).
 */
export interface NormalizedTurn {
  normalized_schema_version: number;
  // Production source_tool is one of the registered ToolIds. The Rust
  // trait-extensibility test fixture uses a sentinel identifier that
  // appears only inside `src-tauri/tests/` — kept out of this production
  // type so CI's grep stays clean (Q2 SUCCESS CRITERION).
  source_tool: ToolId;
  source_tool_version: string | null;
  adapter_version: string;
  /** Bare handle: "claude3", "codex2". `@` prefix is display-layer only (W4). */
  agent_handle: string;
  ts_iso8601: string;
  ts_source: TsSource;
  role: TurnRole;
  text_visible: string; // empty turns are SKIPPED at write-time (M6)
  turn_index: number;
  source_offset: number;
}

/**
 * Reservation handle returned by `reserveAgentHandle`. Used by both the
 * success path (`consumeReservation`) and rollback path (`releaseReservation`).
 */
export interface AgentHandleReservation {
  reservationId: string;
  handle: string; // bare CT handle the reservation locked in
  collabSessionId: string;
  tool: ToolId;
}

/**
 * Env-var keys injected at PTY spawn time. Frontend hands these in via
 * `extraEnv`; the Rust `apply_extra_env` helper merges them onto the
 * spawned process.
 */
export const ENV_AGENT_ID = "CT_AGENT_ID" as const;
export const ENV_COLLAB_SESSION_ID = "CT_COLLAB_SESSION_ID" as const;

/**
 * Result of a PeerContextPanel data load. `archivesBeyondWindow` is the
 * truncation-footer count (Q4): when ≥ 1, the panel renders a
 * "history truncated — older turns at <session-dir>/contexts/<agent>.0..N-2.jsonl"
 * breadcrumb.
 */
export interface PeerContextSnapshot {
  agent_handle: string;
  active_turns: NormalizedTurn[]; // ≤ 8 MB worth (rotation cap)
  last_archive_turns: NormalizedTurn[]; // ≤ 8 MB worth; empty if no rotation yet
  archivesBeyondWindow: number; // # of older archives not loaded (Q4 footer)
}
