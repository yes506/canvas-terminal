# Implementation report — resilience-recovery

## Source
- Planner marker: **system** (`interfaces only, human-confirmed`) from commit `6a02d5f`
- Planner artifacts: `ai-artifacts/runs/code/resilience-recovery-15880-14321-23155/architecture.{html,mmd}`
- Source hash: `87ac9ba9668d7a73`
- Phase 0 note: the marker commit carried **no `AI-Artifacts-Run-Dir:` trailer**. The run-dir was unambiguous (exactly one `ai-artifacts/runs/code/*` dir in the marker tree, allowlist-passing, both artifacts present) and the user **human-confirmed** proceeding with it (override of the missing-trailer refusal).
- Scope ratified by user: **"Build full TS layer now (staged)"** — 38 interface method bodies as concrete classes + 3 planner-sanctioned restore-only store seams + a `resilienceConfig.recoveryGateOpen` flag, with `invoke()` wired to the **deferred** Rust IPC commands (a separate Rust planner run). `recoveryGateOpen` defaults **CLOSED**, so the reload-crossing recovery path never fires until Rust lands and the gate is opened.

## Work queue summary
- Total items: **41** (38 interface methods + config + 3 store seams; counted at the file/seam granularity in `.implementer-state.json`)
- Completed: **41**
- Blocked: **0**

The implementation is the downstream half the planner explicitly assigned (`architecture.html` Out-of-scope: *"메서드 바디 구현 (다운스트림 implementer 소관)"*). The Rust IPC layer (`persist/load_topology`, `reattach_pty`, `persist/load/claim/clear_recovery_session`, `read_death_evidence`, `report_heartbeat`, `recreate_webview`), the `blankObserved` compositor probe, the replay-ring byte cap, and `main.tsx` block-first-render remain **out of scope** (deferred Rust run) per the marker commit's "Downstream holds" note.

## Files changed
- `src/lib/resilience/config.ts` (+66) — `resilienceConfig` incl. the `recoveryGateOpen` gate (default CLOSED)
- `src/lib/resilience/WebglContextBudget.ts` (+48) — `IWebglContextBudget`
- `src/lib/resilience/ScrollbackPolicy.ts` (+35) — `IScrollbackPolicy`
- `src/stores/resilienceStore.ts` (+120) — `IResilienceStore` (Zustand FSM) + interface facade
- `src/lib/resilience/WebContentWatchdog.ts` (+32) — `IWebContentWatchdog`
- `src/lib/resilience/PtyReattachClient.ts` (+31) — `IPtyReattachClient`
- `src/lib/resilience/RecoverySessionClient.ts` (+56) — `IRecoverySession`
- `src/lib/resilience/Heartbeat.ts` (+60) — `IHeartbeat`
- `src/lib/resilience/WatermarkSampler.ts` (+82) — `IWatermarkSampler`
- `src/lib/resilience/DeathDetector.ts` (+95) — `IDeathDetector`
- `src/lib/resilience/TopologySnapshotService.ts` (+162) — `ITopologySnapshot`
- `src/lib/resilience/RecoveryOrchestrator.ts` (+237) — `IRecoveryOrchestrator`
- `src/components/RootErrorBoundary.tsx` (+98) — `IResilienceBoundary`
- `src/stores/terminalStore.ts` (+48) — seam: `restoreTabs` + `snapshotPaneToPaneNode`
- `src/lib/terminalManager.ts` (+189) — seam: `adoptDetachedSession`
- `src/stores/collaboratorStore.ts` (+56) — seam: `restoreAgents` + `seedOrdinalCounter`

Total: **16 files, +1415 lines** (all additive; no existing logic altered).

## Validation
- Baseline exit (`dev` HEAD): **0**
- Final validation command: `npx tsc --noEmit && npm run test`
- Final exit: **0**
- Auto-fix attempts used: **0/3**
- Tail of last run:
```
 Test Files  16 passed (16)
      Tests  364 passed (364)
   Duration  1.82s
```
(identical to the 364-test baseline — no regressions)

## Per-item outcomes
| Group | Items | Status | Notes |
|---|---|---|---|
| config | `resilienceConfig` | completed | gate CLOSED by default |
| WebglContextBudget | acquire/release/activeCount | completed | pure FE Set-backed counter |
| ScrollbackPolicy | limitFor/enforce | completed | per-kind caps; mini ≤ main |
| resilienceStore | beginIncident/recordBoundaryCaught/recordSign/recordWatermark/transition/currentIncidentId/snapshotState | completed | Zustand FSM; illegal transitions → 'failed' |
| WebContentWatchdog | reportBeat/readDeathEvidence | completed | `invoke()` → deferred Rust |
| PtyReattachClient | reattach | completed | `invoke("reattach_pty")` |
| RecoverySessionClient | begin/loadPending/claimAttempt/clear | completed | `invoke()` → deferred Rust; expiry FE-guard |
| Heartbeat | start/recordTick/lastBeatAt/stop | completed | idempotent start/stop; throttled forward |
| WatermarkSampler | sample/log | completed | `performance.memory` guarded; loss counter owned here |
| DeathDetector | onVisibilityRegained/classifySign | completed | layered: js-fatal → webcontent-death → gpu-loss(LOW) → unknown |
| store seams | restoreTabs/adoptDetachedSession/restoreAgents | completed | restore-only; original ids; identity verbatim |
| TopologySnapshotService | capture/persist/loadPersisted/restoreShell | completed | proactive persist; 2-phase restore (shell then reattach) |
| RecoveryOrchestrator | shouldRecover/prepareReloadRecovery/resumeAfterReload/isReloadInProgress/abort | completed | gate-guarded; durable crash-loop claim; sign from session.decision on expected resume |
| RootErrorBoundary | onTopLevelError/renderFallback | completed | React class; never throws; mints/correlates incident |

## Scope-discipline self-check
- [x] No new interfaces / files outside the planner's interface set (concrete impls are the planner-assigned bodies; the 3 store seams were explicitly directed by the interface docstrings)
- [x] No renames of committed public names
- [x] No signature changes on planner-committed interface methods
- [x] No edits to `validation_command` configuration
- [x] No edits to files outside the work queue's hint set
- [x] Rust IPC layer left untouched (explicitly deferred); recovery gate left CLOSED

## Known limitations (by design — deferred, not defects)
- The `invoke()` calls target Rust commands that **do not exist yet**; they compile (string-based IPC) but reject at runtime. Because `recoveryGateOpen` is CLOSED and the diagnostic forwards swallow IPC errors, this does not destabilize the app.
- `resumeAfterReload`'s reattach loop runs without the full React mount-await synchronization (DOM-slot binding via `adoptDetachedSession` is gated integration); the body is structurally faithful and dormant until the gate opens.
- Concrete classes are not yet wired into the live app (`main.tsx` / `terminalManager.createSession`); wiring is staged-rollout integration beyond the ratified body-generation scope.

## Peer review fold (task-24, 5 reviewers: codex1/2/3, claude2/3)

After the initial landing, five peer agents reviewed the worktree. Verified + adjudicated:

**Folded in (in-scope):**
- **F1 (claude3, real bug)** — `collectSnapshotSessionIds` ignored `leaf.kind`, feeding collaborator-*container* ids (which have no backing PTY) into the `reattach_pty` loop → `success:false` on every recovery containing a collab pane, while skipping the actual agent PTYs in `leaf.agents[]`. **Fixed**: now collects terminal-leaf ids ∪ agent ids, skips container ids. Locked by a regression test.
- **F2 (unanimous, test gap)** — ~1494 lines shipped with the suite at the 364 baseline. **Added 27 unit tests** for the pure-FE logic (FSM legal/illegal/idempotent transitions + incident guards; classifier precedence + durable-gap fallback; WebGL budget cap/idempotency; scrollback caps; gate-closed/open `shouldRecover`; F1 regression). Suite now 391 passing.

**Deferred (out of ratified scope — gate-opening prerequisites, NOT this run's defects):** the wiring findings H1 (thread `isReloadInProgress` through `AgentMiniTerminal`/`CollaboratorPane`/`collaboratorStore.killAllAgents`/`terminalManager.cleanupManaged`), H2 (route restored terminal leaves through `adoptDetachedSession`, not `createSession`), H3 (`main.tsx` bootstrap: mount `RootErrorBoundary`, `heartbeat.start()`, `loadPending`→`resumeAfterReload`), and M (schedule proactive `capture`/`persist`; wire `ScrollbackPolicy`/`WebglContextBudget` into `createSession`). The two deepest scope adjudications (claude2, claude3-addendum) agree these are defensibly deferred per the planner's "메서드 바디 구현" Out-of-scope and are entangled with the deferred Rust run — *"not a protocol violation."* They are tracked here as explicit prerequisites that MUST land (with the Rust run) before `recoveryGateOpen` is flipped.

**Noted, no change (harmless):** `recreate-webview` branch in `prepareReloadRecovery` is currently unreachable (defensive); the crash-loop-fail `healthy→failed` uses the FSM's illegal-coercion safety path (lands correctly); `RestoreReport` counts are partially unused by the orchestrator. `adoptDetachedSession` is a near-clone of `createSession` (F3, LOW) — extract a shared builder when integration starts (touches `createSession`, so deferred).

**Reviewer-confirmed-solid (independently re-verified):** sign provenance reads `session.decision.sign` on expected resume; crash-loop `claimAttempt` runs before any restore side-effect; proactive-persist/`loadPersisted` ordering; identity-verbatim `restoreAgents` + ordinal seeding; gate-closed `shouldRecover` safety switch; `RootErrorBoundary.onTopLevelError` never throws.
