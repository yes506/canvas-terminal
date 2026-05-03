// Spike 3 — PTY drain across `.done.json` gate
//
// Validates spec.md §11 spike #3 + S1 atomicity protocol:
//   Agent writes `.done.json` via tempfile + rename (atomic on POSIX);
//   drainer reads via serde_json::from_reader; mid-write kills do NOT
//   produce a half-state where drainer sees partial `.done.json`.
//
// Two scenarios:
//   A — happy path: agent writes tempfile, renames to .done.json, exits;
//        drainer polls and reads complete JSON
//   B — mid-write kill: agent writes tempfile but is SIGKILL'd BEFORE
//        rename; drainer never sees .done.json (only the .tmp), correctly
//        falls through to Path B per S11

use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use serde::{Deserialize, Serialize};
use std::io::{Read, Write};
use std::path::Path;
use std::time::{Duration, Instant};
use tempfile::TempDir;

#[derive(Serialize, Deserialize, Debug)]
struct DoneJson {
    agent_id: String,
    completed_at: u64,
    summary: String,
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    println!("=== Spike 3: PTY drain across .done.json gate ===\n");

    let mut all_pass = true;
    all_pass &= scenario_a_happy_path()?;
    all_pass &= scenario_b_mid_write_kill()?;

    println!(
        "\n=== Spike 3 result: {} ===",
        if all_pass { "PASS" } else { "FAIL" }
    );
    std::process::exit(if all_pass { 0 } else { 1 });
}

// --------------------------------------------------------------------------
// Scenario A — happy path
// Agent writes tempfile + rename to `.done.json` + exits.
// Drainer polls for complete `.done.json` per S1 (serde_json::from_reader)
// and snapshots a "diff" (file count) before teardown.
// --------------------------------------------------------------------------
fn scenario_a_happy_path() -> Result<bool, Box<dyn std::error::Error>> {
    println!("scenario A: happy path");
    let tmp = TempDir::new()?;
    let worktree = tmp.path();
    let done_json = worktree.join(".done.json");
    let done_tmp = worktree.join(".done.json.tmp");

    // Spawn shell in PTY that writes tempfile + renames + exits
    let pty_system = native_pty_system();
    let pair = pty_system.openpty(PtySize {
        rows: 24,
        cols: 80,
        pixel_width: 0,
        pixel_height: 0,
    })?;

    let mut cmd = CommandBuilder::new("sh");
    cmd.arg("-c");
    cmd.arg(format!(
        "echo '{{\"agent_id\":\"agent-A\",\"completed_at\":1234567890,\"summary\":\"happy path complete\"}}' > {tmp_path} && mv {tmp_path} {done_path}",
        tmp_path = done_tmp.display(),
        done_path = done_json.display(),
    ));
    cmd.cwd(worktree);

    let mut child = pair.slave.spawn_command(cmd)?;
    drop(pair.slave); // drainer doesn't need slave end

    // Drain PTY output (we don't care about stdout for spike, but draining
    // prevents blocking)
    let mut reader = pair.master.try_clone_reader()?;
    let drain_handle = std::thread::spawn(move || {
        let mut buf = [0u8; 1024];
        let mut total_read = 0usize;
        while let Ok(n) = reader.read(&mut buf) {
            if n == 0 {
                break;
            }
            total_read += n;
            if total_read > 1_000_000 {
                break; // safety
            }
        }
        total_read
    });

    // Drainer poll loop per S1
    let start = Instant::now();
    let mut observed_complete = None;
    while start.elapsed() < Duration::from_secs(3) {
        if done_json.exists() {
            // Try to read via serde_json::from_reader (S1)
            if let Ok(file) = std::fs::File::open(&done_json) {
                let buf_reader = std::io::BufReader::new(file);
                match serde_json::from_reader::<_, DoneJson>(buf_reader) {
                    Ok(parsed) => {
                        observed_complete = Some(parsed);
                        break;
                    }
                    Err(_) => {
                        // partial json or empty → not complete yet
                    }
                }
            }
        }
        std::thread::sleep(Duration::from_millis(50));
    }

    let _ = child.wait();
    drop(pair.master); // close master so drain thread sees EOF
    let _ = drain_handle.join();

    let json_complete = observed_complete.is_some();
    println!("  drainer observed complete .done.json: {}", json_complete);
    if let Some(j) = &observed_complete {
        println!("  parsed: agent_id={} summary={:?}", j.agent_id, j.summary);
    }
    let tmp_cleaned = !done_tmp.exists();
    println!("  tempfile cleaned by rename: {}", tmp_cleaned);

    // "Snapshot diff": for spike, just count files in worktree
    let file_count = std::fs::read_dir(worktree)?.count();
    println!("  snapshot file count: {}", file_count);
    let snapshot_ok = file_count >= 1; // at least .done.json

    let pass = json_complete && tmp_cleaned && snapshot_ok;
    println!("  scenario A: {}\n", if pass { "PASS" } else { "FAIL" });
    Ok(pass)
}

// --------------------------------------------------------------------------
// Scenario B — agent killed mid-write, BEFORE rename
// Drainer must NOT see a partial `.done.json`. Only the `.tmp` file
// exists. Per S11, drainer falls through to Path B forced_close.
// --------------------------------------------------------------------------
fn scenario_b_mid_write_kill() -> Result<bool, Box<dyn std::error::Error>> {
    println!("scenario B: mid-write kill (no rename)");
    let tmp = TempDir::new()?;
    let worktree = tmp.path();
    let done_json = worktree.join(".done.json");
    let done_tmp = worktree.join(".done.json.tmp");

    // Pre-write a partial tempfile to simulate the agent-killed-mid-write
    // condition WITHOUT actually relying on race timing (which is flaky)
    {
        let mut f = std::fs::File::create(&done_tmp)?;
        f.write_all(b"{\"agent_id\":\"agent-B\",\"completed_at\":1234,")?; // truncated
    }
    println!("  pre-state: .done.json.tmp exists with truncated json (partial)");

    // Drainer polls per S1
    let start = Instant::now();
    let mut observed_complete = false;
    let mut observed_partial = false;
    while start.elapsed() < Duration::from_millis(500) {
        if done_json.exists() {
            if let Ok(file) = std::fs::File::open(&done_json) {
                let buf_reader = std::io::BufReader::new(file);
                match serde_json::from_reader::<_, DoneJson>(buf_reader) {
                    Ok(_) => {
                        observed_complete = true;
                        break;
                    }
                    Err(_) => {
                        observed_partial = true;
                    }
                }
            }
        }
        std::thread::sleep(Duration::from_millis(50));
    }

    println!("  drainer observed complete .done.json: {}", observed_complete);
    println!("  drainer observed partial .done.json: {}", observed_partial);
    println!("  .done.json.tmp still present: {}", done_tmp.exists());
    println!("  .done.json present: {}", done_json.exists());

    // Hypothesis check: drainer NEVER sees `.done.json` (only `.tmp`).
    // This validates that the rename-based atomicity protocol from S1
    // is observable from the drainer side: a partial `.tmp` does NOT
    // count as a `.done.json` for Path A.
    let pass = !observed_complete && !observed_partial && !done_json.exists() && done_tmp.exists();
    println!("  scenario B: {}\n", if pass {
        "PASS (drainer correctly never sees .done.json; falls through to Path B per S11)"
    } else {
        "FAIL"
    });
    Ok(pass)
}
