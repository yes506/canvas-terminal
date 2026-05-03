// Spike 1 — Darwin flock on `<managed_root>/locks/<agent-id>.lock`
//
// Validates the spec.md §11 spike #1 hypothesis:
//   flock(LOCK_EX | LOCK_NB) on the worktree lockfile is per-process-
//   excluding on Darwin (consistent with V4 Task-44 finding).
//
// Three sub-tests:
//   T1: same-process two-FD exclusion (the falsifier — should FAIL to
//       acquire on the second FD)
//   T2: lock release on drop (acquire → drop → re-acquire on a fresh FD
//       in the same process)
//   T3: cross-process exclusion (parent holds → child fails to acquire)

use fs2::FileExt;
use std::fs::OpenOptions;
use std::path::Path;
use std::process::Command;
use tempfile::TempDir;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    println!("=== Spike 1: Darwin flock on <managed_root>/locks/<id>.lock ===\n");

    // Simulate the managed_root structure per spec §6.1
    let tmp = TempDir::new()?;
    let managed_root = tmp.path();
    let locks_dir = managed_root.join("locks");
    std::fs::create_dir_all(&locks_dir)?;
    let lockfile = locks_dir.join("agent-spike-01.lock");
    std::fs::write(&lockfile, "")?; // touch

    // T3 spawns a child that needs to find the lockfile path → pass via env
    if std::env::var("SPIKE_01_CHILD_LOCKFILE").is_ok() {
        return run_child_lock_attempt();
    }

    let mut all_pass = true;
    all_pass &= t1_same_process_two_fd(&lockfile)?;
    all_pass &= t2_release_on_drop(&lockfile)?;
    all_pass &= t3_cross_process(&lockfile)?;

    println!(
        "\n=== Spike 1 result: {} ===",
        if all_pass { "PASS" } else { "FAIL" }
    );
    std::process::exit(if all_pass { 0 } else { 1 });
}

// --------------------------------------------------------------------------
// T1 — Same-process two-FD exclusion (the falsifier test)
// Hypothesis: per-process exclusion = FD2 in same process FAILS to acquire
// while FD1 holds.
// Falsifier: FD2 SUCCEEDS to acquire while FD1 holds.
// --------------------------------------------------------------------------
fn t1_same_process_two_fd(lockfile: &Path) -> Result<bool, Box<dyn std::error::Error>> {
    println!("T1: same-process two-FD exclusion");

    let fd1 = OpenOptions::new().read(true).write(true).open(lockfile)?;
    let fd2 = OpenOptions::new().read(true).write(true).open(lockfile)?;

    // Acquire on FD1
    let fd1_ok = fd1.try_lock_exclusive().is_ok();
    println!("  FD1 try_lock_exclusive: {}", if fd1_ok { "OK" } else { "FAIL" });
    if !fd1_ok {
        println!("  T1: UNEXPECTED — could not acquire FD1\n");
        return Ok(false);
    }

    // Now FD2 in the SAME process tries to acquire
    let fd2_result = fd2.try_lock_exclusive();
    let fd2_acquired = fd2_result.is_ok();
    println!(
        "  FD2 try_lock_exclusive (with FD1 held): {} {}",
        if fd2_acquired { "OK" } else { "FAIL" },
        match &fd2_result {
            Ok(_) => "→ FALSIFIER TRIPPED (per-FD, not per-process)".to_string(),
            Err(e) => format!("→ {}", e),
        }
    );

    let pass = !fd2_acquired; // hypothesis: FD2 should fail
    println!("  T1: {}\n", if pass { "PASS (per-process exclusion confirmed)" } else { "FAIL (Darwin flock is per-FD, not per-process)" });

    fs2::FileExt::unlock(&fd1)?;
    Ok(pass)
}

// --------------------------------------------------------------------------
// T2 — Lock release on drop
// Hypothesis: dropping the File handle releases the flock; a fresh FD can
// then acquire.
// --------------------------------------------------------------------------
fn t2_release_on_drop(lockfile: &Path) -> Result<bool, Box<dyn std::error::Error>> {
    println!("T2: lock release on drop");

    {
        let fd = OpenOptions::new().read(true).write(true).open(lockfile)?;
        fd.try_lock_exclusive()?;
        println!("  scope-A FD acquired");
        // fd dropped at end of scope → flock should release
    }

    let fresh = OpenOptions::new().read(true).write(true).open(lockfile)?;
    let acquired = fresh.try_lock_exclusive().is_ok();
    println!("  fresh FD after scope drop: {}", if acquired { "OK" } else { "FAIL" });

    let pass = acquired;
    println!("  T2: {}\n", if pass { "PASS" } else { "FAIL (release-on-drop broken)" });

    if acquired {
        fs2::FileExt::unlock(&fresh)?;
    }
    Ok(pass)
}

// --------------------------------------------------------------------------
// T3 — Cross-process exclusion
// Hypothesis: parent holding the lock excludes a child process.
// --------------------------------------------------------------------------
fn t3_cross_process(lockfile: &Path) -> Result<bool, Box<dyn std::error::Error>> {
    println!("T3: cross-process exclusion");

    let parent_fd = OpenOptions::new().read(true).write(true).open(lockfile)?;
    parent_fd.try_lock_exclusive()?;
    println!("  parent acquired lock");

    // spawn ourselves with SPIKE_01_CHILD_LOCKFILE set; child should fail to acquire
    let exe = std::env::current_exe()?;
    let output = Command::new(exe)
        .env("SPIKE_01_CHILD_LOCKFILE", lockfile)
        .output()?;
    let child_exit = output.status.code().unwrap_or(-1);
    let child_stdout = String::from_utf8_lossy(&output.stdout);
    println!("  child exit code: {} (expected non-zero = fail-to-acquire)", child_exit);
    println!("  child stdout: {}", child_stdout.trim());

    let pass = child_exit != 0;
    println!("  T3: {}\n", if pass { "PASS (cross-process exclusion confirmed)" } else { "FAIL (child acquired despite parent holding)" });

    fs2::FileExt::unlock(&parent_fd)?;
    Ok(pass)
}

fn run_child_lock_attempt() -> Result<(), Box<dyn std::error::Error>> {
    let path = std::env::var("SPIKE_01_CHILD_LOCKFILE").unwrap();
    let fd = OpenOptions::new().read(true).write(true).open(&path)?;
    match fd.try_lock_exclusive() {
        Ok(_) => {
            println!("CHILD: ACQUIRED unexpectedly");
            std::process::exit(0); // success = falsifier tripped
        }
        Err(e) => {
            println!("CHILD: failed to acquire (expected) — {}", e);
            std::process::exit(11); // non-zero = correctly excluded
        }
    }
}
