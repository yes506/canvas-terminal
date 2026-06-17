# Implementation report — collab-context-collision-fix

## Source
- Planner marker: `feature` from commit `c909c23` `(plan-feature, human-confirmed)`
- Planner artifacts: `plan.md`, `plan.mmd`
- Source hash (sha256 of plan.md+plan.mmd, short): `e3e3804723c8a475`

## Work queue summary
- Total items: 22 (N1–N21 + N14b)
- Completed: 22
- Blocked: 0

The two defenses were implemented together (no split, per the plan's
convergence note): Defense-1 session namespacing + Defense-2A identity-marker
discovery + Defense-2B claimed-path exclusion + N17 atomic dup-source recheck.

## Files changed
- `src-tauri/src/commands/transcripts/mod.rs` (+278/-… ): `TranscriptHandle.collab_session_id` field (N3), `sanitize_collab_session_id` helper, `watch_transcript` IPC arg (N1), `watch` arg + thread to task (N2), `discovery_loop` claimed-path snapshot + finite marker-wait budget + retry-on-rollback (N9/N19), `populate_entry` sanitized attach + atomic dup-source recheck + bool return (N17), session-scoped `append_normalized_turn`/`rotate_if_needed`/`scan_archive_indices` (N6/N7/N8), stale comment sync (N21), `sanitize_tests` (N20)
- `src-tauri/src/commands/transcripts/adapters/mod.rs` (+199): `transcript_has_identity_marker` helper, `discover_by_mtime` 2A/2B/N19 rewrite + new params (N5/N19), `discover_handle` field (N4), `marker_tests` (N20)
- `src-tauri/src/commands/transcripts/adapters/{claude_code,codex,gemini}.rs` (+4 each): `discover_session` signature + forwarding (N4)
- `src-tauri/src/commands/transcripts/watcher.rs` (+1): handle clone carries new field (N3 consequence)
- `src-tauri/tests/transcript_adapter_contract.rs` (+2): fixture signature (N4)
- `src/lib/peerContext.ts` (+73): `sanitizeCollabSessionId` + session-scoped `loadActive`/`loadLastArchive`/`listArchives`/`hasContextsBreadcrumb`/`loadSnapshot` (N11–N14b)
- `src/lib/peerContext.test.ts` (+142, new): reader scoping + cross-session isolation + sanitize contract (N20)
- `src/components/collaborator/PeerContextPanel.tsx` (+12): `collabSessionId` prop → `loadSnapshot` (N15)
- `src/components/collaborator/AgentMiniTerminal.tsx` (+6): `collabSessionId` in `watch_transcript` invoke (N10)
- `src/stores/collaboratorStore.ts` (+44): session-scoped `[Peer contexts: …]` breadcrumb (N16) + `TASK_PROTOCOL` → `buildTaskProtocol(glob)` Rule-2 scoping (N18)
- `docs/collaborator-agent-protocol.md` (+9): session-scoped mirror path + Rule-2 glob (N18)

Total: 13 files, +686/-92.

## Validation
- Baseline exit (dev HEAD): 0 (clean)
- Final validation command: `(cd src-tauri && cargo check && cargo test) && tsc --noEmit && npm test`
- Final exit: 0
- Auto-fix attempts used: 1/3 (corrected a wrong assertion in my own new tests — the impl was correct; `"a/b\c..d e"` sanitizes to `"abcde"`, not `"abcd"`)
- Result tail (after peer-review round):
```
cargo test: 47 passed; 0 failed (lib) | 4 passed (integration) | 1 passed (contract)
tsc --noEmit: clean
vitest: Test Files 16 passed (16) | Tests 364 passed (364)
```

### Rust test coverage — precise scope (corrected after peer review)
N20's Rust tests cover: `sanitize_collab_session_id` contract (2),
`transcript_has_identity_marker` incl. word-boundary (5), AND — added in the
review round — `append_normalized_turn` session-scoped write vs. flat-path
absence + two-session isolation (1) and `scan_archive_indices` session scoping
+ cross-session exclusion (1). The **N17 dup-source rollback branch** in
`populate_entry` is NOT unit-tested: it sits behind `subscribe_fsevents` /
`tailer::resume_from_state`, which require a live FSEvents watcher and a real
source file under an fs_gate-allowed root — out of reach for an in-process unit
test without heavy fixtures. Its correctness is established by review (peer
@claude2 independently verified the rollback symmetry against the proven
entry-gone `RaceRollback` path) and by inspection; this report does not claim
it is covered by an automated test.

## Per-item outcomes
| item | status | notes |
|---|---|---|
| N1 watch_transcript IPC arg | completed | `collab_session_id: String` ↔ JS `collabSessionId` |
| N2 watch() + thread to loop | completed | threaded as param (mirrors existing `agent_handle` pattern) — see reconciliation note |
| N3 TranscriptHandle field | completed | `+` watcher.rs handle clone, both adapter constructors |
| N4 discover_session trait+impls+fixture | completed | added `claimed_paths` + `allow_unmarked_fallback`; NOT collab_session_id |
| N5 discover_by_mtime 2A+2B | completed | marker-prefer + claimed exclusion (canonical compare) |
| N6 append path session-scoped | completed | `contexts/<sid>/<agent>.jsonl`, mkdir -p |
| N7 rotate session-scoped | completed | active/archive/tmp under session dir |
| N8 scan_archive_indices session-scoped | completed | sanitizes defensively (pub method) |
| N9 discovery_loop claimed snapshot | completed | one lock with the exit-check |
| N10 AgentMiniTerminal invoke | completed | + dep array |
| N11–N13 readers | completed | session segment in path + regex |
| N14 hasContextsBreadcrumb | completed | scoped prefix; null/IPC-fail → false |
| N14b loadSnapshot | completed | threads collabSessionId |
| N15 PeerContextPanel | completed | new `collabSessionId` prop |
| N16 store breadcrumb | completed | `[Peer contexts: <dir>/contexts/<sid>/]` |
| N17 populate dup-source recheck | completed | atomic under Inner lock; rollback → loop retries |
| N18 TASK_PROTOCOL + docs | completed | `buildTaskProtocol(glob)`; doc x2 |
| N19 2A fallback termination | completed | finite marker-wait (3 polls ≈ 15s) → newest-unclaimed + warn |
| N20 tests | completed | Rust sanitize+marker+writer(append/scan), TS readers; N17 dup-rollback review-verified (not unit-tested — FSEvents dependency) |
| N21 stale comments/docs | completed | mod.rs docstrings + discover_by_mtime algo doc |

## Reconciliation notes (faithful to plan intent)
- **N2 — Entry storage vs param threading**: the plan listed "store collab_session_id on `Entry`". I threaded it as a `discovery_loop`/`populate_entry` parameter instead, exactly mirroring how the existing `agent_handle` flows (watch → loop → handle). This avoids redundant state that could drift from `TranscriptHandle.collab_session_id` (the load-bearing carrier per plan line 102 "watcher-owned, attached to handle at populate"). Same wiring, one source of truth.
- **N4/N19 — second discover_session arg**: N4 says "claimed_paths only (NOT collab_session_id)". N19's finite-retry policy requires the attempt count (loop state) to reach `discover_by_mtime`, so `discover_session` also gained `allow_unmarked_fallback: bool`. This honors N4's intent (adapter stays out of the collab_session_id business — it only does source discovery) while satisfying N19.

## Scope-discipline self-check
- [x] No new interfaces / files outside hints (only the planned test files added)
- [x] No renames of committed public names
- [x] No signature changes on planner-committed methods beyond the planned threading
- [x] No edits to validation_command configuration
- [x] No edits to files outside the work queue's hint set (watcher.rs touched only as a direct consequence of the N3 field addition)

## Peer-review round (task-6)

Five independent peer reviews were collected from the collaborator session
(`session-2403`): @codex1, @codex2, @codex3, @claude2, @claude3. Verdicts: one
explicit APPROVE (@claude2), four "no functional blocker." Each finding was
empirically re-verified against the tree before acting.

| Finding (reviewers) | Verdict after verification | Action |
|---|---|---|
| Rust N20 coverage incomplete; report overstated it (codex1, codex3, claude3 — Med) | TRUE — only sanitize/marker tests existed | Added `writer_tests` (append session-scoped vs flat + 2-session isolation; scan session-scoped + cross-session exclusion). Corrected report to scope N17 as review-verified, not unit-tested. |
| Stale truncation footer omits session segment (codex2, codex3, claude3 — Low) | TRUE — `renderTruncationFooter` showed flat path | Threaded `collabSessionId` into the footer; path now `contexts/<scope>/…`. |
| TS doc-comment drift (claude2, claude3 — Low) | TRUE — `types/peerContext.ts` ×2 still flat | Updated comments to session-scoped path. |
| `watch_transcript` effect lacks `!collabSessionId` guard (claude2 — Low) | Latent (hook returns non-empty `string`); cheap defense-in-depth | Added `|| !collabSessionId` to the effect guard with rationale. |
| Dirty worktree: `Cargo.lock` 0.5.6→0.5.9 + untracked `target/` (all — non-blocking) | Pre-existing **dev-branch** drift: committed `Cargo.lock` is 0.5.6 but `Cargo.toml` is 0.5.9 on dev, so **every** cargo invocation re-normalizes the lock — reverting does not stick. `target` is the build-cache symlink. | Left **uncommitted** (correct scope discipline — release/lockfile concern, not this feature; to be fixed on `dev` separately). The branch's 5 commits do NOT touch `Cargo.lock`, so the merge change-set is clean. The working tree re-dirties only because validation runs cargo. **Not claiming the working tree stays clean** — claiming the *merge* is clean. |
| Defense-2A marker assumption for Claude (claude2, claude3 — value-add) | Confirmed VALID: real claude transcripts contain `You are @claudeN`; codex/gemini remain the plan's stated open question, covered by N19 fallback + 2B/N17 | No change needed (matches plan). |
| N19 markerless residual / marker-forgery (codex1, claude3 — awareness) | Within plan's stated out-of-scope; 2B+N17 prevent double-binding regardless | No change (documented residual risk). |

All fixes stay within implementer scope: test additions, one UI path-display
fix, comment sync, and a defensive guard — no re-architecting, no signature
changes to planner-committed methods.

### Round 2 (task-12)

Re-reviewed the updated draft (`72aec16..0b2eddf`). Verdicts: **2 APPROVE**
(@claude2 "ship it", @claude3 "recommend merge") + 3 "no functional blocker".
No new functional findings. Two Low doc/hygiene items, both addressed:

| Finding (reviewers) | Verdict | Action |
|---|---|---|
| `src/lib/peerContext.ts` function docstrings still show flat `contexts/<agent>.jsonl` (codex2, codex3 — Low) | TRUE — N21 synced types + Rust but missed these 4 docstrings | Updated `hasContextsBreadcrumb`/`loadActive`/`loadLastArchive`/`listArchives` docstrings to `contexts/<collabSessionId>/…` |
| `Cargo.lock` re-dirties despite report saying "reverted/clean" (codex1, codex2, codex3 — Low) | TRUE — cargo re-normalizes 0.5.6→0.5.9 every run; my revert can't stick | Corrected report language (above row) to claim a clean *merge change-set*, not a clean working tree; lock left uncommitted as a dev-branch concern. Reverted again immediately before the merge gate. |

Multiple reviewers explicitly endorsed the decision to scope N17's dup-source
rollback as review-verified-not-unit-tested (FSEvents dependency) rather than
author a brittle fake test.
