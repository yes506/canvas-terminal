//! Tauri command wrappers for the FSD inbox subsystem (plan v6 PR-3b).
//!
//! Thin IPC layer over the `pub(crate)` storage helpers in
//! `crate::fsd::storage`. Every command:
//!
//! 1. Accepts a typed `InboxScope` (no raw path strings — closes the
//!    traversal vector at the type system level per plan v6 §2.6).
//! 2. Validates the scope before any I/O.
//! 3. Delegates to the storage layer (already tested via PR-3a).
//!
//! No Phase A consumer exists yet — these commands are scaffolded so
//! Phase B's `LeaderInboxPoller` and Phase C's frontend inbox-inspection
//! UI can call them. Plan v6 Part 3 / PR-3b.

use crate::fsd::inbox::{
    validate_id_hex, ClaimedMessage, InboxMessage, InboxMessagePartial, InboxScope, InboxState,
    MessageKind, SenderKind, MESSAGE_ID_HEX_WIDTH,
};
use crate::fsd::storage;
use crate::state::AppState;
use tauri::State;

/// Write a user-authored message into the `.pending/` lane of an inbox.
///
/// Plan v6 §2.3 + post-implementation review (codex2 task-46 §1, codex3
/// task-47 §2, claude5 task-49 §2.5): this command is the IPC entry-point
/// for **user** writes only. Authority fields (`sender_kind`, `sender_id`,
/// `sn`, `rn`, `message_id`) are stamped server-side; caller-supplied
/// values for these fields are ignored. This closes the architecture-level
/// authorization gap where a frontend caller could otherwise forge
/// `SenderKind::Orchestrator` or `SenderKind::Leader` envelopes.
///
/// Restrictions:
/// - `target_state` MUST be `Pending`. The `Audit` lane is orchestrator-only;
///   any external write to `.audit/` would corrupt the divergence-analysis log.
/// - `kind` MUST be `UserPrompt` or `Broadcast`. System-internal kinds
///   (`Control`, `IterationReport`, `AgentMessage`) are produced only by
///   server-side helpers (`write_iteration_report_audit`, dispatch broker).
///
/// Frontend callers construct an `InboxMessagePartial` describing what they
/// want delivered; this function overrides the authority-bearing fields
/// with trusted server-side values and stamps a fresh `message_id`. Plan
/// v6 writer-monopoly invariant.
#[tauri::command]
pub async fn fsd_inbox_write_message(
    state: State<'_, AppState>,
    scope: InboxScope,
    partial: InboxMessagePartial,
    target_state: InboxState,
) -> Result<String, String> {
    // Lane restriction: external writers may only enqueue Pending messages.
    // Audit is orchestrator-only (divergence log integrity); Processing/
    // Processed/Failed/Tmp are managed by the storage layer's lifecycle.
    if !ipc_write_target_state_allowed(target_state) {
        return Err(format!(
            "fsd_inbox_write_message: target_state {:?} not allowed (only Pending)",
            target_state
        ));
    }
    // Kind restriction: system-internal kinds cannot originate from user IPC.
    if !ipc_write_kind_allowed(partial.kind) {
        return Err(format!(
            "fsd_inbox_write_message: kind {:?} not allowed (only UserPrompt or Broadcast)",
            partial.kind
        ));
    }

    // Build a server-stamped envelope: caller-supplied authority fields are
    // ignored and replaced with trusted values. This closes the v6 review's
    // forge-orchestrator-message attack vector.
    let stamped = InboxMessagePartial {
        message_id: crate::fsd::inbox::generate_message_id_pub(),
        sender_id: "user".into(),
        sender_kind: SenderKind::User,
        target_id: partial.target_id.clone(),
        kind: partial.kind,
        content: partial.content.clone(),
        created_at_ms: crate::fsd::inbox::now_ms_pub(),
        run_id: partial.run_id.clone(),
        task_id: partial.task_id.clone(),
        // turn never carries on user-authored messages (envelope invariant
        // enforced by validate(): only IterationReport is allowed turn=Some).
        turn: None,
        source_cmd_id: partial.source_cmd_id.clone(),
        // sn/rn are leader-mediated nonces; user IPC does not bear them.
        sn: None,
        rn: None,
        attempt: 1,
    };

    let result =
        storage::write_inbox_payload_atomic(&scope, &stamped, target_state, &*state.seq_global)?;

    // Round-12 reflection per codex1+codex2+codex3: poller.rs's
    // wake-hierarchy doc claims `fsd_inbox_*` commands notify the
    // matching leader poller after a successful write so frontend-
    // originated writes use the same fast path as the in-process
    // orchestrator notify. Wire that here via the testable helper
    // `notify_leader_poller_if_present`. Without this, frontend
    // writes wait up to `IDLE_POLL_INTERVAL_MS` (2s) for the timer
    // to pick the new pending file up.
    notify_leader_poller_if_present(&state.leader_inbox_pollers, &scope);

    Ok(result)
}

/// Best-effort: if `scope` is a `Leader` scope and a matching poller
/// is registered in `pollers`, signal its `Notify` so it wakes
/// immediately for the just-written `.pending/` file. Otherwise no-op.
///
/// Round-12 reflection per codex1+codex2+codex3: closes the round-11
/// doc/code mismatch where `poller.rs`'s wake-hierarchy doc claimed
/// the Tauri `fsd_inbox_*` commands notify the matching poller but
/// the implementation only wrote to storage. Notify failures (poison
/// lock, scope is Global/Agent, no matching poller) are silently
/// tolerated because the timer fallback (`IDLE_POLL_INTERVAL_MS`)
/// still delivers within 2s.
pub(crate) fn notify_leader_poller_if_present(
    pollers: &std::sync::Mutex<
        std::collections::HashMap<String, crate::state::LeaderPollerEntry>,
    >,
    scope: &InboxScope,
) {
    let handle = match scope {
        InboxScope::Leader { handle } => handle,
        InboxScope::Global | InboxScope::Agent { .. } => return,
    };
    if let Ok(map) = pollers.lock() {
        if let Some(entry) = map.get(handle) {
            entry.notify.notify_one();
        }
    }
}

/// List filenames in `${scope}/.pending/` in lex-sorted (delivery) order,
/// up to `limit` entries. Caller-side capping prevents pathological
/// large-directory scans. Pass 0 for "no limit". Plan v6 §2.5.
#[tauri::command]
pub async fn fsd_inbox_list_pending(
    scope: InboxScope,
    limit: u32,
) -> Result<Vec<String>, String> {
    let mut all = storage::list_inbox_pending(&scope)?;
    if limit > 0 && all.len() > limit as usize {
        all.truncate(limit as usize);
    }
    Ok(all)
}

/// Atomically claim a specific pending file: `.pending/<filename>`
/// → `.processing/<filename>`. Returns:
///
/// - `Ok(Some(ClaimedMessage))` — claim succeeded; caller now owns the message
///   and must `ack` after delivery. The envelope is deserialized AND
///   `validate()`-checked before being returned, so callers receive only
///   well-formed envelopes (post-review hardening per codex2 task-46 §2 +
///   codex3 task-47 §2).
/// - `Ok(None)` — race lost (another claimer got there first OR the file
///   was already moved/reaped). Caller should pick another candidate.
/// - `Err(...)` — validation, scope, or I/O error. Caller-supplied
///   `filename` is rejected unless it is a canonical pending-lane filename
///   per `parse_seq_from_filename`; this prevents nested path components,
///   bogus extensions, and authority-field corruption via filename forgery.
///
/// Caller is expected to (a) call `fsd_inbox_list_pending`, (b) iterate
/// candidates in sort order, (c) call this command on each until one
/// succeeds. Plan v6 §2.5 / claim-deliver-ack pattern.
#[tauri::command]
pub async fn fsd_inbox_claim(
    scope: InboxScope,
    filename: String,
) -> Result<Option<ClaimedMessage>, String> {
    scope.validate()?;
    // Reject path separators / nested components — filename must be a basename.
    if filename.contains('/') || filename.contains('\\') {
        return Err("fsd_inbox_claim: filename must not contain path separators".into());
    }
    // Reject non-canonical filenames so callers can't bypass the lex-sort
    // delivery order or forge dedup keys. parse_seq_from_filename returns
    // None for any filename that doesn't match the strict ordered-lane shape.
    if crate::fsd::inbox::parse_seq_from_filename(&filename).is_none() {
        return Err(format!(
            "fsd_inbox_claim: filename '{}' is not a canonical pending-lane name",
            filename
        ));
    }

    let from_rel = format!("{}/{}", scope.state_dir(InboxState::Pending), filename);
    let to_rel = format!("{}/{}", scope.state_dir(InboxState::Processing), filename);
    let claimed = storage::claim_inbox_file(&from_rel, &to_rel)?;
    if !claimed {
        return Ok(None);
    }
    // Claim succeeded — read the file content and parse the envelope.
    let memory_root = crate::commands::memory::get_memory_root()?;
    let abs = memory_root.join(&to_rel);
    let body = std::fs::read_to_string(&abs).map_err(|e| e.to_string())?;
    let envelope: InboxMessage = serde_json::from_str(&body).map_err(|e| e.to_string())?;
    // Validate the envelope semantic invariants (kind ⟺ turn, schema=1,
    // message_id 16-hex). Post-review per codex3 task-47 §2.
    envelope
        .validate()
        .map_err(|e| format!("claimed envelope failed validate(): {}", e))?;

    // Cross-check: filename suffix `-<id>.json` MUST equal envelope.message_id.
    // Without this, a malformed pending file (filename id A, envelope id B)
    // would claim successfully but later ack would fail because the suffix
    // check in `fsd_inbox_ack` rejects mismatch — leaving the file stuck
    // in `.processing/`. Per codex2 task-51 "Remaining finding".
    if !filename_matches_message_id(&filename, &envelope.message_id) {
        // Move the malformed file to .failed/ so it doesn't block the
        // pending lane forever. Best-effort; if move fails, just leave
        // it in .processing/ and surface the error.
        let failed_rel = format!("{}/{}", scope.state_dir(InboxState::Failed), filename);
        let _ = storage::claim_inbox_file(&to_rel, &failed_rel);
        return Err(format!(
            "fsd_inbox_claim: filename '{}' message-id suffix does not match envelope.message_id '{}'; \
             moved to .failed/ (likely planted/malformed file)",
            filename, envelope.message_id
        ));
    }

    let claimed_at_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    Ok(Some(ClaimedMessage {
        envelope,
        claim_token: filename,
        claimed_at_ms,
    }))
}

/// Acknowledge successful delivery: rename `.processing/<full_filename>`
/// → `.processed/<message_id>.json` (the dedup ledger). The truncation to
/// `<message_id>.json` is intentional — plan v6 §2.3, the dedup ledger uses
/// cmd_id-only as its key for `Path::exists` lookups.
///
/// Validation (post-review hardening per codex2 task-46 §2 + codex3 task-47 §2):
/// - `full_filename` must be a basename matching the canonical pending-lane
///   shape (`parse_seq_from_filename` accepts it).
/// - `message_id` must be 16 lowercase hex chars.
/// - `message_id` must equal the suffix portion of `full_filename` — this
///   prevents an attacker from acking a valid `.processing/` file under
///   the wrong dedup key, which would corrupt the ledger.
///
/// Returns `Ok(true)` on success, `Ok(false)` if the file was already
/// reaped/moved (idempotent retry).
#[tauri::command]
pub async fn fsd_inbox_ack(
    scope: InboxScope,
    full_filename: String,
    message_id: String,
) -> Result<bool, String> {
    // Filename hygiene.
    if full_filename.contains('/') || full_filename.contains('\\') {
        return Err("fsd_inbox_ack: full_filename must not contain path separators".into());
    }
    if crate::fsd::inbox::parse_seq_from_filename(&full_filename).is_none() {
        return Err(format!(
            "fsd_inbox_ack: full_filename '{}' is not a canonical name",
            full_filename
        ));
    }
    // Message-ID hygiene.
    validate_id_hex(&message_id, MESSAGE_ID_HEX_WIDTH)
        .map_err(|e| format!("fsd_inbox_ack: invalid message_id: {}", e))?;
    // Cross-check: the filename's tail must end with `-<message_id>.json`.
    // Canonical shape is `${pri:1}-${seq:020}-${ts:013}-${msg_id:16}.json`
    // so the suffix slice MUST equal `-${message_id}.json`. Reuses the
    // shared `filename_matches_message_id` helper for SST.
    if !filename_matches_message_id(&full_filename, &message_id) {
        return Err(format!(
            "fsd_inbox_ack: filename '{}' does not match message_id '{}'",
            full_filename, message_id
        ));
    }

    storage::ack_inbox_message(&scope, &full_filename, &message_id)
}

/// Reap stale `.processing/` claims older than `older_than_secs` back to
/// `.pending/`. Returns the number of files moved. Used by Phase B's
/// periodic reaper task and as a manual maintenance hook from the UI.
/// Plan v6 §2.6 retention table.
///
/// 30s default is the v6-recommended TTL for the stale-claim window.
#[tauri::command]
pub async fn fsd_inbox_reap_stale(
    scope: InboxScope,
    older_than_secs: u64,
) -> Result<u32, String> {
    storage::reap_stale_inbox_claims(&scope, older_than_secs)
}

/// Pure check used by both `fsd_inbox_claim` and `fsd_inbox_ack` to verify
/// that a canonical filename's `-<id>.json` suffix matches a given
/// `message_id`. Extracted as a `pub(crate)` helper so it can be unit-tested
/// directly without spinning up a Tauri `State` harness. Per codex2 task-56
/// + claude4 task-58 §3.1 ("command-boundary tests are mostly serde shape
/// checks; the strongest hardening lacks direct tests").
pub(crate) fn filename_matches_message_id(filename: &str, message_id: &str) -> bool {
    filename.ends_with(&format!("-{}.json", message_id))
}

/// Pure check matching `fsd_inbox_write_message`'s kind restriction. Only
/// user-originated kinds may transit the IPC boundary; system kinds
/// (Control, IterationReport, AgentMessage) are produced by server-side
/// helpers. Extracted for direct testability.
pub(crate) fn ipc_write_kind_allowed(kind: MessageKind) -> bool {
    matches!(kind, MessageKind::UserPrompt | MessageKind::Broadcast)
}

/// Pure check matching `fsd_inbox_write_message`'s target-lane restriction.
/// External writers may only enqueue Pending messages — Audit is
/// orchestrator-only (divergence-log integrity); the other lanes are
/// managed by the storage layer's lifecycle.
pub(crate) fn ipc_write_target_state_allowed(state: InboxState) -> bool {
    matches!(state, InboxState::Pending)
}

#[cfg(test)]
mod tests {
    //! IPC-layer tests. Direct Tauri command invocation requires a full
    //! `State<'_, AppState>` harness which is impractical for unit tests;
    //! instead, the validation/cross-check logic is extracted into
    //! `pub(crate)` pure helpers and exercised here.

    use super::*;

    // ---- Restriction tables (post-review accuracy fix) ----

    /// Plan v6 §2.5 + post-review (codex2 task-51 Low #2 + claude4 task-58
    /// §3.1): the previous test asserted on a stale matcher pattern that
    /// passed accidentally for Processing/Processed/Failed/Tmp without
    /// actually exercising the Audit rejection. This rewrite uses the
    /// extracted `ipc_write_target_state_allowed` helper to verify the
    /// real invariant: ONLY Pending is allowed.
    #[test]
    fn ipc_write_only_pending_target_allowed() {
        // Pending is the single allowed target.
        assert!(ipc_write_target_state_allowed(InboxState::Pending));
        // Every other state — including Audit which round-2 hardening
        // explicitly removed from the IPC surface — must be rejected.
        for bad in [
            InboxState::Audit,
            InboxState::Processing,
            InboxState::Processed,
            InboxState::Failed,
            InboxState::Tmp,
        ] {
            assert!(
                !ipc_write_target_state_allowed(bad),
                "InboxState::{:?} must NOT be allowed as IPC write target",
                bad
            );
        }
    }

    /// Plan v6 + post-review (codex2 task-46 §1 + claude5 task-49 §2.5):
    /// IPC writes are restricted to user-originated kinds; system kinds
    /// (Control / IterationReport / AgentMessage) are produced only by
    /// server-side helpers. Direct unit test of the `ipc_write_kind_allowed`
    /// helper.
    #[test]
    fn ipc_write_only_user_kinds_allowed() {
        assert!(ipc_write_kind_allowed(MessageKind::UserPrompt));
        assert!(ipc_write_kind_allowed(MessageKind::Broadcast));
        for bad in [
            MessageKind::Control,
            MessageKind::IterationReport,
            MessageKind::AgentMessage,
        ] {
            assert!(
                !ipc_write_kind_allowed(bad),
                "MessageKind::{:?} must NOT be allowed at IPC boundary",
                bad
            );
        }
    }

    // ---- Filename ↔ message_id cross-check ----

    /// Plan v6 + post-review (codex2 task-51 "Remaining finding" +
    /// claude4 task-58 §3.2): the cross-check logic prevents claim
    /// returning an envelope whose internal `message_id` doesn't match
    /// the filename suffix. Direct unit test of the extracted helper.
    #[test]
    fn filename_matches_message_id_happy_path() {
        // Canonical filename: `${pri:1}-${seq:020}-${ts:013}-${id:16}.json`
        let canonical = "5-00000000000000000043-1714823900000-0123456789abcdef.json";
        assert!(filename_matches_message_id(canonical, "0123456789abcdef"));
    }

    #[test]
    fn filename_matches_message_id_rejects_mismatched_suffix() {
        // Filename's id is "0123...ef" but caller claims it's "abcd...ef".
        // The forge-the-dedup-key attack vector — must reject.
        let canonical = "5-00000000000000000043-1714823900000-0123456789abcdef.json";
        assert!(!filename_matches_message_id(canonical, "abcdef0123456789"));
    }

    #[test]
    fn filename_matches_message_id_rejects_partial_match() {
        // The full message_id must match — substring matches must NOT pass.
        // Filename id ends in "abcdef", claimer says id is just "ef".
        // The leading "-" + ".json" delimiter prevents this.
        let canonical = "5-00000000000000000043-1714823900000-0123456789abcdef.json";
        assert!(!filename_matches_message_id(canonical, "ef"));
    }

    #[test]
    fn filename_matches_message_id_rejects_empty_id() {
        let canonical = "5-00000000000000000043-1714823900000-0123456789abcdef.json";
        assert!(!filename_matches_message_id(canonical, ""));
    }

    // ---- Envelope serde + scope round-trip ----

    #[test]
    fn scope_serde_through_inbox_scope_argument_shape() {
        // Verifies that the InboxScope type used at the IPC boundary
        // round-trips through JSON cleanly. Frontend code will call these
        // commands with JSON-serialized InboxScope arguments.
        let cases = vec![
            InboxScope::Global,
            InboxScope::Leader { handle: "claude1".into() },
            InboxScope::Agent { agent_id: "abc12345".into() },
        ];
        for scope in cases {
            let json = serde_json::to_string(&scope).expect("serialize");
            let parsed: InboxScope = serde_json::from_str(&json).expect("deserialize");
            assert_eq!(scope, parsed);
        }
    }

    #[test]
    fn inbox_state_serializes_snake_case() {
        // Frontend invocations send InboxState as snake_case JSON strings
        // (per the `#[serde(rename_all = "snake_case")]` on InboxState).
        let cases = [
            (InboxState::Pending, "\"pending\""),
            (InboxState::Audit, "\"audit\""),
            (InboxState::Processed, "\"processed\""),
            (InboxState::Processing, "\"processing\""),
            (InboxState::Failed, "\"failed\""),
            (InboxState::Tmp, "\"tmp\""),
        ];
        for (state, expected) in cases {
            assert_eq!(serde_json::to_string(&state).unwrap(), expected);
            let parsed: InboxState = serde_json::from_str(expected).unwrap();
            assert_eq!(parsed, state);
        }
    }

    // ---- notify_leader_poller_if_present (round-12 follow-up) ---------
    //
    // Round-12 reflection per codex1+codex2+codex3: the wake-hierarchy
    // doc in poller.rs claimed `fsd_inbox_*` IPC commands notify the
    // matching leader poller; previously they did not. The helper is
    // tested in isolation here so the contract is pinned even though
    // the full Tauri command can't be invoked without a runtime
    // harness.

    fn build_pollers_with_handle(
        handle: &str,
    ) -> (
        std::sync::Mutex<std::collections::HashMap<String, crate::state::LeaderPollerEntry>>,
        std::sync::Arc<tokio::sync::Notify>,
    ) {
        let notify = std::sync::Arc::new(tokio::sync::Notify::new());
        // We need a LeaderPollerEntry. Its `join` field requires a
        // tokio JoinHandle — spawn a tiny no-op so we have a real one.
        // The Drop impl aborts the join, so the spawn is harmless even
        // outside a tokio runtime once dropped.
        let rt = tokio::runtime::Builder::new_current_thread()
            .build()
            .expect("build rt");
        let join = rt.spawn(async {});
        let entry = crate::state::LeaderPollerEntry {
            join,
            notify: notify.clone(),
        };
        let mut map = std::collections::HashMap::new();
        map.insert(handle.to_string(), entry);
        // Keep the runtime alive for the duration of the test by leaking
        // it intentionally — the entry's JoinHandle would otherwise fire
        // its abort-on-drop on a torn-down runtime. This is a unit test;
        // the leak is bounded to the test process exit.
        std::mem::forget(rt);
        (std::sync::Mutex::new(map), notify)
    }

    #[test]
    fn notify_leader_wakes_when_handle_matches() {
        let (pollers, notify) = build_pollers_with_handle("claude1");
        let scope = InboxScope::Leader {
            handle: "claude1".into(),
        };

        // Pre-arm a `notified()` future so the notify_one signal is
        // observed even though Notify drops a permit if no waiter is
        // pending. tokio::sync::Notify::notify_one stores one permit.
        notify_leader_poller_if_present(&pollers, &scope);

        // Drain the permit synchronously: build a tiny rt and poll the
        // notified future once — it must return Ready.
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("rt");
        let observed = rt.block_on(async {
            tokio::time::timeout(std::time::Duration::from_millis(50), notify.notified())
                .await
                .is_ok()
        });
        assert!(
            observed,
            "notify_one should have stored a permit consumable by notified()"
        );
    }

    #[test]
    fn notify_leader_noop_when_handle_unknown() {
        let (pollers, notify) = build_pollers_with_handle("claude1");
        let scope = InboxScope::Leader {
            handle: "different-leader".into(),
        };

        notify_leader_poller_if_present(&pollers, &scope);

        // No waiter consumed — verify by checking that notified() times
        // out (no permit was stored on the cloned notify).
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("rt");
        let observed = rt.block_on(async {
            tokio::time::timeout(std::time::Duration::from_millis(20), notify.notified())
                .await
                .is_ok()
        });
        assert!(
            !observed,
            "no-op for unknown handle: notified() must time out (no permit stored)"
        );
    }

    #[test]
    fn notify_leader_noop_for_non_leader_scope() {
        let (pollers, notify) = build_pollers_with_handle("claude1");

        // Global and Agent scopes do not have pollers in the current
        // architecture — helper must short-circuit without touching
        // the pollers map.
        notify_leader_poller_if_present(&pollers, &InboxScope::Global);
        notify_leader_poller_if_present(
            &pollers,
            &InboxScope::Agent {
                agent_id: "deadbeef".into(),
            },
        );

        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("rt");
        let observed = rt.block_on(async {
            tokio::time::timeout(std::time::Duration::from_millis(20), notify.notified())
                .await
                .is_ok()
        });
        assert!(
            !observed,
            "Global/Agent scopes must not signal any leader notify"
        );
    }
}
