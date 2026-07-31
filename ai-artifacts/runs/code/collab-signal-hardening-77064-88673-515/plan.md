# Plan — Collaborator completion-signal hardening (rev 2)

**Scale lane:** feature · **Planner ID:** 77064-88673-515 · **Base branch:** dev
**Origin:** task-4/5/11 diagnosis → task-11 synthesis → this plan → 5-peer plan
review (task-12/13/14/16 + task-15 pending) → **rev 2** folding that review.

> **Rev-2 changes vs rev 1** (from the plan review): P0b is now a **protocol
> change**, not an app-side writer (rev-1 N1/N2 were dead code — external CLI
> agents can't call an in-webview TS helper). Added a **typed failure taxonomy**
> (rev-1 "quarantine ANY failure" was unsafe). Added **report_path → Task Report
> mapping** (rev-1 minimal signal would have emptied the report and recreated the
> original bug). Diagnostic is now **peer-visible in the conversation log** (not a
> toast). Deletion is **coupled to durable persistence**. Schema is
> **legacy-compatible** (author/prose optional). Resolver is **exact-first**.
> **P1 watchdog deferred** to a follow-up (no reliable idle signal exists today).

## Goal

Make the collaborator completion-signal → task-terminalization pipeline
**prevent, recover, and observe** failures instead of failing silently, so a
finished mini-agent's task reliably terminalizes *with its review discoverable
by the orchestrator*. This does three distinct things (honest framing — fail-loud
alone does not "eliminate" a stuck task):
1. **Prevent** the common malformed-JSON source by removing free prose from the
   agent's `done.json` (protocol change).
2. **Recover/observe** every residual failure: typed disposition, stabilized
   quarantine, and a **peer-visible** diagnostic so the orchestrator (and human)
   can see and act on a stuck signal instead of it vanishing silently.
3. **Disambiguate** terminalization so `task-1` never terminalizes `task-10`.

Root cause (peer-confirmed): both symptoms are one fact — the task never reaches
a terminal state — and `scanForTaskCompletions` silently swallows every ingestion
failure. Header (`getAgentTaskState → in_progress`) and peer-visible `pending`
read that same un-terminalized status.

## In scope (4 workstreams; P1 deferred)

- **P0a — Fail-loud with a typed failure taxonomy.** Replace the silent empty
  `catch`. Each ingestion outcome gets an explicit disposition (below), a
  **conversation-log diagnostic** (peer-visible), and stabilized quarantine for
  genuinely-bad files. Never silently delete/re-fail.
- **P0b — Minimal-heredoc protocol (prevention at source).** Edit the injected
  protocol template so agents write a `done.json` with **only fixed fields**
  (`task_id`, `status`, optional `author`, `report_path`) and put all prose in a
  separate `task-<id>-report.md`. No app IPC (agents are external shells). The
  scanner maps `report_path` into the Task Report so the orchestrator still sees
  the review.
- **P0c — Legacy-compatible strict schema.** Validate types; `status ∈
  {completed, blocked}` (drop the `:1067` "anything → completed" coercion);
  `task_id` required; `author`/`agent`/prose (`reasoning`/`conclusion`/`output`)
  **optional but type-checked when present** (current scanner accepts no-author +
  assignee fallback — must keep working); `report_path` optional + validated
  (session-relative, no traversal, exists, bounded size, not the signal itself).
  filename↔payload agreement uses the **same strip-normalization as N-resolve**.
- **P0d — Exact-first shared id resolver.** Two-stage: (1) unique `t.id === id`
  wins immediately; (2) else, if `id` is a valid stripped id, unique
  normalized match (`strip = replace(/-\d{13}$/,'')`); >1 → ambiguous (fail
  closed). Grammar-aware; reject arbitrary prefixes. Shared by the scanner, the
  cross-session orphan check, AND `/task status|assign|done`
  (commands.ts:460/478/508).

## Deferred to a follow-up (not in this plan)

- **P1 — Missing-signal watchdog.** Requires a real quiescence signal
  (PTY-quiet + prompt-pattern), which the store does not have today
  (`getAgentTaskState` is task-derived; `agentOutputCapture` exposes no idle
  timestamp). Building an `AgentActivityTracker` is its own feature. P0a's
  peer-visible diagnostic already surfaces stuck signals, which is the
  orchestrator-visibility win; the watchdog is additive. Tracked as a separate
  intent.

## Out of scope

- The indicator / `getAgentTaskState` seam (Claim 0 confirmed correct).
- Lenient JSON repair / heuristic field extraction (peer consensus: rejected).
- Auto-completing tasks from idle heuristics.
- Conversation-log **format** redesign — but appending a **new structured
  diagnostic entry** via the existing `appendLog` path is in scope (that's an
  additive entry, not a format change).

## Constraints

- TS: Zustand + React. Rust: Tauri v2 over path-validated, symlink-protected
  shared memory (`~/.cache/canvas-terminal/collab-memory`).
- **Preserve every documented race guard** in `scanForTaskCompletions`: in-loop
  task re-read, per-iteration `tasksBySession` re-read, 24h orphan grace +
  backward-clock clamp, teardown/abort guards.
- **Preserve current partial-write tolerance.** The existing silent-catch
  accidentally tolerates a mid-heredoc-write file (skips, retries next scan).
  The new taxonomy MUST keep that: content-errors quarantine only after a
  **stability gate** (unchanged `(mtime,size,error)` across ≥2 scans, or a
  min-age), never on first sight.
- **Backward compatible:** legacy hand-authored `done.json` (full or stripped
  id, optional author, prose fields) still ingests. P0b changes only what the
  protocol *tells* agents to write going forward.
- `collabCompletion.ts` stays store-independent: accept
  `ReadonlyArray<{ id: string }>`, do not import `CollabTask` (keeps the
  dependency direction acyclic).
- No hardcoded versions; pre-commit hooks run.

## Success criteria

- No ingestion failure is silent: each is classified, gets a **conversation-log
  diagnostic the orchestrator can read**, and bad files are quarantined
  (stabilized) — never silently deleted or re-failed forever.
- A partial mid-write legacy file is NOT quarantined on first sight (no
  regression).
- A no-match signal preserves the 24h grace (not immediately quarantined);
  transient read/list/stat IPC errors are retried, never quarantined.
- A completed task's Task Report contains the review (via `report_path` mapping),
  so the orchestrator can reference it — the original complaint is resolved.
- `task_id "task-1"` never terminalizes `task-10`; the resolver is exact-first
  and shared with `/task`.
- Signal deletion happens only after durable ledger persistence is acknowledged;
  on persist failure the signal is retained + retried.
- Regression tests (below) pass; `tsc --noEmit`, `cargo test` (memory cmd),
  `npm run test` clean; existing collaborator tests stay green.

## Package layout

No new packages. One new shared TS module, one new Rust command, plus edits.

```
src/lib/collabCompletion.ts        ★ NEW — validateSignal (codec), resolveTaskId (exact-first),
                                            classifyFailure/shouldQuarantine (policy). Pure; store-independent.
src/lib/scopedCollabMemory.ts      edit  — add quarantineMemoryFile wrapper (calls Rust cmd)
src/stores/collaboratorStore.ts    edit  — P0b protocol-template edit (minimal fields + report_path convention);
                                           rework scan → ingestSignalFile using codec/resolver/policy;
                                           stability-gate state; report_path → Task Report mapping;
                                           durableTerminalize (await persist ack before delete);
                                           reportIngestFailure via appendLog (peer-visible); keep race guards
src/components/collaborator/commands.ts   edit — /task status|assign|done use resolveTaskId (P0d)
src-tauri/src/commands/memory.rs   edit  — NEW quarantine_memory_file (no-clobber, symlink-guarded,
                                           same-session/same-parent, regular-file-only); register in lib.rs
tests: src/lib/collabCompletion.test.ts (new), src/stores/collaboratorStore.test.ts (scanner + /task),
       Rust memory tests (cargo test)
```

Dependency direction — inward to the shared seam, no cycle:
`collaboratorStore.ts`, `commands.ts` → `lib/collabCompletion.ts` (pure) ;
`collaboratorStore.ts` → `lib/scopedCollabMemory.ts` → IPC → `memory.rs`.
`collabCompletion.ts` depends on nothing app-side.

## Decomposition

One method = one node.

| Node | Stage | Interface | Method | File |
|---|---|---|---|---|
| N1 | Minimal-signal protocol template (P0b, prevention) | CompletionProtocol | renderMinimalSignalTemplate | stores/collaboratorStore.ts (protocol string) |
| N2 | List candidate `*.done.json` | MemorySignalStore | listMemoryFiles *(exists)* | lib/scopedCollabMemory.ts |
| N3 | Read raw signal | MemorySignalStore | readMemoryFile *(exists)* | lib/scopedCollabMemory.ts |
| N4 | Parse + legacy-compatible schema (P0c) | CompletionCodec | validateSignal(raw, fileName) | lib/collabCompletion.ts |
| N5 | Exact-first id resolve (P0d) | TaskIdResolver | resolveTaskId(tasks, id) | lib/collabCompletion.ts |
| N6 | Classify failure → disposition (P0a) | IngestFailurePolicy | classifyFailure(kind) | lib/collabCompletion.ts |
| N7 | Stability gate for content-errors (P0a) | IngestFailurePolicy | shouldQuarantine(track) | lib/collabCompletion.ts (+ scanner-held state, getMemoryFileMtime) |
| N8 | Map report_path → Task Report (K2) | CompletionScanner | (in ingestSignalFile) sets `output`/keeps prose | stores/collaboratorStore.ts |
| N9 | Durable terminalize then delete (H-persist) | CompletionScanner | durableTerminalize(task, signal) | stores/collaboratorStore.ts |
| N10 | Quarantine bad file (TS wrapper) (P0a) | MemorySignalStore | quarantineMemoryFile | lib/scopedCollabMemory.ts |
| N11 | Rust no-clobber quarantine (P0a) | QuarantineCmd | quarantine_memory_file | src-tauri/src/commands/memory.rs |
| N12 | Peer-visible diagnostic (P0a, H-diag) | IngestDiagnostics | reportIngestFailure(reason, path) | stores/collaboratorStore.ts (appendLog) |
| N13 | Per-file ingest (orchestrates N3→N12) | CompletionScanner | ingestSignalFile(session, relPath) | stores/collaboratorStore.ts |
| N14 | Scan driver; preserves race guards (P0a) | CompletionScanner | scanForTaskCompletions *(rework)* | stores/collaboratorStore.ts |
| N15 | Reuse resolver in `/task` cmds (P0d) | SlashCommands | resolveTaskIdReuse | components/collaborator/commands.ts |

Interface-level DAG in `plan.mmd`.

### Failure taxonomy (N6/N7 — the heart of P0a)

| Failure | Disposition |
|---|---|
| Content/schema error (bad JSON, wrong types/status, filename↔payload mismatch) | Diagnose. Quarantine **only after stability gate** (unchanged `(mtime,size,error)` across ≥2 scans or min-age) — protects legacy partial writes. |
| Ambiguous id | Diagnose + quarantine (never guess). |
| No task match | **Preserve 24h grace**: re-read current + all sessions via the shared resolver; if matched elsewhere, leave it; if unmatched & younger than grace, diagnose once + retain; only after grace → quarantine (not silent delete). |
| Transient read/stat IPC error | Diagnose/rate-limit + retry. **Never quarantine** (content unknown). |
| List IPC error (N2) | Session-level diagnostic + retry (no file to quarantine). |
| Delete-after-terminalize failure | Retain + retry on next scan's already-terminal branch. Not an ingestion failure. |
| File-gone race | Benign no-op. |

### Per-node contracts (for the implementer — signatures fixed here)

- **N1** — edit the `TASK_PROTOCOL` heredoc + slim reminder in collaboratorStore.ts:
  agents write `{task_id, status, author?, report_path}` only; prose → a sibling
  `.md`. Legacy prose still accepted on ingest (compat).
- **N4 `validateSignal(raw, fileName) → {ok:true; value:Signal} | {ok:false; reason: IngestFailReason}`**
  — parse in a caller-safe wrapper (no throw escapes); `task_id` required;
  `status ∈ {completed,blocked}`; `author`/`agent`/prose/`report_path` optional +
  type-checked; filename↔payload agreement via `strip`-normalization (reuse N5's
  strip); `reason` is a typed enum consumed by N6/N12.
- **N5 `resolveTaskId(tasks: ReadonlyArray<{id:string}>, id) → {kind:"unique";task} | {kind:"none"} | {kind:"ambiguous";matches}`**
  — exact-first, then normalized-unique; grammar-aware. Pure; unit-tested.
- **N6/N7** — `classifyFailure` maps a reason/resolver-result to a disposition;
  `shouldQuarantine` consults per-`(session,path)` stability tracking (bounded,
  cleaned up) so content-errors only quarantine when stable/old.
- **N8** — on unique-match completion: set `output = report_path` when present
  (and keep any legacy `reasoning`/`conclusion`/`output`); the existing
  `updateTask` Task Report then carries a peer-discoverable reference. Validate
  `report_path` per P0c before use.
- **N9 `durableTerminalize(task, signal)`** — call the terminalizing update, then
  **await** a ledger-persist ack before `deleteMemoryFile`; on persist failure,
  retain the signal + diagnose + retry (do not delete).
- **N10 `quarantineMemoryFile(session, relPath) → Promise<{ok;path?}>`** — via N11.
- **N11 `quarantine_memory_file(collab_session_id, rel)`** — Rust; derives a
  no-clobber `.bad` destination (collision-safe ordinal); source+dest+parents
  regular-file/no-symlink; same-session/same-parent/same-fs; no directory; returns
  actual dest. Preserves the original bytes. (Purpose-built, not a general rename —
  smaller attack surface.) Register in lib.rs.
- **N12 `reportIngestFailure(reason, relPath)`** — append ONE structured
  `appendLog("system", …)` entry to the session conversation log (peer-visible),
  deduped by `(session,path,reason)` with TTL/cleanup; console detail. Never
  throws into the scan loop.
- **N13/N14** — keep the loop structure 1:1 with today's; move only
  parse/match/fail-handling into the codec/resolver/policy. Retain
  already-terminal short-circuit + per-iteration re-reads + grace.

## Validation

Feature lane, plan-only → no compile target at Phase 6; Phase 7 smoke-check
(headers + `graph LR`). Implementer-time: `tsc --noEmit`; `cargo test` for the
memory command (rename/quarantine behavior — `cargo check` alone can't verify
path safety); `npm run test`.

Regression matrix (implementer must add): malformed JSON; missing/mis-cased
`task_id`; legacy no-author + assignee fallback; invalid status; partial-write
NOT quarantined on first sight; no-match preserves grace / matches foreign
session / post-grace quarantine; transient read/list/stat retried not
quarantined; delete-after-terminalize retry; quarantine no-clobber collision +
source-gone + concurrent; `task-1` vs `task-10` both orderings; exact-full vs
stripped filename/payload (4 pairs); report_path mapping + missing/unsafe/oversized
path; diagnostic dedupe/TTL reset; durable-persist-failure retains signal; Rust
traversal/symlink/dir/parent matrix; `/task` none vs ambiguous distinct messages;
protocol-template render test.

## Open questions — RESOLVED (pinned; not left to the body-only implementer)

1. **Diagnostic surface** → conversation-log structured entry via `appendLog`
   (peer-visible), + console detail. (Not toastStore — its renderer lives in
   DrawingBoard.tsx and may not mount on collaborator routes.)
2. **Quarantine primitive** → dedicated `quarantine_memory_file` Rust command
   (no-clobber), NOT a general rename. N11 exists; not optional.
3. **P1 watchdog** → deferred to a separate follow-up feature.

## Risks

- Reworking `scanForTaskCompletions` risks regressing race guards + partial-write
  tolerance — mitigated by keeping N13/N14 1:1 with today's loop and the
  stability gate (N7).
- Schema tightening could reject a legacy signal — mitigated by keeping
  author/prose optional and only enumerating `status`.
- Protocol-template edit (N1) changes agent behavior — mitigated by keeping
  legacy ingestion fully backward-compatible, so old and new shapes coexist.
