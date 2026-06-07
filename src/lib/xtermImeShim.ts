import { Terminal } from "@xterm/xterm";
import { invoke } from "@tauri-apps/api/core";
import {
  createShadowTextarea,
  type ShadowTextarea,
} from "./xtermShadowTextarea";

// ===========================================================================
// Public surface
// ===========================================================================

/**
 * Options passed to {@link attachKoreanImeShim}. Additive-only since the
 * pre-rewrite contract — `shouldBubbleShortcut` is the only v3 addition;
 * existing callers continue to work unmodified.
 */
export interface AttachKoreanImeShimOptions {
  /**
   * PTY session id forwarded to `invoke("write_to_pty", { sessionId, data })`
   * when the shim flushes committed Korean syllables or terminator-driven
   * compositions.
   */
  sessionId: string;

  /**
   * Reserved for renderer-specific overlay tweaks. The current
   * implementation accepts but does not currently branch on this flag —
   * preserved on the contract so future asymmetric tweaks do not require a
   * signature change.
   */
  webgl?: boolean;

  /**
   * Font size to use for the IME overlay when `terminal.options.fontSize`
   * is `undefined`. PTY pane uses 12 (terminalManager.ts); mini terminals
   * use 10 (AgentMiniTerminal.tsx). Defaults to 12 when omitted.
   */
  defaultFontSize?: number;

  /**
   * Synchronous notification fired AFTER the shim has written a flushed
   * composition to the PTY via `write_to_pty`. **Notification only — the
   * callback MUST NOT itself invoke `write_to_pty` for the same payload**,
   * otherwise the PTY receives the bytes twice.
   *
   * Fires on the three helper-originated PTY write paths:
   *   1. `compositionend` commit
   *   2. `blur` flush (focus leaves the shadow textarea mid-composition)
   *   3. Terminating-key flush (Enter / Escape / Tab during composition;
   *      the terminator is reported separately).
   *
   * Subscriber responsibilities:
   *   - PTY pane (`terminalManager.ts`): reset `lineBuffer` on `'\r'`
   *     terminator so a Korean → IME-off → `collaborator\r` sequence
   *     still triggers the in-app spawn intercept.
   *   - Mini terminal (`AgentMiniTerminal.tsx`): call
   *     `terminal.scrollToBottom()` so Korean composition snaps the
   *     viewport same as ASCII keystrokes.
   */
  onComposedFlush?: (
    committedText: string,
    terminator: "\r" | "\x1b" | "\t" | null,
  ) => void;

  /**
   * Predicate that returns `true` for keyboard events the call site wants
   * to bubble natively past xterm (Cmd+T / Cmd+W / Cmd+F / etc.). When
   * `true`, the shim performs NO `preventDefault`, NO synthesize-to-helper,
   * and the original trusted event bubbles up the DOM tree to the
   * application shortcut layer.
   *
   * Default (callback omitted): nothing bubbles — every non-composition
   * key goes through Branch B (`terminal.input`) or Branch C
   * (`synthesizeKeydown`).
   *
   * Note: Native edit shortcuts (Cmd+V/C/X on macOS, `metaKey && !ctrlKey
   * && !shiftKey && !altKey`) are bypassed UNCONDITIONALLY before this
   * predicate runs — the browser fires the `paste`/`copy`/`cut` event
   * on shadow which `routePaste`/`routeCopy`/`routeCut` handle. The
   * predicate doesn't need to enumerate those.
   */
  shouldBubbleShortcut?: (e: KeyboardEvent) => boolean;
}

/**
 * Handle returned by {@link attachKoreanImeShim} for lifecycle control.
 */
export interface KoreanImeShimHandle {
  /**
   * The composing-glyph overlay element. `null` once disposed OR when
   * attach happened before `.xterm-screen` was reachable AND the
   * container itself was not in the DOM tree.
   *
   * Exposed so the call sites can update `style.fontSize` reactively
   * when the user changes terminal font size.
   */
  readonly overlayEl: HTMLElement | null;

  /**
   * Re-anchor the shadow textarea + overlay against the current
   * `.xterm-screen` element and refresh font-size styling. Idempotent;
   * safe to call after layout changes or DOM reparenting.
   */
  rebind(): void;

  /**
   * Tear down everything the shim attached. Removes the shadow
   * textarea, the overlay span, the helper-focus patch, the focus
   * mirror, the defensive helper-`compositionstart` listener, and the
   * runtime CSS rule. Idempotent.
   */
  dispose(): void;

  /**
   * `true` when the shadow textarea owns DOM focus. Call sites use this
   * for the visual focus border AND for the
   * "is the user actively typing" check that gates the live
   * scroll-to-bottom behavior.
   */
  isFocused(): boolean;
}

// ===========================================================================
// Constants + helpers (kept module-local)
// ===========================================================================

const STYLE_BLOCK_ID = "ime-cursor-blink-style";
const HIDDEN_CURSOR_CSS_CLASS = "ime-cursor-hidden";
const DEFAULT_CELL_WIDTH = 8;
const DEFAULT_CELL_HEIGHT = 16;

const KOREAN_CODEPOINT_RE = /[ᄀ-ᇿㄱ-ㆎ가-힣]/;
// Exported for the test surface — the JP/ZH fixture asserts the predicate
// shape stays in step with the shim's classification.
export { KOREAN_CODEPOINT_RE };

function isFullWidth(ch: string): boolean {
  const cp = ch.codePointAt(0) ?? 0;
  return (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0x303e) ||
    (cp >= 0x3040 && cp <= 0x33bf) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0xa4cf) ||
    (cp >= 0xa960 && cp <= 0xa97c) ||
    (cp >= 0xac00 && cp <= 0xd7af) ||
    (cp >= 0xd7b0 && cp <= 0xd7ff) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe6f) ||
    (cp >= 0xff01 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x20000 && cp <= 0x2fa1f)
  );
}

interface RenderDimensions {
  css: { cell: { width: number; height: number } };
}

interface XtermCoreShape {
  _renderService?: { dimensions?: RenderDimensions };
}

function readCellDimensions(terminal: Terminal): { w: number; h: number } {
  const dims = (
    terminal as unknown as { _core?: XtermCoreShape }
  )._core?._renderService?.dimensions;
  if (!dims) return { w: DEFAULT_CELL_WIDTH, h: DEFAULT_CELL_HEIGHT };
  return { w: dims.css.cell.width, h: dims.css.cell.height };
}

function ensureStyleBlock(): void {
  if (document.getElementById(STYLE_BLOCK_ID)) return;
  const styleEl = document.createElement("style");
  styleEl.id = STYLE_BLOCK_ID;
  styleEl.textContent =
    `@keyframes ime-cursor-blink { 0%,50% { opacity: 1; } 50.01%,100% { opacity: 0; } }\n` +
    // Hide xterm's DOM-renderer cursor layer while a composition is
    // active. WebGL renderer paints into canvas so this rule is a no-op
    // there — the overlay span's solid background covers the cell.
    `.${HIDDEN_CURSOR_CSS_CLASS} .xterm-cursor-layer { visibility: hidden; }\n`;
  document.head.appendChild(styleEl);
}

// ===========================================================================
// CursorOverlay — paints in-progress composition glyphs at the cursor cell
// ===========================================================================

interface CursorOverlay {
  readonly overlayEl: HTMLElement;
  readonly attached: boolean;
  tryAttach(): void;
  show(text: string): void;
  clear(): void;
  reposition(): void;
  updateStyle(): void;
  dispose(): void;
}

function createCursorOverlay(
  terminal: Terminal,
  container: HTMLElement,
  defaultFontSize: number,
): CursorOverlay {
  const overlayEl = document.createElement("span");
  const fakeCursorEl = document.createElement("span");

  overlayEl.style.cssText =
    `position:absolute;color:inherit;` +
    `font-family:${terminal.options.fontFamily ?? "monospace"};` +
    `font-size:${terminal.options.fontSize ?? defaultFontSize}px;` +
    `font-weight:${terminal.options.fontWeight ?? "normal"};` +
    `-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility;` +
    `pointer-events:none;` +
    `z-index:11;white-space:pre;display:none;padding:0;margin:0;`;
  fakeCursorEl.style.cssText =
    `display:inline-block;width:2px;vertical-align:top;` +
    `animation:ime-cursor-blink 1s step-end infinite;`;
  overlayEl.appendChild(fakeCursorEl);

  let attached = false;
  let mountedParent: HTMLElement | null = null;
  let lastText = "";

  function tryAttach(): void {
    const screenEl = container.querySelector<HTMLElement>(".xterm-screen");
    // Round-1 fold (convergent LOW-MED from @claude2 / @claude3 /
    // @codex1): re-anchor from container fallback to .xterm-screen when
    // it becomes available. Mirrors ShadowTextarea.tryMount.
    if (mountedParent && screenEl && mountedParent !== screenEl) {
      if (!screenEl.style.position || screenEl.style.position === "static") {
        screenEl.style.position = "relative";
      }
      screenEl.appendChild(overlayEl);
      mountedParent = screenEl;
      attached = true;
      return;
    }
    if (attached) return;
    if (screenEl) {
      if (!screenEl.style.position || screenEl.style.position === "static") {
        screenEl.style.position = "relative";
      }
      screenEl.appendChild(overlayEl);
      mountedParent = screenEl;
      attached = true;
      return;
    }
    if (container.isConnected) {
      if (!container.style.position || container.style.position === "static") {
        container.style.position = "relative";
      }
      container.appendChild(overlayEl);
      mountedParent = container;
      attached = true;
    }
  }
  tryAttach();

  function paint(text: string): void {
    while (overlayEl.firstChild && overlayEl.firstChild !== fakeCursorEl) {
      overlayEl.removeChild(overlayEl.firstChild);
    }
    if (!fakeCursorEl.parentNode) overlayEl.appendChild(fakeCursorEl);
    const { w: cellW, h: cellH } = readCellDimensions(terminal);
    const bg = terminal.options.theme?.background ?? "#1a1a1a";
    const fg = terminal.options.theme?.foreground ?? "#e0e0e0";
    const cursorColor = terminal.options.theme?.cursor ?? "#ffffff";
    overlayEl.style.color = fg;
    overlayEl.style.lineHeight = `${cellH}px`;
    overlayEl.style.height = `${cellH}px`;
    for (const ch of text) {
      const charSpan = document.createElement("span");
      charSpan.textContent = ch;
      const w = isFullWidth(ch) ? cellW * 2 : cellW;
      charSpan.style.cssText =
        `display:inline-block;width:${w}px;height:${cellH}px;` +
        `text-align:center;background:${bg};`;
      overlayEl.insertBefore(charSpan, fakeCursorEl);
    }
    fakeCursorEl.style.height = `${cellH}px`;
    fakeCursorEl.style.backgroundColor = cursorColor;
  }

  function repositionInternal(): void {
    const { w: cellW, h: cellH } = readCellDimensions(terminal);
    const cx = terminal.buffer.active.cursorX;
    const cy = terminal.buffer.active.cursorY;
    overlayEl.style.left = `${cx * cellW}px`;
    overlayEl.style.top = `${cy * cellH}px`;
  }

  function show(text: string): void {
    lastText = text;
    paint(text);
    repositionInternal();
    overlayEl.style.display = text ? "" : "none";
    if (text) {
      container.classList.add(HIDDEN_CURSOR_CSS_CLASS);
    }
  }

  function clear(): void {
    lastText = "";
    while (overlayEl.firstChild && overlayEl.firstChild !== fakeCursorEl) {
      overlayEl.removeChild(overlayEl.firstChild);
    }
    overlayEl.style.display = "none";
    container.classList.remove(HIDDEN_CURSOR_CSS_CLASS);
  }

  function reposition(): void {
    repositionInternal();
  }

  function updateStyle(): void {
    overlayEl.style.fontSize = `${terminal.options.fontSize ?? defaultFontSize}px`;
    overlayEl.style.fontFamily = terminal.options.fontFamily ?? "monospace";
    overlayEl.style.fontWeight = String(
      terminal.options.fontWeight ?? "normal",
    );
    if (lastText) paint(lastText);
  }

  function dispose(): void {
    if (overlayEl.parentNode) {
      overlayEl.parentNode.removeChild(overlayEl);
    }
    attached = false;
    mountedParent = null;
    container.classList.remove(HIDDEN_CURSOR_CSS_CLASS);
  }

  return {
    overlayEl,
    get attached() {
      return attached;
    },
    tryAttach,
    show,
    clear,
    reposition,
    updateStyle,
    dispose,
  };
}

// ===========================================================================
// HelperTextareaIsolator — patches helper.focus(), mirrors focus state
// ===========================================================================

interface HelperTextareaIsolator {
  helper: HTMLTextAreaElement | null;
  rebind(): void;
  dispose(): void;
}

function createHelperTextareaIsolator(
  terminal: Terminal,
  container: HTMLElement,
  shadow: ShadowTextarea,
): HelperTextareaIsolator {
  let helper: HTMLTextAreaElement | null = null;
  let nativeFocus: HTMLTextAreaElement["focus"] | null = null;
  let onShadowFocus: (() => void) | null = null;
  let onShadowBlur: (() => void) | null = null;
  let onHelperCompositionStart: ((e: CompositionEvent) => void) | null = null;

  function findHelper(): HTMLTextAreaElement | null {
    return (
      terminal.textarea ??
      container.querySelector<HTMLTextAreaElement>(".xterm-helper-textarea")
    );
  }

  function dispatchFocusOnHelper(type: "focus" | "blur"): void {
    if (!helper) return;
    try {
      helper.dispatchEvent(new FocusEvent(type, { bubbles: false }));
    } catch {
      // happy-dom may reject some FocusEvent shapes; fall back to Event.
      helper.dispatchEvent(new Event(type));
    }
  }

  function installFocusRedirect(): void {
    if (!helper) return;
    // Capture the native focus method ONCE per helper element — repeated
    // rebinds against the same element are no-ops. The patched function
    // forwards into the original (bound) focus with preventScroll forced
    // on so xterm's auto-focus on container clicks doesn't scroll the
    // page.
    if (!nativeFocus) {
      nativeFocus = helper.focus.bind(helper);
    }
    helper.focus = ((opts?: FocusOptions): void => {
      // Redirect helper.focus() to shadow.focus() so anything that
      // synchronously focuses the helper (xterm's `_keyDown` early-out,
      // container click handlers) lands focus on the shadow instead.
      shadow.focus();
      void opts;
    }) as HTMLTextAreaElement["focus"];
  }

  function installFocusMirror(): void {
    const ta = shadow.textareaEl;
    if (!ta) return;
    onShadowFocus = () => dispatchFocusOnHelper("focus");
    onShadowBlur = () => dispatchFocusOnHelper("blur");
    ta.addEventListener("focus", onShadowFocus);
    ta.addEventListener("blur", onShadowBlur);
  }

  function installDefensiveCompositionStart(): void {
    if (!helper) return;
    // Capture-phase listener on helper. If helper ever receives a
    // `compositionstart` (e.g. xterm internally calls helper.focus
    // outside our patch path), intercept it before xterm's own
    // listener runs and bounce focus back to shadow so the IME's
    // composition target stays where we expect.
    onHelperCompositionStart = (e: CompositionEvent) => {
      e.stopImmediatePropagation();
      shadow.focus();
    };
    helper.addEventListener(
      "compositionstart",
      onHelperCompositionStart as EventListener,
      true,
    );
  }

  function rebind(): void {
    const next = findHelper();
    if (helper === next) {
      // Helper element unchanged — re-install focus redirect (idempotent)
      // and ensure the focus mirror is wired on the current shadow
      // element. Defensive compositionstart re-installs only if no
      // existing listener.
      installFocusRedirect();
      return;
    }
    // Helper changed (e.g. xterm reattached). Tear down the prior
    // bindings, then install fresh ones against the new element.
    if (helper) {
      if (nativeFocus) {
        helper.focus = nativeFocus;
      }
      if (onHelperCompositionStart) {
        helper.removeEventListener(
          "compositionstart",
          onHelperCompositionStart as EventListener,
          true,
        );
      }
    }
    helper = next;
    nativeFocus = null;
    if (helper) {
      installFocusRedirect();
      installDefensiveCompositionStart();
    }
  }

  // Initial wire-up.
  helper = findHelper();
  if (helper) {
    installFocusRedirect();
    installDefensiveCompositionStart();
  }
  installFocusMirror();

  function dispose(): void {
    const ta = shadow.textareaEl;
    if (ta) {
      if (onShadowFocus) ta.removeEventListener("focus", onShadowFocus);
      if (onShadowBlur) ta.removeEventListener("blur", onShadowBlur);
    }
    onShadowFocus = null;
    onShadowBlur = null;
    if (helper) {
      if (nativeFocus) helper.focus = nativeFocus;
      if (onHelperCompositionStart) {
        helper.removeEventListener(
          "compositionstart",
          onHelperCompositionStart as EventListener,
          true,
        );
      }
    }
    helper = null;
    nativeFocus = null;
    onHelperCompositionStart = null;
  }

  return {
    get helper() {
      return helper;
    },
    rebind,
    dispose,
  };
}

// ===========================================================================
// CompositionRouter — owns composition state machine on the shadow textarea
// ===========================================================================

interface CompositionRouter {
  readonly isComposing: boolean;
  onCompositionStart(e: CompositionEvent): void;
  onCompositionUpdate(e: CompositionEvent): void;
  onCompositionEnd(e: CompositionEvent): void;
  onTerminatingKey(e: KeyboardEvent, terminator: "\r" | "\x1b" | "\t"): void;
  onBlurDuringComposition(): void;
}

function createCompositionRouter(args: {
  sessionId: string;
  overlay: CursorOverlay;
  shadow: ShadowTextarea;
  emitFlush: (text: string, terminator: "\r" | "\x1b" | "\t" | null) => void;
}): CompositionRouter {
  const { sessionId, overlay, shadow, emitFlush } = args;
  let composing = false;
  let fragment = "";

  function flushToPty(data: string): void {
    if (!data) return;
    invoke("write_to_pty", { sessionId, data }).catch(() => {});
  }

  function onCompositionStart(_e: CompositionEvent): void {
    composing = true;
    fragment = "";
    overlay.reposition();
    overlay.show("");
  }

  function onCompositionUpdate(e: CompositionEvent): void {
    // event.data is the canonical "what's in the composition right now"
    // signal — preferred over reading `textareaEl.value` because the
    // textarea may carry a stale value between IME engines.
    const data = e.data ?? "";
    fragment = data;
    overlay.show(data);
  }

  function onCompositionEnd(e: CompositionEvent): void {
    const written = (e.data ?? fragment) || "";
    if (composing && written) {
      flushToPty(written);
      emitFlush(written, null);
    }
    overlay.clear();
    composing = false;
    fragment = "";
    shadow.clearValue();
  }

  function onTerminatingKey(
    _e: KeyboardEvent,
    terminator: "\r" | "\x1b" | "\t",
  ): void {
    const composed = fragment;
    overlay.clear();
    composing = false;
    fragment = "";
    const data = composed + terminator;
    flushToPty(data);
    emitFlush(composed, terminator);
    shadow.clearValue();
  }

  function onBlurDuringComposition(): void {
    if (!composing) return;
    const composed = fragment;
    overlay.clear();
    composing = false;
    fragment = "";
    if (composed) {
      flushToPty(composed);
      emitFlush(composed, null);
    }
    shadow.clearValue();
  }

  return {
    get isComposing() {
      return composing;
    },
    onCompositionStart,
    onCompositionUpdate,
    onCompositionEnd,
    onTerminatingKey,
    onBlurDuringComposition,
  };
}

// ===========================================================================
// KeyRouter — keydown / clipboard / beforeinput routing on shadow
// ===========================================================================

const SYNTH_PROPS = [
  "key",
  "code",
  "keyCode",
  "which",
  "shiftKey",
  "ctrlKey",
  "altKey",
  "metaKey",
  "location",
  "repeat",
] as const;

function buildSyntheticKeydown(src: KeyboardEvent): KeyboardEvent {
  const init: KeyboardEventInit = {
    bubbles: true,
    cancelable: true,
    composed: true,
  };
  for (const prop of SYNTH_PROPS) {
    // `which` is deprecated but xterm still reads it in some code paths;
    // mirror verbatim from the source.
    (init as Record<string, unknown>)[prop] = (
      src as unknown as Record<string, unknown>
    )[prop];
  }
  return new KeyboardEvent("keydown", init);
}

interface KeyRouter {
  routePrintable(key: string): void;
  synthesizeKeydown(src: KeyboardEvent): void;
  routePaste(e: ClipboardEvent): void;
  routeBeforeInputReplace(e: InputEvent): void;
  routeCopy(e: ClipboardEvent): void;
  routeCut(e: ClipboardEvent): void;
}

function createKeyRouter(args: {
  terminal: Terminal;
  shadow: ShadowTextarea;
  isolator: HelperTextareaIsolator;
}): KeyRouter {
  const { terminal, shadow, isolator } = args;

  function routePrintable(key: string): void {
    terminal.input(key, true);
    shadow.clearValue();
  }

  function synthesizeKeydown(src: KeyboardEvent): void {
    const helper = isolator.helper;
    if (!helper) {
      // Helper not bound yet (e.g. terminal.open() happened with no
      // textarea). Fall through to terminal.input for printable-ish
      // keys; otherwise drop. This is a degraded path; the orchestrator's
      // rebind() should restore the helper on the next layout tick.
      if (src.key.length === 1) {
        terminal.input(src.key, true);
      }
      shadow.clearValue();
      return;
    }
    const synthetic = buildSyntheticKeydown(src);
    helper.dispatchEvent(synthetic);
    shadow.clearValue();
  }

  function routePaste(e: ClipboardEvent): void {
    // v3.3 contract: do NOT call terminal.paste(text). The event bubbles
    // through `.xterm-viewport` to xterm's `this.element` paste listener
    // which performs the actual PTY write via `handlePasteEvent` →
    // `paste()` → `triggerDataEvent`. Calling `terminal.paste` here
    // would double-fire under bracketed-paste mode.
    e.preventDefault();
    shadow.clearValue();
  }

  function routeBeforeInputReplace(e: InputEvent): void {
    // No xterm bubble path exists for `beforeinput` (xterm does not
    // bind a `beforeinput` listener on `this.element`). Shadow owns
    // the PTY write here via `terminal.paste(data)`.
    const data = e.data ?? "";
    e.preventDefault();
    if (data) terminal.paste(data);
    shadow.clearValue();
  }

  function routeCopy(e: ClipboardEvent): void {
    // Defense-in-depth: xterm's `this.element` 'copy' listener already
    // catches the shadow's bubbling copy event and writes the selection
    // via `copyHandler`. We MAY also write here so the contract survives
    // a future xterm refactor that rebinds 'copy' to the helper. Do NOT
    // call `stopPropagation` — the bubble path to xterm must continue.
    const sel = terminal.getSelection();
    if (sel) {
      try {
        e.clipboardData?.setData("text/plain", sel);
      } catch {
        // happy-dom may not support setData; the bubble path still
        // delivers via xterm's listener under real browsers.
      }
      e.preventDefault();
    }
    // else: no selection — let the native copy fire on the empty
    // shadow.value (no-op). Bubble continues regardless.
  }

  function routeCut(e: ClipboardEvent): void {
    // Terminal cannot semantically cut — same behavior as copy.
    routeCopy(e);
  }

  return {
    routePrintable,
    synthesizeKeydown,
    routePaste,
    routeBeforeInputReplace,
    routeCopy,
    routeCut,
  };
}

// ===========================================================================
// ImeShimOrchestrator — wires subsystems, returns the public handle
// ===========================================================================

function isNativePasteShortcut(e: KeyboardEvent): boolean {
  return (
    e.metaKey &&
    !e.ctrlKey &&
    !e.shiftKey &&
    !e.altKey &&
    (e.key === "v" || e.key === "V")
  );
}

function isNativeCopyOrCutShortcut(e: KeyboardEvent): boolean {
  if (!e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return false;
  return e.key === "c" || e.key === "C" || e.key === "x" || e.key === "X";
}

/**
 * Install Canvas Terminal's Korean IME composition shim on the given
 * xterm.js Terminal. Replaces the helper-textarea-owned input path with
 * a transparent shadow textarea that owns composition + keydown +
 * clipboard + beforeinput events. The structural fix makes the WKWebView
 * CFRunLoop coalescing race that drove `korean-ime-dup-*` unreachable
 * rather than window-tuned around.
 *
 * Architecture (5 logical modules wired by this function):
 *   - `ShadowTextarea` — transparent textarea sibling of `.xterm-screen`,
 *     focus owner, composition target.
 *   - `CursorOverlay` — paints composition glyphs at the cursor cell.
 *   - `HelperTextareaIsolator` — patches `helper.focus` to redirect to
 *     shadow; mirrors shadow's focus state onto helper so xterm's
 *     focus listeners + `.focus` CSS + DECSET 1004 keep working.
 *   - `CompositionRouter` — `composition*` event state machine on shadow.
 *   - `KeyRouter` — `keydown` / `paste` / `copy` / `cut` / `beforeinput`
 *     routing on shadow with the three-branch classifier (bubble,
 *     printable, special) + native edit shortcut bypass.
 *
 * Preconditions: `terminal.open(container)` has already been called;
 *   `terminal._core` is accessible; the shim is invoked at most once per
 *   Terminal instance.
 */
export function attachKoreanImeShim(
  terminal: Terminal,
  container: HTMLElement,
  options: AttachKoreanImeShimOptions,
): KoreanImeShimHandle {
  const {
    sessionId,
    defaultFontSize = 12,
    onComposedFlush,
    shouldBubbleShortcut,
  } = options;
  void options.webgl; // Reserved for future renderer-asymmetric tweaks.

  ensureStyleBlock();

  // --- Subsystems ----------------------------------------------------------
  const overlay = createCursorOverlay(terminal, container, defaultFontSize);
  const shadow = createShadowTextarea(terminal, container, defaultFontSize);
  const isolator = createHelperTextareaIsolator(terminal, container, shadow);

  // Cursor blink saved so dispose can restore. The overlay's blinking
  // caret paints during composition; xterm's native cursor is hidden
  // via the runtime CSS class — but we also flip cursorBlink off so
  // WebGL's static-cursor mode doesn't fight the overlay caret.
  const origCursorBlink = terminal.options.cursorBlink;

  const emitFlush = (
    committedText: string,
    terminator: "\r" | "\x1b" | "\t" | null,
  ): void => {
    if (!onComposedFlush) return;
    try {
      onComposedFlush(committedText, terminator);
    } catch {
      // Subscriber errors are non-fatal — never let a downstream
      // exception break the IME state machine.
    }
  };

  const composition = createCompositionRouter({
    sessionId,
    overlay,
    shadow,
    emitFlush,
  });
  const keyRouter = createKeyRouter({ terminal, shadow, isolator });

  // --- Per-tick "did we handle a keydown this microtask" flag --------------
  // Used by the `beforeinput insertText` path (R-NEW-6): if a keydown was
  // already routed in this tick (printable / synthesize), suppress the
  // `insertText` event so the same input doesn't fire twice. Reset on a
  // microtask after each keydown so subsequent ticks see a clean slate.
  let keydownHandledThisTick = false;
  function markKeydownHandled(): void {
    keydownHandledThisTick = true;
    queueMicrotask(() => {
      keydownHandledThisTick = false;
    });
  }

  // --- Event listeners on shadow -------------------------------------------
  const shadowEl = shadow.textareaEl;

  // Live cursor tracking during composition.
  //
  // In production WKWebView and especially in dev mode (Vite + Tauri
  // round-trip), Korean composition can produce this race:
  //   1. compositionend("안") → invoke("write_to_pty", "안") (async)
  //   2. compositionstart("녕") fires BEFORE the PTY echo of "안"
  //      arrives back at xterm (round-trip can be 30-100ms in dev).
  //   3. overlay.reposition reads terminal.buffer.active.cursorX —
  //      still STALE (where "안" will go), so the overlay paints
  //      ON TOP of the just-arriving "안" character.
  //   4. User sees the overlay glyph instead of "안" → visible
  //      character drop / drift across multi-syllable composition.
  // Subscribing to terminal.onCursorMove keeps the overlay glued to
  // the live cursor; when the PTY echo lands and xterm advances the
  // cursor, the overlay snaps forward. Dispose on every composition
  // exit path so we don't burn cycles outside composition.
  let cursorMoveDisposable: { dispose(): void } | null = null;
  function attachCursorTracker(): void {
    if (cursorMoveDisposable) return;
    cursorMoveDisposable = terminal.onCursorMove(() => {
      overlay.reposition();
    });
  }
  function detachCursorTracker(): void {
    cursorMoveDisposable?.dispose();
    cursorMoveDisposable = null;
  }

  function onShadowCompositionStart(e: CompositionEvent): void {
    if (terminal.options.cursorBlink) {
      terminal.options.cursorBlink = false;
    }
    composition.onCompositionStart(e);
    attachCursorTracker();
  }

  function onShadowCompositionUpdate(e: CompositionEvent): void {
    composition.onCompositionUpdate(e);
  }

  function onShadowCompositionEnd(e: CompositionEvent): void {
    composition.onCompositionEnd(e);
    detachCursorTracker();
    terminal.options.cursorBlink = origCursorBlink;
  }

  function onShadowBlur(): void {
    composition.onBlurDuringComposition();
    detachCursorTracker();
    terminal.options.cursorBlink = origCursorBlink;
  }

  function routeKey(e: KeyboardEvent): void {
    // Mid-composition terminator (Enter / Esc / Tab) — flush + suppress.
    //
    // CRITICAL ORDERING (round-1 fold, convergent BLOCKING from
    // @claude3 / @codex1 / @codex3): real IME terminator keydowns on
    // WKWebView commonly carry `isComposing: true`, and on Chromium
    // during pending composition they often carry `keyCode: 229`. If we
    // run the generic `isComposing || keyCode === 229` early-return
    // FIRST, those production-shaped events get dropped and the atomic
    // flush + Tab focus-shift suppression never fire. So this branch
    // MUST run before the generic early-return when composition is
    // active.
    if (composition.isComposing) {
      const isEnter = e.key === "Enter" || e.code === "Enter";
      const isEsc = e.key === "Escape" || e.code === "Escape";
      const isTab = e.key === "Tab" || e.code === "Tab";
      if (isEnter || isEsc || isTab) {
        const term: "\r" | "\x1b" | "\t" = isEnter ? "\r" : isEsc ? "\x1b" : "\t";
        composition.onTerminatingKey(e, term);
        detachCursorTracker();
        e.preventDefault();
        markKeydownHandled();
        return;
      }
      // Mid-composition non-terminator — IME may still consume; let
      // composition* events drive state.
      if (e.isComposing || e.keyCode === 229) return;
      // Mid-composition modifier or other key — pass through.
      return;
    }

    // Composition path (non-composing router state but the event itself
    // is IME-marked) — IME consumed the key; let composition* events
    // drive state.
    if (e.isComposing || e.keyCode === 229) return;

    // Native edit shortcut bypass — Cmd+V/C/X on macOS. Browser fires
    // paste/copy/cut on shadow which routePaste/routeCopy/routeCut owns.
    if (isNativePasteShortcut(e) || isNativeCopyOrCutShortcut(e)) {
      return;
    }

    // Branch A: app-shortcut bubble (Cmd+T / Cmd+W / etc.). No synth,
    // no preventDefault — original trusted event bubbles natively.
    if (shouldBubbleShortcut?.(e)) {
      return;
    }

    // Branch B: printable single-character key (Shift allowed). Goes
    // through `terminal.input` which preserves `terminal.onData` so
    // call sites' `lineBuffer` + `scrollToBottom` work.
    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      keyRouter.routePrintable(e.key);
      e.preventDefault();
      markKeydownHandled();
      return;
    }

    // Branch C: special / modifier / Ctrl-letter. Synthesize a keydown
    // on helper so xterm's `_keyDown` runs its normal keymap (Tab → `\t`,
    // Ctrl+C → `\x03`, ArrowLeft → CSI, etc.). preventDefault on the
    // ORIGINAL shadow event so Tab does not move browser focus.
    keyRouter.synthesizeKeydown(e);
    e.preventDefault();
    markKeydownHandled();
  }

  function onShadowPaste(e: Event): void {
    keyRouter.routePaste(e as ClipboardEvent);
  }
  function onShadowCopy(e: Event): void {
    keyRouter.routeCopy(e as ClipboardEvent);
  }
  function onShadowCut(e: Event): void {
    keyRouter.routeCut(e as ClipboardEvent);
  }

  function onShadowBeforeInput(e: Event): void {
    const ie = e as InputEvent;
    if (ie.inputType === "insertReplacementText") {
      keyRouter.routeBeforeInputReplace(ie);
      return;
    }
    if (ie.inputType === "insertText" && !keydownHandledThisTick) {
      // Emoji palette / pen-input / no-keydown text injection. xterm
      // has no `beforeinput` listener, so shadow owns the write here
      // (mirrors `routeBeforeInputReplace` topology). Use
      // `terminal.input` (not `paste`) because emoji panel insertion
      // is "user-input intent" — `lineBuffer` / `scrollToBottom`
      // should fire.
      const data = ie.data ?? "";
      e.preventDefault();
      if (data) terminal.input(data, true);
      shadow.clearValue();
    }
  }

  if (shadowEl) {
    shadowEl.addEventListener("compositionstart", onShadowCompositionStart);
    shadowEl.addEventListener("compositionupdate", onShadowCompositionUpdate);
    shadowEl.addEventListener("compositionend", onShadowCompositionEnd);
    shadowEl.addEventListener("blur", onShadowBlur);
    shadowEl.addEventListener("keydown", routeKey);
    shadowEl.addEventListener("paste", onShadowPaste);
    shadowEl.addEventListener("copy", onShadowCopy);
    shadowEl.addEventListener("cut", onShadowCut);
    shadowEl.addEventListener("beforeinput", onShadowBeforeInput);
  }

  // Focus shadow at attach time so the first composition starts on it.
  shadow.repositionToCursor();
  shadow.focus();

  // --- Public handle -------------------------------------------------------
  let disposed = false;
  const handle: KoreanImeShimHandle = {
    get overlayEl() {
      return disposed || !overlay.attached ? null : overlay.overlayEl;
    },
    rebind(): void {
      if (disposed) return;
      overlay.tryAttach();
      isolator.rebind();
      shadow.repositionToCursor();
      overlay.reposition();
      overlay.updateStyle();
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      if (shadowEl) {
        shadowEl.removeEventListener(
          "compositionstart",
          onShadowCompositionStart,
        );
        shadowEl.removeEventListener(
          "compositionupdate",
          onShadowCompositionUpdate,
        );
        shadowEl.removeEventListener(
          "compositionend",
          onShadowCompositionEnd,
        );
        shadowEl.removeEventListener("blur", onShadowBlur);
        shadowEl.removeEventListener("keydown", routeKey);
        shadowEl.removeEventListener("paste", onShadowPaste);
        shadowEl.removeEventListener("copy", onShadowCopy);
        shadowEl.removeEventListener("cut", onShadowCut);
        shadowEl.removeEventListener("beforeinput", onShadowBeforeInput);
      }
      detachCursorTracker();
      isolator.dispose();
      shadow.dispose();
      overlay.dispose();
      terminal.options.cursorBlink = origCursorBlink;
    },
    isFocused(): boolean {
      return !disposed && shadow.isFocused();
    },
  };

  return handle;
}
