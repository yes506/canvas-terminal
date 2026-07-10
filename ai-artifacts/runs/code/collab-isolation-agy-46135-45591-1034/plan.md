# Feature plan — collab-isolation-agy

Planner run `46135-45591-1034` · lane `feature` · base `dev` · stack `typescript` (+ Rust IPC side)
Origin: collaborator task `task-1-1783644753660` (session-22-1783644131641).
Rev 2 — folds verified findings from 5 peer reviews (@codex1 task-11, @claude2 task-12,
@codex2 task-13, @claude3 task-14, @codex3 task-15). Disposition table at the end.

## Goal

canvas-terminal collaborator 모드에서 각 collaborator 세션의 공유 메모리를 세션별 디렉토리로
격리하고, 2026-06-18 개인 티어 서비스가 종료된 Gemini CLI mini-agent를 Antigravity CLI(`agy`)로
교체한다.

격리 보장 수준(정확한 명세): **앱 IPC 경로에 대해서는 구조적 강제**(스코프된 커맨드는 자기
세션 서브트리 밖을 해석할 수 없음), **에이전트 셸 접근에 대해서는 레이아웃+지시 스코핑**(주입
되는 모든 경로/grep 타깃이 자기 세션 디렉토리만 가리키고, 프로토콜이 형제 디렉토리 접근을
금지). 스폰된 CLI가 셸로 `../<sibling>`을 읽는 것까지 막는 OS 수준 격리(샌드박스/uid 분리)는
범위 밖이다. IPC 스코프는 소유권 인증이 아니다 — 호출자는 자기 `collabSessionId`를 전달한다는
로컬 신뢰 모델을 전제한다(에이전트는 Tauri IPC를 직접 호출할 수 없음).

## In scope

- New on-disk layout `session-<pid>/<collabSessionId>/` holding ALL per-session files:
  `conversation-<sid>.md`, `tasks-<sid>.md`, `context.md`, agent peer reports `task-*-*.md`,
  `<task-id>.done.json`, dashboard roster sidecar `agents-<sid>.json`, and the `contexts/`
  peer-context mirror (moved from `contexts/<sid>/` to `<sid>/contexts/`, `.state.json` included).
- `collab_session_id` scope (sanitized, Rust-side single source of truth) on the memory IPC
  surface in `src-tauri/src/commands/memory.rs`:
  - scoped commands: `read_memory_file`, `write_memory_file`, `write_memory_file_atomic`,
    `delete_memory_file`, `list_memory_files`, `get_memory_file_mtime`, `clear_memory_dir`
  - **8th scoped command**: `init_memory_dir` is replaced by (or renamed to)
    `get_memory_session_dir(collab_session_id)` — it is the source of every path printed into
    agent prompts (`getMemoryDir()` at `collaboratorStore.ts:785-789`), so leaving it
    root-scoped would keep inviting agents into the mixed root. The TS-side
    `memoryDirCache` becomes **keyed by collabSessionId** (Map), not a single global string.
  - new helpers: `sanitize_collab_session_id` (empty-after-sanitize = error, never root
    fallback), `get_memory_session_dir`
  - **teardown split**: window-close wipe at `src-tauri/src/lib.rs:251` currently calls
    root-level `clear_memory_dir()`; it moves to a new **internal, non-IPC** helper
    `clear_process_memory_root()` that wipes `session-<pid>/` wholesale. The IPC
    `clear_memory_dir(collab_session_id)` clears one session subtree only. `endSession`/
    `killAllAgents` teardown switches from ad-hoc file deletes to the scoped
    `clear_memory_dir(sid)` (explicit decision: per-session teardown now clears the whole
    subtree — conversation, tasks, context, reports, done.json, contexts mirror).
- Implement the TS contract `src/types/scopedCollabMemory.ts` (interfaces `ScopedMemoryIpc`,
  `ScopedMemoryClient` — emitted by this planner run, tsc-validated). **All raw
  `invoke("<memory-command>")` call sites are REPLACED by a typed facade implementing
  `ScopedMemoryIpc`/`ScopedMemoryClient`** so a missed `collabSessionId` is a compile error,
  not a silent runtime deserialization failure. Known call-site anchors:
  `collaboratorStore.ts:754, 769, 1055, 1064, 1078, 1111, 1214, 1656, 1663, 1992, 2220` and
  `commands.ts:328, 333, 339, 526, 533, 543, 548`.
- Update header builders `prependContextHeader` / `buildSlimHeader` and `buildTaskProtocol`
  (`src/stores/collaboratorStore.ts`) so every injected path points ONLY at the agent's own
  session directory, and add an explicit protocol rule prohibiting access to sibling session
  directories.
- Transcript mirror relocation (Rust writer side), decomposed precisely:
  - append target `contexts/<sid>/<agent>.jsonl` → `<sid>/contexts/<agent>.jsonl`
    (`transcripts/mod.rs:1416, 1510, 1587`)
  - **tailer state relocation**: `STATE_FILE_RELPATH = "contexts/.state.json"`
    (`tailer.rs:40`) becomes a per-session computed path. `TranscriptHandle.memory_dir` is
    captured from `get_memory_dir()` BEFORE `collab_session_id` is populated
    (`adapters/mod.rs:774, 1247`), so the implementer must thread the session id into state
    resolution: either re-point `handle.memory_dir` at the scoped dir once
    `collab_session_id` is known, or add `collab_session_id` to `TailState` and route
    `persist_offset` (`tailer.rs:135`) through a scoped write. Call sites:
    `state_file_path` (`tailer.rs:49`), `persist_offset` self-call (`tailer.rs:169`),
    `watcher.rs:370-376` (constructs `TailState` and persists).
  - identity-marker needle update: `line_references_collab_session`
    (`adapters/mod.rs:463-466`) matches the OLD `contexts/<sid>/` token; after relocation the
    needle becomes `<sid>/contexts/` (the OR'd `conversation-<sid>.md` needle survives
    unchanged). Update the needle + the stale fixture test at `adapters/mod.rs:1304`.
- Wire TS consumers to the scoped facade: `/memory` + `/context` handlers
  (`src/components/collaborator/commands.ts`), done.json scanning (`scanForTaskCompletions`),
  peer-context reader glob + breadcrumbs (`src/lib/peerContext.ts:297-356, 425-456` →
  `contexts/...` relative to the scoped session root).
- Replace the retired Gemini CLI: `TOOL_CONFIGS.gemini_cli` `command: "gemini"` → `"agy"`,
  `label: "Gemini CLI"` → `"Antigravity CLI"` (`src/types/collaborator.ts`); ToolId and
  `@gemini*` handles unchanged.
- **agy peer-context publishing: consciously disabled in this feature.** Empirically verified
  (2026-07-10): agy v1.1.0 stores conversations as SQLite databases with WAL
  (`~/.gemini/antigravity-cli/conversations/<uuid>.db` + `-shm`/`-wal`), NOT the JSONL the
  Gemini adapter tails (`~/.gemini/tmp/<slug>/chats/*.jsonl`). A JSONL tailer cannot capture
  them. Scope decision: `adapter_for("gemini" | "gemini_cli")` (`adapters/mod.rs:511-516`)
  returns **None** (adapter unregistered), the frontend handles watch-registration failure
  gracefully (publish Eye toggle disabled/hidden for agy agents), `fs_gate::ALLOWED_ROOTS`
  keeps or drops the `.gemini/tmp` entry accordingly, and tests lock the graceful-degradation
  path. A dedicated SQLite-reading antigravity adapter is recorded as a follow-up feature.
- Re-verify `format_for_tool`'s gemini-only `\n`→`\r` branch (`src-tauri/src/commands/pty.rs:551`)
  against agy's TUI and keep/remove per measurement; audit prompt/readiness regexes
  (`src/lib/agentOutputCapture.ts`, `AgentMiniTerminal` READY_PATTERNS) for agy.
- Update existing vitest suites and add isolation tests (scoped path builders, cross-session
  denial via IPC, per-session `.state.json` non-sharing) plus Rust-side unit coverage for the
  sanitizer and scoped path resolution.

## Out of scope

- agy authentication/onboarding automation and the corporate CA bundle update (user environment
  actions, already handled interactively outside the plan).
- **OS-level filesystem confinement of spawned CLI agents** (sandbox, per-agent uid, chroot) —
  the shell vector is mitigated by layout + injected-path scoping + protocol prohibition only.
- **Antigravity transcript adapter** (SQLite/WAL reader for
  `~/.gemini/antigravity-cli/conversations/*.db`) — recorded follow-up; this feature ships with
  agy peer-context publishing disabled.
- claude/codex spawn command changes; shipping `--dangerously-skip-permissions` by default.
- Renaming the `gemini_cli` ToolId or the `@gemini*` handle family (cosmetic, high ripple).
- Migration of existing session files (session dirs are ephemeral; stale-session cleanup already
  purges them on app restart).
- Dashboard UI redesign.

## Constraints

- Path-safety defenses (`validate_relative_path`, `O_NOFOLLOW`, symlink component walk, TOCTOU
  re-checks) are REUSED, never weakened; the new session segment must pass
  `sanitize_collab_session_id` and a value that sanitizes to empty is an error, never a fallback
  to the root directory.
- TS NEVER composes session-root paths from raw `collabSessionId` strings; every absolute path
  printed into prompts or used for IPC display comes from the Rust-resolved
  `get_memory_session_dir` (single source of truth, prevents raw-vs-sanitized divergence).
- `clear_stale_sessions` keeps its PID-based cleanup at the `session-<pid>` root level; the new
  internal `clear_process_memory_root()` (window-close) also operates at that root.
- Rust mirror-writer path change, tailer `.state.json` resolver change
  (`state_file_path`/`persist_offset`/`watcher.rs:370`), identity-needle update, and the TS
  reader glob change land in the SAME commit (atomic disk-layout contract; splitting any of the
  four deadlocks peer-context discovery or crash-resume).
- Update path is always a process restart (Tauri updater relaunches → new PID → fresh
  `session-<pid>` dir); no live in-place layout mix ever exists.
- Implementation is generated by `codebase-implementer` in a dev-based worktree; no signature
  changes to the planner-committed interfaces.
- Validation: `tsc --noEmit` + vitest (TS), `cargo check` + unit tests (Rust).

## Success criteria

- Through app IPC, a caller scoped to session A cannot list/read/write/delete files of session B
  (structural denial for every scoped command, including `list`/`clear`); mini-agent prompts
  contain ONLY session-A paths and the protocol prohibition (layout+instruction scoping for the
  shell vector, per the Goal's threat-model statement).
- `/context` set in pane A is never injected into pane B's agents.
- Every path and grep target injected into agent prompts matches the actual on-disk mirror paths
  (load-bearing invariant); done.json completion detection and task reports keep working
  per session.
- Two collaborator sessions tailing transcripts never share `.state.json` state (crash-resume
  stays per-session correct).
- agy spawns in the gemini slot end-to-end: readiness detection flips to running, injected
  messages submit, responses stream back; peer-context publishing for agy degrades gracefully
  (no watch errors surfaced as crashes, Eye toggle reflects unsupported state).
- Dashboard snapshot lists nested per-session paths and file viewing still works
  (verified: `dashboard/App.tsx` renders `f.path` verbatim and `encodePathForUrl` handles
  nested segments; smoke-test locks it).
- Full vitest suite and `cargo check` pass.

## Open questions

- `format_for_tool` `\n`→`\r` conversion for agy: decide empirically after the user completes agy
  onboarding (default: keep current behavior until measured). Verification step included in the
  implementer's validation plan.

(Resolved in rev 2: dashboard filename parsing — SPA renders raw `f.path`, no grouping logic;
risk closed with a smoke test. See disposition table.)

## Package layout

No new packages introduced — the feature lives in existing modules:

```
src-tauri/src/commands/memory.rs            # scoped path helpers + 8 scoped IPC commands + clear_process_memory_root()
src-tauri/src/commands/transcripts/mod.rs   # adapters/mod.rs: adapter_for gemini removal, identity needle,
src-tauri/src/commands/transcripts/adapters/#   TranscriptHandle.memory_dir scoping (:774,:1247), fixture test :1304
src-tauri/src/commands/transcripts/tailer.rs# STATE_FILE_RELPATH → per-session path; persist_offset scoping
src-tauri/src/commands/transcripts/watcher.rs# TailState construction site (:370-376)
src-tauri/src/commands/transcripts/fs_gate.rs# ALLOWED_ROOTS gemini entry decision
src-tauri/src/lib.rs                        # window-close teardown → clear_process_memory_root()
src-tauri/src/commands/pty.rs               # format_for_tool gemini/agy branch decision
src/types/scopedCollabMemory.ts             # ★ planner-emitted IPC contract (new file)
src/types/collaborator.ts                   # TOOL_CONFIGS agy command/label
src/stores/collaboratorStore.ts             # typed facade adoption, path/header builders, protocol text,
                                            #   scans, memoryDirCache keyed by sid, endSession teardown
src/components/collaborator/commands.ts     # /memory, /context via typed facade
src/lib/peerContext.ts                      # reader glob + breadcrumb paths (same commit as Rust writer)
src/lib/agentOutputCapture.ts               # prompt-pattern audit
src/dashboard/App.tsx                       # verified no-change needed; smoke test only
```

New on-disk layout (runtime artifact, not source):

```
~/.cache/canvas-terminal/collab-memory/session-<app-pid>/
└── <collabSessionId>/          # one isolated subtree per collaborator pane
    ├── conversation-<sid>.md, tasks-<sid>.md, context.md
    ├── task-*-*.md, <task-id>.done.json, agents-<sid>.json
    └── contexts/ (.state.json, <agent>.jsonl, <agent>.<N>.jsonl)
```

## Decomposition

| Node # | Stage | Belongs to package | Notes |
|---|---|---|---|
| 1 | sanitize collab session id | src-tauri memory.rs | Rust-side single source of truth; empty-after-sanitize = error |
| 2 | resolve/create scoped session dir | src-tauri memory.rs | `get_memory_session_dir(collab_session_id)` — replaces `init_memory_dir` as the 8th scoped IPC |
| 3 | scoped read | src-tauri memory.rs | `read_memory_file(+scope)`; missing file → null preserved |
| 4 | scoped write / atomic write | src-tauri memory.rs | symlink + TOCTOU defenses reused |
| 5 | scoped delete / clear | src-tauri memory.rs | parent pruning stops at session root; clear recreates empty subtree |
| 6 | scoped list / mtime | src-tauri memory.rs | list structurally cannot cross sessions |
| 7 | mirror writer path switch | src-tauri transcripts/mod.rs | `contexts/<sid>/` → `<sid>/contexts/`; SAME COMMIT as nodes 7b/7c/13 |
| 7b | tailer state relocation | src-tauri transcripts/tailer.rs + watcher.rs | `STATE_FILE_RELPATH` → per-session; thread sid into `TailState`/`persist_offset` (:135,:169) + `watcher.rs:370`; `TranscriptHandle.memory_dir` captured pre-populate (:774,:1247) must be re-pointed post-populate |
| 7c | identity needle + fixture update | src-tauri transcripts/adapters/mod.rs | `line_references_collab_session` (:463-466) needle → `<sid>/contexts/`; fixture test :1304 |
| 8 | TS scoped memory facade | src/stores/collaboratorStore.ts | implements `ScopedMemoryIpc`/`ScopedMemoryClient`; ALL raw memory invokes replaced; `memoryDirCache` keyed by sid |
| 9 | header builders (full/slim) | src/stores/collaboratorStore.ts | all printed paths inside own session dir |
| 10 | protocol text + isolation rule | src/stores/collaboratorStore.ts | explicit sibling-session prohibition wording |
| 11 | done.json scan scoped | src/stores/collaboratorStore.ts | per-session scan + orphan grace period preserved |
| 12 | /memory + /context scoped | src/components/collaborator/commands.ts | context.md becomes session-scoped; via typed facade |
| 13 | peer-context reader glob | src/lib/peerContext.ts | pairs with nodes 7/7b/7c in one commit |
| 14 | dashboard snapshot smoke test | src-tauri dashboard + src/dashboard/App.tsx | verified compatible; lock with test |
| 15 | agy tool registration | src/types/collaborator.ts | command `agy`, label `Antigravity CLI` |
| 16 | PTY injection format decision | src-tauri pty.rs | empirical keep/remove of `\n`→`\r` for agy |
| 17 | prompt/readiness pattern audit | src/lib/agentOutputCapture.ts | agy prompt shape vs existing regexes |
| 18 | agy adapter unregistration + graceful degradation | src-tauri transcripts/adapters/mod.rs + fs_gate.rs + frontend Eye toggle | agy transcripts are SQLite (.db/WAL) — JSONL tailer cannot capture; publishing disabled with tests; follow-up adapter recorded |
| 19 | teardown split | src-tauri memory.rs + lib.rs + collaboratorStore.ts | internal `clear_process_memory_root()` for window close; scoped `clear_memory_dir(sid)` for /memory clear + endSession |

## Interfaces emitted

`src/types/scopedCollabMemory.ts` (committed on this planner branch, tsc-validated; rev 2 fixes
the stale `MemoryFileEntry` doc — it is a session-relative path string, not a triple):

- `ScopedMemoryIpc` — 7 methods (`readMemoryFile`, `writeMemoryFile`, `writeMemoryFileAtomic`,
  `deleteMemoryFile`, `clearMemoryDir`, `listMemoryFiles`, `getMemoryFileMtime`), each with the
  full 9-field TSDoc contract. Adoption is mandatory: raw `invoke()` memory calls are replaced
  by this facade (compile-time scope enforcement).
- `ScopedMemoryClient` — 1 method (`getMemorySessionDir`), the successor of `init_memory_dir`.
- Value object: `MemoryFileEntry` (session-relative path string).

Rust-side counterparts are signature changes to existing `#[tauri::command]` functions and are
specified by the decomposition table + the TSDoc contracts (single-stack rule: TS is the
skeleton language for this run).

## Validation

- Phase 6: `tsc --noEmit` — exit 0 on the skeleton commit (re-run after rev 2 doc fix).
- Phase 7 smoke-check: plan.md headers present; plan.mmd parses (`graph` first line).
- Implementer validation plan: vitest (updated + new isolation tests incl. cross-session IPC
  denial and per-session `.state.json`), `cargo check` + Rust unit tests, dashboard snapshot
  smoke test, plus the empirical item (agy injection format / readiness patterns, after user
  completes agy onboarding).

## Peer-review disposition (rev 2)

| Finding | Reviewers | Disposition |
|---|---|---|
| "Structural denial" overstated for shell vector; IPC scope ≠ ownership auth | codex1 HIGH, claude2 F1, codex2 #1 | FOLDED — Goal/SC reworded with explicit threat model; OS sandboxing declared out of scope |
| Root `clear_memory_dir()` teardown callers break (`lib.rs:251`) | codex1 HIGH, codex3 #3, claude2 F5 | FOLDED — node 19 teardown split (`clear_process_memory_root()` internal + scoped IPC); endSession decision made explicit |
| `init_memory_dir` is the real 8th command; `memoryDirCache` global | codex3 #3 | FOLDED — node 2 expanded; cache keyed by sid |
| Tailer `.state.json` relocation underdecomposed (`persist_offset`, `watcher.rs:370`, memory_dir pre-populate capture) | ALL FIVE | FOLDED — new node 7b with exact anchors + two-session test |
| `adapters/mod.rs` missing from package layout; identity needle + fixture go stale | claude3 #1, codex1 MED, codex3 | FOLDED — node 7c; file named in layout |
| agy transcript capture unplanned; Gemini adapter can't apply | codex3 BLOCKING | FOLDED + STRENGTHENED — empirically verified agy uses SQLite/WAL (`~/.gemini/antigravity-cli/conversations/*.db`); node 18 disables publishing gracefully; SQLite adapter recorded as follow-up |
| Raw untyped `invoke()` call sites → silent runtime misses | claude3 #2, codex1 note | FOLDED — typed-facade adoption made mandatory with call-site anchors |
| `MemoryFileEntry` doc/type contradiction | claude3, codex1, codex3 | FIXED — skeleton doc corrected in rev 2 commit |
| Dashboard SPA grouping regression risk | claude2 F3 | RESOLVED BY VERIFICATION — `App.tsx` renders raw `f.path`, no filename grouping; smoke test added to validation |
| Updater/restart assumption implicit | claude2 F4 | FOLDED — constraint added |
| Raw-vs-sanitized id divergence in TS-composed paths | codex2 | FOLDED — constraint added (Rust-resolved root only) |
| Gemini CLI not universally dead (enterprise tiers unaffected) | codex1 | NOTED — migration targets the user's personal-tier slot; no plan change |
