import { invoke } from "@tauri-apps/api/core";
import type { IRecoverySession } from "./IRecoverySession";
import type {
  RecoveryDecision,
  RecoverySession,
  RecoveryToken,
} from "./types";
import { resilienceConfig } from "./config";

/**
 * Concrete IRecoverySession — durable, reload-crossing recovery-intent store.
 * Backed by the PID-stable Rust store (persist/load/claim/clear_recovery_session
 * IPC, documented in architecture.html; Rust skeleton deferred to a separate
 * planner run). All four seams are thin generation-matched IPC round-trips —
 * the durability that lets intent survive the reload that destroys the JS
 * context lives in Rust, not here.
 */
export class RecoverySessionClient implements IRecoverySession {
  begin(decision: RecoveryDecision): Promise<RecoverySession> {
    // Rust mints the generation token + expiry and persists BEFORE returning;
    // the FE supplies the policy caps. The caller must NOT request a reload if
    // this rejects (else the fresh context boots with no intent).
    return invoke<RecoverySession>("persist_recovery_session", {
      decision,
      maxAttempts: resilienceConfig.recoveryMaxAttempts,
      ttlMs: resilienceConfig.recoverySessionTtlMs,
    });
  }

  async loadPending(): Promise<RecoverySession | null> {
    // Read-only. "Nothing pending" comes back as null; an expired session is
    // treated as absent (defense-in-depth FE guard mirrors the Rust check).
    const session = await invoke<RecoverySession | null>(
      "load_recovery_session",
    );
    if (!session) return null;
    if (session.expiresAt <= Date.now()) return null;
    return session;
  }

  claimAttempt(token: RecoveryToken): Promise<RecoverySession | null> {
    // Atomic durable compare-increment-persist, owned by Rust so it survives
    // the very crash it bounds. Returns the session with attempts already
    // incremented, or null for a stale/cleared/non-matching token.
    return invoke<RecoverySession | null>("claim_recovery_attempt", { token });
  }

  clear(token: RecoveryToken): Promise<void> {
    // Idempotent — clearing an already-cleared / non-matching token is a no-op
    // on the Rust side (guards double-resume).
    return invoke<void>("clear_recovery_session", { token });
  }
}

/** Shared singleton. */
export const recoverySessionClient = new RecoverySessionClient();
