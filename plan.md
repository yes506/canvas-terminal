# Feature plan — korean-ime-textarea-rewrite

Status: plan v3.2 (5/5 reviewer convergence across 4 rounds; v3.2 folds @codex3's BLOCKING Cmd+V paste-suppression finding + @claude2/@claude3 minor non-blocking items). Implementer-facing canonical artifact.

## Goal

Eliminate the DMG-only Korean syllable duplication bug by replacing xterm.js's helper-textarea IME ownership with a transparent, cell-aligned HTML `<textarea>` mounted over the xterm screen — making the WKWebView CFRunLoop coalescing race that drives the bug structurally unreachable rather than window-tuned around. v0.5.6 (commit `c5d332c`) extended the safety-clear ceiling 40 → 250ms; the v0.5.6 implementer report explicitly queues this rewrite as the next iteration ("convert prefix-strip to claim-at-schedule discipline so it's race-free against the safety clear by construction, not by window-width tuning").

## In scope

- Transparent shadow `<textarea>` mounted as a sibling of `.xterm-screen`, cell-aligned to the cursor cell; owns composition events for Korean (and JP/ZH by extension — same path serves all IME locales).
- On `compositionend` / Enter / Escape / Tab during composition, the shadow textarea's committed value is sent directly to `write_to_pty`; terminator appended atomically when applicable (matches today's `onComposedFlush` contract).
- xterm's `.xterm-helper-textarea` becomes the input target only for non-composition input via synthesized events; never receives `compositionstart`, so `CompositionHelper._finalizeComposition → setTimeout(0) → triggerDataEvent` re-emit path is structurally unreachable.
- Three-branch KeyRouter:
  - **Branch A** (app-shortcut bubble): `shouldBubbleShortcut(e)` predicate returns true → no synthesize, no `preventDefault`, no `clearValue`. Original trusted event bubbles (Cmd+T opens tab, etc.).
  - **Branch B** (printable): `e.key.length === 1 && !ctrlKey && !metaKey && !altKey` (Shift allowed) → `terminal.input(e.key)` (public API; preserves `terminal.onData` so `lineBuffer` + `scrollToBottom` work). `preventDefault` + `clearValue`.
  - **Branch C** (terminal-owned special key): everything else → `synthesizeKeydown` (`helper.dispatchEvent(new KeyboardEvent('keydown', {...12 props}))`). `preventDefault` (critical for Tab — prevents focus shift) + `clearValue`.
- Paste routed via `terminal.paste(text)` (public API; bracketed-paste-aware).
- Live composition rendering via the existing overlay span (cell-aligned glyph painting reused).
- Focus state mirrored: `HelperTextareaIsolator.mirrorFocusState` synthesizes `FocusEvent('focus'/'blur')` on helper from shadow's actual focus state — drives xterm's `_handleTextAreaFocus`/`Blur` listeners at `Terminal.ts:467-468` (preserves `.focus` CSS class, `_onFocus`/`_onBlur` subscribers, DECSET 1004 `ESC[I/O` emission).
- Defensive helper `compositionstart` listener: capture-phase + `stopImmediatePropagation` + sync `shadow.focus()`. Preempts xterm's bubble-phase listener at `Terminal.ts:381` if helper ever leaks focus.
- Both call sites preserved: `terminalManager.ts` (PTY pane) and `AgentMiniTerminal.tsx` (collaborator sub-agent). `onComposedFlush(text, terminator)` contract preserved verbatim.
- JP/ZH non-regression: Node 10 fixture + 4-event ordering test dispatched against shadow textarea (uniform path for all IME locales).
- Deletions from `xtermImeShim.ts`: `triggerDataEvent` patch, `isCursorHidden` property swap, 250ms safety clear, multi-char prefix-strip dedup, `lastCompositionCommit`/`lastClearedCommit` state machine, A.3 `imeDebug` instrumentation.

## Out of scope

- Replacing xterm.js's renderer (canvas/WebGL); only input ownership moves. Scrollback, ANSI parsing, selection-drag, search, themes all stay xterm-owned.
- Generalizing to non-xterm terminal widgets (Collaborator InputPrompt is already a plain textarea; no change needed).
- The v0.5.6 A.6 interim claim-at-schedule fix (superseded by this rewrite; if both ship, the interim becomes redundant).
- Windows / Linux IME validation (bug + fix scoped to macOS WKWebView; other platforms unaffected).
- DevTools / source-map posture changes from `korean-ime-dmg-race` (orthogonal; that one-way-door stays open).
- The `canvasTerminal_imeDebug` localStorage flag (becomes dead after this rewrite — surface as follow-up cleanup, not in scope).

## Constraints

- macOS WKWebView (Tauri v2) is the target; behavior under Vite dev mode (Chromium) is secondary validation surface.
- Must not regress JP/ZH IME (Node 10 test fixture floor).
- Must not regress the `collaborator\r` in-app spawn intercept after Korean → IME-off → ASCII typing (`terminalManager.ts:374-392` path).
- Must not regress AgentMiniTerminal's `scrollToBottom`-on-input parity (Korean commit must snap viewport same as ASCII keystroke).
- xterm's selection-drag (mouse drag over `.xterm-screen` to highlight cells) must keep working — shadow textarea uses `pointer-events: none` by default so clicks reach xterm's selection layer.
- xterm's focus model must keep working — `Cmd+T` / `Cmd+W` / `Cmd+F` / `Cmd+E` / `Shift+Enter` (`CSI u`) shortcuts (call sites' `attachCustomKeyEventHandler`) still bubble; Branch A path preserves this.
- xterm's `.focus` CSS class + `_onFocus`/`_onBlur` events + DECSET 1004 `ESC[I/O` emission must keep working — `mirrorFocusState` preserves this.
- No changes to public Tauri commands (`write_to_pty`, `spawn_shell`, `resize_pty` signatures unchanged).
- Public API of `attachKoreanImeShim` is **additive only**: `AttachKoreanImeShimOptions` gains `shouldBubbleShortcut?: (e: KeyboardEvent) => boolean` (default: no bubble); `KoreanImeShimHandle` gains `isFocused(): boolean`. Existing callers unaffected; both fields backward-compatible.

## Success criteria

- DMG build (`npm run tauri:build` → installed `.dmg`) shows **zero Korean syllable duplication across 100+ commit cycles** in each prior-bug-class scenario:
  - `안녕` then commit (compositionend duplicate)
  - `안녕 ` (space mid-composition)
  - `안녕.` (period mid-composition)
  - `안녕←` (arrow mid-composition)
  - `안녕\r` (Enter mid-composition)
  - `안녕Tab` (Tab mid-composition)
- `vitest src/lib/xtermImeShim.test.ts src/lib/xtermShadowTextarea.test.ts`: rewritten test surface passes (target: structural invariants — commit fires once, JP/ZH unchanged, `onComposedFlush` contracts preserved — instead of timing-window tests). ~38-42 tests total.
- `npm run build` (both app + dashboard) and `cargo check src-tauri` pass.
- `collaborator\r` intercept fires after `"안녕<bs><bs>collaborator\r"` (Korean → backspace cleanup → ASCII command).
- Net code delta is a deletion: ≥ 800 LOC removed across shim + test layer combined.
- **DMG packaged manual smoke acceptance** (the only test that exercises real WKWebView CFRunLoop coalescing — happy-dom cannot reproduce this race): at least one cycle on real macOS DMG validates the structural fix against actual production timing.

## Open questions

None at confirmation time. v3.1 absorbed every architectural and contract-level concern from the 5-reviewer × 3-round convergence. Implementer-Phase-0 questions (e.g., exact `shouldBubbleShortcut` table per call site, happy-dom `FocusEvent` fallback assertion shape, mid-composition arrow behavior on shadow's transparent caret) are properly the implementer's call.

## Package layout

No new packages introduced — feature lives entirely in `src/lib/` (existing) and touches two existing call sites in `src/lib/terminalManager.ts` and `src/components/collaborator/AgentMiniTerminal.tsx`.

```
src/
├── lib/
│   ├── xtermImeShim.ts            (REWRITTEN — orchestrator, target ~370 LOC, was 916)
│   ├── xtermShadowTextarea.ts     (NEW — transparent textarea owner, target ~280 LOC)
│   ├── xtermImeShim.test.ts       (REWRITTEN — structural invariants, target ~950 LOC, was 1649)
│   ├── xtermShadowTextarea.test.ts (NEW — target ~150 LOC)
│   └── terminalManager.ts         (TOUCHED — shouldBubbleShortcut wiring + comment update, ~15 LOC)
└── components/
    └── collaborator/
        └── AgentMiniTerminal.tsx  (TOUCHED — focus mirror via imeHandle.isFocused proxy + shouldBubbleShortcut + comment update, ~27 LOC)
```

Dependency direction: `AgentMiniTerminal.tsx`, `terminalManager.ts` → `xtermImeShim.ts` → `xtermShadowTextarea.ts` → `@xterm/xterm` types.

Public API additions (additive only, backward compatible):

```ts
interface AttachKoreanImeShimOptions {
  sessionId: string;
  webgl?: boolean;
  defaultFontSize?: number;
  onComposedFlush?: (text: string, terminator: "\r" | "\x1b" | "\t" | null) => void;
  shouldBubbleShortcut?: (e: KeyboardEvent) => boolean;   // NEW v3.1
}

interface KoreanImeShimHandle {
  readonly overlayEl: HTMLElement | null;
  rebind(): void;
  dispose(): void;
  isFocused(): boolean;                                    // NEW v3.1
}
```

## Decomposition

6 interfaces / 22 nodes. Mermaid DAG at `plan.mmd`.

| # | Stage | Interface | Method | File |
|---|---|---|---|---|
| 1 | Wire all subsystems, return handle | `ImeShimOrchestrator` | `attach` (== `attachKoreanImeShim`) | `xtermImeShim.ts` |
| 2 | Re-anchor textarea + overlay on layout change | `ImeShimOrchestrator` | `rebind` | `xtermImeShim.ts` |
| 3 | Tear down + restore | `ImeShimOrchestrator` | `dispose` | `xtermImeShim.ts` |
| 4 | Mount transparent textarea sibling of `.xterm-screen`; focus it | `ShadowTextarea` | `mount` | `xtermShadowTextarea.ts` |
| 5 | Reposition over xterm cursor cell on advance | `ShadowTextarea` | `repositionToCursor` | `xtermShadowTextarea.ts` |
| 6 | Reset `.value` after every commit/cancel/blur/routed-keydown (prevents stale-value accumulation) | `ShadowTextarea` | `clearValue` | `xtermShadowTextarea.ts` |
| 7 | Remove DOM + detach listeners | `ShadowTextarea` | `dispose` | `xtermShadowTextarea.ts` |
| 8 | `compositionstart` → mark composing, begin overlay paint | `CompositionRouter` | `onCompositionStart` | `xtermImeShim.ts` |
| 9 | `compositionupdate` → repaint overlay from `event.data` (canonical, NOT `textarea.value`) | `CompositionRouter` | `onCompositionUpdate` | `xtermImeShim.ts` |
| 10 | `compositionend` → `write_to_pty(text)`, clear overlay, `onComposedFlush(text, null)`, `clearValue` | `CompositionRouter` | `onCompositionEnd` | `xtermImeShim.ts` |
| 11 | Enter/Esc/Tab during composition → `write_to_pty(text+terminator)`, `onComposedFlush(text, terminator)`, `clearValue` | `CompositionRouter` | `onTerminatingKey` | `xtermImeShim.ts` |
| 12 | Blur during composition → flush + clear + notify + `clearValue` | `CompositionRouter` | `onBlurDuringComposition` | `xtermImeShim.ts` |
| 13 | Printable (Branch B): `terminal.input(e.key)` + `preventDefault` + `clearValue` | `KeyRouter` | `routePrintable` | `xtermImeShim.ts` |
| 14 | Special/modifier (Branch C): `helper.dispatchEvent` with 12 props + `preventDefault` + `clearValue` | `KeyRouter` | `synthesizeKeydown` | `xtermImeShim.ts` |
| 15 | Paste (incl. `insertReplacementText`): `terminal.paste(text)` + `preventDefault` + `clearValue` | `KeyRouter` | `routePaste` | `xtermImeShim.ts` |
| 16 | Paint composition glyphs at cursor cell; add `ime-cursor-hidden` CSS class to xterm container | `CursorOverlay` | `show` | `xtermImeShim.ts` |
| 17 | Hide overlay; remove CSS class | `CursorOverlay` | `clear` | `xtermImeShim.ts` |
| 18 | Move overlay to new cell when xterm cursor advances | `CursorOverlay` | `reposition` | `xtermImeShim.ts` |
| 19 | React to font-size / theme changes | `CursorOverlay` | `updateStyle` | `xtermImeShim.ts` |
| 20 | Patch `helper.focus()` → `shadow.focus()` (focus redirect; no listener removal) | `HelperTextareaIsolator` | `installFocusRedirect` | `xtermImeShim.ts` |
| 21 | Synthesize `FocusEvent` on helper from shadow's actual focus/blur (drives xterm's focus listeners, `.focus` CSS, DECSET 1004) | `HelperTextareaIsolator` | `mirrorFocusState` | `xtermImeShim.ts` |
| 22 | Restore native `focus` method; unsubscribe focus mirror | `HelperTextareaIsolator` | `restoreNativeFocus` | `xtermImeShim.ts` |
| 23 | `copy` event on shadow → write `terminal.getSelection()` to clipboard (preserves xterm-selection copy with shadow always focused) | `KeyRouter` | `routeCopy` | `xtermImeShim.ts` |
| 24 | `cut` event on shadow → same as copy (terminal can't semantically cut) | `KeyRouter` | `routeCut` | `xtermImeShim.ts` |

Total: 6 interfaces / 24 nodes. KeyRouter holds 5 methods (`routePrintable`, `synthesizeKeydown`, `routePaste`, `routeCopy`, `routeCut`).

Cohesion check: each interface passes ≥2 of (state, lifecycle, collaboration boundary, failure domain). No god-interface (max 5 methods); no method-shaped class; no hidden orchestration in method bodies.

## KeyRouter classification rule (final, locked v3.2)

```typescript
function isNativePasteShortcut(e: KeyboardEvent): boolean {
  return (e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey
      && (e.key === 'v' || e.key === 'V');
}

function isNativeCopyOrCutShortcut(e: KeyboardEvent): boolean {
  if (!(e.metaKey || e.ctrlKey)) return false;
  if (e.shiftKey || e.altKey) return false;
  return e.key === 'c' || e.key === 'C' || e.key === 'x' || e.key === 'X';
}

function routeKey(e: KeyboardEvent) {
  if (e.isComposing || e.keyCode === 229) return;       // composition path on shadow

  // v3.2 fix: native edit shortcuts bypass — do NOT preventDefault, so the
  // browser's paste/copy/cut event still fires on the shadow textarea and
  // routes via routePaste / routeCopy / routeCut. Without this branch,
  // Branch C's preventDefault on Cmd+V can suppress the paste event in
  // some browser environments (spec is loose; behavior differs across
  // Chromium/WebKit/Tauri WKWebView versions).
  if (isNativePasteShortcut(e) || isNativeCopyOrCutShortcut(e)) return;

  if (options.shouldBubbleShortcut?.(e)) return;        // Branch A: app-shortcut bubble

  if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
    routePrintable(e.key);                              // Branch B: Shift allowed
    e.preventDefault();
    shadow.clearValue();
    return;
  }

  synthesizeKeydown(e);                                  // Branch C: special/modifier
  e.preventDefault();                                    // critical for Tab — prevents focus shift
  shadow.clearValue();
}
```

### Clipboard event handlers (KeyRouter additions)

```typescript
// shadow 'copy' event — Cmd+C arrives via Native-edit-shortcut bypass above
function routeCopy(e: ClipboardEvent) {
  const sel = terminal.getSelection();   // xterm public API
  if (sel) {
    e.clipboardData?.setData('text/plain', sel);
    e.preventDefault();   // we wrote the data; suppress native copy of shadow.value (empty)
  }
  // else: let native copy fire (no-op — shadow has no selection)
}

// shadow 'cut' event — same as copy; terminal can't semantically cut
function routeCut(e: ClipboardEvent) { routeCopy(e); }
```

**Why this matters**: today xterm syncs the terminal selection into `helper.value` at `Terminal.ts:530-534` and Cmd+C on helper copies that. With shadow always focused, browser's Cmd+C would copy `shadow.value` (empty) — regression vs today. The `routeCopy` handler supplies `terminal.getSelection()` to the clipboard directly, preserving the user-visible behavior.

### `synthesizeKeydown` fidelity rule

The synthetic `KeyboardEvent('keydown', init)` MUST copy these 12 properties verbatim from the source shadow event so xterm's `evaluateKeyboardEvent` and the call sites' `attachCustomKeyEventHandler` see the same input as today:

```
key, code, keyCode, which, shiftKey, ctrlKey, altKey, metaKey, location, repeat,
bubbles: true, cancelable: true, composed: true
```

Missing any of `key/code/keyCode/modifier flags` silently breaks xterm's keymap.

### `clearValue` cadence

| Branch | When `clearValue` runs |
|---|---|
| Composition (any path) | Inside `CompositionRouter.onCompositionEnd / onTerminatingKey / onBlurDuringComposition` |
| Branch A (bubble) | Skipped — original event bubbles natively; no shadow mutation expected |
| Branch B (printable) | Immediately after `terminal.input(e.key)` and `preventDefault()` |
| Branch C (terminal-owned) | Immediately after `synthesizeKeydown(e)` + `preventDefault()` (defensive backstop) |
| Native-edit-shortcut bypass (Cmd+V/C/X) | Skipped — original event bubbles natively to fire paste/copy/cut events |
| `routePaste` | Immediately after `terminal.paste(text)` + `preventDefault()` |
| `routeCopy` / `routeCut` | Skipped — these write to clipboard, not to shadow.value (which stays empty) |

## Interfaces emitted

N/A (Phase 5 skipped — `emit skeletons` token not typed at decomposition confirmation). Interface signatures captured in this plan.md as the implementer-facing contract.

## Validation

Phase 7 smoke-check (skeletons-skipped):
- `plan.md` non-empty ✅ (this file)
- `plan.md` contains required headers: `## Goal` ✅, `## Package layout` ✅, `## Decomposition` ✅
- `plan.mmd` parses as valid Mermaid (first line `flowchart`) ✅

`tsc --noEmit` compile target N/A at this phase (no skeletons to compile). Run by the implementer after Phase 1 of the implementer skill at the worktree root.

## Risks

- **R1** — `compositionupdate.data` timing on shadow under WKWebView. Verify same DOM contract holds; fallback: snapshot `textarea.value` at `requestAnimationFrame`.
- **R2** — happy-dom composition + FocusEvent support may be incomplete. Tests synthesize events directly; if happy-dom doesn't fire listeners reliably, switch IME suite to jsdom OR fall back to behavioral assertion. Recommended order: (1) spy on `_handleTextAreaFocus`/`_handleTextAreaBlur` via xterm internals to verify the synthesized FocusEvent reached them; (2) if spy isn't viable, assert `terminal.element.classList.contains('focus')` as a behavioral proxy.
- **R3** — synthesize fidelity drift on future xterm versions (e.g., new `isTrusted` gate, new event prop read). Mitigation: (a) pin `@xterm/xterm` version exactly in `package.json` (no `^` range); (b) add a vitest "xterm anchor probe" test that asserts the four load-bearing source-level facts the rewrite depends on — `Terminal.ts:379` keydown binding on helper, `Terminal.ts:1046` early-return on `!result.key`, `Terminal.ts:467-468` focus/blur on helper, `Terminal.ts:381` compositionstart on helper. Test fails loudly on xterm upgrade if any anchor moves.
- **R4** — Focus model: `terminal.focus()` → patched `helper.focus()` → `shadow.focus()`. Confirmed end-to-end.
- **R5** — `AgentMiniTerminal` focus-state proxy needed at TWO touchpoints: the visual focus border (`setFocused`) AND the `writeWithFollowBottom` `document.activeElement === terminal.textarea` check. Both updated via `imeHandle.isFocused()` proxy.
- **R6** — `pointer-events` arbitration on `.xterm-screen` for mouse selection drag and wheel/touchpad scroll. Shadow uses `pointer-events: none` by default + `overflow: hidden`; wheel events bubble naturally to `.xterm-viewport`.
- **R7** — Synthesized event default action: xterm doesn't depend on it (computes from props directly). Verified across representative key set.
- **R8** — Helper retains xterm's bound listeners (we can't remove them — bound via private `register()` at `Terminal.ts:379`). Defense-in-depth via capture-phase `compositionstart` listener on helper with `stopImmediatePropagation` + sync `shadow.focus()`.
- **R-NEW-4** — Paste during `_keyDownSeen=true`: `terminal.paste()` goes via `coreService.triggerDataEvent` directly (bypasses `_inputEvent`), no intersection. Test guards it.
- **R-NEW-5** — Cmd+V keydown could suppress browser's paste action if `preventDefault` is called. v3.2 fix: explicit `isNativePasteShortcut` bypass in `routeKey` ensures the original Cmd+V keydown is NOT `preventDefault`-ed; the browser fires the `paste` event normally, which `routePaste` handles. Test guards it.
- **R-NEW-6** — Single rule for non-keydown text input: `beforeinput` event handler routes `inputType === 'insertReplacementText'` (autocomplete/dictation) via `terminal.paste(data)` and `inputType === 'insertText'` when no keydown was handled in the current tick (emoji palette / IME-less typed text) via `terminal.input(data)`. Implementer tracks the "keydown handled this tick" flag with a microtask-cleared bool. Documented in `routePaste` / `routePrintable` docstrings.
- **R-NEW-7** — Copy/cut with shadow always focused: browser's Cmd+C copies `shadow.value` (empty), regressing vs today's xterm `Terminal.ts:530-534` selection-to-helper.value sync. v3.2 fix: `routeCopy` listener supplies `terminal.getSelection()` to clipboard directly. `routeCut` mirrors. Test: mouse-select on `.xterm-screen` → Cmd+C → clipboard contains the selection.

## Test plan

Total: ~38-42 tests across `xtermImeShim.test.ts` (~950 LOC, was 1649) + `xtermShadowTextarea.test.ts` (NEW ~150 LOC).

KEPT clusters:
- `attach` (3 cases: `.xterm-screen` present, container fallback, degraded mode) + `rebind` retry
- `onComposedFlush` emission (4 paths: compositionend / blur / Enter / Esc / Tab) — contract preserved verbatim
- JP/ZH non-regression (Node 10 fixture + 4-event ordering) — dispatched against shadow textarea
- `dispose` restoration (subset: overlay removed, focus restored, listeners gone)
- T1-T4 case-d (compose → period/arrow/modifier-arrow) — reframed as "exactly one `write_to_pty` observed"
- Multi-char prefix-strip family — reframed as ONE structural test: "no late re-emit duplicate across coalesced-timing scenarios"

INVALIDATED clusters (deleted):
- variant (b) `imeStartPos` anchoring
- Korean defer (20ms single-codepoint)
- T5-T8 dedup token lifetime
- A.3 instrumentation (strip-hit / strip-miss)

NEW clusters:
- Shadow textarea lifecycle (mount / repositionToCursor / clearValue / dispose)
- Focus invariant (`document.activeElement === shadow.textareaEl` after attach; `helper.focus()` redirects to shadow)
- `routePrintable`: `a`, `A`, `!`, ` ` (space), non-ASCII single-char
- `synthesizeKeydown` CSI encoding: ArrowLeft → `\x1b[D`, DECCKM-flipped → `\x1bOD`, Ctrl+C → `\x03`, Backspace → `\x7f`, Shift+Enter → `\x1b[13;2u` via call-site custom handler
- Branch A: Cmd+T `shouldBubbleShortcut` returns true; original bubbles; PTY receives nothing; document focus state unchanged
- **Branch C `preventDefault` acceptance** (v3.1 fix): Tab on shadow does NOT move browser focus (`document.activeElement` stays on shadow); Enter on shadow → shadow.value empty post-route; Ctrl+A on shadow → no select-all visual artifact
- **Cmd+V**: `isNativePasteShortcut` returns true → routeKey returns early (no synth, no preventDefault) → browser fires `paste` event → `routePaste` → `terminal.paste(text)` called once; no `v` written to PTY (v3.2 BLOCKING fix)
- Paste during `_keyDownSeen=true` → exactly one PTY write (bracketed `\x1b[200~...\x1b[201~` or plain per mode)
- **Cmd+C with terminal mouse-selection**: mouse-select on `.xterm-screen` → Cmd+C on shadow → `routeCopy` writes `terminal.getSelection()` to clipboard via `e.clipboardData.setData('text/plain', sel)`; clipboard content matches the selected text (v3.2 BLOCKING fix for copy regression)
- **Cmd+C with no selection**: `routeCopy` early-exits; native copy fires on shadow.value (empty) — no-op, no error
- **Cmd+X**: `routeCut` mirrors `routeCopy`; clipboard contains selection; terminal buffer unchanged (terminal can't semantically cut)
- Focus mirror: `shadow.focus()` → `terminal.element.classList.contains('focus')` === true
- DECSET 1004: `terminal.write('\x1b[?1004h')` then `shadow.focus()` → onData fires `\x1b[I`
- Defensive helper `compositionstart`: dispatched on helper → capture-phase listener fires `stopImmediatePropagation` + shadow re-focused; xterm's `_compositionHelper.compositionstart` NOT called
- emoji via `beforeinput` `insertText` (no preceding keydown) → `terminal.input(data)`; single PTY write
- autocomplete/dictation via `beforeinput` `insertReplacementText` → `terminal.paste(data)`; single PTY write
- collaborator\r intercept after Korean: `안녕<bs><bs>collaborator\r` triggers `openCollaboratorSplit`
- Wheel/touchpad scroll passthrough: wheel event on shadow does not eat xterm viewport scroll
- Mid-composition Tab: composition state preserved, no focus shift

## LOC budget summary

| File | Before | v3.1 target | Delta |
|---|---|---|---|
| `xtermImeShim.ts` | 916 | ~370 | −546 |
| `xtermShadowTextarea.ts` | 0 | ~280 | +280 |
| `xtermImeShim.test.ts` | 1649 | ~950 | −699 |
| `xtermShadowTextarea.test.ts` | 0 | ~150 | +150 |
| `terminalManager.ts` | 490 | ~505 | +15 |
| `AgentMiniTerminal.tsx` | 921 | ~948 | +27 |

Net shim+test reduction: ~815 LOC. Plan meets the "net deletion" success criterion.

## Review history

- **Round 1 (v1)**: 5/5 REQUEST CHANGES on input-ownership contradiction. v1's "shadow = sole input sink with `triggerDataEvent` bypass" would have required 150-250 LOC of `_keyDown` reimplementation. Reviewers: @codex1, @codex2, @codex3, @claude2, @claude3.
- **Round 2 (v2)**: shifted to "shadow = focus owner; helper = keymap owner via synthesized keydowns". 4/5 confirmable; @claude3 surfaced blocker unique to v2's mechanism (synthesized keydown alone doesn't reach PTY for printable ASCII — `_keyDown` bails at `!result.key`).
- **Round 3 (v3)**: added `routePrintable` via `terminal.input()` public API + `mirrorFocusState` for focus mirror + locked defensive `compositionstart` to capture-phase. @claude2 + @codex2 surfaced blocker (no `preventDefault` for synthesize breaks Tab → focus loss). @claude3 surfaced process issue (artifact is summary, not full plan).
- **Round 4 (v3.1)**: three-branch classifier with explicit `preventDefault` discipline; `shouldBubbleShortcut` predicate added to `AttachKoreanImeShimOptions`; full plan persisted to `plan.md` per CLAUDE.md `(plan-feature, human-confirmed)` contract. 4/5 reviewers APPROVE.
- **Round 5 (v3.2, locked)**: @codex3 surfaced BLOCKING Cmd+V paste-suppression defect (Branch C `preventDefault` on Cmd+V keydown can suppress browser's paste event in some environments). Added `isNativePasteShortcut`/`isNativeCopyOrCutShortcut` bypass before Branch C. Added `routeCopy`/`routeCut` to KeyRouter (5 methods total) to preserve Cmd+C of terminal-selection (today's helper-value sync at `Terminal.ts:530-534`). Resolved emoji/`beforeinput` rule ambiguity. Added R-NEW-4/R-NEW-7. R-NEW-3 mitigation specified (version pin + anchor probe). 5/5 reviewers expected to APPROVE.

## References to existing code

- Bug context: `src/lib/xtermImeShim.ts:300-916` (current 916-LOC shim — full rewrite target)
- Call site 1: `src/lib/terminalManager.ts:352-366` (`attachKoreanImeShim` invocation + `onComposedFlush` lineBuffer reset on `\r`)
- Call site 2: `src/components/collaborator/AgentMiniTerminal.tsx:458-465` (`attachKoreanImeShim` invocation + `onComposedFlush` `scrollToBottom`)
- xterm public API: `node_modules/@xterm/xterm/src/common/CoreTerminal.ts:171` (`terminal.input(data)`)
- xterm public API: `node_modules/@xterm/xterm/src/browser/Terminal.ts:890` (`terminal.paste(text)`)
- xterm keymap binding: `node_modules/@xterm/xterm/src/browser/Terminal.ts:379` (`_keyDown` listener on helper)
- xterm focus bindings: `node_modules/@xterm/xterm/src/browser/Terminal.ts:467-468` (focus/blur listeners on helper)
- xterm composition binding: `node_modules/@xterm/xterm/src/browser/Terminal.ts:381` (`compositionstart` listener on helper — defensive intercept target)
- Reference for the pattern this rewrite mirrors: `src/components/collaborator/InputPrompt.tsx:363-395` (plain HTML textarea owning Korean composition)
- v0.5.6 implementer report queuing this rewrite: `implementation-report.md:73` ("Out-of-scope follow-up (plan-v3 A.6): convert multi-char prefix-strip to claim-at-schedule discipline...").
