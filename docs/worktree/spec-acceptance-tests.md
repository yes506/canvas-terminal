# Worktree Acceptance Tests

Companion to `spec.md`. Enumerates the tests that gate each phase's
exit. Format: one row per test; each row maps to a spec section it
validates.

---

## Phase 2 (Foundation) acceptance tests

| # | Test | Spec ref | Notes |
|---|------|----------|-------|
| **P2.T0** | **CI bootstrap promotion (Phase 2 erratum)** — `worktree-ci.yml` updated to: (a) remove `--no-run` from the worktree test step so tests actually execute; (b) upgrade clippy to `cargo clippy --lib --no-deps -- -D warnings -A clippy::too_many_arguments` (scoped to the lib target, with one named allow for a pre-existing `pty.rs` warning that's unrelated to the worktree subsystem). The literal `cargo clippy --all-targets -- -D warnings` form is deferred until the unrelated `pty.rs:225` warning is addressed in a separate cleanup PR. | claude3 round-7 #4; codex2/codex3 R4 erratum | gate-correctness |
| P2.T1 | `ManagedRoot` rejects path outside its declared root | §3, B.13 item 0 | newtype validation |
| P2.T2 | `BranchRef` rejects names not matching `agent/<session>/<id>` | §3 | newtype validation |
| P2.T3 | Registry CRUD: write → atomic file rename + fsync; corrupted partial write recoverable | §3.1 | atomic-write contract |
| P2.T4 | Registry schema migration: v1 → v2 (synthetic) preserves all fields | §3.1 schema_version | migration safety |
| P2.T5 | Reaper claims lease when PID dead | §3.4, §6.2 | basic aliveness |
| P2.T6 | Reaper claims lease when nonce mismatches (PID-reuse hazard) | §3.4 | round-3 T2.2 |
| P2.T7 | Reaper claims lease when heartbeat expired | §3.4 | basic aliveness |
| P2.T8 | Reaper crash mid-sweep: resume picks up where left off | §6.2 Model B | idempotent reconciliation |
| P2.T9 | Two app instances ticking reaper concurrently: first holds lock, second no-ops | §6.2 Model B | claude2 round-6 + codex2 round-6 |
| P2.T10 | First instance crashes mid-sweep; second acquires lock on next tick and resumes | §6.2 Model B | flock auto-release |
| P2.T11 | `orchestrator.lock` lazy: non-worktree session does not acquire | §6.1 | UX / multi-window |
| P2.T12 | Second instance's worktree-backed session start fails with user-visible error when lock held | §6.1 | UX |
| P2.T13 | `clear_memory_dir()` does NOT touch registry/quarantine/queue paths | spec §0 non-goals | codex2 round-4 |
| P2.T14 | Process group kill (`killpg`) reaches all child processes | §6.3 | S9 |

CI gate: all P2.T* pass on macOS + Linux runners with the scoped
clippy form per P2.T0. The whole-crate `cargo clippy --all-targets
-- -D warnings` form is the post-cleanup goal but is not the
Phase 2 gate.

---

## Phase 3 (Spawn) acceptance tests

| # | Test | Spec ref | Notes |
|---|------|----------|-------|
| P3.T1 | `provision_worktree` happy path: lease registered + lockfile held + branch matches namespace | §1, §3 | basic |
| P3.T2 | Provisioning fails when base is dirty → user-visible error | §8.1 | base-ref policy |
| P3.T3 | Provisioning fails on detached HEAD → user-visible error | §8.1 | base-ref policy |
| P3.T4 | Provisioning fails when `.gitmodules` exists → user-visible error | §8.2 | S12 |
| P3.T5 | Provisioning fails when sparse checkout enabled → user-visible error | §8.2 | S12 |
| P3.T6 | Provisioning fails when `.git/shallow` exists → user-visible error | §8.2 | S12 |
| P3.T7 | Provisioning fails when repo IS a worktree (file `.git`) → user-visible error | §8.2 | S12 |
| P3.T8 | Branch namespace collision: second spawn with same prefix rejects | §3 BranchRef | safety |
| P3.T9 | UI handleSpawn blocks AgentMiniTerminal mount when provisioning fails | plan-rev-2 §5 | fail-closed |
| P3.T10 | **End-to-end smoke**: lease-after-spawn-then-kill-process — kill agent immediately after spawn → reaper claims worktree within `heartbeat_timeout_secs` and runs cleanup path through to `gc_done` | §1, §3.4, §6 | round-1 LB regression test |

---

## Phase 4 (Working) acceptance tests

| # | Test | Spec ref | Notes |
|---|------|----------|-------|
| P4.T1 | Supervisor heartbeat posts every `heartbeat_timeout_secs / 3` while PG alive | §3.4 (S4) | basic |
| P4.T2 | Heartbeat freshness visible in registry under load with **8-12 concurrent agents** (cap+headroom) | rev-2 §6 R-T1.5 | NOT 50 (capped product target) |
| P4.T3 | **Stress**: 50 synthetic leases with heartbeat-every-10s → registry write throughput acceptable (no flock starvation) | rev-2 §6 R-T1.5 | labeled stress, not capacity |
| P4.T4 | Lease becomes `quiescent` when no PTY activity within `liveness_quiescent_secs` | §3.4 (S4) | wedge detection |
| P4.T5 | Lease becomes `wedged` after additional `wedge_grace_secs` | §3.4 (S4) | wedge detection |
| P4.T6 | Reaper claims `wedged` lease (not `quiescent`) | §3.4 (S4) | precise wedge semantics |
| P4.T7 | Tauri command path validation: refuses path outside agent's allowed roots — agent's worktree ∪ agent's quarantine (`<managed_root>/quarantine/<agent_id>/`) ∪ system tmpdir (excluding paths under managed_root). **Phase 4 rev-2 B5 spec amendment**: "collab-memory" wording from earlier draft replaced with "quarantine" (the actual allowed root for agent-internal data per Phase 5 dirty preservation). Includes symlink-bypass defense via canonicalization of both the requested path and the comparison roots (B4). | rev-2 §6 R-T1.1 + Phase 4 rev-2 B4+B5 | app-mediated guard with symlink resolution |
| P4.T8 | Audit log entry created when Tauri command refuses out-of-bound path | rev-2 §6 R-T1.1 | audit, not enforcement |
| P4.T9 | NO test asserts shell-mediated writes detected (out of MVP scope per P1.3) | rev-3 P1.3 | honesty constraint |
| P4.T10 | `query_agent_lease` Tauri command returns `LeaseSnapshot` (no PIDs/FDs leaked) | §3.3 | UI-safe snapshot |

---

## Phase 5 (Draining) acceptance tests

| # | Test | Spec ref | Notes |
|---|------|----------|-------|
| P5.T1 | Path A: agent writes `.done.json` via tempfile+rename → drainer reads via `serde_json::from_reader` → snapshot success → gc_done | §2 (S1), §7 (S9) | happy path |
| P5.T2 | Path A: agent writes partial `.done.json` (mid-write kill) → drainer treats as Path B `forced_close` | §2 precedence (S11) | atomicity |
| P5.T3 | Path B: drainer writes `.system-close.json`; supervisor SIGTERM → 5s → SIGKILL PG | §2, §7 (S9) | forced close |
| P5.T4 | Both `.done.json` AND `.system-close.json` exist (race) → `.done.json` wins; drainer deletes stale `.system-close.json` | §2 (S11) | precedence rule |
| P5.T5 | Crash during `snapshotting` → reaper restarts → enters `snapshotting` again → completes idempotently | §1, §6.2 | atomicity |
| P5.T6 | Crash between `snapshotting` and `artifact_written` → on resume, no half-state visible | §4.2 | atomicity |
| P5.T7 | Crash between `artifact_written` and `wip_ref_written` → resume rolls back artifact | §4.2 | atomicity |
| P5.T8 | Each of 6 dirty categories preserved correctly | §4.1 | category-by-category |
| P5.T9 | Category 4 secrets: synthetic AWS-key fixture in worktree → draining enters `preserve_failed` → no copy in quarantine | §4.3, fixtures/secrets/ | S11.4 |
| P5.T10 | Category 6 stale-branch: clean worktree with branch ahead of base → `merge_ready` (not `removed`) | §4.1 #6 | category split |
| P5.T11 | UI surfaces `preserve_failed` with retry/discard/open-quarantine buttons | spec-state-diagram §"Half-state visibility" | UX |
| P5.T12 | UI does NOT use language "blocked external write" for shell writes | rev-3 codex3 round-6 #4 | honest UI copy |

---

## Phase 6 (Merge queue) acceptance tests

| # | Test | Spec ref | Notes |
|---|------|----------|-------|
| P6.T1 | 6 concurrent merge requests → no deadlock; serialized via `merge-queue.lock` | §5.3 | MVP gate input |
| P6.T2 | Conflict detected → `MergeStatus = Conflict` + conflict_artifact_path set | §5.1 | basic |
| P6.T3 | Push fails (mocked auth) → `MergeStatus = PushFailed` + remote_push_error set | §5.1 | basic |
| P6.T4 | Local merge succeeds + push succeeds → `MergeStatus = Pushed` | §5.1 | basic |
| P6.T5 | **Spike-5 productionised**: orchestrator killed mid-merge → restart detects `.git/MERGE_HEAD` → either MergedLocally consistently OR Aborted with `orchestrator_crash_mid_merge` | §5.4 | crash recovery |
| P6.T6 | URL parsing: HTTPS-with-port (`https://ghe.example.com:8443/...`) | round-1 commit `0951ba5` | GHE |
| P6.T7 | URL parsing: SSH (`ssh://git@ghe.example.com:22/...`) | round-1 commit `f9e74bb` | GHE |
| P6.T8 | GHE host detection: known GHE hostnames vs github.com | round-1 commits `a6552f8`, `0e5bce3` | GHE |
| P6.T9 | Protected-branch detection three-state wizard: protected / not-protected / unknown | round-1 commits `7629df2`, `199256d` | protection |
| P6.T10 | Merge handoff: drainer-`merge_ready` lease accepted by queue; non-`merge_ready` rejected | §5.2 (S2) | handoff contract |
| P6.T11 | Base evolution: `expected_base` mismatched at handoff → `Conflict` + "rebase required" artifact | §8.3 | base evolution |
| P6.T12 | **Real-protocol integration test**: against Dockerized gitserver/gitea — push succeeds, push to protected branch rejected | §5.5 (S13) | realism |

---

## Phase 7 (Type hardening) acceptance tests

| # | Test | Spec ref | Notes |
|---|------|----------|-------|
| P7.T1 | `compile_fail` doc-test: assigning `Vec<Task>` to `WorktreeBackedAgent.task` MUST NOT compile | rev-2 §9 | type invariant |
| P7.T2 | `match` exhaustiveness audit: no `_` arm in production code paths handling `AgentState` | rev-2 §9 | exhaustiveness |
| P7.T3 | `merge_ready` AgentState variant present in: types.rs enum, registry serialization, query_agent_lease snapshot, all production matches | spec §1 (S2) | rev-3 codex3 round-6 #3 |
| P7.T4 | proptest 1000 iterations: every state reachable from `advance()` is a defined `AgentState` variant | rev-2 §9 | property test |

---

## Phase 8 (Soak / CI) acceptance tests

| Gate | Criteria |
|------|----------|
| **MVP integration** | Per-PR CI green + 1 successful nightly soak run (50 spawn/crash/reap cycles + 6 concurrent merges across macOS + Linux) |
| **Beta** | 7 consecutive nightly soak runs green |
| **Default-on** | 14 consecutive nightly soak runs green |

Soak-clock semantics: PR test failures gate the PR but don't reset the
soak clock UNLESS the failure mode is in the worktree subsystem (in
which case clock resets and synthesis revisit triggered per meta-risk).

---

## CI cost pre-computation (S13)

@codex1 to verify before user signs B.13 item 8:
- Per nightly soak: ~50 minutes across both platforms (verified math
  per rev-3 P2.1)
- Hardening window (14 nights): ~11.7 runner-hours total
- Per-PR runs: ~10 minutes each at 10 cycles
- Plus `push_integration_test`: ~2-3 min/PR via Dockerized gitserver
- Estimated total: ~30 hr/month at 5 PRs/week + nightly
- Distinguish personal vs org GitHub Actions tier
