// Codex CLI adapter.
//
// Source root:   ~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-<ISO-TS>-<UUID>.jsonl
// Line schema:   `{ timestamp, type, payload }` per line.
//                First line carries `type: "session_meta"` with payload
//                `{ cwd, ... }` — used for session identification when
//                triangulating across multiple concurrent CT sessions in
//                the same cwd.
//
// Inclusion table per R4: include `response_item.message.content[*].text`
// (assistant text), and `user_input` payloads. Exclude `function_call`,
// `function_call_output`, `reasoning_text` (Codex's analogue of
// `thinking`), `system_message`, and any other payload type whose semantic
// is internal/tool-side.

use super::super::{
    ContentBlockTable, DiscoveryError, NormalizeContext, NormalizedTurn, RawTurn,
    TranscriptAdapter, TranscriptHandle,
};

pub const ADAPTER_VERSION: &str = "0.1.0";

const INCLUSION_TABLE: ContentBlockTable = ContentBlockTable {
    include: &["user_input", "response_item.message.text"],
    exclude: &[
        "function_call",
        "function_call_output",
        "reasoning_text",
        "system_message",
        "session_meta",
        "tool_call",
        "tool_result",
    ],
};

pub struct CodexAdapter;

impl TranscriptAdapter for CodexAdapter {
    /// # Returns `"codex"`. # Errors None. # Side effects None.
    /// # Invariants Constant. # Concurrency Pure. # Lifecycle Static.
    /// # Test contract Equals `fs_gate::ALLOWED_ROOTS` codex entry.
    fn tool_id(&self) -> &'static str {
        "codex"
    }

    /// # Returns `ADAPTER_VERSION`. # Errors None. # Side effects None.
    /// # Invariants Semver. # Concurrency Pure. # Lifecycle Static.
    /// # Test contract Parses as semver.
    fn adapter_version(&self) -> &'static str {
        ADAPTER_VERSION
    }

    /// PID→fd discovery for Codex CLI.
    ///
    /// # Inputs Same trait shape as Claude.
    /// # Returns `TranscriptHandle` resolving to a rollout JSONL under
    /// `~/.codex/sessions/<YYYY>/<MM>/<DD>/`.
    /// # Errors Same as trait.
    /// # Side effects One lsof / proc-fd call.
    /// # Invariants Path matches `rollout-<ISO-TS>-<UUID>.jsonl` pattern;
    /// canonicalized.
    /// # Concurrency Same as trait.
    /// # Lifecycle Same as trait.
    /// # Test contract Returns `NoMatchingFd` when the PID hasn't opened
    /// a rollout file yet (Codex creates the file on first model call,
    /// not on launch).
    fn discover_session(
        &self,
        agent_handle: &str,
        pid: i32,
        spawned_at_unix_ms: i64,
    ) -> Result<TranscriptHandle, DiscoveryError> {
        let _ = (agent_handle, pid, spawned_at_unix_ms);
        todo!()
    }

    /// # Returns `&INCLUSION_TABLE`. # Errors None. # Side effects None.
    /// # Invariants `exclude` MUST contain `"reasoning_text"` (Codex
    /// equivalent of Claude's `thinking`).
    /// # Concurrency Pure. # Lifecycle Consulted per turn.
    /// # Test contract `exclude.contains(&"reasoning_text")` AND
    /// `exclude.contains(&"function_call")`.
    fn inclusion_table(&self) -> &ContentBlockTable {
        &INCLUSION_TABLE
    }

    /// Parse Codex rollout JSONL bytes.
    ///
    /// # Inputs Same shape as trait.
    /// # Returns Same shape as trait. First line of any rollout file is
    /// `{ type: "session_meta" }` — the parser MUST still emit it as a
    /// `RawTurn`; `normalize` filters it out via the inclusion table.
    /// # Errors Per-line parse failures dropped silently.
    /// # Side effects None. # Invariants `consumed ≤ bytes.len()`.
    /// # Concurrency Pure. # Lifecycle Tailer callback.
    /// # Test contract Bytes containing only the `session_meta` line emit
    /// one `RawTurn`; subsequent `normalize` returns `None` for it.
    fn parse_native_lines(&self, bytes: &[u8]) -> (Vec<RawTurn>, usize) {
        let _ = bytes;
        todo!()
    }

    /// Normalize one Codex turn.
    ///
    /// # Inputs Same shape as trait.
    /// # Returns `Some(NormalizedTurn)` for `user_input` payloads
    /// (role=User) and `response_item` payloads containing visible text
    /// (role=Assistant). `None` for `session_meta`, `reasoning_text`,
    /// `function_call`, `function_call_output`, `tool_call`, `tool_result`,
    /// `system_message`.
    /// # Errors Never panics. # Side effects None.
    /// # Invariants `source_tool == "codex"`; `ts_iso8601` is set from
    /// the line's top-level `timestamp` field when present (`ts_source =
    /// Tool`), else CT-side fallback.
    /// # Concurrency Pure. # Lifecycle Per-turn.
    /// # Test contract Turn with `payload.type == "reasoning_text"`
    /// returns `None`. Turn with `payload.type == "user_input"` and
    /// `payload.text == "hello"` returns `Some` with `text_visible ==
    /// "hello"` and `role == User`.
    fn normalize(&self, raw: RawTurn, ctx: NormalizeContext<'_>) -> Option<NormalizedTurn> {
        let _ = (raw, ctx);
        todo!()
    }
}
