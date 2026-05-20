# Cycle F — always-on peer-context-mirror, correct threshold, re-arm

`scale: feature   marker on merge: (plan-feature, human-confirmed)`

(Prior `plan.md` on `dev` documented cycle E `cycle-e-mtime-discovery`.
Overwritten with this cycle F plan; historical content via
`git log -- plan.md`.)

## Goal

Peer-context-mirror works **without user intervention**. Spawning any
agent + sending it any message → `contexts/<handle>.jsonl` appears
automatically in the collab-memory session dir, without clicking the
Eye toggle. The Eye toggle remains as a per-agent opt-out.

## Background

Cycles A–E built the peer-context-mirror infrastructure layer by layer
(reservation lifecycle, watch_transcript IPC, mtime-based discovery,
descendant walk, initial drain). End-to-end verification surfaced two
remaining gaps:

1. **Manual gate on Eye toggle**: cycle B set `publishOptedIn=false` by
   default as a "privacy: explicit opt-in" choice. In practice the user
   has to remember to click Eye for each agent — fragile and easy to
   miss. Default has to flip.

2. **Cycle E mtime-threshold bug**: the frontend passes
   `spawned_at_unix_ms = Date.now()` at the watch-effect-fire moment
   (i.e. click-Eye time), not actual agent spawn time. Cycle E used
   this as the mtime gate inside `discover_by_mtime`. If the user types
   a message + gets a reply BEFORE clicking Eye, the JSONL's mtime is
   already older than the click-time threshold → `NoMatchingFd`. With
   always-on, the watch effect fires at agent-spawn time → no JSONL
   exists yet → 5×500ms retry expires before the first user message →
   permanent failure. Discovery model needs the real process-spawn
   time, server-side, with a retry budget that survives user delays.

3. **No re-arm**: today's `discover_session` is a sync IPC. If
   discovery fails (e.g. agent never wrote yet), the watch effect
   doesn't retry until its dependencies change. With always-on,
   nothing changes once the agent is spawned → permanent failure.

## In-scope

### F1 — `publishOptedIn` default flip

`useCollaboratorStore.addAgent` (currently `collaboratorStore.ts:1351`)
defaults `publishOptedIn = false`. Flip to `true`. Update the inline
comment block that cites "Default visibility OFF on session start"
(cycle B's architecture criterion) to "Default visibility ON; Eye
toggle remains as per-agent opt-out".

Effect: at the moment `addAgent` runs (post-spawn, after reservation
consumption), the agent record has `publishOptedIn === true`. The
`AgentMiniTerminal.tsx` watch effect (line 892) sees
`isPublishing === true` as soon as the agent record exists and the
status becomes `running` — fires `watch_transcript` automatically.

### F2 — `SpawnedAgentInit.publishOptedIn` docstring

`types/collaborator.ts:51` carries a docstring that mentions "default
false". Update to "default true".

### F3 — `discover_pid_start_time(pid: i32) -> io::Result<i64>`

New private helper in `adapters/mod.rs`. Returns process-start unix
seconds.

- **macOS**: `ps -p <pid> -o etime=` returns elapsed time since
  process start in `[[DD-]HH:]MM:SS` format. Parse to seconds and
  subtract from `SystemTime::now()`. Avoids `ps -o lstart=` date
  parsing (locale-fragile).
- **Linux**: read `/proc/<pid>/stat` field 22 (process start time in
  clock ticks since boot). Combine with `/proc/uptime` to derive
  unix-seconds-since-epoch.
- **Other OSes**: `Err(io::ErrorKind::Unsupported)`.

Error semantics: `Io` for genuine OS failures (ps spawn, /proc read).
`NotFound` for "PID exists but ps reports no etime" (unlikely but
defended).

### F4 — `discover_by_mtime` threshold source change

Signature change (cycle E's signature):
```rust
pub(super) fn discover_by_mtime<F>(
    adapter_id: &'static str,
    agent_handle: &str,
    scan_roots: &[PathBuf],
    spawned_at_unix_ms: i64,    // <-- removed
    pid: i32,                   // <-- added
    predicate: F,
) -> Result<TranscriptHandle, DiscoveryError>
```

Internally:
1. Call `discover_pid_start_time(pid)` → `start_unix_secs`.
2. Threshold = `start_unix_secs * 1000`; no 500ms slack needed (process
   start time is authoritative).
3. Retry loop SHRINKS to a single attempt: F6's async retry layer is
   the new outer loop. The cycle E 5×500ms internal retry is removed
   (one-shot scan + return).

The function becomes a single-shot "scan + return" — the retry-until-
unwatch loop lives one layer up in `TranscriptWatcher::watch`'s tokio
task (F6).

### F5 — Adapter call-site updates

All three adapters (`claude_code.rs`, `codex.rs`, `gemini.rs`) call
`discover_by_mtime(..., spawned_at_unix_ms, predicate)`. Change to
`discover_by_mtime(..., pid, predicate)`.

Codex previously discarded `pid` via `let _ = pid;` (it's cwd-
agnostic). That line is removed — pid flows through to threshold.

The trait signature on `TranscriptAdapter::discover_session` is
**unchanged** — `(agent_handle, pid, spawned_at_unix_ms)` stays.
Adapters now ignore `spawned_at_unix_ms` (the entire trait parameter
becomes effectively unused; documented in trait docstring).

### F6 — `TranscriptWatcher::watch` async refactor

Today's flow (cycle B/E):
```
watch() {
    discover_session(...)?            // sync, may fail
    subscribe_fsevents(...)?
    insert Entry
    on_fs_event(initial_drain)        // cycle D
    return WatchToken
}
```

New flow (cycle F):
```
watch() {
    insert PENDING Entry (no source_path, no subscription yet)
    let token = WatchToken
    let handle = tokio::task::spawn(async move {
        loop {
            match discover_session(...) {
                Ok(handle) => {
                    populate Entry (source_path, source_inode, etc.)
                    subscribe_fsevents(parent_dir)
                    on_fs_event(initial_drain)
                    return
                }
                Err(NoMatchingFd) => {
                    tokio::time::sleep(5s).await
                    if entry was unwatched: return
                    continue
                }
                Err(other) => log + retry
            }
        }
    })
    Entry.discovery_task = Some(handle.abort_handle())
    return token
}
```

Key shape changes:
- `Entry` gains `discovery_task: Option<tokio::task::AbortHandle>` and
  `pending: bool` (or simply: `source_path: Option<PathBuf>`).
- On the notify-thread side, `on_fs_event` skips entries whose
  `source_path` is `None` (they haven't been populated yet — events
  for the project dir aren't relevant to a pending watch).
- `unwatch` (F7) calls `.abort()` on the AbortHandle if present and
  removes the Entry as before.

The tokio task runs on the existing Tauri runtime (no new runtime
instance). Cost per pending agent: one task + 5s timer. Bounded by
the number of opted-in agents in the UI (~6 realistic max).

### F7 — `TranscriptWatcher::unwatch` extension

Existing body decrements FSEvents ref-count + removes the Entry. Add:
```rust
if let Some(handle) = entry.discovery_task.take() {
    handle.abort();
}
```

Idempotent. Already-completed task is a no-op on abort. Race window
where the task is mid-completion vs the abort call is safe: the task
checks for entry presence before populating, and the entry was
already removed by unwatch's path.

## Out-of-scope

- Removing the `spawned_at_unix_ms` IPC parameter — kept for backward
  compatibility per cycle B's commitment.
- Removing the `pid` field from `TranscriptHandle` (still pass-through
  state; the discovery flow no longer needs it post-population).
- Cleanup of cycle E's `MTIME_DISCOVERY_*` constants (drop together
  with cycle E's retry loop in F4).
- Frontend re-architecture — the watch effect's shape stays exactly
  as in cycle C; only the default flip in F1 is frontend.
- A first-launch privacy modal (per Phase 0.5 Q4 — Eye icon is enough).

## Constraints

- **No trait signature change** on `TranscriptAdapter::discover_session`.
- **No new `DiscoveryError` variants**.
- **`cargo check` + `tsc --noEmit` + `vitest 216/216`** all pass.
- **No removal** of cycle E's mtime infrastructure — just refactored.
- **No new direct crate deps** — tokio + tauri already present.

## Success criteria

1. **Cold flow** (the user's verification target): spawn a Claude
   Code / Codex / Gemini agent, send a first message, see
   `contexts/<handle>.jsonl` appear within ~6 s (5 s poll + filesystem
   latency) — **no Eye click required**.
2. **Walk-away flow**: spawn an agent, leave for 10 minutes, return,
   send a message, see `contexts/<handle>.jsonl` appear within ~6 s of
   the first message. The retry-until-unwatch survives the gap.
3. **Eye opt-out**: clicking Eye OFF cancels the pending discovery
   task; `contexts/` stops growing. Clicking Eye ON re-arms discovery.
4. **Cross-provider correctness**: two Codex agents under different
   Canvas Terminal sessions in different cwds — each binds to its own
   rollout (verified by inspecting first turn content).
5. **No regression**: vitest 216/216 pass, cargo check + tsc clean.

## Validation plan

- **Planner-phase compile**: `cd src-tauri && cargo check` —
  baseline-green on `dev@8960052` verified.
- **Implementer-phase validation**:
  `cd src-tauri && cargo check && cd .. && npx tsc --noEmit && npm test`.
- **Smoke (post-merge, user-driven)**: per "Success criteria" 1–4.

## Risks

- **`ps -o etime=` parsing fragility**: format depends on elapsed
  time — short (MM:SS), medium (HH:MM:SS), or long (DD-HH:MM:SS).
  Implementer phase handles all three branches explicitly; unit-test
  the parser if implementer wishes.
- **Async task vs unwatch race**: on `unwatch`, the task might be
  mid-populating the Entry (between `discover_session` success and the
  `subscribe_fsevents` call). Mitigation: under the Inner mutex, task
  re-checks Entry presence before populating; if Entry has been
  removed, the task exits without subscribing.
- **Tokio task leak on app shutdown**: existing `shutdown()` sets
  `Inner.shutdown = true`; the task's outer loop should check the
  shutdown flag between attempts and exit. Implementer adds this
  guard.
- **Always-on privacy expectation**: users who don't read release
  notes may not realize their agent transcripts now propagate. The
  Eye icon (Eye vs EyeOff) is the visible affordance; flipping it
  off stops propagation. Documented in CLAUDE.md (out-of-scope for
  this cycle's diff; can land in a docs follow-up).
- **`/proc/<pid>/stat` field 22**: Linux only. Implementer must
  handle the case where the agent process has already exited by the
  time discovery runs (NotFound → return immediately, the retry loop
  will exit on the next iteration since the WatchToken's parent has
  unwatched on agent-exit).

## Decomposition graph

See `plan.mmd` for the Mermaid DAG.

Topological order: **F1, F2 (parallel) → F3 → F4 → F5 → F6 → F7**.

F1 and F2 are frontend-only and can land before any Rust changes; F5
depends on F4's signature change; F6 depends on F4 (calls the new
helper) and on F5 (adapters now accept the new param chain).
