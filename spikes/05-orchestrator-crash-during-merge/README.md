# Spike 5 — Orchestrator crash during merge

Owner pair: @claude1 + @codex1 (per plan-rev-2 §3 spike pairing)
Spec source: `docs/worktree/spec.md` §11 spike #5
Status: **draft → executing**

---

## Hypothesis

The orchestrator dies (`kill -9`) between `git merge` start and ref
update. On restart, the recovery logic must detect `.git/MERGE_HEAD`
(and queue record state) and either complete the merge or
`git merge --abort` consistently. The integration branch and the
queue record never disagree on what state they ended up in.

## Falsifier

Restart leaves the integration branch in an inconsistent state, OR
the queue records a final commit SHA that doesn't match the actual
git ref.

## Harness

Rust (here in `rust/`); Python equivalent welcome from the second
reviewer per V4 verification pattern.

The Rust harness:
1. Creates a temp git repo with two diverging branches `A` (base) and
   `B` (source)
2. Simulates orchestrator pre-merge state: synthetic queue record with
   `status = MergingLocally`, `expected_base = A's HEAD SHA`
3. Starts `git merge --no-commit --no-ff B` from branch `A`. This
   creates `.git/MERGE_HEAD` but does NOT yet create the merge commit
4. **Simulated crash** (process exits without committing). MERGE_HEAD
   exists; ref still at pre-merge SHA
5. **Simulated restart**: recovery logic reads queue record, observes
   `MERGE_HEAD` exists; since queue says `MergingLocally` (not
   `MergedLocally`), recovery decision = `git merge --abort`
6. Verifies post-recovery: no `MERGE_HEAD`, branch ref equals
   `expected_base`, queue record updated to `Aborted` with reason
   `orchestrator_crash_mid_merge`

Three scenarios are covered in scenarios A/B/C in `rust/src/main.rs`:
- **A** (clean merge possible): MERGE_HEAD created → crash → restart
  recovery aborts cleanly, ref unchanged
- **B** (conflicting merge): MERGE_HEAD created with conflict
  markers in worktree → crash → restart recovery aborts, ref and
  worktree clean
- **C** (post-commit crash): merge commit created, ref updated → crash
  before queue record update → restart recovery sees `MergedLocally`
  with sha matching ref; recovery is a no-op (already consistent)

## Acceptance

≥2 reviewers, both observe consistent recovery (committed-and-recorded,
or aborted-and-marked-failed; never half).

Pair convergence: both `@claude1` and `@codex1` run the harness
independently in different shells; both append run output to
`results.md`. If outcomes converge, spike passes. If outcomes diverge
on any scenario, the spike escalates to a third reviewer for
adjudication and the spec gets a falsifier-driven amendment.

## Files

- `README.md` — this file
- `rust/Cargo.toml` — minimal manifest, only `tempfile` dep
- `rust/src/main.rs` — three-scenario harness
- `results.md` — reviewer run outputs (each reviewer appends a section)
