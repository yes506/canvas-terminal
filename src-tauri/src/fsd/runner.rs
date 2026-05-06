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
    ///
    /// `cwd` is the leader's project root, looked up by the orchestrator from
    /// `state.sessions[leader_session_id].cwd`. Threaded here (Phase 2.9) so
    /// helpers resolve relative paths in the leader's prompt against the
    /// project root, not the Tauri app bundle's working directory.
    fn run<'a>(
        &'a self,
        spec: TaskSpec,
        output_dir_rel: String,
        cwd: Option<std::path::PathBuf>,
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
        cwd: Option<std::path::PathBuf>,
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
                Err(e) => {
                    return RunOutcome {
                        exit_code: None,
                        wallclock_ms: started.elapsed().as_millis() as u64,
                        stdout_bytes: 0,
                        stderr_bytes: 0,
                        kind: "io_error",
                        error: Some(format!("memory root: {}", e)),
                    }
                }
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

            // Phase C: drain the addressed agent's inbox BEFORE spawn so
            // both stdin-driven CLIs (claude/codex/gemini) AND non-stdin
            // CLIs that take the prompt as an arg (gh copilot -p <prompt>)
            // receive the augmented prompt. Round-10 reflection per
            // codex1 task-1: previously `build_command` baked `spec.prompt`
            // into copilot's args, so drained inbox messages were acked
            // by `build_augmented_prompt` but never delivered to Copilot.
            //
            // At-most-once delivery contract is preserved (drain always
            // acks regardless of spawn outcome). The drain now happens
            // pre-spawn instead of post-spawn, so a spawn failure also
            // drops the messages — same semantic as the prior post-spawn
            // stdin-write failure window, just an earlier loss point.
            let augmented_prompt = build_augmented_prompt(&spec);

            // Build the final args. For non-stdin tools the prompt is
            // appended as the last positional arg (e.g. `gh copilot -p
            // <augmented_prompt>`); stdin tools get base args only and the
            // prompt is written to child stdin below.
            let mut final_args: Vec<String> = tool_command.args.clone();
            if !tool_command.stdin_prompt {
                final_args.push(augmented_prompt.clone());
            }

            let mut cmd = Command::new(&tool_command.program);
            cmd.args(&final_args);
            cmd.stdin(std::process::Stdio::piped());
            cmd.stdout(std::process::Stdio::piped());
            cmd.stderr(std::process::Stdio::piped());
            // Phase 2.9: inherit the leader's project root if known. Without this,
            // helpers run against the Tauri app's bundle path (e.g. `/Applications/
            // Canvas Terminal.app/Contents/MacOS/`), which silently breaks any
            // prompt referring to relative file paths.
            if let Some(ref dir) = cwd {
                cmd.current_dir(dir);
            }
            let mut cmd = spawn_in_new_session(cmd);

            let mut child = match cmd.spawn() {
                Ok(c) => c,
                Err(e) => {
                    return RunOutcome {
                        exit_code: None,
                        wallclock_ms: started.elapsed().as_millis() as u64,
                        stdout_bytes: 0,
                        stderr_bytes: 0,
                        kind: "spawn_error",
                        error: Some(format!("spawn {}: {}", spec.tool, e)),
                    }
                }
            };
            let pid = child.id().map(|p| p as i32).unwrap_or(0);

            // Write the prompt to stdin and close the pipe so stdin-driven CLIs
            // exit when done. Non-stdin CLIs (copilot) already received the
            // augmented prompt via args above.
            if tool_command.stdin_prompt {
                if let Some(stdin) = child.stdin.take() {
                    let prompt = augmented_prompt;
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
    /// Base args WITHOUT the prompt. The prompt is delivered separately:
    /// - `stdin_prompt=true` → prompt is written to child stdin.
    /// - `stdin_prompt=false` → prompt is appended to args at spawn time
    ///   (e.g. `gh copilot -p <prompt>`).
    ///
    /// Round-10 reflection per codex1 task-1: previously the copilot
    /// branch baked `spec.prompt` into args here, which silently bypassed
    /// the Phase C `build_augmented_prompt` drain — inbox messages were
    /// acked but never reached Copilot. Splitting prompt delivery out of
    /// `build_command` lets the spawn site pass the augmented prompt
    /// uniformly for both transport modes.
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
            // for the stdio one-shot runner. The augmented prompt is
            // appended by the spawn site (Phase C delivery).
            Some(ToolCommand {
                program: "gh".into(),
                args: vec!["copilot".into(), "-p".into()],
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

/// Phase C: drain the addressed agent's `.pending/` inbox at spawn time
/// and prepend each message's content to the task's prompt. One-shot
/// subprocesses have no continuous stdin to inject into, so delivery
/// happens as a spawn-time concatenation (plan v6 Pattern 2 / §C.1).
///
/// If `spec.to_agent_id` is `None`, returns the prompt unchanged.
/// Drained messages are atomically renamed `.pending → .processed` (acked
/// at spawn-success time) so they're not delivered twice. If the spawn
/// fails afterward, the rollback in step ④ of the producer write order
/// is the orchestrator's responsibility — for Phase C scope, we
/// ack-on-drain (at-most-once delivery to the spawned subprocess).
fn build_augmented_prompt(spec: &crate::fsd::schema::TaskSpec) -> String {
    let Some(target) = &spec.to_agent_id else {
        return spec.prompt.clone();
    };
    let scope = crate::fsd::inbox::InboxScope::Agent {
        agent_id: target.clone(),
    };
    // List pending messages (lex-sorted) and concatenate their content.
    // Best-effort: any storage error → log and proceed with original prompt.
    let names = match crate::fsd::storage::list_inbox_pending(&scope) {
        Ok(n) => n,
        Err(e) => {
            eprintln!(
                "fsd: build_augmented_prompt list_inbox_pending({}) failed: {} \
                 (prompt unchanged)",
                target, e
            );
            return spec.prompt.clone();
        }
    };
    if names.is_empty() {
        return spec.prompt.clone();
    }

    let memory_root = match crate::commands::memory::get_memory_root() {
        Ok(p) => p,
        Err(e) => {
            eprintln!("fsd: get_memory_root failed in spawn drain: {}", e);
            return spec.prompt.clone();
        }
    };
    let mut prepend = String::from("[INBOX MESSAGES — from prior turn(s)]\n");
    let mut acked: u32 = 0;
    for filename in names {
        // Claim atomically; if race lost, skip silently.
        let from_rel = format!(
            "{}/{}",
            scope.state_dir(crate::fsd::inbox::InboxState::Pending),
            filename
        );
        let to_rel = format!(
            "{}/{}",
            scope.state_dir(crate::fsd::inbox::InboxState::Processing),
            filename
        );
        match crate::fsd::storage::claim_inbox_file(&from_rel, &to_rel) {
            Ok(true) => {}
            _ => continue, // race lost or err — skip
        }
        // Read envelope.
        let abs = memory_root.join(&to_rel);
        let body = match std::fs::read_to_string(&abs) {
            Ok(b) => b,
            Err(_) => continue,
        };
        let env_result: Result<crate::fsd::inbox::InboxMessage, _> = serde_json::from_str(&body);
        let env = match env_result {
            Ok(e) => e,
            Err(_) => {
                // Round-8 reflection (codex3 task-83 §"Phase C spawn-time"):
                // quarantine malformed envelopes to .failed/ instead of
                // leaving in .processing/ where the stale reaper would
                // recycle them back to .pending/ for endless re-claim.
                quarantine_to_failed(&scope, &filename);
                continue;
            }
        };
        // Round-7 reflection (codex3 task-77 P2): validate envelope shape
        // and filename↔message_id binding before consuming. Same hygiene
        // as `fsd_inbox_claim`.
        if env.validate().is_err() {
            // Round-8 reflection: quarantine instead of silent skip.
            quarantine_to_failed(&scope, &filename);
            continue;
        }
        let expected_suffix = format!("-{}.json", env.message_id);
        if !filename.ends_with(&expected_suffix) {
            // Round-8 reflection: quarantine instead of silent skip.
            quarantine_to_failed(&scope, &filename);
            continue;
        }
        prepend.push_str(&format!("• from {}: {}\n", env.sender_id, env.content));
        // Ack (rename .processing → .processed)
        let _ = crate::fsd::storage::ack_inbox_message(&scope, &filename, &env.message_id);
        acked = acked.saturating_add(1);
    }
    prepend.push_str("[END INBOX]\n\n");
    if acked == 0 {
        // We claimed nothing — skip the prepend entirely.
        return spec.prompt.clone();
    }
    format!("{}{}", prepend, spec.prompt)
}

/// Best-effort move of a claimed-but-malformed file from `.processing/` to
/// `.failed/`. Used by `build_augmented_prompt` to quarantine envelopes
/// that fail deserialization, `validate()`, or filename↔message_id
/// cross-check. Round-8 reflection per codex3 task-83 §"Phase C spawn-time
/// drain has weak poison handling" — without this, malformed messages
/// would cycle `.pending → .processing → stale-reap → .pending` forever.
fn quarantine_to_failed(scope: &crate::fsd::inbox::InboxScope, filename: &str) {
    let from_rel = format!(
        "{}/{}",
        scope.state_dir(crate::fsd::inbox::InboxState::Processing),
        filename
    );
    let to_rel = format!(
        "{}/{}",
        scope.state_dir(crate::fsd::inbox::InboxState::Failed),
        filename
    );
    if let Err(e) = crate::fsd::storage::claim_inbox_file(&from_rel, &to_rel) {
        eprintln!(
            "fsd: quarantine_to_failed({}) failed: {} \
             (file remains in .processing/ for stale-claim recovery)",
            filename, e
        );
    }
}

#[cfg(test)]
mod tests {
    //! Round-9 reflection per codex2 task-88 + codex3 task-89 + claude4
    //! task-90 §3.1: direct regression test for `quarantine_to_failed`.
    //! Closes the unanimous test-coverage follow-up from round-9 reviewers.

    use super::*;
    use crate::fsd::inbox::{InboxScope, InboxState};

    fn ensure_test_root() {
        if std::env::var("CANVAS_TERMINAL_MEMORY_ROOT").is_err() {
            let test_root = std::env::temp_dir().join(format!(
                "canvas-terminal-fsd-test-{}",
                std::process::id()
            ));
            std::fs::create_dir_all(&test_root).expect("create test root");
            #[allow(unused_unsafe)]
            unsafe {
                std::env::set_var(
                    "CANVAS_TERMINAL_MEMORY_ROOT",
                    test_root.to_string_lossy().as_ref(),
                );
            }
        }
    }

    /// Plan v6 Phase C round-8 reflection: `quarantine_to_failed` must
    /// atomically move a `.processing/<file>` to `.failed/<file>` so a
    /// malformed message can't recycle through the stale-claim reaper
    /// back to `.pending/` for endless re-claim. Regression test closes
    /// codex3 task-89's "no direct unit tests for the quarantine helper"
    /// follow-up.
    #[test]
    fn quarantine_to_failed_moves_processing_to_failed_lane() {
        ensure_test_root();
        use std::sync::atomic::{AtomicU32, Ordering};
        static COUNTER: AtomicU32 = AtomicU32::new(0);
        let n = COUNTER.fetch_add(1, Ordering::SeqCst);
        let scope = InboxScope::Leader {
            handle: format!("test-quarantine-{}-{}", std::process::id(), n),
        };

        // Seed a malformed file in .processing/ that would otherwise loop
        // through .processing → stale-reap → .pending → re-claim → stale.
        let filename = "5-00000000000000000007-1714823900000-cafebabecafebabe.json";
        let memory_root = crate::commands::memory::get_memory_root().unwrap();
        let processing_path = memory_root
            .join(scope.state_dir(InboxState::Processing))
            .join(filename);
        std::fs::create_dir_all(processing_path.parent().unwrap()).unwrap();
        std::fs::write(&processing_path, "{ malformed json }").unwrap();
        assert!(processing_path.exists());

        // Quarantine — file should land in .failed/ atomically.
        quarantine_to_failed(&scope, filename);

        let failed_path = memory_root
            .join(scope.state_dir(InboxState::Failed))
            .join(filename);
        assert!(
            failed_path.exists(),
            "file should be quarantined to .failed/ (recycle-loop closed)"
        );
        assert!(
            !processing_path.exists(),
            "file must no longer be in .processing/"
        );

        // Cleanup
        let _ = std::fs::remove_dir_all(memory_root.join(scope.relative_path()));
    }

    /// `quarantine_to_failed` is best-effort: if the source doesn't exist
    /// (race: stale reaper already moved it), the helper logs and continues
    /// without panicking. Closes the "no source file" branch.
    #[test]
    fn quarantine_to_failed_silent_on_missing_source() {
        ensure_test_root();
        let scope = InboxScope::Leader {
            handle: format!("test-quarantine-noexist-{}", std::process::id()),
        };
        // No source file exists — must not panic.
        quarantine_to_failed(&scope, "5-00000000000000000099-1714823900000-aaaaaaaaaaaaaaaa.json");
    }

    /// Round-10 reflection per codex1 task-1: `build_command` for `copilot_cli`
    /// MUST NOT bake `spec.prompt` into args here — the prompt is appended at
    /// the spawn site so the augmented prompt (drained inbox messages) is
    /// delivered uniformly across stdin and non-stdin tools. Regression test
    /// pins the new contract: copilot args are `["copilot", "-p"]` with no
    /// trailing prompt, and `stdin_prompt=false` signals the spawn site to
    /// append the augmented prompt.
    #[test]
    fn build_command_copilot_omits_prompt_from_args() {
        let spec = TaskSpec {
            task_id: "T".into(),
            tool: "copilot_cli".into(),
            instance_idx: 1,
            role_hint: None,
            prompt: "PROMPT-MUST-NOT-APPEAR-IN-ARGS".into(),
            context_refs: Vec::new(),
            wallclock_ms_cap: 10_000,
            agent_id: "deadbeef".into(),
            from_agent_id: None,
            to_agent_id: None,
        };
        let cmd = build_command(&spec).expect("copilot_cli must build");
        assert_eq!(cmd.program, "gh");
        assert_eq!(cmd.args, vec!["copilot".to_string(), "-p".to_string()]);
        assert!(
            !cmd.stdin_prompt,
            "copilot must remain a non-stdin tool so the spawn site appends the augmented prompt"
        );
        for arg in &cmd.args {
            assert!(
                !arg.contains("PROMPT-MUST-NOT-APPEAR-IN-ARGS"),
                "build_command must not bake spec.prompt into copilot args (Phase C regression)"
            );
        }
    }

    /// Round-10 reflection per codex1 task-1: stdin-mode tools (claude/codex/
    /// gemini) keep their existing args contract — no prompt baked, prompt
    /// arrives via stdin. Verifies the refactor didn't accidentally start
    /// embedding `spec.prompt` in args for stdin tools.
    #[test]
    fn build_command_stdin_tools_omit_prompt_from_args() {
        for tool in ["claude_code", "codex_cli", "gemini_cli"] {
            let spec = TaskSpec {
                task_id: "T".into(),
                tool: tool.into(),
                instance_idx: 1,
                role_hint: None,
                prompt: "STDIN-ONLY-PROMPT".into(),
                context_refs: Vec::new(),
                wallclock_ms_cap: 10_000,
                agent_id: "deadbeef".into(),
                from_agent_id: None,
                to_agent_id: None,
            };
            let cmd = build_command(&spec).unwrap_or_else(|| panic!("{} must build", tool));
            assert!(cmd.stdin_prompt, "{} should be stdin_prompt=true", tool);
            for arg in &cmd.args {
                assert!(
                    !arg.contains("STDIN-ONLY-PROMPT"),
                    "{} build_command must not bake spec.prompt into args",
                    tool
                );
            }
        }
    }
}
