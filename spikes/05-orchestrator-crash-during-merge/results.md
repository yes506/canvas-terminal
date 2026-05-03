# Spike 5 Results

Each reviewer in the pair appends their run section. Pair convergence
is the acceptance condition (per V4 verification pattern + spec.md §11).

---

## Run 1 — @claude1 — 2026-05-02

**Environment**:
- macOS Darwin 25.4.0
- `git --version` → (system git, the canvas-terminal default)
- `cargo --version` → stable
- harness: `spikes/05-orchestrator-crash-during-merge/rust/`
- command: `cargo run --manifest-path rust/Cargo.toml --quiet`

**Result**: **PASS** (all three scenarios)

```
=== Spike 5: orchestrator crash during merge ===

scenario A: recovery decision = Abort
scenario A: post-recovery → MERGE_HEAD gone=true, ref unchanged=true
scenario A: PASS

scenario B: recovery decision = Abort
scenario B: post-recovery → MERGE_HEAD gone=true, ref unchanged=true, markers gone=true
scenario B: PASS

scenario C: recovery decision = NoOp
scenario C: post-recovery → queue catch-up consistent=true (status=MergedLocally, sha=Some("42728993c8a85acd5722977acec20c35efd295c4"))
scenario C: PASS

=== Spike 5 result: PASS ===
```

**Falsifier check**: integration branch and queue record never disagreed:
- A: ref unchanged + queue would be marked Aborted → consistent
- B: ref unchanged + queue would be marked Aborted + worktree clean → consistent
- C: ref advanced + queue caught up to `MergedLocally(post_sha)` → consistent

**Recovery decision matrix** (validated by the spike, codified in
`decide_recovery()`):

| queue.status      | MERGE_HEAD | recovery action          | scenario |
|-------------------|------------|--------------------------|----------|
| MergingLocally    | yes        | Abort                    | A, B     |
| MergingLocally    | no, ref advanced | NoOp (queue catch-up) | C        |
| MergingLocally    | no, ref unchanged | NoOp                | (untested but symmetric) |
| MergedLocally(sha)| no, ref==sha | NoOp                   | (post-success path) |
| MergedLocally(sha)| no, ref!=sha | InvestigateInconsistency | (corruption case) |
| MergedLocally     | yes          | InvestigateInconsistency | (corruption case) |
| Pending           | yes          | InvestigateInconsistency | (corruption case) |

The "untested" and "corruption" rows are exercised by Phase 6 unit
tests in `merge_recovery_test.rs` per spec-acceptance-tests.md P6.T5.
This spike covers the 3 expected real-world cases.

**Compile warnings**: two dead-code warnings on `QueueStatus::Pending`
and `QueueStatus::Aborted` (only matched, never constructed in the
spike). Intentional — these variants are part of the matrix being
validated in `decide_recovery()`, not exercised by the scenarios.

**Hypothesis status**: confirmed — `.git/MERGE_HEAD` detection +
queue-record consistency check is sufficient to make recovery
deterministic.

**Recommendation for Phase 6**: port `decide_recovery()` verbatim into
`merge_executor.rs` (per spec.md §5.4); the 7-row matrix becomes the
function body. The InvestigateInconsistency cases should surface to
the user via the merge queue UI; production should include the
`current_sha` and `queue.expected_base` in the diagnostic.

---

## Run 2 — @codex1 — _pending_

(Append your run output here, including environment, command, output,
and any falsifier observations. If results converge with @claude1's,
spike PASSES the pair-convergence acceptance gate. If they diverge,
escalate to a third reviewer for adjudication.)

---

## Pair convergence

(Filled when both runs are recorded.)

---

## Additional confirmation — @codex3 — 2026-05-03

**Environment**: macOS Darwin, stable Rust toolchain
**Command**: `cargo run --manifest-path spikes/05-orchestrator-crash-during-merge/rust/Cargo.toml --quiet`
**Result**: **PASS** (all three scenarios)

Observed:
- Scenario A: recovery decision `Abort`; `MERGE_HEAD` gone and ref unchanged after recovery.
- Scenario B: recovery decision `Abort`; `MERGE_HEAD` gone, ref unchanged, and conflict markers gone after recovery.
- Scenario C: recovery decision `NoOp`; queue catch-up consistent with `MergedLocally` and a concrete post-merge SHA.

Compile warnings seen in the throwaway harness:
- dead-code warnings on `QueueStatus::{Pending, Aborted}`
- unused field warning on `RecoveryAction::InvestigateInconsistency(String)`

**Confirmation**: matches @claude1's PASS. Falsifier not tripped.

**Note**: I am not the assigned second reviewer for Spike 5, so I am recording this as extra convergence evidence rather than filling @codex1's pair slot.
