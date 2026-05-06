//! FSD inbox subsystem types (plan v6 PR-2).
//!
//! Defines the shared envelope, scope, state, and helpers used by the
//! orchestrator and Tauri command layer to read/write inbox messages
//! under `${memory_root}/inbox/`.
//!
//! ## Lanes
//!
//! Each inbox is a directory containing six sub-lanes:
//!
//! - `.tmp/`         — producer staging; files here are mid-write.
//! - `.pending/`     — ordered queue; lex-sort delivers in priority+time order.
//! - `.processing/`  — claimed by a poller; in-flight delivery (30s stale TTL).
//! - `.processed/`   — dedup ledger as `<message_id>.json` (24h TTL).
//! - `.audit/`       — Phase A shadow audit; full filename retained 7 days then deleted.
//! - `.failed/`      — poison messages after `MAX_ATTEMPTS=3`; manual triage.
//!
//! ## Filename schemes (asymmetric per role; plan v6 §2.3)
//!
//! - `.pending/.processing/.audit/.failed/.tmp/`:
//!   `${priority_inv:1}-${seq_global:020}-${ts_ms:013}-${message_id:16}.json`
//!   Lex-sort yields delivery order (priority DESC then seq ASC then time ASC).
//!
//! - `.processed/`: `${message_id:16}.json` only — single `Path::exists()`
//!   is the whole dedup-check API.
//!
//! ## Authorization
//!
//! `InboxScope::validate()` enforces ID-component rules (delegating to
//! `super::storage::validate_id_component` for SST). Path-traversal segments
//! and symlinks are caught at the storage layer when paths are materialized.
//!
//! ## PR scope (plan v6 PR-2)
//!
//! This module ships the types, validators, and filename helpers in PR-2.
//! No consumers exist yet — those land in PR-3a (storage helpers + reapers),
//! PR-3b (Tauri commands), PR-4 (orchestrator shadow-audit hook). The
//! module-level `#[allow(dead_code)]` mirrors the precedent at
//! `storage.rs:28,41,90,123` for forward-declared Phase scaffolding and is
//! removed once consumers land.

#![allow(dead_code)]

use serde::{Deserialize, Serialize};

use super::storage::{validate_id_component, INBOX_PREFIX};

// ---------------------------------------------------------------------------
// Filename schema constants (plan v6 §2.7)
// ---------------------------------------------------------------------------

/// Message ID width in hex characters. 16 hex = 64 bits → birthday collision
/// probability negligible at any practical horizon. Plan v6 §2.7 / v4 #16.
pub(crate) const MESSAGE_ID_HEX_WIDTH: usize = 16;

/// Agent ID width in hex characters. 8 hex = 32 bits — backward-compatible
/// with the existing `generate_8hex` orchestrator helper. Plan v6 §2.14 #17.
#[allow(dead_code)] // PR-PreC consumer
pub(crate) const AGENT_ID_HEX_WIDTH: usize = 8;

/// Schema version stamped on every envelope. Bumped on breaking changes to
/// `InboxMessage`. Plan v6 §A.1.3.
pub(crate) const ENVELOPE_SCHEMA_VERSION: u8 = 1;

/// Maximum delivery attempts before a message is moved to `.failed/`.
/// Plan v6 §2.10 / v4 #15.
#[allow(dead_code)] // PR-3a consumer (poller)
pub(crate) const MAX_ATTEMPTS: u32 = 3;

// ---------------------------------------------------------------------------
// Sender / message kind
// ---------------------------------------------------------------------------

/// Origin of a message's authority.
///
/// `Leader` = a user-facing PTY-attached CLI emitted an `##FSD` command that
/// the orchestrator validated and brokered into the inbox.
///
/// `Orchestrator` = the Rust state machine authored the message itself
/// (iteration_report, brokered response, control signals). Self-authoritative.
///
/// `User` = the Tauri UI wrote directly (broadcast, user prompt). Trusted
/// at the IPC boundary.
///
/// `Agent` = reserved for future direct-write paths; not used in Phase A–C
/// because non-leader agents are not authorized to write inbox messages.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SenderKind {
    User,
    Leader,
    Orchestrator,
    Agent,
}

/// What the message represents semantically.
///
/// Determines the `priority` stamped on the envelope (see `priority_for_kind`)
/// and validates the `turn` invariant (see `InboxMessage::validate`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MessageKind {
    /// Orchestrator-emitted summary of a dispatch turn's results.
    /// Carries `turn: Some(_)`. Targeted at the leader.
    IterationReport,
    /// User typed a prompt at the UI; routed to the leader or a specific agent.
    UserPrompt,
    /// User UI wrote to `inbox/global/` for fan-out to all current-turn agents.
    Broadcast,
    /// Leader authorized agent-to-agent or response to an earlier
    /// leader-mediated dispatch. Phase C.
    AgentMessage,
    /// System-internal control signal (force_blocked notice, max_turns reached).
    Control,
}

/// Orchestrator-stamped priority based on `kind`. Caller-provided priority
/// is ignored (plan v6 §2.9). Single source of truth referenced by both
/// the audit-write helper (PR-4) and the per-kind backpressure caps (Phase B).
pub(crate) fn priority_for_kind(kind: MessageKind) -> u8 {
    match kind {
        MessageKind::Control => 9,         // urgent
        MessageKind::UserPrompt => 7,      // high
        MessageKind::IterationReport => 5, // normal
        MessageKind::AgentMessage => 3,    // low
        MessageKind::Broadcast => 1,       // background
    }
}

// ---------------------------------------------------------------------------
// Envelope
// ---------------------------------------------------------------------------

/// Inbox message envelope. Lives on disk as a single JSON file in one of the
/// six lanes. Schema version 1.
///
/// Field invariants enforced by `validate()`:
/// - `kind == IterationReport` IFF `turn == Some(_)` (plan v6 §2.7 / claude4 §3.3).
/// - `message_id` is exactly 16 lowercase hex chars.
/// - `schema == ENVELOPE_SCHEMA_VERSION`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct InboxMessage {
    pub message_id: String,
    pub schema: u8,
    pub sender_id: String,
    pub sender_kind: SenderKind,
    pub target_id: String,
    pub kind: MessageKind,
    pub content: String,
    pub created_at_ms: u64,
    pub seq_global: u64,
    pub priority: u8,
    pub run_id: Option<String>,
    pub task_id: Option<String>,
    /// Only `Some(_)` when `kind == IterationReport`. Validated.
    pub turn: Option<u32>,
    pub source_cmd_id: Option<String>,
    pub sn: Option<String>,
    pub rn: Option<String>,
    pub attempt: u32,
}

/// Envelope without the orchestrator-stamped fields (`seq_global`, `priority`).
/// Producers construct this; storage helper stamps the missing fields just
/// before write. Re-centers the writer-monopoly invariant per plan v6 §2.6.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InboxMessagePartial {
    pub message_id: String,
    pub sender_id: String,
    pub sender_kind: SenderKind,
    pub target_id: String,
    pub kind: MessageKind,
    pub content: String,
    pub created_at_ms: u64,
    pub run_id: Option<String>,
    pub task_id: Option<String>,
    pub turn: Option<u32>,
    pub source_cmd_id: Option<String>,
    pub sn: Option<String>,
    pub rn: Option<String>,
    pub attempt: u32,
}

impl InboxMessage {
    /// Validate envelope invariants. Called at write time and at parse time
    /// (when reading audit/processed files for diagnostics).
    pub(crate) fn validate(&self) -> Result<(), String> {
        if self.schema != ENVELOPE_SCHEMA_VERSION {
            return Err(format!(
                "schema: expected {}, got {}",
                ENVELOPE_SCHEMA_VERSION, self.schema
            ));
        }
        validate_id_hex(&self.message_id, MESSAGE_ID_HEX_WIDTH)
            .map_err(|e| format!("message_id: {}", e))?;
        // `turn` invariant per plan v6 §2.7:
        match (self.kind, self.turn) {
            (MessageKind::IterationReport, None) => {
                Err("kind=IterationReport requires turn=Some(_)".into())
            }
            (k, Some(_)) if k != MessageKind::IterationReport => {
                Err(format!("kind={:?} must not carry turn", k))
            }
            _ => Ok(()),
        }
    }
}

// ---------------------------------------------------------------------------
// Inbox state (sub-directory)
// ---------------------------------------------------------------------------

/// Which lane a message currently lives in. Maps to the sub-directory name
/// under each inbox.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum InboxState {
    Tmp,
    Pending,
    Processing,
    Processed,
    Audit,
    Failed,
}

impl InboxState {
    pub(crate) fn dir_name(self) -> &'static str {
        match self {
            InboxState::Tmp => ".tmp",
            InboxState::Pending => ".pending",
            InboxState::Processing => ".processing",
            InboxState::Processed => ".processed",
            InboxState::Audit => ".audit",
            InboxState::Failed => ".failed",
        }
    }
}

// ---------------------------------------------------------------------------
// InboxScope — typed addressing
// ---------------------------------------------------------------------------

/// Strongly-typed inbox addressing. Replaces caller-supplied path strings
/// at every public API boundary so traversal attacks (`inbox/../etc/passwd`)
/// are impossible at the type level. Plan v6 §2.6 / v4 #6.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", content = "value", rename_all = "snake_case")]
pub enum InboxScope {
    /// User-broadcast inbox. Single, root-level.
    Global,
    /// Per-leader inbox keyed by the leader's session handle.
    Leader { handle: String },
    /// Per-agent inbox keyed by the agent's 8-hex ID. Phase C.
    #[allow(dead_code)] // PR-PreC consumer
    Agent { agent_id: String },
}

impl InboxScope {
    /// Validate scope identifier components. Returns Err on empty/disallowed
    /// chars/traversal. Reuses `super::storage::validate_id_component`
    /// (storage.rs:253) as the single source of truth.
    pub(crate) fn validate(&self) -> Result<(), String> {
        match self {
            InboxScope::Global => Ok(()),
            InboxScope::Leader { handle } => validate_id_component("leader_handle", handle),
            InboxScope::Agent { agent_id } => {
                validate_id_component("agent_id", agent_id)?;
                validate_id_hex(agent_id, AGENT_ID_HEX_WIDTH)
                    .map_err(|e| format!("agent_id: {}", e))
            }
        }
    }

    /// Inbox directory relative to `${memory_root}`. PRIVATE-CRATE — only
    /// storage helpers should construct paths from this. Plan v6 §2.6 +
    /// codex2 task-39 §4.
    pub(crate) fn relative_path(&self) -> String {
        match self {
            InboxScope::Global => format!("{}global", INBOX_PREFIX),
            InboxScope::Leader { handle } => format!("{}leader-{}", INBOX_PREFIX, handle),
            InboxScope::Agent { agent_id } => format!("{}agent-{}", INBOX_PREFIX, agent_id),
        }
    }

    /// State sub-directory: `${relative_path()}/<.lane>/`.
    pub(crate) fn state_dir(&self, state: InboxState) -> String {
        format!("{}/{}", self.relative_path(), state.dir_name())
    }
}

// ---------------------------------------------------------------------------
// Filename builders / parsers
// ---------------------------------------------------------------------------

/// Build a filename for the ordered lanes (`.pending`, `.processing`,
/// `.audit`, `.failed`, `.tmp`). Format: `${pri_inv:1}-${seq:020}-${ts:013}-${id:16}.json`
///
/// `priority_inv = 9 - priority` so lex-sort ascending = priority DESC.
/// Plan v6 §2.7.
pub(crate) fn build_pending_filename(priority: u8, seq_global: u64, ts_ms: u64, message_id: &str) -> String {
    debug_assert!(priority <= 9, "priority must be 0..=9");
    let pri_inv = 9u8.saturating_sub(priority);
    format!(
        "{}-{:020}-{:013}-{}.json",
        pri_inv, seq_global, ts_ms, message_id
    )
}

/// Filename used in `.processed/` (dedup ledger). Single `Path::exists()`
/// is the whole API. Plan v6 §2.3.
#[allow(dead_code)] // PR-3a consumer
pub(crate) fn dedup_filename(message_id: &str) -> String {
    format!("{}.json", message_id)
}

/// Parse a `seq_global` value out of a pending-style filename. Used by
/// `init_seq_global_from_disk` recovery scan. Returns None on malformed
/// filenames so recovery soft-skips garbage. Plan v6 §2.3 + claude4 §3.5.
#[allow(dead_code)] // PR-3a consumer
pub(crate) fn parse_seq_from_filename(name: &str) -> Option<u64> {
    let stripped = name.strip_suffix(".json")?;
    let parts: Vec<&str> = stripped.split('-').collect();
    if parts.len() != 4 {
        return None;
    }
    if parts[0].len() != 1 || !parts[0].chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    if parts[1].len() != 20 || !parts[1].chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    if parts[2].len() != 13 || !parts[2].chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    // Lowercase-only invariant — keeps filenames stable across case-folding
    // filesystems (HFS+) and matches `validate_id_hex` semantics. Uppercase
    // hex digits are rejected here so the round-trip with `build_pending_filename`
    // is canonical and recovery doesn't accept malformed external writes.
    if parts[3].len() != MESSAGE_ID_HEX_WIDTH
        || !parts[3]
            .chars()
            .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase())
    {
        return None;
    }
    parts[1].parse::<u64>().ok()
}

// ---------------------------------------------------------------------------
// ID-width validators (plan v6 §2.14 #17 — single helper, width parameter)
// ---------------------------------------------------------------------------

/// Validate a hex-string ID of an exact width. Used for `message_id` (16),
/// `agent_id` (8). Single source of truth so the two width regimes don't
/// drift into separate near-identical regexes.
pub(crate) fn validate_id_hex(value: &str, width: usize) -> Result<(), String> {
    if value.len() != width {
        return Err(format!(
            "expected exactly {} hex chars, got {}",
            width,
            value.len()
        ));
    }
    if !value.chars().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()) {
        return Err("must be lowercase hex (0-9 a-f)".into());
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Claimed-message handle (returned by Tauri claim command in PR-3b)
// ---------------------------------------------------------------------------

/// Result of a successful claim by a poller. Plan v6 §2.14.
#[allow(dead_code)] // PR-3b consumer
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClaimedMessage {
    pub envelope: InboxMessage,
    /// Filename in `.processing/` — used by ack/reap to locate the file.
    pub claim_token: String,
    pub claimed_at_ms: u64,
}

// ---------------------------------------------------------------------------
// Shadow-audit helper (plan v6 PR-4)
// ---------------------------------------------------------------------------

/// Generate a fresh 16-hex `message_id`. Plan v6 §2.7.
fn generate_message_id() -> String {
    use rand::RngCore;
    let mut bytes = [0u8; 8]; // 8 bytes = 16 hex chars
    rand::thread_rng().fill_bytes(&mut bytes);
    hex::encode(bytes)
}

/// Current wall-clock millis (UTC). Used for `created_at_ms` envelope field.
fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Crate-internal alias of `generate_message_id` for use by the Tauri command
/// layer when stamping server-side envelopes (post-review hardening per
/// codex2 task-46 §1 + claude5 task-49 §2.5). Distinct name avoids ambiguity
/// with the test-only fixture-generator pattern elsewhere.
pub(crate) fn generate_message_id_pub() -> String {
    generate_message_id()
}

/// Crate-internal alias of `now_ms` for the IPC layer's server-stamped
/// envelope construction.
pub(crate) fn now_ms_pub() -> u64 {
    now_ms()
}

/// Phase A shadow-audit helper (plan v6 PR-4 / §2.7).
///
/// Builds an `IterationReport` envelope and writes it to
/// `inbox/leader-<handle>/.audit/<filename>.json` via the storage layer.
/// Called by `orchestrator::inject_iteration_report` AFTER the existing
/// `app.emit` event so the inbox version is a strict shadow of the
/// PTY-event payload (plan v6 §2.4 success criterion).
///
/// Returns the filename written. Errors propagate to the caller, which
/// is expected to log-and-continue (audit failure must NOT alter
/// `DispatchResponse` per plan v6 §2.6 PR-4 spec).
pub(crate) fn write_iteration_report_audit(
    seq_provider: &dyn super::storage::SeqProvider,
    leader_handle: &str,
    run_id: &str,
    turn: u32,
    report: &str,
) -> Result<String, String> {
    let scope = InboxScope::Leader {
        handle: leader_handle.to_string(),
    };
    let partial = build_iteration_report_partial(leader_handle, run_id, turn, report);
    super::storage::write_inbox_payload_atomic(&scope, &partial, InboxState::Audit, seq_provider)
}

/// Phase B real-delivery helper (plan v6 §B.1).
///
/// Same envelope shape as `write_iteration_report_audit` but writes to
/// `.pending/` so the `LeaderInboxPoller` will pick it up, deliver via
/// `fsd-inbox-leader-message-<handle>` Tauri event, and ack to `.processed/`.
///
/// Behind the `fsd_inbox_delivery` feature flag in Tauri settings — only
/// invoked when the flag is `true`. Plan v6 §B.1 + §2.16 #25.
pub(crate) fn write_iteration_report_pending(
    seq_provider: &dyn super::storage::SeqProvider,
    leader_handle: &str,
    run_id: &str,
    turn: u32,
    report: &str,
) -> Result<String, String> {
    let scope = InboxScope::Leader {
        handle: leader_handle.to_string(),
    };
    let partial = build_iteration_report_partial(leader_handle, run_id, turn, report);
    super::storage::write_inbox_payload_atomic(&scope, &partial, InboxState::Pending, seq_provider)
}

/// Shared envelope construction for both `_audit` and `_pending` writers.
fn build_iteration_report_partial(
    leader_handle: &str,
    run_id: &str,
    turn: u32,
    report: &str,
) -> InboxMessagePartial {
    InboxMessagePartial {
        message_id: generate_message_id(),
        sender_id: "orchestrator".into(),
        sender_kind: SenderKind::Orchestrator,
        target_id: format!("leader-{}", leader_handle),
        kind: MessageKind::IterationReport,
        content: report.to_string(),
        created_at_ms: now_ms(),
        run_id: Some(run_id.to_string()),
        task_id: None,
        turn: Some(turn),
        source_cmd_id: None,
        sn: None,
        rn: None,
        attempt: 1,
    }
}

// ===========================================================================
// Tests
// ===========================================================================

#[cfg(test)]
mod tests {
    use super::*;

    // ---- priority_for_kind ----------------------------------------------

    #[test]
    fn priority_for_kind_table() {
        assert_eq!(priority_for_kind(MessageKind::Control), 9);
        assert_eq!(priority_for_kind(MessageKind::UserPrompt), 7);
        assert_eq!(priority_for_kind(MessageKind::IterationReport), 5);
        assert_eq!(priority_for_kind(MessageKind::AgentMessage), 3);
        assert_eq!(priority_for_kind(MessageKind::Broadcast), 1);
    }

    // ---- validate_id_hex ------------------------------------------------

    #[test]
    fn validate_id_hex_accepts_correct_width_lowercase() {
        assert!(validate_id_hex("0123456789abcdef", 16).is_ok());
        assert!(validate_id_hex("a1b2c3d4", 8).is_ok());
    }

    #[test]
    fn validate_id_hex_rejects_wrong_width() {
        let too_short = validate_id_hex("a1b2c3d", 8);
        assert!(too_short.is_err());
        let too_long = validate_id_hex("a1b2c3d4e", 8);
        assert!(too_long.is_err());
    }

    #[test]
    fn validate_id_hex_rejects_non_hex() {
        assert!(validate_id_hex("01234567890abcdz", 16).is_err());
        assert!(validate_id_hex("g1b2c3d4", 8).is_err());
    }

    #[test]
    fn validate_id_hex_rejects_uppercase() {
        // Lowercase-only invariant — keeps filenames stable across
        // case-folding filesystems (HFS+ etc.).
        assert!(validate_id_hex("0123456789ABCDEF", 16).is_err());
    }

    // ---- InboxScope::validate -------------------------------------------

    #[test]
    fn inbox_scope_global_validates() {
        assert!(InboxScope::Global.validate().is_ok());
    }

    #[test]
    fn inbox_scope_leader_validates_handle() {
        assert!(InboxScope::Leader { handle: "claude1".into() }.validate().is_ok());
        assert!(InboxScope::Leader { handle: "leader-1.session_2".into() }.validate().is_ok());
    }

    #[test]
    fn inbox_scope_leader_rejects_bad_handle() {
        let bad = InboxScope::Leader { handle: "../etc/passwd".into() }.validate();
        assert!(bad.is_err());
        let empty = InboxScope::Leader { handle: "".into() }.validate();
        assert!(empty.is_err());
        let traversal = InboxScope::Leader { handle: "..".into() }.validate();
        assert!(traversal.is_err());
        let slash = InboxScope::Leader { handle: "leader/escape".into() }.validate();
        assert!(slash.is_err());
    }

    #[test]
    fn inbox_scope_agent_requires_8hex() {
        // 8-hex agent_id passes both component-rule + width check.
        assert!(InboxScope::Agent { agent_id: "abc12345".into() }.validate().is_ok());
        // Non-hex chars — fails width check (lowercase hex only).
        assert!(InboxScope::Agent { agent_id: "agent-01".into() }.validate().is_err());
        // Wrong width.
        assert!(InboxScope::Agent { agent_id: "abc1".into() }.validate().is_err());
    }

    // ---- InboxScope::relative_path / state_dir --------------------------

    #[test]
    fn inbox_scope_paths_well_formed() {
        assert_eq!(InboxScope::Global.relative_path(), "inbox/global");
        assert_eq!(
            InboxScope::Leader { handle: "claude1".into() }.relative_path(),
            "inbox/leader-claude1"
        );
        assert_eq!(
            InboxScope::Agent { agent_id: "abc12345".into() }.relative_path(),
            "inbox/agent-abc12345"
        );
    }

    #[test]
    fn inbox_scope_state_dir() {
        let scope = InboxScope::Leader { handle: "claude1".into() };
        assert_eq!(scope.state_dir(InboxState::Pending), "inbox/leader-claude1/.pending");
        assert_eq!(scope.state_dir(InboxState::Processing), "inbox/leader-claude1/.processing");
        assert_eq!(scope.state_dir(InboxState::Processed), "inbox/leader-claude1/.processed");
        assert_eq!(scope.state_dir(InboxState::Audit), "inbox/leader-claude1/.audit");
        assert_eq!(scope.state_dir(InboxState::Failed), "inbox/leader-claude1/.failed");
        assert_eq!(scope.state_dir(InboxState::Tmp), "inbox/leader-claude1/.tmp");
    }

    // ---- InboxState::dir_name -------------------------------------------

    #[test]
    fn inbox_state_dir_names() {
        assert_eq!(InboxState::Tmp.dir_name(), ".tmp");
        assert_eq!(InboxState::Pending.dir_name(), ".pending");
        assert_eq!(InboxState::Processing.dir_name(), ".processing");
        assert_eq!(InboxState::Processed.dir_name(), ".processed");
        assert_eq!(InboxState::Audit.dir_name(), ".audit");
        assert_eq!(InboxState::Failed.dir_name(), ".failed");
    }

    // ---- Filename builders / parsers (round-trip table) -----------------
    // Per claude5 task-42 §8.2 + plan v6 PR-2 spec: round-trip filename
    // format. Table-driven tests cover the boundary cases without adding
    // a `proptest` dev-dep.

    fn make_envelope(priority: u8, seq: u64, ts: u64, id: &str) -> (String, String, u64) {
        let filename = build_pending_filename(priority, seq, ts, id);
        (filename, id.to_string(), seq)
    }

    #[test]
    fn build_pending_filename_shape() {
        let f = build_pending_filename(5, 42, 1714823900000, "0123456789abcdef");
        // 9 - 5 = 4 (priority_inv); seq padded 020; ts padded 013; id 16
        assert_eq!(f, "4-00000000000000000042-1714823900000-0123456789abcdef.json");
    }

    #[test]
    fn build_pending_filename_priority_zero() {
        // priority=0 (lowest) → priority_inv=9 → sorts last lex-asc → which
        // is the LATEST in priority-DESC ordering. Background messages
        // genuinely come last under the lex-sort poller.
        let f = build_pending_filename(0, 1, 100, "a1b2c3d4e5f60718");
        assert!(f.starts_with("9-"));
    }

    #[test]
    fn build_pending_filename_priority_nine() {
        // priority=9 (highest) → priority_inv=0 → sorts first lex-asc.
        let f = build_pending_filename(9, 1, 100, "a1b2c3d4e5f60718");
        assert!(f.starts_with("0-"));
    }

    #[test]
    fn parse_seq_from_filename_roundtrip() {
        // Round-trip test: build → parse → compare seq.
        // Note: `ts_ms` width is fixed at 13 digits in the filename schema;
        // values must fit (`ts_ms <= 9_999_999_999_999`, ≈ year 2286).
        // The seq_global field is 20 digits so any u64 fits.
        let cases: Vec<(u8, u64, u64, &str)> = vec![
            (5, 0, 0, "0123456789abcdef"),
            (5, 1, 1_714_823_900_000, "0123456789abcdef"),
            (9, 99, 1_714_823_900_001, "abcdef0123456789"),
            (0, u64::MAX, 9_999_999_999_999, "ffffffffffffffff"),
        ];
        for (pri, seq, ts, id) in cases {
            let (filename, _id, expected_seq) = make_envelope(pri, seq, ts, id);
            let parsed = parse_seq_from_filename(&filename);
            assert_eq!(
                parsed,
                Some(expected_seq),
                "round-trip failed for filename {}",
                filename
            );
        }
    }

    #[test]
    fn parse_seq_from_filename_rejects_malformed() {
        // Must soft-fail (return None) so disk-scan recovery skips garbage
        // instead of panicking. Plan v6 §2.4 + claude4 §3.5.
        assert_eq!(parse_seq_from_filename("garbage.json"), None);
        assert_eq!(parse_seq_from_filename("not-a-real-filename"), None);
        assert_eq!(parse_seq_from_filename(""), None);
        // Wrong segment count.
        assert_eq!(parse_seq_from_filename("5-42-100-id.json"), None);
        assert_eq!(parse_seq_from_filename("5-42-100-id-extra.json"), None);
        // Wrong widths.
        assert_eq!(parse_seq_from_filename("55-00000000000000000042-1714823900000-0123456789abcdef.json"), None); // pri 2 chars
        assert_eq!(parse_seq_from_filename("5-42-1714823900000-0123456789abcdef.json"), None); // seq 2 chars
        // Non-digit in seq.
        assert_eq!(parse_seq_from_filename("5-0000000000000000004x-1714823900000-0123456789abcdef.json"), None);
        // Non-hex in cmd_id.
        assert_eq!(parse_seq_from_filename("5-00000000000000000042-1714823900000-0123456789abcdez.json"), None);
        // No .json suffix.
        assert_eq!(parse_seq_from_filename("5-00000000000000000042-1714823900000-0123456789abcdef"), None);
    }

    #[test]
    fn parse_seq_from_filename_rejects_uppercase_hex() {
        // Lowercase-only invariant per validate_id_hex.
        assert_eq!(parse_seq_from_filename("5-00000000000000000042-1714823900000-0123456789ABCDEF.json"), None);
    }

    #[test]
    fn dedup_filename_shape() {
        assert_eq!(dedup_filename("0123456789abcdef"), "0123456789abcdef.json");
    }

    // ---- InboxMessage::validate -----------------------------------------

    fn ok_envelope() -> InboxMessage {
        InboxMessage {
            message_id: "0123456789abcdef".into(),
            schema: ENVELOPE_SCHEMA_VERSION,
            sender_id: "orchestrator".into(),
            sender_kind: SenderKind::Orchestrator,
            target_id: "leader-claude1".into(),
            kind: MessageKind::IterationReport,
            content: "report content".into(),
            created_at_ms: 1_714_823_900_000,
            seq_global: 42,
            priority: priority_for_kind(MessageKind::IterationReport),
            run_id: Some("r1".into()),
            task_id: None,
            turn: Some(3),
            source_cmd_id: None,
            sn: None,
            rn: None,
            attempt: 1,
        }
    }

    #[test]
    fn validate_envelope_iteration_report_with_turn_passes() {
        let env = ok_envelope();
        assert!(env.validate().is_ok());
    }

    #[test]
    fn validate_envelope_iteration_report_without_turn_fails() {
        // Plan v6 §2.7 invariant: kind=IterationReport ⇒ turn=Some(_).
        let mut env = ok_envelope();
        env.turn = None;
        let r = env.validate();
        assert!(r.is_err());
        assert!(r.unwrap_err().contains("IterationReport requires turn"));
    }

    #[test]
    fn validate_envelope_non_iteration_report_with_turn_fails() {
        // The reverse invariant: only IterationReport carries turn.
        let mut env = ok_envelope();
        env.kind = MessageKind::Broadcast;
        env.turn = Some(3);
        let r = env.validate();
        assert!(r.is_err());
        assert!(r.unwrap_err().contains("must not carry turn"));
    }

    #[test]
    fn validate_envelope_non_iteration_report_without_turn_passes() {
        let mut env = ok_envelope();
        env.kind = MessageKind::AgentMessage;
        env.turn = None;
        assert!(env.validate().is_ok());
    }

    #[test]
    fn validate_envelope_rejects_bad_schema_version() {
        let mut env = ok_envelope();
        env.schema = 99;
        assert!(env.validate().is_err());
    }

    #[test]
    fn validate_envelope_rejects_bad_message_id() {
        let mut env = ok_envelope();
        env.message_id = "tooshort".into();
        assert!(env.validate().is_err());

        let mut env = ok_envelope();
        env.message_id = "ZZZZZZZZZZZZZZZZ".into(); // uppercase hex rejected
        assert!(env.validate().is_err());
    }

    // ---- Envelope JSON round-trip ---------------------------------------

    #[test]
    fn envelope_serde_roundtrip() {
        let env = ok_envelope();
        let json = serde_json::to_string(&env).expect("serialize");
        let parsed: InboxMessage = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(env, parsed);
        assert!(parsed.validate().is_ok());
    }

    #[test]
    fn scope_serde_roundtrip() {
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

    // ---- Shadow-audit helper (plan v6 PR-4) -----------------------------

    use super::super::storage::SeqProvider;
    use std::sync::atomic::{AtomicU64, Ordering};

    /// Plan v6 PR-4 success criterion: write an iteration-report audit
    /// envelope, read it back, and verify field-equality against the
    /// inputs + structural correctness of the envelope.
    ///
    /// This is the test design from v6 §2.4 (field-equality on shared
    /// subset, NOT byte-equality of full payloads — claude4 task-29 §3.3
    /// caught that byte-equality is impossible by construction since
    /// `app.emit` payload has 3 fields and the envelope has 17).
    #[test]
    fn write_iteration_report_audit_field_equality() {
        // Test isolation: ensure we write under the test temp root.
        // (Reuses the same env-var override pattern as storage tests.)
        if std::env::var("CANVAS_TERMINAL_MEMORY_ROOT").is_err() {
            let test_root = std::env::temp_dir()
                .join(format!("canvas-terminal-fsd-test-{}", std::process::id()));
            std::fs::create_dir_all(&test_root).expect("create test_root");
            #[allow(unused_unsafe)]
            unsafe {
                std::env::set_var(
                    "CANVAS_TERMINAL_MEMORY_ROOT",
                    test_root.to_string_lossy().as_ref(),
                );
            }
        }

        let counter = AtomicU64::new(43); // simulate "next free" = 43
        let leader_handle = format!("test-pr4-leader-{}", std::process::id());
        let run_id = "r-pr4-001";
        let turn = 7u32;
        let report = "## Iteration 7\n\nTask t-7-a completed.\n";

        let filename = write_iteration_report_audit(
            &counter as &dyn SeqProvider,
            &leader_handle,
            run_id,
            turn,
            report,
        )
        .expect("audit write should succeed");

        // Counter advanced by 1.
        assert_eq!(counter.load(Ordering::SeqCst), 44);

        // Read the audit file back.
        let scope = InboxScope::Leader { handle: leader_handle.clone() };
        let memory_root = super::super::super::commands::memory::get_memory_root().unwrap();
        let audit_path = memory_root
            .join(scope.state_dir(InboxState::Audit))
            .join(&filename);
        let body = std::fs::read_to_string(&audit_path).expect("audit file readable");
        let env: InboxMessage = serde_json::from_str(&body).expect("envelope deserializes");

        // ===== Structural correctness =====
        assert_eq!(env.schema, ENVELOPE_SCHEMA_VERSION);
        assert_eq!(env.kind, MessageKind::IterationReport);
        assert_eq!(env.sender_kind, SenderKind::Orchestrator);
        assert_eq!(env.message_id.len(), MESSAGE_ID_HEX_WIDTH);
        assert_eq!(env.seq_global, 43, "expected first issued seq=43 (next-free pattern)");
        assert_eq!(env.priority, priority_for_kind(MessageKind::IterationReport));
        assert_eq!(env.attempt, 1);
        // Envelope-validation invariant must hold for what we wrote.
        assert!(env.validate().is_ok());

        // ===== Field-equality on shared subset (the v6 §2.4 success
        //       criterion: PTY-emit payload's 3 fields match the
        //       envelope's corresponding fields). =====
        assert_eq!(env.run_id.as_deref(), Some(run_id));
        assert_eq!(env.turn, Some(turn));
        assert_eq!(env.content, report);

        // ===== Plan v6 §2.7 invariant: kind=IterationReport ⇒ turn=Some =====
        assert!(env.turn.is_some());

        // Filename is canonical (priority + seq + ts + msg_id .json).
        // Validate the parts.
        let parsed_seq = parse_seq_from_filename(&filename);
        assert_eq!(parsed_seq, Some(43));

        // Cleanup
        let _ = std::fs::remove_dir_all(memory_root.join(scope.relative_path()));
    }

    // ---- PR-5: 1000-turn divergence harness (plan v6 §2.11) -------------

    /// Phase A-prime stress harness. Runs 1000 iterations of the shadow-audit
    /// path, asserts every iteration produces a valid audit file with full
    /// field-equality + structural correctness, and reports P50/P99 latency.
    ///
    /// Marked `#[ignore]` so it doesn't slow down the default test cycle.
    /// Run with:
    ///
    ///   cargo test --lib fsd::inbox::tests::pr5_shadow_audit_1000_turn_harness \
    ///     -- --ignored --nocapture
    ///
    /// Exit criteria per plan v6 §2.11:
    ///   - Zero divergences across 1000 turns
    ///   - Monotonic seq_global (no skips, no duplicates)
    ///   - Every envelope round-trips field-equality
    ///   - Owner: @claude1; co-reviewers: @codex3 + @claude4
    #[test]
    #[ignore]
    fn pr5_shadow_audit_1000_turn_harness() {
        // Test isolation — same env-var override pattern as field_equality test.
        if std::env::var("CANVAS_TERMINAL_MEMORY_ROOT").is_err() {
            let test_root = std::env::temp_dir()
                .join(format!("canvas-terminal-fsd-test-{}", std::process::id()));
            std::fs::create_dir_all(&test_root).expect("create test_root");
            #[allow(unused_unsafe)]
            unsafe {
                std::env::set_var(
                    "CANVAS_TERMINAL_MEMORY_ROOT",
                    test_root.to_string_lossy().as_ref(),
                );
            }
        }

        const N: u64 = 1000;
        let leader_handle = format!("test-pr5-harness-{}", std::process::id());
        let scope = InboxScope::Leader { handle: leader_handle.clone() };
        let memory_root = super::super::super::commands::memory::get_memory_root().unwrap();

        // Pre-clean any leftovers from a prior run.
        let _ = std::fs::remove_dir_all(memory_root.join(scope.relative_path()));

        // Counter starts at "next free" = 1 (simulating cold first boot).
        let counter = AtomicU64::new(1);
        let mut latencies_us: Vec<u128> = Vec::with_capacity(N as usize);
        let mut filenames: Vec<String> = Vec::with_capacity(N as usize);
        let mut expected_seqs: Vec<u64> = Vec::with_capacity(N as usize);
        let mut divergence_count: u32 = 0;

        for i in 0..N {
            let run_id = format!("r-pr5-{:04}", i);
            let turn = (i % 16) as u32 + 1;
            let report = format!("## Iteration {}\n\nSynthetic stress payload #{}.\n", i, i);
            let expected_seq = counter.load(Ordering::SeqCst); // pre-fetch peek

            let started = std::time::Instant::now();
            let filename = match write_iteration_report_audit(
                &counter as &dyn super::super::storage::SeqProvider,
                &leader_handle,
                &run_id,
                turn,
                &report,
            ) {
                Ok(f) => f,
                Err(e) => {
                    // Post-review fix (codex2 task-46 §4 + codex3 task-47 §4 +
                    // claude4 task-48 §3.3): the harness's stated intent is
                    // "report divergence count after 1000 iterations." If we
                    // panic on first failure, we lose the diagnostic value of
                    // running through all 1000. Count + log + continue instead.
                    eprintln!("iteration {} write failed: {}", i, e);
                    divergence_count += 1;
                    continue;
                }
            };
            let elapsed_us = started.elapsed().as_micros();
            latencies_us.push(elapsed_us);
            filenames.push(filename.clone());
            expected_seqs.push(expected_seq);

            // Verify counter advanced exactly by 1 (no skips, no double-fires).
            // This is a single-thread invariant; if it fires, the entire
            // harness premise is violated and we abort early.
            assert_eq!(
                counter.load(Ordering::SeqCst),
                expected_seq + 1,
                "iteration {}: counter should have advanced by exactly 1",
                i
            );

            // Field-equality on every iteration. Any I/O or parse failure
            // here is also recorded as a divergence (count + continue).
            let audit_path = memory_root
                .join(scope.state_dir(InboxState::Audit))
                .join(&filename);
            let body = match std::fs::read_to_string(&audit_path) {
                Ok(b) => b,
                Err(e) => {
                    eprintln!("iteration {}: audit file missing: {}", i, e);
                    divergence_count += 1;
                    continue;
                }
            };
            let env: InboxMessage = match serde_json::from_str(&body) {
                Ok(e) => e,
                Err(e) => {
                    eprintln!("iteration {}: deserialize failed: {}", i, e);
                    divergence_count += 1;
                    continue;
                }
            };

            // Per-iteration field-equality assertions.
            if env.run_id.as_deref() != Some(run_id.as_str()) {
                divergence_count += 1;
            }
            if env.turn != Some(turn) {
                divergence_count += 1;
            }
            if env.content != report {
                divergence_count += 1;
            }
            if env.seq_global != expected_seq {
                divergence_count += 1;
            }
            if env.kind != MessageKind::IterationReport {
                divergence_count += 1;
            }
            if env.schema != ENVELOPE_SCHEMA_VERSION {
                divergence_count += 1;
            }
            if env.message_id.len() != MESSAGE_ID_HEX_WIDTH {
                divergence_count += 1;
            }
            if env.validate().is_err() {
                divergence_count += 1;
            }
        }

        // Verify no duplicate seq_globals were issued (monotonicity invariant).
        let unique_seqs: std::collections::HashSet<u64> = expected_seqs.iter().copied().collect();
        assert_eq!(
            unique_seqs.len(),
            N as usize,
            "duplicate seq_global detected — monotonicity invariant violated"
        );

        // Verify the lex-sort of filenames matches issue order. Since priority
        // is uniform (IterationReport ⇒ priority 5 ⇒ priority_inv 4) and
        // seq_global is monotonic, lex-sort should equal issue order.
        let mut lex_sorted = filenames.clone();
        lex_sorted.sort();
        assert_eq!(
            lex_sorted, filenames,
            "filename lex-sort diverged from issue order — priority/seq scheme broken"
        );

        // Compute latency percentiles.
        latencies_us.sort();
        let p50 = latencies_us[(N as usize) / 2];
        let p99 = latencies_us[(N as usize * 99) / 100];
        let p999_idx = ((N as usize * 999) / 1000).min(latencies_us.len() - 1);
        let p999 = latencies_us[p999_idx];
        let max = *latencies_us.last().unwrap();

        eprintln!(
            "PR-5 harness: {} iterations, divergences={}, P50={}μs P99={}μs P99.9={}μs MAX={}μs",
            N, divergence_count, p50, p99, p999, max
        );

        // Plan v6 §2.11 exit criterion: zero divergences.
        assert_eq!(
            divergence_count, 0,
            "PR-5 EXIT CRITERION FAILED: {} divergences across {} iterations",
            divergence_count, N
        );

        // Cleanup
        let _ = std::fs::remove_dir_all(memory_root.join(scope.relative_path()));
    }
}
