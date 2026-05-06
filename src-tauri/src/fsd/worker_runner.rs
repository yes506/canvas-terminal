//! Phase D: long-lived assistant worker (`WorkerRunner`).
//!
//! Plan v6 Phase D (speculative — separate design pass per claude5 task-30 §6).
//! This module ships a minimal `WorkerRunner` impl alongside the existing
//! `HeadlessStdioRunner` so future code paths can opt into long-lived workers
//! without disrupting Phase 1's stdio one-shot contract.
//!
//! ## Design
//!
//! - **One-shot vs long-lived**: `HeadlessStdioRunner` spawns a fresh CLI
//!   subprocess per task and closes stdin to signal end-of-prompt. The
//!   worker pattern keeps the subprocess alive across multiple tasks,
//!   delivering each task's prompt as a delimited message on stdin and
//!   parsing each response as a delimited block on stdout.
//!
//! - **Trade-off**: avoids cold-start cost (Claude/Codex CLI startup is
//!   seconds); adds liveness/restart complexity (worker must be probed,
//!   restarted on crash, drained on shutdown).
//!
//! - **Phase D scope (this commit)**: trait + minimal impl + tests.
//!   Production wiring (when to use which runner) is left to a Phase D
//!   integration commit. The default remains `HeadlessStdioRunner` per
//!   plan v6 §3 risk gate.
//!
//! ## Wire protocol (initial — minimal)
//!
//! Each task is delivered as a JSON line on the worker's stdin:
//!
//! ```json
//! {"task_id": "...", "prompt": "...", "wallclock_ms_cap": 120000}
//! ```
//!
//! The worker emits one JSON line per response:
//!
//! ```json
//! {"task_id": "...", "result": "...", "exit_code": 0, "wallclock_ms": 1234}
//! ```
//!
//! For Phase D's first cut, we don't actually exec a real wrapper script —
//! the impl is structurally complete (spawn, send, recv, kill) and ready
//! for a `claude --serve` / `codex --serve` mode when those land upstream.
//! Until then, this runner is **not registered for production use**; it
//! exists as scaffolding to validate the trait shape.

use crate::fsd::process_group::{kill_process_group, spawn_in_new_session};
use crate::fsd::runner::{AssistantRunner, RunOutcome};
use crate::fsd::schema::TaskSpec;
use std::sync::Arc;
use std::time::Instant;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};
use tokio::sync::Mutex as TokioMutex;

/// Long-lived assistant worker. Spawns a CLI in `--serve` mode and
/// communicates via JSON-line stdin/stdout. **Phase D scaffolding;
/// not registered for production use until a real `--serve` mode exists.**
#[allow(dead_code)] // Phase D consumer
pub struct WorkerRunner {
    inner: Arc<TokioMutex<Option<WorkerProcess>>>,
    program: String,
    args: Vec<String>,
}

#[allow(dead_code)]
struct WorkerProcess {
    child: Child,
    stdin: ChildStdin,
    stdout_reader: BufReader<ChildStdout>,
    pid: i32,
}

impl WorkerRunner {
    /// Construct a new worker (lazily spawned on first `run`).
    /// `program` and `args` should reference a CLI in serve-mode.
    /// Phase D first cut accepts any program; production wiring would
    /// gate on a known list (claude_cli, codex_cli with `--serve`).
    #[allow(dead_code)]
    pub fn new(program: String, args: Vec<String>) -> Self {
        Self {
            inner: Arc::new(TokioMutex::new(None)),
            program,
            args,
        }
    }

    /// Lazy-spawn the worker subprocess on first use.
    async fn ensure_alive(&self) -> Result<(), String> {
        let mut guard = self.inner.lock().await;
        if guard.is_some() {
            return Ok(());
        }
        let mut cmd = Command::new(&self.program);
        cmd.args(&self.args);
        cmd.stdin(std::process::Stdio::piped());
        cmd.stdout(std::process::Stdio::piped());
        cmd.stderr(std::process::Stdio::piped());
        let mut cmd = spawn_in_new_session(cmd);
        let mut child = cmd.spawn().map_err(|e| format!("spawn worker: {}", e))?;
        let pid = child.id().map(|p| p as i32).unwrap_or(0);
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| "worker stdin missing".to_string())?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "worker stdout missing".to_string())?;
        *guard = Some(WorkerProcess {
            child,
            stdin,
            stdout_reader: BufReader::new(stdout),
            pid,
        });
        Ok(())
    }

    /// Gracefully shut down the worker. Sends SIGTERM to the process group
    /// and waits up to 5s before SIGKILL.
    #[allow(dead_code)]
    pub async fn shutdown(&self) {
        let mut guard = self.inner.lock().await;
        if let Some(mut proc) = guard.take() {
            let _ = kill_process_group(proc.pid).await;
            let _ = proc.child.wait().await;
        }
    }
}

impl AssistantRunner for WorkerRunner {
    fn run<'a>(
        &'a self,
        spec: TaskSpec,
        _output_dir_rel: String,
        _cwd: Option<std::path::PathBuf>,
        mut cancel_rx: tokio::sync::oneshot::Receiver<()>,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = RunOutcome> + Send + 'a>> {
        Box::pin(async move {
            let started = Instant::now();
            // Ensure the worker is up.
            if let Err(e) = self.ensure_alive().await {
                return RunOutcome {
                    exit_code: None,
                    wallclock_ms: started.elapsed().as_millis() as u64,
                    stdout_bytes: 0,
                    stderr_bytes: 0,
                    kind: "spawn_error",
                    error: Some(e),
                };
            }

            // Send the task as a JSON line on stdin.
            let request = serde_json::json!({
                "task_id": spec.task_id,
                "prompt": spec.prompt,
                "wallclock_ms_cap": spec.wallclock_ms_cap,
            });
            let line = format!("{}\n", request);

            let timeout = std::time::Duration::from_millis(spec.wallclock_ms_cap);
            let inner = self.inner.clone();

            // Race: worker response read vs cancel vs timeout.
            let work = async move {
                let mut guard = inner.lock().await;
                let proc = match guard.as_mut() {
                    Some(p) => p,
                    None => return Err("worker shut down".to_string()),
                };
                if let Err(e) = proc.stdin.write_all(line.as_bytes()).await {
                    return Err(format!("write to worker: {}", e));
                }
                if let Err(e) = proc.stdin.flush().await {
                    return Err(format!("flush worker stdin: {}", e));
                }
                let mut response_line = String::new();
                if let Err(e) = proc.stdout_reader.read_line(&mut response_line).await {
                    return Err(format!("read worker response: {}", e));
                }
                Ok(response_line)
            };

            let result = tokio::select! {
                biased;
                _ = &mut cancel_rx => Err("cancelled".to_string()),
                r = tokio::time::timeout(timeout, work) => match r {
                    Ok(Ok(s)) => Ok(s),
                    Ok(Err(e)) => Err(e),
                    Err(_) => Err("wallclock timeout".to_string()),
                },
            };

            let wallclock_ms = started.elapsed().as_millis() as u64;
            match result {
                Ok(response_line) => {
                    let bytes = response_line.len() as u64;
                    // Parse the response — production would extract exit_code,
                    // result content, etc. For Phase D scaffolding, we only
                    // verify it's well-formed JSON and treat that as success.
                    match serde_json::from_str::<serde_json::Value>(&response_line) {
                        Ok(_) => RunOutcome {
                            exit_code: Some(0),
                            wallclock_ms,
                            stdout_bytes: bytes,
                            stderr_bytes: 0,
                            kind: "ok",
                            error: None,
                        },
                        Err(e) => RunOutcome {
                            exit_code: None,
                            wallclock_ms,
                            stdout_bytes: bytes,
                            stderr_bytes: 0,
                            kind: "io_error",
                            error: Some(format!("worker JSON parse: {}", e)),
                        },
                    }
                }
                Err(e) if e == "cancelled" => RunOutcome {
                    exit_code: None,
                    wallclock_ms,
                    stdout_bytes: 0,
                    stderr_bytes: 0,
                    kind: "killed",
                    error: Some("cancelled by orchestrator".into()),
                },
                Err(e) if e == "wallclock timeout" => RunOutcome {
                    exit_code: None,
                    wallclock_ms,
                    stdout_bytes: 0,
                    stderr_bytes: 0,
                    kind: "timeout",
                    error: Some(format!("wallclock {}ms exceeded", spec.wallclock_ms_cap)),
                },
                Err(e) => RunOutcome {
                    exit_code: None,
                    wallclock_ms,
                    stdout_bytes: 0,
                    stderr_bytes: 0,
                    kind: "io_error",
                    error: Some(e),
                },
            }
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Smoke test: WorkerRunner constructs and can be dropped without panic.
    /// Doesn't actually spawn a worker (no real `--serve` mode exists yet).
    #[test]
    fn worker_runner_constructs() {
        let _runner = WorkerRunner::new("/bin/cat".into(), vec![]);
    }

    /// Trait object usability: WorkerRunner can be coerced to `&dyn AssistantRunner`.
    #[test]
    fn worker_runner_is_object_safe() {
        let runner: Box<dyn AssistantRunner> =
            Box::new(WorkerRunner::new("/bin/cat".into(), vec![]));
        let _ = runner;
    }
}
