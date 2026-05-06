//! Phase E scaffolding — leader outbox watcher.
//!
//! **STATUS: SCAFFOLDING ONLY. Not registered for production use.**
//!
//! Plan v6 Phase E (suspended per `docs/fsd/phase-e-design.md`):
//! when leaders emit `##FSD` commands via Write-tool to
//! `inbox/orchestrator/.pending/<filename>.json` instead of stdout,
//! this module's `notify`-driven watcher would parse each new file
//! and dispatch via `fsd_dispatch_command`.
//!
//! Phase E is NOT active. This module compiles but is not wired into
//! `lib.rs::run` or `AppState`. It exists so the structure is present
//! when the upstream CLI / prompt-discipline preconditions are met
//! (see `docs/fsd/phase-e-design.md` for trigger conditions).
//!
//! ## Design (when activated)
//!
//! - `notify` crate watches `inbox/orchestrator/.pending/` for create events.
//! - On each new file: read contents, validate as `FsdCommand` envelope,
//!   call `orchestrator::handle_command(...)` (same path as today's
//!   `fsd_dispatch_command` Tauri command).
//! - Move file to `.processed/<message_id>.json` after successful dispatch
//!   (or `.failed/` on validation error / orchestrator strike).
//!
//! ## Why this isn't wired yet
//!
//! 1. No supported leader CLI has a documented Write-tool emit mode.
//! 2. The current `fsdLineTap.ts` works (5 rounds of hardening; PR-5 harness
//!    reports zero divergences across 1000 turns).
//! 3. Removing `fsdLineTap` requires migrating every leader's prompt; doing
//!    that without a tested replacement is too risky.

#![allow(dead_code, unused_imports)] // Phase E scaffolding — entire module is not yet active

use crate::fsd::inbox::{InboxScope, InboxState};

/// Phase E entry point — would be called from `lib.rs::run` setup when
/// Phase E unlocks. Spawns the leader-outbox watcher tokio task.
///
/// Currently a stub that does nothing — real implementation deferred
/// until Phase E preconditions (see `docs/fsd/phase-e-design.md`).
pub fn spawn_leader_outbox_watcher_phase_e_only() {
    // Intentionally empty. When activated:
    //
    //   use notify::{Watcher, RecursiveMode};
    //   let scope = InboxScope::Leader { handle: "orchestrator".into() };
    //   let watch_path = ...; // memory_root.join(scope.state_dir(InboxState::Pending))
    //   let mut watcher = notify::recommended_watcher(|event| {
    //       // On create: parse file, validate FsdCommand, dispatch
    //   })?;
    //   watcher.watch(&watch_path, RecursiveMode::NonRecursive)?;
    //
    // The full impl is reserved until Phase E unlocks.
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Smoke test: the entry-point function exists and doesn't panic.
    /// Phase E activation is the only path that actually exercises this.
    #[test]
    fn spawn_phase_e_stub_does_not_panic() {
        spawn_leader_outbox_watcher_phase_e_only();
    }

    /// Verify the InboxScope used for orchestrator-bound commands is
    /// well-formed. Locks the design contract from `docs/fsd/phase-e-design.md`.
    #[test]
    fn phase_e_inbox_scope_path() {
        // Phase E commands target an orchestrator-side inbox so the
        // existing `claim_inbox_file` semantics apply uniformly.
        let scope = InboxScope::Leader { handle: "orchestrator".into() };
        assert_eq!(
            scope.state_dir(InboxState::Pending),
            "inbox/leader-orchestrator/.pending"
        );
    }
}
