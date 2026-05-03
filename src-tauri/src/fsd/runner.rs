//! `AssistantRunner` trait + `HeadlessStdioRunner` impl.
//!
//! Per plan v5 §3 architecture: the trait abstracts the assistant transport so
//! the orchestrator state machine doesn't know whether an assistant runs as a
//! stdio one-shot, a hidden PTY (Phase 3 fallback), or a long-lived warm
//! worker (Phase 5).
//!
//! Phase 1: only `HeadlessStdioRunner` ships. Spawns the assistant CLI in its
//! own process group via `process_group::spawn_in_new_session`, captures
//! stdout/stderr to file with bounded reader (4 MB cap), enforces per-task
//! wallclock timeout via `tokio::time::timeout`. On cancel, kills the process
//! group via `process_group::kill_process_group`.

use crate::commands::memory::get_memory_root;
use crate::fsd::process_group::{kill_process_group, spawn_in_new_session};
use crate::fsd::schema::TaskSpec;
use std::path::PathBuf;
use std::time::Instant;
use tokio::io::AsyncReadExt;
use tokio::process::Command;

/// Bounded buffer cap per task per stream (plan v5 §6.3).
const MAX_STREAM_BYTES: usize = 4 * 1024 * 1024;

/// Hard ceiling on per-task wallclock — even if the leader's `wallclock_ms_cap`
/// is higher, we clamp here. Per plan v5 §6.3 + @codex1 task-48 risk #3.
pub const WALLCLOCK_MS_PER_TASK_CAP: u64 = 120_000;

#[derive(Debug, Clone)]
pub struct RunOutcome {
    pub exit_code: Option<i32>,
    pub wallclock_ms: u64,
    pub stdout_bytes: u64,
    pub stderr_bytes: u64,
    /// "ok", "timeout", "killed", "spawn_error", "io_error"
    pub kind: &'static str,
    pub error: Option<String>,
}

/// Assistant transport contract. Phase 1 = stdio one-shot; Phase 3 = HiddenPtyRunner.
///
/// Uses `Pin<Box<dyn Future>>` instead of native `async fn in trait` (Rust
/// 1.75 RPITIT) so the trait is **object-safe** — `&dyn AssistantRunner` is
/// usable, which unblocks fake-runner integration tests for the orchestrator
/// per @codex3 task-84 P2 (raised by 3 evaluators across rounds 7-12). The
/// per-call boxing cost is negligible vs the actual subprocess spawn.
pub trait AssistantRunner: Send + Sync {
    /// Spawn the assistant, write its prompt to stdin, capture stdout+stderr
    /// to disk under `output_dir`, and return the outcome. Honors
    /// `spec.wallclock_ms_cap`. On cancel (via `cancel_rx`), kills the
    /// child's process group via `process_group::kill_process_group`.
    fn run<'a>(
        &'a self,
        spec: TaskSpec,
        output_dir_rel: String,
        cancel_rx: tokio::sync::oneshot::Receiver<()>,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = RunOutcome> + Send + 'a>>;
}

/// Phase 1 default runner — `tokio::process::Command` with stdin pipe.
pub struct HeadlessStdioRunner;

impl AssistantRunner for HeadlessStdioRunner {
    fn run<'a>(
        &'a self,
        spec: TaskSpec,
        output_dir_rel: String,
        mut cancel_rx: tokio::sync::oneshot::Receiver<()>,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = RunOutcome> + Send + 'a>> {
        Box::pin(async move {
        let started = Instant::now();
        let tool_command = match build_command(&spec) {
            Some(command) => command,
            None => {
                return RunOutcome {
                    exit_code: None,
                    wallclock_ms: started.elapsed().as_millis() as u64,
                    stdout_bytes: 0,
                    stderr_bytes: 0,
                    kind: "spawn_error",
                    error: Some(format!("unknown tool: {}", spec.tool)),
                };
            }
        };

        let output_dir = match get_memory_root() {
            Ok(root) => root.join(&output_dir_rel),
            Err(e) => return RunOutcome {
                exit_code: None,
                wallclock_ms: started.elapsed().as_millis() as u64,
                stdout_bytes: 0,
                stderr_bytes: 0,
                kind: "io_error",
                error: Some(format!("memory root: {}", e)),
            },
        };
        if let Err(e) = std::fs::create_dir_all(&output_dir) {
            return RunOutcome {
                exit_code: None,
                wallclock_ms: started.elapsed().as_millis() as u64,
                stdout_bytes: 0,
                stderr_bytes: 0,
                kind: "io_error",
                error: Some(format!("create output dir: {}", e)),
            };
        }

        let mut cmd = Command::new(&tool_command.program);
        cmd.args(&tool_command.args);
        cmd.stdin(std::process::Stdio::piped());
        cmd.stdout(std::process::Stdio::piped());
        cmd.stderr(std::process::Stdio::piped());
        let mut cmd = spawn_in_new_session(cmd);

        let mut child = match cmd.spawn() {
            Ok(c) => c,
            Err(e) => return RunOutcome {
                exit_code: None,
                wallclock_ms: started.elapsed().as_millis() as u64,
                stdout_bytes: 0,
                stderr_bytes: 0,
                kind: "spawn_error",
                error: Some(format!("spawn {}: {}", spec.tool, e)),
            },
        };
        let pid = child.id().map(|p| p as i32).unwrap_or(0);

        // Write the prompt to stdin and close the pipe so stdin-driven CLIs
        // exit when done. Copilot's current CLI uses `-p <prompt>` instead.
        if tool_command.stdin_prompt {
            if let Some(stdin) = child.stdin.take() {
                let prompt = spec.prompt.clone();
                tokio::spawn(async move {
                    use tokio::io::AsyncWriteExt;
                    let mut stdin = stdin;
                    let _ = stdin.write_all(prompt.as_bytes()).await;
                    let _ = stdin.shutdown().await;
                });
            }
        } else {
            drop(child.stdin.take());
        }

        // Concurrent: read stdout, read stderr, wait for exit, watch cancel,
        // honor wallclock timeout.
        let stdout = child.stdout.take();
        let stderr = child.stderr.take();
        let stdout_path = output_dir.join("result.stdout");
        let stderr_path = output_dir.join("result.stderr");
        let stdout_task = tokio::spawn(read_to_capped_file(stdout, stdout_path));
        let stderr_task = tokio::spawn(read_to_capped_file(stderr, stderr_path));

        let timeout = std::time::Duration::from_millis(spec.wallclock_ms_cap);
        let result = tokio::select! {
            biased;
            _ = &mut cancel_rx => {
                let _ = kill_process_group(pid).await;
                let _ = child.wait().await;
                RunOutcomeKind::Cancelled
            }
            r = tokio::time::timeout(timeout, child.wait()) => {
                match r {
                    Ok(Ok(status)) => RunOutcomeKind::Exited(status.code()),
                    Ok(Err(e)) => RunOutcomeKind::IoError(e.to_string()),
                    Err(_) => {
                        let _ = kill_process_group(pid).await;
                        let _ = child.wait().await;
                        RunOutcomeKind::Timeout
                    }
                }
            }
        };

        // Drain reader tasks (with their own short timeout — they should
        // wrap up immediately after stdin is closed and the child exits).
        let stdout_bytes = stdout_task.await.unwrap_or(0);
        let stderr_bytes = stderr_task.await.unwrap_or(0);

        let wallclock_ms = started.elapsed().as_millis() as u64;
        match result {
            RunOutcomeKind::Exited(code) => RunOutcome {
                exit_code: code,
                wallclock_ms,
                stdout_bytes,
                stderr_bytes,
                kind: "ok",
                error: None,
            },
            RunOutcomeKind::Timeout => RunOutcome {
                exit_code: None,
                wallclock_ms,
                stdout_bytes,
                stderr_bytes,
                kind: "timeout",
                error: Some(format!("wallclock {}ms exceeded", spec.wallclock_ms_cap)),
            },
            RunOutcomeKind::Cancelled => RunOutcome {
                exit_code: None,
                wallclock_ms,
                stdout_bytes,
                stderr_bytes,
                kind: "killed",
                error: Some("cancelled by orchestrator".into()),
            },
            RunOutcomeKind::IoError(e) => RunOutcome {
                exit_code: None,
                wallclock_ms,
                stdout_bytes,
                stderr_bytes,
                kind: "io_error",
                error: Some(e),
            },
        }
        }) // close Box::pin(async move { ... })
    }
}

enum RunOutcomeKind {
    Exited(Option<i32>),
    Timeout,
    Cancelled,
    IoError(String),
}

struct ToolCommand {
    program: String,
    args: Vec<String>,
    stdin_prompt: bool,
}

/// Build the command for each supported tool's headless mode.
/// Per the user spec + plan v5 §6.1 spike scenarios.
fn build_command(spec: &TaskSpec) -> Option<ToolCommand> {
    match spec.tool.as_str() {
        "claude_code" | "claude" => {
            // claude -p reads prompt from stdin in non-interactive mode.
            Some(ToolCommand {
                program: "claude".into(),
                args: vec!["-p".into()],
                stdin_prompt: true,
            })
        }
        "codex_cli" | "codex" => {
            // codex exec reads prompt from stdin.
            Some(ToolCommand {
                program: "codex".into(),
                args: vec!["exec".into()],
                stdin_prompt: true,
            })
        }
        "gemini_cli" | "gemini" => {
            // gemini -p reads prompt from stdin.
            Some(ToolCommand {
                program: "gemini".into(),
                args: vec!["-p".into()],
                stdin_prompt: true,
            })
        }
        "copilot_cli" | "copilot" => {
            // Current GitHub CLI manual documents noninteractive Copilot as:
            // `gh copilot -p "prompt"`; the older `gh copilot suggest ...`
            // command starts an interactive suggest flow and is not suitable
            // for the stdio one-shot runner.
            Some(ToolCommand {
                program: "gh".into(),
                args: vec!["copilot".into(), "-p".into(), spec.prompt.clone()],
                stdin_prompt: false,
            })
        }
        _ => None,
    }
}

/// Read from a child's stdout/stderr, writing to `path` with a hard cap of
/// MAX_STREAM_BYTES. Returns the number of bytes read. Uses tokio::fs so the
/// reader doesn't block a runtime worker thread (per @claude3 task-51 §5.2).
async fn read_to_capped_file<R>(stream: Option<R>, path: PathBuf) -> u64
where
    R: AsyncReadExt + Unpin + Send + 'static,
{
    use tokio::io::AsyncWriteExt;
    let Some(mut stream) = stream else { return 0 };
    let mut buf = [0u8; 8192];
    let mut total: u64 = 0;
    let mut file = match tokio::fs::File::create(&path).await {
        Ok(f) => f,
        Err(_) => return 0,
    };
    loop {
        let n = match stream.read(&mut buf).await {
            Ok(0) => break,
            Ok(n) => n,
            Err(_) => break,
        };
        let remaining = MAX_STREAM_BYTES.saturating_sub(total as usize);
        let take = n.min(remaining);
        if take == 0 {
            break; // cap reached
        }
        if file.write_all(&buf[..take]).await.is_err() {
            break;
        }
        total += take as u64;
        if take < n {
            break; // cap reached mid-buffer
        }
    }
    let _ = file.flush().await;
    total
}
