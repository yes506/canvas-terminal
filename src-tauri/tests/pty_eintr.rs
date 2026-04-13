/// Integration tests for PTY EINTR resilience.
///
/// These tests exercise the exact same portable-pty read/write path
/// used by the app, verifying that SIGWINCH (PTY resize) during
/// active I/O does not kill the reader thread or corrupt data.
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// Mirrors the reader loop from commands/pty.rs — tests the EINTR handling.
fn reader_loop(mut reader: Box<dyn Read + Send>, collected: Arc<Mutex<String>>) {
    let mut buf = [0u8; 4096];
    let mut pending = Vec::new();
    loop {
        match reader.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                pending.extend_from_slice(&buf[..n]);
                let valid_up_to = match std::str::from_utf8(&pending) {
                    Ok(_) => pending.len(),
                    Err(e) => e.valid_up_to(),
                };
                if valid_up_to > 0 {
                    let data =
                        unsafe { std::str::from_utf8_unchecked(&pending[..valid_up_to]) };
                    collected.lock().unwrap().push_str(data);
                }
                if valid_up_to < pending.len() {
                    let remaining = pending[valid_up_to..].to_vec();
                    pending.clear();
                    pending = remaining;
                } else {
                    pending.clear();
                }
            }
            // *** THE FIX UNDER TEST ***
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => {
                continue;
            }
            Err(e) => {
                let errno = e.raw_os_error();
                if matches!(
                    errno,
                    Some(libc::EIO) | Some(libc::EBADF) | Some(libc::ENOTTY)
                ) {
                    break;
                }
                eprintln!("reader error: {}", e);
                break;
            }
        }
    }
}

/// Mirrors the write_to_pty EINTR retry loop from commands/pty.rs.
fn write_with_eintr_retry(writer: &mut Box<dyn Write + Send>, data: &[u8]) -> std::io::Result<()> {
    loop {
        match writer.write_all(data) {
            Ok(()) => return Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(e) => return Err(e),
        }
    }
}

/// Helper: open a PTY, spawn `echo` via shell, return (master, child).
fn open_pty_with_command(
    cmd_str: &str,
) -> (
    Box<dyn portable_pty::MasterPty + Send>,
    Box<dyn portable_pty::Child + Send + Sync>,
) {
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows: 24,
            cols: 80,
            pixel_width: 0,
            pixel_height: 0,
        })
        .expect("openpty");

    let mut cmd = CommandBuilder::new("/bin/sh");
    cmd.arg("-c");
    cmd.arg(cmd_str);
    let child = pair.slave.spawn_command(cmd).expect("spawn");
    drop(pair.slave);
    (pair.master, child)
}

// ─────────────────────────────────────────────────────────
//  Test 1: reader survives rapid SIGWINCH during output
// ─────────────────────────────────────────────────────────
#[test]
fn reader_survives_sigwinch_during_output() {
    // Spawn a shell command that produces output over ~2 seconds
    let (master, _child) = open_pty_with_command(
        "for i in $(seq 1 50); do echo \"line-$i\"; sleep 0.03; done; echo DONE_MARKER",
    );
    let reader = master.try_clone_reader().expect("clone reader");
    let collected = Arc::new(Mutex::new(String::new()));
    let collected_clone = collected.clone();

    // Start reader thread (mirrors app's reader loop)
    let reader_handle = std::thread::spawn(move || {
        reader_loop(reader, collected_clone);
    });

    // Bombard with resize events while output is flowing.
    // Each resize sends SIGWINCH to the child process group,
    // which can cause EINTR on the reader's read() syscall.
    for i in 0..30 {
        let cols = if i % 2 == 0 { 80 } else { 120 };
        let _ = master.resize(PtySize {
            rows: 24,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        });
        std::thread::sleep(Duration::from_millis(50));
    }

    // Wait for reader to finish (child exits after "DONE_MARKER")
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        if reader_handle.is_finished() {
            break;
        }
        if Instant::now() > deadline {
            panic!("Reader thread did not finish within 10s — likely stuck or dead");
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    reader_handle.join().expect("reader thread panicked");

    let output = collected.lock().unwrap();
    assert!(
        output.contains("DONE_MARKER"),
        "Reader missed the final output. Got {} bytes: ...{}",
        output.len(),
        &output[output.len().saturating_sub(200)..],
    );
    // Verify some of the numbered lines survived
    assert!(
        output.contains("line-1"),
        "Reader missed early output"
    );
    assert!(
        output.contains("line-50"),
        "Reader missed late output"
    );
}

// ─────────────────────────────────────────────────────────
//  Test 2: write_to_pty retry loop works under signal pressure
// ─────────────────────────────────────────────────────────
#[test]
fn write_survives_sigwinch() {
    let (master, _child) = open_pty_with_command("cat > /dev/null");
    let mut writer = master.take_writer().expect("take writer");

    // Send rapid resizes while writing
    let master_for_resize = master;
    let resize_handle = std::thread::spawn(move || {
        for i in 0..20 {
            let cols = if i % 2 == 0 { 80 } else { 100 };
            let _ = master_for_resize.resize(PtySize {
                rows: 24,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            });
            std::thread::sleep(Duration::from_millis(10));
        }
    });

    // Write data concurrently with resizes
    for i in 0..50 {
        let data = format!("write-chunk-{}\n", i);
        write_with_eintr_retry(&mut writer, data.as_bytes())
            .expect("write should succeed despite SIGWINCH");
    }

    resize_handle.join().expect("resize thread");
}

// ─────────────────────────────────────────────────────────
//  Test 3: reader completes cleanly when child exits normally
//          (no signal interference — baseline correctness)
// ─────────────────────────────────────────────────────────
#[test]
fn reader_completes_on_normal_exit() {
    let (master, _child) =
        open_pty_with_command("echo hello_from_pty; echo goodbye_from_pty");
    let reader = master.try_clone_reader().expect("clone reader");
    let collected = Arc::new(Mutex::new(String::new()));
    let collected_clone = collected.clone();

    let reader_handle = std::thread::spawn(move || {
        reader_loop(reader, collected_clone);
    });

    // No resizes — just wait for clean exit
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        if reader_handle.is_finished() {
            break;
        }
        if Instant::now() > deadline {
            panic!("Reader thread did not finish within 5s");
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    reader_handle.join().expect("reader thread panicked");

    let output = collected.lock().unwrap();
    assert!(output.contains("hello_from_pty"), "Missing hello output");
    assert!(
        output.contains("goodbye_from_pty"),
        "Missing goodbye output"
    );
}

// ─────────────────────────────────────────────────────────
//  Test 4: reader exits properly on child kill (EBADF/EIO)
// ─────────────────────────────────────────────────────────
#[test]
fn reader_exits_on_child_kill() {
    let (master, mut child) = open_pty_with_command("sleep 60");
    let reader = master.try_clone_reader().expect("clone reader");
    let collected = Arc::new(Mutex::new(String::new()));
    let collected_clone = collected.clone();

    let reader_handle = std::thread::spawn(move || {
        reader_loop(reader, collected_clone);
    });

    // Let it start, then kill
    std::thread::sleep(Duration::from_millis(200));
    child.kill().expect("kill child");
    drop(child);

    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        if reader_handle.is_finished() {
            break;
        }
        if Instant::now() > deadline {
            panic!("Reader thread did not exit after child kill within 5s");
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    reader_handle.join().expect("reader thread panicked");
    // If we get here, the reader exited cleanly — test passes
}
