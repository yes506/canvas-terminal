// Worktree subsystem
//
// Module organization (per final-implementation-plan-claude1.md §3b):
//   types          — newtypes, AgentState, LeaseRecord/Snapshot
//   config         — env-based ManagedRoot resolution
//   managed_root   — disk-side bring-up + path validation
//   registry_store — atomic file persistence layer
//   registry       — CRUD on top of store + reconciliation primitives
//   lease_check    — PID + nonce + heartbeat freshness evaluation
//   orchestrator_lock — session + per-sweep flock guards
//   reaper         — sweep orchestration (Model B per-sweep flock)
//   provisioner    — worktree provisioning + RollbackGuard (Phase 3)
//   heartbeat      — supervisor-owned heartbeat task (Phase 4)
//   write_audit    — app-mediated path validation + audit log (Phase 4)
//   process_group_kill — killpg wrapper with PGID validation (Phase 4)
//
// Phase 4.5 (separate PR) will add the supervisor task that
// orchestrates spawn + setsid (constraint C3 via portable_pty
// CommandBuilder integration) + heartbeat ownership + agent-exit
// detection + lease state Ready → Working transition.
// Phase 5 will add the `drainer.rs` family (Path A `agent_completed`
// + Path B `forced_close` + dirty preservation).
// Phase 6 will add the merge queue.
// Phase 7 will add type hardening (compile_fail + proptest).
//
// Until Phase 3+ consumers land, many of the `pub` items here have
// no production-side caller (only the unit tests reference them).
// Module-level allow keeps the warnings out of CI noise; spec
// acceptance test P2.T0 + Phase 7 will turn lint back to `-D warnings`
// once cross-phase wiring exists.
#![allow(dead_code)]

pub mod config;
pub mod drainer;
pub mod heartbeat;
pub mod recovery;
pub mod lease_check;
pub mod managed_root;
pub mod merge_queue;
pub mod orchestrator_lock;
pub mod process_group_kill;
pub mod provisioner;
pub mod pty_supervisor;
pub mod registry;
pub mod registry_store;
pub mod reaper;
pub mod secret_detector;
pub mod supervisor;
pub mod supervisor_registry;
pub mod types;
pub mod write_audit;
