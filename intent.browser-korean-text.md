# Intent — browser-korean-text

## Mode

problem

## Persona

내장 브라우저로 로컬 텍스트 파일(.txt, .md 등)을 열어보는 Canvas Terminal 사용자. 한국어 콘텐츠(레거시 인코딩 포함)를 다룬다. [사용 빈도는 사용자가 명시하지 않음 — inferred]

## Goal

로컬 텍스트 파일을 내장 브라우저로 여는 사용자를 위해, 한글이 포함된 텍스트 파일이 UTF-8 및 한국어 레거시 인코딩(EUC-KR/CP949) 범위에서 깨짐 없이 표시되도록 한다.

## In-scope features

- 내장 브라우저가 `localfile://`로 텍스트 파일을 인라인 렌더링할 때 한글이 올바르게 표시된다
- UTF-8(BOM 유무 무관) 한글 텍스트 파일 지원
- EUC-KR/CP949(레거시) 한글 텍스트 파일 지원 (실제 깨진 파일 `어린왕자-dmsah10.txt`가 CP949로 검증됨)
- 인라인 렌더 대상 포맷 audit: 텍스트 포맷 중 현재 인라인 렌더 대상은 `text/*`이다(이미지/PDF도 인라인이지만 텍스트가 아니므로 별개). `.txt`·`.md`(text/markdown)·`.csv`(text/csv)·`.log`(text/plain)는 모두 `text/*` → 인라인이라 깨질 수 있음(mime_guess-2.0.5로 검증); `.json`=application/json은 attachment/다운로드라 in-browser mojibake가 없다. 인라인 렌더되어 한글이 깨지는 포맷을 식별 후 커버 범위를 확정한다

## Out-of-scope

- 터미널 패널 / 캔버스 텍스트 / 협업 패널에서의 한글 — 이번 버그는 내장 브라우저 localfile 렌더링 한정
- 원격(http/https) 웹사이트의 한글 인코딩 — 서버가 보내는 charset은 우리 통제 밖
- 한국어 외 보편 인코딩 감지: UTF-16/UTF-32, Shift_JIS, GBK, Big5 등 — 이번 버그 범위 밖(필요 시 부수적으로만)
- 파일을 다른 인코딩으로 변환·저장하는 에디터 기능 — 읽기/표시만이 목적이며 파일 수정이 아님
- 다운로드(attachment) 대상 포맷을 인라인 렌더로 바꾸는 동작 변경

## Constraints

- 현재 증거(근본원인 가설): localfile 응답은 `classify_mime`가 `mime_guess`로 만든 charset 없는 MIME(`text/plain`)을 그대로 `Content-Type`에 싣고 raw 바이트를 `X-Content-Type-Options: nosniff`와 함께 전달한다. 깨진 샘플은 CP949이므로 `charset=utf-8`만으로는 고칠 수 없다. (정확한 WebKit fallback 동작은 미검증 — 추정)
- 인코딩 감지/트랜스코딩이 필요: `file -I`조차 `iso-8859-1`로 오판하므로 신뢰할 외부 charset 신호가 없고 바이트 기반으로 인코딩을 정해야 한다
- CP949는 EUC-KR의 상위집합이며 샘플이 양쪽에서 동일하게 디코드됨(검증) → CP949/EUC-KR 호환 디코더 하나로 충분하고 EUC-KR 별도 처리는 불필요하다 (단 crate별 라벨이 다름: `encoding_rs`는 WHATWG `euc-kr`/`windows-949` 라벨을 쓰며 코드명이 정확히 'CP949'가 아닐 수 있음 — 디코더 선택은 플래너 결정) [resolved]
- 결함은 응답 구성 경로(`classify_mime` / `build_localfile_response` + 선택적 트랜스코딩 단계)에 국소화된다 → URL-scheme 3-way invariant(`browser.rs`/`urlScheme.ts`/`localfile.rs`)나 CSP sandbox는 건드릴 필요가 없으며, 보안 헤더(CSP/nosniff)·localfile 토큰 범위·deny-prefix 경로 검사는 그대로 유지할 것
- 기존 ASCII/영문 텍스트 및 비텍스트(이미지/PDF/octet-stream attachment) 동작을 회귀시키지 않을 것. 트랜스코딩을 하더라도 인라인 렌더되는 `text/*` 클래스에만 적용하고 이미지/PDF/octet-stream은 바이트 보존 다운로드로 유지할 것
- 선례: `dashboard/server.rs`는 이미 text/plain·json·html 응답에 `charset=utf-8`을 부여한다 — localfile 경로만 예외다 (단 dashboard 라우트는 localfile과 보안 표면이 다르므로 '명시적 charset 부여' 패턴의 선례로만 참고하고, 동작을 그대로 복제하는 근거로 쓰지 말 것)

## Success criteria

- 한글이 포함된 UTF-8 `.txt`/`.md`를 내장 브라우저로 열면 깨짐 없이 그대로 보인다 (`.md`는 마크다운 '서식 렌더'가 아니라 원문 한글 텍스트가 안 깨지는 것을 의미)
- 한글이 포함된 CP949/EUC-KR `.txt`(예: `어린왕자-dmsah10.txt`)를 열면 "여섯 살 적에 나는 …"처럼 한글로 올바로 보인다(mojibake 아님)
- 헤더/바디 시맨틱: UTF-8 텍스트는 명시적 UTF-8 charset(또는 UTF-8 바디)로, 레거시 텍스트는 올바른 charset 또는 UTF-8 트랜스코딩 + 일치 헤더로 제공된다
- 회귀 금지: 기존 ASCII/영문 표시, 이미지/PDF 인라인, 비텍스트 attachment(다운로드) 동작, 보안 헤더(CSP/nosniff)가 변하지 않는다
- 검증 경로 존재: UTF-8 한글 fixture + CP949 한글 fixture("여섯 살 적에 나는") + ASCII 불변 케이스에 대한 단위/통합(또는 수동) 확인 경로가 있다. fixture는 저장소에 커밋한 바이트 픽스처/인라인 바이트 벡터로 구성하고, 사용자 `~/Downloads`의 실제 파일을 CI 테스트 의존성으로 쓰지 말 것

## Examples

- `어린왕자-dmsah10.txt`(CP949, 첫 바이트 `bf a9 bc b8`)를 내장 브라우저로 열면 도입부가 "여섯 살 적에 나는 「체험한 이야기」라는 제목의, 원시림에 관한 책에서…"로 한글 정상 표시된다

## Counter-examples

- UTF-8 파일을 레거시로 오판(또는 그 반대)하여 새로 깨뜨림 — 잘못된 인코딩 감지 자체가 새 버그다 (UTF-8은 자기검증적이므로 'strict UTF-8 우선, 실패 시 CP949' 순서가 근거상 안전하다 — 샘플로 입증됨, 단 일반 증명은 아니며 플래너 검증 대상)
- 보안 헤더(nosniff/CSP)를 제거해 임의 HTML 스니핑/렌더를 허용 — 보안 invariant 위반이다
- 다운로드되어야 할 비텍스트를 인라인 렌더로 바꾸거나 브라우저 밖 영역(터미널/캔버스)을 손대는 것 — 범위 밖 + 회귀 위험이다

## Root-cause

1. 사용자가 CP949로 인코딩된 한글 `.txt`를 내장 브라우저로 연다 (증상: 한글이 `¿©¼¸` 형태로 깨져 보인다)
2. localfile 핸들러가 `classify_mime`로 확장자만 보고 `text/plain`을 결정한다 (charset 없음, 바이트 미검사)
3. `build_localfile_response`가 `Content-Type: text/plain`(charset 없음) + `nosniff`로 raw CP949 바이트를 그대로 전달한다
4. charset 신호도 트랜스코딩도 없어 디코딩 인코딩이 미확정 상태가 된다
5. [추정] WebKit가 파일과 불일치하는 기본/추정 인코딩으로 바이트를 해석한다 → 한글 mojibake (근본 원인: charset 미부여 + 레거시 인코딩 미감지)

## Open questions

- 전략 선택: charset 헤더 부여 vs 서버측 UTF-8 트랜스코딩. 외부 charset 신호가 전무하고(`file -I` 오판) 커스텀 스킴에서 레거시 charset 라벨 준수 보장이 불확실 → 'CP949 디코드 후 UTF-8 재인코딩 + charset=utf-8 제공'이 더 결정론적이라는 lean(검증 후 채택 권장). 구현/플래너 결정.
- 감지 순서: strict UTF-8 우선 → 실패 시 CP949 (UTF-8 자기검증성으로 오판 위험 낮음). 단, 전체가 valid UTF-8인 CP949 파일(긴 ASCII 영역만 포함 등)은 UTF-8로 판정되어 비한국어 레거시는 감지되지 않는다 — 이번 범위(한글 표시)에서는 수용 가능. 최종은 구현 결정.
- 트랜스코딩 선택 시 Content-Length 출처: `build_localfile_response`는 `bytes.len()`(`localfile.rs:270`)로 Content-Length를 산출하므로 트랜스코딩은 응답 구성보다 **먼저** 일어나야 한다. `fs::metadata().len()`(크기 게이트 값)로 길이를 내면 트랜스코딩된 바디와 불일치해 응답이 잘리거나 손상된다. 플래너/구현이 확정.
- 크기 한계 적용 시점: `LOCALFILE_MAX_BYTES`(256 MiB, `localfile.rs:54`)는 원본 on-disk 크기(`metadata.len()`, `localfile.rs:560/566`)에 대해 사전 검사된다. CP949→UTF-8은 한글에서 ~1.5x 팽창하므로 게이트를 통과한 파일이 트랜스코딩 후 precondition(`bytes.len() <= LOCALFILE_MAX_BYTES`)을 초과할 수 있다 → 한계를 pre/post-transcode 중 어디에 적용할지 플래너 결정.
- 의존성: `encoding_rs`(+ 필요 시 `chardetng`)는 net-new 크레이트(현재 `src-tauri/Cargo.toml`에 부재). 도입 여부/대안은 플래너 결정.

## Provenance

- Intent ID: 47454-39728-19327
- Revision: 1
- Confirmed at: 2026-06-21T22:12:11+0900
- Language used during elicitation: Korean
