# Canvas Terminal

A desktop terminal emulator with an integrated drawing canvas. Draw diagrams, annotate ideas, and send visual prompts directly to AI CLI tools running in the terminal.

![License](https://img.shields.io/badge/license-MIT-blue.svg)
![Platform](https://img.shields.io/badge/platform-macOS-lightgrey.svg)

## What is Canvas Terminal?

Canvas Terminal combines a full-featured terminal emulator with a drawing board. Instead of describing your ideas in text alone, you can sketch architecture diagrams, flowcharts, or UI wireframes and send them as structured text to any AI CLI tool (Claude Code, Codex, Gemini CLI, etc.) running in the terminal.

**The drawing becomes part of your prompt.**

## Features

### Terminal
- Full PTY-based shell (zsh/bash)
- Tabbed sessions with drag reorder
- Split panes (vertical/horizontal) with resizable dividers
- Pane navigation and maximize
- Find in terminal (Cmd+F)
- Copy/paste (Cmd+C/V)
- Font size zoom (Cmd+=/-)
- Multiple themes (Monochrome, Catppuccin, Dracula, Tokyo Night, Nord, Solarized)
- Undo close tab (Cmd+Z within 5s)
- Fullscreen (Cmd+Enter)

### Canvas
- Shape tools: rectangle, circle, triangle, line, arrow, text
- Multi-joint lines and arrows (click to add joints, double-click to finish)
- Image support (drag-and-drop or insert button)
- Stroke and fill color system with 14-color palette
- Apply colors to selected objects
- Undo/redo with 50-state history
- Clear canvas with confirmation
- Double-click shapes to add labels
- Proportional resize when canvas panel resizes
- Save/load drawings as `.canvas.json` (Cmd+S/O)

### Canvas-to-Terminal Integration
- Click "Send to Terminal" to serialize your drawing as structured text
- The serialized prompt describes shapes, connections, images, and annotations
- Text is written directly to the active terminal's stdin
- Works with any AI CLI tool that accepts text input

## Tech Stack

- **Tauri v2** — Rust backend, native macOS webview
- **React + TypeScript** — Frontend UI
- **xterm.js** — Terminal emulator
- **fabric.js** — Canvas drawing library
- **Zustand** — State management
- **Tailwind CSS** — Styling

## Getting Started

### Prerequisites

- [Rust](https://rustup.rs/) (1.70+)
- [Node.js](https://nodejs.org/) (18+)
- [Tauri CLI](https://v2.tauri.app/start/prerequisites/)

```bash
cargo install tauri-cli
```

### Development

```bash
# Install dependencies
npm install

# Run in development mode (hot reload)
cargo tauri dev

# Build for production
cargo tauri build
```

The built app will be at:
- `src-tauri/target/release/bundle/macos/Canvas Terminal.app`
- `src-tauri/target/release/bundle/dmg/Canvas Terminal_*.dmg`

## Keyboard Shortcuts

### Terminal
| Shortcut | Action |
|----------|--------|
| Cmd+T | New tab |
| Cmd+W | Close tab |
| Cmd+1-9 | Switch to tab |
| Cmd+Shift+[ / ] | Previous/next tab |
| Cmd+D | Split pane vertically |
| Cmd+Shift+D | Split pane horizontally |
| Cmd+Opt+Arrow | Navigate between panes |
| Cmd+Shift+Enter | Maximize/restore pane |
| Cmd+Z | Undo close tab (within 5s) |
| Cmd+C | Copy selection |
| Cmd+V | Paste |
| Cmd+F | Find in terminal |
| Cmd+= / Cmd+- | Zoom in/out |
| Cmd+0 | Reset font size |
| Cmd+Enter | Toggle fullscreen |

### Canvas
| Shortcut | Action |
|----------|--------|
| Cmd+S | Save canvas |
| Cmd+O | Open canvas |
| Cmd+Z | Undo (when canvas focused) |
| Cmd+Shift+Z | Redo (when canvas focused) |
| Cmd+A | Select all (when canvas focused) |
| Delete/Backspace | Delete selected object |
| Escape | Deselect / cancel drawing |
| Enter | Finish polyline |
| Double-click | Finish polyline / add label to shape |

## Canvas File Format

Drawings are saved as `.canvas.json` files using fabric.js native JSON serialization. These files capture all shapes, positions, colors, and images.

## How It Works

When you click "Send to Terminal", the canvas content is serialized into structured text:

```
I have a diagram with the following elements:

Shapes:
- [1] Rect "API Gateway" at position (120, 80), size 200x100
- [2] Circle "Database" at position (400, 200), radius 50

Connections:
- Arrow from "API Gateway" to "Database"

Images:
- Image "architecture.png" at position (50, 300), size 300x200

Annotations:
- "Handle retry logic here" at position (500, 150)
```

This text is written to the active terminal's stdin, where it becomes input for whatever CLI tool is running.

## License

MIT
