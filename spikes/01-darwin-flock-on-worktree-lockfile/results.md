# Spike 1 Results

## Run 1 — @claude1 (first reviewer; Option B acceleration) — 2026-05-02

**Environment**: macOS Darwin 25.4.0, stable Rust toolchain
**Command**: `cargo run --manifest-path rust/Cargo.toml --quiet`
**Result**: **PASS 3/3 sub-tests**

```
=== Spike 1: Darwin flock on <managed_root>/locks/<id>.lock ===

T1: same-process two-FD exclusion
  FD1 try_lock_exclusive: OK
  FD2 try_lock_exclusive (with FD1 held): FAIL → Resource temporarily unavailable (os error 35)
  T1: PASS (per-process exclusion confirmed)

T2: lock release on drop
  scope-A FD acquired
  fresh FD after scope drop: OK
  T2: PASS

T3: cross-process exclusion
  parent acquired lock
  child exit code: 11 (expected non-zero = fail-to-acquire)
  child stdout: CHILD: failed to acquire (expected) — Resource temporarily unavailable (os error 35)
  T3: PASS (cross-process exclusion confirmed)

=== Spike 1 result: PASS ===
```

**Hypothesis status**: confirmed. Darwin flock on
`<managed_root>/locks/<agent-id>.lock` is per-process-excluding (T1)
and cross-process-excluding (T3). Lock releases cleanly on file-handle
drop (T2). The V4 Task-44 finding for bare files extends to lockfiles
in a regular user-space directory.

**Falsifier status**: NOT TRIPPED. T1 (same-process two-FD) is the
falsifier; FD2 correctly failed with EAGAIN/EWOULDBLOCK.

**Implication for Phase 2**: `orchestrator.lock` and per-worktree
lockfile design (spec.md §6.1, §6.2 Model B) are sound on the new
path. Spec amendment NOT needed.

---

## Run 2 — @claude2 — _pending_

(Append your run output. If results converge with @claude1's, spike
PASSES.)

## Run 3 — @codex2 — 2026-05-03

**Environment**: macOS Darwin, stable Rust toolchain
**Command**: `cargo run --manifest-path spikes/01-darwin-flock-on-worktree-lockfile/rust/Cargo.toml --quiet`
**Result**: **PASS 3/3 sub-tests**

Observed:
- T1 same-process two-FD exclusion: FD2 failed with
  `Resource temporarily unavailable (os error 35)` while FD1 held
  the lock.
- T2 release-on-drop: a fresh FD acquired the lock after the first
  handle dropped.
- T3 cross-process exclusion: child failed to acquire the parent-held
  lock with the expected non-zero exit.

**Confirmation**: matches @claude1's PASS. Falsifier not tripped.

---

## Pair convergence

**Converged: PASS** between @claude1 and @codex2.

Spike 1 can be treated as empirically confirmed for Phase 1. The
Phase 2 lock design can use regular user-space lockfiles under
`<managed_root>/locks/<agent-id>.lock`; no spec amendment is needed.

---

## Additional confirmation — @codex3 — 2026-05-03

**Environment**: macOS Darwin, stable Rust toolchain
**Command**: `cargo run --manifest-path spikes/01-darwin-flock-on-worktree-lockfile/rust/Cargo.toml --quiet`
**Result**: **PASS 3/3 sub-tests**

Observed:
- T1 same-process two-FD exclusion: FD2 failed with `Resource temporarily unavailable (os error 35)` while FD1 held the lock.
- T2 release-on-drop: fresh FD acquired after the first handle dropped.
- T3 cross-process exclusion: child failed to acquire the parent-held lock with the expected non-zero exit.

**Confirmation**: matches @claude1's PASS. Falsifier not tripped.

**Note**: I am not the assigned second reviewer for Spike 1, so I am recording this as extra convergence evidence rather than filling the @claude2/@codex2 pair slot.
