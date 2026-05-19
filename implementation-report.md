# Implementation report — cluster-h-prep-rust-bridge

## Source

- Planner marker: `local` (chat-gate) — `(plan-local, human-confirmed)`
  emitted by `/codebase-planner` in this session, followed by user
  `confirm plan`.
- Source: 2-bullet planner reflection block.

(Prior `implementation-report.md` on `dev@eccb4aa` documented
`wire-inode-rotation-recovery`. Overwritten with this session's report;
historical content reachable via `git log` on the prior merge.)

## Work queue summary

- Total items: 2 (chat bullets)
- Completed: 2
- Blocked: 0

## Files changed

- `src-tauri/src/commands/transcripts/mod.rs` (+30 / -10) — `watch_transcript` IPC signature refactor
- `src-tauri/src/commands/pty.rs` (+7 / -4) — `spawn_shell` body wiring + `apply_extra_env` attribute cleanup

## Validation

- Baseline exit (BASE_BRANCH HEAD `dev@eccb4aa`): 0
- Final validation command: `cargo check --manifest-path src-tauri/Cargo.toml && cargo test --test transcript_adapter_contract --manifest-path src-tauri/Cargo.toml`
- Final exit: 0
- Auto-fix attempts used: **0 / 3** (clean first pass)
- cargo check tail:
  ```
  warning: `canvas-terminal` (lib) generated 10 warnings
      Finished `dev` profile target(s) in 6.35s
  ```
  Warning count unchanged from baseline. The dropped `#[allow(dead_code)]` on `apply_extra_env` is offset by the now-real call from `spawn_shell` (net zero).
- transcript_adapter_contract fixture: 1 passed; 0 failed

## Per-item outcomes

| item_id | status | files_touched | notes |
|---|---|---|---|
| bullet-1 | completed | `transcripts/mod.rs` | `watch_transcript(transcript_state, app_state, session_id, agent_handle, tool, spawned_at_unix_ms) → Result<u64, String>`. Resolves PID server-side via `app.sessions[session_id].child.process_id()` under a minimal lock scope (mirrors `pty.rs::get_pty_cwd` pattern). Single-call design avoids the TOCTOU race a two-step (`get_pty_pid` + `watch`) approach would introduce. Zero TS callers today (Cluster H deferred) so the breaking signature change has zero blast radius. |
| bullet-2 | completed | `pty.rs` | Removed `let _ = &extra_env;` placeholder + comment from `spawn_shell` body. Added real `apply_extra_env(&mut cmd, extra_env.as_ref())` call AFTER `apply_baseline_env(&mut cmd)` per helper's docstring contract ("caller-provided keys override baseline values when collisions occur"). Removed `#[allow(dead_code)]` attribute from `apply_extra_env` since the helper now has a genuine caller. |

## Scope-discipline self-check

- [x] No new interfaces / files outside hints — touched only the 2 files named in planner bullets
- [x] No renames of committed public names — `watch_transcript` is an architecture-implied addition from session 6 (not a planner-committed skeleton); its signature change is permitted under local lane and has zero callers
- [x] No signature changes on planner-committed methods — `apply_extra_env` body unchanged; `spawn_shell` signature unchanged (only its body now uses the previously-inert `extra_env` parameter)
- [x] No edits to `validation_command` configuration — `Cargo.toml` / `tsconfig.json` untouched
- [x] No edits to files outside the work queue's hint set — diff stat confirms exactly 2 files

## Bug history (for the audit trail)

- **`watch_transcript` IPC**: added in session 6 (commit `1aabafa` per
  the peer-context-mirror lineage) as an architecture-implied
  `#[tauri::command]` wrapper. Took `pid: i32` because the original
  rough plan assumed the frontend could supply the PID. Investigation
  for cycle A revealed: the frontend doesn't have the PID (portable_pty
  hides it inside `PtySession.child`); only the server can resolve it.
  Hence the refactor.
- **`spawn_shell::extra_env`**: parameter added in the planner touch-up
  (commit `bffb828`, plan-feature). The implementer scope discipline at
  the time forbade the body wiring (would have been "implementation in
  a planner cycle"), so the body had `let _ = &extra_env;` as a
  placeholder with a TODO comment naming this exact follow-up. This
  cycle's bullet-2 cashes that TODO.

## Commits on `implementer/cluster-h-prep-rust-bridge-48944-20836-25248`

```
6167702 fix(implementer): cycle A — watch_transcript takes session_id + spawn_shell wires extra_env
```

Branched off `dev@eccb4aa`.

## Recommended response at Phase 6

**`confirm merge`** — the fix is minimal (2 edits, ~30 lines net),
restores the docstring-promised contract for both `spawn_shell::extra_env`
and `watch_transcript`'s IPC shape, validates cleanly, and unblocks
the next cycle (cycle B: TS-side AgentMiniTerminal useEffect lifecycle).

After merge, downstream marker `(impl-local, human-confirmed)` lands.
The Rust side of Cluster H's prerequisites is then complete; the
remaining work is purely TypeScript (AgentMiniTerminal useEffect +
publish-opt-in store flag + reservation lifecycle wiring + PeerContextPanel
mount point + breadcrumb wiring).
