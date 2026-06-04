# Intent — korean-ime-dup-render

## Mode

problem

## Persona

Canvas Terminal users on macOS who type Korean (Hangul) IME input in either the PTY terminal pane or the AI agent's built-in terminal in the collaborator pane; primary witness is the project maintainer, who hits this on every Korean word.

## Goal

For Canvas Terminal users typing Korean (Hangul) IME input, typed characters render in place without visual duplication or required arrow-key cleanup, in both the PTY terminal pane and the AI agent's built-in terminal.

## In-scope features

- Diagnose and fix the IME composition + buffer rendering interaction in the xterm.js + PTY pipeline used by Canvas Terminal
- Cover both terminal surfaces (PTY pane + collaborator-pane built-in terminals)
- Ship the fix in a v0.5.x patch release

## Out-of-scope

- Japanese / Chinese IME (user only uses Korean+English; explicitly deferred to a future intent)
- Non-macOS platforms (Linux / Windows untested; outside user's environment)
- xterm.js major version bump or architectural refactor (must fit within a patch release)

## Constraints

- Must ship as a v0.5.x patch — no breaking API changes, bounded scope
- No regression in non-IME typing latency or correctness
- Buffer correctness must be preserved (PTY stream is already correct per user repro; only rendering is broken)

## Success criteria

- Typing "안녕하세요" character-by-character in the PTY terminal pane displays exactly 안녕하세요 at every composition step — no duplicate prefix anywhere in the buffer, no required arrow-key cleanup
- Same in the AI agent's built-in terminal (collaborator pane)
- Longer phrase ("한국어 입력 테스트") renders cleanly with no accumulating duplicates
- No regression in ASCII typing, paste, arrow keys, Ctrl+C/R, Tab completion, or shell history
- Japanese / Chinese IME rendering not visibly worsened (even if not improved)

## Examples

- PTY terminal pane: typing the syllables of "안녕하세요" one keystroke at a time produces this visible sequence: ㅇ → 아 → 안 → 안ㄴ → 안 안녀 → 안 안녕 → 안녕 안녕하 하. Each commit step echoes the prior committed text at the start of the line while new composition continues, accumulating duplicate prefixes. Pressing → (arrow right) once collapses cleanly to "안녕하세요". Reproducible 100% of the time; happens on every Korean word.
- Same symptom in the AI agent's built-in terminal (collaborator pane) — same repro, same resolution.

## Counter-examples

- ASCII / English typing regresses in latency or correctness — much larger blast radius than the IME bug; would affect every user on every keystroke
- Arrow keys, Ctrl+C, Ctrl+R, Tab completion, or shell history (↑/↓) stop working — core terminal UX; users would abandon the app
- Paste of Korean text from clipboard breaks — currently the only alternative input method; removing it leaves no path for Korean input
- Japanese / Chinese IME made worse than current Korean state — expanding blast radius to other IMEs while "fixing" Korean is a net regression
- PTY stream / agent-visible buffer corrupted — buffer was already correct per user repro; agents reading PTY output rely on it

## Root-cause

1. Symptom: each composed Korean syllable visually echoes the previously-committed text at the start of the visible buffer while new composition continues, accumulating duplicate prefixes until an arrow-key triggered redraw reconciles. Buffer is correct; only rendering is wrong.
2. Why 1: unknown — user reports the issue started after upgrading to macOS Tahoe 26.5.1, suggesting a possible macOS-level Cocoa IME / input-handling change interacting with xterm.js. Planner to investigate empirically.

## Open questions

- Did the bug truly start with macOS Tahoe 26.5.1? Verifiable by testing on an older macOS (15 Sequoia or earlier).
- Which root-cause hypothesis is correct: (a) xterm.js native IME composition overlay colliding with PTY echo of committed bytes, (b) missing row invalidation on `compositionupdate`, (c) a Canvas Terminal-specific duplicate write path in the keystroke handler, or (d) something else (e.g., a macOS Tahoe Cocoa input-handling change) — planner to verify empirically.

## Provenance

- Intent ID: 55333-82403-29710
- Revision: 1
- Confirmed at: 2026-06-04T15:44:34+09:00
- Language used during elicitation: English
