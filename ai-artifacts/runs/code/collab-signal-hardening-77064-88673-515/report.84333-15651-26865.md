# Implementation report — collab-signal-hardening

## Source
- Planner marker: **feature** from commit `a9afef4` (`(plan-feature, human-confirmed)`)
- Planner artifacts: `plan.md` + `plan.mmd` under
  `ai-artifacts/runs/code/collab-signal-hardening-77064-88673-515/`
- Source hash (plan.md sha256, first 16): `1947406a1b94f53d`

## Work queue summary
- Total items: 21
- Completed: 21
- Blocked: 0

## Files changed (vs `dev`)
- `src/lib/collabCompletion.ts` — NEW, +418 (pure seam: resolver/codec/policy/tracker)
- `src/lib/collabCompletion.test.ts` — NEW, +309 (31 unit tests)
- `src/lib/scopedCollabMemory.ts` — +9 (quarantine + inspect wrappers)
- `src/types/scopedCollabMemory.ts` — +43 (2 methods + `ReportFileInfo`)
- `src/stores/collaboratorStore.ts` — +694/−194 (txn, scanner rework, protocol, N14)
- `src/stores/collaboratorStore.test.ts` — +201 (7 new behavioral tests, 1 updated)
- `src/components/collaborator/commands.ts` — +47/− (shared exact-first resolver)
- `src-tauri/src/commands/memory.rs` — +195 (2 IPCs + 4 Rust tests)
- `src-tauri/src/lib.rs` — +2 (command registration)

Total: 9 files, +1724 / −194.

## What was implemented (by plan node)
- **N4/N5/N6/N7** `collabCompletion.ts`: exact-first `resolveTaskId` (kills
  `task-1`/`task-10` collision), legacy-compatible `validateSignal`
  (`report_path` NEVER `ok:false` — G1), `classifyFailure` taxonomy,
  concurrency-safe `StabilityTracker` (injected clock, content hash).
- **N13/N8-rust** `memory.rs`: no-clobber `quarantine_memory_file` (both
  endpoints validated) + no-follow `inspect_report_file` (`symlink_metadata`,
  reference-only), registered in `lib.rs`.
- **N9/N10/N11** persistence-acknowledged terminalization: `persistTasksStrict`
  (revision-fenced, atomic, non-swallowing), `TerminalizationReceipt` phases,
  `terminalizeWithAck` (mark→strict-persist→emit-once→delete; signal RETAINED on
  a failed ledger write). `emitTaskTerminalOutcome` extracted from `updateTask`
  so human + scanner paths share one emitter.
- **N15/N16** `scanForTaskCompletions` reworked into driver + `ingestSignalFile`
  with the typed taxonomy, stability-gated quarantine+diagnostic, per-file
  in-flight guard; race guards (grace, per-iteration re-reads, teardown)
  preserved.
- **N8** report_path → Task Report mapping (no-follow inspect; soft-fail on
  missing/unsafe; legacy `output` preserved + `Report:` appended).
- **N14** `reportIngestFailure`: peer-visible conversation-log diagnostic +
  always-on console fallback, deduped per `(session,path,reason)`.
- **N1** minimal report-first, atomic-`mv` `done.json` protocol template.
- **N17** `/task status|assign|done` use the shared resolver.

## Deliberate behavior change
- A no-match / wrong-session signal past the 24h grace is now **quarantined**
  (`.bad`, forensic) instead of silently deleted, and a wrong-session file is
  diagnosed + quarantined rather than stranded (scoped-memory isolation means a
  sibling scanner can never see it). One existing task-31 test updated to assert
  the new quarantine contract.

## Bug found + fixed during test-first work
- `terminalizeWithAck` initially gated the side-effect emit on the task's
  terminal state; on a retry after a failed persist the task is already terminal
  in-memory, which would skip the emit forever. Fixed to gate on the **receipt
  phase** (`terminal_unpersisted`), so a retry emits exactly once. (Caught by the
  "retry emits exactly once" test — written before finalizing the body, per the
  plan's guidance.)

## Validation
- Baseline exit (BASE_BRANCH HEAD): presumed clean (tagged release v0.5.14; not
  separately run — fresh worktree needs npm install + cargo compile). No
  pre-existing failures surfaced.
- Final validation command: `npx tsc --noEmit && npm run test && (cd src-tauri && cargo test)`
- Final exit (AFTER hardening round): **0**
  - `tsc --noEmit`: clean
  - `npm run test` (vitest): **481 passed** (25 files)
  - `cargo test`: **95 lib passed** (13 memory incl. FIFO reject) + 5 others,
    **0 failed**
- **Worktree verified CLEAN after validation** (`git status --short` empty;
  `Cargo.lock` committed); **zero NUL bytes** in `src`/`src-tauri/src`.
- Auto-fix attempts used: 0/1

## Post-review HARDENING ROUND (5-peer implementation review → fixes)

The first handoff was reviewed by 5 peers. 3 (codex1/2/3) independently found
real blockers that the 2 approvals (incl. my own instinct) missed. I verified
each against the code and fixed them. **My original "clean, fully validated"
claim was wrong** — the worktree was dirty (`Cargo.lock`) and two source files
carried literal NUL bytes. Corrected below.

Blockers fixed:
- **B1 reopen/reassign signal-loss** — `updateTask` now cancels the receipt +
  quarantines the stale signal on any status change; `terminalizeWithAck`
  CAS-rechecks (receipt present AND task still in the intended terminal status)
  after the persist, so a superseded snapshot can never be acked/emitted/deleted.
- **B2 author precedence** — `author` now WINS over the legacy `agent` alias
  (was wrongly returning `author-agent-conflict` → quarantine, a regression); the
  test that codified the wrong behavior was corrected.
- **B3 teardown-as-ack** — `persistTasksStrict` throws on `abortedSessions` so an
  aborted write is never treated as an acknowledgement.

HIGH fixed: silent list/stat/defect failures now diagnosed; quarantine-first then
diagnose with the **actual** `.bad` destination, retryable on failure; report
`sizeBytes` cap enforced (oversize → soft-fail) + sibling-basename-only
injection-safe `report_path` grammar; **exclusive-reservation (O_EXCL) no-clobber**
quarantine + `is_file()`-only source; `endSession`/`killAllAgents` purge every new
per-session map; bounded `.bad` retention (oldest-first cap).

MED fixed: diagnose-once-per-episode for no-match; whitespace rejected in the
resolver; **slim** protocol reminder updated to minimal/report-first; shell sample
quoted + `trap` cleanup; **NUL key delimiters → `::`** (files are text again);
`Cargo.lock` committed.

New regression tests: reopen-CAS signal-loss, teardown non-ack, oversize soft-fail,
`endSession` purge, FIFO/non-regular reject, author-wins, nested/injection report
paths.

## Second review round — adversarial concurrency verification (5 passes)

After the first hardening round, a focused adversarial re-review of the reopen/
reassign concurrency guard found FOUR more genuine, progressively-narrower
signal-loss/re-completion bugs — each fixed, then re-verified:
1. Fire-and-forget quarantine race → **synchronous supersession tombstone**.
2. Stale point-check; reopen during the report-inspect await slipped past →
   **`terminalizeWithAck` checks the tombstone at start + in the CAS**.
3. Per-task tombstone consumed per-file (short-id + full-id both resolve to one
   task) → **generational tombstone** (mtime ≤ reopen-time = stale; all siblings
   blocked; only a signal newer than the reopen proceeds).
4. TOCTOU across the mtime await (a 2nd reopen's newer generation blindly
   discarded) → **compare-and-delete** (clear only if the generation is
   unchanged).

Round-5 adversarial verification: **CLEAN** — the four fixes compose with no gap;
the invariant (a superseded task is never re-completed and its signal never lost)
holds across all reachable interleavings on a single-machine monotonic clock.
Residual items are NON-BLOCKING nits that all fail safe (conservative same-ms
tie / NTP-backward-step → false-quarantine, never wrong completion; one
forensic-only delete-vs-quarantine of an already-consumed stale duplicate).

Dedicated interleaving tests added: B1 race-realistic (signal stays listed),
B1-window (reopen inside the inspect await), B1-two-files (short+full both
quarantined), B1-toctou (reassign inside the mtime await), B1-permanent
(quarantine keeps failing → never re-completes). Reopen-test mtimes are genuinely
pre-reopen so they prove the generational logic, not same-millisecond luck.

Final validation: tsc clean · **485 vitest** · **95 Rust** (13 memory) · 0 failed ·
worktree clean · 0 NUL bytes.

## Per-item outcomes
All 21 queue items `completed` + the hardening round; see `.implementer-state.json`.
Commits: `c52e86c` (codec), `0a91338` (Rust IPCs), `d4279bc` (/task), `d82e8f1`
(txn + scanner + protocol), `c76c978` (tests + txn fix), `10ef69c` (report),
**`<hardening>`** (post-review fixes + Cargo.lock).

## Scope-discipline self-check
- [x] No new interfaces / files outside the plan's package layout
- [x] No renames of committed public names (additive IPC methods + store methods)
- [x] No signature changes on planner-committed methods
- [x] No edits to validation-command configuration
- [x] No edits to files outside the work queue's hint set
