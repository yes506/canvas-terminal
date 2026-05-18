// Claude Code adapter.
//
// Source root:   ~/.claude/projects/<project-slug>/*.jsonl
// Line schema:   one JSON object per line. Top-level `type` discriminates
//                ("user", "assistant", "summary", etc.). Assistant turns
//                contain `message.content` as an array of content blocks
//                with `type` ∈ {text, thinking, tool_use, tool_result,
//                image, redacted_thinking}.
//
// Inclusion table per R4: include `text` only. Exclude `thinking`,
// `tool_use`, `tool_result`, `image`, `redacted_thinking`, and any
// system/synthetic turn.

use super::super::{
    ContentBlockTable, DiscoveryError, NormalizeContext, NormalizedTurn, RawTurn,
    TranscriptAdapter, TranscriptHandle, TsSource, TurnRole, NORMALIZED_SCHEMA_VERSION,
};

/// Bumped when normalization rules or the inclusion table change. Independent
/// of host Claude Code version (T3).
pub const ADAPTER_VERSION: &str = "0.1.0";

/// Inclusion table per R4. `include` is restrictive (text only); `exclude`
/// is policy and MUST list every block type that could leak model-internal
/// state.
const INCLUSION_TABLE: ContentBlockTable = ContentBlockTable {
    include: &["text"],
    exclude: &[
        "thinking",
        "tool_use",
        "tool_result",
        "image",
        "redacted_thinking",
        "system",
    ],
};

pub struct ClaudeCodeAdapter;

impl TranscriptAdapter for ClaudeCodeAdapter {
    /// Stable adapter id; never changes between versions.
    ///
    /// # Returns `"claude_code"`.
    /// # Errors None. # Side effects None. # Invariants Constant string.
    /// # Concurrency Pure. # Lifecycle Static.
    /// # Test contract Equals the `adapter_id` entry in
    /// `fs_gate::ALLOWED_ROOTS` for the Claude root.
    fn tool_id(&self) -> &'static str {
        "claude_code"
    }

    /// Adapter version constant.
    ///
    /// # Returns `ADAPTER_VERSION`.
    /// # Errors None. # Side effects None.
    /// # Invariants Semver string.
    /// # Concurrency Pure. # Lifecycle Static.
    /// # Test contract Parses as semver.
    fn adapter_version(&self) -> &'static str {
        ADAPTER_VERSION
    }

    /// PID→fd discovery for Claude Code.
    ///
    /// # Inputs `agent_handle`: bare collab handle. `pid`: child PID (post-K6,
    /// this is the actual CLI even for shell-fallback launches).
    /// `spawned_at_unix_ms`: tiebreaker (rarely needed because lsof gives
    /// authoritative open-fd info).
    /// # Returns `TranscriptHandle` with `source_path` resolved to one of
    /// `~/.claude/projects/<project-slug>/*.jsonl`, `source_inode` from
    /// `lstat`, `adapter_id == "claude_code"`.
    /// # Errors `NoMatchingFd` if `lsof -p <pid>` shows no JSONL under the
    /// Claude root; `Gated` if the candidate fails `fs_gate::check_transcript_root`;
    /// `Io` for `lsof` subprocess failures.
    /// # Side effects One subprocess (`lsof -p`) on macOS, one walk of
    /// `/proc/<pid>/fd` on Linux. ONE-TIME at session-bind (M8 cache rule).
    /// # Invariants Returned `source_path` is canonicalized + symlink-free
    /// (`fs_gate` enforces).
    /// # Concurrency Thread-safe but expensive; never called inside the
    /// tailer loop.
    /// # Lifecycle Called by `TranscriptWatcher::watch` exactly once per
    /// opt-in publish.
    /// # Test contract Given a PID with no JSONL fd, returns `NoMatchingFd`.
    /// Returned `source_inode` matches `lstat(source_path).inode` at call
    /// time.
    fn discover_session(
        &self,
        agent_handle: &str,
        pid: i32,
        spawned_at_unix_ms: i64,
    ) -> Result<TranscriptHandle, DiscoveryError> {
        let _ = (agent_handle, pid, spawned_at_unix_ms);
        todo!()
    }

    /// Per-adapter content-block inclusion table.
    ///
    /// # Returns `&INCLUSION_TABLE` — include = `["text"]`,
    /// exclude = `["thinking", "tool_use", "tool_result", "image",
    /// "redacted_thinking", "system"]`.
    /// # Errors None. # Side effects None.
    /// # Invariants Reference outlives adapter; values are `'static`.
    /// # Concurrency Pure.
    /// # Lifecycle Consulted by `normalize` per turn.
    /// # Test contract `include.contains(&"text")`. `exclude.contains(&"thinking")`.
    fn inclusion_table(&self) -> &ContentBlockTable {
        &INCLUSION_TABLE
    }

    /// Parse newly-appended bytes into a list of `RawTurn`s.
    ///
    /// # Inputs `bytes`: latest read chunk; may end mid-line.
    /// # Returns `(turns, consumed)` per the trait contract. Each `RawTurn`
    /// carries the full JSON object plus its `source_offset` within the
    /// JSONL.
    /// # Errors Per-line parse failures are dropped silently (their bytes
    /// are still consumed; logging only).
    /// # Side effects None.
    /// # Invariants `consumed ≤ bytes.len()`. Trailing partial line is NOT
    /// consumed.
    /// # Concurrency Pure.
    /// # Lifecycle Called by the Tailer after each non-empty poll.
    /// # Test contract `bytes ending in '\\n'` consumes everything; ending
    /// mid-line consumes up to the last `'\\n'`. A line of garbage between
    /// two valid lines emits two turns and consumes all three lines.
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

    /// Normalize one Claude Code turn.
    ///
    /// # Inputs `raw`: parsed JSONL object. `ctx`: CT-injected
    /// (agent_handle, adapter_version, turn_index).
    /// # Returns `Some(NormalizedTurn)` when the turn contains at least one
    /// `text` block. `None` when the turn was assistant-output but the
    /// content was exclusively excluded types (e.g. `tool_use` only) —
    /// `turn_index` still increments per the trait contract so consumers
    /// detect gaps via non-contiguous indices.
    /// # Errors Never panics; on missing fields, falls back to `ts_source =
    /// Ct` and synthesizes a timestamp.
    /// # Side effects None.
    /// # Invariants `normalized_schema_version == NORMALIZED_SCHEMA_VERSION`;
    /// `source_tool == "claude_code"`; `adapter_version == ADAPTER_VERSION`;
    /// `agent_handle == ctx.agent_handle`.
    /// # Concurrency Pure.
    /// # Lifecycle Called per `RawTurn`.
    /// # Test contract Turn with `content: [{type: "text", text: "hi"}]`
    /// returns `Some` with `text_visible == "hi"`. Turn with
    /// `content: [{type: "thinking", thinking: "..."}]` returns `None`.
    /// `role` is set from the top-level `type` field (`"user"` → User,
    /// `"assistant"` → Assistant).
    fn normalize(&self, raw: RawTurn, ctx: NormalizeContext<'_>) -> Option<NormalizedTurn> {
        let v = &raw.raw_payload;

        // Top-level `type` discriminates the turn role. Anything that isn't
        // "user"/"assistant" (e.g. "summary") is filtered — those carry no
        // mirror-able conversational content.
        let role = match v.get("type").and_then(|t| t.as_str())? {
            "user" => TurnRole::User,
            "assistant" => TurnRole::Assistant,
            _ => return None,
        };

        // Extract text content. User turns often arrive as `message.content:
        // "<plain text>"`; assistant turns use the block-array form. Both
        // shapes coexist in the same JSONL stream so we handle both.
        let content = v.get("message").and_then(|m| m.get("content"))?;
        let text_visible = if let Some(s) = content.as_str() {
            s.to_string()
        } else if let Some(arr) = content.as_array() {
            let mut out = String::new();
            for block in arr {
                let btype = match block.get("type").and_then(|t| t.as_str()) {
                    Some(t) => t,
                    None => continue,
                };
                // Apply the inclusion table — only `text` blocks propagate
                // per R4. Excluded types (`thinking`, `tool_use`, etc.) are
                // skipped silently; M6 says empty-after-filter turns return
                // None (the trait contract).
                if INCLUSION_TABLE.include.iter().any(|t| *t == btype) {
                    if let Some(text) = block.get(btype).and_then(|x| x.as_str()) {
                        out.push_str(text);
                    }
                }
            }
            out
        } else {
            return None;
        };

        if text_visible.is_empty() {
            return None;
        }

        let (ts_iso8601, ts_source) = match v.get("timestamp").and_then(|t| t.as_str()) {
            Some(t) => (t.to_string(), TsSource::Tool),
            None => (super::synth_iso8601_now(), TsSource::Ct),
        };

        Some(NormalizedTurn {
            normalized_schema_version: NORMALIZED_SCHEMA_VERSION,
            source_tool: self.tool_id().to_string(),
            source_tool_version: None,
            adapter_version: ADAPTER_VERSION.to_string(),
            agent_handle: ctx.agent_handle.to_string(),
            ts_iso8601,
            ts_source,
            role,
            text_visible,
            turn_index: ctx.turn_index,
            // Chunk-relative per the trait's touch-up D contract; the
            // caller (TranscriptWatcher / Tailer) adds the current
            // TailState.byte_offset to obtain the absolute file offset.
            source_offset: raw.source_offset,
        })
    }
}
