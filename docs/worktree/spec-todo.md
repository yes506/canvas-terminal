# Worktree Spec — TODO

Lower-priority precision-polish items deferred from Phase 0 spec-acks
verification round. None of these block Phase 1 spike execution. They
are tracked here per kickoff §"Process discipline" so they aren't
silently lost.

Phase 0 spec author (@claude1) or any reviewer may pick these up at
any time; resolved items are deleted from this file.

---

## Open

### T1 — Multi-instance error wording (claude2 Issue 1)

§6.1 user-visible error mentions "open this session in non-worktree
mode" but it's unclear whether non-worktree mode is the existing
default-on collab path or a new toggle.

**Action**: clarify in §6.1 — if non-worktree is the existing path,
say "open in collaborator mode without worktree provisioning" and
reference feature flag `worktree_provisioning_enabled = false` in §9.

### T2 — `last_reaper_id` schema field semantics (claude2 Issue 2)

§3.1 declares `last_reaper_id: Option<String>` "for Model B reaper"
but §6.2 (Model B description) doesn't reference the field.

**Action**: pick one — either (a) add to §6.2 "each reaper sweep
updates `last_reaper_id` on every lease it advances; useful for
debugging which instance last touched a lease", or (b) remove the
field from §3.1.

### T_phase2_F1 — heartbeat conflation (claude2 T1.7)
Spec §3.4 quiescent threshold uses `heartbeat_at`, but per E5 the
heartbeat is supervisor-owned. If the supervisor heartbeats every N
seconds regardless of agent PTY activity, a wedged agent never
trips Quiescent. Phase 4 supervisor design decides whether to:
(a) add `last_pty_activity_at` field + use it for Quiescent/Wedged
thresholds, or (b) document supervisor heartbeat policy as
"only on observed PTY activity, not fixed interval." Spec amendment
on Phase 4 supervisor landing.

### T_phase2_F2 — WorktreePath canonicalization (codex1 task-55 #4)
`WorktreePath::new` now rejects `..` components (R2 fix), but does
not yet canonicalize symlinks. Phase 3 provisioner builds paths
from validated `AgentId` (safe by construction), so this is
defense-in-depth only. Add canonicalization in Phase 3 if/when
needed for symlink edge cases.

### T_phase2_F3 — wedge formula precision (codex1 task-55 #7)
`lease_check::evaluate` ladder uses `liveness_quiescent_secs` and
`liveness_quiescent_secs + wedge_grace_secs` as absolute thresholds.
Spec §11 Spike 4 formula is `heartbeat_timeout_secs +
wedge_grace_secs`. With defaults the difference is invisible; with
custom timeouts there's small drift. Make the formula explicit and
add a non-default-timeout test in Phase 4.

### T_phase2_F4 — schema migration test deferred (P2.T4)
Schema is at v1; no v0 to migrate from. Will become a meaningful
test when we ship v2. Until then, P2.T4 is N/A.

### T_phase2_F5 — config invalid-env behavior tightening (codex3 task-59 #5)
`resolve_managed_root()` falls back to default-prod when the env
var is invalid (relative path). Codex3 + codex2 prefer fail-closed.
Phase 3 provisioner can tighten this since it controls when the
managed root is used.

### T_phase2_F6 — reaper-claimed Draining no-driver (claude2 task-61 N2)
After reaper claim, lease state is `Draining` (in the
`is_actively_managed()` set). Subsequent reaper sweeps SKIP it.
Phase 5 drainer is the intended driver. Between Phase 2 ship and
Phase 5 ship, reaper-claimed leases sit in `Draining` indefinitely.
Phase 5 design must distinguish reaper-claimed from supervisor-
claimed leases (likely via `last_reaper_id.is_some()`) so the
drainer knows there's no live supervisor to wait for.

### T_phase2_F7 — reaper unconditional start (claude2 task-61 N4, codex3 task-64 #4)
`lib.rs` setup starts the reaper task whenever `resolve_managed_root()`
returns `Some` (always, on macOS, since `dirs::data_local_dir()`
exists). Spec §0 lazy-acquisition wording suggests subsystem should
be dormant until used. Either reframe spec ("reaper always runs;
session lock is what's lazy") or short-circuit the spawn on
`!registry.json.exists()`. Decision item before Phase 4 surfaces
heartbeat to UI.

### T_phase2_F8 — config test comment misleading (codex1 task-60 #4, codex3 #3)
`config::env_must_be_absolute` test asserts `ManagedRoot::new`
behavior, not `resolve_managed_root()` itself. Test name suggests
the latter. Tighten in Phase 3.

### T_phase2_F9 — pty.rs:225 too_many_arguments warning
Pre-existing warning unrelated to worktree. Currently
allow-listed in worktree-ci.yml. Should be addressed in a separate
cleanup PR before P2.T0's literal `--all-targets -- -D warnings`
form can be enabled.

### T5 — State diagram label "forced-close trigger" precision (claude3 #5)

Already partially addressed (changed from "timer" to "trigger"); could
be made more precise: "forced-close trigger (close cascade OR Path A
timeout OR App Nap wedge)."

### T6 — Reaper `reaper_max_leases_per_sweep` ordering (claude3 #6)

§6.2 says "process up to N leases per sweep" but doesn't specify which
N if more exist.

**Action**: spec — process oldest `updated_at` first (stalest leases
get processed first under load).

### T7 — Phase 5 frontend assignment review (claude2 F6 from earlier round)

Process item, not spec item. plan-rev2 §R-T1.3 has @claude2 as Phase 5
backend lead with @claude3 co-author for secret-handling. Worth
confirming the React-side review pair before Phase 5 starts (the ~500–
900 LOC of state-machine UI is non-trivial).

### T8 — Default `max_ahead_commits` (spec.md §13 open item, codex2 round-1 hint)

§5.2 merge handoff allows configurable `max_ahead_commits`
(default unlimited per spec.md §13). Reviewers may argue for a sane
cap during Phase 6.

### T9 — Exact regex patterns for §4.3 secret detection

Spec.md §13 already flags this for Phase 5 implementation. No spec-
phase action; Phase 5 implementer picks final patterns.

### T10 — Exact UI copy for §6.1 multi-instance error

Spec.md §13 already flags this for Phase 4 UX. No spec-phase action.

---

## Resolved (kept briefly for traceability)

### T3 (resolved 2026-05-02 by @codex1) — CI workflow `permissions:` and `timeout-minutes:`
`worktree-ci.yml` now declares `permissions: contents: read` (defense-
in-depth) and `timeout-minutes: 30` on the test job (prevents hung
clippy from inheriting 6h runner default). Applied inline by @codex1
during round-8 re-verification (task-45).

### T4 (resolved 2026-05-02 by @codex1) — Workflow path filters incomplete on push
Push trigger now mirrors PR `paths:` list (includes `src-tauri/Cargo.toml`,
`src-tauri/Cargo.lock`, `.github/workflows/worktree-ci.yml`). Applied
inline by @codex1 during round-8 re-verification (task-45).
