use crate::state::{AppState, PtySession};
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::thread::JoinHandle;
use tauri::{AppHandle, Emitter, State};

/// Shared reader-thread setup for PTY sessions (used by both spawn_shell and spawn_process).
/// Reads PTY output, handles UTF-8 decoding, and emits events to the frontend.
fn start_reader_thread(
    app: AppHandle,
    session_id: String,
    mut reader: Box<dyn Read + Send>,
) -> JoinHandle<()> {
    let event_id = session_id;
    std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        let mut pending = Vec::new();
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    pending.extend_from_slice(&buf[..n]);
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
                                    emit_buf.push_str(unsafe {
                                        std::str::from_utf8_unchecked(&pending[pos..valid_end])
                                    });
                                }
                                match e.error_len() {
                                    Some(len) => {
                                        emit_buf.push('\u{FFFD}');
                                        pos = valid_end + len;
                                    }
                                    None => {
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
                    if pos < pending.len() {
                        let remaining = pending[pos..].to_vec();
                        pending.clear();
                        pending = remaining;
                    } else {
                        pending.clear();
                    }
                }
                Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(e) => {
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
    })
}

/// Apply baseline env vars to a CommandBuilder — shared by spawn_shell and spawn_process.
fn apply_baseline_env(cmd: &mut CommandBuilder) {
    cmd.env("TERM", "xterm-256color");
    cmd.env("LANG", "en_US.UTF-8");
    cmd.env("LC_ALL", "en_US.UTF-8");
    cmd.env("LC_CTYPE", "en_US.UTF-8");
    cmd.env("GIT_TERMINAL_PROMPT", "1");
    cmd.env("SSH_ASKPASS", "");
    cmd.env("GIT_ASKPASS", "");
    if let Ok(home) = std::env::var("HOME") {
        cmd.env("HOME", &home);
    }
}

/// Env vars that are explicitly set by apply_baseline_env — don't override these from cache.
const BASELINE_ENV_KEYS: &[&str] = &[
    "TERM", "LANG", "LC_ALL", "LC_CTYPE",
    "GIT_TERMINAL_PROMPT", "SSH_ASKPASS", "GIT_ASKPASS", "HOME",
];

/// Apply CWD to a CommandBuilder if valid.
fn apply_cwd(cmd: &mut CommandBuilder, cwd: &Option<String>) {
    if let Some(ref dir) = cwd {
        if let Ok(canonical) = std::fs::canonicalize(dir) {
            if canonical.is_dir() {
                cmd.cwd(&canonical);
            }
        }
    }
}

/// Inject cached environment into a CommandBuilder, skipping baseline keys.
fn inject_cached_env(cmd: &mut CommandBuilder, state: &State<'_, AppState>) {
    if let Ok(cached) = state.cached_env.lock() {
        if let Some(ref env_map) = *cached {
            for (key, val) in env_map {
                if !BASELINE_ENV_KEYS.contains(&key.as_str()) {
                    cmd.env(key, val);
                }
            }
        }
    }
}

/// Run the user's login shell once, capture the resulting environment, and
/// cache it in AppState. All subsequent PTYs can use this cached env instead
/// of running a login shell every time.
///
/// Uses `env -0` (NUL-separated) for robust parsing — env values can contain
/// newlines, so newline-delimited output is unreliable.
#[tauri::command]
pub fn bootstrap_env(
    state: State<'_, AppState>,
    force: Option<bool>,
) -> Result<(), String> {
    // Already cached? Skip (unless force=true).
    if !force.unwrap_or(false) {
        let cached = state.cached_env.lock().map_err(|e| e.to_string())?;
        if cached.is_some() {
            return Ok(());
        }
    }

    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());

    // Run: $SHELL -lc 'env -0'
    // -l = login shell (sources full profile chain)
    // -c = execute command then exit
    // env -0 = print environment with NUL separators
    let output = std::process::Command::new(&shell)
        .args(["-lc", "env -0"])
        .output()
        .map_err(|e| format!("Failed to bootstrap env: {}", e))?;

    if !output.status.success() {
        return Err(format!(
            "bootstrap_env: shell exited with {}",
            output.status.code().unwrap_or(-1)
        ));
    }

    let raw = output.stdout;
    let mut env_map = HashMap::new();

    // Parse NUL-separated KEY=VALUE pairs
    for entry in raw.split(|&b| b == 0) {
        if entry.is_empty() {
            continue;
        }
        let s = String::from_utf8_lossy(entry);
        if let Some(eq_pos) = s.find('=') {
            let key = &s[..eq_pos];
            let val = &s[eq_pos + 1..];
            env_map.insert(key.to_string(), val.to_string());
        }
    }

    // Ensure critical vars are present
    if !env_map.contains_key("PATH") {
        return Err("bootstrap_env: PATH not found in captured environment".to_string());
    }

    let mut cached = state.cached_env.lock().map_err(|e| e.to_string())?;
    *cached = Some(env_map);

    Ok(())
}

/// Resolve a program name to an absolute path using the cached env's PATH.
/// If already absolute, validates it exists. If bare name, searches PATH.
fn resolve_program(program: &str, state: &State<'_, AppState>) -> Result<String, String> {
    let path = std::path::Path::new(program);

    // Already absolute?
    if path.is_absolute() {
        if path.exists() {
            return Ok(program.to_string());
        }
        return Err(format!("Program not found: {}", program));
    }

    // Search in cached PATH
    let cached = state.cached_env.lock().map_err(|e| e.to_string())?;
    let path_var = cached
        .as_ref()
        .and_then(|m| m.get("PATH"))
        .cloned()
        .or_else(|| std::env::var("PATH").ok())
        .unwrap_or_default();

    for dir in path_var.split(':') {
        let candidate = std::path::PathBuf::from(dir).join(program);
        if candidate.exists() {
            return Ok(candidate.to_string_lossy().to_string());
        }
    }

    Err(format!(
        "Program '{}' not found in PATH. Ensure it is installed and accessible.",
        program
    ))
}

/// Spawn a process directly in a PTY — no intermediate shell.
/// Used by collaborator agents to run CLI tools (claude, codex, gemini)
/// without shell startup overhead.
#[tauri::command]
pub fn spawn_process(
    app: AppHandle,
    state: State<'_, AppState>,
    session_id: String,
    program: String,
    args: Option<Vec<String>>,
    extra_env: Option<HashMap<String, String>>,
    cwd: Option<String>,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let pty_system = native_pty_system();

    let pair = pty_system
        .openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| e.to_string())?;

    let resolved_program = resolve_program(&program, &state)?;
    let mut cmd = CommandBuilder::new(&resolved_program);

    if let Some(ref arg_list) = args {
        for arg in arg_list {
            cmd.arg(arg);
        }
    }

    apply_cwd(&mut cmd, &cwd);
    inject_cached_env(&mut cmd, &state);
    apply_baseline_env(&mut cmd);

    // Merge extra env vars (overrides)
    if let Some(ref extras) = extra_env {
        for (key, val) in extras {
            cmd.env(key, val);
        }
    }

    let child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    drop(pair.slave);

    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
    let reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;

    let reader_thread = start_reader_thread(app, session_id.clone(), reader);

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
pub fn spawn_shell(
    app: AppHandle,
    state: State<'_, AppState>,
    session_id: String,
    cols: u16,
    rows: u16,
    cwd: Option<String>,
    login: Option<bool>,
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
    let use_login = login.unwrap_or(false);

    let mut cmd = CommandBuilder::new(&shell);

    if use_login {
        // Full login shell — sources ~/.zprofile, ~/.zshrc, etc.
        cmd.arg("-l");
    } else {
        // Fast path: interactive shell with cached environment injected
        cmd.arg("-i");
        inject_cached_env(&mut cmd, &state);
    }

    apply_cwd(&mut cmd, &cwd);
    apply_baseline_env(&mut cmd);

    let child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    drop(pair.slave);

    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
    let reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;

    let reader_thread = start_reader_thread(app, session_id.clone(), reader);

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

/// List directory entries for file/directory autocomplete.
/// Expands `~` to the home directory. Returns a sorted list of
/// `[name, is_dir, full_path]` triples.
#[tauri::command]
pub fn list_directory(path: String) -> Result<Vec<(String, bool, String)>, String> {
    let expanded = if path.starts_with('~') {
        let home = dirs::home_dir().ok_or("Cannot resolve home directory")?;
        home.join(path.strip_prefix("~/").unwrap_or(""))
    } else {
        std::path::PathBuf::from(&path)
    };

    let dir = if expanded.is_dir() {
        expanded
    } else {
        expanded.parent().unwrap_or(&expanded).to_path_buf()
    };

    let entries = std::fs::read_dir(&dir).map_err(|e| format!("{}: {}", dir.display(), e))?;

    let mut result: Vec<(String, bool, String)> = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        // Skip hidden files unless the query specifically starts with '.'
        let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
        let full_path = entry.path().to_string_lossy().to_string();
        result.push((name, is_dir, full_path));
    }
    result.sort_by(|a, b| {
        // Directories first, then alphabetical
        b.1.cmp(&a.1).then_with(|| a.0.to_lowercase().cmp(&b.0.to_lowercase()))
    });

    Ok(result)
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
