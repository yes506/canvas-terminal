# Implementation report — transcript-bind-sessionfix

## Source
- Planner marker: **feature** from commit `ba76bce` (`feat(planner): merge transcript-bind-sessionfix plan (plan-feature, human-confirmed)`)
- Planner artifacts: `plan.md`, `plan.mmd`
- Source hash (sha256 of artifact hashes, short): `2bbd697ef1a2a337`

## Work queue summary
- Total items: 10 (N1–N10)
- Completed: 10
- Blocked: 0

Ordering followed `plan.mmd` root-first: N1 → N2 → N3/N4/N5 → N6 → N7 → N8 → N9 → N10.

## Files changed
- `src-tauri/src/commands/transcripts/mod.rs` (+93/−… ; N1, N2, N8, N9)
- `src-tauri/src/commands/transcripts/adapters/mod.rs` (+568/−… ; N6, N7, N9, N10)
- `src-tauri/src/commands/transcripts/adapters/codex.rs` (+2 ; N3)
- `src-tauri/src/commands/transcripts/adapters/claude_code.rs` (+2 ; N4)
- `src-tauri/src/commands/transcripts/adapters/gemini.rs` (+2 ; N5)
- `src-tauri/tests/transcript_adapter_contract.rs` (+1 ; N10 review — fixture signature)

Aggregate vs `dev` (CURRENT head, incl. `Cargo.lock` sync + 4 peer-review
reflection rounds): **8 files, +1126 / −90**. The bulk of the growth beyond the
initial impl is the `adapters/mod.rs` N7 helper hardening + regression tests
added across rounds 1–4 (see the Peer-review reflection sections). The initial
N1–N10 impl was 6 files, +578 / −90.

## Validation
- Baseline exit (`dev` HEAD): **0**
- Final validation command: `cargo build && cargo test` (run in `src-tauri`, shared `CARGO_TARGET_DIR` for cache reuse)
- Final exit: **0** (current head, after four peer-review reflection rounds)
- Auto-fix attempts used: 0 initial / 1 round-1 / 0 round-2 / 0 round-3 / 0 round-4
- Tail of last run (test totals — CURRENT head):

```
test result: ok. 64 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out   (lib)
test result: ok.  4 passed; 0 failed; ...                                     (tests/pty_eintr.rs)
test result: ok.  1 passed; 0 failed; ...                                     (tests/transcript_adapter_contract.rs)
```

> Round history: 56 lib (initial) → 58 (round-1, +2 `g_*`) → 60 (round-2,
> +`g_bare_quote…`+`full_header_identity…`) → 62 (round-3, +`g_assistant_quote…`
> +`g_tool_result_quote…`) → 64 (round-4, +`g_codex_agent_message…`
> +`g_gemini_model…`). See the Peer-review reflection sections below.

Build emits the same 9 pre-existing warnings present at baseline (unrelated `GateError` dead-code fields); no new warnings introduced.

## Per-item outcomes
| item_id | status | files_touched | notes |
|---|---|---|---|
| N1 | completed | transcripts/mod.rs | `discovery_loop` forwards `collab_session_id`; fallback gate now `collab_session_id.is_empty() && attempt >= MARKER_WAIT_ATTEMPTS` |
| N2 | completed | transcripts/mod.rs | trait `discover_session` gains `collab_session_id: &str` (borrowed discriminator) + docstring |
| N3 | completed | adapters/codex.rs | forwards `collab_session_id` to `discover_by_mtime` |
| N4 | completed | adapters/claude_code.rs | forwards `collab_session_id` |
| N5 | completed | adapters/gemini.rs | forwards `collab_session_id` |
| N6 | completed | adapters/mod.rs | `discover_by_mtime` gains `collab_session_id` param, threads into the N7 filter; docstring updated |
| N7 | completed | adapters/mod.rs | `transcript_has_identity_marker` reworked: backward-from-EOF turn-walk, parse-latest-then-compare on (handle, session), 8 MiB early-out cap, `pub(super)`. New helpers: `find_latest_identity_preamble_line`, `scan_tail_for_latest_needle`, `parse_identity_preamble_handle`, `line_references_collab_session`, `find_subslice`, `contains_subslice` |
| N8 | completed | transcripts/mod.rs | `populate_entry` Phase B revalidation reusing N7; rejects (keeps polling) on latest-marker mismatch; IO stays outside the `Inner` lock; only enforced for non-empty session |
| N9 | completed | adapters/mod.rs, transcripts/mod.rs | corrected codex-identity claims (×2) + MARKER_WAIT strict→fallback comment; clarified fallback is permanently off for CT watches |
| N10 | completed | adapters/mod.rs, tests/transcript_adapter_contract.rs | deterministic regression tests (a)–(f) incl. backward-reader cases; fixture signature updated |

## Design notes / decisions
- **Latest-preamble authority** lives in one helper (`transcript_has_identity_marker`), reused by both discovery (N6) and populate-time revalidation (N8), per the plan's single-source-of-truth requirement.
- **Session matching** builds needles `conversation-<sid>.md` / `contexts/<sid>/` from the **sanitized** expected id (`super::sanitize_collab_session_id`); the `.md` / `/` delimiters act as right word-boundaries so `session-3` cannot match `…session-32.md`.
- **Early-out cap** = 8 MiB (vs the plan's "a few MB"): comfortably exceeds the empirically-observed ≤~600 KiB EOF-to-marker distances while bounding the no-preamble per-poll cost; residual gap documented on `MARKER_BACKWARD_SCAN_CAP_BYTES` and exercised by tests (c)/(f).
- **Empty `collab_session_id`** selects legacy handle-only matching (future non-CT/manual watch), per in-scope #3.

## Peer-review reflection (round 1)

Five peer agents reviewed the implementation at `f34b30e`. Two (@codex3, @claude3)
independently found a **blocking** defect; three (@codex1, @claude2, @codex2)
approved behaviorally. I verified every finding against the code and reflected
the warranted fixes (synthesis: `session-32482/task-56-feedback-synthesis-claude1.md`).

- **BLOCKING — needle-presence ≠ preamble-turn (fixed, `20221f8`).** The
  latest-preamble walk treated any line *containing* `You are @` as authoritative
  and validated only that line. Later incidental occurrences (assistant text about
  the harness, code/diff attachments, doc placeholders, a bare `You are @`)
  shadowed the real current-launch preamble → with CT fallback permanently off,
  the mirror safe-spun forever. Fix: accept a line only if **well-formed**
  (parseable handle AND, for CT watches, a generic session-path token) and **keep
  walking** past mere-substring lines; apply latest-authority over the filtered
  set. New helpers `line_is_wellformed_preamble` / `line_has_any_session_token`.
- **Test blind spot (fixed).** Added `g_incidental_needle_after_preamble_does_not_shadow`
  and `g_foreign_wellformed_preamble_after_expected_rejects` (lib tests now 58).
- **Cargo.lock drift (fixed, `28cb99e`).** Pre-existing base drift (dev Cargo.toml
  0.5.10 vs committed lock 0.5.6); committed the regenerated lock so the worktree
  is clean. Behavior-neutral, outside the planner item set.
- **Residual (documented in code, not fixed):** a crafted single physical line
  carrying both a foreign handle and a session-path token can still mis-classify;
  the fully-robust fix is role-aware parsing, which the plan kept out of this
  byte-oriented helper. Candidate follow-up planner item.

Post-reflection validation: `cargo build && cargo test` → **58 lib + 4 + 1 passed,
0 failed**; auto-fix 1/3; only the 9 pre-existing dead-code warnings.

## Peer-review reflection (round 2)

Five peers re-reviewed the round-1 update at `383b9cf`. Tally: **block ×3**
(@codex1 task-62, @codex2 task-64, @claude2 task-63 — @claude2 *reproduced* it
with a scratch test) vs **approve ×2** (@codex3 task-65, @claude3
task-impl-review-r2). I verified the reproduction and reflected the consensus
minimum fix (synthesis: `session-32482/task-67-feedback-synthesis-claude1.md`).

- **BLOCKING — round-1 candidacy still admitted a cross-wire (fixed, `066f4ca`).**
  The round-1 gate (parseable handle + ANY generic `conversation-…md`/`contexts/…/`
  substring) still classified an ordinary later record that *quoted* a peer
  handle plus the expected session's mirror path as the latest preamble →
  wrong-agent bind, violating the "0 cross-wired" criterion. **Fix:** anchor
  candidacy on the harness's CT-preamble **structural shape** — for CT watches a
  line must carry the bracketed identity label (`[You are @…]` / `[Your identity:…]`)
  AND the bracketed session label (`[Conversation log:…]`), not bare substrings.
  Verified both header builders (`buildSlimHeader`, `prependContextHeader`) emit
  these labels, so message-1 / resume recognition is preserved. Helpers
  `line_has_ct_identity_bracket` / `line_has_ct_session_bracket` replace
  `line_has_any_session_token`.
- **Regression tests (lib 58 → 60):** `g_bare_quote_with_handle_and_expected_session_does_not_cross_wire`
  (reproduces the blocked case → now rejected) and `full_header_identity_form_is_recognized`
  (guards the full-header `[Your identity:…]` form against a liveness regression).
  Updated the two `f_*` reader tests to use realistic bracketed preamble content.
- **Residual narrowed (documented; planner follow-up):** only a record quoting a
  *complete* preamble block (both bracket labels present) can still slip the byte
  gate; empirically non-firing (per-task re-injection keeps the real preamble
  latest). Robust close = role/schema-aware JSON parsing — a justified small
  scope adjustment flagged upward to the planner, since a cheap `role == "user"`
  check is insufficient (a `tool_result` is itself a `role:user` record).
- **Report-stat staleness (codex3/claude2 minor):** the Validation section above
  now carries current totals + round history.

Post-round-2 validation: `cargo build && cargo test` → **60 lib + 4 + 1 passed,
0 failed**; no auto-fix needed; only the 9 pre-existing dead-code warnings.

## Peer-review reflection (round 3)

Five peers re-reviewed `63b2886`. Tally: **approve-with-follow-up ×4** (@codex2
task-70, @codex3 task-71, @claude2 task-63-r3, @claude3 task-impl-review-r3) vs
**block ×1** (@codex1 task-69). Crucially, **@claude3 corrected their round-2
"does not fire" claim**: the complete-preamble-quote residual IS live-reachable
(Claude rollouts `082f1689`, `5886ee16` — assistant/`tool_result` turns quoting a
peer preamble that land after the last real preamble), and supplied a cheap,
in-scope fix. (Synthesis: `session-32482/task-73-feedback-synthesis-claude1.md`.)

- **Residual closed for all observed carriers (fix `f4688eb`).** Added a
  record-kind guard `line_is_quote_or_tool_record`: a candidacy line carrying
  `"role":"assistant"` / `"type":"tool_result"` / `"tool_use_id"` is rejected
  (real CT preambles are user-role text records and never carry these; an
  include-side `role=="user"` check is insufficient because a `tool_result` is
  itself `role:user`, so we EXCLUDE on markers). Byte-level, same class as the
  bracket checks — not a JSON parse. This addresses @codex1's block and adopts
  @claude3's concrete recommendation.
- **Minor hardenings (codex1/claude2/codex3):** `[Your identity:` now requires
  the co-located `You are @` (`[Your identity: You are @`); fixed the stale
  "generic session-path token" inline comment.
- **Regression tests (lib 60 → 62):** `g_assistant_quote_of_complete_preamble_does_not_cross_wire`
  and `g_tool_result_quote_of_complete_preamble_does_not_cross_wire`.
- **Residual narrowed (still a recommended planner follow-up):** only a *crafted*
  record that quotes a complete preamble while avoiding those JSON markers
  remains — not seen in practice. Robust close = role/schema-aware preamble
  identification (verify a genuine user/first-turn launch record + content-block
  shape). Severity has converged each round: any `You are @` → handle+generic
  token → complete bracket block → complete bracket block in a non-quote record.

Post-round-3 validation: `cargo build && cargo test` → **62 lib + 4 + 1 passed,
0 failed**; no auto-fix; only the 9 pre-existing dead-code warnings.

## Peer-review reflection (round 4)

Five peers re-reviewed `03badc1`. Tally: **block ×2** (@codex2 task-81, @claude2
task-63-r4) vs **approve ×3** (@codex1 task-80, @codex3 task-82, @claude3
task-impl-review-r4) — but the three approvals exercised only the **Claude**
record forms. (Synthesis: `session-32482/task-88-feedback-synthesis-claude1.md`.)

- **BLOCKING — round-3 guard was Claude-only (fixed `c6ff776`).** @codex2 found
  (and @claude2 independently reproduced) that Codex's user-visible assistant
  bubble — `{"type":"event_msg","payload":{"type":"agent_message",…}}` — carries
  none of the round-3 markers, so a Codex `agent_message` quoting a peer's
  complete preamble still cross-bound. Same wrong-agent class for **Codex, the
  original-bug adapter**; Gemini `type:gemini` turns were likewise unguarded.
  **Fix:** made `line_is_quote_or_tool_record` per-adapter — added Codex
  (`agent_message`, `function_call(_output)`, `reasoning(_text)`) and Gemini
  (`gemini`, `function`) markers, verified none reject the genuine user preamble
  of any adapter (Claude `role:user` text / Codex `event_msg.user_message` /
  Gemini `type:user`).
- **Regression tests (lib 62 → 64):** `g_codex_agent_message_quote_does_not_cross_wire`
  (incl. the trailing `response_item` duplicate the backward walk must also
  reject) and `g_gemini_model_turn_quote_does_not_cross_wire`.
- **Doc/report polish (codex1/codex3/claude2 minors):** refreshed the over-stated
  residual comment on `find_latest_identity_preamble_line`; refreshed the stale
  top-level file/diff stats above.
- **Non-issue cleared:** @codex2's "dirty worktree / failing `scratch_zz_*` test"
  was a *concurrent reviewer's* (@claude2's) uncommitted scratch test in the
  shared worktree — confirmed not in the committed tree; my HEAD is clean.
- **Residual (recommended planner follow-up):** a crafted record avoiding every
  per-adapter marker, or a future adapter with an unmodelled record shape. Robust
  close = a per-adapter schema-aware "genuine injected user-preamble record"
  predicate. The byte-EXCLUDE now covers all three production adapters' known
  assistant/tool record shapes.

Post-round-4 validation: `cargo build && cargo test` → **64 lib + 4 + 1 passed,
0 failed**; no auto-fix; only the 9 pre-existing dead-code warnings.

## Peer-review reflection (round 5)

Five independent peer reviews (codex1/2/3, claude2/3): claude2 + codex2
**APPROVE**; codex1, codex3, claude3 **BLOCK**. Collected, verified each claim by
code trace, and reflected the verified ones.

- **BLOCKING — cap-hit accepted a truncated over-cap fragment as a complete
  preamble (codex1 #2, codex3, claude3 #1; 3-way convergence, confirmed by
  trace).** `find_latest_identity_preamble_line` passed `front_complete =
  at_bof || cap_hit` to `scan_tail_for_latest_preamble`. On `cap_hit && !at_bof`
  the leading segment is the suffix of an over-cap record, but was scanned as a
  complete line — so a quoted complete peer preamble whose `"role":"assistant"` /
  tool record-kind marker sits *before* the 8 MiB window bypassed the guard and
  could cross-bind, contradicting the cap's documented safe-spin guarantee.
  **Fix:** pass `at_bof` alone (one token); the truncated leading fragment now
  stays incomplete and is skipped → a preamble beyond the cap degrades to a safe
  spin, never a fabricated match. Refreshed the two now-stale comments.
- **Regression test (lib 64 → 65):** `cap_hit_does_not_accept_truncated_fragment_as_preamble`
  exercises the previously-untested cap path by injecting a small `cap_bytes`
  directly into the helper (no 8 MiB allocation). Verified it FAILS on the
  pre-fix code (returns `Some` → wrong bind) and PASSES post-fix.
- **Cleared, NOT a defect — genuine-preamble self-reject (codex1 #1, claude3 #2;
  disagreed with by claude2 #7 / codex2).** The concern: a launch prompt pasting
  a compact transcript snippet containing an excluded marker (e.g.
  `"type":"agent_message"`) would self-reject the genuine preamble. Verified the
  opposite: the pasted text is a JSON string *value*, so its quotes are escaped
  on disk (`\"type\":\"agent_message\"`) while the guard's needles use UNescaped
  quotes — the exact asymmetry that makes the EXCLUDE sound also bounds the
  false-reject direction. codex1/claude3 overlooked the escaping. **Reflected as
  defense-in-depth, not a code change:** regression test (lib 65 → 66)
  `g_genuine_preamble_with_escaped_marker_text_still_binds` pins the invariant,
  plus a doc note on `line_is_quote_or_tool_record`.
- **Minor/latent doc note — raw-vs-sanitized session-id coupling (claude3 #3).**
  The on-disk session bracket is built from the raw id, this needle from the
  sanitized id; they agree only for sanitization-stable ids (true for real
  `session-N-<ts>` ids). Documented the coupling on `line_references_collab_session`;
  not active, no code change.

Post-round-5 validation: `cargo test` → **66 lib + 4 + 1 passed, 0 failed**; only
the 9 pre-existing dead-code warnings.

## Scope-discipline self-check
- [x] No new interfaces / files outside hints (helper fns are inline in the same `adapters/mod.rs`)
- [x] No renames of committed public names
- [x] Signature changes (`discover_session`, `discover_by_mtime`) were the planner-specified work (N1–N6), not unplanned
- [x] No edits to validation_command configuration
- [x] No edits to files outside the work queue's hint set
