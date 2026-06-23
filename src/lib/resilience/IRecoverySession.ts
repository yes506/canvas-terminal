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
 * claim_recovery_attempt / clear_recovery_session, each keyed to the PID-stable
 * session dir.
 */
export interface IRecoverySession {
  /**
   * Responsibility: Durably open a recovery session in the old/live context.
   * Pipeline-position: IRecoveryOrchestrator.prepareReloadRecovery -> THIS -> (reload) -> resumeAfterReload
   * Inputs:
   *   - decision: RecoveryDecision — proceed===true intent to carry across reload
   * Outputs: Promise<RecoverySession> — the persisted record incl. a fresh
   *   generation token, suppressTeardown=true, an expiry, and attempts=0 with a
   *   maxAttempts cap (round-4 crash-loop guard — claude3 MED-1).
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
   *   resumeAfterReload instead of normal startup; the token matches begin();
   *   the returned `attempts`/`maxAttempts` let resume fail fast on a crash-loop
   *   (resume increments-and-persists `attempts` before restore — round-4 claude3 MED-1).
   * Failure-modes:
   *   - Error — thrown only on IPC transport failure; "nothing pending" is null.
   * Collaborators: load_recovery_session (Rust IPC)
   */
  loadPending(): Promise<RecoverySession | null>;

  /**
   * Responsibility: Atomically + durably claim ONE recovery attempt before any
   *   restore side-effects run, so a crash-looping recovery fails fast.
   * Pipeline-position: IRecoveryOrchestrator.resumeAfterReload -> THIS -> (restore | fail-fast)
   * Inputs:
   *   - token: RecoveryToken — the pending session to claim (generation-matched)
   * Outputs: Promise<RecoverySession | null> — the session with `attempts`
   *   already INCREMENTED-and-persisted, or null if the token is expired/cleared/
   *   non-matching (treat as "nothing to resume").
   * Round-5 fix (codex1 HIGH / codex2 HIGH / claude3 HIGH — 3-way REQUIRED;
   *   @claude1 task-12): round-4 added RecoverySession.attempts/maxAttempts and
   *   said resume "increments-and-persists before restore", but the only seams
   *   were begin/loadPending(read-only)/clear — no durable mutation. A local
   *   increment is NOT durable (the next crash/reload re-reads the old count, so
   *   the guard does nothing). This is the missing atomic compare-increment-persist
   *   step, owned by Rust so it survives the very crash it bounds.
   * Side-effects: invokes claim_recovery_attempt Rust IPC — durably increments
   *   `attempts` (and persists) in a single generation-matched operation BEFORE
   *   returning. No-op-returns-null for a stale/cleared token.
   * Preconditions: loadPending() returned this token on this boot; called ONCE
   *   per resume, before restoreShell/reattach run.
   * Postconditions: the returned session's `attempts` is the new durable value;
   *   if `attempts > maxAttempts` the caller MUST NOT start restore and instead
   *   clears the session + settles the FSM to 'failed' (exhausted ⇒ fail fast,
   *   not loop to expiry). A null return likewise skips restore.
   * Failure-modes:
   *   - Error — thrown only on IPC transport failure; an exhausted-but-valid
   *     session is a normal (non-throwing) return with attempts > maxAttempts.
   * Collaborators: claim_recovery_attempt (Rust IPC)
   */
  claimAttempt(token: RecoveryToken): Promise<RecoverySession | null>;

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
