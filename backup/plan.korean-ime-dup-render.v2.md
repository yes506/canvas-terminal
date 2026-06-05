# Plan — korean-ime-dup-render · v2

## Goal

For Canvas Terminal users typing Korean (Hangul) IME input, typed characters render in place without visual duplication or required arrow-key cleanup, in both the PTY terminal pane and the AI agent's built-in terminal.

## In-scope

- Diagnose and fix the IME composition + buffer rendering interaction in the xterm.js + PTY pipeline used by Canvas Terminal, including the existing custom IME handling layer present in both terminal surfaces
- Cover both terminal surfaces (PTY pane + collaborator-pane built-in terminals); the planner must determine whether the fix lands as parallel changes on both surfaces or via a refactor to a shared helper, given that both surfaces already implement near-identical custom IME workaround code
- Ship the fix in a v0.5.x patch release (patch-release compatibility — version bump and release flow are separate work)

## Out-of-scope

- Japanese / Chinese IME functional support (user only uses Korean+English; explicitly deferred to a future intent — non-regression of these IMEs is covered separately as a constraint and success criterion)
- Non-macOS platforms (Linux / Windows untested; outside user's environment)

## Constraints

- Must ship as a v0.5.x patch — no breaking API changes, bounded scope
- No regression in non-IME typing latency or correctness
- Per current repro the buffer appears correct (arrow-key redraw resolves cleanly), but this is the user's inference, not a captured PTY/buffer transcript; the planner must empirically verify whether the bug surface is render-only (DOM/renderer reconciliation) or includes write-path duplication (e.g., compositionend → PTY → echo, or the deferred triggerDataEvent fragment) before committing to a fix strategy
- Avoid xterm.js major version bump or broad architectural refactor of the IME/keystroke handling layer. Patch-release compatibility (no breaking API changes) is the hard envelope, which by SemVer convention effectively rules out a major xterm.js bump in this patch. If empirical investigation shows the only viable fix requires breaking that envelope, escalate by re-opening this intent rather than silently bumping under the guise of refactor
- The fix must cover both terminal surfaces — the PTY terminal pane and the collaborator-pane built-in terminal. Landing changes on only one surface leaves half the bug present, because both surfaces currently carry parallel custom IME handling code

## Success criteria

- While typing "안녕하세요" character-by-character in the PTY terminal pane, each intermediate composition/commit state renders the current Korean text (committed + in-progress composing) exactly once with no duplicated prefix anywhere in the buffer; after the final syllable the visible line reads exactly 안녕하세요 without any arrow-key cleanup
- Same behavior in the AI agent's built-in terminal (collaborator pane) — each intermediate state renders the current Korean text exactly once, and the final commit reads exactly 안녕하세요 without arrow-key cleanup
- A longer phrase (e.g., "한국어 입력 테스트") composes to the final string exactly once, with no accumulating duplicate prefixes at any intermediate step, on both surfaces
- No regression in ASCII typing, paste, arrow keys, Ctrl+C / Ctrl+R, Tab completion, or shell history (↑/↓) on either surface
- Japanese / Chinese IME rendering not visibly worsened relative to the current pre-fix baseline — verification depth is a lightweight smoke check on code paths exercised by the Korean IME fix, not full functional parity testing with Korean

## Proposed scale lane

feature

### Lane reasoning

Round-2 peer review (5/5 reviewers: @codex1 task-68, @claude2 task-69, @codex2 task-70, @claude3 task-71, @codex3 task-72)와 코드 reality 검증에 따라 v1의 `system` 제안을 `feature`로 downshift합니다. 근거: (1) Touch surface는 두 기존 파일에 국한됩니다 — `src/lib/terminalManager.ts` (PTY 패널, WebGL 렌더러; line 204 `attachCustomKeyEventHandler`, 249 `new WebglAddon(false)`, 346–697 사용자 정의 IME shim with composition listeners + `triggerDataEvent` 패치), 그리고 `src/components/collaborator/AgentMiniTerminal.tsx` (collaborator 패널, 기본 렌더러; line 426 `attachCustomKeyEventHandler`, 577–672 IME shim, 652 `triggerDataEvent` 패치). 두 블록은 near-parallel 구조이며 각각 ~10–15줄 분량 수정 범위. (2) Intent의 명시적 patch-release 봉투 (v0.5.x, non-breaking API, no broad architectural refactor — Constraint #1, #4)와 `feature` 레인이 부합. `system` 레인의 interfaces-only 프로토콜 (architecture.html + architecture.mmd)은 새 cross-system 경계 도입을 위한 것이며 본 작업의 two-file bugfix 경제학과 어긋남. (3) "Lockstep parallel vs shared-helper" 결정 (intent.open_questions[4])은 단일 로컬 아키텍처 이진 선택으로, planner의 Phase 0.5 recon 후 해결 가능. 단, narrow 공유 헬퍼 추출만 허용되며 Constraint #4의 "broad architectural refactor" 금지 envelope은 그대로 유지. (4) 렌더러 비대칭(`terminalManager.ts`만 `WebglAddon` 임포트)은 shared-helper 결정 시 렌더러별 fix variant 필요 여부로 이어지며, 이 또한 단일 파일 내 분기로 처리 가능한 수준. (5) Planner Phase 0.5 부담은 무시할 수 없음 — seeds가 없으므로 6개 OQ 모두 (controlled keystroke-indexed trace 확보, render-only vs write-path 경험적 검증, Tahoe 26.5.1 falsification, JP/ZH baseline smoke, 렌더러 비대칭 확인) planner가 직접 해결해야 함. 30분 단위가 아닌 다중 시간 단위 Phase 0.5 예상. **Worktree-hygiene note (downstream codebase-planner reader 대상)**: 이 worktree 루트에는 `plan.md` (cycle F — peer-context-mirror), `plan.mmd`, `architecture.html`, `architecture.mmd`가 dev에서 상속된 cycle F 인공물로 존재하며 본 의도와 무관합니다. codebase-planner가 feature 레인으로 emit 시 `plan.md`/`plan.mmd`를 IME 컨텐츠로 덮어쓰면 됩니다 (architecture.{html,mmd}는 feature 레인에서 미사용). 사전 cleanup commit은 사용자 재량에 위임 (cycle F의 gate-marker semantics는 dev의 머지 커밋에 보존됨).

## Evidence inventory

(intent-only — no seeds available)

## Resolved ambiguities

- (Dim 4 · minor · intent.open_questions[bundle-meta]) v1 logged intent.open_questions carry-through as a single bundle-defer Dim-4 finding. Result: HTML renderer (which iterates state.findings where mode=deferred) showed only 1 unresolved item while Markdown showed 6. Codex2 verified the MD/HTML count mismatch (task-70 F2). The MD's verbatim listing was correct in spirit but diverged from renderer behavior. → v2 splits the bundle into 6 separate Dim-4 deferred findings (one per intent.open_questions[i]) so MD/HTML render identically (6 items in Remaining open questions, 6 in the unresolved stat). The single-bundle-defer rationale ("not critical for bug fix" per user) is preserved as each per-OQ finding's resolution.text.
- (Dim 4 · major · proposed_scale_lane) v1's proposed `system` lane is over-budget against intent's explicit patch-release envelope (v0.5.x, no breaking API, no broad architectural refactor of IME/keystroke handling layer). Round-2 peer review (5/5 reviewers: @codex1 task-68, @claude2 task-69, @codex2 task-70, @claude3 task-71, @codex3 task-72) converged on `feature` as the right default; code-reality grep confirms two existing near-duplicate IME shim blocks in two existing files (~10–15 lines each), with renderer asymmetry (WebGL only in terminalManager.ts) — no cross-system interface introduction. The "lockstep parallel vs shared-helper" deferred-design OQ is a single local architectural binary the planner resolves in Phase 0.5, not multi-package decomposition. → Downshift to `feature`. Lockstep-parallel vs shared-helper remains as a planner Phase 0.5 decision (intent.open_questions[4]) but doesn't require system-lane interfaces-only protocol (architecture.html + architecture.mmd). The plan-establisher heuristic's literal "deferred design open question → system" trigger is interpreted in spirit as "cross-system interface design", not "any local refactor binary".
- (Dim 4 · minor · worktree_root) Worktree carries `plan.md`, `plan.mmd`, `architecture.html`, `architecture.mmd` inherited from dev's peer-context-mirror Cycle F (last committed by `12f844c docs(planner): cycle F self-verification artifacts`). Their content is unrelated to korean-ime-dup-render. All 5 reviewers flagged this; @codex1/2/3 misframed it as a plan-establisher gate blocker (it's not — plan-establisher emits slug-versioned files only), but @claude2/@claude3 correctly identified it as worktree-hygiene risk for the next reader (downstream codebase-planner may be confused about which plan.md is authoritative). → Acknowledge as Lane-reasoning note for downstream codebase-planner reader: these cycle-F leftover files at the worktree root are unrelated to this intent. When codebase-planner emits feature-lane artifacts, plan.md/plan.mmd will be overwritten with IME content; architecture.{html,mmd} will be left untouched in feature lane (and remain as dev artifacts of cycle F regardless). Cleanup commit deferred to user discretion to avoid affecting cycle-F's gate-marker semantics on dev.

## Remaining open questions

- Did the bug truly start with macOS Tahoe 26.5.1? Possible falsification approaches (diagnostic avenues, not mandatory preconditions before fixing): (a) git-bisect Canvas Terminal across release tags (v0.4.x → v0.5.2) to localize the regression to a code change vs. an environment change; (b) load a minimal xterm.js demo in Safari (and, if feasible, in a minimal Tauri/WKWebView harness) to separate generic WebKit/xterm/macOS behavior from Canvas Terminal's custom IME path — Safari alone isolates upstream xterm/WebKit/macOS but is not equivalent to Tauri's WKWebView host environment, so a positive WKWebView-only signal still requires the Tauri harness; (c) if a non-Tahoe macOS host is reachable, repro there as a tiebreaker.
- Which root-cause hypothesis is correct: (a) xterm.js native IME composition overlay colliding with PTY echo of committed bytes, (b) missing row invalidation on `compositionupdate`, (c) a Canvas Terminal-specific duplicate write path in the keystroke handler (e.g., the existing custom IME shim), or (d) something else (e.g., a macOS Tahoe Cocoa input-handling change). Planner to verify empirically.
- Is the underlying PTY/terminal buffer actually correct (render-only bug), or does the duplicate also exist in the buffer/write path (and only happens to be visually overwritten by shell-side reprint on arrow-key redraw)? This must be empirically verified — e.g., by dumping terminal.buffer.active mid-composition or capturing the PTY transcript — before committing to a render-only vs. write-path fix.
- Japanese / Chinese IME current baseline rendering on macOS is untested. The planner must establish a lightweight baseline (smoke-only) sufficient to verify that the Korean fix does not visibly worsen these IMEs. **Bounds**: code-path inspection (confirming no JP/ZH-specific branch was touched by the Korean fix) is the floor; one manual smoke pass with a JP IME installed is the ceiling — the actual install/test scope is decided at plan time. Full functional support remains explicitly out of scope.
- The two affected terminal surfaces currently implement parallel custom IME handling. Should the fix be applied in lockstep to both, or refactored into a shared helper as part of this patch? The two surfaces also use different xterm.js renderers (one with the WebGL addon, the other intentionally without), which may force renderer-specific fix variants.
- The user-supplied repro trace (ㅇ → 아 → 안 → 안ㄴ → 안 안녀 → 안 안녕 → 안녕 안녕하 하) is a verbal recall, not a literal frame-by-frame capture. The planner should obtain a controlled, keystroke-indexed step-by-step trace **covering the full string 안녕하세요 from first keystroke through final compositionend** — a keystroke-numbered table with the exact visible buffer at each step, including any cursor/column hint — before committing to a specific render-vs-write-path fix hypothesis. Notable known imprecisions in the verbal trace (transition `안 → 안ㄴ` lacks the duplicated prefix that appears one step later as `안 안녀`; the trailing fragment ends mid-word at `안녕 안녕하 하`) should be specifically clarified by the controlled trace.

## Provenance

- Intent slug: korean-ime-dup-render
- Intent ID: 55333-82403-29710
- Plan version: v2 (supersedes v1; v1 preserved as audit trail)
- Plan run ID: 59637-195-16359
- Seed batch IDs: (none)
- Confirmed at: 2026-06-04T17:15:00+09:00
- plan-establisher format version: 1.0
