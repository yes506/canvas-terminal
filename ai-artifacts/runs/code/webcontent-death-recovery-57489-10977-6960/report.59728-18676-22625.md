# Implementation report — webcontent-death-recovery

(대화 언어: 한국어 — 코드/커밋/마커는 계약상 영어 유지)

## Source
- Planner marker: `feature` — 커밋 `4d56ea5` (`(plan-feature, human-confirmed)`, rev 2)
- Planner artifacts: `ai-artifacts/runs/code/webcontent-death-recovery-57489-10977-6960/plan.md`, `plan.mmd`
- Source hash: `5e6faa03` (sha256)

## Work queue summary
- Total items: 19 (plan Decomposition 노드 1–18, 12b 포함)
- Completed: 19
- Blocked: 0

## Files changed (dev..HEAD, +1792 / −88, 15개 파일)
- `src-tauri/src/commands/resilience.rs` (신규 +616): PID-안정 내구 저장소(`~/.cache/canvas-terminal/resilience/session-<pid>/`, collab-memory 와이프와 분리), 8 IPC(`persist_recovery_session(decision, maxAttempts, ttlMs)` — rev-2 HIGH 폴드), `recreate_webview` no-op 스텁, 포커스-프로브 워치독(`run_focus_probe`), A-경로(`observedTermination` 기록 + **중첩 decision** 세션 민팅 + `WebviewWindow::reload()`), 단위 테스트 7건
- `src-tauri/src/commands/pty.rs`: always-on 링 캡처(reader 스레드가 emit 락 하에 push→emit) + `reattach_pty`(alive 검사 → 링 tail을 같은 락 하에 선방출 → `PtyReattachResult`)
- `src-tauri/src/state.rs`: `PtyRing`(256 KiB cap, UTF-8 경계 정렬 tail) + `PtySession.ring`, 링 테스트 4건
- `src-tauri/src/lib.rs`: `on_page_load(Finished)` 세대 카운터, `Focused(true)` 프로브 훅, **정확 10건 등록**(8+`reattach_pty`+스텁), 스테일 리핑
- `src/lib/resilience/RecoveryOrchestrator.ts`: adoption-readiness 장벽(모듈 스코프 — arm/signal/await/timeout/reset), `resumeAfterReload` 바디에 restoreShell↔reattach 사이 장벽 삽입(시그니처 불변), dead-PTY 타일 exited 강등, `isReloadInProgress()`에 부트스트랩 시드 OR-in
- `src/lib/resilience/bootstrap.ts` (신규 +166): Phase A(프로브 등록→evidence 선독→pending 시드→Heartbeat→persist 트리거) + pending 시 resume 킥 후 **barrier-armed까지만 렌더 차단**(복원 탭이 첫 렌더에 등장 → 기본-탭 이펙트 무발화, 고아 스폰 원천 차단)
- `src/lib/resilience/config.ts`: `adoptionReadinessTimeoutMs: 10000`
- `src/main.tsx`: bootstrap 게이트 + `RootErrorBoundary`로 `<App/>` 래핑
- `src/components/terminal/useTerminal.ts`: 복원 id → `adoptDetachedSession`(스폰 없음)→readiness 신호 (node 17)
- `src/components/collaborator/CollaboratorPane.tsx`: 복구 마운트 시 스토어 행 스냅샷→`startSession` 후 `restoreAgents` 재시드→adopt-모드 `spawns` 물질화; unmount의 `killAllAgents`/`endSession` suppression (nodes 18/14)
- `src/components/collaborator/AgentMiniTerminal.tsx`: `adopt` prop — reserve/spawn/addAgent 전부 생략, 리스너 구독 후 readiness 신호, readiness 감지 비활성(exited 타일 부활 방지); cleanup의 `kill_pty`/`removeAgent` suppression (nodes 18/13)
- 테스트: `bootstrap.test.ts`(신규 8건 — 게이트 순서/프로브/시드/장벽 hold·타임아웃/에이전트-단독 persist/복구중 persist 억제), `RecoveryOrchestrator.resume.test.ts`(장벽 반영 갱신), `AgentMiniTerminal.test.ts`(+5 소스 어서션)

## Validation
- Baseline exit (dev HEAD): 0 (112초; vitest 24파일… 기준선 23파일 424건 + cargo 79건)
- Final validation command: `npx tsc --noEmit && npm test && (cd src-tauri && cargo check && cargo test)`
- Final exit: **0** (25초, 증분)
- Auto-fix attempts used: 0/3 (자율 루프 내 테스트 수정 2건은 큐 항목 작업의 일부)
- Tail of last run (요약):
```
Test Files  24 passed (24)
Tests       437 passed (437)     # 기준선 424 → +13
cargo test: lib 90 passed (resilience 7 + pty_ring 4 신규); pty_eintr 4 ok;
transcript_adapter_contract 1 ok
```

## Per-item outcomes
| item_id | status | files_touched | notes |
|---|---|---|---|
| node-1-durable-store | completed | resilience.rs, mod.rs | 원자 쓰기 `memory::write_file_atomic_under` 재사용; 스테일 리핑 준용 |
| node-2-heartbeat | completed | resilience.rs | 새 beat가 stale `observed_termination`도 클리어 |
| node-3-generation | completed | lib.rs, resilience.rs | `beat_generation` 스냅샷으로 Rust-내부 비교 |
| node-4-evidence | completed | resilience.rs | 계약 5필드 camelCase 정합 |
| node-5-recovery-session | completed | resilience.rs | **3-인자 + `expiresAt=now+ttlMs`(1s–24h 클램프)**; claim은 복원 부작용 전 내구 증가, 소진⇒None(증가는 잔존) |
| node-6-topology | completed | resilience.rs | 스냅샷을 opaque `serde_json::Value`로 — Rust가 FE 스키마에서 드리프트 불가능 |
| node-7-watchdog | completed | lib.rs, resilience.rs | 프로브=eval `__ct_probe`→FE 즉시 beat; 판정=t0 이후 beat 미전진 AND 갭>10s; beat 전무 시 판정 안 함(오탐 방지); PROBE_IN_FLIGHT 직렬화 |
| node-8-apath | completed | resilience.rs, lib.rs | **중첩 decision 리터럴**(rev-2 MED); pending 중 재프로브 억제; reload로 종결 |
| node-9-ring | completed | pty.rs, state.rs | push→emit이 링 뮤텍스 안 — replay/live 인터리브 구조적 불가(Q4) |
| node-10-reattach | completed | pty.rs | FE 인자 형태 `{sessionId, maxBytes}` 그대로; 미등록/사망 세션 alive:false(비-throw) |
| node-11-registration | completed | lib.rs, mod.rs | 정확 10건(체크리스트 그대로) |
| node-12-bootstrap-a | completed | bootstrap.ts, main.tsx | evidence 선독→시드→Heartbeat; **barrier-armed까지 렌더 지연**으로 기본-탭 레이스 봉쇄 |
| node-12b-barrier | completed | RecoveryOrchestrator.ts, bootstrap.ts, config.ts | 전원-ready 또는 타임아웃(10s)⇒lost; 모든 exit 경로에서 reset(부트스트랩 행 방지) |
| node-17-terminal-adopt | completed | useTerminal.ts | 비복원 id는 기존 createSession 경로 불변 |
| node-18-collab-adopt | completed | CollaboratorPane.tsx, AgentMiniTerminal.tsx | `startSession`의 행 클리어를 스냅샷→재시드로 우회(restore-only 시임 사용, addAgent 미사용 — 정체성 보존) |
| node-13-suppress-agent | completed | AgentMiniTerminal.tsx | 설계 :821 계약 그대로 |
| node-14-suppress-pane | completed | CollaboratorPane.tsx | 설계 :82-83 계약 그대로 |
| node-15-persist-trigger | completed | bootstrap.ts | 공유 `scheduleTopologyPersist()` — 양 스토어 구독; 복구 중 억제; **에이전트-단독 변경 테스트 포함**(rev-2 MED) |
| node-16-tests | completed | 양쪽 | Rust 11건 신규 + vitest 13건 신규(장벽 hold/타임아웃, no-reattach-before-ready, 오탐 없음 경로 포함) |

## Scope-discipline self-check
- [x] No new interfaces / files outside hints — 신규 파일 3개 전부 plan 명시(`resilience.rs`, `bootstrap.ts`, 테스트)
- [x] No renames of committed public names
- [x] No signature changes on planner-committed methods — 12개 resilience 인터페이스 시그니처 불변; `resumeAfterReload`/`isReloadInProgress`는 **바디만** 변경(plan Constraints가 명시 허용한 범위); 모듈-스코프 신규 export(장벽 함수들)는 인터페이스 계약 외부
- [x] No edits to validation_command configuration
- [x] No edits to files outside the work queue's hint set — 예외 1건 기록: `RecoveryOrchestrator.resume.test.ts` 갱신(장벽 삽입이 강제한 기존 테스트 적응 — plan node 16 "기존 스위트 갱신" 범위)

## Merge-gate 확인 필요 사항
1. **수동 E2E는 머지 후 사용자 환경 항목** (plan Validation 절 그대로): 개발 모드 실행 → Activity Monitor에서 "Canvas Terminal Web Content" `kill -9` → 앱 포커스 복귀 → ~13초 내(프로브 3s + 판정) 자동 reload → 탭/PTY 복원 확인. CI에서는 재현 불가.
2. 워치독 임계값(갭 10s/프로브 3s/장벽 10s)은 Q2 확정 제안값 — 실측 후 상수 조정 가능(전부 한 곳에 상수화).
