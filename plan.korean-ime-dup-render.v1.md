# Plan — korean-ime-dup-render · v1

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

system

### Lane reasoning

이 의도는 두 터미널 surface (`src/components/terminal/`의 PTY 패널, `src/components/collaborator/`의 AI 에이전트 패널)에 걸친 cross-module 수정으로, "lockstep parallel" vs "shared-helper refactor" 사이의 아키텍처 선택이 명시적으로 planner로 위임된 deferred design open question을 포함합니다. plan-establisher 휴리스틱 상 "deferred design open question 보유"는 `system` 레인 분류 신호에 직접 해당합니다. 추가 ambiguity 신호로 (i) 근본 원인이 render-only인지 buffer/write-path 중복인지 경험적 검증 필요, (ii) 통제된 keystroke-indexed trace 확보 필요, (iii) macOS Tahoe 26.5.1 회귀 가설 falsification, (iv) JP/ZH IME baseline smoke check, (v) 두 surface가 서로 다른 xterm.js 렌더러(WebGL addon 사용 여부 차이)를 사용해 렌더러별 fix variant 가능성 존재 — 총 6개의 carry-through 공개 질문이 Remaining open questions에 verbatim으로 보존됩니다. 범위는 patch-release 봉투(v0.5.x, non-breaking API)와 IME 레이어에 한정되지만, planner의 recon 결과에 따라 touch surface가 단일 surface에 머물고 lockstep parallel 수정으로 결정될 경우 `feature`로 downshift할 여지가 있습니다. 모호성이 높을 때는 over-budget이 안전하므로 `system`을 제안합니다.

## Evidence inventory

(intent-only — no seeds available)

## Resolved ambiguities

- (Dim 4 · minor · intent.open_questions) intent.korean-ime-dup-render.md declares 6 Open questions intended as planner carry-through (empirical investigation / deferred design items). plan.md schema does not auto-promote intent.open_questions to Remaining open questions, and downstream contract states the planner treats plan.md as the only active input. Decision needed: carry verbatim to Remaining open questions or resolve inline. → (deferred — single-bundle defer per user instruction "버그수정에 필요한 중대사항이 아니면 넘어가"; all 6 OQs carried verbatim from intent.open_questions to Remaining open questions)

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
- Plan version: v1
- Plan run ID: 59637-195-16359
- Seed batch IDs: (none)
- Confirmed at: 2026-06-04T16:54:46+09:00
- plan-establisher format version: 1.0
