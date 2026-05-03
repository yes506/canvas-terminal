# Worktree State Diagram

Visual companion to `spec.md` §1.

```
┌─────────────────┐
│  (spawn request)│
└────────┬────────┘
         │
         ▼
┌─────────────────┐         git worktree add fails / base-ref fails /
│  provisioning   │────────►lockfile claim fails / lease write fails
└────────┬────────┘                                  │
         │ all checks pass                          ▼
         ▼                                  (cleanup; no lease persisted;
┌─────────────────┐                          UI surfaces error)
│      ready      │
└────────┬────────┘
         │ first activity (PTY input/output/heartbeat)
         ▼
┌─────────────────┐
│     working     │◄──────────────────────────┐
└────────┬────────┘                           │
         │ close trigger (close-source matrix)│ reaper observes
         │                                    │ stale lease
         ▼                                    │
┌─────────────────┐                           │
│    draining     │                           │
│                 │ Path A: .done.json complete│
│                 │ Path B: forced-close       │
│                 │   trigger (close cascade   │
│                 │   OR Path A timeout)       │
└──┬──────┬───┬───┘                           │
   │      │   │                               │
   │      │   │ Path A clean + branch == base │
   │      │   └──────────────────────► gc_done│
   │      │                                   │
   │      │ Path A clean + branch ahead       │
   │      └────────────────────────► merge_ready
   │                                          │
   │ Path B (forced) OR Path A dirty          │
   │ ▼                                        │
   │   write .system-close.json               │
   │   kill PG (SIGTERM → 5s → SIGKILL)       │
   │   ▼                                      │
┌─────────────────┐    snapshot fails         │
│  snapshotting   │──────────────────────►┐   │
└────────┬────────┘                       │   │
         │ quarantine artifact + fsync    │   │
         ▼                                │   │
┌──────────────────┐  commit fails        │   │
│ artifact_written │─────────────────────►│   │
└────────┬─────────┘                      │   │
         │ wip ref commit succeeds        │   │
         ▼                                │   │
┌──────────────────┐  verify fails        │   │
│ wip_ref_written  │─────────────────────►│   │
└────────┬─────────┘                      │   │
         │ both verified durable          │   │
         ▼                                │   │
┌─────────────────┐                       │   │
│    preserved    │                       │   │
└────┬──────┬─────┘                       │   │
     │      │ (S2: optional)              │   │
     │      ▼                             │   │
     │  ┌────────────┐                    │   │
     │  │ merge_ready│─►(Phase 6 queue)   │   │
     │  └────────────┘                    │   │
     │                                    │   │
     │ git worktree remove                │   │
     ▼                                    │   │
┌─────────────────┐  gc fails             │   │
│     removed     │──────────────────────►│   │
└────────┬────────┘                       │   │
         │ git worktree prune + reg GC    │   │
         ▼                                │   │
┌─────────────────┐                       │   │
│     gc_done     │ (terminal)            │   │
└─────────────────┘                       │   │
                                          ▼   │
                              ┌──────────────────────────┐
                              │ preserve_failed (visible)│
                              │ gc_error (reaper retries)│
                              └────┬─────────────────────┘
                                   │
                                   │ user retries / discard
                                   │ OR reaper retry (gc_error)
                                   └──────────────────────► (back to appropriate state)
```

## Reaper interruption

At any non-terminal state, the reaper may observe the lease as stale
(PID dead, nonce mismatch, or heartbeat expired beyond
`heartbeat_timeout_secs`). The reaper claims the lease (Model B
per-sweep `flock`) and re-enters the SAME state (idempotent
transitions). Example:

```
agent dies during snapshotting:
  state at death: snapshotting
  reaper observes stale lease, claims it
  reaper re-runs snapshotting (idempotent: existing partial quarantine
    is overwritten or detected as identical)
  proceeds to artifact_written → ... → gc_done
```

## Half-state visibility

`preserve_failed` and `gc_error` are visible in the UI tile for the
agent. User-actionable buttons:
- **Retry** — re-enter the failed transition
- **Discard preserved artifact** — only available from `preserve_failed`
  with explicit user consent; clears quarantine + wip ref
- **Open quarantine dir** — opens `quarantine/<agent-id>/` in OS file
  manager

`gc_error` is automatically retried by the reaper up to `gc_max_retries`
(default 5); after exhaustion, surfaces to user.
