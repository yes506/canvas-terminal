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
/// definitive). Then `read_dir` every root in turn, filter entries by
/// `predicate(path) && mtime >= threshold`, and keep the entry with the
/// maximum mtime across all roots. If a candidate exists, build the
/// `TranscriptHandle` (via `fs_gate` + `lstat` + `memory_dir`) and return.
/// Otherwise `DiscoveryError::NoMatchingFd`.
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

    let mut best: Option<(PathBuf, SystemTime)> = None;

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
            match &best {
                None => best = Some((path, mtime)),
                Some((_, current_mtime)) if mtime > *current_mtime => {
                    best = Some((path, mtime));
                }
                _ => {}
            }
        }
    }

    if let Some((candidate, _)) = best {
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
        });
    }

    Err(DiscoveryError::NoMatchingFd)
}
