# Feature plan — collab-context-collision-fix

## Goal

Collaborator peer-context 미러(`contexts/<handle>.jsonl`)가 두 경로로 충돌/오귀속되는
문제를 한 계획으로 해결한다:

1. **세션 간 충돌** — handle(`claude1`/`codex2`...)은 `(collabSessionId, tool)` 단위
   ordinal이라 세션마다 리셋되는데, 미러 경로는 앱-PID 디렉터리 안에서 handle 문자열로만
   키잉된다(`get_memory_dir()` = `collab-memory/session-{process::id()}`). 따라서 서로
   다른 collab 세션의 `claude1`이 하나의 `contexts/claude1.jsonl`로 합쳐진다.
   (session-2154에서 claude 소스 transcript 4개 vs claude 컨텍스트 파일 3개로 실제 발생 확인.)
2. **세션 내 same-cwd 충돌** — `discover_by_mtime`가 "PID 시작시각 이후 mtime이 가장
   최근인 JSONL"을 PID/agent 소유 검증 없이 고른다. 같은 cwd에 동일 tool 에이전트가 둘
   이상이면 엉뚱한 transcript에 바인딩되거나 두 handle이 같은 source에 바인딩될 수 있다.

목표: 각 미러 파일이 정확히 하나의 실제 에이전트 transcript에만 대응되도록 보장.

## In scope

- **Defense-1 (세션 네임스페이싱)**: 미러 경로를 `contexts/<collabSessionId>/<handle>.jsonl`로
  변경. `collabSessionId`를 `watch_transcript` IPC → `watch` → `TranscriptHandle` →
  `append_normalized_turn`(+ `rotate_if_needed` / `scan_archive_indices`)까지 배선.
- 프론트엔드 reader 일치: `peerContext.ts`(loadActive/loadLastArchive/listArchives/
  hasContextsBreadcrumb), `PeerContextPanel.tsx`, `collaboratorStore.ts`의
  `[Peer contexts: …]` breadcrumb를 세션-스코프 경로로 변경.
- **Defense-2A (identity 매칭)**: `discover_session`이 mtime 후보 중 내용에
  `You are @<agent_handle>` 마커를 포함한 source transcript를 우선 선택. claude/codex/
  gemini 어댑터 공통. 미flush race는 기존 5초 `discovery_loop` 재시도가 흡수.
- **Defense-2B (점유경로 제외)**: discovery가 이미 다른 live handle에 바인딩된
  `source_path`를 후보에서 제외해 이중 바인딩을 차단. `discovery_loop`가 watcher Inner의
  live 엔트리에서 claimed source_path 집합을 스냅샷해 전달(N9, 선택 단계). **단 이 스냅샷은
  필요조건일 뿐 충분하지 않음** — 동시 pending discovery는 `populate_entry` 락 안의 원자적
  중복-source 재검사(N17)로만 완전 차단된다.
- **정적 프로토콜 텍스트 동기화(N18)**: 미러 파일이 한 단계 깊어지므로, 에이전트 프롬프트에
  주입되는 `TASK_PROTOCOL`과 협업 프로토콜 문서의 `contexts/*.jsonl` glob을 세션-스코프로
  갱신(안 그러면 grep 불일치 → 협업 데드락).
- **2A 폴백 종료 정책(N19)**: 마커 미기록 tool에서 무한 retry(no-bind)와 잘못된 즉시
  폴백(misbind) 사이의 절충을 planner가 명시 결정.

## Out of scope

- 기존(네임스페이스 안 된) `contexts/<handle>.jsonl` 마이그레이션 — 그대로 두고 무시
  (`~/.cache` 하위 캐시 파일, 무해). 신규 세션부터 새 레이아웃 사용.
- `get_memory_dir()`의 앱-PID 스코프 자체 변경 — 상위 디렉터리는 유지, 하위에 세션 레벨만 추가.
- 마커 위조 방지 등 강한 보증(서명/암호화).
- conversation/tasks 파일 네임스페이싱(이미 세션별로 분리됨).

## Constraints

- **one-way mirror 불변식** 유지: 외부 transcript 루트는 read-only, CT는 미러만 기록.
- **peer-context discovery 불변식** 유지: 에이전트가 grep하는 경로(breadcrumb)와 실제
  기록 경로가 반드시 일치해야 협업 데드락이 안 생김 → N16(breadcrumb)와 N6(기록 경로)은
  같은 세션-스코프 규칙을 공유해야 함.
- `.state.json`은 `source_path` 키(전역 유일)이므로 `contexts/.state.json` 위치/키 변경
  불필요. 단 rotation이 쓰는 `.jsonl.tmp`/`.<N>.jsonl`은 세션-스코프 디렉터리를 따라야 함.
- **resume 불변식(C1)**: `collab_session_id`는 `TranscriptHandle`에만 존재하고, 매번
  프론트 `watch_transcript` 호출로 새로 공급되며, `.state.json`에는 절대 저장하지 않는다.
  resume는 핸들로부터 미러 경로를 재구성한다(`resume_from_state`가 `&TranscriptHandle`만
  받음 — tailer.rs:76). → 구현자가 `.state.json`에 필드를 넣어야 한다고 오해 금지.
- **canonical 경로 비교(N17)**: claimed-path 비교는 양쪽 모두 canonical로. `TranscriptHandle.
  source_path`는 fs-gate 후 canonical, `read_dir`의 raw mtime 후보는 아님 → 섞으면 alias 누락.
- **sanitize 계약(단일 규칙)**: collab session id는 Rust append 경로와 TS reader 경로 양쪽에서
  동일하게 `[A-Za-z0-9_-]+`로 검증/정규화(불허 문자 일관 처리). reader/writer drift 금지.
- 하드코딩 버전/프레임워크 금지. 동시성은 기존 Inner 락 패턴 재사용(새 동시성 설계 없음).

## Success criteria

- 두 collab 세션이 각각 `claude1`을 띄워도 서로 다른 파일(`contexts/<sessionA>/claude1.jsonl`
  vs `contexts/<sessionB>/claude1.jsonl`)에 기록된다.
- 한 세션에서 같은 cwd에 claude를 2개 띄워도 각자 자기 transcript에 정확히 바인딩된다.
- 두 handle이 같은 `source_path`에 동시 바인딩되지 않는다.
- `PeerContextPanel`이 새 경로에서 정상적으로 읽고, breadcrumb의 grep 경로도 실제 기록
  경로와 일치한다.
- 에이전트에 주입되는 grep 지시(`TASK_PROTOCOL`/협업 프로토콜 문서)가 세션-스코프 경로를
  가리켜, 기록 경로와 어긋나지 않는다(N18).
- `hasContextsBreadcrumb`/`listArchives`가 **자기 세션** 하위만 보고, 다른 세션 contexts에
  cross-session 오탐/오집계를 내지 않는다(N13/N14).
- `tsc --noEmit`(frontend) + `cargo check`(src-tauri) 통과, 기존 테스트(특히
  `transcript_adapter_contract.rs`) 회귀 없음.

## Open questions

- (해소됨 → Constraints의 sanitize 계약) collab session id sanitize 규칙을 단일화.
- Codex/Gemini transcript에 동일 `You are @<handle>` identity 마커가 기록되는지는 어댑터별
  **실측 필요**(잔존 open question). 마커가 없는 tool은 Defense-2A가 no-op이 되며, 이때
  N19 종료 정책(유한 retry → 경고 폴백)과 Defense-2B(+N17)로 안전을 보장한다. 단 codex는
  task-3 기준 더 노출된 tool(전역 비-cwd rollout 디렉터리)이므로 구현자는 codex 어댑터의
  마커 기록 여부를 우선 실측할 것.

## Peer review amendments (verified)

5개 동료 리뷰(@codex1/2/3, @claude2/3)를 수집하고 **각 지적을 코드로 실증 검증한 뒤** 반영했다.

| # | 지적 | 검증 결과 | 반영 |
|---|---|---|---|
| 1 | populate 시점 source_path race(2B 불충분) | `populate_entry` Phase C(:961-968)에 Populated/RaceRollback(unwatch) 분기뿐, 중복-source 검사 없음 — **사실** | N17 신규 |
| 2 | `TASK_PROTOCOL`/문서의 stale `contexts/*.jsonl` glob | collaboratorStore.ts:425 + doc:25,40 확인, 매 프롬프트 주입 — **사실, load-bearing** | N18 신규 |
| 3 | `loadSnapshot` 누락(실제 호출 진입점) | PeerContextPanel.tsx:70 → loadSnapshot(peerContext.ts:434)가 3 loader 호출 — **사실** | N14b 신규 |
| 4 | `hasContextsBreadcrumb` cross-session 오탐 | `list_memory_files` 재귀(walk memory.rs:419) + `startsWith("contexts/")` — **사실** | N13/N14 정밀화 |
| 5 | 2A 폴백 liveness vs 엄격성 절충 | codex(미기록 가능)에서 무한 retry=no-bind 위험 타당 | N19 종료 정책 |
| 6 | N4가 어댑터 트레잇 과확장 | collab_session_id는 discovery와 무관(미러 경로용) — 타당 | N4를 claimed_paths만으로 축소, collab_session_id는 watcher-owned(N17/populate에서 핸들에 부착) |
| 7 | 명시 테스트 노드 부재 | adapter_contract.rs는 트레잇 drift만 검출 — 타당 | N20 신규 |
| 8 | sanitize 단일 계약 | reader/writer drift 위험 타당 | Constraints에 명문화 |

수렴 합의(반영 안 함이 정답인 것): **split 금지**(codex1/claude3 — 두 방어는 서로 다른 축,
하나만 내면 알려진 hole 잔존), `.state.json` flat 유지(전원 동의 — resume가 핸들에서 재구성).
줄번호 nit: discovery_loop :838 → **:834** 정정.

## Package layout

신규 패키지 없음 — 변경은 기존 두 위치에 머문다:
`src-tauri/src/commands/transcripts/`(Rust writer + discovery)와 `src/`(frontend
peer-context reader). `packages = []`.

## Decomposition

의존 방향: 프론트 진입(N10) → IPC(N1) → watch(N2) → discovery_loop(N9) →
discover_session(N4) → discover_by_mtime(N5, 2A+2B) → TranscriptHandle(N3) →
append/rotate/scan(N6-8) → [경로 계약] → reader(N11-14) → PeerContextPanel(N15);
breadcrumb(N16)는 N6의 기록 경로와 일치해야 함. 전체 DAG는 `plan.mmd` 참조.

| Node # | Stage | Belongs to package | Notes |
|---|---|---|---|
| 1 | `watch_transcript` IPC에 `collab_session_id` 인자 추가 → `watch()` 전달 | src-tauri/transcripts/mod.rs | 프론트 collabSessionId 수신 |
| 2 | `TranscriptWatcher::watch` + `Entry`(:423)에 collab_session_id 저장, `discovery_loop`로 스레딩 | src-tauri/transcripts/mod.rs | |
| 3 | `TranscriptHandle`에 `collab_session_id` 필드 추가 | src-tauri/transcripts/mod.rs | agent_handle과 동일 CT-side identity 패턴 |
| 4 | `TranscriptAdapter::discover_session` 트레잇 + 3 impl(claude_code/codex/gemini) + test fixture에 **`claimed_paths`만** 인자 추가(2B 선택용). **`collab_session_id`는 어댑터에 넣지 않음** | src-tauri/transcripts/adapters/* + tests/transcript_adapter_contract.rs | 어댑터는 source 발견만 담당 (codex2/claude3 수렴) |
| 5 | `discover_by_mtime`(:639): **2A** mtime 후보 중 `You are @<handle>` 마커 포함 우선 선택, **2B** claimed_paths 제외; 폴백은 **N19 종료 정책**을 따름 | src-tauri/transcripts/adapters/mod.rs | Defense-2 핵심 |
| 6 | `append_normalized_turn`(:1167/:1210) 경로를 `contexts/<collab_session_id>/<handle>.jsonl` (mkdir -p) | src-tauri/transcripts/mod.rs | 충돌 해소 핵심 |
| 7 | `rotate_if_needed`(:1275) active+archive(`.jsonl.tmp`, `.<N>.jsonl`) 경로 세션 스코프화 | src-tauri/transcripts/mod.rs | N6과 동일 규칙 |
| 8 | `scan_archive_indices`(:1368) 스캔 경로 세션 스코프화 | src-tauri/transcripts/mod.rs | rotation 목록 일치 |
| 9 | `discovery_loop`(:834): 매 시도 전 Inner live 엔트리의 source_path 스냅샷 → claimed_paths로 N4/N5에 전달 | src-tauri/transcripts/mod.rs | 2B 선택 단계용(기존 락) |
| 10 | `AgentMiniTerminal`의 `invoke('watch_transcript')`(:916)에 collabSessionId 전달 | src/components/collaborator/AgentMiniTerminal.tsx | writer 계약 진입점 |
| 11 | `peerContext.loadActive(agentHandle, collabSessionId)` 경로 세션 스코프화 | src/lib/peerContext.ts:305 | |
| 12 | `peerContext.loadLastArchive` 경로 세션 스코프화 | src/lib/peerContext.ts:341 | |
| 13 | `peerContext.listArchives` list+정규식에 **세션 세그먼트** 포함 (재귀 list_memory_files 대응 — 없으면 0개 반환) | src/lib/peerContext.ts:381 | claude3 (a) |
| 14 | `peerContext.hasContextsBreadcrumb` 접두사를 **`contexts/<collabSessionId>/`**로 정밀화 (`startsWith("contexts/")`는 cross-session 오탐 — list_memory_files 재귀) | src/lib/peerContext.ts:266/:269 | claude3 (a) |
| 14b | **`peerContext.loadSnapshot(agentHandle, collabSessionId)`** 오케스트레이터에 collabSessionId 추가 → N11~13에 스레딩 (PeerContextPanel이 실제 호출하는 진입점) | src/lib/peerContext.ts:434 | claude2/claude3/codex3 수렴 — 누락 시 tsc hole |
| 15 | `PeerContextPanel.tsx`(:70)가 `loadSnapshot`에 collabSessionId 주입 | src/components/collaborator/PeerContextPanel.tsx | |
| 16 | `collaboratorStore` buildAgentContextPreamble의 `[Peer contexts: …/contexts/]` → `…/contexts/<session>/` | src/stores/collaboratorStore.ts:1092 | grep 경로=기록 경로 불변식 |
| 17 | **(신규·필수) `populate_entry` Phase C 원자적 중복-source 재검사**: 핸들 저장(:961-968) 전, Inner 락 안에서 후보의 **canonical** `source_path`를 다른 live populated 엔트리와 비교 → 이미 점유면 populate 대신 기존 `RaceRollback` 경로(FSEvents sub 해제 + discovery 재시도) | src-tauri/transcripts/mod.rs:900-997 | N9 스냅샷은 필요조건일 뿐, 동시 pending race는 여기서만 차단 (codex2/codex3/claude3 수렴) |
| 18 | **(신규·필수) 정적 프로토콜 텍스트 세션-스코프화**: `TASK_PROTOCOL` Rule 2의 `contexts/*.jsonl` → `contexts/<collabSessionId>/*.jsonl`(또는 주입된 `[Peer contexts: …]` 경로 지시) + 동일 문구 doc 2곳 | src/stores/collaboratorStore.ts:425, docs/collaborator-agent-protocol.md:25,40 | **load-bearing**: 매 에이전트 프롬프트에 주입됨 → 안 고치면 grep 경로 불일치로 협업 데드락 (codex2/codex3/claude3 수렴) |
| 19 | **(신규·필수) Defense-2A 폴백 종료 정책**: 마커-매칭 unclaimed 후보 우선 → 없으면 **유한 횟수** 마커 대기 재시도 → 소진 시 newest-among-unclaimed로 **경고 로그와 함께 폴백**(무한 spin 금지). 마커 미기록 tool(codex)의 no-bind 영구 degradation 방지; 오바인딩은 2B+N17이 차단 | src-tauri/transcripts/adapters/mod.rs | codex1(엄격) vs claude3(liveness) 절충 — planner가 명시 결정 |
| 20 | **(신규) 테스트 노드**: Rust — 네임스페이스 write/rotate/scan 경로 + claimed-path 동시 race 거부(N17); TS — 세션-스코프 peerContext 경로(loadActive/loadLastArchive/listArchives/hasContextsBreadcrumb/loadSnapshot) + store/component(collabSessionId 전달, breadcrumb=`contexts/<session>/`) | src-tauri/tests/*, src/**/*.test.ts(x) | `transcript_adapter_contract.rs`는 트레잇 drift만 잡음 (codex1/codex3/claude3 수렴) |
| 21 | **(신규) stale 주석/문서 동기화**: `session-<pid>/contexts/<agent>.jsonl`로 미러 경로를 설명하는 주석들을 세션-스코프 경로로 갱신 | src-tauri/transcripts/* 주석 | codex1 |

## Interfaces emitted

N/A — feature 레인, Phase 5 스켈레톤 미생성. cross-boundary contract(`watch_transcript`
IPC 시그니처 + `contexts/<session>/<handle>.jsonl` 경로 계약)는 위 분해 N1·N6에 명시.

## Validation

스켈레톤 미생성이므로 컴파일 타겟 없음 → Phase 7 plan-artifact smoke-check로 검증:
- `plan.md` 비어있지 않고 필수 헤더(`## Goal`, `## Package layout`, `## Decomposition`) 포함.
- `plan.mmd`가 유효 Mermaid(`graph LR`로 시작).

구현 단계(codebase-implementer)에서의 실제 검증 계약: `cargo check`(src-tauri) +
`tsc --noEmit`(frontend) + 기존 테스트(`transcript_adapter_contract.rs` 어댑터 계약 포함)
회귀 없음.
