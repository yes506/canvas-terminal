# Plan — Collaborator completion-signal hardening (rev 3)

**Scale lane:** feature · **Planner ID:** 77064-88673-515 · **Base branch:** dev
**Lineage:** task-4/5/11 diagnosis → task-11 synthesis → rev-1 → round-1 plan
review (task-12/13/14/16) → rev-2 → round-2 plan review (task-19/20/21/22) →
**rev 3** folding round-2. (claude3/task-15 still pending; won't change scope.)

> **Rev-3 changes** (round-2 review): (C1) `durableTerminalize` re-specified as a
> real **persistence-acknowledged** transaction (persistTasks swallows errors, so
> awaiting it proves nothing); (C2) foreign-session "leave it" → **`wrong_session`
> diagnose+quarantine** (scoped memory makes a sibling scanner unable to see the
> file); (C3) **concurrency-safe, time-based stability gate** that also gates the
> diagnostic; (C4) missing/unreadable `report_path` on an otherwise-valid signal
> **soft-fails** (terminalize+diagnose), never quarantine; (C5) protocol writes
> **report first, signal last**. Plus refinements (precedence, honest diagnostic
> durability, narrowed goal, no-clobber quarantine, resolver grammar, basename
> semantics, `.bad` GC, DAG seams).

## Goal

Harden the pipeline for **present** completion signals so a finished mini-agent's
task reliably terminalizes **with its review discoverable by the orchestrator**,
and so every residual failure is **classified, recoverable, and visible** instead
of silently swallowed. Three honest sub-goals:
1. **Prevent** the common malformed-JSON source (minimal-field protocol; prose →
   a separate `.md`).
2. **Observe/recover** every failure of a signal that EXISTS: typed disposition,
   concurrency-safe stabilized quarantine, and a peer-visible (best-effort)
   conversation-log diagnostic carrying an actionable recovery hint.
3. **Disambiguate** terminalization (exact-first resolver) so `task-1` never
   terminalizes `task-10`.

**Explicit non-goals / honest limits:** this feature only sees signals that were
actually written into the session directory. A signal that is **never written**,
or written to the **wrong directory / unexpanded path**, remains undiagnosed here
(co-primary residual mode from the diagnosis) — tracked as the P1/activity-tracker
follow-up. Quarantine/nudge make failures *diagnosable*; they do not by
themselves *terminalize* a stuck task — only a reachable signal or an explicit
human/agent `/task <full-id> done` does.

Root cause (peer-confirmed): both symptoms are one un-terminalized task;
`scanForTaskCompletions` silently swallows every ingestion failure. Header
(`getAgentTaskState → in_progress`) and peer `pending` read the same status.

## In scope (4 workstreams; P1 deferred)

- **P0a — Fail-loud, typed failure taxonomy** (replaces the silent empty catch).
- **P0b — Minimal-heredoc protocol** (prevention at source; report-first ordering).
- **P0c — Legacy-compatible strict schema** (+ split shape/reference validation).
- **P0d — Exact-first shared id resolver** (scanner + orphan + `/task`).

## Deferred to a follow-up
- **P1 — missing-signal watchdog / absent-signal detection.** Needs real
  PTY-quiescence telemetry (`getAgentTaskState` is task-derived; capture exposes
  no idle timestamp) AND covers absent/wrong-directory signals P0a can't see.
  Its own feature (an `AgentActivityTracker`). Linked follow-up, not "someday."

## Out of scope
- The indicator / `getAgentTaskState` seam (Claim 0 correct).
- Lenient JSON repair / heuristic field extraction (rejected).
- Auto-completing tasks from idle heuristics.
- Task-ledger **rehydration on reload** (`tasksBySession` is `{}` on cold boot;
  nothing parses the markdown back — a pre-existing, separate limitation; C1's
  "persistence-acknowledged" is NOT reload-survival). Conversation-log **format**
  redesign (appending a new structured entry via existing `appendLog` is fine).

## Constraints
- TS: Zustand + React. Rust: Tauri v2 over path-validated, symlink-protected
  shared memory.
- **Preserve every documented race guard** in `scanForTaskCompletions`
  (in-loop task re-read, per-iteration `tasksBySession` re-read, 24h orphan grace
  + backward-clock clamp, teardown/abort guards).
- **Preserve partial-write tolerance** (the current silent-catch accidentally has
  it) via the concurrency-safe stability gate (C3) — never quarantine on first
  sight.
- **Backward compatible:** legacy hand-authored `done.json` (full/stripped id,
  optional author/`agent` alias, optional prose) still ingests. Protocol rollout
  is per-newly-spawned agent; already-running agents keep the legacy heredoc.
- `collabCompletion.ts` store-independent: `resolveTaskId<T extends {id:string}>`,
  no `CollabTask` import.
- No hardcoded versions; pre-commit hooks run.

## Success criteria
- No ingestion failure of an EXISTING signal is silent: each is classified and
  gets an actionable diagnostic (in-memory always; best-effort conversation-log
  persist with **console fallback that always executes**; retained quarantine
  artifact as forensic truth). Bad files are quarantined only after the stability
  gate; never silently deleted or re-failed forever.
- A partial mid-write legacy file is NOT quarantined and produces NO peer-visible
  diagnostic on first sight (both gated on stability).
- No-match preserves the 24h grace; a `wrong_session` file is diagnosed +
  quarantined (not stranded); transient read/list/stat IPC errors are retried,
  never quarantined.
- A completed task's Task Report contains a **discoverable reference** to the
  review (via `report_path`); a valid completion with a merely-missing report
  **terminalizes** (soft-fail) rather than hanging.
- Signal deletion happens only after the **task-ledger** write is
  **acknowledged** (strict, non-swallowing); on failure the signal is retained +
  retried, with terminal side effects emitted **exactly once**.
- `task_id "task-1"` never terminalizes `task-10`; resolver exact-first + shared.
- `tsc --noEmit`, `cargo test` (memory cmd), `npm run test` clean; existing
  collaborator tests green.

## Package layout
```
src/lib/collabCompletion.ts   ★ NEW — validateSignal (codec, pure shape),
   resolveTaskId (exact-first, generic), classifyFailure/shouldQuarantine (policy),
   StabilityTracker (module-level). Store-independent.
src/lib/scopedCollabMemory.ts edit — quarantineMemoryFile wrapper; report-ref stat/read
src/stores/collaboratorStore.ts edit — P0b protocol edit; scan→ingestSignalFile;
   TerminalizationTxn (persistTasksStrict + receipt); report-ref async validate +
   precedence mapping; reportIngestFailure via appendLog + console fallback; race guards
src/components/collaborator/commands.ts edit — /task uses resolveTaskId
src-tauri/src/commands/memory.rs edit — quarantine_memory_file (no-clobber, symlink-guarded);
   persistence: reuse write_memory_file_atomic; register in lib.rs
tests: src/lib/collabCompletion.test.ts (new); src/stores/collaboratorStore.test.ts
   (scanner + txn); src/components/collaborator/commands.test.ts (new; /task resolver);
   Rust memory tests (cargo test)
```
Dependency direction (inward, acyclic): `collaboratorStore.ts`, `commands.ts` →
`lib/collabCompletion.ts` (pure); `collaboratorStore.ts` → `lib/scopedCollabMemory.ts`
→ IPC → `memory.rs`. DAG in `plan.mmd`.

## Decomposition
One method = one node.

| Node | Stage | Interface | Method | File |
|---|---|---|---|---|
| N1 | Minimal-signal protocol; **report-first** ordering (P0b, C5) | CompletionProtocol | renderMinimalSignalTemplate | collaboratorStore.ts (protocol string) |
| N2 | List candidate `*.done.json` | MemorySignalStore | listMemoryFiles *(exists)* | scopedCollabMemory.ts |
| N3 | Read raw signal | MemorySignalStore | readMemoryFile *(exists)* | scopedCollabMemory.ts |
| N4 | Parse + legacy schema + **pure report-path shape** (P0c) | CompletionCodec | validateSignal(raw, fileName) | collabCompletion.ts |
| N5 | Exact-first id resolve, generic (P0d) | TaskIdResolver | resolveTaskId(tasks, id) | collabCompletion.ts |
| N6 | Classify failure → disposition (P0a) | IngestFailurePolicy | classifyFailure | collabCompletion.ts |
| N7 | Concurrency-safe stability gate (P0a, C3) | StabilityTracker | observe / shouldQuarantine | collabCompletion.ts (+ getMemoryFileMtime) |
| N8 | **Async** report-ref validate; **soft-fail** missing (C4) | ReportRefValidator | validateReportRef(session, path) | collaboratorStore.ts / scopedCollabMemory.ts |
| N9 | Persistence-acknowledged terminalize (C1) | TerminalizationTxn | terminalizeWithAck(task, signal) | collaboratorStore.ts |
| N10 | Strict, non-swallowing ledger write (C1) | TaskLedger | persistTasksStrict(session, snapshot) | collaboratorStore.ts |
| N11 | Terminal-but-unpersisted receipt (C1) | TerminalizationReceipt | mark / consume | collaboratorStore.ts |
| N12 | Quarantine bad file (TS wrapper) | MemorySignalStore | quarantineMemoryFile | scopedCollabMemory.ts |
| N13 | Rust no-clobber quarantine (P0a) | QuarantineCmd | quarantine_memory_file | memory.rs |
| N14 | Peer-visible diagnostic + console fallback (P0a) | IngestDiagnostics | reportIngestFailure(reason, path, hint) | collaboratorStore.ts (appendLog) |
| N15 | Per-file ingest (orchestrates N3→N14) | CompletionScanner | ingestSignalFile(session, relPath) | collaboratorStore.ts |
| N16 | Scan driver; race guards (P0a) | CompletionScanner | scanForTaskCompletions *(rework)* | collaboratorStore.ts |
| N17 | Reuse resolver in `/task` (P0d) | SlashCommands | resolveTaskIdReuse | commands.ts |

### Failure taxonomy (N6/N7)
| Failure | Disposition |
|---|---|
| Content/schema error (bad JSON, wrong types/status, filename↔payload mismatch) | Diagnose **only when stable** (C3); quarantine only when stable. First unstable observation = internal telemetry, no peer log entry. |
| Ambiguous id | Diagnose + quarantine (never guess). |
| No match, **own session**, < grace | Preserve 24h grace: diagnose once + retain; quarantine (not delete) only after grace. |
| **`wrong_session`** (id matches a task in another loaded session) (C2) | Diagnose (name owning session/task when safe) + quarantine after grace. NEVER "leave it" (scoped memory → sibling scanner can't see the file) and never auto-move cross-session. |
| Valid+matched signal, `report_path` **absent/unreadable** (C4) | **SOFT**: terminalize the task + diagnose missing report. NOT quarantine. |
| Valid+matched, `report_path` **traversal/oversize/unsafe shape** | Terminalize + drop the reference + diagnose (security). |
| Transient read/stat IPC error | Diagnose/rate-limit + retry. NEVER quarantine (content unknown). |
| List IPC error (N2) | Session-level diagnostic + retry (no file to quarantine). |
| Ledger-persist failure after terminalize (C1) | Retain signal + receipt; retry; do NOT delete; emit side effects exactly once. |
| Delete-after-ack failure | Retain + retry on next scan's already-terminal branch. |
| File-gone race | Benign no-op. |

### Stability gate (N7 — pinned, concurrency-safe)
- Fingerprint = `(mtime, rawLength_or_contentHash, errorCategory)`. **IPC has no
  file size** → fingerprint uses `raw.length` (or a content hash), named
  explicitly; mtime from `getMemoryFileMtime`.
- Confirmed content-failure requires: identical fingerprint across **≥2
  observations SEPARATED BY a minimum elapsed interval** AND mtime older than a
  minimum age at the final observation.
- Any mtime/length/hash/error change **resets** the record.
- A per-`(session,relPath)` **in-flight guard** so two overlapping scans
  (onFlush + poll + exit) cannot advance the count twice on the same instant.
- Tracker is **module/store-level** (persists across scan calls), bounded, and
  **purged** on success / quarantine / file-gone / session teardown / TTL.
- **Both** quarantine AND the peer-visible diagnostic are gated on this
  stability — no false alarm from a mid-write file.

### Persistence-acknowledged terminalization (N9/N10/N11 — pinned, C1)
- "Durable" is NOT claimed (`writeMemoryFile` is not fsync'd). Guarantee =
  **task-ledger write acknowledged** before signal deletion.
- **Guarantee scope (planner decision, overridable):** the **task ledger** is the
  acknowledged source of truth; the conversation **Task Report** (appendLog,
  swallows) is **best-effort + console fallback + retained artifact** — NOT gated
  on strict ack (gating on it would strand completions on any log hiccup; the
  ledger carries terminal state; the report is reconstructable).
- Flow: compute post-update snapshot → `persistTasksStrict` (a strict variant of
  `persistTasks` that **rejects on IPC failure**, serialized through the existing
  per-session write chain, using the supplied snapshot) → on ack, commit terminal
  in-memory state + emit Task Report/outcome/unread **exactly once** →
  `TerminalizationReceipt.mark` → delete signal → `consume`. On reject: leave task
  active, retain signal + receipt, diagnose, retry. The already-terminal
  short-circuit consults the receipt: **do not delete** a terminal-but-unpersisted
  signal; retry persistence first. Retry is idempotent (a write-committed /
  response-rejected IPC must not duplicate the Task Report).
- Concurrency: define behavior vs. two scanners, a queued older `persistTasks`
  (must not overwrite the acked snapshot), a concurrent human `/task done`, and
  teardown.

### Per-node contract highlights
- **N1** — edit `TASK_PROTOCOL` heredoc + slim reminder: agents write the report
  `.md` **first** (temp + `mv`), then a `done.json` with `{task_id, status,
  author?, report_path}` only (no free prose). Deterministic session-relative
  report name from the canonical id; JSON carries the relative path (shell writes
  the absolute path). Legacy prose still accepted on ingest.
- **N4** — pure: parse (caller-safe, no throw escapes); `task_id` required;
  `status ∈ {completed,blocked}`; `author`/`agent`/prose optional +
  non-empty-after-trim when present; `report_path` **shape** only (non-empty
  session-relative, no absolute/traversal, `.md`/deterministic name, not the
  signal itself). filename↔payload agreement via the **shared canonicalizer**:
  remove exactly one `.done.json` suffix from the basename, then exact-or-stripped
  equality (all four full/short pairs valid; unrelated prefixes rejected).
- **N5** — `resolveTaskId<T extends {id:string}>(tasks, id)`: exact `t.id===id`
  unique wins; else if `id` matches `^task-[1-9]\d*$`, unique normalized
  (`^task-[1-9]\d*-\d{13}$` full) wins; >1 → ambiguous; reject whitespace/
  prefixes/extra suffixes. Pure.
- **N8** — async: existence + bounded-size via scoped memory; **no-symlink-follow**
  (regular sibling basename only). Missing/unreadable → SOFT (see taxonomy).
- **N8 precedence** — one `output` field: if legacy `output` AND `report_path`
  both present, **preserve legacy output + append a stable `Report: <path>`
  reference** (discard neither). Escape/truncate the path before embedding in
  Markdown (Task Report + diagnostics). Mapping the path makes the review
  *discoverable*, not inlined.
- **N13** — Rust `quarantine_memory_file(session, rel)`: **no-clobber under
  concurrency** — unique destination + exclusive-create sentinel (or platform
  no-replace rename with a safe fallback; macOS lacks `RENAME_NOREPLACE`), proven
  by a concurrent test that neither artifact is overwritten. source/dest are
  regular-file paths; existing parents are dirs + non-symlink; same-session /
  same-parent / same-fs; no directory move; returns the actual dest. Register in
  lib.rs.
- **N14** — one structured `appendLog("system", …)` when stable; include the
  actual quarantine `.bad` path (when quarantined) and a recovery hint
  (`/task <full-id> done`) when the id is known. **Console fallback always
  executes.** Dedupe by `(session,path,reason)`; cleared on corrected-success /
  quarantine / file-gone / teardown / TTL. Never throws into the scan loop.
- **N15/N16** — keep the loop 1:1 with today's; move parse/match/fail-handling
  into codec/resolver/policy; retain already-terminal short-circuit (receipt-aware)
  + per-iteration re-reads + grace.
- **`.bad` retention** — bounded cap/age or documented manual-triage; never GC a
  fresh artifact before its diagnostic can be investigated.

## Validation
Feature/plan-only → Phase-7 smoke-check (headers + `graph LR`). Implementer-time:
`tsc --noEmit`; `cargo test` (rename/quarantine path-safety — `cargo check` can't
verify it); `npm run test`.

Regression matrix (implementer adds): malformed JSON; missing/mis-cased `task_id`;
legacy no-author assignee fallback; author-vs-`agent` disagreement; invalid
status; **two overlapping scans on a live partial file do NOT satisfy stability
and produce NO false diagnostic**; content change resets the timer; no-match keeps
grace / `wrong_session` diagnosed-not-stranded / post-grace quarantine; transient
read/list/stat retried not quarantined; **ledger-persist failure retains signal +
receipt, retry deletes only after ack, side effects exactly once, queued older
write can't overwrite acked snapshot**; report-first vs signal-before-report
retry; **missing report soft-fails (terminalizes)**; report symlink / nested path
/ Markdown metachars / size boundary; legacy `output` + `report_path` precedence;
quarantine no-clobber collision + concurrent + source-gone; `task-1` vs `task-10`
both orderings + arbitrary-prefix/extra-suffix rejection; diagnostic dedupe/TTL
reset; console fallback on appendLog failure; Rust traversal/symlink/dir/parent
matrix; `/task` none vs ambiguous distinct messages; protocol-template render.

## Open questions — RESOLVED (pinned)
1. Diagnostic surface → conversation-log structured entry (appendLog) + console
   fallback; NOT toastStore (renderer in DrawingBoard.tsx, may not mount on
   collaborator routes).
2. Quarantine primitive → dedicated no-clobber `quarantine_memory_file`. Exists.
3. Durability scope → task-ledger acknowledged (strict); Task Report best-effort.
   (Overridable — see C1.)
4. P1 watchdog / absent-signal → deferred follow-up.

## Risks
- Reworking the scanner risks race-guard + partial-write regressions — mitigated
  by 1:1 loop structure + concurrency-safe stability gate + receipt-aware
  already-terminal branch.
- The new async persistence/report window widens concurrency surface — mitigated
  by the receipt + exactly-once side effects + explicit concurrency tests.
- Protocol edit changes agent behavior — mitigated by fully backward-compatible
  legacy ingestion.
