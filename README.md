# Canvas Terminal

A desktop terminal emulator with an integrated drawing canvas. Sketch diagrams, annotate ideas, and send visual prompts directly to AI CLI tools running in the terminal.

![License](https://img.shields.io/badge/license-MIT-blue.svg)
![Platform](https://img.shields.io/badge/platform-macOS-lightgrey.svg)
![Built with](https://img.shields.io/badge/built%20with-Tauri%20v2-blue.svg)

## What is Canvas Terminal?

Canvas Terminal combines a full-featured terminal emulator with a drawing board in a single desktop app. Instead of describing your ideas in text alone, you can sketch architecture diagrams, flowcharts, or UI wireframes and send them as image files to any AI CLI tool (Claude Code, Codex, Gemini CLI, etc.) running in the terminal.

**The drawing becomes part of your prompt.**

The app is split into two resizable panels: a collapsible **canvas** on the left and a **terminal** on the right. Drag the divider to adjust the layout to your needs.

---

## Features

### Terminal

#### Tabbed Sessions
- Create, close, rename, and duplicate tabs
- Drag-and-drop to reorder tabs
- Jump to any tab with **Cmd+1** through **Cmd+9**
- Cycle through tabs with **Cmd+Shift+[** and **Cmd+Shift+]**
- Undo a closed tab within 5 seconds (**Cmd+Z**) — up to 5 tabs in history
- Double-click a tab to rename it inline
- Right-click a tab for a context menu (rename, duplicate)

#### Pane Splitting
- Split any pane vertically (**Cmd+D**) or horizontally (**Cmd+Shift+D**)
- Navigate between panes with **Cmd+Opt+Arrow** keys
- Maximize a single pane to fill the tab (**Cmd+Shift+Enter**), toggle to restore
- Click any pane to focus it

#### Full PTY Shell
- Spawns a login shell (zsh or bash) that sources your full RC files (~/.zshrc, etc.)
- Inherits PATH, Homebrew, pyenv, nvm, and all environment variables
- UTF-8 environment (LC_ALL, LANG, LC_CTYPE)
- TERM=xterm-256color for full color support
- Duplicate tab opens in the same working directory as the original

#### Search
- **Cmd+F** opens an inline find bar
- Type to highlight matches in real-time
- **Enter** / **Shift+Enter** to navigate forward/backward through results
- **Esc** to dismiss

#### Font Size & Zoom
- **Cmd+=** / **Cmd+-** to increase/decrease font size (8pt to 28pt)
- **Cmd+0** to reset to default (13pt)
- Font size applies across all panes

#### Themes
Switch terminal colors with a single click. Six built-in themes:

| Theme | Description |
|-------|-------------|
| Monochrome | Minimal grayscale (default) |
| Catppuccin | Warm pastel tones |
| Dracula | Classic dark vampire palette |
| Tokyo Night | Cyberpunk neon |
| Nord | Arctic cool blues |
| Solarized Dark | Precise scientific palette |

#### Clipboard
- **Cmd+C** copies selected terminal text
- **Cmd+V** pastes from clipboard using bracketed paste mode (prevents accidental command execution)

#### Fullscreen
- **Cmd+Enter** toggles native macOS fullscreen

#### Custom Menu
- **Cmd+W** closes the active **tab** (not the window) via a custom Tauri menu
- Standard Edit menu (undo, redo, cut, copy, paste, select all)
- Window menu (minimize, maximize)

---

### Canvas

#### Drawing Tools

| Tool | Description |
|------|-------------|
| **Select** | Click to select, drag to move. Multi-select with click-drag on empty area |
| **Rectangle** | Draw axis-aligned rectangles |
| **Circle** | Draw perfect circles |
| **Triangle** | Draw triangles |
| **Line** | Draw straight lines; click multiple times to create a polyline, double-click to finish |
| **Arrow** | Lines with an arrowhead at the endpoint; supports multi-joint polylines |
| **Leader Line** | Multi-segment polyline with a bent elbow and arrowhead — ideal for callout annotations. Click to place joints, double-click to finish |
| **Text** | Add editable text boxes. Double-click any shape to add a label |
| **Prompt Text** | Special text element for AI-oriented prompts — visually distinct from regular text |

#### Leader Lines & Vertex Editing
- Leader lines are multi-segment polylines with an arrowhead, commonly used for annotation callouts
- After drawing, select a leader line (or any polyline/line) and **drag vertex handles** to reshape it
- **Double-click** on a segment to **add a new midpoint**
- **Double-click** on an existing vertex to **remove** it
- Vertex handles render as white circles with a blue border for easy identification

#### Colors
- **Stroke** (border) and **Fill** (background) modes — toggle between them in the toolbar
- 12-color palette: transparent, six grays (#666 to #fff), red, orange, yellow, green, blue, purple
- Select an object and click a color to update it in real-time

#### Images
- Click the **image insert** button to open a file dialog
- Supports PNG, JPG, JPEG, GIF, SVG, and WebP
- Images are auto-scaled to fit (max 400px width)
- Drag-and-drop positioning after insertion
- Right-click an image for a context menu with **Save Image As...** to export it via a native save dialog

#### Layer Management
Right-click any object to access layer controls:
- **Bring to Front** — move to the top of the z-order
- **Bring Forward** — move up one layer
- **Send Backwards** — move down one layer
- **Send to Back** — move to the bottom

#### Undo / Redo
- 50-level history stack
- Undo with the toolbar button or **Cmd+Z** (when canvas is focused)
- Redo with the toolbar button or **Cmd+Shift+Z**

#### Pan & Zoom
- Scroll or trackpad-drag to pan the canvas
- Pinch or trackpad-zoom to zoom in/out
- Toolbar buttons for zoom in (1.2x), zoom out, and reset to 100%
- Zoom level displayed as a percentage
- Zoom range: 25% to 500%
- Zooms toward the center of the viewport

#### Canvas Snapshots
- **Camera icon**: Capture only the canvas drawing area and insert it as an image on the canvas
- **Monitor icon**: Capture the entire application window (canvas + terminal) and insert it on the canvas
- Both use html2canvas at your device's pixel ratio for crisp output

#### Save & Load
- **Cmd+S**: Save the canvas to a `.canvas.json` file via a native save dialog
- **Cmd+O**: Load a previously saved `.canvas.json` file
- Files use fabric.js native JSON serialization — all shapes, positions, colors, and images are preserved

#### Clear Canvas
- Toolbar button with a confirmation prompt to delete all objects

---

### Canvas-to-Terminal Integration

The core feature that makes Canvas Terminal unique: your drawings become AI prompts.

#### Export to Terminal
1. Click the **Upload** button in the canvas toolbar
2. The canvas is rendered as a PNG snapshot at your display's pixel ratio
3. The snapshot is saved to `~/.cache/canvas-terminal/snapshot.png`
4. The file path is written directly to the active terminal's stdin using **bracketed paste mode**
5. The AI CLI tool receives the path and can read the image

This works with any CLI tool that accepts file paths or image inputs.

#### Import from Terminal
1. Click the **Download** button in the canvas toolbar
2. An instruction prompt is written to the terminal, asking the AI tool to write its output to a specific file
3. The button animates while waiting — the app polls the import file every 1.5 seconds (up to 5 minutes)
4. When the file appears, the app auto-detects the format and renders it on the canvas:

| Format | Rendering |
|--------|-----------|
| PNG / JPEG | Inserted directly as an image |
| SVG | Rasterized and inserted as an image |
| HTML | Body content extracted, styled, and rendered as an image |
| Markdown | Converted to styled HTML (headings, lists, code blocks, tables) and rendered |
| Plain text | Displayed as a monospace code block |

5. Click the animated button again to cancel waiting

#### Response Styling
Imported responses are rendered with a dark-themed style (600px width, 24px padding) using system fonts and Markdown-aware typography. Code blocks use SF Mono / Fira Code.

---

## Tech Stack

| Layer | Technology |
|-------|------------|
| Desktop framework | [Tauri v2](https://v2.tauri.app/) (Rust backend, native macOS webview) |
| Frontend | React 18 + TypeScript 5 |
| Terminal emulation | [xterm.js](https://xtermjs.org/) with WebGL rendering, search, fit, web-links, and Unicode addons |
| Canvas drawing | [Fabric.js 6](http://fabricjs.com/) |
| State management | [Zustand](https://github.com/pmndrs/zustand) |
| Build tool | [Vite](https://vitejs.dev/) |
| Styling | [Tailwind CSS](https://tailwindcss.com/) |
| Icons | [Lucide](https://lucide.dev/) |
| Markdown parsing | [Marked](https://marked.js.org/) |
| Window capture | [html2canvas](https://html2canvas.hertzen.com/) |

---

## Installation

### Build from Source

**Prerequisites:**
- [Rust](https://rustup.rs/) (1.70+)
- [Node.js](https://nodejs.org/) (18+)

```bash
# 1. Install Rust (if not installed)
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
source "$HOME/.cargo/env"

# 2. Install Tauri CLI
cargo install tauri-cli

# 3. Clone the repository
git clone https://github.com/yes506/canvas-terminal.git
cd canvas-terminal

# 4. Install dependencies
npm install

# 5. Build for production
cargo tauri build

# 6. Install the app
open src-tauri/target/release/bundle/dmg/Canvas\ Terminal_*.dmg
```

Drag **Canvas Terminal** to your Applications folder from the opened DMG.

### Development

```bash
npm install
cargo tauri dev    # Hot reload — frontend changes apply instantly
```

---

## Keyboard Shortcuts

### Terminal

| Shortcut | Action |
|----------|--------|
| Cmd+T | New tab |
| Cmd+W | Close active tab |
| Cmd+Z | Undo close tab (within 5 seconds) |
| Cmd+1 through Cmd+9 | Jump to tab by number |
| Cmd+Shift+[ | Previous tab |
| Cmd+Shift+] | Next tab |
| Cmd+D | Split pane vertically |
| Cmd+Shift+D | Split pane horizontally |
| Cmd+Opt+Arrow | Navigate between panes |
| Cmd+Shift+Enter | Maximize / restore pane |
| Cmd+C | Copy selected text |
| Cmd+V | Paste from clipboard |
| Cmd+F | Open find bar |
| Cmd+= / Cmd+- | Zoom font in / out |
| Cmd+0 | Reset font size |
| Cmd+Enter | Toggle fullscreen |

### Canvas

| Shortcut | Action |
|----------|--------|
| Cmd+S | Save canvas to file |
| Cmd+O | Open canvas from file |
| Cmd+Z | Undo |
| Cmd+Shift+Z | Redo |
| Cmd+A | Select all objects |
| Delete / Backspace | Delete selected object |
| Escape | Deselect or cancel current drawing |
| Enter | Finish polyline / leader line |
| Double-click shape | Add or edit label |
| Double-click segment | Add midpoint to polyline |
| Double-click vertex | Remove vertex from polyline |

---

## Security

Canvas Terminal restricts all file operations to your home directory and applies several safety measures:

- **Path validation**: All read/write paths are canonicalized and checked against `$HOME`
- **Symlink protection**: Files are opened with `O_NOFOLLOW`; symlink targets are validated
- **File size limits**: 100 MB for canvas JSON, 50 MB for binary files, 20 MB for images
- **Magic byte validation**: PNG and JPEG files are verified by header bytes before processing
- **Input size limit**: Terminal write operations are capped at 65 KB per call
- **SVG exclusion**: SVG files are not loaded as raw images to prevent XSS vectors
- **IME-aware input**: Korean, Japanese, and Chinese composition events are handled correctly to prevent double input

---

## Canvas File Format

Drawings are saved as `.canvas.json` files using fabric.js native JSON serialization. These files capture all shapes, positions, colors, images, polyline vertices, and layer order. You can share `.canvas.json` files between machines or version-control them alongside your projects.

---

## How It Works

```
+---------------------------+     +---------------------------+
|        Canvas Panel       |     |      Terminal Panel       |
|                           |     |                           |
|  Draw shapes, lines,      |     |  Full PTY shell (zsh)     |
|  leader lines, text,      |     |  Multiple tabs & panes    |
|  prompt text, images      |     |  AI CLI tools running     |
|                           |     |                           |
|  [Export to Terminal] ------>    |  Receives image path      |
|                           |     |  AI reads the image       |
|  <------ [Import from Terminal] |  AI writes response file  |
|  Renders response on      |     |                           |
|  canvas as styled image   |     |                           |
+---------------------------+     +---------------------------+
```

1. **Export**: Canvas is rendered as a PNG. The file path is pasted into the terminal via bracketed paste mode.
2. **AI processes**: The CLI tool (Claude Code, Gemini CLI, etc.) reads the image and generates a response.
3. **Import**: The response (text, Markdown, SVG, or image) is rendered back onto the canvas.

This creates a visual feedback loop between you, the canvas, and the AI.

---

## License

MIT
