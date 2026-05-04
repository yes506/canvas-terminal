//! Startup recovery scan for FSD runs.
//!
//! Scans `fsd-runs/<leader>/runs/<run_id>/manifest.json` for any manifest with
//! status ∈ {Running, Dispatching, AwaitingLeader} where:
//!   (a) `owner_pid` is dead, OR
//!   (b) `last_heartbeat_at` is older than 60 s (R15 — orchestrator-task wedge
//!       while owning process is alive; per plan v5 §5.3).
//!
//! Marks those runs `Interrupted` by writing `final.json` and updating the
//! manifest. UI then shows them in a historical section, never as "running."
//!
//! Also applies Phase-1 retention policy: keep latest 50 runs per leader OR
//! 14 days, whichever is more permissive. Active manifests NEVER deleted.

use crate::commands::memory::get_memory_root;
use crate::fsd::schema::{RunManifest, RunStatus};
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

const HEARTBEAT_TIMEOUT_SECS: u64 = 60;
const RETAIN_LATEST_N: usize = 50;
const RETAIN_DAYS: u64 = 14;
const RETAIN_SECS: u64 = RETAIN_DAYS * 24 * 60 * 60;

/// Returns count of runs marked interrupted + count of runs purged by retention.
///
/// Production wrapper — uses `get_memory_root()` for the scan root. Tests
/// use `recover_runs_in_root` with a per-test tempdir for isolation (per
/// @codex3 task-96 P1: process-wide root + parallel recovery scans + writers
/// caused EOF-mid-parse races).
pub(crate) async fn recover_runs() -> Result<RecoveryReport, String> {
    let root = match get_memory_root() {
        Ok(r) => r,
        Err(_) => return Ok(RecoveryReport::default()),
    };
    recover_runs_in_root(&root).await
}

/// Inner function with explicit root parameter — testable in isolation
/// without env-var racing. Per @codex3 task-96 P1.
pub(crate) async fn recover_runs_in_root(root: &std::path::Path) -> Result<RecoveryReport, String> {
    let fsd_root = root.join("fsd-runs");
    if !fsd_root.exists() {
        return Ok(RecoveryReport::default());
    }

    let mut report = RecoveryReport::default();
    let leaders = match std::fs::read_dir(&fsd_root) {
        Ok(d) => d,
        Err(_) => return Ok(report),
    };

    for leader_entry in leaders.flatten() {
        let leader_dir = leader_entry.path();
        if !leader_dir.is_dir() {
            continue;
        }
        let runs_dir = leader_dir.join("runs");
        if !runs_dir.exists() {
            continue;
        }
        // First pass: mark interrupted runs.
        let mut all_manifests: Vec<(std::path::PathBuf, RunManifest)> = Vec::new();
        if let Ok(runs) = std::fs::read_dir(&runs_dir) {
            for run_entry in runs.flatten() {
                let manifest_path = run_entry.path().join("manifest.json");
                if !manifest_path.exists() {
                    continue;
                }
                if let Some(mut manifest) = read_manifest(&manifest_path) {
                    if manifest.status.is_active() && should_mark_interrupted(&manifest) {
                        manifest.status = RunStatus::Interrupted;
                        write_manifest(&manifest_path, &manifest);
                        let final_path = run_entry.path().join("final.json");
                        let _ = std::fs::write(
                            &final_path,
                            serde_json::to_string_pretty(&serde_json::json!({
                                "status": "interrupted",
                                "interrupted_at": now_iso(),
                                "interrupted_by": "app_startup_recovery",
                            }))
                            .unwrap_or_default(),
                        );
                        report.interrupted += 1;
                    }
                    all_manifests.push((run_entry.path(), manifest));
                }
            }
        }
        // Second pass: retention sweep on terminal manifests.
        report.purged += apply_retention(&all_manifests);
    }

    Ok(report)
}

#[derive(Debug, Default, Clone)]
pub(crate) struct RecoveryReport {
    pub interrupted: usize,
    pub purged: usize,
}

fn should_mark_interrupted(m: &RunManifest) -> bool {
    // Either the owning process is dead, or the heartbeat is stale.
    if !is_process_alive_safe(m.owner_pid) {
        return true;
    }
    if let Some(secs_since) = epoch_secs_diff(&m.last_heartbeat_at) {
        if secs_since > HEARTBEAT_TIMEOUT_SECS {
            return true;
        }
    }
    false
}

#[cfg(unix)]
fn is_process_alive_safe(pid: u32) -> bool {
    if pid == std::process::id() {
        return true;
    }
    let rc = unsafe { libc::kill(pid as i32, 0) };
    rc == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

#[cfg(not(unix))]
fn is_process_alive_safe(_pid: u32) -> bool {
    // Conservative: assume alive on non-unix; recovery on Windows is Phase 5.
    true
}

/// `manifest.started_at` / `last_heartbeat_at` are written via `now_iso()`
/// in orchestrator.rs as `YYYY-MM-DDTHH:MM:SSZ` (ISO-8601, second precision).
/// We accept both the new format AND the legacy `@<epoch>` format that older
/// manifests on disk may still use, so a recovery sweep across an upgrade
/// boundary doesn't lose runs.
fn epoch_secs_diff(iso: &str) -> Option<u64> {
    let then = iso_to_epoch_secs(iso)?;
    let now = SystemTime::now().duration_since(UNIX_EPOCH).ok()?.as_secs();
    Some(now.saturating_sub(then))
}

/// Parse an ISO-8601 timestamp (`YYYY-MM-DDTHH:MM:SSZ`) to epoch seconds.
/// Also accepts the legacy `@<epoch_seconds>` format for backward compat.
/// Returns None on parse failure (treated as "unknown age" — recovery skips).
fn iso_to_epoch_secs(iso: &str) -> Option<u64> {
    if let Some(legacy) = iso.strip_prefix('@') {
        return legacy.parse().ok();
    }
    // Parse YYYY-MM-DDTHH:MM:SSZ. Handles only the format produced by epoch_to_iso.
    let bytes = iso.as_bytes();
    if bytes.len() != 20 || bytes[10] != b'T' || bytes[19] != b'Z' {
        return None;
    }
    let year: i64 = std::str::from_utf8(&bytes[0..4]).ok()?.parse().ok()?;
    let month: i64 = std::str::from_utf8(&bytes[5..7]).ok()?.parse().ok()?;
    let day: i64 = std::str::from_utf8(&bytes[8..10]).ok()?.parse().ok()?;
    let hour: u64 = std::str::from_utf8(&bytes[11..13]).ok()?.parse().ok()?;
    let min: u64 = std::str::from_utf8(&bytes[14..16]).ok()?.parse().ok()?;
    let sec: u64 = std::str::from_utf8(&bytes[17..19]).ok()?.parse().ok()?;
    if month < 1 || month > 12 || day < 1 || day > 31 {
        return None;
    }
    // days_from_civil — inverse of orchestrator::epoch_to_iso.
    let y = if month <= 2 { year - 1 } else { year };
    let era = if y >= 0 { y / 400 } else { (y - 399) / 400 };
    let yoe = (y - era * 400) as u64;
    let m = if month > 2 {
        (month - 3) as u64
    } else {
        (month + 9) as u64
    };
    let doy = (153 * m + 2) / 5 + (day as u64) - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = (era as i64) * 146_097 + (doe as i64) - 719_468;
    if days < 0 {
        return None;
    }
    let secs = (days as u64) * 86_400 + hour * 3600 + min * 60 + sec;
    Some(secs)
}

fn now_iso() -> String {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    crate::fsd::orchestrator::epoch_to_iso(secs)
}

/// Test-only re-export so cross-module tests can verify ISO-8601 round-trip
/// without making `iso_to_epoch_secs` `pub(crate)` for the whole tree.
#[cfg(test)]
pub(crate) fn iso_to_epoch_secs_for_test(iso: &str) -> Option<u64> {
    iso_to_epoch_secs(iso)
}

fn read_manifest(path: &Path) -> Option<RunManifest> {
    let raw = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&raw).ok()
}

fn write_manifest(path: &Path, m: &RunManifest) {
    if let Ok(json) = serde_json::to_string_pretty(m) {
        let _ = std::fs::write(path, json);
    }
}

/// Apply Phase 1 retention: keep the latest RETAIN_LATEST_N terminal runs OR
/// any terminal run within RETAIN_DAYS, whichever is more permissive. Active
/// manifests are NEVER touched. Returns count of dirs deleted.
fn apply_retention(manifests: &[(std::path::PathBuf, RunManifest)]) -> usize {
    // Filter to terminal manifests (non-active) — only those are eligible.
    let mut terminal: Vec<&(std::path::PathBuf, RunManifest)> = manifests
        .iter()
        .filter(|(_, m)| m.status.is_terminal())
        .collect();

    // Sort by started_at descending (most recent first).
    terminal.sort_by(|a, b| b.1.started_at.cmp(&a.1.started_at));

    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let mut deleted = 0;
    for (i, (path, m)) in terminal.iter().enumerate() {
        let in_count_window = i < RETAIN_LATEST_N;
        // Use the shared parser that accepts both ISO-8601 and the legacy
        // `@<epoch>` format (per migration support in iso_to_epoch_secs).
        let in_age_window = match iso_to_epoch_secs(&m.started_at) {
            Some(then) => now.saturating_sub(then) <= RETAIN_SECS,
            None => true, // unparseable: keep (defensive)
        };

        if in_count_window || in_age_window {
            continue; // keep
        }
        // Delete the run dir entirely.
        if std::fs::remove_dir_all(path).is_ok() {
            deleted += 1;
        }
    }
    deleted
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    /// Per @codex3 task-96 P1: even with per-test-unique leader names, the
    /// previous tests shared `CANVAS_TERMINAL_MEMORY_ROOT` and ran
    /// `recover_runs()` (which scans ALL leaders under that root). A
    /// concurrent scan could read a manifest while another test was writing
    /// or deleting one — surfacing as `EOF while parsing a value`. This
    /// helper builds a fully isolated tempdir per test so `recover_runs_in_root`
    /// only ever sees the manifests this test wrote.
    fn per_test_root(label: &str) -> PathBuf {
        use std::sync::atomic::{AtomicU64, Ordering};
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let n = COUNTER.fetch_add(1, Ordering::SeqCst);
        let root = std::env::temp_dir().join(format!(
            "canvas-terminal-recovery-{}-{}-{}",
            label,
            std::process::id(),
            n
        ));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        root
    }

    fn write_test_manifest(root: &Path, leader: &str, run_id: &str, m: &RunManifest) {
        let path = root.join(format!("fsd-runs/{}/runs/{}/manifest.json", leader, run_id));
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, serde_json::to_string_pretty(m).unwrap()).unwrap();
    }

    #[tokio::test]
    async fn recover_runs_marks_dead_pid_as_interrupted() {
        let root = per_test_root("dead_pid");
        let leader = "test_leader";
        let m = RunManifest {
            run_id: "r-stale".into(),
            leader_handle: leader.into(),
            owner_pid: 999_999, // unlikely to exist
            started_at: now_iso(),
            last_heartbeat_at: now_iso(),
            status: RunStatus::Running,
            session_nonce: "abcdef01".into(),
            run_nonce: "01234567".into(),
        };
        write_test_manifest(&root, leader, "r-stale", &m);

        let report = recover_runs_in_root(&root).await.unwrap();
        assert!(report.interrupted >= 1);

        let updated_raw = std::fs::read_to_string(
            root.join(format!("fsd-runs/{}/runs/r-stale/manifest.json", leader)),
        )
        .unwrap();
        let updated: RunManifest = serde_json::from_str(&updated_raw).unwrap();
        assert_eq!(updated.status, RunStatus::Interrupted);

        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn recover_runs_leaves_alive_runs_alone() {
        let root = per_test_root("alive");
        let leader = "test_leader_alive";
        let m = RunManifest {
            run_id: "r-alive".into(),
            leader_handle: leader.into(),
            owner_pid: std::process::id(), // current process — definitely alive
            started_at: now_iso(),
            last_heartbeat_at: now_iso(), // fresh
            status: RunStatus::Running,
            session_nonce: "abcdef01".into(),
            run_nonce: "01234567".into(),
        };
        write_test_manifest(&root, leader, "r-alive", &m);

        let _ = recover_runs_in_root(&root).await.unwrap();

        let updated_raw = std::fs::read_to_string(
            root.join(format!("fsd-runs/{}/runs/r-alive/manifest.json", leader)),
        )
        .unwrap();
        let updated: RunManifest = serde_json::from_str(&updated_raw).unwrap();
        assert_eq!(
            updated.status,
            RunStatus::Running,
            "alive+fresh-heartbeat run must not be touched"
        );

        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn recover_runs_marks_stale_heartbeat_as_interrupted() {
        // R15: orchestrator-task-wedge while owning process is alive.
        let root = per_test_root("wedged");
        let leader = "test_leader_wedge";
        // Simulate a heartbeat from 90 seconds ago (> HEARTBEAT_TIMEOUT_SECS = 60).
        let old_secs = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs()
            - 90;
        let m = RunManifest {
            run_id: "r-wedged".into(),
            leader_handle: leader.into(),
            owner_pid: std::process::id(), // alive!
            started_at: now_iso(),
            last_heartbeat_at: format!("@{}", old_secs),
            status: RunStatus::Running,
            session_nonce: "abcdef01".into(),
            run_nonce: "01234567".into(),
        };
        write_test_manifest(&root, leader, "r-wedged", &m);

        let report = recover_runs_in_root(&root).await.unwrap();
        assert!(report.interrupted >= 1);

        let updated_raw = std::fs::read_to_string(
            root.join(format!("fsd-runs/{}/runs/r-wedged/manifest.json", leader)),
        )
        .unwrap();
        let updated: RunManifest = serde_json::from_str(&updated_raw).unwrap();
        assert_eq!(
            updated.status,
            RunStatus::Interrupted,
            "stale-heartbeat should be marked interrupted"
        );

        let _ = std::fs::remove_dir_all(&root);
    }
}
