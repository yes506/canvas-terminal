// Gemini CLI adapter.
//
// Source root:   ~/.gemini/tmp/<project-slug>/chats/session-<ISO-TS>-<UUID>.jsonl
// Line schema:   first line is a session header
//                `{ sessionId, projectHash, startTime, lastUpdated, kind }`;
//                subsequent lines carry per-turn objects (schema-version
//                dependent; adapter does best-effort field tolerance per D2).
//
// project-slug is the project directory's name OR a hash of its cwd — exact
// derivation is host-version dependent; adapter discovers the active session
// by combining cwd + spawn-timestamp + the PID/open-FD scan.
//
// Inclusion table per R4: include user/model `text` parts. Exclude
// `thoughts` (Gemini's reasoning-trace equivalent), `function_call`,
// `function_response`, anything tool-side.

use super::super::{
    ContentBlockTable, DiscoveryError, NormalizeContext, NormalizedTurn, RawTurn,
    TranscriptAdapter, TranscriptHandle,
};

pub const ADAPTER_VERSION: &str = "0.1.0";

const INCLUSION_TABLE: ContentBlockTable = ContentBlockTable {
    include: &["text"],
    exclude: &[
        "thoughts",
        "function_call",
        "function_response",
        "tool_use",
        "tool_result",
        "session_meta",
        "system",
    ],
};

pub struct GeminiAdapter;

impl TranscriptAdapter for GeminiAdapter {
    /// # Returns `"gemini"`. # Errors None. # Side effects None.
    /// # Invariants Constant. # Concurrency Pure. # Lifecycle Static.
    /// # Test contract Equals `fs_gate::ALLOWED_ROOTS` gemini entry.
    fn tool_id(&self) -> &'static str {
        "gemini"
    }

    /// # Returns `ADAPTER_VERSION`. # Errors None. # Side effects None.
    /// # Invariants Semver. # Concurrency Pure. # Lifecycle Static.
    /// # Test contract Parses as semver.
    fn adapter_version(&self) -> &'static str {
        ADAPTER_VERSION
    }

    /// PID→fd discovery for Gemini CLI.
    ///
    /// # Inputs Same trait shape.
    /// # Returns `TranscriptHandle` under
    /// `~/.gemini/tmp/<project-slug>/chats/`.
    /// # Errors `NoMatchingFd` if the Gemini chat dir does not exist for
    /// this host (older Gemini versions stored elsewhere — fail-soft, NOT
    /// panic).
    /// # Side effects One lsof / proc-fd call.
    /// # Invariants Canonicalized path; passes `fs_gate::check_transcript_root`.
    /// # Concurrency Thread-safe but expensive.
    /// # Lifecycle One-time per opt-in.
    /// # Test contract Hosts where `~/.gemini/tmp` does not exist MUST
    /// produce `NoMatchingFd`, not a panic or filesystem error.
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
    /// # Invariants `exclude` MUST contain `"thoughts"` (Gemini's
    /// reasoning-trace equivalent — boundary-consistent with
    /// OUT OF SCOPE "model-internal state").
    /// # Concurrency Pure. # Lifecycle Per-turn.
    /// # Test contract `exclude.contains(&"thoughts")` AND
    /// `exclude.contains(&"function_call")`.
    fn inclusion_table(&self) -> &ContentBlockTable {
        &INCLUSION_TABLE
    }

    /// Parse Gemini chat JSONL.
    ///
    /// # Inputs Same shape.
    /// # Returns Same shape. First-line header is emitted as a `RawTurn`
    /// like other adapters; `normalize` filters it via the inclusion table.
    /// # Errors Per-line parse failures dropped silently.
    /// # Side effects None.
    /// # Invariants `consumed ≤ bytes.len()`.
    /// # Concurrency Pure. # Lifecycle Tailer callback.
    /// # Test contract Schema-version drift (D2): a field added in a
    /// future Gemini version that the adapter does not know MUST be
    /// dropped silently; the adapter still produces a `RawTurn` for the
    /// known fields.
    fn parse_native_lines(&self, bytes: &[u8]) -> (Vec<RawTurn>, usize) {
        let mut turns = Vec::new();
        let mut consumed: usize = 0;
        let mut line_start: usize = 0;
        for (i, b) in bytes.iter().enumerate() {
            if *b == b'\n' {
                let line = &bytes[line_start..i];
                if !line.is_empty() {
                    if let Ok(payload) = serde_json::from_slice::<serde_json::Value>(line) {
                        turns.push(RawTurn {
                            raw_payload: payload,
                            source_offset: line_start as u64,
                        });
                    }
                }
                consumed = i + 1;
                line_start = i + 1;
            }
        }
        (turns, consumed)
    }

    /// Normalize one Gemini turn.
    ///
    /// # Inputs Same shape.
    /// # Returns `Some(NormalizedTurn)` for user/model text. `None` for
    /// `thoughts`, function-call/response, system blocks. `role` derived
    /// from the turn's `role` field (`"user"` → User, `"model"` →
    /// Assistant).
    /// # Errors Never panics.
    /// # Side effects None.
    /// # Invariants `source_tool == "gemini"`; `ts_iso8601` from the
    /// turn's `startTime`/`timestamp` when present (`ts_source = Tool`),
    /// else CT-side fallback.
    /// # Concurrency Pure. # Lifecycle Per-turn.
    /// # Test contract First-line header turn returns `None`. Turn with
    /// only `thoughts` parts returns `None`. Turn with mixed `thoughts` +
    /// `text` returns `Some` with `text_visible` containing ONLY the
    /// `text` parts (thoughts dropped).
    fn normalize(&self, raw: RawTurn, ctx: NormalizeContext<'_>) -> Option<NormalizedTurn> {
        let _ = (raw, ctx);
        todo!()
    }
}
