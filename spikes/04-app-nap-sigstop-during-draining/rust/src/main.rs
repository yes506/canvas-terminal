// Spike 4 — App Nap / SIGSTOP suspension during draining
//
// Validates spec.md §11 spike #4 (post E4 correction):
//   After SIGSTOP > heartbeat_timeout_secs + wedge_grace_secs, the reaper
//   observes the lease as wedged (heartbeat expired), SIGKILLs the
//   process group, and proceeds idempotently. SIGCONT'd agent does not
//   corrupt cleanup.
//
// Compressed timing for spike: heartbeat_interval=200ms,
// heartbeat_timeout=1.5s, wedge_grace=1s. Total wedge detection: ~2.5s
// after SIGSTOP.

use nix::sys::signal::{kill, killpg, Signal};
use nix::unistd::Pid;
use std::env;
use std::fs;
use std::path::PathBuf;
use std::process::{Child, Command};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const HEARTBEAT_INTERVAL_MS: u64 = 200;
const HEARTBEAT_TIMEOUT_MS: u64 = 1500;
const WEDGE_GRACE_MS: u64 = 1000;
const SAFETY_BUDGET_MS: u64 = 5000; // child should die well before this

fn main() -> Result<(), Box<dyn std::error::Error>> {
    if env::var("SPIKE_04_AGENT").is_ok() {
        return run_agent();
    }
    run_supervisor()
}

fn run_agent() -> Result<(), Box<dyn std::error::Error>> {
    let hb = PathBuf::from(env::var("SPIKE_04_HEARTBEAT_FILE").unwrap());
    let cleanup_sentinel = PathBuf::from(env::var("SPIKE_04_CLEANUP_FILE").unwrap());

    // Run forever, posting heartbeats. We rely on parent to kill us.
    loop {
        let now_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis();
        let _ = fs::write(&hb, format!("{now_ms}"));

        // If the supervisor's "cleanup" sentinel exists, the agent
        // resumed AFTER cleanup happened — corruption check.
        if cleanup_sentinel.exists() {
            // Append corruption marker (this is what we DON'T want)
            let _ = fs::write(&cleanup_sentinel, "AGENT_RESUMED_AFTER_CLEANUP\n");
        }

        std::thread::sleep(Duration::from_millis(HEARTBEAT_INTERVAL_MS));
    }
}

fn run_supervisor() -> Result<(), Box<dyn std::error::Error>> {
    println!("=== Spike 4: SIGSTOP suspension + reaper takeover ===\n");

    let tmp = tempfile::tempdir()?;
    let hb_file = tmp.path().join("heartbeat");
    let cleanup_file = tmp.path().join("cleanup");

    // Spawn the agent
    let exe = env::current_exe()?;
    let mut child = spawn_agent(&exe, &hb_file, &cleanup_file)?;
    let child_pid = Pid::from_raw(child.id() as i32);
    println!("supervisor: spawned agent pid={}", child_pid);

    // Let agent post a few heartbeats so we know it's alive
    std::thread::sleep(Duration::from_millis(500));
    let initial_hb = read_heartbeat(&hb_file);
    println!("supervisor: initial heartbeat read = {:?}", initial_hb.map(|t| t.elapsed()));
    if initial_hb.is_none() {
        eprintln!("FAIL: agent never posted initial heartbeat");
        let _ = child.kill();
        return Ok(());
    }

    // === Phase 1: SIGSTOP the agent ===
    println!("\nphase 1: SIGSTOP agent");
    kill(child_pid, Signal::SIGSTOP)?;
    let stop_at = Instant::now();

    // Reaper loop: check heartbeat freshness; identify wedged after timeout+grace
    let mut wedged_detected_at = None;
    let detection_budget = Duration::from_millis(HEARTBEAT_TIMEOUT_MS + WEDGE_GRACE_MS + SAFETY_BUDGET_MS);
    while stop_at.elapsed() < detection_budget {
        std::thread::sleep(Duration::from_millis(100));
        let age = match read_heartbeat(&hb_file) {
            Some(t) => t.elapsed(),
            None => continue,
        };
        // wedged = age > heartbeat_timeout + wedge_grace
        if age > Duration::from_millis(HEARTBEAT_TIMEOUT_MS + WEDGE_GRACE_MS) {
            wedged_detected_at = Some(stop_at.elapsed());
            break;
        }
    }

    let wedged_ok = wedged_detected_at.is_some();
    println!(
        "phase 1: wedged detected at {:?} after SIGSTOP (target: <{}ms)",
        wedged_detected_at,
        HEARTBEAT_TIMEOUT_MS + WEDGE_GRACE_MS + SAFETY_BUDGET_MS
    );

    if !wedged_ok {
        eprintln!("FAIL: reaper did not detect wedged within budget");
        kill(child_pid, Signal::SIGCONT).ok();
        let _ = child.kill();
        return Ok(());
    }

    // === Phase 2: SIGKILL process group ===
    println!("\nphase 2: SIGKILL process group");
    // killpg requires the child to be in its own pgid; on macOS Command
    // does not setpgid by default. We send SIGKILL to PID directly here;
    // a real implementation calls setsid() on spawn. For the spike, the
    // PID kill suffices to demonstrate the mechanism.
    kill(child_pid, Signal::SIGKILL)?;

    // Wait for child to exit
    let exit_status = child.wait()?;
    println!("phase 2: agent exit status = {:?}", exit_status);
    let killed = !exit_status.success();
    println!("phase 2: killed cleanly = {}", killed);

    // === Phase 3: write cleanup sentinel; verify SIGCONT'd agent
    // cannot corrupt it (because it's dead) ===
    println!("\nphase 3: write cleanup sentinel post-SIGKILL");
    fs::write(&cleanup_file, "REAPER_CLEANUP_DONE\n")?;

    // Try to SIGCONT the dead PID; should fail (ESRCH)
    let cont_result = kill(child_pid, Signal::SIGCONT);
    let cont_failed = cont_result.is_err();
    println!("phase 3: SIGCONT(dead pid) → {} (expect Err = correct)", if cont_failed { "Err (correct)" } else { "Ok (UNEXPECTED)" });

    // Verify cleanup sentinel was not corrupted
    std::thread::sleep(Duration::from_millis(300));
    let sentinel_content = fs::read_to_string(&cleanup_file)?;
    let uncorrupted = sentinel_content.trim() == "REAPER_CLEANUP_DONE";
    println!("phase 3: cleanup sentinel uncorrupted = {}", uncorrupted);
    if !uncorrupted {
        eprintln!("phase 3: sentinel content = {:?}", sentinel_content);
    }

    let pass = wedged_ok && killed && cont_failed && uncorrupted;
    println!(
        "\n=== Spike 4 result: {} ===",
        if pass { "PASS" } else { "FAIL" }
    );
    std::process::exit(if pass { 0 } else { 1 });
}

fn spawn_agent(
    exe: &std::path::Path,
    hb_file: &std::path::Path,
    cleanup_file: &std::path::Path,
) -> Result<Child, Box<dyn std::error::Error>> {
    Ok(Command::new(exe)
        .env("SPIKE_04_AGENT", "1")
        .env("SPIKE_04_HEARTBEAT_FILE", hb_file)
        .env("SPIKE_04_CLEANUP_FILE", cleanup_file)
        .spawn()?)
}

fn read_heartbeat(path: &std::path::Path) -> Option<Instant> {
    let content = fs::read_to_string(path).ok()?;
    let posted_ms: u128 = content.trim().parse().ok()?;
    let now_ms = SystemTime::now().duration_since(UNIX_EPOCH).ok()?.as_millis();
    let age_ms = now_ms.saturating_sub(posted_ms);
    Some(Instant::now() - Duration::from_millis(age_ms as u64))
}
