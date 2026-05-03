# Canvas Terminal — Worktree Subsystem (Operator + Contributor README)

> Per-agent git worktree isolation for AI multi-agent collaboration.
> See `spec.md` for the architectural spec; this README is the
> entry-point for new contributors and operators.

---

## What is the worktree subsystem?

When canvas-terminal runs in collaborator mode with multiple AI mini-agents
(Claude Code, Codex CLI, etc.), each agent traditionally shares the
project repo cwd. The worktree subsystem replaces that shared cwd with
a **per-agent git worktree**: each agent gets its own isolated branch,
working tree, and lifecycle, with structured atomic state transitions
managed by a Supervisor + Reaper + Drainer + Merge Queue.

Benefits:
- **Isolation**: agents can't step on each other's edits
- **Atomicity**: dirty work is preserved (`refs/wip/<agent>` + quarantine artifact) across crashes
- **Recovery**: orphaned leases are reaped automatically; half-states are retryable from the UI
- **Auditability**: every path-validated write is logged; reaper sweep counters are queryable
- **Mergeability**: agents that ship clean work can be queued for fast-forward merge into base

---

## Module map

```
src-tauri/src/worktree/
├── types.rs                # AgentId, BranchRef, WorktreePath, AgentState enum
├── managed_root.rs         # disk-side bring-up + path validation
├── config.rs               # env-based ManagedRoot resolution
├── registry_store.rs       # atomic file persistence (flock + tempfile+rename)
├── registry.rs             # CRUD on top of store + reconciliation primitives
├── lease_check.rs          # PID + nonce + heartbeat freshness evaluation
├── orchestrator_lock.rs    # session + per-sweep flock guards
├── reaper.rs               # sweep orchestration (Model B per-sweep flock)
├── provisioner.rs          # worktree provisioning + RollbackGuard (Phase 3)
├── heartbeat.rs            # supervisor-owned heartbeat task (Phase 4)
├── write_audit.rs          # app-mediated path validation + audit log
├── process_group_kill.rs   # killpg wrapper with PGID validation
├── supervisor.rs           # Phase 4.5 — LeaseRuntime + monitor + setsid spawn
├── supervisor_registry.rs  # process-wide HashMap<agent_id, Supervisor>
├── pty_supervisor.rs       # portable_pty SpawnAgent adapter (production wiring)
├── secret_detector.rs      # spec §4.3 secret patterns (regex)
├── drainer.rs              # Phase 5 — Path A/B drain + dirty preservation
├── merge_queue.rs          # Phase 6 — MergeReady → Merging → Merged
├── recovery.rs             # multi-process restart orphan adoption
└── mod.rs
```

---

## Lifecycle (state machine summary)

```
Provisioning  →  Ready  →  Working  →  Draining
                                ↓          ↓
                           (agent exit)  (forced close)
                                ↓          ↓
                         Snapshotting  →  ArtifactWritten  →  WipRefWritten
                                                                    ↓
                                                                Preserved
                                                                    ↓
                                            ┌───────────────────────┴────────────┐
                                            ↓                                    ↓
                                       MergeReady                            Removed
                                            ↓                                    ↓
                                       MergeQueued                           GcDone
                                            ↓
                                          Merging
                                            ↓
                                     ┌──────┴───────┐
                                     ↓              ↓
                                  Merged        MergeFailed { reason }
                                     ↓                ↓ (user)
                                  Removed       MergeAborted { reason }
                                     ↓
                                   GcDone
```

Half-states (visible in UI; reaper retries idempotently):
- `PreserveFailed { reason }` — spec §4.2 atomicity failure (quarantine, manifest, wip ref)
- `GcError { reason, retries }` — git worktree remove / branch delete failure
- `MergeFailed { reason }` — merge conflict / secret rescan trip
- `MergeAborted { reason }` — user cancelled merge from UI

---

## Quick start (developer)

```bash
# 1. Run the worktree subsystem tests (110+ tests pass)
cd src-tauri
cargo test --lib worktree::

# 2. Run the full test suite (lib + integration + E2E supervisor smoke)
cargo test --tests -- --test-threads=1

# 3. Lint
cargo clippy --all-targets -- -D warnings -A clippy::too_many_arguments

# 4. Release build
cargo build --release
```

---

## Quick start (operator: enable worktree mode)

Worktree mode is **opt-in** via `localStorage`:

1. Open canvas-terminal devtools (Cmd+Opt+I)
2. Run in console: `localStorage.setItem("worktree-mode-enabled", "true")`
3. Reload the app

To disable, run: `localStorage.removeItem("worktree-mode-enabled")` and reload.

When enabled:
- Each new mini-agent gets its own worktree under
  `<managed_root>/worktrees/<agent_id>/`
- Lease state is in `<managed_root>/registry.json`
- The UI header shows half-state chips (preserve_failed, gc_error)
  with retry/discard buttons

`<managed_root>` defaults to `~/.canvas-terminal/worktrees/` — override
via `WORKTREE_MANAGED_ROOT` env var.

---

## Phase 6 merge queue (auto-approve mode)

Set `WORKTREE_MERGE_AUTO_APPROVE=1` to make `MergeQueued → Merging`
happen automatically on the next merge worker tick. Default off
(human-in-the-loop is the safe default for v1).

Tauri commands for the UI:
- `queue_merge(agent_id)` — `MergeReady → MergeQueued`
- `query_merge_state(agent_id)` — `Option<MergeStateSnapshot>`
- `approve_merge(agent_id)` — `MergeQueued → Merging → Merged → GcDone`
- `abort_merge(agent_id, reason)` — `* → MergeAborted`
- `retry_merge(agent_id)` — `MergeFailed → Merging → ...`

The merge worker runs:
1. Defense-in-depth secret rescan on the diff `base...branch`
2. Fast-forward merge (no auto 3-way fallback — surface as `MergeFailed`)
3. Branch delete + worktree cleanup + state advance to `GcDone`
4. Lease removed from registry

---

## Operator runbook

### Q: Half-state chip shows "preserve failed" — what now?

The lease's preservation chain failed somewhere between
`Snapshotting → Preserved`. Common causes: quarantine path collision,
permission denied, secret detected. **Click "retry"** after resolving
the underlying issue (e.g., remove the flagged file). The drainer
re-runs the chain; on success the lease GCs as normal.

If the work is unsalvageable: **click "discard"** (irreversible — the
quarantine artifact is deleted, the lease is GC'd).

### Q: "gc error ×3" chip — what's the count?

The reaper has tried 3 times to GC the worktree (delete branch + remove
worktree dir). Common causes: locked dir, permission failure, git
metadata error. The lease persists for retry. Resolve the underlying
issue (e.g., chmod the worktree, manually `git worktree prune`) and
retry will increment to ×4.

### Q: "merge failed" — secret detected

Phase 6 re-runs the secret detector on the diff before fast-forward
(defense in depth). If a secret was introduced after the original
drainer pass, the merge refuses. Resolve by:
1. `git checkout <branch>`
2. Remove the secret (rebase, edit history)
3. `retry_merge` from the UI

### Q: After Tauri restart, my worktree leases show "draining"

This is recovery (B12). Any lease that was `Working` or `Ready` when
the prior Tauri process exited has no live supervisor — the recovery
sweep transitions them to `Draining` so the reaper picks them up on
the first sweep tick. The drainer will handle them (Path B, since
there's no `.done.json`).

### Q: How do I see what the reaper has been doing?

Tauri command: `query_reaper_metrics()` returns counters for sweeps,
claims, GcError, PreserveFailed. Also `query_supervisor_registry()`
shows live agent_ids + insert/remove totals.

### Q: How do I see audit log entries?

Tauri command: `query_audit_log({ limit: 100 })` returns recent
path-validation entries. Useful for forensics on "why was this write
allowed/refused?"

---

## Constraint trace (C1–C9)

Per spec §0 + Phase 1 spike findings:

| Constraint | Enforcement point |
|------------|-------------------|
| C1 (lockfile path under managed_root) | `managed_root::lock_path_for(&AgentId)` returns `<root>/locks/<id>.lock` |
| C2 (per-process flock) | `RegistryStore::acquire_write_lock` uses Darwin per-process exclusion |
| C3 (setsid) | `pty_supervisor::PtySpawn` (PTY allocation forces setsid); `supervisor::CommandSpawn` uses pre_exec |
| C4 (supervisor wraps spawn) | `Supervisor::start` calls `set_ownership` atomically with state transition |
| C5 (killpg with validated PGID) | `process_group_kill::sigterm_process_group` rejects pgid<=1 |
| C6 (wedge threshold) | `lease_check::evaluate` AliveStatus ladder |
| C7 (recovery matrix) | `recovery::adopt_orphan_leases` + `reaper::claim_dead_lease` |
| C8 (path validation) | `write_audit::audit_path` with canonicalize + symlink resolution |
| C9 (atomicity) | `drainer::write_quarantine_artifact` (fsync), `verify_preservation` (manifest + wip ref check before Preserved) |

---

## Test topology

- **Unit tests**: `cargo test --lib worktree::` — 121+ tests, runs in <5s
- **Integration tests**: `cargo test --tests` — includes `worktree_supervisor_e2e.rs` (real PTY + Supervisor + Drainer flow)
- **CI**: `.github/workflows/worktree-ci.yml` — gates on macOS + Linux

---

## Phase boundaries

- **Phase 1** — Spikes (Darwin flock, SIGHUP+setsid, PTY drain, App Nap, orchestrator crash)
- **Phase 2** — Foundation (registry, reaper, types, orchestrator lock)
- **Phase 3** — Provisioner (worktree creation + RollbackGuard)
- **Phase 4** — Working state foundation (heartbeat, write_audit, process_group_kill)
- **Phase 4.5** — Supervisor (LeaseRuntime + monitor + ownership + force_close)
- **Phase 5** — Drainer (Path A/B + spec §4.2 atomicity + secret detector + quarantine)
- **Phase 6** — Merge queue (queue/approve/abort/retry + secret rescan + fast-forward)
- **Phase 7** — Hardening (compile_fail tests, proptest, fuzz, PID-reuse defense)

---

## Where to read more

- `spec.md` — architectural spec (state machine, atomicity invariants, S1–S11 protocols)
- `spec-state-diagram.md` — visual state machine
- `spec-acceptance-tests.md` — P*.T* gate matrix
- `spec-todo.md` — outstanding items
