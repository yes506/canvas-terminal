import { invoke } from "@tauri-apps/api/core";
import type { IPtyReattachClient } from "./IPtyReattachClient";
import type { ReplayBudget, PtyReattachResult } from "./types";

/**
 * Concrete IPtyReattachClient — front-end client for the Rust PTY-reattach
 * contract (reattach_pty IPC + the always-on bounded ring buffer documented in
 * architecture.html; Rust skeleton deferred to a separate planner run).
 *
 * The replayed tail is NOT returned inline — Rust re-emits its ring through the
 * existing pty-data-{sessionId} event that the (already-mounted, via
 * restoreShell → adoptDetachedSession) terminal listens on. This call only
 * triggers the reattach + replay and reports liveness + bytes re-emitted.
 */
export class PtyReattachClient implements IPtyReattachClient {
  reattach(
    sessionId: string,
    replayBudget: ReplayBudget,
  ): Promise<PtyReattachResult> {
    // A dead PTY comes back as alive=false from Rust (NOT a throw); only an IPC
    // transport failure rejects. Re-subscription idempotency + flush-before-live
    // ordering are owned by the Rust side per the contract.
    return invoke<PtyReattachResult>("reattach_pty", {
      sessionId,
      maxBytes: replayBudget.maxBytes,
    });
  }
}

/** Shared singleton. */
export const ptyReattachClient = new PtyReattachClient();
