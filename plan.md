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
  live 엔트리에서 claimed source_path 집합을 스냅샷해 전달.

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
- 하드코딩 버전/프레임워크 금지. 동시성은 기존 Inner 락 패턴 재사용(새 동시성 설계 없음).

## Success criteria

- 두 collab 세션이 각각 `claude1`을 띄워도 서로 다른 파일(`contexts/<sessionA>/claude1.jsonl`
  vs `contexts/<sessionB>/claude1.jsonl`)에 기록된다.
- 한 세션에서 같은 cwd에 claude를 2개 띄워도 각자 자기 transcript에 정확히 바인딩된다.
- 두 handle이 같은 `source_path`에 동시 바인딩되지 않는다.
- `PeerContextPanel`이 새 경로에서 정상적으로 읽고, breadcrumb의 grep 경로도 실제 기록
  경로와 일치한다.
- `tsc --noEmit`(frontend) + `cargo check`(src-tauri) 통과, 기존 테스트(특히
  `transcript_adapter_contract.rs`) 회귀 없음.

## Open questions

- `collabSessionId` 문자열을 파일시스템 안전하게 sanitize(영숫자+하이픈)하여 디렉터리명으로
  사용 — 가정으로 진행. (구현 시 sanitize 헬퍼를 Rust append 경로와 TS reader 경로 양쪽에
  동일 규칙으로 적용해야 함.)
- Codex/Gemini transcript에 동일 `You are @<handle>` identity 마커가 기록되는지는 어댑터별
  실측 필요. 마커가 없는 tool은 Defense-2A를 적용할 수 없으므로 Defense-2B(점유경로 제외)
  단독으로 폴백한다. 구현 단계에서 각 어댑터 실측으로 확정.

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
| 4 | `TranscriptAdapter::discover_session` 트레잇 + 3 impl(claude_code/codex/gemini) + test fixture에 collab_session_id·claimed_paths 인자, handle echo | src-tauri/transcripts/adapters/* + tests/transcript_adapter_contract.rs | 시그니처 계약 변경 |
| 5 | `discover_by_mtime`(:639): **2A** mtime 후보 중 `You are @<handle>` 마커 포함 우선 선택, **2B** claimed_paths 제외; 마커 0개면 retry, 단일 unclaimed 후보뿐이면 폴백 | src-tauri/transcripts/adapters/mod.rs | Defense-2 핵심 |
| 6 | `append_normalized_turn`(:1167) 경로를 `contexts/<collab_session_id>/<handle>.jsonl` (mkdir -p) | src-tauri/transcripts/mod.rs | 충돌 해소 핵심 |
| 7 | `rotate_if_needed`(:1275) active+archive(`.jsonl.tmp`, `.<N>.jsonl`) 경로 세션 스코프화 | src-tauri/transcripts/mod.rs | N6과 동일 규칙 |
| 8 | `scan_archive_indices`(:1368) 스캔 경로 세션 스코프화 | src-tauri/transcripts/mod.rs | rotation 목록 일치 |
| 9 | `discovery_loop`(:838): 매 시도 전 Inner live 엔트리의 source_path 스냅샷 → claimed_paths로 N4/N5에 전달 | src-tauri/transcripts/mod.rs | 2B용 공유상태 읽기(기존 락) |
| 10 | `AgentMiniTerminal`의 `invoke('watch_transcript')`에 collabSessionId 전달 | src/components/collaborator/AgentMiniTerminal.tsx | writer 계약 진입점 |
| 11 | `peerContext.loadActive(agentHandle, collabSessionId)` 경로 세션 스코프화 | src/lib/peerContext.ts:305 | |
| 12 | `peerContext.loadLastArchive` 경로 세션 스코프화 | src/lib/peerContext.ts:341 | |
| 13 | `peerContext.listArchives` list+정규식 세션 프리픽스 | src/lib/peerContext.ts:381 | |
| 14 | `peerContext.hasContextsBreadcrumb` 세션 스코프 존재검사 | src/lib/peerContext.ts:266 | breadcrumb 조건 |
| 15 | `PeerContextPanel.tsx`가 loader들에 collabSessionId 주입 | src/components/collaborator/PeerContextPanel.tsx | |
| 16 | `collaboratorStore` buildAgentContextPreamble의 `[Peer contexts: …/contexts/]` → `…/contexts/<session>/` | src/stores/collaboratorStore.ts:1092 | grep 경로=기록 경로 불변식 |

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
