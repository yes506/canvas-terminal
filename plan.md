# Cycle E — peer-context-mirror discovery rewrite (mtime-based)

`scale: feature   marker on merge: (plan-feature, human-confirmed)`

(Prior `plan.md` on `dev` documented cycle B `cluster-h-agent-lifecycle`.
Overwritten with this cycle E plan; historical content reachable via
`git log -- plan.md`.)

## Goal

Replace the lsof-based `discover_session` primitive in all three
adapters (Claude Code, Codex, Gemini) with an mtime-based scan of each
adapter's project directory, gated by `spawned_at_unix_ms`. Required
because Claude Code 2.1.133 (and likely Codex) uses **open-append-close
per turn** — they do NOT hold the session JSONL open between turns, so
`lsof -p <pid>` finds nothing even when the JSONL exists on disk and
has substantial content. Cycle B's discovery model is broken for this
class of CLI.

## Background (evidence from cycle C+D verification)

- Spawned a Claude Code agent (PID 43953, cwd `/Users/donghyeon`).
- Sent it a message; the agent processed it and wrote 117 KB to
  `~/.claude/projects/-Users-donghyeon/7f8461bd-c0e3-4e47-820b-5084669389ae.jsonl`.
- `lsof -p 43953 | grep jsonl` → empty.
- `lsof` on all four direct children (43967, 43970, 43986, 43996) and
  one observed grandchild (43968) → all empty.
- 3-second observation post-write shows the file is closed (size
  stable, mtime not advancing).
- Cycle D's descendant-walk fix is therefore irrelevant for this class
  of CLI — there's nothing to discover regardless of how deep the
  walk goes.

The cycle B docstring at `adapters/mod.rs::discover_pid_fd` rationale
("M8: lsof gives authoritative open-fd info ... one JSONL open per CLI
process") is invalidated by this evidence. Cycle E moves all three
adapters off that primitive.

## In-scope

### N1 — `discover_pid_cwd(pid: i32) -> io::Result<PathBuf>`

New private helper in `adapters/mod.rs`. Mirrors the lsof-d-cwd pattern
already in `commands/pty.rs::get_pty_cwd` (line 514) but returns
`PathBuf` (not `String`) for direct `.join()` use by adapter code.

- macOS: `/usr/sbin/lsof -a -p <pid> -d cwd -F n`, parse the single
  `n`-prefixed line.
- Linux: `std::fs::read_link("/proc/<pid>/cwd")`.
- Other OSes: `Err(io::ErrorKind::Unsupported)`.

Error semantics mirror existing helpers: `Io` for genuine OS failures
(lsof spawn, readlink permission denied); a missing `n` line surfaces
as `Io` with `NotFound`.

### N2 — `discover_by_mtime(adapter_id, agent_handle, scan_roots, spawned_at_unix_ms, predicate) -> Result<TranscriptHandle, DiscoveryError>`

New private helper in `adapters/mod.rs`. The mtime-based discovery
primitive. Replaces `discover_handle`'s call to `discover_pid_fd` with
a `readdir` + mtime-filter loop.

Signature:

```rust
pub(super) fn discover_by_mtime<F>(
    adapter_id: &'static str,
    agent_handle: &str,
    scan_roots: &[PathBuf],
    spawned_at_unix_ms: i64,
    predicate: F,
) -> Result<TranscriptHandle, DiscoveryError>
where
    F: Fn(&Path) -> bool;
```

Algorithm:
1. Convert `spawned_at_unix_ms` to a `SystemTime` threshold. Subtract a
   small slack (500ms) to defend against clock-skew between the
   frontend's `Date.now()` and the agent's filesystem write — the JS
   timestamp may be a few ms behind the actual CLI process spawn.
2. Retry loop: up to **5 iterations** with **500ms sleep** between
   attempts (per Phase 0.5 Q3 decision — 2.5s total window).
3. Each iteration:
   - For each `root` in `scan_roots`:
     - `read_dir(root)` (non-recursive; callers pre-enumerate the
       directories they want scanned — Codex passes today + yesterday).
     - For each entry: `lstat`, apply `predicate(entry.path())`, filter
       by `mtime >= threshold`.
     - Keep the entry with the **maximum mtime** across all roots in
       this iteration.
   - If a candidate exists: run `fs_gate::check_transcript_root`,
     re-lstat the canonical path for source_inode, fetch `memory_dir`,
     return the `TranscriptHandle`. Stop retrying.
   - If no candidate: sleep 500ms, try again.
4. After 5 failed iterations: return `DiscoveryError::NoMatchingFd`.

Error handling:
- `read_dir` failure on a single root is logged (best-effort) and
  treated as "no candidates from this root"; other roots still
  scanned. This matches the existing `list_children` policy in cycle D.
- `fs_gate::check_transcript_root` failure surfaces as
  `DiscoveryError::Gated` (existing variant).
- Total time bounded at ~2.5s; the watch_transcript IPC will block
  for at most that long. Frontend `AgentMiniTerminal` already shows a
  "spawning" indicator that doesn't update during this window, so the
  delay is invisible to the user.

The legacy `discover_handle` helper is preserved as-is for N6 (dead
code), so this is purely additive.

### N3 — `ClaudeCodeAdapter::discover_session` rewrite

```
fn discover_session(&self, agent_handle, pid, spawned_at_unix_ms) {
    let cwd = discover_pid_cwd(pid).map_err(DiscoveryError::Io)?;
    let home = dirs::home_dir().ok_or(...)?;
    // Claude Code project-dir encoding: leading "-" + every "/" -> "-"
    let encoded = format!("-{}", cwd.to_string_lossy().replace('/', "-"));
    let project_dir = home.join(".claude").join("projects").join(encoded);
    discover_by_mtime(
        self.tool_id(),
        agent_handle,
        &[project_dir],
        spawned_at_unix_ms,
        |p| p.extension().map_or(false, |e| e == "jsonl"),
    )
}
```

Notes:
- `cwd.to_string_lossy()` is acceptable: cwd here is the canonical
  cwd of the spawned CLI; non-UTF-8 paths don't occur on macOS/Linux
  in practice (Claude Code itself wouldn't function with a non-UTF-8
  cwd).
- Predicate filters by extension only — the directory listing is
  already partitioned by cwd, so any `.jsonl` here belongs to a
  session for that cwd. The mtime + spawned_at_unix_ms gate
  distinguishes the agent's session from older sessions for the same
  cwd.

### N4 — `CodexAdapter::discover_session` rewrite

Codex doesn't partition by cwd — `~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-<...>.jsonl`.
The spawn window is sub-second, so two date dirs (today + yesterday)
cover the spawn-near-midnight edge case.

```
fn discover_session(&self, agent_handle, _pid, spawned_at_unix_ms) {
    let home = dirs::home_dir().ok_or(...)?;
    let root = home.join(".codex").join("sessions");
    let now = SystemTime::now();
    let today = date_path_for(now);                     // YYYY/MM/DD
    let yesterday = date_path_for(now - 24h);
    let scan_roots = [root.join(&today), root.join(&yesterday)];
    discover_by_mtime(
        self.tool_id(),
        agent_handle,
        &scan_roots,
        spawned_at_unix_ms,
        |p| p.extension().map_or(false, |e| e == "jsonl")
            && p.file_name().and_then(|n| n.to_str())
               .map_or(false, |n| n.starts_with("rollout-")),
    )
}
```

The `date_path_for` helper is private to `codex.rs` (small enough not
to warrant adapters/mod.rs placement). Uses the same Howard Hinnant
`civil_from_days` algorithm as `synth_iso8601_now` (already in
adapters/mod.rs) to convert UNIX seconds → Y/M/D without a new crate.
**Note:** the existing `synth_iso8601_now` could be refactored to share
the civil_from_days math with a new `civil_date_for_unix_secs` helper,
but that's a Codex-internal refactor — not in cycle E scope. Inline
the date math in `codex.rs` for now.

`pid` parameter is unused (Codex is cwd-agnostic). Suppressed via
`let _ = pid;` like the existing `let _ = spawned_at_unix_ms;` in the
current implementation.

### N5 — `GeminiAdapter::discover_session` rewrite

Gemini's layout per existing code: `~/.gemini/tmp/<project-slug>/chats/session-<...>.jsonl`.
The `<project-slug>` encoding is **not yet known**. Plan:

```
fn discover_session(&self, agent_handle, pid, spawned_at_unix_ms) {
    let cwd = discover_pid_cwd(pid).map_err(DiscoveryError::Io)?;
    let home = dirs::home_dir().ok_or(...)?;
    let tmp_root = home.join(".gemini").join("tmp");
    // Investigation needed at impl time: derive Gemini's project-slug
    // from cwd. Fallback if encoding is non-trivial: glob over all
    // ~/.gemini/tmp/<*>/chats/ and filter by mtime + cwd-similarity.
    // The simpler-first path is to test what Gemini actually puts on
    // disk by running it once and reading the dir listing.
    let scan_roots = derive_gemini_scan_roots(&tmp_root, &cwd)?;
    discover_by_mtime(
        self.tool_id(),
        agent_handle,
        &scan_roots,
        spawned_at_unix_ms,
        |p| p.extension().map_or(false, |e| e == "jsonl")
            && p.file_name().and_then(|n| n.to_str())
               .map_or(false, |n| n.starts_with("session-")),
    )
}
```

`derive_gemini_scan_roots` is a private helper inside `gemini.rs`:
- **Primary**: if `~/.gemini/tmp/<encoded-cwd-or-similar>/chats/`
  exists, return `[that path]`.
- **Fallback**: glob `~/.gemini/tmp/*/chats/` and return all matching
  paths; the predicate + mtime + spawned_at_unix_ms still narrows to
  the right session.

The implementer phase investigates Gemini's actual encoding before
committing to primary or fallback. If primary works, the fallback can
be dropped. If primary doesn't, fallback is the implementation.

### N6 — `#[allow(dead_code)]` on legacy lsof primitives

After N3–N5 land, the following symbols in `adapters/mod.rs` have no
in-tree callers:

- `DESCENDANT_WALK_DEPTH_CAP`, `DESCENDANT_WALK_BREADTH_CAP` (consts)
- `discover_pid_fd`, `scan_one_pid`, `list_children` (helpers)
- `discover_handle` (orchestrator)

Annotate each with `#[allow(dead_code)]`. **Do not delete** — the
primitives remain useful for any future adapter whose CLI does hold
its JSONL open. The annotation is a one-line addition per symbol.

## Out-of-scope (deferred)

- Removing `discover_pid_fd` / `discover_handle` entirely (cleanup
  cycle, after we're sure no adapter wants to come back).
- Frontend changes — `watch_transcript` IPC contract is unchanged.
- Modifying `TranscriptAdapter` trait signature — kept stable per cycle
  B's commitment.
- `fs_gate`, `tailer`, `watcher` — all unchanged.
- Refactoring `synth_iso8601_now` into a shared `civil_from_days`
  helper that Codex's `date_path_for` could reuse — separate cleanup.

## Constraints

- **No trait signature change** on `TranscriptAdapter::discover_session`.
- **No new `DiscoveryError` variants** — cycle B committed `Io`,
  `Gated(String)`, `NoMatchingFd`.
- **`cargo check` + `tsc --noEmit` + `vitest 216/216`** all pass.
- **No deletion** of cycle D code — strictly additive plus annotation.

## Success criteria

1. After implementer merge, spawning a Claude Code agent, sending one
   message, and clicking Eye yields a non-empty
   `~/.cache/canvas-terminal/collab-memory/session-<APP_PID>/contexts/<handle>.jsonl`
   within ~3s of the Eye click.
2. Same flow works for Codex agents.
3. Same flow works for Gemini agents (or Gemini-specific quirks are
   documented in the implementation report).
4. No regressions: TS + Rust + vitest all green.
5. The 5×500ms retry inside `discover_by_mtime` means clicking Eye
   immediately at spawn (before the first agent reply) still works —
   the helper waits for the first JSONL to appear.

## Validation plan

- **Compile (planner phase)**: `cd src-tauri && cargo check` —
  baseline-green on dev@13a68a9 verified.
- **Implementer-phase validation**:
  `cd src-tauri && cargo check && cd .. && npx tsc --noEmit && npm test`
- **Smoke (post-merge, user-driven)**: per "Success criteria" 1–3.

## Risks

- **Multi-agent same-cwd race**: two Claude Code agents spawned in the
  same cwd within milliseconds — both scan the same project dir, both
  may match the same JSONL. `spawned_at_unix_ms` tiebreaker mitigates
  (the JSONL's first turn timestamp must be ≥ the spawn time of the
  agent that owns it). In practice, the user spawns agents one at a
  time, so the race window is unlikely. Documented but not specially
  handled in cycle E.
- **Gemini encoding unknown**: handled by the primary/fallback split
  in N5. Worst case is a wider glob, not failure.
- **Clock skew**: `Date.now()` from the frontend vs. filesystem mtime
  may differ by tens to hundreds of milliseconds. Mitigated by the
  500ms slack subtracted from the threshold in N2.
- **`~/.codex/sessions/` deep tree**: today's dir has at most a few
  JSONLs (one per session); listing is cheap. Cap at top-level
  `read_dir` of the two date dirs.

## Decomposition graph

See `plan.mmd` for the Mermaid DAG. Topological order:
**N1 → N2 → (N3, N4, N5 in any order) → N6**.

N4 (Codex) does not depend on N1 (no cwd resolution needed).
