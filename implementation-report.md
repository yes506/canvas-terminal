# Implementation report — cycle-e-mtime-discovery

(Prior `implementation-report.md` on `dev` documented cycle D
`cycle-d-discover-walk-and-drain`. Overwritten with this cycle E report;
historical content reachable via `git log -- implementation-report.md`.)

## Source
- Planner marker: `feature` from commit `1f060df` (`(plan-feature, human-confirmed)`)
- Planner artifacts: `plan.md` + `plan.mmd` on `dev`
- Source hash: based on `1f060df`'s plan.md (12.6 KB) and plan.mmd
  (48-byte placeholder; the planner state file held the real
  decomposition graph)

## Work queue summary
- Total items: 6 (N1, N2, N3, N4, N5, N6)
- Completed: 6
- Blocked: 0
- Auto-fix attempts used: 0/3

## Files changed
- `src-tauri/src/commands/transcripts/adapters/mod.rs` (+221 / -0; new helpers + N6 annotations)
- `src-tauri/src/commands/transcripts/adapters/claude_code.rs` (+30 / -23; rewrite)
- `src-tauri/src/commands/transcripts/adapters/codex.rs` (+58 / -18; rewrite + date helper)
- `src-tauri/src/commands/transcripts/adapters/gemini.rs` (+66 / -15; rewrite + scan-roots helper)

## Validation
- Baseline exit (`dev@1f060df`): 0
- Final validation command: `cd src-tauri && cargo check && cd .. && npx tsc --noEmit && npm test`
- Final exit: 0
- Auto-fix attempts: 0/3
- `cargo check`: **10 warnings**, identical to baseline (the long-standing FsSafety/Debug warning + 9 others — none introduced by cycle E)
- `tsc --noEmit`: exit 0, no errors
- `npm test`: **216/216 pass** in 12 test files, 1.56s

## Per-item outcomes

| item_id | status | files_touched | notes |
|---|---|---|---|
| N1 | completed | `adapters/mod.rs` | `discover_pid_cwd(pid)` → `PathBuf`. macOS: `lsof -a -p <pid> -d cwd -Fn`. Linux: `read_link("/proc/<pid>/cwd")`. Other OSes: `Err(Unsupported)`. NotFound surfaced when lsof returns success but no `n`-line. |
| N2 | completed | `adapters/mod.rs` | `discover_by_mtime(adapter_id, agent_handle, scan_roots, spawned_at_unix_ms, predicate) -> Result<TranscriptHandle, DiscoveryError>`. 5×500 ms retry with 500 ms clock-skew slack. Per-iteration scans all roots, keeps max-mtime candidate, runs fs_gate + lstat + memory_dir wiring inline (mirrors legacy `discover_handle`). `handle.pid` set to 0 — the value is no longer meaningful under mtime discovery and is only pass-through in `watcher::on_fs_event:230`. Bounded total time ≈ 2 s sleep + read_dir cost. |
| N3 | completed | `adapters/claude_code.rs` | Body rewrite. `discover_pid_cwd(pid)` → encode cwd via `replace('/', "-")` (preserves Claude's leading-dash convention since a leading `/` becomes a leading `-`) → `~/.claude/projects/<encoded>/` → `discover_by_mtime` with `.jsonl` predicate. |
| N4 | completed | `adapters/codex.rs` | Body rewrite + new `date_path_for_unix_secs` helper (private; inlined civil_from_days math, sharing-with-`synth_iso8601_now` deferred to a later cleanup per plan). `scan_roots = [today_date_dir, yesterday_date_dir]`. Predicate filters to `.jsonl` with `rollout-` basename prefix. `pid` parameter no longer used (Codex is cwd-agnostic). |
| N5 | completed | `adapters/gemini.rs` | Body rewrite + new `derive_gemini_scan_roots(tmp_root)` helper (private). Glob enumeration of `~/.gemini/tmp/*/chats/` since the cwd → project-slug encoding is not yet known; mtime + predicate inside `discover_by_mtime` narrows reliably. `~/.gemini/tmp` absent → `NoMatchingFd` (matches docstring test-contract verbatim). |
| N6 | completed | `adapters/mod.rs` | `#[allow(dead_code)]` on `DESCENDANT_WALK_DEPTH_CAP`, `DESCENDANT_WALK_BREADTH_CAP`, `discover_pid_fd`, `scan_one_pid`, `list_children`, `discover_handle`. Bodies preserved verbatim — no deletion (legacy primitives remain available for any future adapter whose CLI does hold its transcript open). |

## Scope-discipline self-check

- [x] No new interfaces / files — touched only the 4 files in the planner-decomposition table
- [x] No renames of committed public names — adapter struct names, `TranscriptAdapter` trait, `TranscriptHandle` fields, `DiscoveryError` variants all unchanged
- [x] No signature changes on planner-committed methods — `discover_session(agent_handle, pid, spawned_at_unix_ms)` keeps its exact shape; the cycle B trait contract is preserved
- [x] No edits to validation_command configuration — `Cargo.toml`, `package.json`, `tsconfig.json` untouched
- [x] No edits to files outside the work queue's hint set — diff stat confirms exactly 4 files
- [x] No new `DiscoveryError` variants — cycle B's `Io` / `Gated(String)` / `NoMatchingFd` set preserved

## Architecture-pattern notes

- **`handle.pid = 0` under mtime discovery**: the previous lsof model used `pid` as the originating proof ("this is the process whose FD points at this file"). That semantic is gone — mtime discovery binds by filesystem timestamp, not by process. Setting `pid = 0` is honest about that; `TranscriptHandle.pid` remains as a field only because removing it would change a cycle B-committed struct shape. The only reader (`watcher::on_fs_event:230`) just copies it through.
- **Bounded retry inside the IPC handler**: `discover_by_mtime` blocks `watch_transcript` for up to ~2.5 s on cold-spawn click-Eye flows. The frontend's `spawning` indicator already covers this latency; no additional user-facing state is needed. If the CLI is wedged and never writes, the user sees the same "no contexts/" outcome they'd see today — just 2.5 s later.
- **Clock-skew slack**: 500 ms subtracted from `spawned_at_unix_ms` to defend against the JS→Rust→syscall path. Negligible cost (one Duration arithmetic), real benefit on slow VMs where filesystem mtime can lag Date.now() by tens of ms.
- **Codex date math inlined rather than shared**: extracting a `civil_date_for_unix_secs` helper into `adapters/mod.rs` would force `synth_iso8601_now` to refactor too — out of scope. The math is small (~10 lines) and identical in shape to `synth_iso8601_now`'s already-present version. Future cleanup cycle can consolidate.
- **Gemini cwd-encoding deferred**: rather than reverse-engineer Gemini's project-slug naming, we glob all chats subdirs. The 5-poll retry + spawned_at_unix_ms + basename predicate narrows reliably. Investigating the slug-encoding in a future cycle can tighten this to a single scan root.
- **Cycle D primitives kept**: rather than delete `discover_pid_fd` / `discover_handle` / friends, we annotated them dead_code. They remain useful primitives for any future adapter whose CLI holds its transcript open continuously. The annotations are one-line additions; deletion can happen in a dedicated cleanup cycle once cycle E is settled in production.

## Commits on `implementer/cycle-e-mtime-discovery-71976-60876-24546`

```
d9ab2d3 feat(implementer): cycle E — mtime-based transcript discovery (N1-N6)
```

Branched off `dev@1f060df`.

## Smoke-test plan (post-merge, user-driven)

The cycle E fixes target a runtime path that has no Rust unit-test
coverage (the transcripts module has no `#[cfg(test)]` hits).
Verification is by manual smoke:

1. **Stop** the running `npm run tauri dev`; **start** it fresh so cargo
   rebuilds the binary with cycle E code.
2. **Claude Code path** — primary smoke:
   - Spawn a Claude Code agent in the Canvas Terminal mini-terminal.
   - Click the mini-terminal pane to focus it.
   - Type `hello` and press Enter; wait for the agent's reply.
   - Click the Eye toggle on that agent's header.
   - Within ~3 s, `~/.cache/canvas-terminal/collab-memory/session-<APP_PID>/contexts/<handle>.jsonl` should appear (where `<handle>` is e.g. `claude1`).
   - Cycle continues to grow on subsequent turns (notify-driven appends).
3. **Codex path** — secondary smoke:
   - Spawn a Codex agent, type a prompt, send, click Eye. Same expectation.
4. **Gemini path** — secondary smoke:
   - Spawn a Gemini agent, send a prompt, click Eye. Same expectation. If the wide glob over `~/.gemini/tmp/*/chats/` proves too slow or matches the wrong file, follow-up cycle can derive the slug encoding.
5. **Pre-message edge** — click Eye **before** sending the first message:
   - Should still work — `discover_by_mtime`'s 5×500ms retry catches the first JSONL within 2.5 s of the agent writing it.

## Recommended response at Phase 6

**`confirm merge`** — cycle E completes the discovery rewrite that
unblocks peer-context-mirror for the current generation of CLIs.
Validation is green without auto-fix intervention. All planner
constraints honored (no trait change, no new DiscoveryError variants,
all three adapters covered per Phase 0.5 Q1).

After merge, downstream marker `(impl-feature, human-confirmed)`
lands on `dev`. The peer-context-mirror feature should then surface
context for Claude Code and Codex via the Eye toggle alone — no
DevTools, no manual file inspection, no per-version CLI workarounds.
