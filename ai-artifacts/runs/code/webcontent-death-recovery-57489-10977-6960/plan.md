# Feature plan — webcontent-death-recovery

Planner run `57489-10977-6960` · lane `feature` · base `dev` · stack `typescript` (+ Rust IPC side)
Origin: collaborator task `task-1` (session-22-1783644131641) — long-session "header-only blank
screen" report; root cause proven in-session (2026-07-10).
Rev 2 — 5-peer review fold (task-70 @codex1, task-71 @claude2, task-72 @codex2,
task-73 @claude3, task-74 @codex3); disposition table at the end.
Design source of record: the resilience-recovery SYSTEM run — `architecture.html`/`architecture.mmd`
at merge `6a02d5f` (`(interfaces only, human-confirmed)`, run-dir
`ai-artifacts/runs/code/resilience-recovery-15880-14321-23155`, retrievable from git; removed from
disk by a later cleanup commit) — plus the landed FE implementation at `48b4f7f`
(`(impl-system, human-confirmed)`), whose `src/lib/resilience/types.ts` pins every serde shape.
This run is the **"separate Rust planner run"** that design explicitly deferred (its codex1 HIGH
open item), now unblocked by the feasibility finding below.

## Goal

macOS가 메모리 압박(jetsam)으로 WKWebView의 WebContent 헬퍼 프로세스를 죽였을 때 발생하는
"네이티브 타이틀바만 남는 영구 빈 화면"을 제거한다. Rust가 죽음을 감지해 웹뷰를 리로드하고,
이미 랜딩된 FE resilience 계층(RecoveryOrchestrator/TopologySnapshot/PtyReattachClient)이
살아있는 Rust PTY에 재접속해 **수동 재시작·작업 손실 없이** 세션을 복원한다.

**Feasibility resolution (this session, closes the system run's codex1 HIGH)**: wry 0.54.4 exposes
`on_web_content_process_terminate_handler` (`wkwebview/navigation.rs:107`) but tauri 2.10.3 /
tauri-runtime-wry 2.10.1 never set it (source-verified) and the app cannot reach it through public
API. Therefore A-detection lands as a **Rust-side watchdog over public tauri APIs**:
durable heartbeat gap + focus-probe eval ping + `WebviewWindow::reload()` (present in tauri 2.10.3,
`webview/mod.rs:1676`; WKWebView `reload` restarts a dead WebContent process). The native delegate
is recorded as a follow-up if tauri ever plumbs the wry hook.

## In scope

- **`src-tauri/src/commands/resilience.rs` (신규)** — 등록 체크리스트(정확한 집합; 카운트 프로즈 금지):
  resilience.rs 8건 — `report_heartbeat(at)`, `read_death_evidence()`,
  **`persist_recovery_session(decision, maxAttempts, ttlMs)`** (FE `RecoverySessionClient.begin()`이
  `resilienceConfig.recoverySessionTtlMs`를 전달 — `expiresAt = now + ttlMs`, ttlMs는 양수 범위로
  클램프; 2-인자 형태는 계약 위반), `load_recovery_session()`, `claim_recovery_attempt(token)`,
  `clear_recovery_session(token)`, `persist_topology(snapshot)`, `load_topology()`.
  pty.rs 1건 — `reattach_pty`. 스텁 1건 — `recreate_webview`(아래 결정 참조).
  **lib.rs invoke_handler 총 10건 = 8 + 1 + 1 스텁.**
  내구 저장소는 PID-안정 dir `~/.cache/canvas-terminal/resilience/session-<pid>/`
  (collab-memory와 **다른 루트** — 창-닫힘 `clear_process_memory_root()` 와이프에 비영향;
  reload는 PID 불변이므로 생존). 원자 쓰기는 기존 `memory::write_file_atomic_under` 재사용,
  스테일 정리는 기존 `clear_stale_sessions` 패턴 준용.
- **`pty.rs`: always-on 링 버퍼 + `reattach_pty`** — 세션 생성 시점부터 출력을 세션별 바운디드
  링(캡 256 KiB, Q1 확정값)에 상시 캡처(리로드 중 리스너 공백 구간 보존 — 설계 round-4 확정).
  `reattach_pty(sessionId, budget)`: alive 검사 → 세션별 emit 락 하에 링 replay를
  `pty-data-{sessionId}` 이벤트로 **live 재개보다 선행** 방출(설계 Q4 확정) →
  `PtyReattachResult { sessionId, alive, replayBytes }`.
- **죽음 감지 워치독 (공개 API만)** —
  (a) `on_page_load(Finished)` 훅으로 내구 launch-generation 증가 →
  `DeathEvidence.launchCount`/`reloadedSinceLastBeat`(Rust-내부 세대 비교);
  (b) `WindowEvent::Focused(true)` 시 t0 기록 → `eval("window.__ct_probe?.()")` — 프로브는
  FE의 **즉시 하트비트**를 유발하므로 추가 IPC 불필요 — T초 내 내구 last-beat가 t0 이후로
  전진하면 생존, 아니고 갭>임계면 사망 판정;
  (c) A-경로: 죽은 JS는 복구 세션을 민팅할 수 없으므로 **Rust가** observedTermination=true 기록
  + RecoverySession 민팅(설계 문구 "or by Rust on the A path" 구현) → `WebviewWindow::reload()`.
  민팅 형태는 types.ts의 **중첩 구조 그대로**(평탄화 금지 — sign/action은 RecoverySession의
  필드가 아님): `{ token, decision: { proceed: true, sign: "webcontent-death",
  action: "reload-in-place", reason: "<watchdog rationale>" }, suppressTeardown: true,
  createdAt, expiresAt, attempts: 0, maxAttempts }` — `loadPending()`/`classifySign`은
  `session.decision.sign`을 읽는다.
  복구 진행 중(pending session 존재) 재프로브/재리로드 억제.
- **FE 부트스트랩 배선 (2-페이즈 + 재접속 장벽)** — `src/lib/resilience/bootstrap.ts`(신규) +
  `main.tsx`(얇게). **Phase A (렌더 전)**: `loadPending()` resolve + `isReloadInProgress` 시드 +
  `__ct_probe` 등록(호출 시 즉시 beat) + Heartbeat 기동 + `RootErrorBoundary`로 `<App/>` 래핑 후
  렌더 시작. **Phase B (마운트 후)**: 대기 세션 존재 시 `readDeathEvidence()`→`classifySign`→
  `resumeAfterReload()` — 단, `restoreShell()`은 스토어만 변경하고 xterm 리스너는 React 마운트가
  설치하므로, **`resumeAfterReload()` 내부의 Phase 1(restoreShell)과 Phase 2(reattach 루프) 사이에
  adoption-readiness 장벽을 삽입**한다: 스냅샷의 복원 대상 sessionId 집합을 기대치로 등록하고,
  각 adopt-모드 마운트(아래 두 adopt 경로)가 리스너 구독 완료를 신호하면 전원-ready 또는
  타임아웃(config)까지 대기 후 `reattach_pty`를 호출한다(타임아웃된 id는 lost 처리).
  링 replay가 리스너 없는 허공으로 방출되는 것을 구조적으로 방지(리뷰 3-way HIGH).
  기존 12개 resilience **인터페이스 시그니처는 무변경**; `RecoveryOrchestrator.resumeAfterReload`
  **바디**의 장벽 삽입은 허용 범위로 명시(아래 Constraints).
- **터미널 복원-adopt 경로** — `useTerminal.ts`/`TerminalPane.tsx`: 복구 모드에서 sessionId가
  복원 집합에 속하면 `createSession()`(→`spawn_shell`) 대신 기존 restore-only 프리미티브
  `terminalManager.adoptDetachedSession()`을 호출(생존 PTY를 새 스폰으로 덮어쓰는 회귀 방지 —
  리뷰 HIGH). adopt 완료 시 readiness 신호.
- **collaborator 복원-adopt 경로** — `CollaboratorPane`은 컴포넌트-로컬 `spawns`로 타일을
  렌더하므로 스토어 `restoreAgents()`만으로는 타일이 보이지 않는다(리뷰 HIGH). 복구 모드에서
  스냅샷 `AgentSnapshot[]`로부터 `spawns`를 물질화하고, `AgentMiniTerminal`에 **adopt 모드**를
  추가: `reserveAgentHandle`/`spawn_process`/`spawn_shell`/`addAgent`를 모두 생략하고 기존
  스토어 행(restoreAgents가 시드)에 결합, `pty-data` 리스너 구독 후 readiness 신호,
  handle/nickname/nameHistory 보존, dead-PTY 타일은 exited로(설계 정책 그대로).
- **teardown suppression 소비 (2개소)** — `AgentMiniTerminal.tsx` cleanup의
  `kill_pty`/`removeAgent`(설계 :821 계약) 및 `CollaboratorPane.tsx`의
  `killAllAgents`/`endSession`(설계 :82-83) 경로를 `isReloadInProgress()`로 게이트
  (설계 round-4 4-way blocker 확정 그대로).
- **topology 영속 트리거** — 탭/pane/에이전트 변경 시 디바운스 capture→`persist_topology`
  (설계 Q3 "proactive debounced" 확정).
- **테스트** — Rust: 저장소 라운드트립, claim 세대-일치/내구-증가/소진 시맨틱, 링 cap·replay
  순서, evidence 계산; vitest: 부트스트랩 게이트 순서(loadPending 선행), suppression 게이트,
  `__ct_probe` 등록, 오탐 없음(생존 웹뷰에서 no-reload).

## Out of scope

- 네이티브 `didTerminateWebProcess` 델리게이트 설치(objc 후킹/tauri 포크) — tauri가 훅을
  노출하면 후속 개선으로 기록.
- `recreate-webview` 폴백 **동작**(설계 Q2의 2차 수단) — 이번 런은 reload-in-place만.
  단, 랜딩된 FE(`RecoveryOrchestrator.ts:126-128`)가 해당 액션 분기에서 `invoke("recreate_webview")`를
  fire-and-forget으로 이미 호출하므로, **`recreate_webview`는 명시적 no-op 스텁으로 등록**한다
  (명확한 Err 메시지 반환 — FE `.catch()`가 삼킴; 잠재 갭이 아니라 의식적 결정으로 기록,
  리뷰 claude2 F2 채택 — 등록 10건 산식도 이로써 닫힘).
- gpu-loss(가설 C) 능동 복구, 멀티윈도우, 비-macOS 플랫폼 분기.
- 메모리 성장 자체의 완화(#4 잔여: 스크롤백 정책 적용, `appendLog` 전체-파일 재기록 개선) —
  별도 런. 이 런은 죽음의 **결과**를 복구하고, 죽음의 **원인**(메모리)은 후속이 다룬다.

## Constraints

- 랜딩된 FE 인터페이스/시그니처 **불변** — 9-field docstring이 Rust 형태의 단일 진실원.
  단 **바디 수정 허용 범위를 명시**: `RecoveryOrchestrator.resumeAfterReload` 내부의
  adoption-readiness 장벽 삽입, `useTerminal`/`AgentMiniTerminal`/`CollaboratorPane`의
  adopt-모드 분기 — 모두 시그니처·계약 불변의 바디/컴포넌트 변경.
  serde 형태는 `types.ts`의 `DeathEvidence`/`RecoverySession`/`TopologySnapshot`/
  `PtyReattachResult`와 camelCase 정합(TS camelCase ↔ Rust snake_case는 serde rename).
- 정상 종료 경로(`WindowEvent::Destroyed`→clear) 불침범; resilience 저장소는 창-닫힘 와이프와
  분리된 루트.
- 워치독 fail-safe: 오판의 최악 결과는 불필요한 reload 1회; `attempts/maxAttempts`(claim의
  내구 증가) + `expiresAt`이 crash-loop 백스톱(설계 그대로).
- 기존 URL-scheme/localfile 불변식 불침범; 버전 하드코딩 금지.
- 구현은 `codebase-implementer`가 dev-기반 워크트리에서 생성; planner-확정 시그니처 변경 금지.
- 검증: `tsc --noEmit` + vitest (TS), `cargo check` + 단위 테스트 (Rust).

## Success criteria

- WebContent 사망 시뮬레이션(`kill -9 <WebContent pid>`) 후 앱 포커스 복귀 → 수 초 내 자동
  reload → 탭/pane 토폴로지 복원 + 살아있는 PTY 재접속(링 replay가 공백 출력 포함) —
  수동 재시작 불필요.
- 리로드 경계에서 collaborator 에이전트 PTY가 kill되지 않음(suppression 2개소 동작);
  죽은 PTY 타일은 handle/nickname 보존한 exited로 복원(설계 정책 — 미드롭·미재스폰).
- `read_death_evidence`가 계약 튜플(observedTermination, lastGoodBeatAt, gapMs, launchCount,
  reloadedSinceLastBeat)을 반환; expected-resume(스스로 유발한 reload)에서는 pending
  RecoverySession.decision이 사인 소스(재분류 금지 — 설계 round-5).
- 오탐 없음: 정상 백그라운드→복귀(생존 웹뷰)에서 reload 미발생.
- 전체 검증 통과(기준선 대비 회귀 0).

## Open questions

- Q1 **확정 제안**: 링 cap = 세션당 256 KiB, `ReplayBudget.maxBytes`로 추가 상한 (설계가
  implementer에 위임한 OPEN 항목의 기본값).
- Q2 **확정 제안**: 워치독 임계 = 내구 last-beat 갭 > 10s AND 프로브 무응답 3s; Heartbeat
  주기는 기존 `resilienceConfig` 값 사용. 구현 중 측정으로 조정 가능(상수는 config에).
- Q3 **확정 제안**: 사망 감지 시 사전 알림 없이 즉시 reload(빈 화면 지속보다 항상 우월),
  복원 후 상태 표시로 "복구됨" 노출.

## Package layout

신규 패키지 없음 — 기존 모듈에 안착. 신규 파일 2개만:

```
src-tauri/src/commands/resilience.rs   # ★ 신규 — 9 IPC + 내구 저장소 + 워치독 판정/A-경로
src-tauri/src/commands/pty.rs          # 링 버퍼 + reattach_pty
src-tauri/src/commands/mod.rs          # 모듈 등록
src-tauri/src/lib.rs                   # invoke_handler 10건, on_page_load 세대, Focused 프로브
src/main.tsx                           # 얇은 엔트리 — bootstrap 게이트 후 렌더
src/lib/resilience/bootstrap.ts        # ★ 신규 — 게이트/시드/프로브/하트비트/resume 오케스트레이션
src/components/terminal/useTerminal.ts             # 복원-adopt 분기 (createSession 대신 adopt)
src/lib/terminalManager.ts                          # adoption-readiness 레지스트리 (기존 adoptDetachedSession 활용)
src/lib/resilience/RecoveryOrchestrator.ts          # resumeAfterReload 바디에 readiness 장벽 (시그니처 불변)
src/components/collaborator/AgentMiniTerminal.tsx  # suppression ① + adopt 모드
src/components/collaborator/CollaboratorPane.tsx   # suppression ② + spawns 물질화(복구 모드)
src/stores/terminalStore.ts + collaboratorStore.ts  # 공유 scheduleTopologyPersist() — 양 스토어 변경 경로에서 호출
```

의존 방향: `main.tsx → bootstrap.ts → 기존 resilience 인터페이스 → IPC → resilience.rs·pty.rs`;
Rust 측은 `lib.rs`(이벤트 훅) → `resilience.rs`(판정·저장) 단방향.

## Decomposition

| Node # | Stage | Belongs to package | Notes |
|---|---|---|---|
| 1 | 내구 저장소 프리미티브 | src-tauri resilience.rs | PID-안정 dir(collab-memory와 다른 루트, 와이프 비영향); `write_file_atomic_under` 재사용; 스테일 정리 준용 |
| 2 | `report_heartbeat` | src-tauri resilience.rs | 내구 last-beat; 스로틀은 FE Heartbeat 소관(계약) |
| 3 | launch 세대 카운터 | src-tauri lib.rs+resilience.rs | `on_page_load(Finished)` → 내구 generation; `reloadedSinceLastBeat`의 Rust-내부 비교 재료 |
| 4 | `read_death_evidence` | src-tauri resilience.rs | 계약 튜플; camelCase 정합; 부트스트랩이 첫 beat 전에 1회 호출하는 계약 존중 |
| 5 | recovery-session IPC 4종 | src-tauri resilience.rs | **persist(decision, maxAttempts, ttlMs)** — 토큰 민팅, attempts:0, `expiresAt=now+ttlMs`(클램프)/load(만료검사·읽기전용)/claim(세대 일치+**복원 부작용 전 내구 증가**, 소진⇒None)/clear |
| 6 | topology IPC 2종 | src-tauri resilience.rs | snapshot 그대로 직렬화; version 필드 존중 |
| 7 | 포커스 프로브 워치독 | src-tauri lib.rs+resilience.rs | Focused(true)→t0→eval `__ct_probe`→T초 내 beat 전진=생존; 갭>임계=사망. 추가 IPC 없음 |
| 8 | A-경로 사망 처리 | src-tauri resilience.rs+lib.rs | Rust가 증거 기록+세션 민팅 — **중첩 형태**: `decision:{proceed:true, sign:"webcontent-death", action:"reload-in-place", reason}` (평탄화 금지, types.ts 정합)→`WebviewWindow::reload()`; pending 중 재프로브 억제 |
| 9 | always-on PTY 링 | src-tauri pty.rs | 생성 시점부터 캡처; cap 256 KiB(Q1); 리스너 공백 보존(round-4) |
| 10 | `reattach_pty` | src-tauri pty.rs | alive 검사→emit 락→링 replay 선방출(Q4)→live 재개→`PtyReattachResult` |
| 11 | invoke_handler 등록 | src-tauri lib.rs | **정확 집합 10건** = resilience.rs 8 + pty.rs `reattach_pty` + `recreate_webview` no-op 스텁; 누락=런타임 command-not-found(직전 런 학습 앵커) |
| 12 | FE 부트스트랩 Phase A (렌더 전) | src bootstrap.ts+main.tsx | loadPending 선행 게이트+시드+RootErrorBoundary 래핑+`__ct_probe`+Heartbeat — 렌더 차단은 여기까지 |
| 12b | 재접속 장벽 + resume Phase B | src bootstrap.ts+RecoveryOrchestrator.ts | restoreShell(스토어)→**adopt-마운트 readiness 전원 대기(타임아웃=lost)**→reattach 루프; resumeAfterReload 바디에 장벽 삽입(시그니처 불변) — replay를 허공에 방출하는 3-way HIGH 봉쇄 |
| 13 | suppression ① | src AgentMiniTerminal.tsx | cleanup `kill_pty`/`removeAgent` 게이트(설계 :821) |
| 14 | suppression ② | src CollaboratorPane.tsx | `killAllAgents`/`endSession` 게이트(설계 :82-83, 4-way blocker) |
| 15 | topology 영속 트리거 | src terminalStore+collaboratorStore | **공유 `scheduleTopologyPersist()`** — capture가 두 스토어를 모두 읽으므로 양쪽 변경 경로(탭/pane + 에이전트 스폰/상태/rename/publishOptedIn)에서 디바운스 호출; 에이전트-단독 변경이 persist를 유발하는 테스트 필수(3-way MED) |
| 16 | 테스트 | 양쪽 스택 | Rust: 저장소/claim(ttlMs·만료 포함)/링/evidence; vitest: 게이트 순서/suppression/프로브/오탐 없음/readiness 장벽(전원-ready 전 reattach 미호출)/에이전트-단독 topology persist |
| 17 | 터미널 복원-adopt 경로 | src useTerminal.ts+terminalManager.ts | 복원 집합의 sessionId는 `adoptDetachedSession`(스폰 없음)으로; adopt 완료=readiness 신호; 비복원 id는 기존 createSession 경로 불변 |
| 18 | collaborator 복원-adopt 경로 | src CollaboratorPane.tsx+AgentMiniTerminal.tsx | `spawns`를 AgentSnapshot[]에서 물질화; AgentMiniTerminal adopt 모드(reserve/spawn/addAgent 생략, 리스너 구독→readiness, 정체성 보존, dead=exited) |

## Interfaces emitted

N/A — Phase 5 생략. 경계 계약은 이미 dev에 랜딩된 FE 인터페이스 12종(9-field docstring,
`6a02d5f`)이 단일 진실원이며, 이 plan의 Rust 노드들은 그 계약의 이행이다.

## Validation

- Phase 6: 생략(스켈레톤 미생성 — feature 레인 규칙). rev 2 폴드 후 스모크 재통과.
- Phase 7 smoke-check: plan.md 필수 헤더(`## Goal`, `## Package layout`, `## Decomposition`)
  존재; plan.mmd 첫 줄 `graph` 파싱 확인.
- Implementer 검증 계획: `tsc --noEmit` + vitest(신규: 게이트 순서·suppression·프로브·오탐),
  `cargo check` + Rust 단위 테스트(저장소·claim·링·evidence), 수동 E2E(개발 모드에서
  WebContent kill 시뮬레이션 → 자동 복구 확인)은 머지 후 사용자 환경 항목으로 기록.

## Peer-review disposition (rev 2 — tasks 70-74)

| Finding | Reviewers | Disposition |
|---|---|---|
| HIGH: `persist_recovery_session`가 FE의 `ttlMs` 인자 누락 (`RecoverySessionClient.ts:23-27` 확증) | codex1, codex2, claude3 | FOLDED — 3-인자 시그니처 + `expiresAt=now+ttlMs`(클램프) 명시 (in-scope + node 5) |
| HIGH: 렌더-차단 부트스트랩과 replay-into-mounted-xterm 순서 충돌 — restoreShell은 스토어만, 리스너는 마운트가 설치 | codex2, codex3 | FOLDED — 2-페이즈 부트스트랩 + adoption-readiness 장벽(전원-ready/타임아웃) 노드 12/12b 분리; resumeAfterReload 바디 수정 허용을 Constraints에 명시 |
| HIGH: 복원 leaf가 `createSession→spawn_shell`로 생존 PTY를 덮어씀 (`useTerminal.ts:31-39` 확증) | codex2 | FOLDED — 신규 node 17: `adoptDetachedSession` 복원-adopt 분기 |
| HIGH: collaborator 타일은 로컬 `spawns` 렌더 — restoreAgents만으론 미표시; AgentMiniTerminal은 마운트 시 무조건 스폰 | codex2 | FOLDED — 신규 node 18: spawns 물질화 + adopt 모드 |
| MED: node 8의 RecoverySession 평탄화 — sign/action은 `decision` 중첩 필드 (types.ts:308-338) | claude3 (신규) | FOLDED — 중첩 구조 리터럴로 명시 (in-scope + node 8) |
| MED: topology 트리거가 collaboratorStore-단독 변경을 놓침 (capture가 양 스토어를 읽음) | codex1, codex2, claude3 | FOLDED — 공유 `scheduleTopologyPersist()` + 에이전트-단독 변경 테스트 (node 15/16) |
| LOW: IPC 카운트 자기모순 (9개/8열거/10건) | 4인 수렴 | FOLDED — 카운트 프로즈 제거, 정확 등록 체크리스트로 대체 (in-scope + node 11) |
| LOW: `recreate_webview`가 랜딩 FE에서 이미 호출됨에도 미등록/무결정 | claude2 | FOLDED — 명시적 no-op 스텁 등록 결정(Err 반환, FE가 삼킴); 등록 10건 산식 폐합 |
