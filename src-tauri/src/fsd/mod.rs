//! FSD (Full-Self Driving) — leader-orchestrated assistant subsystem.
//!
//! Per `docs/fsd/plan-v5.md` (collab-memory `task-38-implementation-plan-v5-FINAL.md`):
//! the visible mini-agent (the "leader", an interactive PTY-attached CLI) owns
//! the planning, dispatch, evaluation, and termination of work assigned to a
//! pool of headless assistant CLIs. This module is the app-side **harness** —
//! it never decides tasks, it executes leader-authored commands.
//!
//! ## Architecture (from plan v5 §2, stable across 5 review rounds)
//!
//! ```text
//! user prompt → leader (PTY) → emits ##FSD {json} lines → fsdLineTap (TS)
//!                                                       → fsd_dispatch_command
//!                                                       → Orchestrator (Rust)
//!                                                       → AssistantRunner trait
//!                                                       → result.json on disk
//!                                                       → iteration_report.md
//!                                                       → inject_into_pty(leader)
//!                                                       → leader emits next ##FSD
//! ```
//!
//! ## Sub-modules
//!
//! - `storage` — durable run files under `collab-memory/fsd-runs/`; atomic
//!   `claim_memory_file` with kernel-level no-replace rename.
//! - `process_group` — async `setsid()` spawn + SIGTERM/SIGKILL group cleanup.
//! - `recovery` — startup scan to mark interrupted runs (dead PID OR stale
//!   heartbeat).
//! - `schema` — typed envelopes mirroring the TS-side `src/types/fsd.ts`.
//! - `runner` — `AssistantRunner` trait + `HeadlessStdioRunner` impl.
//! - `orchestrator` — `RunState` machine that consumes leader commands.
//!
//! Phase 1 ships: storage, process_group, recovery, schema, runner (stdio
//! only), orchestrator (single-CLI Pilot per plan v5 §5.1).

pub(crate) mod storage;
pub(crate) mod process_group;
pub(crate) mod recovery;
pub(crate) mod schema;
pub(crate) mod runner;
pub(crate) mod orchestrator;
