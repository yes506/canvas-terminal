# Implementation report — korean-ime-dmg-race

## Source
- Planner marker: `local` from chat (this conversation)
- Planner artifacts: `planner-93899-16654-1459-phase-light-plan-v3.md` (peer-reviewed across 4 rounds; 5/5 → 5/5 → 4/4 → 5/5 convergent; one blocking concern reversed at round-4 via @claude2's Cargo.lock preservation correction)
- Source hash: chat-local; no committed planner artifact

## Work queue summary
- Total items: 15 (interleaved per plan-v3's failing-now/passing-after design)
- Completed: 15
- Blocked: 0

## Files changed
- `src/lib/xtermImeShim.ts` — +69 / −15 (A.1 literals 40→250 at 2 sites; A.2 length-cap predicate + Order-Q comment; A.3 instrumentation: token shape extension at L329/L487/L519, `lastClearedCommit` snapshot, cached `imeDebug` flag, hit/miss counters with `gapMs`/`ageMs` console.warn logs; A.4 stale `40 ms` comment rewrites)
- `src/lib/xtermImeShim.test.ts` — +217 / −16 (5 new `it()` cases: T-space-late-arrival, T-space-out-of-window, T-prefix-strip-cap, strip-hit instrumentation, strip-miss instrumentation; T5 literal `60→300` + description `40ms→250ms`; T7 description + comment updates; misc stale `40 ms` cleanup)
- `src-tauri/Cargo.toml` — +1 / −1 (`devtools` added to tauri feature list)
- `src-tauri/Cargo.lock` — +1 / −1 (`canvas-terminal` version sync `0.5.4` → `0.5.5` — matches the v0.5.5 release that bumped Cargo.toml but didn't re-stage the lockfile)

## Validation
- Baseline exit (BASE_BRANCH HEAD): 0 (36/36 vitest, clean cargo)
- Final validation commands:
  - `npx vitest run src/lib/xtermImeShim.test.ts` → exit 0, 41/41 passed
  - `npm run build` → exit 0, both app + dashboard built
  - `cargo check --manifest-path src-tauri/Cargo.toml` → exit 0 (9 pre-existing warnings unrelated)
- Auto-fix attempts used: 0/3
- Tail of last vitest run:
  ```
   Test Files  1 passed (1)
        Tests  41 passed (41)
     Duration  652ms
  ```

## Per-item outcomes

| Item | Status | Files touched | Notes |
|---|---|---|---|
| 1 — test: T-space-late-arrival | done | xtermImeShim.test.ts | added inside existing multi-char strip describe |
| 2 — validate: must FAIL | done | — | vitest showed 1 failed (T-space-late-arrival): `[" ", "녕 "]` vs `[" "]` — confirms test exercises race window |
| 3 — impl: A.1 literals 40→250 | done | xtermImeShim.ts:501, :527 | |
| 4 — validate: must PASS | done | — | T-space-late-arrival now green; T5 fails as expected (item 11 fix) |
| 5 — impl: A.2 length-cap + Order-Q comment | done | xtermImeShim.ts:697-708 | `data.length <= live.text.length + 4` predicate added |
| 6 — impl: A.3 instrumentation | done | xtermImeShim.ts (5 sites) | token shape extended at L329/L487/L519, lastClearedCommit added, imeDebug cached, hit log at strip success, miss log before final origTrigger |
| 7 — impl: A.4 stale `40 ms` rewrites in source | done | xtermImeShim.ts:489-496, :731 | intentional historical refs at :522, :524 preserved (describe migration) |
| 8 — test: T-space-out-of-window (t=500) | done | xtermImeShim.test.ts | demonstrative; widened from plan-v2's t=260 per @claude2's round-4 robustness pushback |
| 9 — test: T-prefix-strip-cap (12-char paste) | done | xtermImeShim.test.ts | A.2 over-suppression guard |
| 10 — test: 2 A.3 instrumentation tests | done | xtermImeShim.test.ts | new describe block; **happy-dom v20 ships localStorage as empty plain object** — added Map-backed Storage stub via vi.stubGlobal; afterEach unstubAllGlobals; explicit `toFake: ['setTimeout', 'clearTimeout', 'performance', 'Date']` |
| 11 — test: T5 literal+description (40→250) | done | xtermImeShim.test.ts:971, :997 | drain `60` → `300` |
| 12 — test: T7 description (40ms→250ms window) | done | xtermImeShim.test.ts:1080 + comments | mechanism unchanged; comments now honestly describe the new ceiling |
| 13 — test: remaining stale `40 ms` refs | done | xtermImeShim.test.ts:1276 | intentional historical refs in T-space-late-arrival + T7 + B4 header preserved (they describe pre-extension state) |
| 14 — impl: Cargo.toml devtools feature | done | src-tauri/Cargo.toml:14 | |
| 15 — validate: cargo check + Cargo.lock | done | src-tauri/Cargo.lock | only v0.5.4→v0.5.5 line synced; `devtools` toggles existing code paths so no new transitive deps |

## Scope-discipline self-check
- [x] No new interfaces / files outside hints
- [x] No renames of committed public names
- [x] No signature changes on planner-committed methods
- [x] No edits to validation_command configuration
- [x] No edits to files outside the work queue's hint set

## Plan deviations & their justification

1. **happy-dom v20 localStorage stub**: plan-v3 assumed `localStorage.setItem("canvasTerminal_imeDebug", "1")` would work directly in the test environment. Verified empirically that happy-dom v20 ships `localStorage` as an empty plain object (no Storage prototype). Stubbed via `vi.stubGlobal("localStorage", makeMapStorage())` with `afterEach(() => vi.unstubAllGlobals())` — preserves plan-v3's afterEach hygiene intent.

2. **Cargo.lock dirty-state preservation moot in worktree**: plan-v3 (per @claude2's round-4 reversal) said preserve the main checkout's existing v0.5.4→v0.5.5 dirty Cargo.lock and let `cargo check` append. In the implementer worktree (fresh checkout from `dev`), Cargo.lock starts CLEAN — `cargo check` produced the same v0.5.4→v0.5.5 line and nothing else (devtools is a feature flag toggling existing code paths, not adding new crates). Net commit-time state matches the plan's intended outcome.

3. **T7 description rewrite (item 12)**: simply swapping "40ms" → "250ms" in the inline t=25-vs-t=40 timing claims would have made the comments factually wrong (250 ms safety clear doesn't fire at t=25-45 like the 40 ms one did). Rewrote the comments to be honest about the new ceiling — claim-at-schedule's race-freeness is the load-bearing property, and that's now stated as "race-free against the safety clear regardless of window width." Test mechanism (claim-at-schedule) is unchanged.

## Operational notes for v0.5.6 release

- **IME debug flag activation**: cached at attach. To enable counters: (1) Right-click → Inspect Element (available thanks to the new `devtools` Cargo feature), (2) `localStorage.setItem('canvasTerminal_imeDebug', '1')` in console, (3) cause shim to re-attach — safest path is full Tauri restart; reload (Cmd+R) or terminal session recreation also work but may have build-specific edge cases.
- **DevTools-in-DMG is a one-way door commitment**: user explicitly blessed at the `confirm plan` gate; removing in a later release would be regression-grade UX deterioration.
- **Source-map posture**: verified `vite.config.ts` and `vite.dashboard.config.ts` do NOT set `build.sourcemap`. Vite default is OFF in production → Inspect Element exposes bundled+minified JS only, not original TS. A future `build.sourcemap: true` flip would change this; re-evaluate the one-way-door tradeoff at that point.
- **Out-of-scope follow-up (plan-v3 A.6)**: convert multi-char prefix-strip to claim-at-schedule discipline (matching the length-1 path's hardening) so it's race-free against the safety clear by construction, not by window-width tuning. Queue as `plan-local` follow-up after v0.5.6 confirms the DMG regression is dead. The strip-hit/strip-miss telemetry from A.3 will surface real CFRunLoop gap distribution to inform whether 250 ms is the right ceiling or needs further adjustment.
