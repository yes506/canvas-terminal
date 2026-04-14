# Canvas Terminal

[English](README.md) | 🌐 **한국어**

**그림이 곧 AI 프롬프트가 되고, 여러 AI CLI가 나란히 협업할 수 있는 터미널.**

다이어그램을 그리고 업로드를 클릭하면, 터미널에서 실행 중인 AI CLI 도구가 그림을 봅니다. AI에게 응답을 요청하면 결과가 캔버스에 렌더링됩니다. 여기에 Collaborator 패널을 열어 여러 에이전트 터미널을 띄우고, 공유 태스크와 메모리 파일을 기준으로 협업시킬 수도 있습니다. Canvas Terminal은 시각적 아이디어를 AI 대화로 바꿔줍니다 — 복사-붙여넣기도, 파일 관리도 필요 없습니다.

![License](https://img.shields.io/badge/license-MIT-blue.svg)
![Platform](https://img.shields.io/badge/platform-macOS-lightgrey.svg)
![Built with](https://img.shields.io/badge/built%20with-Tauri%20v2-blue.svg)

<!-- TODO: 실제 앱 스크린샷 또는 GIF로 교체 -->
<!-- ![Canvas Terminal 스크린샷](docs/screenshot.png) -->

---

## 작동 방식

```
+---------------------------+     +---------------------------+
|        캔버스 패널         |     |       터미널 패널          |
|                           |     |                           |
|  도형, 다이어그램,         |     |  완전한 PTY 셸 (zsh)      |
|  와이어프레임, 주석 그리기  |     |  AI CLI 도구 실행 중       |
|                           |     |                           |
|  [업로드] ───────────────────>  경로가 터미널에 붙여넣기     |
|                           |     |  AI가 그림 읽기            |
|                           |     |                           |
|  <─────────────────── [다운로드] AI가 응답 파일 작성         |
|  응답이 캔버스에           |     |                           |
|  스타일 이미지로 렌더링     |     |                           |
+---------------------------+     +---------------------------+
```

1. **그리기** — 캔버스에 아키텍처 다이어그램, UI 와이어프레임, 플로차트 등을 스케치합니다.
2. **업로드** — 캔버스가 PNG로 변환되고, 파일 경로가 활성 터미널에 붙여넣기됩니다.
3. **AI 처리** — Claude Code, Gemini CLI, Codex 등 CLI 도구가 이미지를 읽습니다.
4. **다운로드** — AI의 응답(Markdown, SVG, HTML, 이미지, 일반 텍스트)이 캔버스에 렌더링됩니다.

이를 통해 사용자, 캔버스, AI 간의 **시각적 피드백 루프**가 만들어집니다. 이미지 경로를 받는 모든 CLI 도구와 호환됩니다.

---

## 새로운 내용

- **Collaborator 패널**로 Claude Code, Codex CLI, Gemini CLI를 병렬 실행
- `~/.cache/canvas-terminal/collab-memory` 아래의 **공유 메모리 워크스페이스**로 대화 로그, 태스크 파일, 컨텍스트 관리
- `@mention`, 브로드캐스트, 태스크 추적, 메모리 파일 관리를 지원하는 **에이전트 명령 프롬프트**
- `/canvas-export`, `/canvas-import`가 스폰된 협업 에이전트와 직접 연결되는 **캔버스 라우팅**
- 사람이 읽을 수 있는 텍스트만 협업 로그로 기록하는 **자동 에이전트 출력 캡처**

---

## Collaborator 워크플로우

Collaborator는 멀티 에이전트 세션을 위한 전용 분할 패널입니다.

### 여는 방법

- 탭 바의 **zap** 버튼 클릭
- `Cmd+E` 입력
- 또는 터미널에 `collaborator`를 입력하고 Enter

### 에이전트 실행

Collaborator 도구막대에서 다음 도구를 실행할 수 있습니다.

- **Claude Code**
- **Codex CLI**
- **Gemini CLI**

각 에이전트는 자체 PTY 기반 미니 터미널에서 실행되며, 가능하면 현재 활성 터미널의 작업 디렉토리를 그대로 이어받습니다.

### 명령 보내기

Collaborator 패널 하단 입력창에서 다음과 같이 사용할 수 있습니다.

| 입력 | 동작 |
|------|------|
| `@claude fix this bug` | 특정 에이전트 하나에 메시지 전송 |
| `@all investigate startup latency` | 실행 중인 모든 에이전트에 브로드캐스트 |
| `/status` | 활성 에이전트 목록 표시 |
| `/help` | 명령 도움말 표시 |
| `/canvas-export` | 현재 캔버스를 모든 에이전트에 내보내기 |
| `/canvas-import @claude` | 한 에이전트가 응답 파일을 쓰게 하고 다시 캔버스로 가져오기 |
| `/context <text>` | 공유 컨텍스트 추가 |
| `/memory list` | 공유 메모리 파일 목록 표시 |
| `/memory read <path>` | 공유 메모리 파일 읽기 |
| `/memory delete <path>` | 공유 메모리 파일 삭제 |
| `/memory clear` | 공유 메모리 디렉토리 비우기 |
| `/task list` | 협업 태스크 목록 표시 |
| `/task add <title> | <objective> [@agent]` | 새 태스크 생성 |
| `/task <id> status <pending|in-progress|completed|blocked>` | 태스크 상태 변경 |
| `/task <id> assign @<agent>` | 태스크 담당 에이전트 변경 |
| `/task <id> done [notes]` | 태스크 완료 처리 |

### 공유 메모리 파일

Canvas Terminal은 다음 경로 아래에 협업용 워크스페이스를 만듭니다.

```text
~/.cache/canvas-terminal/collab-memory
```

대표적인 파일은 다음과 같습니다.

- `conversation-<session>.md` — append-only 대화 및 태스크 보고 로그
- `tasks.md` — 활성 협업 세션의 태스크 정의 파일
- `context.md` — 모든 에이전트가 공유하는 선택적 컨텍스트 파일

이 파일들은 에이전트 간 인수인계를 위한 용도로 설계되었고, Tauri 백엔드에서 경로 검증, 크기 제한, 심볼릭 링크 차단으로 보호됩니다.

---

## 빠른 시작

### 사전 요구 사항

| 도구 | 버전 | 설치 |
|------|------|------|
| **Rust** | 1.70+ | [rustup.rs](https://rustup.rs/) |
| **Node.js** | 18+ | [nodejs.org](https://nodejs.org/) |

> Tauri CLI는 npm devDependency에 포함되어 있어 별도의 `cargo install`이 필요 없습니다.

### 빌드 & 설치

```bash
# 1. Rust 설치 (이미 설치된 경우 건너뛰기)
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
source "$HOME/.cargo/env"

# 2. 프로젝트 클론 및 진입
git clone https://github.com/yes506/canvas-terminal.git
cd canvas-terminal

# 3. 모든 의존성 설치 (프론트엔드 + Tauri CLI)
npm install

# 4. 프로덕션 앱 빌드
npm run tauri:build

# 5. 생성된 DMG를 열고 Applications로 드래그
open src-tauri/target/release/bundle/dmg/Canvas\ Terminal_*.dmg
```

### 개발 모드

```bash
npm install
npm run tauri dev    # 핫 리로드 — 프론트엔드 변경 즉시 반영
```

| 스크립트 | 설명 |
|----------|------|
| `npm run dev` | Vite 개발 서버 (프론트엔드만) |
| `npm run tauri dev` | 핫 리로드로 전체 앱 시작 |
| `npm run tauri:build` | 프로덕션 빌드 (.dmg) |
| `npm run build` | 프론트엔드만 빌드 (TypeScript + Vite) |
| `npm run preview` | 빌드된 프론트엔드 미리보기 |
| `npm run clean` | dist 및 릴리스 번들 삭제 |

---

## 캔버스-터미널 연동

Canvas Terminal을 다른 모든 터미널 에뮬레이터와 차별화하는 핵심 기능입니다.

### 내보내기 (캔버스 → 터미널)

1. 캔버스 도구바의 **업로드** 버튼 클릭
2. 그림이 고해상도 PNG 스냅샷으로 렌더링
3. 파일 경로가 **브래킷 붙여넣기 모드**로 터미널에 전달 (안전 — 실수로 실행되지 않음)
4. AI CLI 도구가 경로를 수신하여 이미지 읽기

### 가져오기 (터미널 → 캔버스)

1. 캔버스 도구바의 **다운로드** 버튼 클릭
2. AI에게 파일로 출력하도록 안내하는 지시문이 터미널에 전송
3. 앱이 1.5초마다 응답 파일 확인 (최대 5분) — 다시 클릭하면 취소
4. 파일이 나타나면 형식을 자동 감지하여 캔버스에 렌더링:

| 형식 | 렌더링 |
|------|--------|
| PNG / JPEG | 이미지로 직접 삽입 |
| SVG | 래스터화하여 이미지로 삽입 |
| HTML | 본문 추출, 스타일 적용 후 이미지로 렌더링 |
| Markdown | 스타일 적용된 HTML로 변환 (제목, 목록, 코드 블록, 테이블) |
| 일반 텍스트 | 모노스페이스 코드 블록으로 표시 |

응답은 다크 테마 스타일과 Markdown 인식 타이포그래피로 렌더링됩니다. 코드 블록은 SF Mono / Fira Code를 사용합니다.

---

## 기능

### 터미널

터미널은 완전한 PTY 셸입니다 — 단순화된 에뮬레이터가 아닙니다. 로그인 셸(zsh/bash)을 실행하고, RC 파일을 로드하며, 전체 환경(PATH, Homebrew, pyenv, nvm 등)을 상속합니다.

- **탭** — 생성, 닫기, 이름 변경(더블클릭), 복제, 순서 변경(드래그). 5초 이내 닫은 탭 되돌리기 (Cmd+Z, 최대 5개)
- **패인 분할** — 수직(Cmd+D) 또는 수평(Cmd+Shift+D), Cmd+Opt+화살표로 이동, Cmd+Shift+Enter로 최대화
- **검색** — Cmd+F로 실시간 하이라이트 검색
- **폰트 줌** — Cmd+= / Cmd+- (8pt ~ 28pt), Cmd+0으로 초기화
- **6가지 테마** — Monochrome (기본), Catppuccin, Dracula, Tokyo Night, Nord, Solarized Dark
- **WebGL 렌더링** — xterm.js WebGL 애드온으로 GPU 가속 텍스트, 자동 캔버스 폴백
- **IME 지원** — 한국어, 일본어, 중국어 조합 입력 정확 처리 (이중 입력 방지)
- **Shift+Enter** — Claude Code가 인식하는 전용 이스케이프 시퀀스 전송
- **Collaborator 토글** — 현재 탭을 벗어나지 않고 멀티 에이전트 분할 패널 열기

### Collaborator

Collaborator는 터미널 레이아웃 안에 포함된 PTY 기반 멀티 에이전트 작업 공간입니다.

- **3가지 실행 대상** — Claude Code, Codex CLI, Gemini CLI
- **병렬 에이전트 터미널** — 같은 도구도 여러 개 띄울 수 있으며 `@claude1`, `@claude2`처럼 인덱스로 지정 가능
- **공유 태스크 프로토콜** — 태스크 생성, 할당, 상태 변경, 완료 로그를 기본 지원
- **공유 메모리 백엔드** — 태스크 파일, 대화 로그, 선택적 컨텍스트가 `~/.cache/canvas-terminal/collab-memory` 아래에 저장
- **에이전트 출력 캡처** — ANSI 시퀀스를 제거한 읽기 쉬운 출력만 협업 로그에 추가
- **캔버스 연동 명령** — 현재 그림을 하나 또는 여러 에이전트에 내보내고, 에이전트가 만든 응답을 다시 캔버스로 가져오기 가능
- **프롬프트 사용성** — 히스토리 이동, `Shift+Enter` 멀티라인 입력, `@mention` 자동완성 지원

### 캔버스

빠른 스케치를 위한 Fabric.js 기반 드로잉 보드입니다. 픽셀 단위의 정밀 작업이 아닌, 빠른 아이디어 전달에 최적화되어 있습니다.

**그리기 도구:**

| 도구 | 기능 |
|------|------|
| 선택 | 클릭으로 선택, 드래그로 이동, 빈 영역 드래그로 다중 선택 |
| 사각형 / 원 / 삼각형 | 기본 도형 |
| 선 | 직선 또는 다중 포인트 폴리라인 (더블클릭으로 완료) |
| 화살표 | 화살촉이 있는 선, 다중 관절 폴리라인 지원 |
| 리더 라인 | 꺾인 주석 콜아웃 — 클릭으로 관절 배치 |
| 텍스트 | 편집 가능한 텍스트 상자. 도형 더블클릭으로 레이블 추가 |
| 프롬프트 텍스트 | AI 프롬프트용 시각적으로 구분되는 특수 텍스트 |

**편집:**
- **꼭짓점 편집** — 폴리라인 선택 후 꼭짓점 핸들(파란 테두리 흰색 원) 드래그로 형태 변경. 세그먼트 더블클릭으로 중간점 추가, 꼭짓점 더블클릭으로 삭제
- **색상** — 테두리와 채우기 모드, 12색 팔레트
- **이미지** — 파일 대화상자로 PNG, JPG, GIF, SVG, WebP 삽입. 우클릭으로 저장
- **레이어** — 객체 우클릭으로 앞/뒤 순서 변경
- **실행 취소/다시 실행** — 50단계 히스토리 (Cmd+Z / Cmd+Shift+Z)
- **팬 & 줌** — 트랙패드 또는 도구바, 25% ~ 500%
- **스냅샷** — 캔버스만 캡처(카메라 아이콘) 또는 전체 앱 창 캡처(모니터 아이콘)
- **저장/불러오기** — Cmd+S / Cmd+O로 `.canvas.json` 파일 관리 (fabric.js JSON, 버전 관리 가능)

---

## 키보드 단축키

<details>
<summary><strong>터미널 단축키</strong></summary>

| 단축키 | 동작 |
|--------|------|
| Cmd+T | 새 탭 |
| Cmd+W | 활성 탭 닫기 |
| Cmd+Z | 탭 닫기 되돌리기 (5초 이내) |
| Cmd+1 – Cmd+9 | 번호로 탭 이동 |
| Cmd+Shift+[ / ] | 이전 / 다음 탭 |
| Cmd+D | 수직 패인 분할 |
| Cmd+Shift+D | 수평 패인 분할 |
| Cmd+Opt+화살표 | 패인 간 이동 |
| Cmd+Shift+Enter | 패인 최대화 / 복원 |
| Cmd+C | 선택 텍스트 복사 |
| Cmd+V | 붙여넣기 (브래킷 모드) |
| Cmd+F | 검색 바 열기 |
| Cmd+= / Cmd+- | 폰트 확대 / 축소 |
| Cmd+0 | 폰트 크기 초기화 |
| Cmd+E | Collaborator 분할 토글 |
| Cmd+Enter | 전체 화면 전환 |
| `collaborator` 입력 후 Enter | 셸에서 Collaborator 열기 |

</details>

<details>
<summary><strong>캔버스 단축키</strong></summary>

| 단축키 | 동작 |
|--------|------|
| Cmd+S | 캔버스를 파일로 저장 |
| Cmd+O | 파일에서 캔버스 불러오기 |
| Cmd+Z | 실행 취소 |
| Cmd+Shift+Z | 다시 실행 |
| Cmd+A | 모든 객체 선택 |
| Delete / Backspace | 선택한 객체 삭제 |
| Escape | 선택 해제 또는 그리기 취소 |
| Enter | 폴리라인 / 리더 라인 완료 |
| 도형 더블클릭 | 레이블 추가 또는 편집 |
| 세그먼트 더블클릭 | 폴리라인에 중간점 추가 |
| 꼭짓점 더블클릭 | 폴리라인에서 꼭짓점 삭제 |

</details>

---

## 기술 스택

| 레이어 | 기술 |
|--------|------|
| 데스크톱 프레임워크 | [Tauri v2](https://v2.tauri.app/) (Rust 백엔드, 네이티브 macOS 웹뷰) |
| 프론트엔드 | React 18 + TypeScript 5 |
| 터미널 에뮬레이션 | [xterm.js](https://xtermjs.org/) — WebGL, 검색, fit, web-links, Unicode 애드온 |
| 캔버스 드로잉 | [Fabric.js 6](http://fabricjs.com/) |
| 상태 관리 | [Zustand](https://github.com/pmndrs/zustand) |
| 빌드 도구 | [Vite](https://vitejs.dev/) |
| 스타일링 | [Tailwind CSS](https://tailwindcss.com/) |
| 아이콘 | [Lucide](https://lucide.dev/) |
| Markdown 렌더링 | [Marked](https://marked.js.org/) |
| 화면 캡처 | [html2canvas](https://html2canvas.hertzen.com/) |

---

## 보안

모든 파일 작업은 홈 디렉토리 또는 앱이 관리하는 협업 캐시로 제한됩니다.

- **경로 검증** — 모든 경로를 정규화하고 `$HOME` 기준으로 확인
- **심볼릭 링크 보호** — `O_NOFOLLOW` 플래그; 심볼릭 링크 대상 재검증
- **파일 크기 제한** — 캔버스 JSON 100MB, 바이너리 50MB, 이미지 20MB
- **매직 바이트 검증** — PNG와 JPEG 처리 전 헤더 바이트로 확인
- **입력 크기 제한** — 터미널 쓰기 호출당 65KB 제한
- **협업 메모리 보호 장치** — 공유 메모리 파일은 경로 탈출, 절대 경로, 과도한 읽기 크기, 심볼릭 링크 쓰기를 거부
- **SVG 제외** — XSS 벡터 방지를 위해 SVG를 원시 이미지로 로드하지 않음
- **IME 인식 입력** — 동아시아 언어 조합 이벤트 정확 처리로 이중 입력 방지
- **GUI 인증 대화상자 차단** — git/SSH 프롬프트를 터미널로 강제하여 Tauri 환경에서의 멈춤 현상 방지

---

## 라이선스

MIT
