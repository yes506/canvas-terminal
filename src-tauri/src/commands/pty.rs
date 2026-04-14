use crate::state::{AppState, PtySession};
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use std::io::{Read, Write};
use tauri::{AppHandle, Emitter, State};

#[tauri::command]
pub fn spawn_shell(
    app: AppHandle,
    state: State<'_, AppState>,
    session_id: String,
    cols: u16,
    rows: u16,
    cwd: Option<String>,
) -> Result<(), String> {
    let pty_system = native_pty_system();

    let pair = pty_system
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())?;

    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
    // Spawn as login shell (-l) so ~/.zshrc / ~/.zprofile are sourced,
    // giving the user their full PATH (brew, pyenv, nvm, etc.)
    let mut cmd = CommandBuilder::new(&shell);
    cmd.arg("-l");
    // Set working directory if provided (e.g., for duplicate tab)
    // CWD originates from a running process's lsof output, not user input —
    // validate only that it exists and is a directory.
    if let Some(ref dir) = cwd {
        if let Ok(canonical) = std::fs::canonicalize(dir) {
            if canonical.is_dir() {
                cmd.cwd(&canonical);
            }
        }
    }
    cmd.env("TERM", "xterm-256color");
    // Force UTF-8 locale — Tauri GUI apps do NOT inherit shell env on macOS
    cmd.env("LANG", "en_US.UTF-8");
    cmd.env("LC_ALL", "en_US.UTF-8");
    cmd.env("LC_CTYPE", "en_US.UTF-8");
    // Force git/SSH to prompt via terminal, not GUI dialogs (Keychain, ssh-askpass).
    // macOS GUI credential dialogs may hang in Tauri's app context because the
    // dialog is hidden behind the window or fails to spawn entirely.
    cmd.env("GIT_TERMINAL_PROMPT", "1");
    cmd.env("SSH_ASKPASS", "");
    cmd.env("GIT_ASKPASS", "");
    // HOME is needed for the login shell to find ~/.zshrc etc.
    if let Ok(home) = std::env::var("HOME") {
        cmd.env("HOME", &home);
    }
    // Don't pass Tauri's minimal PATH — the login shell will build
    // the correct PATH from ~/.zshrc (brew shellenv, pyenv, nvm, etc.)

    let child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    drop(pair.slave);

    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;

    let event_id = session_id.clone();
    let reader_thread = std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        // Buffer for incomplete UTF-8 sequences split across reads
        let mut pending = Vec::new();
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    pending.extend_from_slice(&buf[..n]);

                    // Decode as much UTF-8 as possible, replacing invalid bytes
                    // with U+FFFD so the reader never gets stuck on non-UTF-8
                    // output (e.g. from git/SSH error messages, binary paths).
                    let mut emit_buf = String::new();
                    let mut pos = 0;

                    while pos < pending.len() {
                        match std::str::from_utf8(&pending[pos..]) {
                            Ok(s) => {
                                emit_buf.push_str(s);
                                pos = pending.len();
                            }
                            Err(e) => {
                                let valid_end = pos + e.valid_up_to();
                                if valid_end > pos {
                                    // Safety: from_utf8 verified this slice
                                    emit_buf.push_str(unsafe {
                                        std::str::from_utf8_unchecked(&pending[pos..valid_end])
                                    });
                                }
                                match e.error_len() {
                                    Some(len) => {
                                        // Definite invalid byte(s) — replace and skip
                                        emit_buf.push('\u{FFFD}');
                                        pos = valid_end + len;
                                    }
                                    None => {
                                        // Incomplete sequence at end — wait for next read
                                        pos = valid_end;
                                        break;
                                    }
                                }
                            }
                        }
                    }

                    if !emit_buf.is_empty() {
                        let _ = app.emit(&format!("pty-data-{}", event_id), emit_buf.as_str());
                    }

                    // Keep only the incomplete trailing bytes for the next read
                    if pos < pending.len() {
                        let remaining = pending[pos..].to_vec();
                        pending.clear();
                        pending = remaining;
                    } else {
                        pending.clear();
                    }
                }
                Err(e) if e.kind() == std::io::ErrorKind::Interrupted => {
                    // EINTR — read was interrupted by a signal (e.g. SIGWINCH from
                    // PTY resize). Just retry the read.
                    continue;
                }
                Err(e) => {
                    // EIO (Linux), EBADF (macOS fd closed), ENOTTY — all expected on PTY close
                    let errno = e.raw_os_error();
                    if matches!(errno, Some(libc::EIO) | Some(libc::EBADF) | Some(libc::ENOTTY)) {
                        break;
                    }
                    eprintln!("PTY read error for {}: {}", event_id, e);
                    break;
                }
            }
        }
        let _ = app.emit(&format!("pty-exit-{}", event_id), ());
    });

    let session = PtySession {
        child,
        writer,
        reader_thread: Some(reader_thread),
        master: pair.master,
    };

    state
        .sessions
        .lock()
        .map_err(|e| e.to_string())?
        .insert(session_id, session);

    Ok(())
}

/// Maximum bytes per PTY write to prevent kernel buffer exhaustion
const MAX_PTY_WRITE: usize = 65536;

#[tauri::command]
pub fn write_to_pty(
    state: State<'_, AppState>,
    session_id: String,
    data: String,
) -> Result<(), String> {
    if data.len() > MAX_PTY_WRITE {
        return Err(format!("Write payload too large: {} bytes", data.len()));
    }

    let mut sessions = state.sessions.lock().map_err(|e| e.to_string())?;
    let session = sessions
        .get_mut(&session_id)
        .ok_or("Session not found")?;

    loop {
        match session.writer.write_all(data.as_bytes()) {
            Ok(()) => break,
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(e) => return Err(e.to_string()),
        }
    }
    session.writer.flush().map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
pub fn resize_pty(
    state: State<'_, AppState>,
    session_id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    if cols == 0 || rows == 0 {
        return Err(format!("Invalid PTY size: {}x{}", cols, rows));
    }

    let sessions = state.sessions.lock().map_err(|e| e.to_string())?;
    let session = sessions.get(&session_id).ok_or("Session not found")?;

    session
        .master
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
pub fn get_pty_cwd(state: State<'_, AppState>, session_id: String) -> Result<String, String> {
    // Extract PID under a minimal lock scope — release before blocking on lsof
    let pid = {
        let sessions = state.sessions.lock().map_err(|e| e.to_string())?;
        let session = sessions.get(&session_id).ok_or("Session not found")?;
        session
            .child
            .process_id()
            .ok_or("Cannot get child PID")?
    };

    // On macOS, use lsof to get the CWD of the child process
    let output = std::process::Command::new("/usr/sbin/lsof")
        .args(["-a", "-p", &pid.to_string(), "-d", "cwd", "-Fn"])
        .output()
        .map_err(|e| format!("Failed to run lsof: {}", e))?;

    if !output.status.success() {
        return Err(format!(
            "lsof failed with exit code: {}",
            output.status.code().unwrap_or(-1)
        ));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    stdout
        .lines()
        .find(|l| l.starts_with('n'))
        .map(|l| l[1..].to_string())
        .ok_or_else(|| "CWD not found in lsof output".to_string())
}

/// Normalise newlines inside the pasted text depending on the target CLI tool.
/// Inside bracketed paste mode the text is treated as literal input by the CLI,
/// so `\n` is the correct multiline separator.  Converting to `\r` would cause
/// tools like Claude Code to interpret each line break as an Enter/submit,
/// triggering premature submission of just the first line.
fn format_for_tool(text: &str, tool: Option<&str>) -> String {
    match tool {
        Some("gemini_cli") => text.replace('\n', "\r"),
        // Claude Code and Codex handle \n natively inside bracketed paste
        _ => text.to_string(),
    }
}

/// Inject text into a PTY session using bracketed paste mode so the CLI
/// tool receives it as pasted input rather than typed keystrokes.
/// An optional `tool` parameter adjusts newline formatting per CLI tool.
#[tauri::command]
pub fn inject_into_pty(
    state: State<'_, AppState>,
    session_id: String,
    text: String,
    tool: Option<String>,
) -> Result<(), String> {
    let mut sessions = state.sessions.lock().map_err(|e| e.to_string())?;
    let session = sessions
        .get_mut(&session_id)
        .ok_or_else(|| format!("PTY session '{}' not found", session_id))?;

    let formatted = format_for_tool(&text, tool.as_deref());

    // Bracketed paste wraps the content so the CLI treats it as pasted text,
    // not individual keystrokes.  The \r (Enter) is sent separately after a
    // short delay so the CLI's event loop has time to process the paste-end
    // marker before seeing the submit signal.
    let paste = format!("\x1b[200~{}\x1b[201~", formatted);
    session
        .writer
        .write_all(paste.as_bytes())
        .map_err(|e| e.to_string())?;
    session.writer.flush().map_err(|e| e.to_string())?;

    // Release the lock before sleeping so other commands are not blocked.
    drop(sessions);

    // Small delay for the CLI event loop to consume the paste-end marker
    // before the Enter keystroke arrives.
    std::thread::sleep(std::time::Duration::from_millis(50));

    // Re-acquire lock and send Enter
    let mut sessions = state.sessions.lock().map_err(|e| e.to_string())?;
    let session = sessions
        .get_mut(&session_id)
        .ok_or_else(|| format!("PTY session '{}' not found after delay", session_id))?;

    session
        .writer
        .write_all(b"\r")
        .map_err(|e| e.to_string())?;
    session.writer.flush().map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
pub fn kill_pty(state: State<'_, AppState>, session_id: String) -> Result<(), String> {
    // Remove session from map and release the lock BEFORE cleanup.
    // This prevents deadlock: join() could block while other commands wait for the lock.
    let session = {
        let mut sessions = state.sessions.lock().map_err(|e| e.to_string())?;
        sessions.remove(&session_id)
    }; // Lock released here

    // PtySession's Drop impl handles cleanup in correct order:
    // kill child → drop writer → join reader thread → drop master
    drop(session);

    Ok(())
}
