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
    TranscriptAdapter, TranscriptHandle, TsSource, TurnRole, NORMALIZED_SCHEMA_VERSION,
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
        _spawned_at_unix_ms: i64,
    ) -> Result<TranscriptHandle, DiscoveryError> {
        // Cycle E: lsof-based discovery never sees Codex's rollout JSONL
        // (open-append-close per turn — same behavior as Claude Code 2.1.x).
        // Scan today + yesterday's date dirs by mtime, with the threshold
        // resolved server-side from `pid`'s process-start time (cycle F).
        // Codex is cwd-agnostic — the layout partitions by date, not by
        // cwd — so `pid` is used ONLY for the start-time threshold, never
        // for routing. The cwd-agnostic / date-partitioned layout is what
        // previously caused parallel Codex agents to collide on the
        // "newest matching" mtime under cycle E's click-time threshold;
        // cycle F's process-start threshold disambiguates them.

        let home = dirs::home_dir().ok_or_else(|| {
            DiscoveryError::Io(std::io::Error::new(
                std::io::ErrorKind::NotFound,
                "home dir not resolvable",
            ))
        })?;
        let root = home.join(".codex").join("sessions");

        // Today + yesterday covers the spawn-near-midnight edge case. The
        // spawn-to-first-write window is sub-second, so we don't need
        // history beyond that.
        let now_secs = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);
        let today = date_path_for_unix_secs(now_secs);
        let yesterday = date_path_for_unix_secs(now_secs - 86_400);
        let scan_roots = vec![root.join(&today), root.join(&yesterday)];

        super::discover_by_mtime(
            self.tool_id(),
            agent_handle,
            &scan_roots,
            pid,
            |p| {
                // Codex layout: ~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-<...>.jsonl
                // The mtime helper scans only the date dirs above, so
                // root-prefix check is implicit. Predicate filters to
                // .jsonl with `rollout-` prefix.
                if p.extension().map_or(true, |e| e != "jsonl") {
                    return false;
                }
                p.file_name()
                    .and_then(|n| n.to_str())
                    .map_or(false, |n| n.starts_with("rollout-"))
            },
        )
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

    /// Normalize one Codex turn.
    ///
    /// # Inputs Same shape as trait.
    /// # Returns `Some(NormalizedTurn)` for `event_msg` lines whose
    /// `payload.type` is `user_message` (role=User) or `agent_message`
    /// (role=Assistant). `None` for every other top-level type
    /// (`response_item`, `session_meta`, `turn_context`) and every
    /// other `event_msg.payload.type` (`task_started`, `token_count`,
    /// `patch_apply_end`, etc.).
    /// # Errors Never panics. # Side effects None.
    /// # Invariants `source_tool == "codex"`; `ts_iso8601` is set from
    /// the line's top-level `timestamp` field when present (`ts_source =
    /// Tool`), else CT-side fallback. `event_msg` is the user-visible
    /// "message bubble" surface; `response_item` events carry the
    /// model's internal item stream (reasoning, function calls, paired
    /// duplicates of agent_message) and are skipped to avoid
    /// double-emission and tool-output leakage.
    /// # Concurrency Pure. # Lifecycle Per-turn.
    /// # Test contract Turn with `top.type == "event_msg"` +
    /// `payload.type == "user_message"` + `payload.message == "hello"`
    /// returns `Some(role=User, text_visible="hello")`. Turn with
    /// `top.type == "response_item"` returns `None`. Empty `message`
    /// returns `None`.
    fn normalize(&self, raw: RawTurn, ctx: NormalizeContext<'_>) -> Option<NormalizedTurn> {
        let v = &raw.raw_payload;

        // Codex rollout lines are `{ timestamp, type, payload }`. The
        // top-level `type` discriminates the event family. We accept
        // only `event_msg` (the user-visible message stream) and skip
        // every other top-level type:
        //   - response_item: internal item stream (reasoning, function
        //     calls, paired duplicates of agent_message). Skipping
        //     avoids double-emission of assistant text.
        //   - session_meta / turn_context: bookkeeping, no
        //     user-visible content.
        if v.get("type").and_then(|t| t.as_str()) != Some("event_msg") {
            return None;
        }

        let payload = v.get("payload")?;
        let payload_type = payload.get("type").and_then(|t| t.as_str())?;

        let (role, text_visible) = match payload_type {
            "user_message" => {
                let text = payload.get("message").and_then(|x| x.as_str())?;
                (TurnRole::User, text.to_string())
            }
            "agent_message" => {
                let text = payload.get("message").and_then(|x| x.as_str())?;
                (TurnRole::Assistant, text.to_string())
            }
            // task_started, token_count, patch_apply_end, and every
            // other event_msg subtype — internal/tool events, not
            // user-visible message content. Excluded.
            _ => return None,
        };

        if text_visible.is_empty() {
            return None;
        }

        // Codex line format puts the timestamp at the TOP level (not inside
        // payload). Per docstring: `ts_iso8601` from `v.timestamp` (ts_source
        // = Tool), else CT-side fallback.
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
            // Chunk-relative per the trait's touch-up D contract.
            source_offset: raw.source_offset,
        })
    }
}

#[cfg(test)]
mod tests {
    //! Fixture-based unit tests for the Codex adapter's `normalize` body.
    //!
    //! Line samples captured 2026-05-20 from a real rollout file at
    //! `~/.codex/sessions/2026/05/19/rollout-2026-05-19T17-52-54-*.jsonl`.
    //! Sanitized: agent handles / cwd paths trimmed; payload shapes kept
    //! verbatim. If a future Codex version drifts the line shape, these
    //! tests fail loudly — that's the intent.

    use super::*;
    use serde_json::json;

    fn ctx() -> NormalizeContext<'static> {
        NormalizeContext {
            agent_handle: "codex1",
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
    fn user_message_event_normalizes_to_user_role() {
        let line = json!({
            "timestamp": "2026-05-19T08:53:48.606Z",
            "type": "event_msg",
            "payload": {
                "type": "user_message",
                "message": "hello"
            }
        });
        let out = CodexAdapter.normalize(parse_line(line), ctx()).expect("Some");
        assert!(matches!(out.role, TurnRole::User));
        assert_eq!(out.text_visible, "hello");
        assert_eq!(out.source_tool, "codex");
        assert_eq!(out.ts_iso8601, "2026-05-19T08:53:48.606Z");
        assert!(matches!(out.ts_source, TsSource::Tool));
    }

    #[test]
    fn agent_message_event_normalizes_to_assistant_role() {
        let line = json!({
            "timestamp": "2026-05-19T08:53:56.204Z",
            "type": "event_msg",
            "payload": {
                "type": "agent_message",
                "message": "Hello from @codex1.",
                "phase": "commentary",
                "memory_citation": null
            }
        });
        let out = CodexAdapter.normalize(parse_line(line), ctx()).expect("Some");
        assert!(matches!(out.role, TurnRole::Assistant));
        assert_eq!(out.text_visible, "Hello from @codex1.");
    }

    #[test]
    fn session_meta_returns_none() {
        let line = json!({
            "timestamp": "2026-05-19T08:53:00.000Z",
            "type": "session_meta",
            "payload": { "cwd": "/Users/donghyeon" }
        });
        assert!(CodexAdapter.normalize(parse_line(line), ctx()).is_none());
    }

    #[test]
    fn turn_context_returns_none() {
        let line = json!({
            "timestamp": "2026-05-19T08:53:01.000Z",
            "type": "turn_context",
            "payload": {}
        });
        assert!(CodexAdapter.normalize(parse_line(line), ctx()).is_none());
    }

    #[test]
    fn response_item_returns_none() {
        // response_item.message is the internal item stream; skipped
        // to avoid double-emission with event_msg.agent_message.
        let line = json!({
            "timestamp": "2026-05-19T08:53:56.300Z",
            "type": "response_item",
            "payload": {
                "type": "message",
                "message": {
                    "role": "assistant",
                    "content": [{"type": "output_text", "text": "duplicate"}]
                }
            }
        });
        assert!(CodexAdapter.normalize(parse_line(line), ctx()).is_none());
    }

    #[test]
    fn task_started_event_returns_none() {
        let line = json!({
            "timestamp": "2026-05-19T08:53:00.500Z",
            "type": "event_msg",
            "payload": { "type": "task_started" }
        });
        assert!(CodexAdapter.normalize(parse_line(line), ctx()).is_none());
    }

    #[test]
    fn token_count_event_returns_none() {
        let line = json!({
            "timestamp": "2026-05-19T08:53:57.000Z",
            "type": "event_msg",
            "payload": { "type": "token_count", "input": 100, "output": 50 }
        });
        assert!(CodexAdapter.normalize(parse_line(line), ctx()).is_none());
    }

    #[test]
    fn empty_user_message_returns_none() {
        let line = json!({
            "timestamp": "2026-05-19T08:53:48.000Z",
            "type": "event_msg",
            "payload": { "type": "user_message", "message": "" }
        });
        assert!(CodexAdapter.normalize(parse_line(line), ctx()).is_none());
    }

    #[test]
    fn missing_timestamp_falls_back_to_ct_source() {
        let line = json!({
            "type": "event_msg",
            "payload": { "type": "user_message", "message": "hi" }
        });
        let out = CodexAdapter.normalize(parse_line(line), ctx()).expect("Some");
        assert!(matches!(out.ts_source, TsSource::Ct));
    }
}

/// Format a UNIX-seconds value as Codex's date-dir path: `YYYY/MM/DD`.
///
/// Used by `discover_session` to enumerate the two date dirs Codex would
/// have written rollouts into. Uses the same Howard Hinnant `civil_from_days`
/// algorithm as `synth_iso8601_now` in `adapters/mod.rs`; inlined here
/// rather than shared because (a) different return shape and (b) sharing
/// would require lifting the civil-date math into a third helper, which is
/// out of scope for cycle E per the plan.
fn date_path_for_unix_secs(unix_secs: i64) -> String {
    let days = unix_secs.div_euclid(86_400);
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = if month <= 2 { y + 1 } else { y };

    format!("{:04}/{:02}/{:02}", year, month, d)
}
