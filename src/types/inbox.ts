/**
 * FSD inbox subsystem types — TypeScript mirror of `src-tauri/src/fsd/inbox.rs`.
 *
 * Round-7 frontend slice (claude5) — completes plan v6 PR-2 deliverable that
 * was deferred from Phase A per v3 §A.2 + claude4 task-29 §5. The two
 * representations (this file and the Rust enum/struct) MUST round-trip
 * through serde JSON cleanly; the Rust-side tests at
 * `commands::inbox::tests::scope_serde_through_inbox_scope_argument_shape`
 * and `inbox_state_serializes_snake_case` pin the wire shape.
 *
 * Plan v6 §2.6 + §2.7 are the architectural anchors: typed scope replaces
 * raw path strings at the IPC boundary; envelope schema version 1.
 */

// ---------------------------------------------------------------------------
// Constants (mirror src-tauri/src/fsd/inbox.rs)
// ---------------------------------------------------------------------------

/** 16 hex chars (64 bits) — birthday collision negligible at any horizon. */
export const MESSAGE_ID_HEX_WIDTH = 16;

/** 8 hex chars (32 bits) — backward-compatible with `generate_8hex`. */
export const AGENT_ID_HEX_WIDTH = 8;

/** Envelope schema version. Bumped on breaking changes to `InboxMessage`. */
export const ENVELOPE_SCHEMA_VERSION = 1;

/** Maximum delivery attempts before a message is moved to `.failed/`. */
export const MAX_ATTEMPTS = 3;

// ---------------------------------------------------------------------------
// SenderKind — origin of authority
// ---------------------------------------------------------------------------

/**
 * Origin of a message's authority.
 *
 * - `user` — Tauri UI wrote directly (broadcast, user prompt). Trusted at IPC.
 * - `leader` — A user-facing PTY-attached CLI emitted `##FSD` that the
 *   orchestrator validated and brokered into the inbox.
 * - `orchestrator` — The Rust state machine authored the message itself
 *   (iteration_report, brokered response, control signals). Self-authoritative.
 * - `agent` — Reserved for future direct-write paths; not used in Phase A–C.
 */
export type SenderKind = "user" | "leader" | "orchestrator" | "agent";

// ---------------------------------------------------------------------------
// MessageKind — semantic role + priority lookup
// ---------------------------------------------------------------------------

export type MessageKind =
  | "iteration_report"
  | "user_prompt"
  | "broadcast"
  | "agent_message"
  | "control";

/**
 * Orchestrator-stamped priority based on `kind`. Caller-provided priority is
 * IGNORED on the server side (plan v6 §2.9 + commands/inbox.rs server-stamping
 * of authority fields). This client-side mirror is for UI display only —
 * never trust caller-supplied `priority`; always derive from kind.
 */
export function priorityForKind(kind: MessageKind): number {
  switch (kind) {
    case "control":
      return 9;
    case "user_prompt":
      return 7;
    case "iteration_report":
      return 5;
    case "agent_message":
      return 3;
    case "broadcast":
      return 1;
  }
}

// ---------------------------------------------------------------------------
// InboxState — sub-directory lane name
// ---------------------------------------------------------------------------

export type InboxState =
  | "tmp"
  | "pending"
  | "processing"
  | "processed"
  | "audit"
  | "failed";

// ---------------------------------------------------------------------------
// InboxScope — typed addressing (closes path-traversal at the type level)
// ---------------------------------------------------------------------------

/**
 * Strongly-typed inbox addressing. The wire shape matches serde's
 * adjacently-tagged enum format (`#[serde(tag = "kind", content = "value")]`):
 *
 * - `Global`  → `{"kind":"global"}` (NO `value` field — adjacently-tagged
 *   serde unit variants emit only the tag).
 * - `Leader`  → `{"kind":"leader","value":{"handle":"..."}}`
 * - `Agent`   → `{"kind":"agent","value":{"agent_id":"..."}}`
 *
 * Empirically verified against the Rust enum's actual JSON output (see
 * `commands::inbox::tests::scope_serde_through_inbox_scope_argument_shape`).
 */
export type InboxScope =
  | { kind: "global" }
  | { kind: "leader"; value: { handle: string } }
  | { kind: "agent"; value: { agent_id: string } };

/**
 * Constructor helpers — one each per variant. Use these to build scope
 * arguments rather than hand-constructing the discriminated union, so the
 * wire shape can't drift if serde's tag/content semantics change upstream.
 */
export const InboxScope = {
  global(): InboxScope {
    return { kind: "global" };
  },
  leader(handle: string): InboxScope {
    return { kind: "leader", value: { handle } };
  },
  agent(agentId: string): InboxScope {
    return { kind: "agent", value: { agent_id: agentId } };
  },
} as const;

// ---------------------------------------------------------------------------
// Envelope: full + producer-partial
// ---------------------------------------------------------------------------

/**
 * Full inbox message envelope. Lives on disk as a single JSON file in one
 * of six lanes (.tmp/.pending/.processing/.processed/.audit/.failed). Schema 1.
 *
 * Field invariants (enforced by Rust `InboxMessage::validate`):
 *
 * - `kind === "iteration_report"` IFF `turn !== null && turn !== undefined`
 * - `messageId` is exactly 16 lowercase hex chars
 * - `schema === ENVELOPE_SCHEMA_VERSION`
 *
 * Field naming follows the Rust struct (snake_case at the wire boundary, kept
 * here for round-trip fidelity).
 */
export interface InboxMessage {
  message_id: string;
  schema: number;
  sender_id: string;
  sender_kind: SenderKind;
  target_id: string;
  kind: MessageKind;
  content: string;
  created_at_ms: number;
  seq_global: number;
  priority: number;
  run_id: string | null;
  task_id: string | null;
  /** Only `Some(_)` when `kind === "iteration_report"`. */
  turn: number | null;
  source_cmd_id: string | null;
  sn: string | null;
  rn: string | null;
  attempt: number;
}

/**
 * Envelope without orchestrator-stamped fields (`seq_global`, `priority`,
 * `schema`). Producers construct this; the storage helper stamps the
 * missing fields just before write. Re-centers the writer-monopoly
 * invariant per plan v6 §2.6.
 *
 * Note: when sent through `fsd_inbox_write_message`, the IPC layer
 * additionally overrides `message_id`, `sender_id`, `sender_kind`,
 * `created_at_ms`, `sn`, `rn`, and `attempt` with server-stamped values.
 * Callers should populate them with placeholder values; the server WILL
 * ignore/overwrite them.
 */
export interface InboxMessagePartial {
  message_id: string;
  sender_id: string;
  sender_kind: SenderKind;
  target_id: string;
  kind: MessageKind;
  content: string;
  created_at_ms: number;
  run_id: string | null;
  task_id: string | null;
  turn: number | null;
  source_cmd_id: string | null;
  sn: string | null;
  rn: string | null;
  attempt: number;
}

// ---------------------------------------------------------------------------
// Claim result
// ---------------------------------------------------------------------------

/**
 * Result of a successful claim by a poller.
 *
 * - `envelope` — the deserialized message (validated by the server before
 *   being returned, so callers receive only well-formed envelopes per
 *   commands/inbox.rs cross-check).
 * - `claim_token` — the full filename in `.processing/`. Pass this to
 *   `fsd_inbox_ack` to move the message to `.processed/`.
 * - `claimed_at_ms` — wall-clock UTC ms when the claim succeeded.
 */
export interface ClaimedMessage {
  envelope: InboxMessage;
  claim_token: string;
  claimed_at_ms: number;
}

// ---------------------------------------------------------------------------
// Validation helpers (mirror Rust validators for early UI-side checks)
// ---------------------------------------------------------------------------

/**
 * Validate a hex-string ID of an exact width. Used for `message_id` (16) and
 * `agent_id` (8). Mirrors `fsd::inbox::validate_id_hex` so frontend can
 * pre-check user input before sending it through the IPC.
 *
 * Returns null on success, or an error message string on failure.
 */
export function validateIdHex(value: string, width: number): string | null {
  if (value.length !== width) {
    return `expected exactly ${width} hex chars, got ${value.length}`;
  }
  if (!/^[0-9a-f]+$/.test(value)) {
    return "must be lowercase hex (0-9 a-f)";
  }
  return null;
}
