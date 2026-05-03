# Worktree System — Spec (v1)

Status: **Phase 0 draft**. Awaiting reviewer acks (≥4/5, no blocking nacks).
Authoritative design source: `synthesis-round3-claude1.md`.
Authoritative plan source: `plan-revised-claude1.md` + `plan-rev3-claude1.md`
+ `plan-finalization-claude1.md` in this session's collab memory.

This document is the single source of truth for implementers from
Phase 1 onward. Every load-bearing decision below is traceable to a
synthesis section (`B.X`) or a plan deferral (`S1–S13`).

---

## 0. Goals & non-goals

### Goals
- Each spawned mini-agent runs in its own git worktree (lifecycle-bound).
- Agent close → worktree cleaned up cleanly *whether or not* the close
  is graceful. Graceful close + ungraceful crash recovery are co-equal
  first-class concerns.
- All agent code/docs/merge work happens inside the worktree.
- Merges to integration branch go through a coordinator-mediated queue
  with file locking, not direct agent merges.

### Non-goals (v1)
- **OS-level filesystem sandboxing**. Worktrees provide git
  working-tree isolation, not process sandboxing. (Per S10 / synthesis
  §B.3 pillar 1.)
- **Submodule, sparse-checkout, or shallow-clone support**. (S12.)
  Provisioner detects and rejects with user-visible error.
- **Multi-instance orchestrator**. Single orchestrator per managed-root;
  second instance fails clean. (Synthesis B.13 item 9, recommendation a.)
- **Shell-mediated write confinement**. Audit + cwd guard only;
  shell-write detection deferred to optional 6th spike. (P1.3.)

---

## 1. Lifecycle state machine

The full state set (12 production states + 2 half-states):

```
Production states (terminal indicated by ⊥):
  provisioning → ready → working → draining

  draining branches:
    → snapshotting → artifact_written → wip_ref_written → preserved
                                                              ├─→ removed → gc_done ⊥
                                                              └─→ merge_ready
    → merge_ready                              (Path A clean + branch ahead fast-path)
    → gc_done ⊥                                (Path A clean + branch == base)

  merge_ready → removed → gc_done ⊥            (after merge queue resolves)

Half-states (visible in UI; reaper retries idempotently):
  preserve_failed { reason: PreserveFailReason }   ← from snapshotting/artifact_written/wip_ref_written
  gc_error { reason: GcErrorReason, retries: u32 } ← from removed (rare)
```

Notes:
- `merge_ready` is reachable via two paths: direct from `draining`
  (clean Path A branch-ahead fast-path); or from `preserved`
  (preservation succeeded AND drainer flagged for merge). The reaper
  may also re-enter `merge_ready` from `gc_error` if a `merge_ready →
  gc_error` lease is rescued — this is reaper interruption (§B.5),
  not a new transition.
- `stale_branch` is **not** an `AgentState` variant. Branch-handoff
  semantics for category 6 (clean worktree, branch ahead) live in
  §4.1 row 6 and ride on the `merge_ready` → `removed` transition
  with branch-ref preservation handled by the merge queue policy.

### Transition rules

| From | To | Trigger | Notes |
|------|-----|---------|-------|
| (none) | provisioning | spawn request | Phase 3 |
| provisioning | ready | `git worktree add` succeeds + lease registered + lockfile acquired + base-ref policy passed | Fail-closed on any step |
| provisioning | (cleanup) | any step fails | UI surfaces error; no lease persisted |
| ready | working | first agent activity (PTY input, output, or heartbeat) | Phase 4 |
| working | draining | close trigger (any of close-source matrix §3) | Phase 5 |
| draining | snapshotting | (Path A with dirty work or category-2/3/5 files) OR (Path B `.system-close.json` written) | See §2 |
| draining | merge_ready | (Path A clean working tree AND branch ahead of `expected_base` AND no preservation needed) | Direct fast-path; bypasses preservation states (no quarantine artifact, no wip ref) |
| draining | gc_done | (Path A clean working tree AND branch == `expected_base`) | Trivial cleanup; no preservation, no merge-handoff |
| draining | (loop) | wait for `.done.json` complete OR forced-close trigger | Up to `path_a_drain_timeout_secs` for Path A |
| snapshotting | artifact_written | quarantine artifact written + fsync | Both atomic per §4.2 |
| snapshotting | preserve_failed | snapshot failed | Visible in UI; manual recovery |
| artifact_written | wip_ref_written | `wip/<agent-id>` commit succeeds | Atomicity per §4.2 |
| artifact_written | preserve_failed | wip commit failed | Rollback artifact |
| wip_ref_written | preserved | both verified durable | Final preserve-state |
| wip_ref_written | preserve_failed | verification failed | Rollback both |
| preserved | removed | `git worktree remove` succeeds | Phase 5; reached when work was preserved via wip ref / quarantine but is not flagged for merge |
| preserved | merge_ready | drainer flagged this `preserved` lease as also meriting merge (e.g., partial preserve + branch ahead + handoff gates pass) | Reaches merge queue with quarantine artifact + wip ref attached |
| merge_ready | removed | merge queue completed (Pushed / MergedLocally) OR queue refused with reason recorded | Phase 6; branch ref preserved per merge_queue policy even after worktree removed |
| merge_ready | gc_error | merge queue lost the lease record (orphaned) | Reaper rescues; lease records `gc_error` until manual approve/discard |
| removed | gc_done | `git worktree prune` + registry GC | Final |
| removed | gc_error | gc step failed | Reaper retries idempotently |
| gc_error | gc_done | retry succeeds | Up to `gc_max_retries` |
| (any non-terminal) | (re-enter via reaper) | reaper observes lease stale (PID dead OR nonce mismatch OR heartbeat expired) | Reaper picks up the SAME state; transitions advance |

### State transition invariants

1. **Idempotency**: every transition succeeds if run twice. The reaper
   may interrupt and resume any non-terminal state.
2. **Atomic preservation**: states `snapshotting → artifact_written →
   wip_ref_written → preserved` are a single conceptual transaction.
   Failure at any step → `preserve_failed` half-state. NO partial
   "preserved" state ever exists.
3. **Drainer never authors `.done.json`** (S1, S11). That file is the
   agent's artifact. Drainer authors `.system-close.json` for Path B
   only.
4. **`preserve_failed` blocks GC**. User must explicitly resolve via
   retry / discard / open-quarantine UI before the lease is GC'd.

---

## 2. Close-source matrix (synthesis B.13 item 0)

Every close trigger maps to one entry edge of the state machine
(`working → draining`):

| Close source | graceful? | PTY state | Path | Notes |
|--------------|-----------|-----------|------|-------|
| Agent self-exit + complete `.done.json` | Y | drained | A `agent_completed` | Drainer observes complete `.done.json` (S1: `serde_json::from_reader` validates) |
| Agent pane close (X button) | partial | SIGHUP propagation | B `forced_close` | Drainer writes `.system-close.json`; supervisor sends SIGTERM → wait 5s → SIGKILL process group |
| Parent terminal close | partial | SIGHUP propagation | B `forced_close` | Same as pane close |
| Top-terminal close (with sub-tabs) | partial | SIGHUP cascade | B `forced_close` | Cascade propagated by orchestrator, not OS |
| Host process crash (kill -9, OOM, panic) | N | orphan | reaper takeover | Lease stale on next reaper sweep; B path |
| Orchestrator crash mid-merge | N | varies | spike-5 recovery | `git merge --abort` from `.git/MERGE_HEAD` on restart |
| App Nap / SIGSTOP > heartbeat_timeout_secs | N | suspended | reaper takeover | Stale via heartbeat expiry (quiescent → wedged per §3.4); reaper SIGKILLs PG (S9) and proceeds idempotently. SIGSTOP does **not** invalidate the nonce — nonce mismatch is the PID-reuse hazard, not the suspension hazard |
| Lid close (battery drain) | N | killed | reaper takeover | Same as crash; cleaned up on next launch |

### Path A vs Path B precedence rule (S11)

If both `.done.json` AND `.system-close.json` exist when the drainer
scans the worktree (race: agent completed just as drainer was about to
write its system artifact):

> **`.done.json` always wins.** Drainer reads `.done.json` via
> `serde_json::from_reader` (per S1). On success, drainer deletes the
> stale `.system-close.json` and continues Path A. On failure (e.g.,
> half-written `.done.json`), drainer treats as Path B forced_close and
> proceeds.

---

## 3. Lease schema (synthesis B.8 + S5 split)

Three view types — persistence, runtime, snapshot.

### 3.1 `LeaseRecord` — canonical persisted form

Stored at `<managed_root>/registry.json`. Atomic write via tempfile +
rename + fsync. Schema versioned for migration.

```rust
pub struct LeaseRecord {
    // identity
    pub session_id: String,
    pub agent_id: String,
    pub parent_agent_id: Option<String>,
    pub task_id: String,

    // git
    pub repo_root: PathBuf,
    pub base_ref: String,         // e.g., "refs/heads/main" at provision time
    pub base_commit: String,      // SHA at provision time (for ahead/behind check)
    pub branch_ref: BranchRef,    // newtype, validated against namespace
    pub worktree_path: WorktreePath,  // newtype, validated against ManagedRoot

    // ownership (S5: persisted slice of identity)
    pub owner_pid: i32,           // hint, not authoritative
    pub owner_nonce: String,      // random uuid; supervisor writes at provisioning
                                  //   (atomically tempfile+rename) — see §3.4;
                                  //   authoritative for liveness vs PID reuse
    pub owner_start_time: Option<i64>,  // ps -o lstart on macOS; /proc/<pid>/stat on Linux
    pub process_group_id: Option<i32>,  // for SIGKILL targeting
    pub heartbeat_at: i64,        // monotonic, supervisor-posted (S4)
    pub heartbeat_timeout_secs: u32,    // default 30
    pub liveness_quiescent_secs: u32,   // default 60 (S4)
    pub wedge_grace_secs: u32,    // default 30 (S4)

    // state
    pub state: AgentState,
    pub artifact_path: Option<PathBuf>,  // quarantine/<agent-id>/
    pub last_error: Option<String>,
    pub last_reaper_id: Option<String>,  // for Model B reaper (P1.4)

    // metadata
    pub created_at: i64,
    pub updated_at: i64,
    pub schema_version: u32,
}
```

### 3.2 `LeaseRuntime` — in-memory only

Never persisted. Holds non-serializable handles.

```rust
pub struct LeaseRuntime {
    pub record_id: String,                   // join key to LeaseRecord
    pub pty: Option<PtyHandle>,              // tokio task / fd
    pub heartbeat_task: tokio::task::JoinHandle<()>,
    pub lock_file: std::fs::File,            // worktree lockfile; flock held via
                                             //   fs2::FileExt methods on this File
                                             //   handle. Released on Drop (RAII).
    pub last_pty_activity: std::time::Instant,
}
```

### 3.3 `LeaseSnapshot` — UI-facing flattened view

Returned by `query_agent_lease`. Safe for UI consumption (no PIDs, no
FDs, no full paths).

```rust
pub struct LeaseSnapshot {
    pub agent_id: String,
    pub state: AgentState,
    pub branch_short: String,           // agent/<session>/<id>
    pub worktree_relative: String,      // relative to managed root
    pub heartbeat_age_secs: u32,
    pub is_alive: bool,                 // computed: PID + nonce + heartbeat
    pub last_error: Option<String>,
    pub artifact_present: bool,
}
```

### 3.4 Lease aliveness decision (S4)

A lease is **alive** iff ALL of:
1. `owner_pid` exists in OS process table
2. (If `owner_start_time` is set) running process's start time matches
3. `owner_nonce` matches the nonce file at
   `<worktree>/.canvas-agent-nonce` — the **supervisor** writes this file
   atomically (tempfile + rename) at provisioning time; contents = same
   UUID stored in `LeaseRecord.owner_nonce`. External CLI agents
   (Claude Code, Codex CLI) cannot inject Canvas-specific code, so the
   supervisor — not the agent — owns this file (consistent with S4
   supervisor-ownership). Missing nonce file → treat as nonce mismatch
   → reaper claim.
4. `heartbeat_at` is within `heartbeat_timeout_secs` of monotonic now

Aliveness states:
- `alive` — all conditions met
- `quiescent` — alive but no PTY activity within
  `liveness_quiescent_secs` → mark in registry but do not reap yet
- `wedged` — quiescent for additional `wedge_grace_secs` → reaper may
  claim the lease
- `dead` — any of conditions 1–4 fails → reaper claims the lease

**PID is a hint; nonce is authoritative.** PID reuse cannot misclaim a
lease (round-3 T2.2).

---

## 4. Dirty-state preservation (synthesis B.6 + B.7)

### 4.1 Six preservation categories

| # | Category | Action |
|---|----------|--------|
| 1 | Tracked + staged changes | Commit to `wip/<agent-id>` ref |
| 2 | Untracked files | Listed in `untracked-manifest.json`; included subject to allowlist |
| 3 | Ignored files | Default skip; allowlist for known-relevant (`.env.local`) if user opts in |
| 4 | Secret-detected files | **NEVER copied**, **never committed** (S11.4). Manifest records path + size + hash + detector reason only. UI surfaces; teardown blocks until user acks. |
| 5 | Generated/large assets (>10MB or known patterns) | Reference by hash; not bundled |
| 6 | Branch ahead of integration base (clean worktree, unmerged commits) | **Branch-handoff policy**, separate from dirty-preservation. Lease takes the `draining → merge_ready` direct fast-path (no quarantine, no wip ref). On merge queue completion (Pushed / MergedLocally / refused), worktree is removed but the **branch ref is preserved** (never `git branch -D` for `agent/<id>` until manual cleanup). The merge queue policy decides when/whether to prune the branch ref. |

### 4.2 Atomicity transaction (synthesis B.6)

Applies when there is anything to preserve (categories 1, 2, 3, 5 from
§4.1 — i.e., dirty working tree OR untracked/ignored/generated files in
scope). For **Path A clean working tree** AND **branch ahead of base**,
the lease takes the `draining → merge_ready` direct fast-path defined
in §1: no quarantine artifact, no wip ref, no preservation transitions.
For **Path A clean working tree** AND **branch == base**, the lease
takes `draining → gc_done` directly (no preservation, no merge handoff).

Two artifacts must succeed or both fail (no half-state):

```
snapshotting:
  1. Compute dirty manifest (categorize all files into 1-6)
  2. If any category-4 (secrets) → preserve_failed (block; user surfacing)
  3. Write quarantine/<agent-id>/manifest.json + relevant files
  4. fsync(quarantine_dir)
  5. → artifact_written

artifact_written:
  6. git commit -m "wip(agent-id): preserved at <ts>" --allow-empty=false
  7. git update-ref refs/wip/<agent-id> <commit>
  8. → wip_ref_written

wip_ref_written:
  9. Verify both quarantine/<agent-id>/manifest.json reads OK
     AND `git rev-parse refs/wip/<agent-id>` returns committed SHA
  10. → preserved

# half-state rollbacks
snapshotting failure → preserve_failed; quarantine partial cleanup attempted
artifact_written failure (commit failed) → preserve_failed; quarantine kept
wip_ref_written failure (verify) → preserve_failed; rollback wip ref AND quarantine
```

### 4.3 Secret detection (best-effort; NOT a security boundary)

`secret_detector.rs` uses regex patterns + entropy heuristic:
- AWS access key: `AKIA[0-9A-Z]{16}`
- AWS secret key: high-entropy 40-char base64
- GitHub token: `ghp_[A-Za-z0-9]{36}`, `gho_`, `ghs_`, `ghu_`, `ghr_`
- JWT: `eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+`
- Generic high-entropy strings: Shannon entropy > 4.5 in lines > 40 chars

Test fixtures at `src-tauri/tests/fixtures/secrets/` use **synthetic
patterns** that match the regex but are not real credentials.

> **Documented limitations**:
> - Best-effort guard, not a security boundary
> - User surfacing is mandatory
> - Never relied on as authoritative
> - False negatives expected (especially custom credential formats)

---

## 5. Merge queue (synthesis B.9 + S2 + S13)

### 5.1 Queue record schema

```rust
pub struct MergeQueueRecord {
    pub queue_id: String,
    pub source_branch: BranchRef,
    pub source_lease_id: String,
    pub expected_base: String,        // SHA agent provisioned from
    pub requested_at: i64,
    pub status: MergeStatus,
    pub conflict_artifact_path: Option<PathBuf>,
    pub reviewer_approval: Option<String>,
    pub final_integration_commit: Option<String>,
    pub remote_push_at: Option<i64>,
    pub remote_push_error: Option<String>,
    pub locked_by_orchestrator_id: Option<String>,
}

pub enum MergeStatus {
    Pending,
    MergingLocally,
    MergedLocally,
    PushPending,    // separate from local merge per synthesis B.9
    Pushed,
    PushFailed,
    Conflict,
    Aborted,
}
```

### 5.2 Drainer → Merge handoff (S2)

Phase 5 → Phase 6 handoff is gated:
1. Drainer transitions lease to `merge_ready` state when:
   - Path A `.done.json` complete (S1) AND clean working tree
   - branch ahead of `expected_base` by ≥1 commit
   - target branch (per push policy) is not protected without approval
2. Phase 6 merge queue may **refuse** a `merge_ready` lease if:
   - Branch ahead of `expected_base` by more than `max_ahead_commits`
     (configurable, default unlimited)
   - `protected_branch.rs` reports target protected without approval
   - Conflict detected before merge attempt (`git merge --no-commit
     --no-ff` dry run)

### 5.3 Serialization mechanism

File lock at `<managed_root>/merge-queue.lock` via `flock(LOCK_EX)`.
Single-writer semantics. `flock` releases on process death (Darwin
per-process semantics validated in Task-44 V4 round and re-validated
by Spike 1).

### 5.4 Crash recovery (Spike 5 productionised)

On orchestrator restart:
1. Scan queue for any record with `status = MergingLocally`
2. For each: check `<repo>/.git/MERGE_HEAD` existence
   - If exists: verify against queue record's `final_integration_commit`
   - If matches and ref updated: mark `MergedLocally`
   - If mismatch or ref not updated: `git merge --abort`; mark `Aborted`
     with reason `orchestrator_crash_mid_merge`

### 5.5 Push integration test (S13)

`push_integration_test.rs` runs against a Dockerized `gitserver` /
`gitea` fixture. CI cost: ~2-3 min/PR. Folded into @codex1's CI
pre-computation.

---

## 6. Multi-instance orchestrator + Reaper (Model B per P1.4)

### 6.1 Orchestrator lock — lazy acquisition

`orchestrator.lock` at `<managed_root>/orchestrator.lock`. Lock is
acquired only when a worktree-backed collab session starts; non-worktree
windows are unaffected.

If a second app instance attempts to start a worktree-backed session:
- `flock(LOCK_EX | LOCK_NB)` on `orchestrator.lock` fails
- User-visible error: "Another canvas-terminal instance is using
  worktree-backed collaboration on this project. Close it or open
  this session in non-worktree mode."

### 6.2 Reaper Model B — per-sweep lock acquisition

**Spec erratum (Phase 2 verifier round, R3 / F6)**: the reaper sweep
lock targets a SEPARATE file from the session lock — `<managed_root>/
sweep.lock`, NOT `<managed_root>/orchestrator.lock`. Using the same
file would mean the same process holding the session lock could never
sweep (Darwin per-process exclusion confirmed by Spike 1), starving
the most-likely-to-have-stale-children instance of cleanup capability.

The two locks are now orthogonal:
- `orchestrator.lock` = session-level mutual exclusion across instances
- `sweep.lock` = sweep-level serialization across instances

The reaper task always starts during Tauri setup. Each sweep:
1. Attempt `flock(LOCK_EX | LOCK_NB)` on `<managed_root>/sweep.lock`
2. If lock fails → no-op; next tick retries
3. If lock acquired:
   a. Load registry snapshot
   b. For each lease: check aliveness (§3.4); compute next state
   c. Process up to `reaper_max_leases_per_sweep` (default 50) leases
      per sweep, **sorted oldest-first by `updated_at`** (F8 fix:
      otherwise HashMap-iteration randomness can starve old stale
      leases under load > cap)
   d. fsync registry updates
   e. Release lock

If holding instance crashes mid-sweep, `flock` releases on process
death; next instance's next tick acquires the lock. Leases the crashed
sweep was working on remain in their last persisted state; the new
sweep picks up where the crashed one left off (idempotent transitions).

**Reaper claim semantics (R3 / F3 spec erratum)**: when the reaper
claims a wedged/dead lease, it advances the lease to `Draining`, NOT
`Removed`. `Removed` is a terminal-adjacent state meaning `git
worktree remove` succeeded; jumping there directly would bypass the
preservation chain (snapshotting → artifact_written → wip_ref_written
→ preserved → removed → gc_done) and cause data loss. Phase 5
drainer picks up `Draining` leases and runs Path B `forced_close`.

The atomic update also stamps `last_reaper_id` on the claimed lease
for debugging which instance touched it (F4).

### 6.3 SIGKILL targets process group (S9, codex3 #5)

When the reaper claims a wedged/dead lease, kill the **process group**,
not just the owner PID. Process-group PID is recorded in `LeaseRecord`
at provision time. Use `nix::sys::signal::killpg(pgid, SIGKILL)`.

---

## 7. Path A PTY lifecycle postcondition (S9)

Path A `agent_completed` flow:

```
0. INVARIANT: supervisor MUST continue heartbeating throughout this
   entire flow. The lease is NOT stale during supervised draining,
   regardless of heartbeat-relative-to-clock readings. If the
   supervisor dies during draining, only THEN can the reaper claim
   the lease (after heartbeat expiry per §3.4).
1. Drainer observes complete .done.json (per S1 atomicity)
2. Supervisor signals "no more input expected" via PTY input close
3. Supervisor reads PTY output until natural EOF
   OR until path_a_drain_timeout_secs (default 30s)
4. If timeout:
     supervisor sends SIGTERM to process group
     wait 5s
     send SIGKILL to process group
5. Snapshot diff (clean state, no further mutations possible)
6. Worktree state machine → snapshotting → ... → gc_done
   (or → merge_ready / → gc_done direct per §1 fast-paths
    when working tree is clean)
```

`path_a_drain_timeout_secs` is configurable per session (default 30s).

The §3.4 aliveness check additionally short-circuits on
`state in {draining, snapshotting, artifact_written, wip_ref_written,
merge_ready}` to mean "actively managed by supervisor; do not reap
regardless of heartbeat freshness." This prevents another reaper sweep
from double-processing a lease whose owning supervisor is in the middle
of a multi-second drain operation.

---

## 8. Base-ref policy (S12)

### 8.1 Selection rules

- **Default base**: HEAD of repo's primary branch, detected in this
  order:
  1. `git symbolic-ref refs/remotes/origin/HEAD` (if remote `origin`
     has HEAD configured)
  2. Fallback: `main` if `refs/heads/main` exists
  3. Fallback: `master` if `refs/heads/master` exists
  4. Otherwise: REJECT with user-visible error: "Could not determine
     a default base branch. Configure `git remote set-head origin
     <branch>` or pass an explicit `--base <branch>` option."
- **Dirty base** (uncommitted changes in repo's working tree):
  **REJECTED** with user-visible error:
  > "Worktree provisioning requires a clean base. Commit or stash your
  > current changes before spawning a worktree-backed agent."
- **Detached HEAD**: REJECTED with user-visible error:
  > "Worktree provisioning requires a named branch as base. Check out
  > a branch first."

### 8.2 v1 unsupported repository configurations (S12)

Provisioner pre-checks and rejects with user-visible error if any of:
- **Submodule**: `.gitmodules` exists at repo root
- **Sparse checkout**: `git config --get core.sparseCheckout` returns truthy
- **Shallow clone**: `<repo>/.git/shallow` exists
- **Repo IS a worktree**: `<repo>/.git` is a file (not dir); we don't
  support worktree-of-worktree

User-visible error template:
> "Worktree support requires a regular git repository. Detected:
> {submodule | sparse | shallow | worktree-of-worktree}. Not supported
> in v1."

### 8.3 Base evolution during agent work

If `main` advances while agent is working on `agent/<id>` (based on
older `main`):
- Merge queue check at handoff (§5.2): if branch is ahead of original
  `expected_base` AND `expected_base` no longer = current `main`,
  `MergeStatus = Conflict` with conflict_artifact noting "rebase
  required"
- User must explicitly rebase via `rebase agent branch onto current
  base` command (Phase 6 deliverable)

---

## 9. Feature flags (S3)

Stored at `~/.config/canvas-terminal/worktree-flags.json`:

```json
{
  "schema_version": 1,
  "worktree_provisioning_enabled": false,
  "worktree_audit_enabled": false,
  "worktree_dirty_preservation_enabled": false,
  "worktree_merge_queue_enabled": false
}
```

Atomic write via tempfile + rename + fsync. Each phase ships with its
flag default = `false`. Flag flip = explicit user action via Settings UI.

Phase 8 promotion path:
- MVP integration gate green → flip provisioning + audit defaults
- Beta gate green (7 nights) → flip dirty_preservation + merge_queue
- Default-on (14 nights) → all flags default true

---

## 10. Plan-acks "blocking nack" definition (S6)

A plan-ack is *blocking* if either:
- Verdict is explicitly `nack` or `block` in `plan-acks/<reviewer>.json`
- No response within 72 hours of plan posting AND the reviewer is the
  spike-pair primary for an affected spike (their non-response would
  block downstream work)

Non-blocking silence (reviewer is not on spike-pair-primary path) is
recorded as `silent` in the gate-check log; gate proceeds with their
absence noted.

---

## 11. Empirical assumptions (validated by Phase 1 spikes)

The following spec assumptions are explicitly load-bearing. If any
spike falsifies its assumption, this spec gets amended (per rev-2 §3
spec → spike → spec-amendment workflow) before Phase 2 starts.

| Assumption | Spike | Falsifier |
|------------|-------|-----------|
| `flock(LOCK_EX \| LOCK_NB)` on `<managed_root>/locks/<agent-id>.lock` is per-process-excluding on Darwin | Spike 1 | Same process opens two FDs to same lockfile; both acquire LOCK_EX |
| Agent process started via `setsid` survives parent zsh pane SIGHUP; cleanup hooks fire on its natural exit | Spike 2 | Agent dies on pane close OR cleanup hooks never fire |
| PTY can be kept alive long enough for `.done.json` (atomic via tempfile+rename) to be observed and complete diff snapshot taken | Spike 3 | PTY dies before snapshot; `.done.json` partial; diff on half-killed worktree |
| After SIGSTOP > `heartbeat_timeout_secs + wedge_grace_secs`, reaper observes lease as `wedged` (heartbeat expired), SIGKILLs the process group, and proceeds idempotently. A subsequent SIGCONT does not corrupt cleanup because the killed process is gone (PID may be reused — but the new process won't have our nonce, so any liveness probe still fails) | Spike 4 | Reaper does not detect within timeout OR a SIGCONT'd agent that survives somehow corrupts cleanup |
| Orchestrator crash mid-merge: restart detects `.git/MERGE_HEAD` consistently; queue record either reflects committed or aborted, never half | Spike 5 | Restart leaves integration branch inconsistent |

---

## 12. Risk #11 attribution (S7)

Spec author Phase 0 todo (5-min `git show --stat 9675b7a 0cbbb31` check):

- `9675b7a` "P2 backend hardening: parent-state safety + push partial-success
  + end-to-end conflict test"
- `0cbbb31` "P2 backend: orchestrator-owned approval commit + merge with
  file lock"

These round-1 commits *partially* addressed orchestrator-mediated merge
hardening. Risk #11 in the plan's risk register should be amended:

> Risk #11 (orchestrator crash mid-merge): "round-1 commits 9675b7a +
> 0cbbb31 partially addressed orchestrator-owned merge with file lock;
> NEW for the explicit `.git/MERGE_HEAD` recovery on restart and the
> queue-record reconciliation per Spike 5."

(Verify against actual commit messages during spec-acks.)

---

## 13. Acceptance criteria (Phase 0)

This spec is acceptance-ready when:

- [x] §1 state machine complete
- [x] §2 close-source matrix complete with Path A/B precedence (S11)
- [x] §3 lease schema with Record/Runtime/Snapshot split (S5)
- [x] §3.4 aliveness decision with quiescent/wedged distinction (S4)
- [x] §4 dirty preservation with atomicity transaction (S1)
- [x] §5 merge queue with handoff contract (S2) and integration test (S13)
- [x] §6 reaper Model B (P1.4)
- [x] §7 Path A PTY postcondition (S9)
- [x] §8 base-ref policy with v1 unsupported configs (S12)
- [x] §9 feature flags (S3)
- [x] §10 blocking-nack definition (S6)
- [x] §11 5 empirical spike assumptions
- [x] §12 risk #11 attribution check

Open items for spec-acks discussion (not blockers):
- Exact regex patterns for §4.3 secret detection (defer to Phase 5
  implementation)
- Exact UI copy for §6.1 multi-instance error (defer to Phase 4 UX)
- `max_ahead_commits` default (§5.2) — propose unlimited; reviewers may
  argue for a sane cap

---

**End of spec.md.** Companion docs:
- `spec-state-diagram.md` — visual state diagram
- `spec-acceptance-tests.md` — test enumeration per phase
- `spec-todo.md` — non-blocking precision-polish items deferred from
  spec-acks (created when items accumulate)

(§8 covers the base-ref policy in full; no separate `spec-base-ref-policy.md`
is needed.)
