# Implementation report — collab-isolation-agy

(대화 언어: 한국어 — 코드/커밋/마커는 계약상 영어 유지)

## Source
- Planner marker: `feature` — 커밋 `db71df9` (`(plan-feature, human-confirmed)`)
- Planner artifacts: `ai-artifacts/runs/code/collab-isolation-agy-46135-45591-1034/plan.md`, `plan.mmd` (rev 3)
- Source hash: `23fd4357` (sha256, plan.md+plan.mmd 연결)

## Work queue summary
- Total items: 22 (plan Decomposition 노드 1–19, 7b/7c/15b 포함)
- Completed: 22
- Blocked: 0

## Files changed (dev..HEAD, +1197 / −406)
- `src-tauri/src/commands/memory.rs` (+272−33): sanitize 단일 소스, `get_memory_session_root`, 8개 스코프 IPC(`get_memory_session_dir` 포함), `clear_process_memory_root()`, `write_file_atomic_under` 엔진 분리, 격리 단위 테스트 8건
- `src-tauri/src/lib.rs` (+9−2): `init_memory_dir`→`get_memory_session_dir` 등록 교체, 창-닫힘 와이프를 `clear_process_memory_root()`로 전환
- `src-tauri/src/commands/transcripts/mod.rs` (+145−?): 미러 라이터/로테이션/아카이브 스캔 경로 `contexts/<sid>/`→`<sid>/contexts/`, `populate_entry`가 `memory_dir`을 세션 루트로 재지정, sanitize 위임, writer_tests 갱신 + `.state.json` 비공유 테스트 추가
- `src-tauri/src/commands/transcripts/tailer.rs` (+62−?): `persist_offset(handle, state)`로 스코프화 — 읽기/쓰기가 동일한 `handle.memory_dir` 기반
- `src-tauri/src/commands/transcripts/watcher.rs`: persist_offset 호출부 갱신
- `src-tauri/src/commands/transcripts/adapters/mod.rs` (+24−?): identity needle `<sid>/contexts/` 전환 + 픽스처 갱신, `adapter_for(gemini*)`→None, `GEMINI_ADAPTER` dead_code 보존(후속 SQLite 어댑터 출발점)
- `src-tauri/src/commands/pty.rs` (+5): `\n`→`\r` 유지 결정 문서화(측정 전 기본값 유지 — plan open question)
- `src/lib/scopedCollabMemory.ts` (신규 +82): `ScopedMemoryIpc`/`ScopedMemoryClient` 파사드, sid-키 dir 캐시(Map)
- `src/stores/collaboratorStore.ts` (+274−?): 전 memory invoke 파사드 교체, 헤더 빌더 세션 스코프(경로 전부 자기 세션 하위), 프로토콜 Rule 7(형제 세션 금지), killAllAgents 테어다운 → 스코프 `clearMemoryDir(sid)`, `toolShortName` handlePrefix 우선, publish 능력 게이트(addAgent/restore/setPublishOptedIn)
- `src/components/collaborator/commands.ts` (+53−?): /context·/memory 세션 스코프(세션 없으면 거부)
- `src/lib/peerContext.ts` (+87−?): 리더 glob 세션-상대(`contexts/…`), TS `sanitizeCollabSessionId` 삭제
- `src/components/collaborator/PeerContextPanel.tsx`: sanitize 사용 제거, truncation footer 경로 갱신
- `src/components/collaborator/AgentMiniTerminal.tsx` (+30−?): watch effect 능력 가드, Eye 토글 미지원 도구 숨김, READY_PATTERNS agy 감사 주석
- `src/types/collaborator.ts` (+34−?): gemini_cli → `command:"agy"`, `label:"Antigravity CLI"`, `handlePrefix:"gemini"`, `supportsPeerContextPublishing` 술어
- `src/dashboard/App.tsx` (+6−?): `encodePathForUrl` export(스모크 테스트용) — 동작 무변경
- 테스트: `collaboratorStore.test.ts` (+330−? — 격리 9건 + agy 10건 + mock 기반 갱신), `peerContext.test.ts` (재작성), `AgentMiniTerminal.test.ts` (+32), `dashboard/App.test.ts` (신규 +33)

## Validation
- Baseline exit (dev HEAD): 0 (119초; vitest 22파일 399건 + cargo 전체 통과)
- Final validation command: `npx tsc --noEmit && npm test && (cd src-tauri && cargo check && cargo test)`
- Final exit: **0** (18초, 증분)
- Auto-fix attempts used: 0/3
- Tail of last run (요약):
```
Test Files  23 passed (23)
Tests       424 passed (424)
cargo test: lib 79 passed (scoped_memory 8 + writer/state 3 포함); pty_eintr 4 ok;
transcript_adapter_contract 1 ok; doc-tests 0
```

## Per-item outcomes
| item_id | status | files_touched | notes |
|---|---|---|---|
| node-1-sanitize | completed | memory.rs | 크레이트 단일 소스; transcripts는 위임 |
| node-2-session-dir | completed | memory.rs, lib.rs | 3개 참조(정의/등록/TS 호출) 모두 갱신 |
| node-3-scoped-read | completed | memory.rs | `Ok(None)` 시맨틱 보존 |
| node-4-scoped-write | completed | memory.rs, tailer.rs | symlink/TOCTOU 방어 무손실 재사용; atomic 엔진 `write_file_atomic_under`로 분리 |
| node-5-scoped-delete-clear | completed | memory.rs | 부모 프루닝은 세션 루트에서 정지 |
| node-6-scoped-list-mtime | completed | memory.rs | list는 구조적으로 세션 횡단 불가 |
| node-19-teardown-split | completed | memory.rs, lib.rs, collaboratorStore.ts | 창-닫힘=프로세스 전체 와이프(비-IPC), killAllAgents=스코프 clear. endSession은 문서화된 "in-memory-only" 계약 유지(파일 삭제는 killAllAgents 경로가 담당 — plan의 "ad-hoc delete 교체" 대상이 killAllAgents의 delete 2건이었음) |
| node-8-ts-facade | completed | scopedCollabMemory.ts(신규), store, commands.ts | 원시 invoke 잔존 0건(grep 검증); dir 캐시 sid-키 Map |
| node-7-mirror-writer | completed | transcripts/mod.rs | 커밋 `200833a`에 7b/7c/13과 원자 랜딩 |
| node-7b-tailer-state | completed | tailer.rs, watcher.rs, mod.rs | 선택지 (a) 채택: populate 시 `memory_dir` 재지정 (sid를 `.state.json`에 저장하지 않는 기존 계약 보존); 빈 sid(수동 watch)는 레거시 경로 유지 |
| node-7c-identity-needle | completed | adapters/mod.rs | needle+픽스처 갱신; `conversation-<sid>.md` needle 생존 |
| node-13-reader-glob | completed | peerContext.ts(+test), PeerContextPanel.tsx | TS sanitize 미러 삭제 — drift 표면 제거 |
| node-9-header-builders | completed | collaboratorStore.ts(+test) | 주입 경로 전부 자기 세션 dir 하위; 교차-pane 격리 테스트 |
| node-10-protocol-text | completed | collaboratorStore.ts(+test) | Rule 7: 형제 세션 디렉토리 접근 명시 금지 |
| node-11-done-scan | completed | collaboratorStore.ts(+test) | 스코프 목록 + orphan 24h 유예 보존 |
| node-12-memory-context-cmds | completed | commands.ts(+test) | 세션 부재 시 거부(공유 루트 접근 원천 차단) |
| node-14-dashboard-smoke | completed | App.tsx(export만), App.test.ts | SPA는 `f.path` 그대로 렌더 — 검증대로 무변경; 중첩 경로 인코딩 스모크 3건 |
| node-15-agy-registration | completed | collaborator.ts | command `agy`, label `Antigravity CLI`; ToolId 불변 |
| node-15b-handle-prefix | completed | collaborator.ts, store(+test) | `@gemini1` 민팅 보존(스폰+예약 경로), help 텍스트 테스트 |
| node-16-pty-format | completed | pty.rs | 기능 무변경 — 측정 전 `\n`→`\r` 유지(문서화). **잔여 실증 항목**: agy 온보딩 후 주입 제출 동작 실측 |
| node-17-pattern-audit | completed | agentOutputCapture.ts, AgentMiniTerminal.tsx | 감사 결과: generic `>` 패턴 + 5s 폴백으로 커버(미스 시 지연으로 강등, 행 없음); 레거시 패턴 무해 보존. **잔여 실증 항목**: agy TUI 실측 |
| node-18-agy-publish-disable | completed | adapters/mod.rs, collaborator.ts, store, AgentMiniTerminal(+tests) | 상태 수준(default-off+restore 강제+setPublishOptedIn 가드)+effect 가드+Eye 숨김; copilot_cli는 현상 유지 |

## Scope-discipline self-check
- [x] No new interfaces / files outside hints — 신규 파일은 `src/lib/scopedCollabMemory.ts`(plan 명시), 테스트 파일 2건(`dashboard/App.test.ts` — node 14가 요구한 스모크 테스트)뿐
- [x] No renames of committed public names — `init_memory_dir`→`get_memory_session_dir` 교체는 plan이 명시한 8번째 스코프 커맨드
- [x] No signature changes on planner-committed methods — `ScopedMemoryIpc`/`ScopedMemoryClient` 시그니처 그대로 구현
- [x] No edits to validation_command configuration
- [x] No edits to files outside the work queue's hint set — 예외 2건 기록: `PeerContextPanel.tsx`(node 13의 sanitize 삭제가 강제한 소비자 갱신 — 미사용 파라미터 제거), `AgentMiniTerminal.test.ts`(node 18 zero-IPC 가드 잠금 테스트)

## Merge-gate 확인 필요 사항 (plan이 명시적으로 게이트에 올린 항목)
1. **agy 비대칭 승인**: 이 피처에서 agy는 완전한 mini-agent로 동작하되 peer-context 스토어에는 **write-only**(다른 에이전트가 agy 트랜스크립트를 grep 불가 — 후속 SQLite 어댑터까지). plan rev 3이 merge gate에서 명시 승인 요구.
2. **실증 잔여 항목**(코드 랜딩 후 사용자 환경 필요): agy 스폰 E2E(readiness→running, 주입 제출, 응답 스트림)와 `format_for_tool` `\n`→`\r` 유지/제거 실측.

---

## Addendum — 구현 라운드 피어 리뷰 처분 (5 리뷰: task-47 @codex1, task-48 @claude2, task-49 @codex2, task-50 @claude3, task-51 @codex3)

5인 전원 APPROVE (각자 독립적으로 전체 검증 재실행, 전원 exit 0 / 424 vitest / 79 lib 재현). 지적 사항 처분:

| Finding | Reviewers | 검증 결과 | 처분 |
|---|---|---|---|
| [MED] 검증 후 워크트리 더티 — `package-lock.json` 0.5.1→0.5.13, `Cargo.lock` 0.5.12→0.5.13 | 5인 전원 | 확인 — 원인은 **dev 자체의 사전 드리프트**(dev의 `package.json`=0.5.13 vs 커밋된 `package-lock.json`=0.5.1)를 검증용 `npm install`/cargo가 정규화한 것 | **폐기(restore)** — 피처 범위 밖의 릴리스-플로우 드리프트를 이 브랜치에 실어 보내지 않음. 워크트리 클린 확인. **후속 권고**: dev에서 별도 커밋으로 lockfile 동기화 (`npm install` + `cargo update -p canvas-terminal` 후 커밋) — 아니면 모든 워크트리/CI가 계속 더티해짐 |
| [MINOR] `peerContext.ts` `hasContextsBreadcrumb` JSDoc 깨짐(perl 편집 잔해) | @claude3 (task-50) | 확인 | **수정** — 커밋 `d389064`; 같은 docstring의 사전-재배치 서술(Inputs/Test contract)도 스코프-리스트 시맨틱으로 정정 |
| [LOW] 손상된 `.state.json`이 fresh-start 대신 바인드 대기 유발 | @claude2 (task-48) | 확인 — 이 diff 이전부터의 시맨틱; 재배치로 blast radius는 오히려 축소(전 세션 공유 → 단일 세션) | **변경 없음** (pre-existing; 수정은 스코프 확장). 향후 하드닝 후보로 기록 |
| [INFO] 비원자 `write_memory_file`에 per-component 심링크 워크 부재 + non-ELOOP 폴백이 `O_NOFOLLOW` 미적용 | @claude2 (task-48) | 확인 — 이 diff는 시그니처/디렉토리 해석만 변경, 해당 경로 무변경; plan의 로컬 단일 사용자 위협 모델 내 | **변경 없음** (pre-existing) |
| Merge-gate: agy write-only 비대칭 승인 + 실증 잔여 항목 | 5인 전원 재확인 | — | 게이트에서 인간 결정 (본 리포트 상단 참조) |

재검증(수정 후): `tsc --noEmit && npm test && cargo check && cargo test` → **exit 0** (424 vitest / 79 lib 전부 통과), 워크트리 클린.
