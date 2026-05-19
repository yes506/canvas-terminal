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
        spawned_at_unix_ms: i64,
    ) -> Result<TranscriptHandle, DiscoveryError> {
        // Cycle E: switch to mtime-based discovery (consistent with the
        // Claude / Codex rewrites). Gemini's project-slug encoding from cwd
        // is not yet known — the implementer uses a glob over all
        // ~/.gemini/tmp/<*>/chats/ as a fallback that still narrows
        // correctly via mtime + spawned_at_unix_ms + predicate. If the slug
        // encoding can be derived in a future cycle, this enumeration can
        // be tightened.
        //
        // `pid` is consumed only to read cwd if a future tightening uses
        // it; today it's a no-op for the glob path.
        let _ = pid;

        let home = dirs::home_dir().ok_or_else(|| {
            DiscoveryError::Io(std::io::Error::new(
                std::io::ErrorKind::NotFound,
                "home dir not resolvable",
            ))
        })?;
        let tmp_root = home.join(".gemini").join("tmp");

        // Enumerate every <project-slug>/chats subdir under ~/.gemini/tmp/.
        // Cost is one read_dir on tmp_root + one read_dir per project (and
        // discover_by_mtime adds one read_dir per scan_root per attempt).
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
            spawned_at_unix_ms,
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
        let v = &raw.raw_payload;

        // First-line session header: `{ sessionId, projectHash, startTime,
        // lastUpdated, kind }` — no `role`/`parts`. Per docstring test
        // contract: first-line header turn returns None. The simplest
        // discriminator is "missing `role` field" — header lines have none.
        let role_str = v.get("role").and_then(|r| r.as_str())?;
        let role = match role_str {
            "user" => TurnRole::User,
            "model" => TurnRole::Assistant,
            // Future Gemini versions may add new roles (e.g. "function" for
            // tool invocations). Per D2 (best-effort field tolerance), unknown
            // roles return None rather than panic — the watcher's
            // turn_index still increments, so consumers detect gaps via
            // non-contiguous indices.
            _ => return None,
        };

        // Per-turn shape: `parts: [{ text: "..." }, { thoughts: "..." }, ...]`.
        // Each part has a single typed key. Filter to `text` only; drop
        // `thoughts` (Gemini's reasoning-trace equivalent of Claude's
        // `thinking`) and function_call / function_response / tool blocks.
        let parts = v.get("parts").and_then(|p| p.as_array())?;
        let mut text_visible = String::new();
        for part in parts {
            // A part with `.text` is the visible-text variant. Inspect for
            // the key, ignore other variants per the inclusion table.
            if let Some(text) = part.get("text").and_then(|x| x.as_str()) {
                text_visible.push_str(text);
            }
            // Future-tolerant: any other top-level key on a part (thought,
            // functionCall, functionResponse, ...) is silently skipped per
            // D2's "schema-version drift: unknown fields dropped".
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

/// Enumerate every `<tmp_root>/<project-slug>/chats/` directory that exists
/// on disk.
///
/// Used by `discover_session` as the fallback set of scan roots when the
/// project-slug encoding from cwd is not directly derivable. The
/// `discover_by_mtime` retry + mtime + spawned_at_unix_ms filter narrows
/// candidates down to the right session even with the wider scan set.
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
