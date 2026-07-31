# Plan — Collaborator completion-signal hardening

**Scale lane:** feature · **Planner ID:** 77064-88673-515 · **Base branch:** dev
**Origin:** task-4/5/11 diagnosis + 5-peer review (`session-14` collab memory:
`task-4-rootcause-claude1.md`, `task-5-verdict-{claude2,claude3,codex1,codex2,codex3}.md`,
`task-11-review-synthesis-claude1.md`).

## Goal

Eliminate the intermittent "a finished mini-agent stays `pending` to peers and
`processing` in its own header" failure by making the completion-signal →
task-terminalization pipeline **fail loud, robust, and unambiguous**. Root cause
(peer-confirmed): both symptoms are one fact — the agent's assigned task never
reaches a terminal state — and `scanForTaskCompletions` silently swallows every
ingestion failure (malformed JSON, missing/mis-cased `task_id`, no match, IPC
error), so a bad/mis-keyed signal never terminalizes and re-fails forever with
no diagnostic. Header light (`getAgentTaskState → in_progress`) and peer-visible
`pending` both read that same un-terminalized status.

## In scope (5 workstreams)

- **P0a — Kill the silent swallow.** On ANY ingestion failure, emit a
  rate-limited diagnostic and **quarantine** the file (`*.done.json.bad`) so it
  stops re-failing every tick. Surface a diagnostic *before* any orphan delete.
- **P0b — Robust-by-construction writer.** A TS helper builds a canonical
  minimal signal (`JSON.stringify`) and publishes it via the existing
  `write_memory_file_atomic` IPC (temp+rename). Long prose stays in the `.md`
  report; the terminal signal carries only `task_id`, `author`, `status`,
  `report_path`. Removes hand-authored heredoc JSON at the source.
- **P0c — Strict schema validation.** Object/type checks, `status ∈
  {completed, blocked}` (drop the current "anything-not-`blocked` → `completed`"
  coercion at collaboratorStore.ts:1067), `task_id` present, filename-id vs
  payload-id agreement.
- **P0d — Unified id resolver.** `strip(t.id) === strip(id) || t.id === id`
  (strip = remove trailing `-\d{13}`) with ambiguity detection (>1 match →
  report, never guess). Shared by the scanner, the orphan check, AND the
  `/task status|assign|done` commands (kills the `startsWith` collision at
  commands.ts:460/478/508 and collaboratorStore.ts:1019-1020).
- **P1 — Missing-signal watchdog.** When a running agent's assigned task stays
  non-terminal while the agent looks idle past a threshold, **nudge/flag only —
  never auto-complete** (an idle prompt may mean waiting-for-input / permission
  / blocker).

## Out of scope

- The indicator / `getAgentTaskState` logic (Claim 0 confirmed correct — do not
  touch the presentation seam).
- Lenient JSON repair / heuristic field extraction (3 peers: risks attaching
  prose to the wrong field or falsely terminalizing — rejected).
- Auto-completing tasks from idle-prompt heuristics.
- Peer-context-mirror or conversation-log format changes.

## Constraints

- TS: Zustand stores + React panels. Rust: Tauri v2 commands over the
  path-validated, symlink-protected shared memory
  (`~/.cache/canvas-terminal/collab-memory`).
- **Preserve every documented race guard** in `scanForTaskCompletions`
  (in-loop task re-read, per-iteration `tasksBySession` re-read, 24h orphan
  grace + backward-clock clamp, teardown/abort guards).
- **Backward compatible:** agents still hand-writing `done.json` must keep
  working — P0b is additive; ingestion (P0c/P0d) must accept both the legacy
  full-`task_id` shape and the stripped shape.
- No hardcoded language/framework versions. Pre-commit hooks run.
- URL-scheme / localfile invariants untouched (not in this path).

## Success criteria

- A malformed / missing-`task_id` / mis-keyed `done.json` no longer stalls
  silently: logged + quarantined, task made diagnosable, never re-failed forever.
- `task_id "task-1"` never terminalizes `task-10`; the same resolver backs the
  `/task` commands.
- The writer produces schema-valid signals by construction (atomic publish).
- Regression tests: malformed JSON, missing/mis-cased `task_id`, invalid status,
  `task-1` vs `task-10`, quarantine+diagnostic, atomic publish, missing-signal
  nudge.
- `tsc --noEmit` clean; `cargo check` clean (rename cmd); existing ~196
  collaborator tests still green.

## Package layout

No new packages. One new shared TS module + one new Rust command; the rest are
edits to existing files.

```
src/lib/collabCompletion.ts        ★ NEW  — CompletionCodec + TaskIdResolver + writer helper (pure/thin)
src/lib/scopedCollabMemory.ts      edit   — ensure writeMemoryFileAtomic wrapper; add quarantineMemoryFile
src/stores/collaboratorStore.ts    edit   — rework scanForTaskCompletions → ingestSignalFile using codec+resolver;
                                            diagnostic+quarantine; drop permissive status coercion; keep race guards
src/stores/toastStore.ts           edit   — reportIngestFailure surface (IngestDiagnostics)
src/components/collaborator/commands.ts        edit — /task uses resolveTaskId (P0d)
src/components/collaborator/CollaboratorPane.tsx edit — missing-signal watchdog tick (P1, flag only)
src-tauri/src/commands/memory.rs   edit   — NEW rename_memory_file (atomic quarantine); register in lib.rs
tests: collaboratorStore.test.ts, commands (test), src/lib/collabCompletion.test.ts (new)
```

Dependency direction — all inward toward the shared seam, no cycle:
`commands.ts`, `collaboratorStore.ts`, `CollaboratorPane.tsx` →
`lib/collabCompletion.ts` → `lib/scopedCollabMemory.ts` → IPC → `memory.rs`.
`collabCompletion.ts` never depends back on the store/components.

## Decomposition

One method = one node.

| Node | Stage | Interface | Method | File |
|---|---|---|---|---|
| N1 | Build canonical minimal signal (P0b) | CompletionCodec | buildCompletionSignal(fields) | lib/collabCompletion.ts |
| N2 | Atomic publish (temp+rename) | MemorySignalStore | writeMemoryFileAtomic *(exists)* | lib/scopedCollabMemory.ts |
| N3 | List candidate `*.done.json` | MemorySignalStore | listMemoryFiles *(exists)* | lib/scopedCollabMemory.ts |
| N4 | Read raw signal | MemorySignalStore | readMemoryFile *(exists)* | lib/scopedCollabMemory.ts |
| N5 | Strict parse + schema validate (P0c) | CompletionCodec | validateSignal(raw, fileName) | lib/collabCompletion.ts |
| N6 | Suffix-normalized id resolve + ambiguity (P0d) | TaskIdResolver | resolveTaskId(tasks, id) | lib/collabCompletion.ts |
| N7 | Terminalize task on unique match | *(store)* | updateTask *(exists)* | stores/collaboratorStore.ts |
| N8 | Quarantine bad file → `*.done.json.bad` (P0a) | MemorySignalStore | quarantineMemoryFile | lib/scopedCollabMemory.ts |
| N9 | Rust atomic-rename primitive (P0a) | RenameMemoryFileCmd | rename_memory_file | src-tauri/src/commands/memory.rs |
| N10 | Surface ingestion diagnostic (P0a) | IngestDiagnostics | reportIngestFailure(reason) | stores/toastStore.ts |
| N11 | Per-file ingest (orchestrates N4→N10) | CompletionScanner | ingestSignalFile(session, relPath) | stores/collaboratorStore.ts |
| N12 | Scan driver (orchestrates N3→N11) | CompletionScanner | scanForTaskCompletions *(rework)* | stores/collaboratorStore.ts |
| N13 | Reuse resolver in `/task` cmds (P0d) | TaskIdResolver | resolveTaskId *(reuse)* | components/collaborator/commands.ts |
| N14 | Detect stale assigned task (P1) | MissingSignalWatchdog | detectStaleAssignedTasks(session) | stores/collaboratorStore.ts |
| N15 | Nudge/flag — never auto-complete (P1) | MissingSignalWatchdog | flagMissingSignal(agent, task) | components/collaborator/CollaboratorPane.tsx |

Interface-level DAG in `plan.mmd`. Control flow within the ingest path:
`N12 → N3 → N11 → N4 → N5 →(ok) N6 →(unique) N7 | (invalid/no-match/ambiguous) → N8 → N9`,
with any N11 failure also routing to N10.

### Per-node contract (signatures + behavior for the implementer)

- **N1 `buildCompletionSignal(fields: {task_id; author; status; report_path?}) → string`**
  — returns `JSON.stringify` of the canonical minimal object; no free prose fields.
- **N5 `validateSignal(raw: string, fileName: string) → {ok:true; value:Signal} | {ok:false; reason: IngestFailReason}`**
  — strict `JSON.parse` in a caller-safe wrapper (no throw escapes); reject
  missing/typed-wrong `task_id`/`author`/`status`, `status ∉ {completed,blocked}`,
  and filename-id vs payload-id mismatch. `reason` is a typed enum for N10.
- **N6 `resolveTaskId(tasks, id) → {kind:"unique"; task} | {kind:"none"} | {kind:"ambiguous"; matches}`**
  — normalize via `strip = s.replace(/-\d{13}$/,'')`; match `strip(t.id)===strip(id) || t.id===id`;
  ambiguity = >1 match. Pure; unit-tested in isolation.
- **N8 `quarantineMemoryFile(session, relPath) → Promise<boolean>`** — rename to
  `${relPath}.bad` via N9; idempotent; swallows "already gone".
- **N9 `rename_memory_file(collab_session_id, from_rel, to_rel)`** — Rust; same
  path-validation + symlink guards as the sibling memory commands; atomic `fs::rename`.
- **N10 `reportIngestFailure(reason, relPath)`** — rate-limited (dedupe by
  path+reason) toast/status; never throws into the scan loop.
- **N11 `ingestSignalFile`** — the ONLY place the ok/fail branch lives; on any
  failure calls N8 + N10 and continues; on unique match calls N7 then deletes.
  Retains the existing already-terminal short-circuit and per-iteration re-read.
- **N14/N15** — advisory only; N15 sets a per-agent flag/nudge, MUST NOT call
  `updateTask` to a terminal status.

## Validation

Feature lane, skeletons skipped → no compile target at Phase 6. Plan-artifact
smoke-check (this doc has `## Goal`, `## Package layout`, `## Decomposition`;
`plan.mmd` head is `graph LR`) runs at Phase 7 before commit. Implementation-time
validation (implementer): `tsc --noEmit`, `cargo check`, `npm run test`.

## Open questions (resolve during implementation)

1. Diagnostic surface for N10 — toast (`toastStore`) vs the collaborator status
   line vs console + unread badge. **Recommendation:** toast + unread badge
   (visible without focus), console for detail.
2. Watchdog threshold + tick location for N14 — reuse the CollaboratorPane 2s
   poll vs a separate slower interval; threshold (e.g. ≥30s idle with a
   non-terminal assigned task). **Recommendation:** piggyback the existing poll,
   ≥30s, flag-only.
3. Quarantine primitive — dedicated `rename_memory_file` (chosen, atomic) vs
   compose read+atomic-write(.bad)+delete in TS (no Rust). Plan assumes the
   dedicated command; implementer may fall back if Rust churn is undesirable.

## Risks

- Reworking `scanForTaskCompletions` risks regressing its documented race guards
  — mitigate by keeping N12/N11 structure 1:1 with the current loop and moving
  only parse/match/fail-handling into the codec/resolver.
- Schema tightening (`status` enum) could reject a legacy signal an agent still
  writes — mitigate by accepting both stripped+full id and only enumerating
  `status`, which was always meant to be `completed|blocked`.
