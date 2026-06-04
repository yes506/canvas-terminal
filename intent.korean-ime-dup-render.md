# Intent — korean-ime-dup-render

## Mode

problem

## Persona

Canvas Terminal users on macOS who type Korean (Hangul) IME input in either the PTY terminal pane or the AI agent's built-in terminal in the collaborator pane; primary witness is the project maintainer, who hits this on every Korean word.

## Goal

For Canvas Terminal users typing Korean (Hangul) IME input, typed characters render in place without visual duplication or required arrow-key cleanup, in both the PTY terminal pane and the AI agent's built-in terminal.

## In-scope features

- Diagnose and fix the IME composition + buffer rendering interaction in the xterm.js + PTY pipeline used by Canvas Terminal, including the existing custom IME handling layer present in both terminal surfaces
- Cover both terminal surfaces (PTY pane + collaborator-pane built-in terminals); the planner must determine whether the fix lands as parallel changes on both surfaces or via a refactor to a shared helper, given that both surfaces already implement near-identical custom IME workaround code
- Ship the fix in a v0.5.x patch release (patch-release compatibility — version bump and release flow are separate work)

## Out-of-scope

- Japanese / Chinese IME functional support (user only uses Korean+English; explicitly deferred to a future intent — non-regression of these IMEs is covered separately as a constraint and success criterion)
- Non-macOS platforms (Linux / Windows untested; outside user's environment)

## Constraints

- Must ship as a v0.5.x patch — no breaking API changes, bounded scope
- No regression in non-IME typing latency or correctness
- Per current repro the buffer appears correct (arrow-key redraw resolves cleanly), but this is the user's inference, not a captured PTY/buffer transcript; the planner must empirically verify whether the bug surface is render-only (DOM/renderer reconciliation) or includes write-path duplication (e.g., compositionend → PTY → echo, or the deferred triggerDataEvent fragment) before committing to a fix strategy
- Avoid xterm.js major version bump or broad architectural refactor of the IME/keystroke handling layer. Patch-release compatibility (no breaking API changes) is the hard envelope, which by SemVer convention effectively rules out a major xterm.js bump in this patch. If empirical investigation shows the only viable fix requires breaking that envelope, escalate by re-opening this intent rather than silently bumping under the guise of refactor
- The fix must cover both terminal surfaces — the PTY terminal pane and the collaborator-pane built-in terminal. Landing changes on only one surface leaves half the bug present, because both surfaces currently carry parallel custom IME handling code

## Success criteria

- While typing "안녕하세요" character-by-character in the PTY terminal pane, each intermediate composition/commit state renders the current Korean text (committed + in-progress composing) exactly once with no duplicated prefix anywhere in the buffer; after the final syllable the visible line reads exactly 안녕하세요 without any arrow-key cleanup
- Same behavior in the AI agent's built-in terminal (collaborator pane) — each intermediate state renders the current Korean text exactly once, and the final commit reads exactly 안녕하세요 without arrow-key cleanup
- A longer phrase (e.g., "한국어 입력 테스트") composes to the final string exactly once, with no accumulating duplicate prefixes at any intermediate step, on both surfaces
- No regression in ASCII typing, paste, arrow keys, Ctrl+C / Ctrl+R, Tab completion, or shell history (↑/↓) on either surface
- Japanese / Chinese IME rendering not visibly worsened relative to the current pre-fix baseline — verification depth is a lightweight smoke check on code paths exercised by the Korean IME fix, not full functional parity testing with Korean

## Examples

- PTY terminal pane: typing the syllables of "안녕하세요" one keystroke at a time produces this visible sequence: ㅇ → 아 → 안 → 안ㄴ → 안 안녀 → 안 안녕 → 안녕 안녕하 하. Each commit step echoes the prior committed text at the start of the line while new composition continues, accumulating duplicate prefixes. Pressing → (arrow right) once collapses cleanly to "안녕하세요". Reproducible 100% of the time; happens on every Korean word.
- ⚠ **Note on the trace above**: it is the user's verbal-recall fingerprint of the bug shape elicited mid-conversation, not a literal frame-by-frame fixture. Notable known imprecisions: the transition `안 → 안ㄴ` skips the duplicate prefix that appears one step later as `안 안녀`, and the trailing fragment ends at `안녕 안녕하 하` rather than continuing through `세` and `요`. The planner must obtain a controlled keystroke-indexed trace covering the full string 안녕하세요 from first keystroke through final compositionend (per Open question on controlled repro) before using this fingerprint as an acceptance oracle.
- Same symptom in the AI agent's built-in terminal (collaborator pane) — same repro, same resolution via arrow-key redraw.

## Counter-examples

- ASCII / English typing regresses in latency or correctness — much larger blast radius than the IME bug; would affect every user on every keystroke
- Arrow keys, Ctrl+C, Ctrl+R, Tab completion, or shell history (↑/↓) stop working — core terminal UX; users would abandon the app
- Paste of Korean text from clipboard breaks — currently the only alternative input method; removing it leaves no path for Korean input
- Japanese / Chinese IME rendering made visibly worse than their *own current pre-fix baseline* (not measured against Korean's broken state) — expanding blast radius to other IMEs while "fixing" Korean is a net regression
- PTY stream / agent-visible buffer corrupted — agents reading PTY output rely on it being uncorrupted; verifying this requires capturing the actual PTY transcript mid-composition (the user's current claim of buffer correctness is an inference from arrow-key redraw behavior)

## Root-cause

1. Symptom: each composed Korean syllable visually echoes the previously-committed text at the start of the visible buffer while new composition continues, accumulating duplicate prefixes until an arrow-key triggered redraw reconciles. The user infers the buffer is correct and only rendering is wrong, but this inference is not yet empirically verified.
2. Why 1: unknown — the user hypothesizes (with stated uncertainty) the issue started after upgrading to macOS Tahoe 26.5.1, suggesting a possible macOS-level Cocoa IME / input-handling change interacting with xterm.js or with Canvas Terminal's existing custom IME handling layer. The hypothesis is unverified and must be tested empirically before driving the fix strategy.

## Open questions

- Did the bug truly start with macOS Tahoe 26.5.1? Possible falsification approaches (diagnostic avenues, not mandatory preconditions before fixing): (a) git-bisect Canvas Terminal across release tags (v0.4.x → v0.5.2) to localize the regression to a code change vs. an environment change; (b) load a minimal xterm.js demo in Safari (and, if feasible, in a minimal Tauri/WKWebView harness) to separate generic WebKit/xterm/macOS behavior from Canvas Terminal's custom IME path — Safari alone isolates upstream xterm/WebKit/macOS but is not equivalent to Tauri's WKWebView host environment, so a positive WKWebView-only signal still requires the Tauri harness; (c) if a non-Tahoe macOS host is reachable, repro there as a tiebreaker.
- Which root-cause hypothesis is correct: (a) xterm.js native IME composition overlay colliding with PTY echo of committed bytes, (b) missing row invalidation on `compositionupdate`, (c) a Canvas Terminal-specific duplicate write path in the keystroke handler (e.g., the existing custom IME shim), or (d) something else (e.g., a macOS Tahoe Cocoa input-handling change). Planner to verify empirically.
- Is the underlying PTY/terminal buffer actually correct (render-only bug), or does the duplicate also exist in the buffer/write path (and only happens to be visually overwritten by shell-side reprint on arrow-key redraw)? This must be empirically verified — e.g., by dumping terminal.buffer.active mid-composition or capturing the PTY transcript — before committing to a render-only vs. write-path fix.
- Japanese / Chinese IME current baseline rendering on macOS is untested. The planner must establish a lightweight baseline (smoke-only) sufficient to verify that the Korean fix does not visibly worsen these IMEs. **Bounds**: code-path inspection (confirming no JP/ZH-specific branch was touched by the Korean fix) is the floor; one manual smoke pass with a JP IME installed is the ceiling — the actual install/test scope is decided at plan time. Full functional support remains explicitly out of scope.
- The two affected terminal surfaces currently implement parallel custom IME handling. Should the fix be applied in lockstep to both, or refactored into a shared helper as part of this patch? The two surfaces also use different xterm.js renderers (one with the WebGL addon, the other intentionally without), which may force renderer-specific fix variants.
- The user-supplied repro trace (ㅇ → 아 → 안 → 안ㄴ → 안 안녀 → 안 안녕 → 안녕 안녕하 하) is a verbal recall, not a literal frame-by-frame capture. The planner should obtain a controlled, keystroke-indexed step-by-step trace **covering the full string 안녕하세요 from first keystroke through final compositionend** — a keystroke-numbered table with the exact visible buffer at each step, including any cursor/column hint — before committing to a specific render-vs-write-path fix hypothesis. Notable known imprecisions in the verbal trace (transition `안 → 안ㄴ` lacks the duplicated prefix that appears one step later as `안 안녀`; the trailing fragment ends mid-word at `안녕 안녕하 하`) should be specifically clarified by the controlled trace.

## Provenance

- Intent ID: 55333-82403-29710
- Revision: 1
- Confirmed at: 2026-06-04T15:44:34+09:00
- Language used during elicitation: English
- Peer-reviewed and refined (round 1): 2026-06-04T16:00:00+09:00 (folded convergent findings from @codex1/@claude2/@codex2/@claude3/@codex3 reviews; one reviewer claim — "Tahoe is invented" from @codex3 — was empirically rejected because the user did state the Tahoe 26.5.1 hypothesis during elicitation, though wording was softened to reflect stated uncertainty)
- Peer-reviewed and refined (round 2): 2026-06-04T16:20:00+09:00 (5 round-2 reviews unanimous-approve including @codex3 reversing the prior "Tahoe is invented" objection after seeing peer context; folded convergent precision items — Safari/WKWebView isolation wording (@codex2 + @codex3), JP/ZH counter-example baseline wording (@codex1), repro-trace ⚠ Note + Open Question tightening (@claude2 + @claude3), JP/ZH smoke-check floor/ceiling bounds (@claude2), constraint escape-hatch wording cleanup (@claude3), and "Falsification plan" → "Possible falsification approaches" framing (@codex1); rejected @claude3's Minor 1 claim that `.intent-state.json` was stale at review time — empirically verified the state file already carried post-round-1 wording when round-2 reviews were written)
