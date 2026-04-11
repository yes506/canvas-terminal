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
    let mut cmd = CommandBuilder::new(&shell);
    cmd.env("TERM", "xterm-256color");
    // Force UTF-8 locale — Tauri GUI apps do NOT inherit shell env on macOS
    cmd.env("LANG", "en_US.UTF-8");
    cmd.env("LC_ALL", "en_US.UTF-8");
    cmd.env("LC_CTYPE", "en_US.UTF-8");
    // Inherit HOME and PATH from the system
    if let Ok(home) = std::env::var("HOME") {
        cmd.env("HOME", &home);
    }
    if let Ok(path) = std::env::var("PATH") {
        cmd.env("PATH", &path);
    }

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

                    // Find the last valid UTF-8 boundary in pending
                    let valid_up_to = match std::str::from_utf8(&pending) {
                        Ok(_) => pending.len(),
                        Err(e) => e.valid_up_to(),
                    };

                    if valid_up_to > 0 {
                        // Safety: we just verified this slice is valid UTF-8
                        let data = unsafe {
                            std::str::from_utf8_unchecked(&pending[..valid_up_to])
                        };
                        let _ = app.emit(&format!("pty-data-{}", event_id), data);
                    }

                    // Keep only the incomplete trailing bytes for the next read
                    if valid_up_to < pending.len() {
                        let remaining = pending[valid_up_to..].to_vec();
                        pending.clear();
                        pending = remaining;
                    } else {
                        pending.clear();
                    }
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

#[tauri::command]
pub fn write_to_pty(
    state: State<'_, AppState>,
    session_id: String,
    data: String,
) -> Result<(), String> {
    let mut sessions = state.sessions.lock().map_err(|e| e.to_string())?;
    let session = sessions
        .get_mut(&session_id)
        .ok_or("Session not found")?;

    session
        .writer
        .write_all(data.as_bytes())
        .map_err(|e| e.to_string())?;
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
