# Canvas Terminal

🌐 **English** | [한국어](README.ko.md)

**A canvas-first terminal where you and multiple AI CLIs think together as one collective.**

Canvas Terminal is built around a single idea: **collective intelligence**. Sketch a diagram once and route the same picture to one agent or every agent in the workspace. Spawn Claude Code, Codex CLI, Gemini CLI, and Copilot CLI side by side, route tasks between them, and let them share memory through a common workspace — so what would be four separate chat windows becomes one coordinated system. Drop an image or `.md` file directly to insert it; PDF, DOCX, XLSX, CSV, and HWP files come in via the toolbar's Insert File button. Open the Collaborator pane to launch multiple agent terminals and coordinate them with shared task and memory files — no copy-paste, no file juggling.

![License](https://img.shields.io/badge/license-MIT-blue.svg)
![Platform](https://img.shields.io/badge/platform-macOS-lightgrey.svg)
![Built with](https://img.shields.io/badge/built%20with-Tauri%20v2-blue.svg)
[![Release](https://img.shields.io/github/v/release/yes506/canvas-terminal?label=download)](https://github.com/yes506/canvas-terminal/releases/latest)

<!-- TODO: Replace with an actual screenshot or GIF of the app -->
<!-- ![Canvas Terminal Screenshot](docs/screenshot.png) -->

---

## Get Started

### Download Latest Release

Download the latest macOS build from [GitHub Releases](https://github.com/yes506/canvas-terminal/releases/latest), open the `.dmg`, and drag **Canvas Terminal** into Applications.

Releases are code-signed and Apple-notarized, and the app updates itself in place via Tauri 2 auto-update from signed GitHub Releases — no need to manually re-download for new versions.

### Build from Source

#### Prerequisites

| Tool | Version | Install |
|------|---------|---------|
| **Rust** | 1.70+ | [rustup.rs](https://rustup.rs/) |
| **Node.js** | 18+ | [nodejs.org](https://nodejs.org/) |

> The Tauri CLI is included as an npm devDependency — no separate `cargo install` needed.

#### Build & Install

```bash
# 1. Install Rust (skip if already installed)
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
source "$HOME/.cargo/env"

# 2. Clone and enter the project
git clone https://github.com/yes506/canvas-terminal.git
cd canvas-terminal

# 3. Install all dependencies (frontend + Tauri CLI)
npm install

# 4. Build the production app
npm run tauri:build

# 5. Open the generated DMG and drag to Applications
open src-tauri/target/release/bundle/dmg/Canvas\ Terminal_*.dmg
```

#### Development Mode

```bash
npm install
npm run tauri dev    # Hot reload — frontend changes apply instantly
```

| Script | Description |
|--------|-------------|
| `npm run dev` | Vite dev server (frontend only) |
| `npm run tauri dev` | Full app with hot reload |
| `npm run tauri:build` | Production build (.dmg) |
| `npm run build` | Frontend only (TypeScript + Vite) |
| `npm run preview` | Preview the built frontend |
| `npm run clean` | Remove dist and release bundles |

For public macOS distribution, see [docs/macos-signing-notarization.md](docs/macos-signing-notarization.md) for Apple code signing and notarization of the generated DMG.

---

## How It Works

```
+---------------------------+     +---------------------------+
|        Canvas Panel       |     |      Terminal Panel       |
|                           |     |                           |
|  Draw shapes, diagrams,   |     |  Full PTY shell (zsh)     |
|  wireframes, annotations  |     |  AI CLI tools running     |
|                           |     |                           |
|  [Upload] ───────────────────>  Path pasted into terminal   |
|                           |     |  AI reads your drawing    |
|                           |     |                           |
|  <─────────────────── [Download] AI writes a response file  |
|  Response rendered as     |     |                           |
|  styled image on canvas   |     |                           |
+---------------------------+     +---------------------------+
```

1. **Draw** something on the canvas — an architecture diagram, a UI wireframe, a flowchart.
2. **Upload** — the canvas becomes a PNG. Its file path is pasted into the active terminal.
3. **AI processes** — Claude Code, Gemini CLI, Codex, Copilot CLI, or any CLI tool reads the image.
4. **Download** — the AI's response (Markdown, SVG, HTML, image, or plain text) is rendered back onto the canvas as an image, so the canvas works with document-like outputs as well as images. Markdown source from imported `.md` files can be exported back out via **Cmd+Shift+S**.

This creates a **visual feedback loop** between you, the canvas, and the AI. Works with any CLI tool that accepts image paths, and brings both visual and document-style outputs back onto the canvas.

---

## Collective Intelligence — The Core Idea

> One human, many minds, one canvas, one memory.

Canvas Terminal is not a terminal that happens to run AI tools. It is a workbench for **collective intelligence** — the deliberate composition of multiple AI agents, a human, a shared visual surface, and a shared memory into a single thinking system.

### The three pillars

**1. Many minds — diversity over redundancy.**
Claude Code, Codex CLI, Gemini CLI, and Copilot CLI run in parallel mini-terminals. They do not share the same training, the same biases, or the same blind spots. Disagreement between them is signal, not noise. Address one with `@claude1`, broadcast to the swarm with `@all`, and let conflict surface what a single model would have hidden.

**2. Shared memory — cognition that outlives a context window.**
Every agent reads from and writes to `~/.cache/canvas-terminal/collab-memory`: conversation logs, task files, and an optional `context.md`. When one agent finishes a task it writes a JSON marker, and the next agent can continue from the same shared files instead of starting from scratch. The swarm's memory is a file tree, not a single chat history — durable, inspectable, and version-controllable.

**3. Visual common ground — a channel text cannot replace.**
The canvas is the lingua franca. A diagram you sketch is exported as an image to one agent or all agents at once. Their answers — Markdown, SVG, HTML, plain text, PNG — render back on the same canvas. Shape, spatial layout, and annotation become things the swarm can point at together. No copy-paste, no "describe what you see" preamble.

### The topology

```
                         ┌──────────────────────┐
                         │    Shared Canvas     │
                         │ visual common ground │
                         └──────────┬───────────┘
                                    │
                            export ↕ import
                                    │
        ┌───────────┬───────────┬───┴───────┬───────────┬─────────┐
        │           │           │           │           │         │
   ┌────▼────┐ ┌────▼────┐ ┌────▼────┐ ┌────▼────┐ ┌────▼────┐ ┌──▼──┐
   │ @human  │ │ @claude │ │ @codex  │ │ @gemini │ │@copilot │ │ ... │
   └────┬────┘ └────┬────┘ └────┬────┘ └────┬────┘ └────┬────┘ └──┬──┘
        │           │           │           │           │         │
        └───────────┴───────────┴───┬───────┴───────────┴─────────┘
                                    │
                         ┌──────────▼───────────┐
                         │    Shared Memory     │
                         │  tasks · logs · ctx  │
                         └──────────────────────┘
```

### Solo AI chat vs. Canvas Terminal collective

| Solo AI chat | Canvas Terminal collective |
|---|---|
| One model, one context window | N models, N perspectives |
| Text-only channel | Text + canvas + files |
| Memory dies with the tab | Memory lives on disk, picked up by the next agent |
| You orchestrate by copy-paste | You orchestrate with `@mentions`, `/task`, `/canvas-export` |
| Disagreement is friction | Disagreement is a feature |

The human stays the conductor. Canvas Terminal does not replace human judgment — it lowers the cost of distributing work, surfacing disagreement, and recombining results into a single decision. Every other section of this README — the canvas integration, the collaborator pane, the task protocol, the shared-memory layout — is an implementation detail of these three pillars. Read it that way.

---

## What's New

> These collaboration features are not isolated utilities — together they form the runtime of collective intelligence inside the terminal.

**Many minds**
- **Collaborator pane** for running Claude Code, Codex CLI, Gemini CLI, and Copilot CLI in parallel
- **Indexed handles** like `@claude1` / `@claude2`, with `@all` broadcasts and a target selector for untargeted prompts

**Shared memory**
- **Shared workspace** at `~/.cache/canvas-terminal/collab-memory` for conversation logs, task files, and optional context
- **Multi-agent task protocol** — assign, claim, complete with JSON markers
- **Automatic agent output capture** that strips ANSI sequences and appends readable text to the shared log

**Visual common ground**
- **Canvas routing for agents** — `/canvas-export` and `/canvas-import` work directly with spawned collaborators
- **Document round-trip** — Markdown, SVG, HTML, PNG/JPEG, and plain text render back onto the canvas

---

## Canvas-to-Terminal Integration

The canvas is the visual common ground for the collective. It is how a sketch becomes shared perception across every agent in the workspace — and how their document-style responses come back home.

### Export (Canvas → Terminal)

1. Click the **Upload** button in the canvas toolbar
2. Your drawing is rendered as a high-DPI PNG snapshot
3. The file path is pasted into the terminal using **bracketed paste mode** (safe — won't accidentally execute)
4. The AI CLI tool receives the path and reads the image

### Import (Terminal → Canvas)

1. Click the **Download** button in the canvas toolbar
2. An instruction is sent to the terminal, asking the AI to write its output to a file
3. The app polls for the response every 1.5 seconds (up to 5 minutes) — click again to cancel
4. When the file appears, the format is auto-detected and rendered on the canvas:

| Format | Rendering |
|--------|-----------|
| PNG / JPEG | Inserted directly as an image |
| SVG | Rasterized and inserted as an image |
| HTML | Body extracted, styled, and rendered as an image |
| Markdown | Converted to styled HTML (headings, lists, code blocks, tables) |
| Plain text | Displayed as a monospace code block |

Responses are rendered in a dark-themed style with Markdown-aware typography. Code blocks use SF Mono / Fira Code.

When the collaborator pane is active, canvas import/export routes through the collaborator workflow. Export sends an instructive prompt to the selected agent or agents, and import can poll multiple agents concurrently so their results appear on the canvas independently as they arrive.

---

## Features

### Terminal

The terminal is a full PTY shell — not a simplified emulator. It spawns a login shell (zsh/bash), sources your RC files, and inherits your entire environment (PATH, Homebrew, pyenv, nvm, etc.).

- **Tabs** — create, close, rename (double-click), duplicate, reorder (drag). Undo a closed tab within 5 seconds (Cmd+Z, up to 5 in history)
- **Pane splitting** — vertical (Cmd+D) or horizontal (Cmd+Shift+D), navigate with Cmd+Opt+Arrow, maximize a pane with Cmd+Shift+Enter
- **Search** — Cmd+F for inline find with real-time highlighting
- **Font zoom** — Cmd+= / Cmd+- (8pt to 28pt), Cmd+0 to reset
- **6 themes** — Monochrome (default), Catppuccin, Dracula, Tokyo Night, Nord, Solarized Dark
- **WebGL rendering** — GPU-accelerated text via xterm.js WebGL addon, with automatic canvas fallback
- **IME support** — Korean, Japanese, and Chinese composition handled correctly (no double input)
- **Shift+Enter** — sends a dedicated escape sequence recognized by Claude Code
- **Collaborator toggle** — open a multi-agent split without leaving the current tab

### Collaborator

The collaborator is the runtime of Collective Intelligence — a PTY-backed multi-agent workspace where many minds and one shared memory live together inside the terminal layout.

- **Four launch targets** — Claude Code, Codex CLI, Gemini CLI, Copilot CLI
- **Parallel agent terminals** — spawn multiple instances of the same tool, with indexed targeting like `@claude1` and `@claude2`
- **Shared task protocol** — built-in task creation, assignment, status updates, and completion logging
- **Shared memory backend** — task files, conversation logs, and optional context persisted under `~/.cache/canvas-terminal/collab-memory`
- **Agent output capture** — strips ANSI sequences and appends readable output to the collaboration log
- **Canvas-aware commands** — export the current drawing to one or many agents and import an agent-generated response back into the canvas
- **Prompt ergonomics** — history navigation, multi-line input with `Shift+Enter`, `@mention` autocomplete, and a target selector for untargeted prompts

### Canvas

A Fabric.js-powered drawing board designed for quick sketching, not pixel-perfect illustration.

- **Document-aware canvas output** — AI responses can come back as Markdown, HTML, SVG, plain text, or standard images, then render directly onto the canvas
- **Markdown file round-trip** — drop `.md` files onto the canvas to render them as styled images; **Cmd+Shift+S** exports the original Markdown source back to disk
- **Importable file formats** (toolbar Insert File) — PDF, DOCX, XLSX, XLS, CSV, TSV, HWP, HWPX, and **MD**. Drag-and-drop currently accepts images and `.md` only.
- **Collaborator-aware canvas routing** — send one canvas export to one or many agents and import each response back independently

**Drawing tools:**

| Tool | What it does |
|------|-------------|
| Select | Click to select, drag to move, area-select on empty space |
| Rectangle / Circle / Triangle | Basic shapes |
| Line | Straight lines or multi-point polylines (double-click to finish) |
| Arrow | Lines with arrowheads, supports multi-joint polylines |
| Leader Line | Bent annotation callouts with arrowheads — click to place joints |
| Text | Editable text boxes. Double-click any shape to add a label |
| Prompt Text | Visually distinct text for AI-oriented prompts |

**Editing:**
- **Vertex editing** — select a polyline and drag vertex handles (white circles with blue border) to reshape. Double-click a segment to add a midpoint, double-click a vertex to remove it
- **Colors** — stroke and fill modes, 12-color palette
- **Images** — insert PNG, JPG, GIF, SVG, WebP via file dialog. Right-click to save
- **Layers** — right-click any object to bring forward/backward
- **Undo/Redo** — 50-level history (Cmd+Z / Cmd+Shift+Z)
- **Pan & Zoom** — trackpad or toolbar, 25% to 500%
- **Snapshots** — capture canvas only (camera icon) or full app window (monitor icon) as on-canvas images
- **Save/Load** — Cmd+S / Cmd+O for `.canvas.json` files (fabric.js JSON, version-controllable)

---

## Collaborator Workflow

The collaborator is a dedicated split pane for multi-agent sessions.

### Open It

- Click the **zap** button in the tab bar
- Press `Cmd+E`
- Or type `collaborator` directly in a terminal and press Enter

### Launch Agents

The collaborator toolbar can spawn:

- **Claude Code**
- **Codex CLI**
- **Gemini CLI**
- **Copilot CLI** — requires GitHub authentication on first launch (`gh auth login` or in-app device-code prompt).

Each agent runs in its own PTY-backed mini terminal and inherits the active terminal's working directory when possible.

When multiple sessions of the same tool are running, the target selector disambiguates them with labels like `Claude Code #1`, `Claude Code #2`, plus matching handles such as `@claude1` and `@claude2`.

### Send Commands

Use the input prompt at the bottom of the collaborator pane:

| Input | Action |
|------|--------|
| `@claude fix this bug` | Send a message to one agent |
| `plain message` | If one agent is running, send directly. If multiple agents are running, open a target selector before sending |
| `@all investigate startup latency` | Explicitly broadcast to all running agents |
| `/status` | Show active agents |
| `/help` | Show command help |
| `/canvas-export [msg]` | Export canvas and show target selector (or send to sole agent) |
| `/canvas-export @agent [msg]` | Export canvas to a specific agent with optional prompt |
| `/canvas-import @agent` | Ask a specific agent to write a response file and import it back |
| `/context <text>` | Append shared context |
| `/memory list` | List files in shared memory |
| `/memory read <path>` | Read a shared-memory file |
| `/memory delete <path>` | Delete a shared-memory file |
| `/memory clear` | Clear the shared memory directory |
| `/task list` | List collaboration tasks |
| `/task add <title> \| <objective> [@agent]` | Create a task |
| `/task <id> status <pending|in-progress|completed|blocked>` | Update task state |
| `/task <id> assign @<agent>` | Reassign a task |
| `/task <id> done [notes]` | Mark a task complete |

### Shared Memory Files

Shared memory is the externalized cognition of the swarm. Every agent reads from and writes to the same directory, so the collective's thinking outlives any single conversation. Canvas Terminal creates the workspace under:

```text
~/.cache/canvas-terminal/collab-memory
```

Typical files:

- `conversation-<session>.md` — append-only conversation and task reports
- `tasks.md` — generated task definitions for active collaboration
- `context.md` — optional shared context for all agents

These files are designed for agent-to-agent handoff and are protected by path validation, size limits, and symlink checks in the Tauri backend.

---

## Keyboard Shortcuts

<details>
<summary><strong>Terminal shortcuts</strong></summary>

| Shortcut | Action |
|----------|--------|
| Cmd+T | New tab |
| Cmd+W | Close active tab |
| Cmd+Z | Undo close tab (within 5s) |
| Cmd+1 – Cmd+9 | Jump to tab by number |
| Cmd+Shift+[ / ] | Previous / next tab |
| Cmd+D | Split pane vertically |
| Cmd+Shift+D | Split pane horizontally |
| Cmd+Opt+Arrow | Navigate between panes |
| Cmd+Shift+Enter | Maximize / restore pane |
| Cmd+C | Copy selected text |
| Cmd+V | Paste (bracketed paste mode) |
| Cmd+F | Open find bar |
| Cmd+= / Cmd+- | Font zoom in / out |
| Cmd+0 | Reset font size |
| Cmd+E | Toggle collaborator split |
| Cmd+Enter | Toggle fullscreen |
| Type `collaborator` + Enter | Open collaborator from the shell |

</details>

<details>
<summary><strong>Canvas shortcuts</strong></summary>

| Shortcut | Action |
|----------|--------|
| Cmd+S | Save canvas to file |
| Cmd+O | Open canvas from file |
| Cmd+Z | Undo |
| Cmd+Shift+Z | Redo |
| Cmd+A | Select all objects |
| Delete / Backspace | Delete selected object |
| Escape | Deselect or cancel drawing |
| Enter | Finish polyline / leader line |
| Double-click shape | Add or edit label |
| Double-click segment | Add midpoint to polyline |
| Double-click vertex | Remove vertex from polyline |

</details>

---

## Tech Stack

| Layer | Technology |
|-------|------------|
| Desktop framework | [Tauri v2](https://v2.tauri.app/) (Rust backend, native macOS webview) |
| Frontend | React 18 + TypeScript 5 |
| Terminal emulation | [xterm.js](https://xtermjs.org/) with WebGL, search, fit, web-links, Unicode addons |
| Canvas drawing | [Fabric.js 6](http://fabricjs.com/) |
| State management | [Zustand](https://github.com/pmndrs/zustand) |
| Build tool | [Vite](https://vitejs.dev/) |
| Styling | [Tailwind CSS](https://tailwindcss.com/) |
| Icons | [Lucide](https://lucide.dev/) |
| Markdown rendering | [Marked](https://marked.js.org/) + [DOMPurify](https://github.com/cure53/DOMPurify) (sanitizes user-imported `.md` files) |
| Screen capture | [html2canvas](https://html2canvas.hertzen.com/) |

---

## Security

All file operations are restricted to your home directory or the app-managed collaboration cache.

- **Path validation** — all paths canonicalized and checked against `$HOME`
- **Symlink protection** — `O_NOFOLLOW` flag; symlink targets re-validated
- **File size limits** — 100 MB canvas JSON, 50 MB binary, 20 MB images
- **Magic byte validation** — PNG and JPEG verified by header bytes before processing
- **Input size limit** — terminal writes capped at 65 KB per call
- **Collaboration memory guardrails** — shared memory files reject traversal, absolute paths, oversized reads, and symlink writes
- **SVG exclusion** — SVG not loaded as raw images to prevent XSS vectors
- **IME-aware input** — East Asian composition events handled correctly to prevent double input
- **No GUI credential dialogs** — git/SSH prompts forced to terminal to prevent hangs in Tauri context

---

## License

MIT
