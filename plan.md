# Feature plan — transcript-bind-sessionfix

> Planner lane: **feature** (downgraded from rubric system; risk=3 concurrency,
> scope=2, ambiguity=1). Rust subsystem only. Canonical input: the `task-8`
> diagnosis, confirmed across three unanimous peer-review rounds
> (@codex1/@codex2/@codex3, @claude2/@claude3).

## Goal

Fix transcript-discovery binding so each agent's mirror file
`contexts/<collabSessionId>/<agent>.jsonl` is sourced from **that agent's own
rollout in that collab session**. Today 11 of 16 mirror files are cross-wired
(wrong agent and/or wrong session) within a single app run.

## Root cause (verified)

The source->agent binding key is **handle-only and not collab-session-scoped**:

- `transcript_has_identity_marker` (`adapters/mod.rs:34`) matches only
  `You are @<handle>` and scans only the **leading 256 KiB** from the top of the
  source file.
- `discover_by_mtime` (`adapters/mod.rs:704`) tiebreaks by **newest mtime** among
  handle-marked candidates -> a newer same-handle **wrong-session** rollout
  actively wins (`newest_marked`, `adapters/mod.rs:773-777`).
- `allow_unmarked_fallback` (`adapters/mod.rs:782`) binds the newest unclaimed
  candidate **regardless of marker** -> **wrong-agent** binds.
- App-global `claimed_paths` (`mod.rs:912-925`, no `collab_session_id` filter)
  turns one mis-bind into a cascade.
- On **resumed Claude rollouts** the current launch's preamble sits **past** the
  256 KiB top window — verified on disk at `source_offset ~= 1,049,781`
  (`turn_index 318`) vs `MARKER_SCAN_CAP_BYTES = 262,144` — so even a scoped
  top-anchored scan would miss it -> forced fallback.

## In scope

1. **[load-bearing]** Thread `collab_session_id` into `discover_session` (trait +
   3 adapters) and `discover_by_mtime` as a **borrowed, read-only discovery-time
   discriminator**. Ownership is unchanged: still watcher-owned, still *filled*
   only at `populate_entry`. Adapters receive it, never store/fill it.
2. **[load-bearing]** Scoped + **resume-aware** marker: require BOTH
   `You are @<handle>` AND the `collab_session_id` token in the scan window; scan
   **HEAD and TAIL** windows (head = fresh codex rollouts with preamble at top;
   tail = resumed Claude rollouts whose latest re-injected header is near EOF).
   Both windows bounded by `MARKER_SCAN_CAP_BYTES` (no full-file reads).
3. **[load-bearing]** **Disable `allow_unmarked_fallback` for CT-launched collab
   watches** (i.e. when `collab_session_id` is non-empty). A missed marker then
   degrades to a safe `NoMatchingFd` spin/retry instead of a wrong bind. The
   fallback code path is retained, gated on an **empty** session id (future
   non-CT / manual watch).
4. **[hardening]** Populate-time re-validation in `populate_entry`: before
   committing the handle, scan the bound source's window and **reject** (return
   `false`, keep polling) if it embeds a different `collab_session_id` or a
   different `You are @<handle>` than expected. Reuses item-2's scan helper.
5. Correct the stale comments at `adapters/mod.rs:784-786` and
   `transcripts/mod.rs:898-899` that claim codex rollouts lack the CT-injected
   identity line (they do carry it — it's the injected first `user_message`).

## Out of scope (reviewed decisions, not omissions)

- **Naively session-scoping `claimed_paths`** — it enforces the
  one-source != two-handles invariant together with the N17 dup-source guard
  (`mod.rs:1075`). Per @codex2/@codex3, revisit its semantics only **after**
  scoped discovery lands (once #1+#3 prevent the initial mis-bind, the cascade
  cannot start, so the global claim set is harmless for correctness). Documented
  as a follow-up, not done here.
- No signature changes beyond `discover_session`; no re-architecture of the
  tailer / normalize / fs_gate pipeline.
- Frontend untouched — `watch_transcript` already passes `collabSessionId`.

## Constraints

- Rust subsystem only: `src-tauri/src/commands/transcripts/**`.
- Concurrency-sensitive: must not deadlock or spin beyond the **intended** safe
  spin; must not reintroduce double-binding (preserve N17). Keep the
  lock-ordering invariant in `populate_entry` (no `notify::unwatch` under the
  `Inner` lock).
- Bounded IO on every marker scan (head + tail caps; never read whole files).
- `collab_session_id` passed to adapters is the raw IPC value; sanitize/compare
  consistently with `sanitize_collab_session_id` where it is compared to the
  watcher-owned value.

## Success criteria

- `cargo check` and `cargo test` green in `src-tauri`.
- New **deterministic** regression tests:
  - (a) two same-handle / different-session candidates -> each binds its own.
  - (b) a different-handle candidate is **not** fallback-bound under a CT collab
    watch (non-empty session id).
  - (c) a preamble placed **past 256 KiB** (resumed rollout) is still matched via
    the tail scan.
  - (d) populate-time re-validation **rejects** a source whose embedded
    session/handle mismatches the watcher.
- Re-running the collab flow yields **0** cross-wired mirror files.

## Open questions (none blocking)

- Tail-window size — proposed: reuse `MARKER_SCAN_CAP_BYTES` for both head and
  tail.
- Keep any fallback for a future non-CT/manual watch path — proposed: retain the
  code, gate it on an empty `collab_session_id`.

## Package layout

No new packages — the feature lives entirely in the existing `transcripts`
subsystem.

```
src-tauri/src/commands/transcripts/
- mod.rs              [MODIFY] trait discover_session sig; discovery_loop; populate_entry; comment
- adapters/
  - mod.rs            [MODIFY] transcript_has_identity_marker; discover_by_mtime; comment
  - codex.rs          [MODIFY] discover_session forwards collab_session_id
  - claude_code.rs    [MODIFY] discover_session forwards collab_session_id
  - gemini.rs         [MODIFY] discover_session forwards collab_session_id
  (tailer.rs, fs_gate.rs, watcher.rs — UNTOUCHED)
src-tauri/tests/transcript_adapter_contract.rs   [REVIEW] trait-contract fixture (new param)
```

Dependency direction (unchanged): `discovery_loop` (owns `collab_session_id`) ->
`TranscriptAdapter::discover_session` -> concrete adapters -> `discover_by_mtime`
-> `transcript_has_identity_marker` (leaf). `collab_session_id` flows **down** as
a borrowed discriminator. `populate_entry` (sibling of `discovery_loop`) gains a
re-validation read that reuses the leaf scan helper.

## Decomposition

| Node # | Stage | Belongs to package | Notes |
|---|---|---|---|
| N1 | `discovery_loop` — own session id; session-aware fallback gate | `transcripts/mod.rs` | Pass `collab_session_id` into `discover_session`; set `allow_unmarked_fallback = (collab_session_id empty) && attempt>=3`. In-scope #1,#3 |
| N2 | `TranscriptAdapter::discover_session` trait sig + docstring | `transcripts/mod.rs` | Add `collab_session_id: &str`; clarify "received as discriminator, not owned/filled". In-scope #1 |
| N3 | `CodexAdapter::discover_session` | `adapters/codex.rs` | Forward `collab_session_id` to `discover_by_mtime`. In-scope #1 |
| N4 | `ClaudeCodeAdapter::discover_session` | `adapters/claude_code.rs` | Forward `collab_session_id`. In-scope #1 |
| N5 | `GeminiAdapter::discover_session` | `adapters/gemini.rs` | Forward `collab_session_id`. In-scope #1 |
| N6 | `discover_by_mtime` — scoped select; honor disabled fallback | `adapters/mod.rs` | New `collab_session_id` param; pass to scoped marker; respect caller's fallback flag. In-scope #1,#2,#3 |
| N7 | `transcript_has_identity_marker` — scoped + resume-aware | `adapters/mod.rs` | Needle = handle AND session token; scan HEAD+TAIL windows. Extract a reusable scan helper. In-scope #2 |
| N8 | `populate_entry` — re-validate bound source | `transcripts/mod.rs` | Reject mismatched embedded session/handle before commit; reuse N7 helper; keep lock-ordering invariant. In-scope #4 |
| N9 | Stale-comment corrections | `adapters/mod.rs`, `transcripts/mod.rs` | Fix the "codex has no identity line" claims. In-scope #5 |
| N10 | Deterministic regression tests (a-d) | `adapters/mod.rs` tests + `tests/` | Cover same-handle/diff-session, fallback rejection, past-256KiB tail match, populate re-validation. Success criteria |

Load-bearing trio: **N1 + N6 + N7**. N8 is defense-in-depth reusing N7. N2-N5
are the mechanical signature ripple. N9/N10 are docs/tests.

## Interfaces emitted

N/A — Phase 5 skipped (plan-only feature lane; the change modifies existing
functions and one trait signature rather than introducing new interfaces).

## Validation

Phase 7 plan-artifact smoke-check (skeletons skipped): `plan.md` contains the
required headers (`## Goal`, `## Package layout`, `## Decomposition`); `plan.mmd`
parses as Mermaid (`graph`). Compile/test validation (`cargo check` / `cargo
test` in `src-tauri`) is the implementer's phase to run against real bodies.
