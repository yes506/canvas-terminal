//! `LeaderInboxPoller` — Phase B inbox delivery driver.
//!
//! Plan v6 Phase B: replaces the existing `app.emit("fsd-iteration-report-{handle}", ...)`
//! Tauri-event direct delivery path with a poll-and-deliver loop driven by
//! the inbox subsystem.
//!
//! ## Architecture
//!
//! ```text
//!   orchestrator                              LeaderInboxPoller (this module)
//!   ─────────────                              ───────────────────────────────
//!   write_inbox_payload_atomic         ─────►  notified via tokio::sync::Notify
//!   (inbox/leader-X/.pending/...)              │
//!                                              ▼
//!                                              list_inbox_pending(scope)
//!                                              │
//!                                              ▼
//!                                              claim_inbox_file (.pending → .processing)
//!                                              │
//!                                              ▼
//!                                              app.emit("fsd-inbox-leader-message-{handle}", env)
//!                                              │
//!                                              ▼
//!                                              ack_inbox_message (.processing → .processed)
//! ```
//!
//! ## Wake hierarchy (plan v6 §2.12)
//!
//! 1. **`tokio::sync::Notify`** (primary, in-process) — orchestrator's
//!    inbox writer signals the poller right after the `.tmp → .pending`
//!    rename. Sub-millisecond wake latency. The Tauri `fsd_inbox_*`
//!    commands also notify the matching leader's poller after a
//!    successful write so frontend-originated writes go through the
//!    same fast path. Note: a Rust `notify`-crate (inotify/kqueue)
//!    cross-process fallback was scoped in plan v6 §2.12 but **is not
//!    implemented** in Phase A/B — the timer cadence below covers
//!    that case in practice (cross-process writers wake the poller
//!    within at most `IDLE_POLL_INTERVAL_MS` = 2s).
//! 2. **250ms timer** (last-resort) — backoff to 2s after 3 empty cycles,
//!    reset to 250ms on signal.
//!
//! ## Lifecycle
//!
//! Poller is owned by `AppState::leader_inbox_pollers` (plan v6 §2.5 — kept
//! out of `FsdLeaderRuntime` to preserve `Clone`). Started on FSD-tier-on
//! (per-leader); aborted on FSD-tier-off via `JoinHandle::abort()`.
//!
//! ## MAX_ATTEMPTS poison-message handling (plan v6 §2.10)
//!
//! Each delivery attempt increments `envelope.attempt`. On delivery failure
//! the file is moved back to `.pending/`. After 3 attempts (`MAX_ATTEMPTS`
//! constant from `fsd::inbox`), the file is permanently moved to `.failed/`
//! for manual triage. Closes claude5 task-59 §4.1.

use std::sync::Arc;
use std::time::Duration;

use tauri::{AppHandle, Emitter};
use tokio::sync::Notify;
use tokio::task::JoinHandle;

use crate::fsd::inbox::{InboxScope, InboxState, MAX_ATTEMPTS};
use crate::fsd::storage;

/// Active poll cadence (when delivery work has been seen recently).
const ACTIVE_POLL_INTERVAL_MS: u64 = 250;
/// Idle backoff cadence after `IDLE_THRESHOLD` consecutive empty cycles.
const IDLE_POLL_INTERVAL_MS: u64 = 2_000;
/// Number of consecutive empty cycles before backing off to idle cadence.
const IDLE_THRESHOLD: u32 = 3;
/// Stale claim TTL — `.processing/` files older than this go back to `.pending/`.
const STALE_CLAIM_TTL_SECS: u64 = 30;
/// Audit retention — `.audit/` files older than 7 days are deleted.
const AUDIT_TTL_SECS: u64 = 7 * 24 * 60 * 60;
/// Processed retention — `.processed/` files older than 24h are deleted.
const PROCESSED_TTL_SECS: u64 = 24 * 60 * 60;
/// How often the poller runs the periodic reapers (60s).
const REAPER_INTERVAL_SECS: u64 = 60;

/// Handle returned by `spawn_leader_inbox_poller`. The `JoinHandle` aborts
/// the poller on drop or explicit `abort()`. The `notify` arc allows
/// external writers (the orchestrator's audit hook) to wake the poller.
pub struct LeaderInboxPollerHandle {
    pub join: JoinHandle<()>,
    pub notify: Arc<Notify>,
}

/// Spawn a `LeaderInboxPoller` for `leader_handle`. Returns the join handle
/// so the caller (`AppState::leader_inbox_pollers`) can abort it on
/// FSD-tier-off.
///
/// The poller drains `inbox/leader-<handle>/.pending/` on every wake,
/// delivering each message to the frontend via the
/// `fsd-inbox-leader-message-<handle>` Tauri event. Phase B's frontend
/// listener picks up that event and calls `inject_into_pty` for actual
/// PTY delivery (echo-suppression machinery stays in place — Phase B
/// is a transport-durability win, NOT a PTY-fragility-class fix per
/// plan v6 §2.2 caveat).
pub fn spawn_leader_inbox_poller(
    app: AppHandle,
    leader_handle: String,
) -> LeaderInboxPollerHandle {
    let notify = Arc::new(Notify::new());
    let notify_clone = notify.clone();
    let scope = InboxScope::Leader { handle: leader_handle.clone() };
    let event_name = format!("fsd-inbox-leader-message-{}", leader_handle);

    let join = tokio::spawn(async move {
        let mut empty_cycles: u32 = 0;
        let mut last_reaper_run = std::time::Instant::now();

        loop {
            // Drain everything in .pending/ before waiting again.
            let drained = drain_pending(&app, &scope, &event_name).await;

            // Periodically run reapers (every REAPER_INTERVAL_SECS).
            if last_reaper_run.elapsed() >= Duration::from_secs(REAPER_INTERVAL_SECS) {
                run_reapers(&scope);
                last_reaper_run = std::time::Instant::now();
            }

            // Wait for either a notify signal or the timer interval to elapse.
            let interval = if empty_cycles >= IDLE_THRESHOLD {
                IDLE_POLL_INTERVAL_MS
            } else {
                ACTIVE_POLL_INTERVAL_MS
            };

            tokio::select! {
                _ = notify_clone.notified() => {
                    empty_cycles = 0; // Signal received — reset to active cadence.
                }
                _ = tokio::time::sleep(Duration::from_millis(interval)) => {
                    if drained == 0 {
                        empty_cycles = empty_cycles.saturating_add(1);
                    } else {
                        empty_cycles = 0;
                    }
                }
            }
        }
    });

    LeaderInboxPollerHandle { join, notify }
}

/// Drain all currently-pending messages, delivering each via Tauri event
/// and acking on success / `.failed/`-quarantining after MAX_ATTEMPTS.
/// Returns the number of messages drained this cycle.
async fn drain_pending(app: &AppHandle, scope: &InboxScope, event_name: &str) -> u32 {
    let mut delivered: u32 = 0;
    let pending = match storage::list_inbox_pending(scope) {
        Ok(p) => p,
        Err(e) => {
            eprintln!(
                "fsd: LeaderInboxPoller list_inbox_pending failed: {} (skipping cycle)",
                e
            );
            return 0;
        }
    };

    for filename in pending {
        // Try to claim; if Ok(false) someone else got it (race lost).
        match claim_and_deliver(app, scope, &filename, event_name) {
            Ok(true) => delivered += 1,
            Ok(false) => continue, // race lost, move to next candidate
            Err(e) => {
                eprintln!(
                    "fsd: LeaderInboxPoller claim/deliver failed for {}: {}",
                    filename, e
                );
                // Don't break the loop — try the next file.
            }
        }
    }

    delivered
}

/// Atomically claim a single pending file, deliver it via Tauri event,
/// and ack on success. Returns `Ok(true)` if the message was delivered,
/// `Ok(false)` if the claim race was lost, `Err` on validation/IO error.
fn claim_and_deliver(
    app: &AppHandle,
    scope: &InboxScope,
    filename: &str,
    event_name: &str,
) -> Result<bool, String> {
    let from_rel = format!("{}/{}", scope.state_dir(InboxState::Pending), filename);
    let to_rel = format!("{}/{}", scope.state_dir(InboxState::Processing), filename);
    let claimed = storage::claim_inbox_file(&from_rel, &to_rel)?;
    if !claimed {
        return Ok(false);
    }

    // Read the claimed envelope. Round-10 reflection per codex2 task-3:
    // a read-or-deserialize failure here MUST quarantine the file to
    // `.failed/`, otherwise the file stays in `.processing/` and the
    // stale-claim reaper recycles it back to `.pending/` for endless
    // re-claim. Extracted into `read_processing_envelope_or_quarantine`
    // for direct unit-test coverage (no AppHandle required).
    let envelope = read_processing_envelope_or_quarantine(scope, filename, &to_rel)?;

    // Validate envelope structure.
    envelope.validate().map_err(|e| {
        // Move malformed envelopes to .failed/ — don't loop forever.
        let failed_rel = format!("{}/{}", scope.state_dir(InboxState::Failed), filename);
        let _ = storage::claim_inbox_file(&to_rel, &failed_rel);
        format!("envelope.validate() failed: {} (moved to .failed/)", e)
    })?;

    // Plan v6 §2.10: MAX_ATTEMPTS enforcement. If this is attempt > MAX,
    // permanently move to .failed/ instead of trying delivery.
    if envelope.attempt > MAX_ATTEMPTS {
        let failed_rel = format!("{}/{}", scope.state_dir(InboxState::Failed), filename);
        let _ = storage::claim_inbox_file(&to_rel, &failed_rel);
        return Err(format!(
            "MAX_ATTEMPTS exceeded ({} > {}); moved to .failed/",
            envelope.attempt, MAX_ATTEMPTS
        ));
    }

    // Deliver via Tauri event. The frontend listener at
    // AgentMiniTerminal.tsx picks up `fsd-inbox-leader-message-{handle}`
    // and calls `inject_into_pty`. Echo-suppression machinery stays in
    // place per plan v6 §2.2 caveat.
    let payload = serde_json::json!({
        "message_id": envelope.message_id,
        "kind": envelope.kind,
        "content": envelope.content,
        "run_id": envelope.run_id,
        "task_id": envelope.task_id,
        "turn": envelope.turn,
        "seq_global": envelope.seq_global,
    });

    let emit_result = app.emit(event_name, payload);
    match emit_result {
        Ok(()) => {
            // Ack: rename .processing/<full> → .processed/<message_id>.json
            if let Err(e) = storage::ack_inbox_message(scope, filename, &envelope.message_id) {
                eprintln!(
                    "fsd: ack_inbox_message failed for {} (delivery succeeded; \
                     dedup ledger may be inconsistent until next reaper): {}",
                    filename, e
                );
            }
            Ok(true)
        }
        Err(e) => {
            // Delivery failed. Round-7 reflection per codex2 task-75 P1 +
            // codex3 task-77 P1 + claude4 task-78 §3.1: bump `envelope.attempt`
            // and re-serialize to disk BEFORE moving back to `.pending/`,
            // so MAX_ATTEMPTS=3 is enforced as a strict count.
            //
            // Round-8 reflection per codex2 task-82 P1 + codex3 task-83 §2 +
            // claude4 task-84 §3.1: rewrite mirrors persist_seq_global's
            // hardening (random suffix, symlink rejection, error propagation)
            // so the new path doesn't regress the round-3-5 inbox hardening.
            let mut bumped = envelope.clone();
            bumped.attempt = bumped.attempt.saturating_add(1);
            let target_state = if bumped.attempt > MAX_ATTEMPTS {
                InboxState::Failed
            } else {
                InboxState::Pending
            };

            match rewrite_and_move_processing_message(scope, filename, &bumped, target_state) {
                Ok(()) => Err(format!(
                    "Tauri emit failed (attempt now {}, target {:?}): {}",
                    bumped.attempt, target_state, e
                )),
                Err(rewrite_err) => {
                    // Rewrite failed — DO NOT move the file (would lose the
                    // attempt bump). Leave it in .processing/ for the
                    // stale-claim reaper to handle. Return the original emit
                    // error AND the rewrite error for diagnostic visibility.
                    eprintln!(
                        "fsd: poller rewrite-attempt failed for {}: {} \
                         (file remains in .processing/ for stale-claim recovery)",
                        filename, rewrite_err
                    );
                    Err(format!(
                        "Tauri emit failed: {} (also: rewrite_attempt failed: {})",
                        e, rewrite_err
                    ))
                }
            }
        }
    }
}

/// Atomically rewrite a `.processing/<filename>` envelope to a bumped
/// version and move it to the target state lane. Mirrors the safety
/// pattern from `persist_seq_global` (storage.rs):
///
/// 1. **Reject symlinked parent directories** before any I/O — closes
///    the symlink-traversal class that rounds 3-5 hardened against.
///    Without this, a planted symlink at `.processing/` could redirect
///    the rewrite outside the memory root.
/// 2. **Random 64-bit suffix on the tmp filename** — closes the
///    planted-symlink-at-predictable-tmp-path attack vector.
///    `with_extension("tmp.bumped")` was deterministic; this is
///    `tmp.bumped.<16-hex>`.
/// 3. **Refuse to write if tmp path already exists** — defense against
///    extreme collision OR planted symlink at the random tmp.
/// 4. **Propagate write/rename errors** instead of swallowing them —
///    so the caller can leave the file in `.processing/` rather than
///    moving a stale envelope under fs failure.
///
/// Returns `Ok(())` on full success (envelope rewritten + moved to
/// target state). Returns `Err` if any step fails — the caller is
/// expected to log the error and leave the file in `.processing/` for
/// the stale-claim reaper to recover. Round-8 reflection per codex2
/// task-82 P1 + codex3 task-83 §2 + claude4 task-84 §3.
fn rewrite_and_move_processing_message(
    scope: &InboxScope,
    filename: &str,
    bumped: &crate::fsd::inbox::InboxMessage,
    target_state: InboxState,
) -> Result<(), String> {
    use rand::RngCore;
    let memory_root = crate::commands::memory::get_memory_root()?;
    let processing_dir_rel = scope.state_dir(InboxState::Processing);
    // Symlink-defense: reject if any component of `.processing/` is symlinked.
    // Mirrors the storage-layer hardening from persist_seq_global +
    // write_inbox_payload_atomic.
    storage::reject_symlink_components(&memory_root, &processing_dir_rel)?;

    let processing_abs = memory_root.join(format!("{}/{}", processing_dir_rel, filename));
    let new_body = serde_json::to_string(bumped).map_err(|e| e.to_string())?;

    // Random 64-bit suffix on tmp filename — defends against planted-symlink
    // attacks at predictable tmp paths. Same pattern as persist_seq_global
    // (storage.rs random `seq_global.json.<16hex>.tmp`).
    let mut suffix_bytes = [0u8; 8];
    rand::thread_rng().fill_bytes(&mut suffix_bytes);
    let suffix = hex::encode(suffix_bytes);
    let tmp_abs = processing_abs.with_file_name(format!(
        "{}.{}.tmp.bumped",
        processing_abs
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("envelope"),
        suffix
    ));

    // Defense-in-depth: even with a 64-bit random suffix, refuse to write
    // if the tmp path somehow exists (collision or planted symlink).
    if std::fs::symlink_metadata(&tmp_abs).is_ok() {
        return Err(format!(
            "rewrite tmp path {} unexpectedly exists \
             (likely planted symlink — refusing to overwrite)",
            tmp_abs.display()
        ));
    }

    // Propagate write/rename errors instead of swallowing them.
    std::fs::write(&tmp_abs, new_body).map_err(|e| format!("rewrite write failed: {}", e))?;
    std::fs::rename(&tmp_abs, &processing_abs)
        .map_err(|e| format!("rewrite rename failed: {}", e))?;

    // Now atomically move the rewritten file to the target lane. If this
    // fails, the file is in .processing/ with the bumped attempt — stale
    // reaper will eventually handle it.
    let from_rel = format!("{}/{}", scope.state_dir(InboxState::Processing), filename);
    let to_rel = format!("{}/{}", scope.state_dir(target_state), filename);
    storage::claim_inbox_file(&from_rel, &to_rel).map(|_| ())
}

/// Run the periodic reapers for this scope:
/// - `.processing/` files older than 30s → back to `.pending/` (stale claims)
/// - `.processed/` files older than 24h → deleted (dedup ledger retention)
/// - `.audit/` files older than 7 days → deleted (Phase A bake retention)
fn run_reapers(scope: &InboxScope) {
    if let Err(e) = storage::reap_stale_inbox_claims(scope, STALE_CLAIM_TTL_SECS) {
        eprintln!("fsd: reap_stale_inbox_claims failed: {}", e);
    }
    if let Err(e) = storage::reap_old_processed(scope, PROCESSED_TTL_SECS) {
        eprintln!("fsd: reap_old_processed failed: {}", e);
    }
    if let Err(e) = storage::reap_old_audit(scope, AUDIT_TTL_SECS) {
        eprintln!("fsd: reap_old_audit failed: {}", e);
    }
}

/// Read the envelope at `<memory_root>/<to_rel>` (already-claimed
/// `.processing/<filename>`) and quarantine it to `.failed/` if either
/// the read or the JSON deserialization fails. Returns the parsed
/// envelope on success.
///
/// Round-10 reflection per codex2 task-3: extracted from
/// `claim_and_deliver` so the poison-on-read path is directly unit-
/// testable without spinning up a Tauri `AppHandle`. The caller still
/// holds the only successful claim (`pending → processing`); on read or
/// parse failure we re-claim `processing → failed` to break the
/// `.pending → .processing → stale-reap → .pending` recycle loop the
/// stale-claim reaper would otherwise perpetuate.
fn read_processing_envelope_or_quarantine(
    scope: &InboxScope,
    filename: &str,
    to_rel: &str,
) -> Result<crate::fsd::inbox::InboxMessage, String> {
    let memory_root = crate::commands::memory::get_memory_root()?;
    let abs = memory_root.join(to_rel);
    let body = match std::fs::read_to_string(&abs) {
        Ok(b) => b,
        Err(e) => {
            let failed_rel = format!("{}/{}", scope.state_dir(InboxState::Failed), filename);
            let _ = storage::claim_inbox_file(to_rel, &failed_rel);
            return Err(format!(
                "read claimed envelope failed: {} (moved to .failed/ to break stale-reaper recycle loop)",
                e
            ));
        }
    };
    match serde_json::from_str::<crate::fsd::inbox::InboxMessage>(&body) {
        Ok(env) => Ok(env),
        Err(e) => {
            let failed_rel = format!("{}/{}", scope.state_dir(InboxState::Failed), filename);
            let _ = storage::claim_inbox_file(to_rel, &failed_rel);
            Err(format!(
                "deserialize envelope failed: {} (moved to .failed/ to break stale-reaper recycle loop)",
                e
            ))
        }
    }
}

#[cfg(test)]
mod tests {
    //! Round-9 reflection per codex2 task-88 + codex3 task-89 + claude4
    //! task-90 §3.1 + claude5 task-91 §"unanimous follow-up": direct
    //! regression tests for `rewrite_and_move_processing_message` (round-8
    //! helper) and `quarantine_to_failed` (round-8 in `runner.rs`). Closes
    //! the test-coverage gap all 4 reviewers flagged as "Phase B
    //! production-cutover follow-up."

    use super::*;
    use crate::fsd::inbox::{InboxMessage, InboxMessagePartial, MessageKind, SenderKind};

    /// Smoke test that the reaper helper runs for a synthetic scope without
    /// panicking on missing dirs (cold first boot).
    #[test]
    fn run_reapers_handles_missing_inbox() {
        // CANVAS_TERMINAL_MEMORY_ROOT defaults via test isolation if not set;
        // the reaper helpers soft-fail on missing dirs.
        let scope = InboxScope::Leader {
            handle: format!("test-poller-reapers-{}", std::process::id()),
        };
        run_reapers(&scope); // must not panic
    }

    // ---- rewrite_and_move_processing_message regression battery --------

    /// Test isolation: ensures `CANVAS_TERMINAL_MEMORY_ROOT` is set so we
    /// don't touch real `~/.cache/canvas-terminal/`.
    fn ensure_test_root() {
        if std::env::var("CANVAS_TERMINAL_MEMORY_ROOT").is_err() {
            let test_root = std::env::temp_dir().join(format!(
                "canvas-terminal-fsd-test-{}",
                std::process::id()
            ));
            std::fs::create_dir_all(&test_root).expect("create test root");
            #[allow(unused_unsafe)]
            unsafe {
                std::env::set_var(
                    "CANVAS_TERMINAL_MEMORY_ROOT",
                    test_root.to_string_lossy().as_ref(),
                );
            }
        }
    }

    fn unique_test_handle(tag: &str) -> String {
        use std::sync::atomic::{AtomicU32, Ordering};
        static COUNTER: AtomicU32 = AtomicU32::new(0);
        let n = COUNTER.fetch_add(1, Ordering::SeqCst);
        format!("test-rewrite-{}-{}-{}", tag, std::process::id(), n)
    }

    /// Construct a synthetic envelope at a given attempt for the test.
    fn make_envelope(attempt: u32) -> InboxMessage {
        let partial = InboxMessagePartial {
            message_id: "0123456789abcdef".into(),
            sender_id: "orchestrator".into(),
            sender_kind: SenderKind::Orchestrator,
            target_id: "leader-test".into(),
            kind: MessageKind::IterationReport,
            content: "test content".into(),
            created_at_ms: 1_714_823_900_000,
            run_id: Some("r-test".into()),
            task_id: None,
            turn: Some(1),
            source_cmd_id: None,
            sn: None,
            rn: None,
            attempt,
        };
        InboxMessage {
            message_id: partial.message_id,
            schema: 1,
            sender_id: partial.sender_id,
            sender_kind: partial.sender_kind,
            target_id: partial.target_id,
            kind: partial.kind,
            content: partial.content,
            created_at_ms: partial.created_at_ms,
            seq_global: 1,
            priority: 5,
            run_id: partial.run_id,
            task_id: partial.task_id,
            turn: partial.turn,
            source_cmd_id: partial.source_cmd_id,
            sn: partial.sn,
            rn: partial.rn,
            attempt: partial.attempt,
        }
    }

    /// Seed a `.processing/<filename>` file with a serialized envelope so
    /// tests can exercise the rewrite-and-move path without going through
    /// the producer/poller flow.
    fn seed_processing_file(scope: &InboxScope, filename: &str, env: &InboxMessage) {
        let memory_root = crate::commands::memory::get_memory_root().unwrap();
        let abs = memory_root
            .join(scope.state_dir(InboxState::Processing))
            .join(filename);
        std::fs::create_dir_all(abs.parent().unwrap()).unwrap();
        let body = serde_json::to_string(env).unwrap();
        std::fs::write(&abs, body).unwrap();
    }

    fn cleanup_scope(scope: &InboxScope) {
        let memory_root = crate::commands::memory::get_memory_root().unwrap();
        let _ = std::fs::remove_dir_all(memory_root.join(scope.relative_path()));
    }

    /// Round-8 hardening regression: a successful rewrite at attempt=1 →
    /// bumped envelope (attempt=2) lands in `.pending/` for retry.
    /// Closes codex2 task-88 §"attempt 1→2→3→failed".
    #[test]
    fn rewrite_happy_path_bump_1_to_2_routes_to_pending() {
        ensure_test_root();
        let handle = unique_test_handle("happy");
        let scope = InboxScope::Leader { handle: handle.clone() };
        let filename = "5-00000000000000000001-1714823900000-0123456789abcdef.json";

        let env = make_envelope(1);
        seed_processing_file(&scope, filename, &env);

        let mut bumped = env.clone();
        bumped.attempt += 1; // 1 → 2 (still <= MAX_ATTEMPTS=3)

        let result = rewrite_and_move_processing_message(
            &scope,
            filename,
            &bumped,
            InboxState::Pending,
        );
        assert!(result.is_ok(), "rewrite should succeed: {:?}", result);

        // Verify the file moved to .pending/ AND the bumped attempt was
        // persisted to disk (closes round-8 MAX_ATTEMPTS regression).
        let memory_root = crate::commands::memory::get_memory_root().unwrap();
        let pending_path = memory_root
            .join(scope.state_dir(InboxState::Pending))
            .join(filename);
        assert!(pending_path.exists(), "file should be in .pending/");
        let body = std::fs::read_to_string(&pending_path).unwrap();
        let read_env: InboxMessage = serde_json::from_str(&body).unwrap();
        assert_eq!(
            read_env.attempt, 2,
            "envelope on disk must carry the bumped attempt (closes MAX_ATTEMPTS regression)"
        );

        cleanup_scope(&scope);
    }

    /// Round-8 hardening regression: rewrite at attempt=4 (> MAX_ATTEMPTS=3)
    /// routes to `.failed/` lane (poison quarantine).
    #[test]
    fn rewrite_attempt_exceeds_max_routes_to_failed() {
        ensure_test_root();
        let handle = unique_test_handle("max");
        let scope = InboxScope::Leader { handle: handle.clone() };
        let filename = "5-00000000000000000002-1714823900000-fedcba9876543210.json";

        let env = make_envelope(3);
        seed_processing_file(&scope, filename, &env);

        let mut bumped = env.clone();
        bumped.attempt += 1; // 3 → 4 (> MAX_ATTEMPTS=3)

        let result = rewrite_and_move_processing_message(
            &scope,
            filename,
            &bumped,
            InboxState::Failed,
        );
        assert!(result.is_ok(), "rewrite should succeed: {:?}", result);

        // File should be in .failed/, not .pending/
        let memory_root = crate::commands::memory::get_memory_root().unwrap();
        let failed_path = memory_root
            .join(scope.state_dir(InboxState::Failed))
            .join(filename);
        let pending_path = memory_root
            .join(scope.state_dir(InboxState::Pending))
            .join(filename);
        assert!(failed_path.exists(), "file should be in .failed/ (poison quarantine)");
        assert!(!pending_path.exists(), "file must NOT be in .pending/");

        cleanup_scope(&scope);
    }

    /// Round-8 hardening regression (claude4 task-84 §3.3): planted symlink
    /// at the rewrite tmp path is refused without writing through.
    #[cfg(unix)]
    #[test]
    fn rewrite_refuses_planted_symlink_at_tmp_path() {
        ensure_test_root();
        let handle = unique_test_handle("symlink");
        let scope = InboxScope::Leader { handle: handle.clone() };
        let filename = "5-00000000000000000003-1714823900000-0011223344556677.json";

        let env = make_envelope(1);
        seed_processing_file(&scope, filename, &env);

        // Plant a symlink at every conceivable random-suffixed tmp path
        // is impossible (64-bit suffix space). Instead, we verify the
        // symlink-defense by planting at the .processing/ parent and
        // confirming reject_symlink_components fires before any write.
        let memory_root = crate::commands::memory::get_memory_root().unwrap();
        let processing_parent = memory_root.join(scope.state_dir(InboxState::Processing));
        // Replace .processing/ with a symlink to /tmp/<bait>
        let bait = std::env::temp_dir().join(format!(
            "canvas-terminal-rewrite-bait-{}-{}",
            std::process::id(),
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&bait);
        std::fs::create_dir_all(&bait).unwrap();
        let _ = std::fs::remove_dir_all(&processing_parent);
        std::os::unix::fs::symlink(&bait, &processing_parent).unwrap();

        let mut bumped = env.clone();
        bumped.attempt += 1;
        let result = rewrite_and_move_processing_message(
            &scope,
            filename,
            &bumped,
            InboxState::Pending,
        );
        assert!(
            result.is_err(),
            "expected Err on symlinked .processing/ parent"
        );
        // Verify the bait was NOT touched (symlink-defense intact).
        let bait_entries: Vec<_> = std::fs::read_dir(&bait)
            .unwrap()
            .filter_map(|e| e.ok())
            .collect();
        assert!(
            bait_entries.is_empty(),
            "bait dir was modified — symlink defense regressed"
        );

        // Cleanup
        let _ = std::fs::remove_file(&processing_parent);
        let _ = std::fs::remove_dir_all(&bait);
        cleanup_scope(&scope);
    }

    // ---- read_processing_envelope_or_quarantine regression battery ----
    //
    // Round-10 reflection per codex2 task-3: closes the poller poison-on-
    // read gap. Each test seeds a `.processing/<filename>` file with a
    // pathological body, then asserts the helper returns `Err` AND the
    // file moved out of `.processing/` into `.failed/` — without that
    // move, the stale-claim reaper would recycle the file back to
    // `.pending/` and the poller would re-claim it forever.

    #[test]
    fn read_envelope_quarantines_invalid_json() {
        ensure_test_root();
        let handle = unique_test_handle("poison-json");
        let scope = InboxScope::Leader { handle: handle.clone() };
        let filename = "5-00000000000000000010-1714823900000-deadbeefdeadbeef.json";

        // Seed `.processing/<filename>` with malformed JSON.
        let memory_root = crate::commands::memory::get_memory_root().unwrap();
        let processing_path = memory_root
            .join(scope.state_dir(InboxState::Processing))
            .join(filename);
        std::fs::create_dir_all(processing_path.parent().unwrap()).unwrap();
        std::fs::write(&processing_path, "{ not valid json }").unwrap();
        let to_rel = format!("{}/{}", scope.state_dir(InboxState::Processing), filename);

        let result = read_processing_envelope_or_quarantine(&scope, filename, &to_rel);
        assert!(result.is_err(), "expected Err on malformed JSON");

        // The file must have moved to `.failed/` so the stale-claim
        // reaper cannot recycle it back to `.pending/`.
        let failed_path = memory_root
            .join(scope.state_dir(InboxState::Failed))
            .join(filename);
        assert!(
            failed_path.exists(),
            "poison file should be quarantined to .failed/ (recycle-loop closed)"
        );
        assert!(
            !processing_path.exists(),
            "poison file must NOT remain in .processing/"
        );

        cleanup_scope(&scope);
    }

    #[test]
    fn read_envelope_quarantines_missing_file() {
        ensure_test_root();
        let handle = unique_test_handle("poison-missing");
        let scope = InboxScope::Leader { handle: handle.clone() };
        let filename = "5-00000000000000000011-1714823900000-cafebabecafebabe.json";

        // Pre-create the `.processing/` dir but NOT the file. The helper
        // must still soft-fail with quarantine attempt.
        let memory_root = crate::commands::memory::get_memory_root().unwrap();
        let processing_dir = memory_root.join(scope.state_dir(InboxState::Processing));
        std::fs::create_dir_all(&processing_dir).unwrap();
        let to_rel = format!("{}/{}", scope.state_dir(InboxState::Processing), filename);

        let result = read_processing_envelope_or_quarantine(&scope, filename, &to_rel);
        assert!(result.is_err(), "expected Err on missing source");
        // The quarantine attempt is best-effort; what matters is the helper
        // returned an error rather than silently leaving the caller to
        // proceed with a default/zero envelope.

        cleanup_scope(&scope);
    }

    #[test]
    fn read_envelope_returns_ok_on_well_formed() {
        ensure_test_root();
        let handle = unique_test_handle("happy-read");
        let scope = InboxScope::Leader { handle: handle.clone() };
        let filename = "5-00000000000000000012-1714823900000-0011223344556677.json";

        let env = make_envelope(1);
        seed_processing_file(&scope, filename, &env);
        let to_rel = format!("{}/{}", scope.state_dir(InboxState::Processing), filename);

        let result = read_processing_envelope_or_quarantine(&scope, filename, &to_rel);
        assert!(result.is_ok(), "well-formed envelope must round-trip: {:?}", result);
        let parsed = result.unwrap();
        assert_eq!(parsed.message_id, env.message_id);
        assert_eq!(parsed.attempt, env.attempt);

        // The file should NOT have been moved on the success path —
        // claim_and_deliver continues to use it for the emit + ack flow.
        let memory_root = crate::commands::memory::get_memory_root().unwrap();
        let processing_path = memory_root
            .join(scope.state_dir(InboxState::Processing))
            .join(filename);
        assert!(
            processing_path.exists(),
            "well-formed envelope file must remain in .processing/ for the caller"
        );

        cleanup_scope(&scope);
    }
}
