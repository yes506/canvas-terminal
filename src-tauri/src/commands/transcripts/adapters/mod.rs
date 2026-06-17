// Per-tool transcript adapters.
//
// Production adapter set per K3 (cumulative reviewer fold): three concrete
// adapters here. The trait-extensibility contract is verified by a
// TEST-ONLY fixture at `src-tauri/tests/transcript_adapter_contract.rs`,
// which intentionally lives outside this module to keep production source
// free of the fixture's tool identifier (CI grep contract per Q2 — see
// `tests/transcript_adapter_contract.rs` for the exact identifier used).
// Per the X3 narrowing, transcript adapters here ship only for tools
// already registered in `ToolId` / `TOOL_CONFIGS`.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use super::{DiscoveryError, TranscriptAdapter, TranscriptHandle};

/// ASCII needle that anchors a CT-injected identity preamble turn. The
/// collaborator harness prepends a context header to the agent's launch
/// message (`[You are @claude1]` / `[You are @claude1 (Claude Code #1)]` /
/// `[Your identity: You are @claude1. ...]`), so any JSONL turn containing
/// this substring is an identity preamble. ASCII-only ⇒ UTF-8-safe to search
/// over raw bytes (it can never split a multi-byte codepoint).
const IDENTITY_PREAMBLE_NEEDLE: &[u8] = b"You are @";

/// Early-out byte cap for the N7 backward-from-EOF preamble walk.
///
/// `discover_session` is out of the tailer hot loop, but the discovery-retry
/// loop re-invokes it every 5 s until a *successful* bind. For a
/// correctly-launched agent the latest preamble sits near EOF and the walk
/// stops after the first chunk (cheap). The cap bounds the PATHOLOGICAL case:
/// a candidate that carries NO CT preamble at all (e.g. a stray non-collab
/// rollout in codex's date dir) would otherwise read all the way to BOF on
/// every poll. With the cap, "no preamble found within the last
/// `MARKER_BACKWARD_SCAN_CAP_BYTES`" is treated as a non-match for that poll.
///
/// **Residual gap**: if a candidate's only matching preamble lies *farther*
/// than this cap from EOF (e.g. a resumed rollout with > cap of trailing
/// output appended after the current-launch preamble), the walk will not see
/// it and returns "no match". With fallback disabled for CT collab watches
/// (plan N1/N3) this converts a would-be wrong/no bind into a safe spin —
/// never a wrong bind. Empirically (plan-review round, 12 rollouts > 400 KiB)
/// latest markers landed within ~600 KiB of EOF, so 8 MiB is generous
/// headroom; the cap exists to bound cost, not to be hit in normal operation.
const MARKER_BACKWARD_SCAN_CAP_BYTES: u64 = 8 * 1024 * 1024;

/// Read-chunk size for the backward walk. The walk reads the file in
/// EOF→BOF chunks so a correctly-launched agent (preamble near EOF) costs one
/// chunk; only the no-preamble case pays up to the cap.
const MARKER_BACKWARD_CHUNK_BYTES: usize = 64 * 1024;

/// Whether `path`'s **latest** (closest-to-EOF) CT identity preamble names the
/// expected `(expected_handle, expected_collab_session_id)` (plan N7).
///
/// # Governing principle — latest-preamble authority
///
/// A rollout is a single JSONL stream; on `--resume` the current launch's CT
/// preamble is the **most recent** `You are @<handle>` turn, with any number of
/// earlier (possibly stale / foreign) headers behind it. We therefore walk
/// **backward from EOF**, stop at the FIRST turn carrying ANY identity
/// preamble (that is the current launch's), **parse its `(handle, session)`**,
/// and compare to the expected pair. This **parse-latest-then-compare** order
/// is mandatory: we never scan backward for the expected handle alone, because
/// that could skip a newer *foreign* preamble and wrongly accept an older
/// *expected* one. Both the discovery filter (`discover_by_mtime`) and the
/// populate-time revalidation (`populate_entry`, N8) key on this one helper so
/// the authority semantics live in a single place.
///
/// # Session matching
///
/// The session token appears embedded in the preamble's path text
/// (`conversation-<sid>.md`, `contexts/<sid>/`). We build those needles from
/// the **sanitized** expected id (via `super::sanitize_collab_session_id`) so
/// raw vs sanitized ids match consistently (plan "session-token match
/// format"). The `.md` / `/` delimiters act as right word-boundaries, so
/// `session-3` does NOT match `conversation-session-32.md`. When
/// `expected_collab_session_id` is EMPTY (future non-CT/manual watch) the
/// session check is skipped — handle-only matching, preserving legacy
/// behavior.
///
/// # Errors / robustness
///
/// Any IO error, an empty file, an empty `expected_handle`, or "no preamble
/// found within the byte cap" all return `false` (treated as "no match": the
/// strict-mode caller spins/retries). The backward line reassembly handles a
/// missing trailing newline, a preamble turn larger than one read chunk, and a
/// needle split across a chunk boundary (it searches reassembled lines, never
/// raw chunks).
pub(super) fn transcript_has_identity_marker(
    path: &Path,
    expected_handle: &str,
    expected_collab_session_id: &str,
) -> bool {
    if expected_handle.is_empty() {
        return false;
    }

    // Candidacy gate (peer-review fix): for a CT collab watch (non-empty
    // expected session) a line counts as the latest preamble only if it is a
    // WELL-FORMED CT preamble — a parseable handle AND a generic session-path
    // token. For a non-CT/manual watch (empty expected session) we keep the
    // legacy handle-only candidacy. See `find_latest_identity_preamble_line`.
    let require_session_token = !expected_collab_session_id.is_empty();

    let line = match find_latest_identity_preamble_line(
        path,
        MARKER_BACKWARD_SCAN_CAP_BYTES,
        require_session_token,
    ) {
        Some(l) => l,
        None => return false,
    };

    // Parse-then-compare the handle (never search for the expected handle). The
    // candidacy gate guarantees a parseable handle, but re-parse defensively.
    match parse_identity_preamble_handle(&line) {
        Some(parsed) if parsed.as_slice() == expected_handle.as_bytes() => {}
        _ => return false,
    }

    // Session match only when an expected session is supplied. A well-formed
    // FOREIGN preamble (different session) therefore returns false here —
    // latest-authority correctly rejects rather than walking to an older
    // matching preamble.
    if expected_collab_session_id.is_empty() {
        return true;
    }
    line_references_collab_session(&line, expected_collab_session_id)
}

/// Locate the latest (closest-to-EOF) complete JSONL line in `path` that is a
/// WELL-FORMED CT identity preamble, reading at most `cap_bytes` backward from
/// EOF. Returns the line's bytes (newline excluded), or `None`.
///
/// **Well-formed gate (peer-review fix).** It is NOT enough that a line contains
/// the raw substring `You are @`: ordinary later transcript output (an assistant
/// turn discussing the harness, a code/diff attachment, a doc placeholder like
/// `You are @claudeN`, or a bare `You are @`) also contains it. If such a line
/// were treated as authoritative it would shadow the real current-launch
/// preamble — and because the unmarked fallback is permanently disabled for CT
/// collab watches (plan N1), discovery would safe-spin forever and the mirror
/// would never populate (this is the COMMON case in a session where every agent
/// reasons about the harness). So the walk accepts a line as the latest preamble
/// only if it has the harness's CT-preamble **structural shape**
/// (`line_is_wellformed_preamble`: a parseable handle AND, for CT watches, the
/// bracketed `[You are @…]`/`[Your identity:…]` + `[Conversation log:…]` labels)
/// — and **keeps walking backward** past lines that merely contain the substring.
/// Latest-authority is then applied over that filtered set: the first (latest)
/// well-formed preamble wins; the caller compares it to the EXPECTED
/// `(handle, session)` and rejects a foreign one rather than walking to an older
/// matching one. The candidacy/expected split is deliberate — it lets a stale
/// foreign preamble (well-formed, different sid) be recognized as the latest real
/// identity (→ reject) while ordinary content (no CT bracket shape) is skipped.
///
/// `require_session_token == false` (empty expected session — future non-CT/manual
/// watch) relaxes candidacy to handle-only, preserving legacy behavior.
///
/// Reads EOF→BOF in `MARKER_BACKWARD_CHUNK_BYTES` chunks, reassembling lines
/// across chunk boundaries so a turn larger than one chunk — or a needle split
/// across a boundary — is still found. Stops early at the first well-formed
/// preamble.
///
/// **Residual (documented; see `line_is_wellformed_preamble`):** a single
/// physical line that quotes a COMPLETE real preamble (both CT bracket labels
/// present — e.g. a `tool_result` from grepping a peer transcript) can still be
/// mis-classified. It does not fire in practice (per-task preamble re-injection
/// keeps the real preamble latest) and the fully-robust fix is role-aware parsing (the CT
/// preamble is a user/first-turn record), which the plan intentionally kept out
/// of this byte-oriented helper.
fn find_latest_identity_preamble_line(
    path: &Path,
    cap_bytes: u64,
    require_session_token: bool,
) -> Option<Vec<u8>> {
    use std::io::{Read, Seek, SeekFrom};

    let mut file = std::fs::File::open(path).ok()?;
    let file_len = file.seek(SeekFrom::End(0)).ok()?;
    if file_len == 0 {
        return None;
    }

    let mut pos = file_len; // start of the region currently held in `tail`
    let mut read_total: u64 = 0;
    // `tail` holds a contiguous file region ending at the start of the lines
    // we've already fully scanned. Each iteration prepends a freshly-read
    // chunk, then scans the newly-complete lines and drops them, keeping only
    // the still-incomplete leading fragment for the next iteration.
    let mut tail: Vec<u8> = Vec::new();

    loop {
        let remaining_cap = cap_bytes.saturating_sub(read_total);
        if remaining_cap == 0 {
            return None; // hit the byte cap without a match
        }
        let want = (MARKER_BACKWARD_CHUNK_BYTES as u64)
            .min(pos)
            .min(remaining_cap) as usize;
        if want == 0 {
            return None; // reached BOF
        }
        let new_pos = pos - want as u64;
        file.seek(SeekFrom::Start(new_pos)).ok()?;
        let mut chunk = vec![0u8; want];
        file.read_exact(&mut chunk).ok()?;
        read_total += want as u64;

        // Prepend the chunk: chunk = file[new_pos, pos), tail = file[pos, ...).
        chunk.extend_from_slice(&tail);
        tail = chunk;
        pos = new_pos;

        let at_bof = pos == 0;
        let cap_hit = read_total >= cap_bytes;
        // The leading segment (before the first '\n' in `tail`) is a complete
        // line only once we've reached BOF or the cap; otherwise it continues
        // into not-yet-read bytes.
        if let Some(found) =
            scan_tail_for_latest_preamble(&tail, at_bof || cap_hit, require_session_token)
        {
            return Some(found);
        }
        if at_bof || cap_hit {
            return None;
        }
        // Not found yet: discard the already-scanned complete lines, keep only
        // the still-incomplete leading fragment (everything before the first
        // '\n') so the next chunk reassembles the line that spans `pos`.
        match tail.iter().position(|&b| b == b'\n') {
            Some(first_nl) => tail.truncate(first_nl),
            None => { /* one line longer than the chunk — keep all of `tail` */ }
        }
    }
}

/// Scan `tail` for the rightmost (latest) COMPLETE line that is a well-formed
/// CT preamble. `front_complete` says whether the leading segment (before the
/// first `\n`) is a complete line — true only at BOF / cap. The trailing segment
/// (after the last `\n`) is always complete: on the first read it is the file's
/// final line; on later reads its terminating newline was truncated off a
/// previous iteration. Lines that merely contain the needle but are not
/// well-formed preambles are skipped, so the caller's backward walk continues
/// past them (peer-review fix — see `find_latest_identity_preamble_line`).
fn scan_tail_for_latest_preamble(
    tail: &[u8],
    front_complete: bool,
    require_session_token: bool,
) -> Option<Vec<u8>> {
    let nls: Vec<usize> = tail
        .iter()
        .enumerate()
        .filter_map(|(i, &b)| if b == b'\n' { Some(i) } else { None })
        .collect();

    // Build (start, end_exclusive, complete) ranges right-to-left.
    let mut ranges: Vec<(usize, usize, bool)> = Vec::new();
    if nls.is_empty() {
        ranges.push((0, tail.len(), front_complete));
    } else {
        ranges.push((nls[nls.len() - 1] + 1, tail.len(), true)); // trailing
        for k in (1..nls.len()).rev() {
            ranges.push((nls[k - 1] + 1, nls[k], true)); // middle segments
        }
        ranges.push((0, nls[0], front_complete)); // leading
    }

    for (start, end, complete) in ranges {
        if !complete || start >= end {
            continue;
        }
        let seg = &tail[start..end];
        if line_is_wellformed_preamble(seg, require_session_token) {
            return Some(seg.to_vec());
        }
    }
    None
}

/// Whether `line` is a well-formed CT identity preamble — i.e. it has the
/// **structural shape** the collaborator harness emits, not merely the
/// `You are @` substring. This is the candidacy gate that distinguishes a real
/// preamble turn from ordinary transcript content that happens to mention a
/// handle and a session path (round-2 peer-review fix; reproduced cross-wire).
///
/// For a CT collab watch (`require_session_token`) a line qualifies only if it
/// carries BOTH of the harness's bracketed labels co-located on the one
/// physical JSONL record:
/// - a CT **identity** bracket — `[You are @…]` (slim header, collaboratorStore
///   `buildSlimHeader`) or `[Your identity: You are @…]` (full message-1 header,
///   `prependContextHeader`); AND
/// - a CT **session** bracket — `[Conversation log: …/conversation-<sid>.md]`
///   (emitted by both header builders whenever a collab session is set).
///
/// A line like `… see contexts/session-18/claude2.jsonl which contains
/// You are @claude2 …` (ordinary prose / a peer-grep `tool_result`) carries
/// neither bracket label and is rejected, so it no longer shadows or cross-wires
/// the real preamble. A non-CT/manual watch (`require_session_token == false`)
/// keeps the looser handle-only candidacy.
///
/// **Residual (documented, follow-up planner item):** a single JSONL record that
/// quotes a *complete* real preamble block — both bracket labels present, e.g. a
/// `tool_result` from grepping a peer's transcript — still passes this byte-level
/// shape gate. Empirically it does not fire (the harness re-injects the preamble
/// on every task prompt, so the agent's own real preamble is the latest
/// well-formed line; initial discovery runs at spawn/resume before any peer-grep
/// activity). Fully closing it requires role/schema-aware JSON parsing (confirm a
/// user record with no `tool_result` block and the preamble at text start) — a
/// cheap `role == "user"` check is insufficient because a `tool_result` is itself
/// a `role:user` record. The plan deliberately kept role-aware parsing out of
/// this byte-oriented helper; closing the residual is a justified small scope
/// adjustment to flag upward to the planner.
fn line_is_wellformed_preamble(line: &[u8], require_session_token: bool) -> bool {
    if parse_identity_preamble_handle(line).is_none() {
        return false;
    }
    if require_session_token
        && !(line_has_ct_identity_bracket(line) && line_has_ct_session_bracket(line))
    {
        return false;
    }
    true
}

/// Whether `line` carries the harness's bracketed CT identity label —
/// `[You are @…]` (slim header) or `[Your identity: …]` (full header). Anchoring
/// on the bracket (not the bare `You are @` substring) rejects ordinary prose
/// that merely mentions a handle.
fn line_has_ct_identity_bracket(line: &[u8]) -> bool {
    contains_subslice(line, b"[You are @") || contains_subslice(line, b"[Your identity:")
}

/// Whether `line` carries the harness's bracketed CT session label
/// `[Conversation log:` — emitted (co-located with the session id) by both the
/// slim and full header builders whenever a collab session is set. Anchoring on
/// the bracket label (not a bare `conversation-`/`contexts/` substring) rejects
/// ordinary text that merely quotes a peer mirror path.
fn line_has_ct_session_bracket(line: &[u8]) -> bool {
    contains_subslice(line, b"[Conversation log:")
}

/// Parse the handle out of the first `You are @<handle>` occurrence in `line`.
/// Returns the handle bytes (the maximal `[A-Za-z0-9_-]+` run after the
/// needle), or `None` if the needle is absent or immediately followed by a
/// non-handle character. The run terminates at the first non-handle byte
/// (e.g. `]`, space) so `@claude1]` parses to `claude1` (not `claude11`).
fn parse_identity_preamble_handle(line: &[u8]) -> Option<Vec<u8>> {
    let at = find_subslice(line, IDENTITY_PREAMBLE_NEEDLE)? + IDENTITY_PREAMBLE_NEEDLE.len();
    let mut end = at;
    while end < line.len() {
        let c = line[end];
        if c.is_ascii_alphanumeric() || c == b'_' || c == b'-' {
            end += 1;
        } else {
            break;
        }
    }
    if end == at {
        return None;
    }
    Some(line[at..end].to_vec())
}

/// Whether `line` references the expected collab session via one of the
/// preamble's embedded path tokens (`conversation-<sid>.md` /
/// `contexts/<sid>/`). The expected id is sanitized first so raw vs sanitized
/// ids match consistently (plan "session-token match format").
fn line_references_collab_session(line: &[u8], expected_collab_session_id: &str) -> bool {
    let sid = super::sanitize_collab_session_id(expected_collab_session_id);
    if sid.is_empty() {
        return false;
    }
    let conversation = format!("conversation-{}.md", sid);
    let contexts = format!("contexts/{}/", sid);
    contains_subslice(line, conversation.as_bytes())
        || contains_subslice(line, contexts.as_bytes())
}

/// Index of the first occurrence of `needle` in `haystack`, or `None`.
/// Empty needle never matches (no meaningful position for our callers).
fn find_subslice(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() || needle.len() > haystack.len() {
        return None;
    }
    haystack.windows(needle.len()).position(|w| w == needle)
}

/// Whether `haystack` contains `needle` as a contiguous subslice.
fn contains_subslice(haystack: &[u8], needle: &[u8]) -> bool {
    find_subslice(haystack, needle).is_some()
}

pub mod claude_code;
pub mod codex;
pub mod gemini;

// Static instances of the three production adapter unit-structs. Used by
// `TranscriptWatcher::watch` to resolve a `TranscriptHandle.adapter_id`
// (a `&'static str`) back to a `&'static dyn TranscriptAdapter` it can
// invoke `parse_native_lines` / `normalize` on. Unit structs are `Sync` +
// const-constructable, so static storage is safe.
pub(super) static CLAUDE_CODE_ADAPTER: claude_code::ClaudeCodeAdapter =
    claude_code::ClaudeCodeAdapter;
pub(super) static CODEX_ADAPTER: codex::CodexAdapter = codex::CodexAdapter;
pub(super) static GEMINI_ADAPTER: gemini::GeminiAdapter = gemini::GeminiAdapter;

/// Map `adapter_id` (the `&'static str` carried on every `TranscriptHandle`)
/// back to the corresponding adapter trait object. Returns `None` when the
/// id is unknown — defensive; in practice only the three production
/// adapter ids are ever issued via `discover_session`.
///
/// Accepts BOTH the adapter's canonical `tool_id()` return value
/// (`"claude_code"`, `"codex"`, `"gemini"`) AND the frontend
/// `TOOL_CONFIGS` id (`"claude_code"`, `"codex_cli"`, `"gemini_cli"`).
/// The `watch_transcript` IPC receives the frontend form; internal
/// callers (`source_tool` serialization, `fs_gate::ALLOWED_ROOTS`,
/// `TranscriptHandle.adapter_id`) use the canonical form. Both arms
/// route to the same `'static` adapter — the on-disk schema's
/// `source_tool` field stays the canonical form regardless of which
/// alias the caller used.
pub(super) fn adapter_for(adapter_id: &str) -> Option<&'static dyn TranscriptAdapter> {
    match adapter_id {
        "claude_code" => Some(&CLAUDE_CODE_ADAPTER),
        "codex" | "codex_cli" => Some(&CODEX_ADAPTER),
        "gemini" | "gemini_cli" => Some(&GEMINI_ADAPTER),
        _ => None,
    }
}

/// BFS recursion caps for `discover_pid_fd`'s descendant walk. Typical
/// shell→cli depth is 2 (bash → claude); 4 covers bash → wrapper → cli →
/// tool-subprocess. Breadth 32 per level guards against runaway forks
/// (a misbehaving build script under the shell shouldn't stall discovery).
/// Exceeding either cap falls through to `Ok(None)` — same behavior as the
/// pre-walk single-PID lsof, never a panic.
///
/// Cycle E status: the lsof-based primitive is unused after the move to
/// mtime-based discovery for Claude Code / Codex / Gemini (those CLIs use
/// open-append-close per turn, so lsof never sees the JSONL). The constants
/// and primitive are preserved for future adapters whose CLI does hold its
/// transcript open continuously — see `discover_pid_fd` for the rationale.
#[allow(dead_code)]
const DESCENDANT_WALK_DEPTH_CAP: usize = 4;
#[allow(dead_code)]
const DESCENDANT_WALK_BREADTH_CAP: usize = 32;

/// Locate which file open under `pid` (or any descendant) matches the
/// caller-supplied predicate.
///
/// Cross-platform PID→open-FD scan used by all three adapter
/// `discover_session` impls. Predicate decides "is this the JSONL I'm
/// looking for?"; orthogonal to the OS-mechanism (lsof vs proc-fd walk).
///
/// Returns the first matching path (callers all have a one-FD predicate
/// — only one transcript JSONL is open per CLI process at a time).
/// `Ok(None)` means neither `pid` nor any descendant within the BFS caps
/// has a matching open file (e.g. Codex has not yet created the rollout
/// JSONL — happens before first model call). `Err(io)` is reserved for
/// a genuine OS error scanning the input `pid` itself (lsof spawn
/// failure, permission denied walking /proc/<pid>/fd); per-descendant
/// scan errors are silently skipped so a single dead intermediate
/// process can't poison the whole walk.
///
/// Descendant walk rationale: when the PTY child is the user's shell
/// (the `spawn_shell` fallback in `AgentMiniTerminal.tsx`, exercised
/// whenever direct `spawn_process` rejects the bare CLI command), the
/// JSONL is opened by a descendant of bash — never bash itself. Without
/// the BFS walk the discovery returns `Ok(None)` even when the JSONL is
/// plainly open in the process tree.
///
/// macOS: shells `lsof -p <pid> -F n` (NUL-terminator-free format: lines
/// alternate `p<pid>`, `f<fd>`, `n<name>`; we filter to `n` lines).
/// Children enumerated via `pgrep -P <pid>` (same `/usr/bin` style as
/// `/usr/sbin/lsof`).
/// Linux: walks `/proc/<pid>/fd` and reads each link target. Children
/// via `/proc/<pid>/task/<tid>/children` (whitespace-separated PID list,
/// one file per thread; union across threads).
/// Other OSes: returns `Ok(None)` (no adapter discovers on them today —
/// release artifact is `.dmg`-only per CLAUDE.md).
#[allow(dead_code)]
pub(super) fn discover_pid_fd<F>(pid: i32, predicate: F) -> std::io::Result<Option<PathBuf>>
where
    F: Fn(&Path) -> bool,
{
    // Step 1: try the input PID. Errors here propagate (genuine OS
    // failure scanning the bound PID is a real problem the caller
    // should see).
    if let Some(found) = scan_one_pid(pid, &predicate)? {
        return Ok(Some(found));
    }

    // Step 2: BFS over descendants. Per-PID scan errors are skipped
    // (a single dead intermediate doesn't poison the walk).
    let mut frontier: Vec<i32> = list_children(pid);
    for _depth in 0..DESCENDANT_WALK_DEPTH_CAP {
        if frontier.is_empty() {
            break;
        }
        if frontier.len() > DESCENDANT_WALK_BREADTH_CAP {
            frontier.truncate(DESCENDANT_WALK_BREADTH_CAP);
        }
        let mut next_frontier: Vec<i32> = Vec::new();
        for child_pid in &frontier {
            match scan_one_pid(*child_pid, &predicate) {
                Ok(Some(found)) => return Ok(Some(found)),
                Ok(None) => {}
                Err(_) => {} // skip descendant on error
            }
            // Enumerate grandchildren regardless of this child's scan
            // outcome — the matching FD may live in the next level even
            // if a sibling at this level failed.
            next_frontier.extend(list_children(*child_pid));
        }
        frontier = next_frontier;
    }
    Ok(None)
}

/// Scan a single PID for an open FD matching `predicate`. Same per-OS
/// shape as the pre-walk single-PID logic — extracted so the BFS loop
/// can reuse it per node.
#[allow(dead_code)]
fn scan_one_pid<F>(pid: i32, predicate: &F) -> std::io::Result<Option<PathBuf>>
where
    F: Fn(&Path) -> bool,
{
    #[cfg(target_os = "macos")]
    {
        // `lsof -F n` is the path-only output format; lines starting with
        // `n` carry the path. `-p <pid>` restricts to one process.
        let output = std::process::Command::new("/usr/sbin/lsof")
            .args(["-p", &pid.to_string(), "-F", "n"])
            .output()?;
        // lsof exits with code 1 when the PID has no matching open files
        // OR doesn't exist. Both are NoMatchingFd at the adapter layer —
        // distinguishing them would require an additional kill(pid, 0)
        // probe that adds nothing for our use case.
        if !output.status.success() {
            return Ok(None);
        }
        let stdout = String::from_utf8_lossy(&output.stdout);
        for line in stdout.lines() {
            if let Some(rest) = line.strip_prefix('n') {
                let path = Path::new(rest);
                if predicate(path) {
                    return Ok(Some(path.to_path_buf()));
                }
            }
        }
        return Ok(None);
    }

    #[cfg(target_os = "linux")]
    {
        let fd_dir = format!("/proc/{}/fd", pid);
        let entries = match std::fs::read_dir(&fd_dir) {
            Ok(e) => e,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                // PID's /proc entry vanished or never existed — alive
                // PIDs always have a /proc/<pid>/fd directory on Linux.
                return Ok(None);
            }
            Err(e) => return Err(e),
        };
        for entry in entries {
            let entry = entry?;
            if let Ok(target) = std::fs::read_link(entry.path()) {
                if predicate(&target) {
                    return Ok(Some(target));
                }
            }
        }
        return Ok(None);
    }

    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    {
        let _ = (pid, predicate);
        Ok(None)
    }
}

/// Enumerate direct child PIDs of `pid`. Returns an empty vec on any
/// failure — the caller's BFS treats "no children visible" identically
/// to "PID exists but is a leaf", which is the correct behavior when
/// we can't see further.
#[allow(dead_code)]
fn list_children(pid: i32) -> Vec<i32> {
    #[cfg(target_os = "macos")]
    {
        // `pgrep -P <ppid>` prints one child PID per line. Exit 1 = no
        // matches (treat as empty children). Other failures: silent
        // empty per the docstring contract.
        let output = match std::process::Command::new("/usr/bin/pgrep")
            .args(["-P", &pid.to_string()])
            .output()
        {
            Ok(o) => o,
            Err(_) => return Vec::new(),
        };
        // pgrep exit 1 = no descendants; both cases yield no children.
        // Exit codes >1 indicate pgrep itself failed; same outcome.
        if !output.status.success() && output.status.code() != Some(1) {
            return Vec::new();
        }
        let stdout = String::from_utf8_lossy(&output.stdout);
        let mut out = Vec::new();
        for line in stdout.lines() {
            if let Ok(p) = line.trim().parse::<i32>() {
                out.push(p);
            }
        }
        return out;
    }

    #[cfg(target_os = "linux")]
    {
        // /proc/<pid>/task/<tid>/children is a whitespace-separated PID
        // list, one file per thread. Union across threads — a child of
        // any thread is a child of the process.
        let task_dir = format!("/proc/{}/task", pid);
        let entries = match std::fs::read_dir(&task_dir) {
            Ok(e) => e,
            Err(_) => return Vec::new(),
        };
        let mut seen = std::collections::HashSet::new();
        for entry in entries.flatten() {
            let children_path = entry.path().join("children");
            let contents = match std::fs::read_to_string(&children_path) {
                Ok(s) => s,
                Err(_) => continue,
            };
            for tok in contents.split_whitespace() {
                if let Ok(p) = tok.parse::<i32>() {
                    seen.insert(p);
                }
            }
        }
        return seen.into_iter().collect();
    }

    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    {
        let _ = pid;
        Vec::new()
    }
}

/// Orchestrate the common work of `*Adapter::discover_session`: find the
/// JSONL via `discover_pid_fd`, gate it through `fs_gate`, lstat for the
/// binding-time inode, fetch the session memory dir, and build the
/// `TranscriptHandle`.
///
/// Adapters supply the `adapter_id` constant + a path predicate; all
/// shared work lives here. Keeps the three impls down to a few lines
/// each.
#[allow(dead_code)]
pub(super) fn discover_handle<F>(
    adapter_id: &'static str,
    agent_handle: &str,
    pid: i32,
    predicate: F,
) -> Result<TranscriptHandle, DiscoveryError>
where
    F: Fn(&Path) -> bool,
{
    use std::os::unix::fs::MetadataExt;

    let candidate = discover_pid_fd(pid, predicate)
        .map_err(DiscoveryError::Io)?
        .ok_or(DiscoveryError::NoMatchingFd)?;

    // fs_gate canonicalizes + symlink-rejects + adapter-allow-root checks.
    // Failure → Gated with the inner reason serialized for diagnostic logs.
    let canonical = super::fs_gate::check_transcript_root(adapter_id, &candidate)
        .map_err(|e| DiscoveryError::Gated(format!("{:?}", e)))?;

    let lstat = std::fs::metadata(&canonical).map_err(DiscoveryError::Io)?;
    let source_inode = lstat.ino();

    // Session memory dir for Tailer state I/O (touch-up delta A). Same
    // dir the watcher will write its `.state.json` into — populated
    // here so the handle carries it for downstream Tailer use.
    let memory_dir = super::super::memory::get_memory_dir()
        .map_err(|e| DiscoveryError::Io(std::io::Error::new(std::io::ErrorKind::Other, e)))?;

    Ok(TranscriptHandle {
        agent_handle: agent_handle.to_string(),
        adapter_id,
        source_path: canonical,
        source_inode,
        pid,
        memory_dir,
        // Watcher-owned: adapters never set this. `populate_entry` overwrites
        // the empty placeholder with the sanitized collab_session_id from the
        // IPC (plan N4/N6).
        collab_session_id: String::new(),
    })
}

/// Synthesize a current ISO-8601 timestamp for the `ts_source = Ct` fallback.
///
/// Used by `*Adapter::normalize` when the source line carries no usable
/// timestamp (rare in production — all three adapters' line schemas include
/// a timestamp field — but the trait contract requires a non-panic path).
///
/// Algorithm: Howard Hinnant's `civil_from_days` (public domain — see
/// https://howardhinnant.github.io/date_algorithms.html). Decomposes
/// `SystemTime::now() - UNIX_EPOCH` into Y/M/D/H/M/S without pulling in a
/// new direct crate dependency (chrono/time appear only transitively via
/// `notify`/`tokio`, not under our [dependencies] block — adding them would
/// be a scope expansion the planner did not authorize).
///
/// Output: `YYYY-MM-DDTHH:MM:SSZ` — UTC, second precision, parseable by
/// frontend `Date.parse` and any ISO-8601 reader.
pub(super) fn synth_iso8601_now() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);

    let days = (secs / 86_400) as i64;
    let sec_of_day = (secs % 86_400) as u64;
    let h = sec_of_day / 3600;
    let m = (sec_of_day % 3600) / 60;
    let s = sec_of_day % 60;

    // civil_from_days (Hinnant). Constants are correct for the proleptic
    // Gregorian calendar; covers epoch-anchored dates from year -32767 to
    // +32767, far beyond any plausible synth timestamp.
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

    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z",
        year, month, d, h, m, s
    )
}

// ---------------------------------------------------------------------------
// Cycle E — mtime-based discovery primitives
// ---------------------------------------------------------------------------
//
// Replaces the lsof-based discover_pid_fd / discover_handle pipeline for
// adapters whose CLI uses open-append-close per turn (Claude Code 2.1.x,
// Codex, likely Gemini). Verification on Claude Code 2.1.133 showed the
// session JSONL is NOT held open between turns: lsof on the agent PID and
// every descendant returns no JSONL FD even when a 100+ KB JSONL exists on
// disk. The mtime-scan primitive below works regardless of whether the file
// is open — it relies only on filesystem metadata.

/// Resolve a PID's current working directory.
///
/// Mirrors `commands/pty.rs::get_pty_cwd` (which resolves cwd for the PTY's
/// child via lsof for the get_pty_cwd IPC) but lives in the adapters module
/// and returns `PathBuf` for direct `.join()` use by adapter discover_session
/// impls. Two separate sites are intentional: pty.rs returns `String` for
/// the IPC contract and adds error formatting; this version returns the
/// untouched `PathBuf` so the caller can join project-dir suffixes without
/// re-parsing.
///
/// macOS: shells `/usr/sbin/lsof -a -p <pid> -d cwd -F n` and parses the
/// single `n`-prefixed output line. The `-a` flag intersects `-p` and `-d`
/// filters so only the cwd entry is reported.
///
/// Linux: reads `/proc/<pid>/cwd` as a symlink. Permission denied surfaces
/// as `io::Error` (the agent process is owned by the same user as Canvas
/// Terminal, so this should not occur in practice; defensive error path
/// only).
///
/// Other OSes: returns `Err(Unsupported)` — no adapter discovers on them
/// today (release artifact is `.dmg`-only per CLAUDE.md).
///
/// Errors: `Io` for genuine OS failures (lsof spawn, readlink, exit-non-zero
/// from lsof); `NotFound` when lsof returns success but no `n`-line in
/// output (should not occur on a live PID, but defended).
pub(super) fn discover_pid_cwd(pid: i32) -> std::io::Result<PathBuf> {
    #[cfg(target_os = "macos")]
    {
        let output = std::process::Command::new("/usr/sbin/lsof")
            .args(["-a", "-p", &pid.to_string(), "-d", "cwd", "-Fn"])
            .output()?;
        if !output.status.success() {
            return Err(std::io::Error::new(
                std::io::ErrorKind::NotFound,
                format!("lsof cwd exit {}", output.status.code().unwrap_or(-1)),
            ));
        }
        let stdout = String::from_utf8_lossy(&output.stdout);
        for line in stdout.lines() {
            if let Some(rest) = line.strip_prefix('n') {
                return Ok(PathBuf::from(rest));
            }
        }
        return Err(std::io::Error::new(
            std::io::ErrorKind::NotFound,
            "no n-line in lsof cwd output",
        ));
    }

    #[cfg(target_os = "linux")]
    {
        let link = format!("/proc/{}/cwd", pid);
        return std::fs::read_link(&link);
    }

    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    {
        let _ = pid;
        Err(std::io::Error::new(
            std::io::ErrorKind::Unsupported,
            "discover_pid_cwd not implemented on this platform",
        ))
    }
}

/// Resolve a process's start time in unix seconds (cycle F).
///
/// The mtime-based discovery threshold (`discover_by_mtime`) needs a
/// server-side, authoritative process-start time. The cycle E approach of
/// reading `Date.now()` in the frontend at watch-effect-fire (click-Eye)
/// time carried a "click-time-not-spawn-time" bug: if the user typed a
/// message before clicking Eye, the JSONL mtime was already older than
/// the click-time threshold → `NoMatchingFd`. Cycle F always-on makes
/// this acute, so the threshold moves server-side.
///
/// - **macOS**: `ps -p <pid> -o etime=` returns elapsed time since
///   process start in `[[DD-]HH:]MM:SS` format. Parsed to seconds and
///   subtracted from `SystemTime::now()`. Avoids `ps -o lstart=` date
///   parsing (locale-fragile).
/// - **Linux**: `/proc/<pid>/stat` field 22 (process start time in
///   clock ticks since boot) combined with `/proc/uptime` derives the
///   unix-seconds anchor. Uses `libc::sysconf(_SC_CLK_TCK)` for the
///   per-system clock-tick rate.
/// - **Other OSes**: `Err(io::ErrorKind::Unsupported)` — the watcher
///   degrades to the previous-cycle behaviour via the outer caller's
///   error mapping.
///
/// Error semantics:
/// - `io::ErrorKind::NotFound` — PID does not exist (process exited
///   before discovery ran, or never existed). Caller treats as
///   `NoMatchingFd` because there's no transcript to find.
/// - `io::ErrorKind::InvalidData` — `ps` / `/proc` output failed to
///   parse (PID exists but format is unexpected).
/// - Other `io::Error` kinds — genuine OS failures (spawn `ps`, read
///   `/proc`).
pub(super) fn discover_pid_start_time(pid: i32) -> std::io::Result<i64> {
    #[cfg(target_os = "macos")]
    {
        use std::process::Command;
        use std::time::{SystemTime, UNIX_EPOCH};

        let output = Command::new("ps")
            .args(["-p", &pid.to_string(), "-o", "etime="])
            .output()?;

        if !output.status.success() {
            // ps prints nothing and returns non-zero when the PID has no
            // matching process. Treat as NotFound so the caller can fold
            // it into the existing "no transcript yet" path.
            return Err(std::io::Error::new(
                std::io::ErrorKind::NotFound,
                format!("ps exited {} for pid {}", output.status, pid),
            ));
        }

        let raw = String::from_utf8_lossy(&output.stdout);
        let elapsed_secs = parse_ps_etime(raw.trim()).ok_or_else(|| {
            std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                format!("unparseable ps etime output: {:?}", raw),
            )
        })?;

        let now_secs = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))?
            .as_secs() as i64;

        Ok(now_secs - elapsed_secs as i64)
    }

    #[cfg(target_os = "linux")]
    {
        use std::time::{SystemTime, UNIX_EPOCH};

        let stat = std::fs::read_to_string(format!("/proc/{}/stat", pid))?;
        // The `comm` field is enclosed in parens and may itself contain
        // spaces or `)` characters. Splitting from the LAST `)` is the
        // canonical way to skip it; everything after is whitespace-
        // separated fields starting at field 3 (state).
        let after = stat
            .rfind(')')
            .map(|i| &stat[i + 1..])
            .ok_or_else(|| {
                std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    "missing ')' in /proc/<pid>/stat",
                )
            })?;
        let fields: Vec<&str> = after.split_whitespace().collect();
        // Field 22 (1-indexed in stat layout: pid=1, comm=2, state=3, ...,
        // starttime=22). After dropping pid+comm via the rfind split,
        // fields[0] is state — so starttime is fields[19].
        if fields.len() < 20 {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "/proc/<pid>/stat too short for field 22",
            ));
        }
        let start_ticks: u64 = fields[19].parse().map_err(|e| {
            std::io::Error::new(std::io::ErrorKind::InvalidData, format!("starttime parse: {}", e))
        })?;

        let uptime_raw = std::fs::read_to_string("/proc/uptime")?;
        let uptime_secs: f64 = uptime_raw
            .split_whitespace()
            .next()
            .ok_or_else(|| {
                std::io::Error::new(std::io::ErrorKind::InvalidData, "empty /proc/uptime")
            })?
            .parse()
            .map_err(|e| {
                std::io::Error::new(std::io::ErrorKind::InvalidData, format!("uptime parse: {}", e))
            })?;

        let clk_tck = unsafe { libc::sysconf(libc::_SC_CLK_TCK) };
        if clk_tck <= 0 {
            return Err(std::io::Error::new(
                std::io::ErrorKind::Other,
                "sysconf(_SC_CLK_TCK) returned non-positive value",
            ));
        }

        let now_secs = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))?
            .as_secs() as f64;
        let boot_unix_secs = now_secs - uptime_secs;
        let process_uptime_secs = start_ticks as f64 / clk_tck as f64;
        Ok((boot_unix_secs + process_uptime_secs) as i64)
    }

    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    {
        let _ = pid;
        Err(std::io::Error::new(
            std::io::ErrorKind::Unsupported,
            "discover_pid_start_time not implemented on this platform",
        ))
    }
}

/// Parse `ps -o etime=` output. Format is `[[DD-]HH:]MM:SS`:
///   - `MM:SS`        — minutes:seconds (process < 1h old)
///   - `HH:MM:SS`     — hours:minutes:seconds (< 1d old)
///   - `DD-HH:MM:SS`  — days-hours:minutes:seconds
///
/// Returns total elapsed seconds, or `None` on parse failure.
#[cfg(target_os = "macos")]
fn parse_ps_etime(s: &str) -> Option<u64> {
    if s.is_empty() {
        return None;
    }
    let (days, rest) = match s.split_once('-') {
        Some((d, r)) => (d.parse::<u64>().ok()?, r),
        None => (0u64, s),
    };
    let parts: Vec<&str> = rest.split(':').collect();
    let (hours, mins, secs) = match parts.as_slice() {
        [m, s] => (0u64, m.parse::<u64>().ok()?, s.parse::<u64>().ok()?),
        [h, m, s] => (
            h.parse::<u64>().ok()?,
            m.parse::<u64>().ok()?,
            s.parse::<u64>().ok()?,
        ),
        _ => return None,
    };
    Some(days * 86_400 + hours * 3_600 + mins * 60 + secs)
}

/// Locate the newest JSONL under `scan_roots` whose mtime is at or after
/// the resolved process-start time of `pid` (cycle F).
///
/// The mtime-based replacement for `discover_handle`. Used by adapters whose
/// CLI uses open-append-close per turn. `scan_roots` is a slice so callers
/// like Codex (which needs today + yesterday's date dirs) can pre-enumerate;
/// callers like Claude Code pass a single-element slice.
///
/// Algorithm: resolve `pid`'s start time via `discover_pid_start_time` to
/// produce an authoritative threshold (no slack — process start time is
/// definitive). Then `read_dir` every root, collecting entries that satisfy
/// `predicate(path) && mtime >= threshold` AND are not in `claimed_paths`
/// (Defense-2B — excludes transcripts already bound to other live handles,
/// canonical compare). Among the unclaimed candidates, prefer the newest one
/// whose LATEST identity preamble names BOTH `agent_handle` AND
/// `collab_session_id` (Defense-2A, plan N7 — `transcript_has_identity_marker`
/// walks backward from EOF and parses-then-compares the current launch's
/// preamble); if none matches, return `NoMatchingFd` in strict mode
/// (`allow_unmarked_fallback == false`) so the loop retries, or fall back to
/// the newest unclaimed candidate with a warning when the marker-wait budget
/// is exhausted (`allow_unmarked_fallback == true`, N19 — reachable only for a
/// non-CT/manual watch with an empty `collab_session_id`). On a chosen
/// candidate, build the `TranscriptHandle` (via `fs_gate` + `lstat` +
/// `memory_dir`, `collab_session_id` left empty for the watcher to fill) and
/// return. Otherwise `DiscoveryError::NoMatchingFd`.
///
/// Single-shot scan — the retry-until-unwatch loop has moved up one layer
/// into `TranscriptWatcher::watch`'s async task (cycle F F6). Cycle E's
/// internal 5×500ms loop is gone.
///
/// `read_dir` failure on a single root is logged-equivalent (we simply
/// continue with no candidates from that root) — other roots are still
/// scanned. Matches the per-descendant skip policy in cycle D's
/// `list_children`.
///
/// PID-resolution failures map as:
/// - `io::ErrorKind::NotFound` → `DiscoveryError::NoMatchingFd` (no
///   process means no transcript to look for; the outer async loop will
///   tear the watch down on the next unwatch).
/// - Other `io::Error` → `DiscoveryError::Io` (propagated for diagnosis).
pub(super) fn discover_by_mtime<F>(
    adapter_id: &'static str,
    agent_handle: &str,
    scan_roots: &[PathBuf],
    pid: i32,
    predicate: F,
    claimed_paths: &HashSet<PathBuf>,
    allow_unmarked_fallback: bool,
    collab_session_id: &str,
) -> Result<TranscriptHandle, DiscoveryError>
where
    F: Fn(&Path) -> bool,
{
    use std::os::unix::fs::MetadataExt;
    use std::time::{Duration, SystemTime, UNIX_EPOCH};

    // Threshold = process-start time (server-side, authoritative). No
    // slack — `discover_pid_start_time` returns seconds, multiplied to ms
    // for SystemTime arithmetic.
    let start_unix_secs = match discover_pid_start_time(pid) {
        Ok(s) => s,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Err(DiscoveryError::NoMatchingFd);
        }
        Err(e) => return Err(DiscoveryError::Io(e)),
    };
    let threshold_ms = start_unix_secs.saturating_mul(1000).max(0);
    let threshold = UNIX_EPOCH + Duration::from_millis(threshold_ms as u64);

    // Collect every candidate at-or-after the threshold, EXCLUDING any whose
    // path is already bound to another live handle (Defense-2B). The claimed
    // set holds fs_gate-canonical paths, so we compare against both the raw
    // entry path and its canonical form (a candidate and a claimed handle can
    // reach the same file via different aliases — plan N17 canonical-compare
    // constraint applied at the discovery boundary too).
    let mut candidates: Vec<(PathBuf, SystemTime)> = Vec::new();
    for root in scan_roots {
        let entries = match std::fs::read_dir(root) {
            Ok(e) => e,
            Err(_) => continue, // root missing / unreadable; try others
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if !predicate(&path) {
                continue;
            }
            let meta = match entry.metadata() {
                Ok(m) => m,
                Err(_) => continue,
            };
            let mtime = match meta.modified() {
                Ok(t) => t,
                Err(_) => continue,
            };
            if mtime < threshold {
                continue;
            }
            // Defense-2B: skip paths already claimed by another live handle.
            let canon = std::fs::canonicalize(&path).unwrap_or_else(|_| path.clone());
            if claimed_paths.contains(&canon) || claimed_paths.contains(&path) {
                continue;
            }
            candidates.push((path, mtime));
        }
    }

    // Defense-2A (plan N7): prefer the candidate whose LATEST identity preamble
    // names BOTH the expected handle AND this collab session; among matches
    // pick the newest mtime. Keying on the *latest* preamble (backward walk)
    // and on (handle, session) — not handle alone — binds an agent to ITS OWN
    // transcript in THIS session even when a same-handle, different-session
    // rollout is momentarily newer, and tolerates resumed rollouts whose stale
    // head headers belong to an earlier launch.
    let newest_marked = candidates
        .iter()
        .filter(|(p, _)| transcript_has_identity_marker(p, agent_handle, collab_session_id))
        .max_by_key(|(_, mtime)| *mtime)
        .map(|(p, _)| p.clone());

    let chosen: Option<PathBuf> = match newest_marked {
        Some(p) => Some(p),
        None => {
            if allow_unmarked_fallback {
                // N19 termination: marker-wait budget exhausted. Fall back to
                // the newest unclaimed candidate. NOTE (plan N1/N3): for a
                // CT-launched collab watch the caller holds
                // `allow_unmarked_fallback == false` PERMANENTLY, so this
                // branch is reachable only for a non-CT/manual watch (empty
                // collab_session_id). All three production CLIs — Claude Code,
                // Codex, AND Gemini — DO carry the CT-injected `You are @`
                // preamble (the earlier "codex has no identity line" claim was
                // wrong), so within a CT watch the strict latest-preamble path
                // (N7) handles them and this fallback never fires. Double-
                // binding is still prevented by 2B (claimed exclusion above) +
                // N17 (populate-time recheck).
                let fallback = candidates
                    .iter()
                    .max_by_key(|(_, mtime)| *mtime)
                    .map(|(p, _)| p.clone());
                if let Some(p) = &fallback {
                    eprintln!(
                        "transcripts: no identity marker found for {} after marker-wait \
                         budget; falling back to newest unclaimed candidate {:?} (N19)",
                        agent_handle, p
                    );
                }
                fallback
            } else {
                // Strict mode: no candidate's latest preamble matches this
                // (handle, session) yet. Return NoMatchingFd so the discovery
                // loop retries — the agent's current-launch preamble turn may
                // not have flushed to disk yet.
                None
            }
        }
    };

    if let Some(candidate) = chosen {
        // Run the same fs_gate + lstat + memory_dir wiring as
        // discover_handle. Inlined here so this primitive stays
        // independent of the legacy helper (now dead code since cycle E).
        let canonical = super::fs_gate::check_transcript_root(adapter_id, &candidate)
            .map_err(|e| DiscoveryError::Gated(format!("{:?}", e)))?;

        let lstat = std::fs::metadata(&canonical).map_err(DiscoveryError::Io)?;
        let source_inode = lstat.ino();

        let memory_dir = super::super::memory::get_memory_dir().map_err(|e| {
            DiscoveryError::Io(std::io::Error::new(std::io::ErrorKind::Other, e))
        })?;

        return Ok(TranscriptHandle {
            agent_handle: agent_handle.to_string(),
            adapter_id,
            source_path: canonical,
            source_inode,
            // pid is pass-through state on the handle (not used for
            // discovery routing post-population, but kept for the
            // existing Tailer / fs_gate diagnostic logging).
            pid,
            memory_dir,
            // Watcher-owned: filled by `populate_entry`, never here (plan N6).
            collab_session_id: String::new(),
        });
    }

    Err(DiscoveryError::NoMatchingFd)
}

#[cfg(test)]
mod marker_tests {
    //! Plan N7/N10: the latest-preamble, session-scoped identity match is what
    //! binds an agent to ITS OWN transcript in THIS collab session. These
    //! deterministic tests cover the success-criteria matrix (a)-(f):
    //!   (a) two same-handle / different-session candidates bind their own
    //!   (b) stale wrong header in HEAD + correct header later → latest wins
    //!   (c) correct header followed by >256 KiB trailing output → still found
    //!   (d) a different-handle candidate is rejected (not bound) under a CT
    //!       collab watch (non-empty session id)
    //!   (e) populate-time revalidation rejects a latest-marker mismatch but
    //!       NOT a merely-stale earlier header
    //!   (f) backward-reader robustness: no trailing newline; a turn larger
    //!       than the read chunk; a needle split across a chunk boundary
    use super::{
        find_latest_identity_preamble_line, transcript_has_identity_marker,
        MARKER_BACKWARD_CHUNK_BYTES, MARKER_BACKWARD_SCAN_CAP_BYTES,
    };
    use std::io::Write;
    use std::path::PathBuf;

    fn write_temp(tag: &str, content: &[u8]) -> PathBuf {
        // Unique per (process, tag) so parallel test threads don't collide.
        let p = std::env::temp_dir().join(format!("ct-{}-{}.jsonl", std::process::id(), tag));
        let mut f = std::fs::File::create(&p).unwrap();
        f.write_all(content).unwrap();
        p
    }

    /// Build one physical JSONL preamble line (no embedded real newline — the
    /// CT preamble is one JSON record whose `text` field carries the handle
    /// and the session path tokens together).
    fn preamble_line(handle: &str, sid: &str) -> String {
        format!(
            "{{\"role\":\"user\",\"text\":\"[You are @{h}] [Conversation log: \
             /m/conversation-{s}.md] [contexts/{s}/x.jsonl]\"}}",
            h = handle,
            s = sid
        )
    }

    // -- basic detection --------------------------------------------------

    #[test]
    fn detects_identity_marker_handle_and_session() {
        let mut c = preamble_line("claude1", "session-A");
        c.push('\n');
        let p = write_temp("detect", c.as_bytes());
        assert!(transcript_has_identity_marker(&p, "claude1", "session-A"));
        let _ = std::fs::remove_file(&p);
    }

    #[test]
    fn word_boundary_prevents_prefix_match() {
        // claude1 must NOT match a transcript that belongs to claude11.
        let mut c = preamble_line("claude11", "session-A");
        c.push('\n');
        let p = write_temp("boundary", c.as_bytes());
        assert!(!transcript_has_identity_marker(&p, "claude1", "session-A"));
        assert!(transcript_has_identity_marker(&p, "claude11", "session-A"));
        let _ = std::fs::remove_file(&p);
    }

    #[test]
    fn absent_marker_returns_false() {
        let p = write_temp("absent", b"{\"text\":\"hello world, no marker here\"}\n");
        assert!(!transcript_has_identity_marker(&p, "claude1", "session-A"));
        let _ = std::fs::remove_file(&p);
    }

    #[test]
    fn missing_file_returns_false() {
        let p = std::env::temp_dir().join(format!(
            "ct-{}-does-not-exist-xyz.jsonl",
            std::process::id()
        ));
        let _ = std::fs::remove_file(&p);
        assert!(!transcript_has_identity_marker(&p, "claude1", "session-A"));
    }

    #[test]
    fn empty_handle_returns_false() {
        let p = write_temp("emptyhandle", b"{\"text\":\"You are @\"}\n");
        assert!(!transcript_has_identity_marker(&p, "", "session-A"));
        let _ = std::fs::remove_file(&p);
    }

    #[test]
    fn empty_session_is_handle_only_match() {
        // Non-CT/manual watch (empty session id) keeps legacy handle-only
        // matching: the session token is not required.
        let c = b"{\"text\":\"[You are @claude1] no session path here\"}\n";
        let p = write_temp("emptysess", c);
        assert!(transcript_has_identity_marker(&p, "claude1", ""));
        assert!(!transcript_has_identity_marker(&p, "claude2", ""));
        let _ = std::fs::remove_file(&p);
    }

    // -- (a) same-handle / different-session each binds its own -----------

    #[test]
    fn a_same_handle_different_session_each_binds_own() {
        let mut a = preamble_line("claude1", "session-A");
        a.push('\n');
        let mut b = preamble_line("claude1", "session-B");
        b.push('\n');
        let pa = write_temp("a-sessA", a.as_bytes());
        let pb = write_temp("a-sessB", b.as_bytes());

        assert!(transcript_has_identity_marker(&pa, "claude1", "session-A"));
        assert!(!transcript_has_identity_marker(&pa, "claude1", "session-B"));
        assert!(transcript_has_identity_marker(&pb, "claude1", "session-B"));
        assert!(!transcript_has_identity_marker(&pb, "claude1", "session-A"));

        let _ = std::fs::remove_file(&pa);
        let _ = std::fs::remove_file(&pb);
    }

    // -- (b) latest-preamble authority (stale head, correct later) --------

    #[test]
    fn b_latest_preamble_wins_over_stale_head() {
        // A stale FOREIGN preamble in the head (claude2/session-X), then the
        // current-launch correct preamble (claude1/session-A) later, then
        // ordinary trailing output.
        let mut c = String::new();
        c.push_str(&preamble_line("claude2", "session-X"));
        c.push('\n');
        c.push_str(&preamble_line("claude1", "session-A"));
        c.push('\n');
        c.push_str("{\"text\":\"some later assistant output\"}\n");
        let p = write_temp("b-latest", c.as_bytes());

        // Latest preamble is claude1/session-A → matches it, NOT the stale head.
        assert!(transcript_has_identity_marker(&p, "claude1", "session-A"));
        // Parse-latest-then-compare: the stale head's (claude2, session-X) must
        // NOT be accepted just because it appears somewhere in the file.
        assert!(!transcript_has_identity_marker(&p, "claude2", "session-X"));
        let _ = std::fs::remove_file(&p);
    }

    // -- (c) correct header + >256 KiB trailing output → still found ------

    #[test]
    fn c_found_behind_large_trailing_output() {
        let mut c = String::new();
        c.push_str(&preamble_line("claude1", "session-c"));
        c.push('\n');
        // > 256 KiB of separate trailing output lines (also spans several
        // 64 KiB backward chunks), so the preamble is far from EOF.
        let line = "{\"text\":\"xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx\"}\n";
        let target = 300 * 1024;
        while c.len() < target {
            c.push_str(line);
        }
        let p = write_temp("c-trailing", c.as_bytes());
        assert!(transcript_has_identity_marker(&p, "claude1", "session-c"));
        assert!(!transcript_has_identity_marker(&p, "claude1", "session-other"));
        let _ = std::fs::remove_file(&p);
    }

    // -- (d) different-handle candidate not bound under a CT collab watch -

    #[test]
    fn d_different_handle_not_matched_under_ct_watch() {
        // A claude2 rollout must not satisfy a claude1/session-A CT watch.
        // discover_by_mtime's strict filter (fallback disabled for non-empty
        // session, plan N1) then yields NoMatchingFd rather than binding it.
        let mut c = preamble_line("claude2", "session-A");
        c.push('\n');
        let p = write_temp("d-otherhandle", c.as_bytes());
        assert!(!transcript_has_identity_marker(&p, "claude1", "session-A"));
        let _ = std::fs::remove_file(&p);
    }

    // -- (e) populate revalidation: reject latest mismatch, tolerate stale -

    #[test]
    fn e_revalidation_rejects_latest_mismatch_tolerates_stale() {
        // Reject: latest preamble names a DIFFERENT session than the watcher.
        let mut reject = preamble_line("claude1", "session-B");
        reject.push('\n');
        let p_reject = write_temp("e-reject", reject.as_bytes());
        assert!(
            !transcript_has_identity_marker(&p_reject, "claude1", "session-A"),
            "latest marker session mismatch must reject (N8)"
        );

        // Tolerate: an earlier STALE header mismatches, but the LATEST one
        // matches the watcher → must NOT reject.
        let mut tolerate = String::new();
        tolerate.push_str(&preamble_line("claude1", "session-OLD"));
        tolerate.push('\n');
        tolerate.push_str(&preamble_line("claude1", "session-A"));
        tolerate.push('\n');
        let p_tolerate = write_temp("e-tolerate", tolerate.as_bytes());
        assert!(
            transcript_has_identity_marker(&p_tolerate, "claude1", "session-A"),
            "a merely-stale earlier header must NOT cause rejection (N8)"
        );

        let _ = std::fs::remove_file(&p_reject);
        let _ = std::fs::remove_file(&p_tolerate);
    }

    // -- (f) backward-reader robustness -----------------------------------

    #[test]
    fn f_last_line_without_trailing_newline() {
        // Preamble IS the final line and the file has no trailing '\n'.
        let c = preamble_line("claude1", "session-f1");
        let p = write_temp("f-nonl", c.as_bytes());
        assert!(transcript_has_identity_marker(&p, "claude1", "session-f1"));
        let _ = std::fs::remove_file(&p);
    }

    #[test]
    fn f_preamble_turn_larger_than_read_chunk() {
        // One physical line (a realistic CT preamble: both bracket labels)
        // longer than the backward read chunk — forces multi-chunk reassembly
        // of a single line before it can be recognized as a preamble.
        let chunk = MARKER_BACKWARD_CHUNK_BYTES;
        let mut c = String::from(
            "{\"text\":\"[You are @claude1] [Conversation log: /m/conversation-session-big.md] [contexts/session-big/] ",
        );
        c.push_str(&"x".repeat(chunk * 3));
        c.push_str("\"}\n");
        let p = write_temp("f-biglinetail", c.as_bytes());
        assert!(transcript_has_identity_marker(&p, "claude1", "session-big"));
        let _ = std::fs::remove_file(&p);
    }

    #[test]
    fn f_needle_split_across_chunk_boundary() {
        // Craft a single realistic-preamble line so the `[You are @` identity
        // bracket straddles the boundary between the first and second backward
        // read chunks (at file_len - C). With the identity bracket starting at
        // offset `head.len() + 8` and a trailing pad of `C - 14`, the boundary
        // lands mid-bracket, so only reassembly (not a per-chunk search) can
        // find it. The `[Conversation log: …]` head supplies the session anchor.
        let c = MARKER_BACKWARD_CHUNK_BYTES;
        let head = "[Conversation log: /m/conversation-session-split.md] ";
        let identity = "[You are @claude1]"; // 18 bytes
        assert_eq!(identity.len(), 18);
        let pad = "pppppppp"; // 8 bytes, places identity `[` at head.len()+8
        let trailing = "x".repeat(c - 14); // boundary lands inside `[You are @`
        let content = format!("{}{}{}{}", head, pad, identity, trailing);
        let p = write_temp("f-split", content.as_bytes());

        // Sanity: the reader returns the whole single line (bracket reassembled
        // across the chunk boundary).
        let line = find_latest_identity_preamble_line(&p, MARKER_BACKWARD_SCAN_CAP_BYTES, true)
            .expect("preamble line must be located across the chunk boundary");
        assert!(super::contains_subslice(&line, b"[You are @claude1]"));

        assert!(transcript_has_identity_marker(&p, "claude1", "session-split"));
        assert!(!transcript_has_identity_marker(&p, "claude2", "session-split"));
        let _ = std::fs::remove_file(&p);
    }

    // -- (g) peer-review regression: incidental `You are @` AFTER a valid -
    //        preamble must not shadow it (liveness) nor cross-bind (wrong agent)

    #[test]
    fn g_incidental_needle_after_preamble_does_not_shadow() {
        // Valid current-launch preamble, THEN ordinary later output lines that
        // merely contain `You are @<handle>` with NO session-path token — the
        // common case in a session where agents reason about the harness.
        let mut c = String::new();
        c.push_str(&preamble_line("claude1", "session-g"));
        c.push('\n');
        // assistant turn discussing the protocol (parseable handle, no session token)
        c.push_str(
            "{\"role\":\"assistant\",\"text\":\"the marker string You are @claude2 should be parsed\"}\n",
        );
        // a bare needle with no handle
        c.push_str("{\"role\":\"assistant\",\"text\":\"prefix You are @ suffix\"}\n");
        let p = write_temp("g-incidental", c.as_bytes());

        // Liveness: the valid claude1/session-g preamble is still found despite
        // the later incidental needle lines (old code returned false → spin).
        assert!(
            transcript_has_identity_marker(&p, "claude1", "session-g"),
            "valid preamble must not be shadowed by later incidental `You are @` text"
        );
        // No cross-wire: the incidental `You are @claude2` line (no session
        // token) is skipped, so the latest well-formed preamble is claude1's →
        // claude2's watch does not bind this transcript.
        assert!(
            !transcript_has_identity_marker(&p, "claude2", "session-g"),
            "incidental foreign-handle mention must not cross-bind"
        );
        let _ = std::fs::remove_file(&p);
    }

    #[test]
    fn g_foreign_wellformed_preamble_after_expected_rejects() {
        // A well-formed FOREIGN preamble appearing AFTER the expected one is the
        // rollout's latest real identity → latest-authority must reject the
        // expected watch (not walk back to the older matching preamble).
        let mut c = String::new();
        c.push_str(&preamble_line("claude1", "session-h"));
        c.push('\n');
        c.push_str(&preamble_line("claude2", "session-h"));
        c.push('\n');
        let p = write_temp("g-foreign-latest", c.as_bytes());
        assert!(!transcript_has_identity_marker(&p, "claude1", "session-h"));
        assert!(transcript_has_identity_marker(&p, "claude2", "session-h"));
        let _ = std::fs::remove_file(&p);
    }

    // -- round-2 peer-review regression (codex1/codex2/claude2): a non-preamble
    //    line carrying BOTH a foreign handle AND the EXPECTED session path (but
    //    no CT bracket shape) must NOT cross-bind. This reproduces the wrong-agent
    //    bind @claude2 demonstrated; with the structural-shape candidacy it is now
    //    skipped as non-preamble.

    #[test]
    fn g_bare_quote_with_handle_and_expected_session_does_not_cross_wire() {
        let mut c = String::new();
        // The owner's real, well-formed preamble (claude1 / session-x).
        c.push_str(&preamble_line("claude1", "session-x"));
        c.push('\n');
        // A later ORDINARY assistant turn quoting a peer handle AND the expected
        // session's mirror path — bare `You are @claude2`, NO CT bracket labels.
        c.push_str(
            "{\"role\":\"assistant\",\"text\":\"see contexts/session-x/claude2.jsonl which contains You are @claude2 as its preamble\"}\n",
        );
        let p = write_temp("g-crosswire-quote", c.as_bytes());

        // No cross-wire: claude2's watcher must NOT bind claude1's rollout.
        assert!(
            !transcript_has_identity_marker(&p, "claude2", "session-x"),
            "a bare quote of a foreign handle + expected session path must not cross-bind"
        );
        // Owner still binds: the quote is skipped, the real preamble is latest.
        assert!(
            transcript_has_identity_marker(&p, "claude1", "session-x"),
            "owner's real preamble must still bind despite the later quote"
        );
        let _ = std::fs::remove_file(&p);
    }

    #[test]
    fn full_header_identity_form_is_recognized() {
        // The message-1 full header uses `[Your identity: You are @<h> ...]`
        // (collaboratorStore `prependContextHeader`) rather than the slim
        // `[You are @<h>]`. The candidacy must accept it.
        let c = "{\"text\":\"[Collaborator shared memory: /m] [Conversation log: /m/conversation-session-full.md] [Your identity: You are @claude1. Use the @claude1 handle when authoring files.]\"}\n";
        let p = write_temp("full-header", c.as_bytes());
        assert!(transcript_has_identity_marker(&p, "claude1", "session-full"));
        assert!(!transcript_has_identity_marker(&p, "claude2", "session-full"));
        let _ = std::fs::remove_file(&p);
    }
}
