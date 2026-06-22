import type { RecoveryDecision, RecoverySession, RecoveryToken } from "./types";

/**
 * IRecoverySession — durable, reload-crossing recovery intent store.
 *
 * Cohesion source: the ONE seam that carries recovery intent + teardown
 * suppression ACROSS a webview reload. The in-memory orchestrator state, its
 * Promise, the Zustand store, and any in-memory flag all die with the JS
 * context that the reload destroys (round-3 convergence: codex2 HIGH /
 * claude3 HIGH / codex3 #1). So intent must be persisted OUTSIDE the renderer.
 *
 * Backed by the PID-stable Rust store (same dir family as topology), so the
 * fresh post-reload context — or a Rust-triggered death path that reloads a
 * dead renderer — can read it on bootstrap before any component mounts.
 *
 * Rust-side contract (documented in architecture.html, skeleton not emitted
 * this run): persist_recovery_session / load_recovery_session /
 * clear_recovery_session, each keyed to the PID-stable session dir.
 */
export interface IRecoverySession {
  /**
   * Responsibility: Durably open a recovery session in the old/live context.
   * Pipeline-position: IRecoveryOrchestrator.prepareReloadRecovery -> THIS -> (reload) -> resumeAfterReload
   * Inputs:
   *   - decision: RecoveryDecision — proceed===true intent to carry across reload
   * Outputs: Promise<RecoverySession> — the persisted record incl. a fresh
   *   generation token, suppressTeardown=true, and an expiry.
   * Side-effects: writes the durable recovery-session via Rust IPC, BEFORE the
   *   reload is requested.
   * Preconditions: called from the live context that is about to reload (or by
   *   the Rust death path before it reloads a dead renderer); decision.proceed===true.
   * Postconditions: a subsequent loadPending() on the fresh context (same Rust
   *   PID) returns this exact session until clear() or expiry.
   * Failure-modes:
   *   - Error — thrown on IPC transport failure; the caller MUST NOT request a
   *     reload if begin() failed (else the fresh context boots with no intent).
   * Collaborators: persist_recovery_session (Rust IPC)
   */
  begin(decision: RecoveryDecision): Promise<RecoverySession>;

  /**
   * Responsibility: Read any pending recovery session on fresh-context boot.
   * Pipeline-position: app bootstrap -> THIS -> IRecoveryOrchestrator.resumeAfterReload
   * Inputs: None.
   * Outputs: Promise<RecoverySession | null> — the pending session, or null if
   *   none exists or it has expired (normal startup).
   * Side-effects: invokes load_recovery_session Rust IPC (read-only). An expired
   *   session is treated as absent (and may be lazily cleared).
   * Preconditions: called once, very early in bootstrap, before collaborator
   *   components mount (so isReloadInProgress can be seeded synchronously after).
   * Postconditions: a non-null result obligates bootstrap to enter
   *   resumeAfterReload instead of normal startup; the token matches begin().
   * Failure-modes:
   *   - Error — thrown only on IPC transport failure; "nothing pending" is null.
   * Collaborators: load_recovery_session (Rust IPC)
   */
  loadPending(): Promise<RecoverySession | null>;

  /**
   * Responsibility: Durably clear a completed/aborted recovery session.
   * Pipeline-position: IRecoveryOrchestrator.resumeAfterReload / abort -> THIS -> (normal startup next boot)
   * Inputs:
   *   - token: RecoveryToken — the session to clear (generation-matched)
   * Outputs: Promise<void>.
   * Side-effects: invokes clear_recovery_session Rust IPC.
   * Preconditions: token came from begin()/loadPending().
   * Postconditions: loadPending() returns null afterward; idempotent — clearing
   *   an already-cleared or non-matching token is a no-op (guards double-resume).
   * Failure-modes:
   *   - Error — thrown on IPC transport failure; callers retry on next boot
   *     (the expiry guard prevents an un-cleared session from looping forever).
   * Collaborators: clear_recovery_session (Rust IPC)
   */
  clear(token: RecoveryToken): Promise<void>;
}
