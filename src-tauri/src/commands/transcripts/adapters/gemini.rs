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
    TranscriptAdapter, TranscriptHandle, TsSource, TurnRole, NORMALIZED_SCHEMA_VERSION,
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
        _spawned_at_unix_ms: i64,
    ) -> Result<TranscriptHandle, DiscoveryError> {
        // Cycle E: switch to mtime-based discovery (consistent with the
        // Claude / Codex rewrites). Gemini's project-slug encoding from cwd
        // is not yet known — the implementer uses a glob over all
        // ~/.gemini/tmp/<*>/chats/ as a fallback that still narrows
        // correctly via mtime + process-start-time threshold + predicate.
        // If the slug encoding can be derived in a future cycle, this
        // enumeration can be tightened.
        //
        // Cycle F: `pid` is used by `discover_by_mtime` for the
        // server-side process-start-time threshold (one read of
        // `/proc/<pid>/stat` on Linux, one `ps` call on macOS).
        // `_spawned_at_unix_ms` is now ignored (trait param retained for
        // backward compat per plan Out-of-scope).

        let home = dirs::home_dir().ok_or_else(|| {
            DiscoveryError::Io(std::io::Error::new(
                std::io::ErrorKind::NotFound,
                "home dir not resolvable",
            ))
        })?;
        let tmp_root = home.join(".gemini").join("tmp");

        // Enumerate every <project-slug>/chats subdir under ~/.gemini/tmp/.
        // Cost is one read_dir on tmp_root + one read_dir per project (and
        // discover_by_mtime adds one read_dir per scan_root).
        // In practice, <10 project slugs per dev machine; well-bounded.
        let scan_roots = derive_gemini_scan_roots(&tmp_root);
        if scan_roots.is_empty() {
            // ~/.gemini/tmp does not exist or has no project subdirs —
            // matches the docstring test-contract "MUST produce NoMatchingFd
            // (not a panic / filesystem error)".
            return Err(DiscoveryError::NoMatchingFd);
        }

        super::discover_by_mtime(
            self.tool_id(),
            agent_handle,
            &scan_roots,
            pid,
            |p| {
                // Predicate: extension is .jsonl and basename starts with
                // "session-". The scan_roots already constrain us to
                // <slug>/chats/, so the components-check that the legacy
                // code did is implicit.
                if p.extension().map_or(true, |e| e != "jsonl") {
                    return false;
                }
                p.file_name()
                    .and_then(|n| n.to_str())
                    .map_or(false, |n| n.starts_with("session-"))
            },
        )
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
    /// # Returns `Some(NormalizedTurn)` for user/gemini text. `None` for
    /// session-header lines (no `type`), `$set` state-update lines
    /// (also no `type`), or unknown role values. Role derived from the
    /// turn's top-level `type` field (`"user"` → User, `"gemini"` →
    /// Assistant).
    /// # Errors Never panics.
    /// # Side effects None.
    /// # Invariants `source_tool == "gemini"`; `ts_iso8601` from the
    /// turn's `timestamp`/`startTime` when present (`ts_source = Tool`),
    /// else CT-side fallback. The `thoughts` array is Gemini's
    /// reasoning-trace (analogue of Claude's `thinking`) and is
    /// EXCLUDED per the inclusion-table contract.
    /// # Concurrency Pure. # Lifecycle Per-turn.
    /// # Test contract First-line session header returns `None` (no
    /// `type` field). `$set` state-update returns `None`. User turn with
    /// `content: [{text: "..."}]` returns `Some(role=User)` with the
    /// joined text. Gemini turn with `content: "..."` (plain string)
    /// returns `Some(role=Assistant)` with that string. Gemini turn
    /// with empty `content` (only `thoughts`) returns `None`.
    fn normalize(&self, raw: RawTurn, ctx: NormalizeContext<'_>) -> Option<NormalizedTurn> {
        let v = &raw.raw_payload;

        // Gemini per-turn lines carry `type: "user" | "gemini"`. The
        // session header line (`{sessionId, projectHash, startTime,
        // lastUpdated, kind}`) and `$set` state-update lines have no
        // `type` field, so the early `?` returns None for both.
        let type_str = v.get("type").and_then(|r| r.as_str())?;
        let role = match type_str {
            "user" => TurnRole::User,
            "gemini" => TurnRole::Assistant,
            // Future Gemini versions may add new types (e.g. "function"
            // for tool invocations). Per D2 (best-effort field
            // tolerance), unknown types return None rather than panic.
            _ => return None,
        };

        // Content shape is role-dependent:
        //   - user turns:   `content: [{text: "..."}, ...]` (array of
        //                   typed blocks; only `text` blocks emit).
        //   - gemini turns: `content: "..."` (plain string, the assistant's
        //                   user-visible response).
        // The "thoughts" field (Gemini's reasoning-trace) lives at the
        // top level alongside `content` and is EXCLUDED per the
        // inclusion-table contract — we never read it.
        let mut text_visible = String::new();
        if let Some(arr) = v.get("content").and_then(|c| c.as_array()) {
            for block in arr {
                if let Some(text) = block.get("text").and_then(|x| x.as_str()) {
                    text_visible.push_str(text);
                }
                // Other block shapes (functionCall, functionResponse,
                // tool, ...) are silently skipped per D2's
                // "schema-version drift: unknown fields dropped".
            }
        } else if let Some(s) = v.get("content").and_then(|c| c.as_str()) {
            text_visible.push_str(s);
        }

        if text_visible.is_empty() {
            return None;
        }

        // Gemini schema: timestamp may live at `timestamp` (per-turn) OR
        // `startTime` (some schema versions emit only on session header but
        // others repeat per turn). Check both, in that order.
        let (ts_iso8601, ts_source) = match v
            .get("timestamp")
            .and_then(|t| t.as_str())
            .or_else(|| v.get("startTime").and_then(|t| t.as_str()))
        {
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
            // Chunk-relative per the trait's touch-up D contract.
            source_offset: raw.source_offset,
        })
    }
}

#[cfg(test)]
mod tests {
    //! Fixture-based unit tests for the Gemini adapter's `normalize` body.
    //!
    //! Line samples captured 2026-05-20 from a real session file at
    //! `~/.gemini/tmp/donghyeon/chats/session-2026-05-19T08-52-194738d9.jsonl`.
    //! Sanitized: full identifiers / project paths trimmed; payload
    //! shapes kept verbatim.

    use super::*;
    use serde_json::json;

    fn ctx() -> NormalizeContext<'static> {
        NormalizeContext {
            agent_handle: "gemini1",
            adapter_version: ADAPTER_VERSION,
            turn_index: 0,
        }
    }

    fn parse_line(line: serde_json::Value) -> RawTurn {
        RawTurn {
            raw_payload: line,
            source_offset: 0,
        }
    }

    #[test]
    fn user_turn_with_content_array_normalizes_to_user_role() {
        let line = json!({
            "id": "d11f41d4-a1c7-4fb6-b212-88992b3a6b2f",
            "timestamp": "2026-05-19T08:54:36.991Z",
            "type": "user",
            "content": [{"text": "hello"}],
            "displayContent": "hello"
        });
        let out = GeminiAdapter.normalize(parse_line(line), ctx()).expect("Some");
        assert!(matches!(out.role, TurnRole::User));
        assert_eq!(out.text_visible, "hello");
        assert_eq!(out.source_tool, "gemini");
        assert_eq!(out.ts_iso8601, "2026-05-19T08:54:36.991Z");
        assert!(matches!(out.ts_source, TsSource::Tool));
    }

    #[test]
    fn user_turn_with_multi_block_content_joins_text_only() {
        let line = json!({
            "id": "x",
            "timestamp": "2026-05-19T08:54:37.000Z",
            "type": "user",
            "content": [
                {"text": "alpha"},
                {"functionCall": {"name": "foo"}},  // should be skipped
                {"text": "beta"}
            ]
        });
        let out = GeminiAdapter.normalize(parse_line(line), ctx()).expect("Some");
        assert_eq!(out.text_visible, "alphabeta");
    }

    #[test]
    fn gemini_turn_with_content_string_normalizes_to_assistant_role() {
        let line = json!({
            "id": "f477d8b3-9440-4bad-ad6b-29ca177ab3aa",
            "timestamp": "2026-05-19T08:54:41.863Z",
            "type": "gemini",
            "content": "Reviewing the agent tasks now.",
            "thoughts": [{
                "subject": "Reviewing Agent Tasks",
                "description": "I'm currently reviewing.",
                "timestamp": "2026-05-19T08:54:41.546Z"
            }],
            "tokens": {"input": 100, "output": 20, "total": 120}
        });
        let out = GeminiAdapter.normalize(parse_line(line), ctx()).expect("Some");
        assert!(matches!(out.role, TurnRole::Assistant));
        assert_eq!(out.text_visible, "Reviewing the agent tasks now.");
    }

    #[test]
    fn gemini_turn_with_empty_content_returns_none() {
        // Gemini emits `content: ""` when the assistant's full output is
        // captured in `thoughts` (reasoning-only turn). Per inclusion
        // table, thoughts are excluded — empty visible text is skipped.
        let line = json!({
            "id": "y",
            "timestamp": "2026-05-19T08:54:42.000Z",
            "type": "gemini",
            "content": "",
            "thoughts": [{"subject": "Thinking only", "description": "..."}]
        });
        assert!(GeminiAdapter.normalize(parse_line(line), ctx()).is_none());
    }

    #[test]
    fn session_header_returns_none() {
        // First line of every session file: no `type` field, so the
        // early `?` returns None at v.get("type").
        let line = json!({
            "sessionId": "194738d9-...",
            "projectHash": "donghyeon",
            "startTime": "2026-05-19T08:52:00.000Z",
            "lastUpdated": "2026-05-19T09:00:00.000Z",
            "kind": "chat"
        });
        assert!(GeminiAdapter.normalize(parse_line(line), ctx()).is_none());
    }

    #[test]
    fn set_state_update_returns_none() {
        // `$set` lines mutate session-level state but carry no `type`
        // field, so the early `?` returns None.
        let line = json!({
            "$set": {"lastUpdated": "2026-05-19T09:00:00.000Z"}
        });
        assert!(GeminiAdapter.normalize(parse_line(line), ctx()).is_none());
    }

    #[test]
    fn unknown_type_returns_none() {
        let line = json!({
            "type": "function",
            "content": "should not surface"
        });
        assert!(GeminiAdapter.normalize(parse_line(line), ctx()).is_none());
    }

    #[test]
    fn missing_timestamp_falls_back_to_ct_source() {
        let line = json!({
            "type": "user",
            "content": [{"text": "no timestamp here"}]
        });
        let out = GeminiAdapter.normalize(parse_line(line), ctx()).expect("Some");
        assert!(matches!(out.ts_source, TsSource::Ct));
    }
}

/// Enumerate every `<tmp_root>/<project-slug>/chats/` directory that exists
/// on disk.
///
/// Used by `discover_session` as the fallback set of scan roots when the
/// project-slug encoding from cwd is not directly derivable. The
/// `discover_by_mtime` single-shot scan + mtime + process-start-time
/// threshold (from `pid`) narrows candidates down to the right session
/// even with the wider scan set.
///
/// Returns an empty `Vec` when `<tmp_root>` does not exist or contains no
/// project subdirs — caller surfaces this as `NoMatchingFd` per the
/// adapter's docstring contract.
fn derive_gemini_scan_roots(tmp_root: &std::path::Path) -> Vec<std::path::PathBuf> {
    let entries = match std::fs::read_dir(tmp_root) {
        Ok(e) => e,
        Err(_) => return Vec::new(),
    };
    let mut roots = Vec::new();
    for entry in entries.flatten() {
        let project_dir = entry.path();
        let chats_dir = project_dir.join("chats");
        if chats_dir.is_dir() {
            roots.push(chats_dir);
        }
    }
    roots
}
