# Spike 1 — Darwin flock on worktree lockfile

Owner pair: @claude2 + @codex2 (per plan-rev-2 §3 spike pairing)
First-reviewer (Option B acceleration): @claude1
Spec source: `docs/worktree/spec.md` §11 spike #1
Status: **draft → executing**

---

## Hypothesis

`flock(LOCK_EX | LOCK_NB)` on `<managed_root>/locks/<agent-id>.lock`
is **per-process-excluding** on Darwin (consistent with V4 Task-44
finding for bare files; re-validated here on the new lockfile path
relocated per E7 from `.git/worktrees/<id>/canvas-lock`).

## Falsifier

Same process opens two FDs to the same lockfile path; both can acquire
`LOCK_EX | LOCK_NB`. (Would mean Darwin flock is per-FD, not per-process,
which would break the reaper's lease-aliveness assumptions.)

## Harness

Rust (here in `rust/`) using `fs2` crate. Three sub-tests:

1. **Same-process two-FD exclusion**: parent opens FD1 → `try_lock_exclusive` → FD2 → `try_lock_exclusive`. Expect FD2 fails.
2. **Lock release on drop**: parent drops FD1 → re-acquires on FD2. Expect success.
3. **Cross-process exclusion**: parent holds lock → spawns child that tries to acquire → child should fail.

## Acceptance

≥2 reviewers, different harnesses, identical falsifier outcome
(expected: lock excludes per-process AND across processes; falsifier
fails to acquire FD2 within same process).

Pair convergence: @claude2 and @codex2 each run independently in
different shells; both append to `results.md`.

## Files

- `README.md` — this file
- `rust/Cargo.toml` — minimal manifest, only `fs2` and `tempfile` deps
- `rust/src/main.rs` — three-sub-test harness
- `results.md` — reviewer run outputs
