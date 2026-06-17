# Feature plan — transcript-bind-sessionfix

> Planner lane: **feature** (downgraded from rubric system; risk=3 concurrency,
> scope=2, ambiguity=1). Rust subsystem only. Canonical input: the `task-8`
> diagnosis (3 unanimous peer-review rounds) + two **plan-review rounds**
> (task-36..44 reworked N7/N8; task-46..49 approved with N7-wording + cost
> refinements). @codex1/@codex2/@codex3/@claude2/@claude3.

## Goal

Fix transcript-discovery binding so each agent's mirror file
`contexts/<collabSessionId>/<agent>.jsonl` is sourced from **that agent's own
rollout in that collab session**. Today 11 of 16 mirror files are cross-wired
(wrong agent and/or wrong session) within a single app run.

## Root cause (verified)

The source->agent binding key is **handle-only and not collab-session-scoped**:

- `transcript_has_identity_marker` (`adapters/mod.rs:34`) matches only
  `You are @<handle>` and scans only the **leading 256 KiB** from the top.
- `discover_by_mtime` (`adapters/mod.rs:704`) tiebreaks by **newest mtime** among
  handle-marked candidates -> a newer same-handle **wrong-session** rollout wins
  (`newest_marked`, `adapters/mod.rs:773-777`).
- `allow_unmarked_fallback` (`adapters/mod.rs:782`) binds the newest unclaimed
  candidate **regardless of marker** -> **wrong-agent** binds.
- App-global `claimed_paths` (`mod.rs:912-925`, no `collab_session_id` filter)
  turns one mis-bind into a cascade.
- On **resumed Claude rollouts** the current launch's preamble sits **deep** in
  the file (Claude `--resume` appends to the same JSONL), past a top-anchored
  256 KiB scan -> forced fallback.

## Governing design principle (from the plan-review round)

> **The LATEST identity-preamble turn in the rollout is authoritative.**

A rollout is one JSONL stream; on resume the current launch's CT preamble is the
**most recent** `You are @<handle>` turn, with any number of earlier (possibly
stale, foreign) headers behind it. Both discovery selection (N7) and
populate-time revalidation (N8) must key on the *latest* preamble turn — found by
parsing the latest preamble for **ANY** handle and then comparing its parsed
`(handle, session)` to the watcher's expected values. **Do NOT search only for
the expected handle** — that could skip a newer foreign preamble and wrongly
accept an older expected one. This single rule resolves both the N7 middle-gap
and the N8 stale-header defects.

## In scope

1. **[load-bearing]** Thread `collab_session_id` into `discover_session` (trait +
   3 adapters) and `discover_by_mtime` as a **borrowed, read-only discovery-time
   discriminator**. Ownership unchanged: watcher-owned, *filled* only at
   `populate_entry`. Adapters receive it, never store/fill it.
2. **[load-bearing] N7 — latest-preamble, scoped matching.** Replace the fixed
   top-256 KiB (and the earlier head+tail proposal — see "Rejected approach")
   with a **backward-from-EOF JSONL turn-walk**: read lines backward from EOF and
   stop at the first line carrying **any** `You are @<some-handle>` identity
   preamble (that is the current launch's), **parse its `(handle, session)`**, and
   accept only if it equals the expected `(agent_handle, collab_session_id)`.
   This **parse-latest-then-compare** order is mandatory (per unanimous reviewer
   note): never scan backward for the expected handle alone.
   **Cost/cadence:** `discover_session` is **out of the tailer hot loop** (M8,
   `mod.rs:288`), but it is **re-invoked every 5 s in the discovery-retry loop**
   (`discovery_loop`, `mod.rs:903`) until a *successful* bind — so the walk runs
   once per *successful* bind, re-evaluated each 5 s poll until then, per
   candidate. For a correctly-launched agent its latest preamble is near EOF and
   it binds on the first/second poll (cheap). To bound the pathological case
   (candidate with **no** CT preamble — e.g. a stray non-collab rollout in
   codex's date dir — would otherwise read to BOF every poll), the implementer
   **SHOULD** early-out the per-candidate backward read at a sane byte cap and
   treat "no preamble found within cap" as a non-match for that poll. If a cap is
   used, document the residual gap and add a boundary test (N10c/N10f).
3. **[load-bearing]** **Disable `allow_unmarked_fallback` for CT-launched collab
   watches** (`collab_session_id` non-empty). A missed marker then degrades to a
   safe `NoMatchingFd` spin/retry instead of a wrong bind. The fallback code path
   is retained, gated on an **empty** session id (future non-CT/manual watch).
   Because the latest-preamble walk (N7) is gap-free (to the cap), the safe-spin
   should not fire for a correctly-launched agent.
4. **[hardening] N8 — latest-marker authority.** In `populate_entry`, before
   committing the handle, resolve the bound source's **latest** identity-preamble
   turn (reuse N7's helper) and **reject** (return `false`, keep polling) only
   when that latest marker's `(handle, session)` differs from the watcher's, or
   no preamble is found. Stale historical headers earlier in the file are
   **ignored**, so valid resumed transcripts are not rejected.
5. Correct stale comments: `adapters/mod.rs:784-786` and
   `transcripts/mod.rs:898-899` (claim codex rollouts lack the CT identity line —
   they carry it) **and** the `MARKER_WAIT_ATTEMPTS` strict->fallback comment at
   `transcripts/mod.rs:893-901` (misleading once collab fallback is permanently
   off).

## Rejected approach (recorded so it is not re-proposed)

A fixed **HEAD + TAIL** raw-byte window (256 KiB each) was proposed in a prior
plan revision. The plan-review round **empirically refuted** it: on live large
Claude rollouts the latest marker frequently lands in the unscanned middle.
Independent measurement (12 rollouts >400 KiB): **4 had their latest marker in
the middle gap** (e.g. `069a3d81` 8.98 MB / last marker @8.40 MB; `c94df1f1`
1.28 MB / @993 KB), and several "tail" hits were within 8-64 KB of the boundary
(one more turn evicts them). With fallback disabled this converts wrong-data into
**no-data**. Hence the backward-from-EOF turn-walk in N7.

## Out of scope (reviewed decisions, not omissions)

- **Naively session-scoping `claimed_paths`** — it enforces the
  one-source != two-handles invariant together with the N17 dup-source guard
  (`mod.rs:1075`). Revisit only **after** scoped discovery lands (once #1+#2+#3
  prevent the initial mis-bind, the cascade cannot start). Follow-up, not here.
- No signature changes beyond `discover_session`; no re-architecture of the
  tailer / normalize / fs_gate pipeline.
- Frontend untouched — `watch_transcript` already passes `collabSessionId`.

## Constraints

- Rust subsystem only: `src-tauri/src/commands/transcripts/**`.
- Concurrency-sensitive: must not deadlock or spin beyond the **intended** safe
  spin; preserve N17 (no double-binding); keep the lock-ordering invariant in
  `populate_entry` (no `notify::unwatch` under the `Inner` lock); the N7 helper's
  IO must stay outside the `Inner` lock when called from `populate_entry`'s
  Phase B.
- IO cadence: N7 is re-evaluated each 5 s discovery poll (not the tailer hot
  loop). Prefer a gap-free backward walk; **recommend** an early-out byte cap for
  no-preamble / foreign candidates so they don't read to BOF every poll. Any cap
  must document its residual gap.
- **Session-token match format**: search for the **sanitized** `collab_session_id`
  as it appears embedded in the preamble's path text
  (`conversation-session-<id>.md`, `contexts/session-<id>/`), comparing via
  `sanitize_collab_session_id` so raw vs sanitized IDs match consistently.
- **Helper visibility**: `transcript_has_identity_marker` is currently a private
  `fn` in `transcripts::adapters`; `populate_entry` lives in the parent
  `transcripts` module. The implementer MUST either expose the (reworked) helper
  as `pub(super)` or relocate it to a shared parent module so N8 can reuse it.
- **Backward-reader robustness** (implementation risk, flagged by @claude2):
  backward JSONL line reading is fiddly — handle a missing trailing newline on
  the last line, turns larger than the read chunk (a single `user_message`
  preamble can be tens of KB), and chunk-boundary splits of the `You are @`
  needle. The ASCII-needle search is UTF-8-safe; line reassembly is where bugs
  hide. Cover the reader with its own unit test, separate from binding tests
  (N10f).

## Success criteria

- `cargo check` and `cargo test` green in `src-tauri`.
- New **deterministic** regression tests (N10):
  - (a) two same-handle / different-session candidates -> each binds its own.
  - (b) **stale wrong header in HEAD + correct current header later -> binds**
    (latest-preamble authority).
  - (c) **correct header followed by >256 KiB trailing output -> still found**
    (backward walk, no middle/tail gap).
  - (d) a different-handle candidate is **not** fallback-bound under a CT collab
    watch (non-empty session id).
  - (e) populate-time revalidation **rejects** a source whose **latest** marker's
    session/handle mismatches the watcher (and does NOT reject when only an
    earlier stale header mismatches).
  - (f) **backward-reader unit test**: last line without trailing newline; a
    preamble turn larger than the read chunk; needle split across a chunk
    boundary — all locate the preamble correctly.
- Re-running the collab flow yields **0** cross-wired mirror files.

## Open questions (none blocking)

- Early-out byte cap size for the N7 backward walk — proposed: a sane cap (e.g.
  a few MB) with a documented residual gap + N10c/N10f coverage; gap-free to BOF
  is acceptable for correctness but the cap is recommended to bound the
  no-preamble per-poll cost.
- Keep any fallback for a future non-CT/manual watch path — proposed: retain the
  code, gate it on an empty `collab_session_id`.

## Package layout

No new packages — the feature lives entirely in the existing `transcripts`
subsystem.

```
src-tauri/src/commands/transcripts/
- mod.rs              [MODIFY] trait discover_session sig; discovery_loop; populate_entry (N8); comments (N9)
- adapters/
  - mod.rs            [MODIFY] transcript_has_identity_marker (N7, backward-walk + parse-latest-then-compare + visibility); discover_by_mtime; comment
  - codex.rs          [MODIFY] discover_session forwards collab_session_id
  - claude_code.rs    [MODIFY] discover_session forwards collab_session_id
  - gemini.rs         [MODIFY] discover_session forwards collab_session_id
  (tailer.rs, fs_gate.rs, watcher.rs — UNTOUCHED)
src-tauri/tests/transcript_adapter_contract.rs   [REVIEW] trait-contract fixture (new param)
```

Dependency direction (unchanged): `discovery_loop` (owns `collab_session_id`) ->
`TranscriptAdapter::discover_session` -> concrete adapters -> `discover_by_mtime`
-> `transcript_has_identity_marker` (leaf). `collab_session_id` flows **down** as
a borrowed discriminator. `populate_entry` (sibling) reuses the leaf helper for
N8 revalidation.

## Decomposition

| Node # | Stage | Belongs to package | Notes |
|---|---|---|---|
| N1 | `discovery_loop` — own session id; session-aware fallback gate | `transcripts/mod.rs` | Pass `collab_session_id` into `discover_session`; `allow_unmarked_fallback = collab_session_id.is_empty() && attempt>=3`. In-scope #1,#3 |
| N2 | `TranscriptAdapter::discover_session` trait sig + docstring | `transcripts/mod.rs` | Add `collab_session_id: &str`; doc: "received as discriminator, not owned/filled". In-scope #1 |
| N3 | `CodexAdapter::discover_session` | `adapters/codex.rs` | Forward `collab_session_id`. In-scope #1 |
| N4 | `ClaudeCodeAdapter::discover_session` | `adapters/claude_code.rs` | Forward `collab_session_id`. In-scope #1 |
| N5 | `GeminiAdapter::discover_session` | `adapters/gemini.rs` | Forward `collab_session_id`. In-scope #1 |
| N6 | `discover_by_mtime` — scoped select; honor disabled fallback | `adapters/mod.rs` | New `collab_session_id` param; pass to N7; respect caller's fallback flag. In-scope #1,#2,#3 |
| N7 | `transcript_has_identity_marker` — backward-from-EOF turn-walk; parse-latest-then-compare (handle AND session); early-out cap; reusable + visible | `adapters/mod.rs` | Parse latest preamble for ANY handle, then compare. `pub(super)` or relocate. In-scope #2 |
| N8 | `populate_entry` — latest-marker-authority revalidation | `transcripts/mod.rs` | Reject only if LATEST marker's (handle,session) mismatches or absent; tolerate stale headers; reuse N7; keep lock-ordering. In-scope #4 |
| N9 | Stale-comment corrections (codex-identity x2 + MARKER_WAIT strict->fallback) | `adapters/mod.rs`, `transcripts/mod.rs` | In-scope #5 |
| N10 | Deterministic regression tests (a-f) | `adapters/mod.rs` tests + `tests/` | same-handle/diff-session; stale-head/correct-later; >256KiB trailing; fallback rejection; latest-marker reject; backward-reader unit test. Success criteria |

Load-bearing trio: **N1 + N6 + N7**. N8 reuses N7's latest-preamble helper (so
the authority semantics live in one place). N2-N5 are the mechanical signature
ripple. N9/N10 are docs/tests.

## Interfaces emitted

N/A — Phase 5 skipped (plan-only feature lane; modifies existing functions and
one trait signature rather than introducing new interfaces).

## Validation

Phase 7 plan-artifact smoke-check (skeletons skipped): `plan.md` contains the
required headers (`## Goal`, `## Package layout`, `## Decomposition`); `plan.mmd`
parses as Mermaid (`graph`). Compile/test validation (`cargo check` / `cargo
test` in `src-tauri`) is the implementer's phase against real bodies.

## Feature-lane gate note

The `(plan-feature, human-confirmed)` marker is **expected to be absent
pre-approval**; it lands on the Phase 8 `--no-ff` merge commit into `dev` after
the human types `confirm plan` + `confirm merge`. Reviewers correctly flagged its
current absence as a not-yet-confirmed state, not a planner error.
