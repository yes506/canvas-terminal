# Feature plan — korean-ime-textarea-rewrite

Status: plan v3.4 (5/5 reviewer convergence across 6 rounds; v3.4 folds the convergent v3.3 BLOCKING — @codex1/@codex2/@codex3/@claude3 all flagged that Node 15 + clearValue cadence table still said `terminal.paste(text)` despite v3.3's prose locking Option A. v3.4 splits Node 15 into `routePaste` (ClipboardEvent — preventDefault only) + new node 15b `routeBeforeInputReplace` (autocorrect/dictation — `terminal.paste(data)` because no xterm bubble path) so the canonical artifact no longer self-contradicts). Implementer-facing canonical artifact.

## Goal

Eliminate the DMG-only Korean syllable duplication bug by replacing xterm.js's helper-textarea IME ownership with a transparent, cell-aligned HTML `<textarea>` mounted over the xterm screen — making the WKWebView CFRunLoop coalescing race that drives the bug structurally unreachable rather than window-tuned around. v0.5.6 (commit `c5d332c`) extended the safety-clear ceiling 40 → 250ms; the v0.5.6 implementer report explicitly queues this rewrite as the next iteration ("convert prefix-strip to claim-at-schedule discipline so it's race-free against the safety clear by construction, not by window-width tuning").

## In scope

- Transparent shadow `<textarea>` mounted as a sibling of `.xterm-screen`, cell-aligned to the cursor cell; owns composition events for Korean (and JP/ZH by extension — same path serves all IME locales).
- On `compositionend` / Enter / Escape / Tab during composition, the shadow textarea's committed value is sent directly to `write_to_pty`; terminator appended atomically when applicable (matches today's `onComposedFlush` contract).
- xterm's `.xterm-helper-textarea` becomes the input target only for non-composition input via synthesized events; never receives `compositionstart`, so `CompositionHelper._finalizeComposition → setTimeout(0) → triggerDataEvent` re-emit path is structurally unreachable.
- KeyRouter classification: native edit shortcut bypass + three branches.
  - **Native edit shortcuts** (Cmd+V/C/X — macOS only, `metaKey && !ctrlKey && !shift && !alt`): no synthesize, no `preventDefault`. Browser fires `paste`/`copy`/`cut` events on shadow → routed via `routePaste`/`routeCopy`/`routeCut`. Ctrl+V/C/X are NOT in this bypass — they're terminal control chars.
  - **Branch A** (app-shortcut bubble): `shouldBubbleShortcut(e)` predicate returns true → no synthesize, no `preventDefault`, no `clearValue`. Original trusted event bubbles (Cmd+T opens tab, etc.).
  - **Branch B** (printable): `e.key.length === 1 && !ctrlKey && !metaKey && !altKey` (Shift allowed) → `terminal.input(e.key)` (public API; preserves `terminal.onData` so `lineBuffer` + `scrollToBottom` work). `preventDefault` + `clearValue`.
  - **Branch C** (terminal-owned special key): everything else (incl. Ctrl-letters which xterm encodes as C0 controls) → `synthesizeKeydown` (`helper.dispatchEvent(new KeyboardEvent('keydown', {...12 props}))`). `preventDefault` (critical for Tab — prevents focus shift) + `clearValue`.
- Paste delegated to xterm's existing `this.element` paste listener via bubble (v3.3 fix: `routePaste` only calls `preventDefault` on shadow; xterm's `pasteHandlerWrapper` does the PTY write via `handlePasteEvent`).
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

None at confirmation time. v3.3 absorbed every architectural and contract-level concern from the 5-reviewer × 5-round convergence. Implementer-Phase-0 questions (e.g., exact `shouldBubbleShortcut` table per call site, happy-dom `FocusEvent` fallback assertion shape, mid-composition arrow behavior on shadow's transparent caret, whether to make `routePaste` Option A or Option B — Option A locked in v3.3) are properly the implementer's call.

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

6 interfaces / 24 nodes (KeyRouter holds 5 methods after v3.2's `routeCopy`/`routeCut` additions). Mermaid DAG at `plan.mmd`.

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
| 15 | `ClipboardEvent('paste')` on shadow (Cmd+V via native edit shortcut bypass): `preventDefault` + `clearValue` ONLY. Event bubbles to xterm's `this.element` paste listener which calls `handlePasteEvent` → `paste()` → `triggerDataEvent` (single PTY write). Must NOT call `terminal.paste(text)` (would double-fire — see R-NEW-8). Must NOT call `stopPropagation` (would block xterm's listener — no PTY write at all). | `KeyRouter` | `routePaste` | `xtermImeShim.ts` |
| 15b | `InputEvent('beforeinput')` with `inputType === 'insertReplacementText'` (autocorrect / dictation): `e.preventDefault()` + `terminal.paste(data)` + `clearValue`. xterm has NO `beforeinput` listener at `this.element`, so no bubble path — shadow MUST own the PTY write here. Distinct from Node 15 because the bubble topology differs. | `KeyRouter` | `routeBeforeInputReplace` | `xtermImeShim.ts` |
| 16 | Paint composition glyphs at cursor cell; add `ime-cursor-hidden` CSS class to xterm container | `CursorOverlay` | `show` | `xtermImeShim.ts` |
| 17 | Hide overlay; remove CSS class | `CursorOverlay` | `clear` | `xtermImeShim.ts` |
| 18 | Move overlay to new cell when xterm cursor advances | `CursorOverlay` | `reposition` | `xtermImeShim.ts` |
| 19 | React to font-size / theme changes | `CursorOverlay` | `updateStyle` | `xtermImeShim.ts` |
| 20 | Patch `helper.focus()` → `shadow.focus()` (focus redirect; no listener removal) | `HelperTextareaIsolator` | `installFocusRedirect` | `xtermImeShim.ts` |
| 21 | Synthesize `FocusEvent` on helper from shadow's actual focus/blur (drives xterm's focus listeners, `.focus` CSS, DECSET 1004) | `HelperTextareaIsolator` | `mirrorFocusState` | `xtermImeShim.ts` |
| 22 | Restore native `focus` method; unsubscribe focus mirror | `HelperTextareaIsolator` | `restoreNativeFocus` | `xtermImeShim.ts` |
| 23 | `copy` event on shadow → write `terminal.getSelection()` to clipboard (preserves xterm-selection copy with shadow always focused) | `KeyRouter` | `routeCopy` | `xtermImeShim.ts` |
| 24 | `cut` event on shadow → same as copy (terminal can't semantically cut) | `KeyRouter` | `routeCut` | `xtermImeShim.ts` |

Total: 6 interfaces / 25 nodes. KeyRouter holds 6 methods (`routePrintable`, `synthesizeKeydown`, `routePaste`, `routeBeforeInputReplace`, `routeCopy`, `routeCut`).

Cohesion check: each interface passes ≥2 of (state, lifecycle, collaboration boundary, failure domain). No god-interface (max 5 methods); no method-shaped class; no hidden orchestration in method bodies.

## KeyRouter classification rule (final, locked v3.2)

```typescript
// v3.3 fix (@codex1 BLOCKING): macOS-only `metaKey && !ctrlKey`. Ctrl+V/C/X
// are TERMINAL CONTROL CHARS (SYN/ETX/CAN) and must reach PTY via Branch C
// → xterm `_keyDown` → `evaluateKeyboardEvent` encoding. Only Cmd-prefixed
// (no Ctrl, no Shift, no Alt) are macOS clipboard shortcuts.
function isNativePasteShortcut(e: KeyboardEvent): boolean {
  return e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey
      && (e.key === 'v' || e.key === 'V');
}

function isNativeCopyOrCutShortcut(e: KeyboardEvent): boolean {
  if (!e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return false;
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

### Clipboard event handlers (KeyRouter additions) — v3.3 revised

**Critical bubble-phase topology** (v3.3 finding from @claude3):

Shadow textarea is mounted as a sibling of `.xterm-screen` → both inside `.xterm-viewport` → inside `terminal.element`. Clipboard events on shadow **bubble to xterm's existing `this.element` listeners** at `Terminal.ts:334-344`:

```ts
// Terminal.ts:334-341 (copy listener bound on this.element — fires for bubble from shadow):
addDisposableDomListener(this.element!, 'copy', (event) => {
  if (!this.hasSelection()) return;
  copyHandler(event, this._selectionService!);  // Clipboard.ts:32-37: setData + preventDefault
});

// Terminal.ts:342-344 (paste listener on BOTH textarea AND this.element):
const pasteHandlerWrapper = (event) => handlePasteEvent(event, this.textarea!, ...);
addDisposableDomListener(this.textarea!, 'paste', pasteHandlerWrapper);
addDisposableDomListener(this.element!, 'paste', pasteHandlerWrapper);
//                                                  ^^^^^^^^^^^^^^ shadow's paste bubbles HERE
```

```typescript
// v3.3 fix (@claude3 BLOCKING): routePaste must NOT call terminal.paste itself.
// Shadow's paste event bubbles to `this.element` where xterm's pasteHandlerWrapper
// runs `handlePasteEvent` → `paste()` → `triggerDataEvent` → PTY write.
// If routePaste also calls `terminal.paste(text)`, the PTY receives TWO writes
// (bracketed-paste appears as `\x1b[200~TEXT\x1b[201~\x1b[200~TEXT\x1b[201~`).
// Option A locked: routePaste only suppresses native shadow.value mutation;
// xterm's element-level handler does the actual PTY write via bubble.
function routePaste(e: ClipboardEvent) {
  e.preventDefault();         // suppress native paste-into-shadow.value
  // do NOT call terminal.paste(text) — xterm's this.element listener handles it via bubble
  shadow.clearValue();        // defensive: clear any pre-event residue
}

// v3.3 (@claude3 + @claude2): routeCopy/routeCut are DEFENSE-IN-DEPTH, not load-bearing.
// xterm's existing `this.element` 'copy' listener (Terminal.ts:334-341) catches the
// shadow's bubbling copy event and calls `copyHandler` which writes selectionText
// + preventDefault. So Cmd+C ALREADY works without routeCopy. We keep routeCopy as
// a redundant write — same data, same target — so the contract survives if xterm
// rebinds 'copy' to the helper textarea in a future version.
// IMPORTANT: do NOT call stopPropagation — letting bubble proceed to xterm's
// handler is exactly the defense-in-depth: if our handler somehow fails, xterm's
// still fires.
function routeCopy(e: ClipboardEvent) {
  const sel = terminal.getSelection();
  if (sel) {
    e.clipboardData?.setData('text/plain', sel);
    e.preventDefault();   // suppress native copy of (empty) shadow.value
  }
  // else: let native copy fire on shadow.value (empty — no-op). Bubble continues
  // regardless; xterm's this.element handler will see no selection and skip.
}

function routeCut(e: ClipboardEvent) { routeCopy(e); }  // terminal can't semantically cut
```

**Corrected rationale**: today xterm's Cmd+C path lives at `Terminal.ts:334-341` (`addDisposableDomListener(this.element!, 'copy', ...)` → `copyHandler`), NOT at `Terminal.ts:530-534` (which is the Linux middle-click selection-to-helper.value path — irrelevant on macOS). The bubble-phase topology means xterm's element-level handler already catches the shadow's copy event, so `routeCopy`/`routeCut` are redundant — but the redundancy is harmless (same `selectionText` written twice; second write idempotently overwrites) and serves as defense-in-depth against future xterm internal rebinding.

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
| `routePaste` (ClipboardEvent paste, Cmd+V) | Immediately after `preventDefault()`; NO `terminal.paste(text)` call — xterm's `this.element` paste listener owns the PTY write via bubble |
| `routeBeforeInputReplace` (autocorrect/dictation) | Immediately after `terminal.paste(data)` + `preventDefault()`; shadow OWNS the PTY write (no xterm bubble path for `beforeinput`) |
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
- **R3** — synthesize fidelity drift on future xterm versions (e.g., new `isTrusted` gate, new event prop read). Primary mitigation: add a vitest "xterm anchor probe" test that asserts the seven load-bearing source-level facts the rewrite depends on — (1) `Terminal.ts:379` keydown binding on helper, (2) `Terminal.ts:1046` early-return on `!result.key`, (3) `Terminal.ts:467-468` focus/blur on helper, (4) `Terminal.ts:381` compositionstart on helper, (5) `Terminal.ts:344` paste binding on `this.element` (R-NEW-8 dependency), (6) `Terminal.ts:334-341` copy binding on `this.element` with `copyHandler`, (7) `CoreTerminal.ts:171` public `input()` API shape. Test fails loudly on xterm upgrade if any anchor moves. Secondary mitigation (recommended, not committed by the planner per scope discipline — implementer can land if they choose): pin `@xterm/xterm` version exactly in `package.json` (currently `^5.5.0`; `5.5.0` would prevent accidental minor-bump drift). Anchor probe test alone is sufficient even without the pin.
- **R4** — Focus model: `terminal.focus()` → patched `helper.focus()` → `shadow.focus()`. Confirmed end-to-end.
- **R5** — `AgentMiniTerminal` focus-state proxy needed at TWO touchpoints: the visual focus border (`setFocused`) AND the `writeWithFollowBottom` `document.activeElement === terminal.textarea` check. Both updated via `imeHandle.isFocused()` proxy.
- **R6** — `pointer-events` arbitration on `.xterm-screen` for mouse selection drag and wheel/touchpad scroll. Shadow uses `pointer-events: none` by default + `overflow: hidden`; wheel events bubble naturally to `.xterm-viewport`.
- **R7** — Synthesized event default action: xterm doesn't depend on it (computes from props directly). Verified across representative key set.
- **R8** — Helper retains xterm's bound listeners (we can't remove them — bound via private `register()` at `Terminal.ts:379`). Defense-in-depth via capture-phase `compositionstart` listener on helper with `stopImmediatePropagation` + sync `shadow.focus()`.
- **R-NEW-4** — Paste during `_keyDownSeen=true`: `terminal.paste()` goes via `coreService.triggerDataEvent` directly (bypasses `_inputEvent`), no intersection. Test guards it.
- **R-NEW-5** — Cmd+V keydown could suppress browser's paste action if `preventDefault` is called. v3.2 fix: explicit `isNativePasteShortcut` bypass in `routeKey` ensures the original Cmd+V keydown is NOT `preventDefault`-ed; the browser fires the `paste` event normally, which `routePaste` handles. Test guards it.
- **R-NEW-6** — Single rule for non-keydown text input: `beforeinput` event handler routes `inputType === 'insertReplacementText'` (autocomplete/dictation) via `routeBeforeInputReplace` → `terminal.paste(data)` (shadow OWNS the write — no xterm bubble path for `beforeinput`); and `inputType === 'insertText'` when no keydown was handled in the current tick (emoji palette / IME-less typed text) via `terminal.input(data)`. Implementer tracks the "keydown handled this tick" flag with a microtask-cleared bool. Distinct from Node 15 (`routePaste`) where the ClipboardEvent path bubbles to xterm.
- **R-NEW-7** — Copy/cut with shadow always focused: v3.2's framing was based on a wrong citation. The actual macOS Cmd+C path lives at `Terminal.ts:334-341` bound on `this.element` (the terminal container), NOT at `Terminal.ts:530-534` (which is the Linux middle-click path). Shadow's `copy` events bubble through `.xterm-viewport` to `this.element`, where xterm's `copyHandler` catches them and writes `selectionService.selectionText` to the clipboard. Cmd+C therefore already works correctly **without** `routeCopy`. v3.3 retains `routeCopy`/`routeCut` as defense-in-depth (redundant write, same data — survives potential future xterm rebinds) and explicitly does NOT call `stopPropagation` so xterm's listener fires as fallback. Test: mouse-select on `.xterm-screen` → Cmd+C → clipboard contains the selection; assertion against the actual clipboard (not stubbed) verifies the path end-to-end.
- **R-NEW-8** — Shadow-as-descendant-of-`this.element` bubble pattern: any DOM event fired on shadow that xterm also binds on `this.element` will double-fire unless mitigated. Currently affected: `paste` (BLOCKING — v3.3 fixes via Option A: `routePaste` only `preventDefault`; xterm does PTY write), `copy`, `cut` (redundant but harmless — defense-in-depth keeps both). Potentially affected if shadow ever gains `pointer-events: auto`: `mousedown` (Linux/Firefox right-click), `contextmenu` (Terminal.ts:355), `auxclick` (Linux middle-click). v3.3 mitigation discipline: any new shadow event listener that intersects with an xterm `this.element` binding must explicitly pick "shadow authoritative (`stopPropagation`)" vs "xterm authoritative (no PTY-write side effect in shadow handler)" vs "defense-in-depth (both fire, idempotent operations only)". Test plan: add bubble-double-fire integration tests for paste and copy/cut against the real xterm instance, not stubbed `terminal.paste` / `terminal.getSelection`.

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
- **Cmd+V**: `isNativePasteShortcut` returns true → routeKey returns early (no synth, no preventDefault) → browser fires `paste` event → `routePaste` calls only `preventDefault` + `clearValue` → event bubbles to `this.element` → xterm's `pasteHandlerWrapper` → `handlePasteEvent` → `paste()` → `triggerDataEvent` → **exactly one PTY write** (v3.3 BLOCKING fix vs double-fire)
- **Ctrl+V** (v3.3 added test): `isNativePasteShortcut` returns FALSE (predicate is `metaKey && !ctrlKey`) → falls through to Branch C → `synthesizeKeydown` → xterm encodes `\x16` (SYN) → PTY receives `\x16`; NOT routed via paste path
- **Ctrl+C** (v3.3 added test): same path as Ctrl+V; PTY receives `\x03` (ETX, terminal interrupt); NOT routed via copy path
- **Ctrl+X** (v3.3 added test): same path; PTY receives `\x18` (CAN); NOT routed via cut path
- **Paste during `_keyDownSeen=true`** → exactly one PTY write (xterm's `pasteHandlerWrapper` calls `paste()` which uses `coreService.triggerDataEvent` directly, bypassing `_inputEvent` _keyDownSeen gate)
- **Cmd+C with terminal mouse-selection** (v3.3 production-mode test): mouse-select on `.xterm-screen` → Cmd+C on shadow → both `routeCopy` AND xterm's element-level handler fire (defense-in-depth); clipboard content matches the selected text exactly once (idempotent setData with same string). Assertion uses real clipboard or spy on `e.clipboardData.setData` — NOT a stub of `terminal.getSelection`
- **Cmd+C with no selection**: `routeCopy` early-exits; bubble continues to xterm's listener which also sees `!this.hasSelection()` and returns; native copy fires on shadow.value (empty) — no-op
- **Cmd+X**: `routeCut` mirrors `routeCopy`; clipboard contains selection; terminal buffer unchanged
- **Bubble double-fire integration test** (v3.3 NEW per @claude3 R-NEW-8): paste of `한글` against the real xterm instance (not stubbed `terminal.paste`) → exactly ONE PTY write observed via `terminal.onData` listener; under bracketed-paste mode result is `\x1b[200~한글\x1b[201~` (NOT doubled)
- Focus mirror: `shadow.focus()` → `terminal.element.classList.contains('focus')` === true
- DECSET 1004: `terminal.write('\x1b[?1004h')` then `shadow.focus()` → onData fires `\x1b[I`
- Defensive helper `compositionstart`: dispatched on helper → capture-phase listener fires `stopImmediatePropagation` + shadow re-focused; xterm's `_compositionHelper.compositionstart` NOT called
- emoji via `beforeinput` `insertText` (no preceding keydown) → `terminal.input(data)`; single PTY write
- autocomplete/dictation via `beforeinput` `insertReplacementText` → `routeBeforeInputReplace` → `terminal.paste(data)`; single PTY write (shadow owns; no bubble path)
- collaborator\r intercept after Korean: `안녕<bs><bs>collaborator\r` triggers `openCollaboratorSplit`
- Wheel/touchpad scroll passthrough: wheel event on shadow does not eat xterm viewport scroll
- Mid-composition Tab: composition state preserved, no focus shift

## LOC budget summary

| File | Before | v3.3 target | Delta |
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
- **Round 5 (v3.2)**: @codex3 surfaced BLOCKING Cmd+V paste-suppression defect. Added native edit shortcut bypass and `routeCopy`/`routeCut` to KeyRouter (5 methods total). Cited `Terminal.ts:530-534` for the Cmd+C rationale — this citation was WRONG (that's the Linux middle-click path). Reviewer convergence: 2 APPROVE, 2 narrow-revise (predicate too broad, factual error), 1 revise (double-paste defect). Did NOT lock.
- **Round 6 (v3.3, locked)**: @codex1 BLOCKING + @claude3 BLOCKING both folded.
  - **@codex1 BLOCKING**: `isNativePasteShortcut(e)` previously included `ctrlKey`, but Ctrl+V/C/X are terminal control characters (SYN/ETX/CAN), not browser clipboard shortcuts on macOS. v3.3 restricts predicates to `metaKey && !ctrlKey`. Ctrl+letters route via Branch C → xterm encodes correctly.
  - **@claude3 BLOCKING**: `routePaste` previously called `terminal.paste(text)` AND the event bubbled to `this.element` where xterm's `pasteHandlerWrapper` ALSO called `paste(...)` → double PTY write under bracketed-paste mode. v3.3 fix (Option A): `routePaste` only calls `preventDefault` + `clearValue`; xterm's element-level handler does the actual PTY write via bubble. Single write guaranteed.
  - **Factual correction**: Cmd+C path lives at `Terminal.ts:334-341` bound on `this.element`, not `Terminal.ts:530-534` (Linux middle-click). `routeCopy`/`routeCut` retained as defense-in-depth (redundant but harmless; mirrors xterm's element-level handler).
  - **R-NEW-8 added**: shadow-bubbles-to-`this.element` topology — any new shadow listener intersecting xterm's element binding must pick an explicit ownership policy.
  - **Test plan additions**: Ctrl+V/C/X (terminal control reachability), bubble-double-fire production-mode integration test (real xterm, not stubbed).
  - Expected: 5/5 APPROVE — design has not shifted shape since v3, only narrow defects in adjacent surfaces.
- **Round 6 (v3.4, locked)**: 4/5 reviewers (@codex1, @codex2, @codex3, @claude3) convergent on the same residual defect — v3.3 prose locked routePaste Option A but the decomposition table (Node 15) and clearValue cadence table still read `terminal.paste(text)` (the v3.2 double-fire shape). Artifact contradiction would have caused the implementer to ship the bug. @claude2 verified the BLOCKING fixes against xterm source and APPROVED — they reviewed the prose, not the tables. v3.4 amendments:
  - **Node 15 split into 15 + 15b**: Node 15 (`routePaste` for ClipboardEvent — `preventDefault` + `clearValue` ONLY; xterm's `this.element` listener does the PTY write via bubble); Node 15b (`routeBeforeInputReplace` for `beforeinput insertReplacementText` — `terminal.paste(data)` because there's no xterm bubble path for `beforeinput`). The conflation in v3.3's Node 15 was the bug.
  - **clearValue cadence table**: `routePaste` row corrected to "no `terminal.paste(text)` call"; new row for `routeBeforeInputReplace`.
  - **plan.mmd**: routePaste edge corrected — Cmd+V bubbles from shadow to `this.element`'s `PASTE_API`, not from KeyRouter directly; `routeBeforeInputReplace` retains the direct `→ PASTE_API` edge.
  - **R3 mitigation reframed**: anchor probe test is the load-bearing mitigation (primary); `@xterm/xterm` exact version pin is recommended but not committed by planner per scope discipline.
  - Total interfaces / nodes: 6 / 25. KeyRouter: 6 methods.

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
