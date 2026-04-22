# YouTube Short Package

This folder contains a ready-to-record 9:16 short for Canvas Terminal.

## Files

- `youtube-short.html` — self-contained vertical motion graphic (1080x1920) for a 26-second promo
- `youtube-short.srt` — subtitle track aligned to the animation (9 cues)

## What it shows (5 scenes, ~5s each)

1. **Hero** — Canvas + Terminal split view with animated drawing and typing terminal lines
2. **Visual Feedback Loop** — 4-step flow diagram (Draw → Upload → AI Processes → Download)
3. **Multi-Agent Collaborator** — Three parallel agent terminals (@claude, @codex, @gemini) with @mention bar
4. **Terminal Power** — Tabs, WebGL, themes, IME support + tech stack pills
5. **CTA** — GitHub URL, tags (macOS / MIT / Tauri v2 / Open Source), star button

## Recording

1. Open `youtube-short.html` in Chrome.
2. Use a screen recorder set to 1080x1920 (9:16 vertical).
3. Record one full 26-second loop.
4. Add the `.srt` subtitles in your video editor or YouTube Studio.

## Design

- Dark background with animated aurora orbs, dot grid, scanline overlay, and vignette
- Gradient text accents (cyan → blue → violet)
- CSS-only animations — no JavaScript required
- Scene transitions: slide up in, slide up out with fade
- Bottom caption bar cycles in sync with scenes
- Loops every 26 seconds
