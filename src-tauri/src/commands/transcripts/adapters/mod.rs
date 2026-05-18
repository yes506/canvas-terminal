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

use super::{DiscoveryError, TranscriptHandle};

pub mod claude_code;
pub mod codex;
pub mod gemini;

/// Locate which file open under `pid` matches the caller-supplied predicate.
///
/// Cross-platform PID→open-FD scan used by all three adapter
/// `discover_session` impls. Predicate decides "is this the JSONL I'm
/// looking for?"; orthogonal to the OS-mechanism (lsof vs proc-fd walk).
///
/// Returns the first matching path (callers all have a one-FD predicate
/// — only one transcript JSONL is open per CLI process at a time).
/// `Ok(None)` means PID is alive but no FD satisfies the predicate
/// (e.g. Codex has not yet created the rollout JSONL — happens before
/// first model call). `Err(io)` is reserved for genuine OS errors
/// (lsof spawn failure, permission denied walking /proc/<pid>/fd).
///
/// macOS: shells `lsof -p <pid> -F n` (NUL-terminator-free format: lines
/// alternate `p<pid>`, `f<fd>`, `n<name>`; we filter to `n` lines).
/// Linux: walks `/proc/<pid>/fd` and reads each link target. Other OSes:
/// returns `Ok(None)` (no adapter discovers on them today — release
/// artifact is `.dmg`-only per CLAUDE.md).
pub(super) fn discover_pid_fd<F>(pid: i32, predicate: F) -> std::io::Result<Option<PathBuf>>
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
