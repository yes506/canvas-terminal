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

use std::path::{Path, PathBuf};

use super::{DiscoveryError, TranscriptAdapter, TranscriptHandle};

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
pub(super) fn adapter_for(adapter_id: &str) -> Option<&'static dyn TranscriptAdapter> {
    match adapter_id {
        "claude_code" => Some(&CLAUDE_CODE_ADAPTER),
        "codex" => Some(&CODEX_ADAPTER),
        "gemini" => Some(&GEMINI_ADAPTER),
        _ => None,
    }
}

/// BFS recursion caps for `discover_pid_fd`'s descendant walk. Typical
/// shell→cli depth is 2 (bash → claude); 4 covers bash → wrapper → cli →
/// tool-subprocess. Breadth 32 per level guards against runaway forks
/// (a misbehaving build script under the shell shouldn't stall discovery).
/// Exceeding either cap falls through to `Ok(None)` — same behavior as the
/// pre-walk single-PID lsof, never a panic.
const DESCENDANT_WALK_DEPTH_CAP: usize = 4;
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
