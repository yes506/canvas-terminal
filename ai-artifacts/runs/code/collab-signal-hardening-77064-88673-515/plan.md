# Plan — Collaborator completion-signal hardening (rev 4)

**Scale lane:** feature · **Planner ID:** 77064-88673-515 · **Base branch:** dev
**Lineage:** diagnosis (task-4/5/11) → rev-1 → R1 review (12/13/14/16) → rev-2 →
R2 review (19/20/21/22) → rev-3 → R3 review (25/26/27/28 + late claude3/15) →
**rev 4**. R3 reviewers' stated approval condition: B1 (txn race) + B2 (no-follow
report IPC) + pinned stability constants — all folded here.

> **Rev-4 changes:** (C1) persistence txn re-specified as a **linearizable,
> terminal-first** transaction with a monotonic ledger-revision fence + snapshot
> constructed **inside** the chain turn (fixes the stale-snapshot clobber);
> (C2) added a purpose-built **`inspect_report_file`** no-follow Rust IPC (the
> existing read/mtime IPCs follow symlinks); (G1) `report_path` shape+existence
> are **never** `ok:false` (kept out of `validateSignal`'s reject path); pinned
> stability **constants** + injected clock + content hash; ambiguity gated on
> stability; author-precedence; signal also temp+`mv`; one `.bad` retention
> policy; both quarantine endpoints validated.

## Goal

Harden the pipeline for **present** completion signals so a finished mini-agent's
task reliably terminalizes **with its review discoverable by the orchestrator**,
and every residual failure is **classified, recoverable, and visible** rather
than silently swallowed. Sub-goals: **Prevent** (minimal-field protocol, prose →
a separate `.md`), **Observe/recover** (typed disposition + stabilized quarantine
+ peer-visible diagnostic), **Disambiguate** (exact-first resolver).

**Honest limits:** only signals actually written into the correct session dir are
seen. Absent / wrong-directory / unexpanded-path signals stay undiagnosed here
(co-primary residual mode) → the deferred P1/activity-tracker follow-up.
Quarantine/nudge make failures *diagnosable*, not *terminal* — only a reachable
signal or an explicit `/task <full-id> done` terminalizes.

## In scope (4 workstreams; P1 deferred)
P0a fail-loud typed taxonomy · P0b minimal-heredoc protocol (report-first) ·
P0c legacy-compatible strict schema (+ split shape/reference validation) ·
P0d exact-first shared resolver.

## Deferred
P1 missing-signal watchdog / absent-signal detection — needs real PTY-quiescence
telemetry (`getAgentTaskState` is task-derived; capture exposes no idle
timestamp) and covers absent/wrong-dir signals P0a can't see. Own feature
(`AgentActivityTracker`). Linked follow-up.

## Out of scope
`getAgentTaskState` seam (Claim 0 correct); lenient JSON repair; idle-heuristic
auto-complete; task-ledger **rehydration on reload** (`tasksBySession` is `{}` on
cold boot — persistence-ack is NOT reload-survival); conversation-log **format**
redesign (a new `appendLog` entry is fine).

## Constraints
- TS Zustand + React; Rust Tauri v2 over path-validated symlink-protected shared
  memory.
- **Preserve race guards** (in-loop task re-read, per-iteration `tasksBySession`
  re-read, 24h orphan grace + backward-clock clamp, teardown/abort).
- **Preserve partial-write tolerance** via the concurrency-safe stability gate.
- **Backward compatible**: legacy `done.json` (full/stripped id, optional
  author/`agent`, optional prose) still ingests; protocol rollout is
  per-newly-spawned agent.
- `collabCompletion.ts` store-independent (`resolveTaskId<T extends {id:string}>`,
  no `CollabTask` import); pure policy vs mutable tracker are **separate exports**.
- No hardcoded versions; pre-commit hooks run.

## Success criteria
- No ingestion failure of an existing signal is silent: classified + actionable
  diagnostic (in-memory always; best-effort conversation-log persist with
  **console fallback that always executes**; retained quarantine artifact as
  forensic truth). Bad files quarantined only after the stability gate.
- A partial mid-write file is NOT quarantined and produces NO peer diagnostic on
  first sight.
- No-match keeps the 24h grace; `wrong_session` is diagnosed + quarantined (not
  stranded); transient read/list/stat IPC errors are retried, never quarantined.
- A completed task's Task Report carries a discoverable review reference; a valid
  completion whose report is merely missing/unsafe **terminalizes** (soft-fail).
- Signal deletion happens only after the **task-ledger revision is acknowledged**;
  no concurrent ordinary write can revert the acked terminal ledger; terminal
  side effects fire **exactly once**.
- `task_id "task-1"` never terminalizes `task-10`; resolver exact-first + shared.
- `tsc --noEmit`, `cargo test` (memory cmds), `npm run test` clean; existing
  collaborator tests green.

## Package layout
```
src/lib/collabCompletion.ts   ★ NEW — validateSignal (pure shape+schema),
   resolveTaskId (exact-first, generic), classifyFailure/shouldQuarantine (policy),
   StabilityTracker (instantiable, injected clock). Store-independent; pure-policy
   and tracker are separate exports.
src/lib/scopedCollabMemory.ts edit — quarantineMemoryFile wrapper; inspectReportFile wrapper
src/stores/collaboratorStore.ts edit — P0b protocol edit; scan→ingestSignalFile;
   TerminalizationTxn (persistTasksStrict + revision fence + receipt); report-ref async
   inspect + precedence mapping; reportIngestFailure via appendLog + console fallback; race guards
src/components/collaborator/commands.ts edit — /task uses resolveTaskId
src-tauri/src/commands/memory.rs edit — NEW quarantine_memory_file (no-clobber, BOTH endpoints
   validated); NEW inspect_report_file (symlink_metadata, no-follow, {exists,is_regular,size});
   reuse write_memory_file_atomic for strict ledger write; register both in lib.rs
tests: src/lib/collabCompletion.test.ts (new); src/stores/collaboratorStore.test.ts (scanner+txn);
   src/components/collaborator/commands.test.ts (new); Rust memory tests (cargo test)
```
Direction (inward, acyclic): store/commands → `collabCompletion.ts` (pure);
store → `scopedCollabMemory.ts` → IPC → `memory.rs`. DAG in `plan.mmd`
(`CompletionProtocol → CompletionScanner` = filesystem DATA FLOW, not a
compile-time dep).

## Decomposition
One method = one node.

| Node | Stage | Interface | Method | File |
|---|---|---|---|---|
| N1 | Minimal-signal protocol; report+signal temp+`mv`, report-first (P0b) | CompletionProtocol | renderMinimalSignalTemplate | collaboratorStore.ts |
| N2 | List `*.done.json` | MemorySignalStore | listMemoryFiles *(exists)* | scopedCollabMemory.ts |
| N3 | Read raw signal | MemorySignalStore | readMemoryFile *(exists)* | scopedCollabMemory.ts |
| N4 | Parse + schema + **report-path shape (flag, never ok:false)** (P0c, G1) | CompletionCodec | validateSignal(raw, fileName) | collabCompletion.ts |
| N5 | Exact-first id resolve, generic (P0d) | TaskIdResolver | resolveTaskId(tasks, id) | collabCompletion.ts |
| N6 | Classify failure → disposition (P0a) | IngestFailurePolicy | classifyFailure | collabCompletion.ts |
| N7 | Concurrency-safe stability gate, pinned constants (P0a) | StabilityTracker | observe / shouldQuarantine | collabCompletion.ts |
| N8 | **No-follow** report inspect → attach/drop reference (C2, C4) | ReportFileInspector | inspect_report_file | memory.rs / scopedCollabMemory.ts |
| N9 | Linearizable terminal-first txn (C1) | TerminalizationTxn | terminalizeWithAck(task, signal) | collaboratorStore.ts |
| N10 | Strict, non-swallowing, revision-fenced ledger write (C1) | TaskLedger | persistTasksStrict(session, snapshot, rev) | collaboratorStore.ts |
| N11 | Receipt with explicit phases (C1) | TerminalizationReceipt | mark / consume | collaboratorStore.ts |
| N12 | Quarantine bad file (TS wrapper) | MemorySignalStore | quarantineMemoryFile | scopedCollabMemory.ts |
| N13 | Rust no-clobber quarantine, both endpoints (P0a) | QuarantineCmd | quarantine_memory_file | memory.rs |
| N14 | Peer-visible diagnostic + console fallback (P0a) | IngestDiagnostics | reportIngestFailure(reason, path, hint) | collaboratorStore.ts |
| N15 | Per-file ingest (orchestrates N3→N14) | CompletionScanner | ingestSignalFile(session, relPath) | collaboratorStore.ts |
| N16 | Scan driver; race guards (P0a) | CompletionScanner | scanForTaskCompletions *(rework)* | collaboratorStore.ts |
| N17 | Reuse resolver in `/task` (P0d) | SlashCommands | resolveTaskIdReuse | commands.ts |

### Failure taxonomy (N6/N7)
| Failure | Disposition |
|---|---|
| Content/schema error (bad JSON, wrong types/status, filename↔payload mismatch) | Diagnose + quarantine **only when stable** (N7). First unstable observation = internal telemetry (no peer log entry, no quarantine). |
| **Ambiguous id** | Same **stability gate** (content-derived), then diagnose + quarantine. Never guess. |
| No match, own session, < grace | Preserve 24h grace: diagnose once + retain; quarantine (not delete) only after grace. |
| `wrong_session` (unique match in another loaded session) | Diagnose (name owner) + quarantine after grace. Never "leave it" (scoped memory) / never auto-move. |
| Valid+matched, `report_path` **absent** | Terminalize; no error (legacy/no-report is normal). |
| Valid+matched, `report_path` **supplied but missing/unsafe/oversize/symlink** | **SOFT**: terminalize + **omit reference** + diagnose. Never quarantine. |
| Transient **report**-stat IPC error | Soft-terminalize (distinct from signal-file read error, which retries). |
| Transient **signal** read/stat IPC error | Diagnose/rate-limit + retry. Never quarantine. |
| List IPC error (N2) | Session-level diagnostic + retry. |
| Ledger-persist failure after terminal mark (C1) | Keep terminal+signal+receipt; retry idempotent; do NOT delete; side effects still pending. |
| Delete-after-ack failure | Retain + retry via receipt-aware already-terminal branch. |
| File-gone race | Benign no-op. |
| Exact unique match, valid | Proceed immediately (no stability wait). |

### Stability gate (N7 — pinned)
- Fingerprint = `(mtime, contentHash, errorCategory)`. **IPC has no size** →
  **content hash** (not raw length: a same-length edit must reset). mtime from
  `getMemoryFileMtime`.
- Confirmed content-failure requires: identical fingerprint across **≥2
  observations separated by `STABILITY_MIN_INTERVAL_MS` (> one 2 s poll, e.g.
  3000 ms)** AND mtime older than `STABILITY_MIN_AGE_MS` (e.g. 2500 ms) at the
  final observation. Exported named constants; boundary (`>=`) documented.
- Any mtime/hash/error change resets the record.
- Per-`(session,relPath)` **in-flight guard wraps the WHOLE `ingestSignalFile`**
  (not just `observe`), so overlapping scans can't double-enter
  validate/inspect/txn/quarantine/diagnostic.
- `StabilityTracker` is **instantiable with an injected clock** (fake-timer
  tests), module/store-scoped instance, bounded, purged on
  success/quarantine/file-gone/teardown/TTL.
- **Both** quarantine AND the peer diagnostic gate on stability.

### Linearizable terminal-first transaction (N9/N10/N11 — pinned, C1)
Guarantee = **task-ledger revision acknowledged** before signal deletion (NOT
fsync-durable, NOT reload-surviving). The conversation **Task Report** is
best-effort (console fallback + retained artifact); the ledger is source of truth.
Flow:
1. acquire per-`(session,task,signal)` txn guard (shared in-flight promise across
   overlapping scans);
2. re-read task; mark in-memory terminal **without emitting** Task Report/
   outcome/unread; receipt phase `terminal_unpersisted`; bump a **monotonic
   per-session ledger revision**;
3. enqueue `persistTasksStrict` on the existing per-session write chain; it
   **constructs the snapshot INSIDE its chain turn** (re-reads latest store
   state — NOT a call-time snapshot) and **rejects on IPC failure** (drops the
   inner `.catch`); it stamps the revision so a later stale ordinary write
   carrying an older revision cannot overwrite a newer acked ledger;
4. on ack → receipt `ledger_acknowledged` → emit Task Report/outcome/unread
   **exactly once** (`effects_emitted`) → delete signal → `consume`
   (`signal_deleted`);
5. on reject → keep terminal state + signal + receipt; retry the idempotent
   snapshot; the already-terminal branch consults the receipt and **never deletes**
   a `terminal_unpersisted` signal;
6. user reopen/reassign while in flight → revision/CAS decides the winner (define:
   an explicit reopen cancels the receipt).
Receipt keyed `(session, task, signalPath)`; phases
`terminal_unpersisted|ledger_acknowledged|effects_emitted|signal_deleted`; purge
on consume/file-gone/reopen/teardown/TTL. Ordinary `updateTask`/`bumpAssignedAt`
persists carry the current revision so they can't clobber a newer acked one.

### Per-node contract highlights
- **N1** — edit `TASK_PROTOCOL` heredoc + slim reminder: write the report `.md`
  to a temp path then `mv`; then write the minimal `{task_id, status, author?,
  report_path}` (no prose) to a temp path then `mv` (report-first ordering).
  Deterministic session-relative report name from the canonical id; JSON carries
  the relative path (shell writes absolute); define temp-file cleanup + shell
  quoting. Legacy prose still accepted on ingest.
- **N4** (pure) — parse (caller-safe); `task_id` required; `status ∈
  {completed,blocked}`; `author`/`agent`/prose optional + non-empty-after-trim;
  **`report_path` is NEVER a reject reason** — carried as an optional flag
  (`usable | unsafe-shape | absent`); only `task_id`/`status`/filename-agreement
  failures → `ok:false`. filename↔payload via the **shared canonicalizer**
  (remove exactly one `.done.json` from the basename, then exact-or-stripped
  equality). **author precedence** over legacy `agent` on disagreement (record
  ignored alias); assignee fallback when neither.
- **N5** — `resolveTaskId<T extends {id:string}>`: exact `t.id===id` unique wins;
  else `id` matching `^task-[1-9]\d*$` → unique normalized (full
  `^task-[1-9]\d*-\d{13}$`); >1 → ambiguous; reject whitespace/prefixes/suffixes.
- **N8** — async via `inspect_report_file` (Rust `symlink_metadata`, reject final
  + parent symlinks, require regular file + sibling `.md` + same-session, return
  `{exists,is_regular,size}`; **never reads content**). Store the exact validated
  relative path in state; if legacy `output` also present, **preserve it +
  append a stable `Report: <path>`** (discard neither). Escape/truncate only at
  Markdown render — never the stored path.
- **N13** — `quarantine_memory_file`: no-clobber under concurrency (unique dest +
  exclusive-create sentinel, or platform no-replace + safe fallback; macOS lacks
  `RENAME_NOREPLACE`), proven by a concurrent test; **validate BOTH `from_rel` and
  `to_rel`** (+ existing parents: dirs, non-symlink); same-session/parent/fs; no
  dir move; returns actual dest.
- **N14** — one `appendLog("system", …)` when stable; include original signal
  path + actual `.bad` dest (post-quarantine) + recovery hint (`/task <full-id>
  done`). **Console fallback always executes** (covers both ingestion diagnostics
  and, on Task-Report append failure, the terminal report text). Dedupe
  `(session,path,reason)`; cleared on corrected-success/quarantine/file-gone/
  teardown/TTL.
- **N15/N16** — loop 1:1 with today's; move parse/match/fail-handling into
  codec/resolver/policy; already-terminal branch is receipt-aware; retain
  per-iteration re-reads + grace.
- **`.bad` retention** — ONE policy: session-lifetime + per-session count/byte
  cap, oldest-first cleanup, never GC a fresh artifact before its diagnostic TTL;
  cleanup errors are non-critical diagnostics.

## Validation
Feature/plan-only → Phase-7 smoke-check. Implementer-time: `tsc --noEmit`;
`cargo test` (both new Rust cmds — path-safety); `npm run test`.

Regression matrix: malformed JSON; missing/mis-cased `task_id`; legacy no-author
assignee fallback; **author-vs-`agent` disagreement → author wins**; invalid
status; **two overlapping scans on a live partial file don't satisfy stability +
no false diagnostic**; same-length content change resets the timer; stability
constant boundaries (fake timers); no-match grace / `wrong_session` diagnosed /
post-grace quarantine; transient signal read/list/stat retried; **newer active
snapshot queued AFTER the strict terminal write cannot revert the ledger**;
ledger-persist failure retains signal+receipt, retry deletes only after ack, side
effects exactly once; receipt phase transitions + file-gone cleanup after
lost-delete-response; concurrent `/task done` / reassignment / teardown;
report-first vs signal-before-report; **missing/unsafe report soft-fails
(terminalizes)**; report final/parent/dangling symlink + directory + size
boundary via `inspect_report_file`; legacy `output` + `report_path` precedence;
quarantine no-clobber collision + concurrent + source-gone + BOTH-endpoint
validation; `task-1` vs `task-10` both orderings + prefix/suffix rejection;
diagnostic dedupe/TTL reset; console fallback on appendLog failure; canonical
signal temp+`mv`; `/task` none vs ambiguous distinct messages; protocol render.

## Open questions — RESOLVED (pinned; only the human gate may change these)
1. Diagnostic surface → conversation-log entry (appendLog) + console fallback.
2. Quarantine → dedicated no-clobber `quarantine_memory_file`.
3. Report validation → dedicated no-follow `inspect_report_file` (reference-only).
4. Durability scope → task-ledger revision acknowledged (strict); Task Report
   best-effort. **Fixed for the implementer.**
5. `.bad` retention → session-lifetime + per-session cap, oldest-first.
6. P1 watchdog / absent-signal → deferred follow-up.

## Risks
- Scanner rework vs race-guard/partial-write regressions → 1:1 loop + stability
  gate + receipt-aware already-terminal branch.
- New async persistence/inspect window widens concurrency surface → txn guard +
  revision fence + exactly-once effects + explicit concurrency tests (write them
  before the txn body — the subtlest part of the change).
- Protocol edit changes agent behavior → fully backward-compatible legacy ingest.
