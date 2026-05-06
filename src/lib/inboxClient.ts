/**
 * Typed Tauri command wrappers for the FSD inbox subsystem.
 *
 * Round-7 frontend slice (claude5) — completes plan v6 PR-2 deliverable that
 * was deferred from Phase A per v3 §A.2 + claude4 task-29 §5.
 *
 * Maps each `#[tauri::command]` in `src-tauri/src/commands/inbox.rs` to a
 * typed async function. Tauri's default arg-name convention (Rust snake_case
 * → JS camelCase) determines the wrapper signatures: a Rust parameter named
 * `target_state` is invoked as `targetState` from JS (verified via existing
 * call sites at `src/lib/canvasOps.ts`).
 *
 * Plan v6 invariants this client preserves:
 *
 * - `InboxScope` is a typed enum, never a raw path string (§2.6).
 * - Authority fields are server-stamped — callers populate placeholder
 *   values that the server overrides (commands/inbox.rs §2.5).
 * - Filename / message_id consistency is enforced server-side
 *   (commands/inbox.rs §2.7 cross-check).
 */

import { invoke } from "@tauri-apps/api/core";

import type {
  ClaimedMessage,
  InboxMessagePartial,
  InboxScope,
  InboxState,
} from "../types/inbox";

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

/**
 * Write a user-authored message into the `.pending/` lane of an inbox.
 *
 * **Server-side restrictions** (mirror commands/inbox.rs):
 *
 * - `targetState` MUST be `"pending"`. The `audit` lane is orchestrator-only;
 *   any external write to `.audit/` would corrupt the divergence-analysis log.
 * - `partial.kind` MUST be `"user_prompt"` or `"broadcast"`. System-internal
 *   kinds (`"control"`, `"iteration_report"`, `"agent_message"`) are produced
 *   only by server-side helpers.
 * - The server overrides `message_id`, `sender_id`, `sender_kind`,
 *   `created_at_ms`, `sn`, `rn`, and `attempt` with trusted values regardless
 *   of what the caller supplies.
 *
 * Returns the basename of the file written (relative to the inbox lane).
 *
 * Throws on validation/IO error or on server-side restriction violations
 * (the IPC error message indicates which restriction triggered).
 */
export async function fsdInboxWriteMessage(
  scope: InboxScope,
  partial: InboxMessagePartial,
  targetState: InboxState,
): Promise<string> {
  return invoke<string>("fsd_inbox_write_message", {
    scope,
    partial,
    targetState,
  });
}

// ---------------------------------------------------------------------------
// List pending
// ---------------------------------------------------------------------------

/**
 * List filenames in `${scope}/.pending/` in lex-sorted (priority+seq) order,
 * up to `limit` entries.
 *
 * Pass `0` for "no limit" (still bounded by the storage layer's natural
 * directory iteration). The `limit` parameter is a defensive cap against
 * pathological large-directory scans.
 *
 * Returns the basenames (no path components). Iterate in order, calling
 * `fsdInboxClaim` on each candidate until one succeeds.
 */
export async function fsdInboxListPending(
  scope: InboxScope,
  limit: number,
): Promise<string[]> {
  return invoke<string[]>("fsd_inbox_list_pending", { scope, limit });
}

// ---------------------------------------------------------------------------
// Claim
// ---------------------------------------------------------------------------

/**
 * Atomically claim a specific pending file: `.pending/<filename>`
 * → `.processing/<filename>`.
 *
 * - Returns `null` on race-loss (another claimer got there first OR the file
 *   was already moved/reaped). Caller should pick another candidate.
 * - Returns a `ClaimedMessage` with the deserialized + validated envelope on
 *   success. Caller now owns the message and MUST call `fsdInboxAck` after
 *   delivery (or wait for the stale-claim reaper if delivery fails).
 *
 * **Server-side validation** (commands/inbox.rs):
 * - The supplied `filename` MUST be a basename in canonical pending-lane
 *   format (`${pri:1}-${seq:020}-${ts:013}-${id:16}.json`); otherwise the
 *   server rejects the claim with an `Err`.
 * - The envelope's `message_id` MUST match the filename suffix; on
 *   mismatch, the server moves the file to `.failed/` (best-effort) and
 *   returns an `Err` so the pending lane isn't blocked.
 *
 * Throws on validation, scope, or I/O error.
 */
export async function fsdInboxClaim(
  scope: InboxScope,
  filename: string,
): Promise<ClaimedMessage | null> {
  const result = await invoke<ClaimedMessage | null>("fsd_inbox_claim", {
    scope,
    filename,
  });
  return result;
}

// ---------------------------------------------------------------------------
// Ack
// ---------------------------------------------------------------------------

/**
 * Acknowledge successful delivery: rename `.processing/<fullFilename>`
 * → `.processed/<messageId>.json` (the dedup ledger).
 *
 * The truncation to `<messageId>.json` is intentional — the dedup ledger
 * uses message_id-only as its key for `Path::exists` lookups.
 *
 * **Server-side validation** (commands/inbox.rs):
 * - `fullFilename` must be a canonical pending-lane name
 *   (`parse_seq_from_filename` accepts it).
 * - `messageId` must be 16 lowercase hex chars.
 * - The filename's suffix MUST equal `-{messageId}.json` — prevents
 *   acking a file under the wrong dedup key (which would corrupt the ledger).
 *
 * Returns:
 * - `true` — ack succeeded; file is now in `.processed/`.
 * - `false` — file was already reaped/moved (idempotent retry).
 *
 * Throws on validation error.
 */
export async function fsdInboxAck(
  scope: InboxScope,
  fullFilename: string,
  messageId: string,
): Promise<boolean> {
  return invoke<boolean>("fsd_inbox_ack", {
    scope,
    fullFilename,
    messageId,
  });
}

// ---------------------------------------------------------------------------
// Reap stale claims
// ---------------------------------------------------------------------------

/**
 * Reap stale `.processing/` claims older than `olderThanSecs` back to
 * `.pending/`. Returns the number of files moved.
 *
 * 30s is the v6-recommended TTL for the stale-claim window. Used by Phase B's
 * periodic reaper task (Rust-side tokio interval) and as a manual maintenance
 * hook from the UI when needed.
 */
export async function fsdInboxReapStale(
  scope: InboxScope,
  olderThanSecs: number,
): Promise<number> {
  return invoke<number>("fsd_inbox_reap_stale", { scope, olderThanSecs });
}
