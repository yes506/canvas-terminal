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

    let child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    drop(pair.slave);

    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;

    let event_id = session_id.clone();
    let reader_thread = std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    let data = String::from_utf8_lossy(&buf[..n]).to_string();
                    let _ = app.emit(&format!("pty-data-{}", event_id), data);
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
