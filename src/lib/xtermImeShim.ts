import { Terminal } from "@xterm/xterm";
import { invoke } from "@tauri-apps/api/core";

/**
 * Options passed to {@link attachKoreanImeShim}.
 *
 * value-object (not a method-bearing interface).
 */
export interface AttachKoreanImeShimOptions {
  /**
   * PTY session id forwarded to `invoke("write_to_pty", { sessionId, data })`
   * when the shim flushes committed Korean syllables or terminator-driven
   * compositions.
   */
  sessionId: string;

  /**
   * `true` when the parent Terminal has loaded `@xterm/addon-webgl`.
   * Reserved for renderer-specific overlay/cursor adjustments. The
   * current implementation MAY ignore this flag; preserved on the
   * contract so future renderer-asymmetric tweaks (cursor bar color,
   * overlay z-index against WebGL canvas, etc.) do not require a
   * signature change.
   */
  webgl?: boolean;

  /**
   * Font size to use for the IME overlay when `terminal.options.fontSize`
   * is `undefined`. PTY pane historically uses 12 (terminalManager.ts);
   * mini terminals use 10 (AgentMiniTerminal.tsx). Defaults to 12 when
   * omitted.
   */
  defaultFontSize?: number;

  /**
   * Optional notification callback fired AFTER the shim has written a
   * flushed composition to the PTY via `write_to_pty`. **Notification
   * only — the callback MUST NOT itself invoke `write_to_pty` for the
   * same payload**, otherwise the PTY receives the bytes twice.
   *
   * **Fires for all three helper-originated PTY write paths**:
   *   1. `compositionend` commit (e.g. user crosses a syllable boundary
   *      and the IME finalizes the previous syllable)
   *   2. `blur` flush (focus leaves the textarea mid-composition)
   *   3. Terminating-key flush (Enter / Escape / Tab during composition;
   *      the terminator is appended to the PTY write and reported here)
   *
   * **Subscriber responsibilities**:
   *   - PTY pane (`terminalManager.ts`): maintain `lineBuffer` for the
   *     in-app `collaborator` keyword detection so Korean-composed
   *     `collaborator\r` still triggers the spawn (otherwise the
   *     terminator-flush bypasses the `terminal.onData` lineBuffer
   *     update at terminalManager.ts:680-697).
   *   - Mini terminal (`AgentMiniTerminal.tsx`): call
   *     `terminal.scrollToBottom()` so Korean-composed input still
   *     snaps the viewport to the live prompt — matching the
   *     "user-input intent" behavior the existing `terminal.onData`
   *     scroll at AgentMiniTerminal.tsx:709 provides for ASCII
   *     typing (which bypasses the helper).
   *
   * **Synchronous-only contract**: the shim invokes the callback
   * synchronously inside its IME handlers and catches synchronous
   * throws. The return type is `void`, not `Promise<void>` — if a
   * subscriber needs to do async work, it MUST schedule it via its
   * own `void Promise.resolve().then(...)` / `queueMicrotask(...)`
   * wrapper. An unhandled rejection from an async callback would
   * escape the shim's sync `try/catch` (and the documented exception
   * swallow contract) on its way to the global handler.
   *
   * @param committedText The fragment that was just sent to the PTY,
   *   EXCLUDING any terminator. Never contains `\r`, `\x1b`, or `\t` —
   *   those go in the `terminator` argument.
   * @param terminator `\r` (Enter), `\x1b` (Escape), `\t` (Tab), or
   *   `null` (compositionend / blur path — no terminator was appended
   *   to the PTY write).
   */
  onComposedFlush?: (
    committedText: string,
    terminator: "\r" | "\x1b" | "\t" | null,
  ) => void;
}

/**
 * Handle returned by {@link attachKoreanImeShim} for lifecycle control.
 *
 * value-object (not a method-bearing interface, but carries two
 * lifecycle methods because both must close over shim-private state).
 */
export interface KoreanImeShimHandle {
  /**
   * The DOM element appended under `.xterm-screen` (or the container
   * fallback when `.xterm-screen` is not yet available) that paints the
   * in-progress composition overlay.
   *
   * **Intentionally exposed (not a backward-compat band-aid)**: the
   * overlay's `font-size` MUST track the host terminal's font-size for
   * the overlay glyphs to remain cell-aligned. The two existing
   * surfaces drive this via:
   *   - `terminalManager.ts:122-123` — `s.imeOverlayEl.style.fontSize`
   *     updates inside `ensureGlobalSubscriptions` font-size store
   *     listener
   *   - `AgentMiniTerminal.tsx:914-915` — `imeOverlayRef.current.style
   *     .fontSize` updates inside the font-size subscription effect
   * Post-substitution those mutations route through
   * `handle.overlayEl?.style.fontSize` (the `readonly` qualifier
   * applies to the reference, not the element's mutable DOM state).
   *
   * `null` if the shim has already been disposed OR if attach happened
   * before `.xterm-screen` was in the DOM tree AND the container
   * itself was not attached (see Failure-modes).
   */
  readonly overlayEl: HTMLElement | null;

  /**
   * Re-binds the focus / preventScroll patch to the current
   * `.xterm-helper-textarea` AND retries the overlay attach if the
   * shim is in degraded-overlay mode (the `.xterm-screen` element was
   * not yet in the DOM tree at attach time — see Failure-modes).
   *
   * Idempotent on the helper textarea (no-op when called repeatedly
   * with the same underlying element) and on the overlay attach
   * (no-op once overlay is attached). Call this after a terminal
   * layout change (e.g. reattachment to a new container) that may
   * have replaced the textarea node or made the screen element
   * newly reachable.
   */
  rebind(): void;

  /**
   * Tears down everything the shim attached. **Sole-owner cleanup
   * contract**: after substitution (decomposition Nodes 6 & 7), callers
   * MUST invoke `dispose()` EXACTLY ONCE in their existing teardown path
   * and MUST NOT perform parallel manual cleanup for any of the
   * fields below — the old `imeHandlers/rebindIme/docKeyDown/docInput/
   * imeOverlayEl` (PTY pane) and `imeOverlayRef/docInputRef/
   * docKeyDownRef/imeHandlersRef` (mini pane) fields/refs are replaced
   * by the handle, not duplicated alongside it.
   *
   * Restoration steps performed by `dispose()`:
   *  - removes document-level `keydown` (capture) and `input` (capture)
   *    listeners installed at attach time
   *  - restores the ORIGINAL `terminal._core.coreService.
   *    triggerDataEvent` reference captured at attach time (the prior
   *    inline shims at `terminalManager.ts:762-798` and
   *    `AgentMiniTerminal.tsx:845-884` did NOT restore this; the
   *    helper closes the leak)
   *  - restores the ORIGINAL `isCursorHidden` PROPERTY DESCRIPTOR on
   *    `terminal._core.coreService` (not just sets `_realHidden=false`
   *    — re-defines the property via `Object.defineProperty` with the
   *    descriptor captured at attach time, so subsequent owners see a
   *    pristine property)
   *  - removes the overlay element from the DOM
   *  - restores `cursorBlink` and any other `terminal.options`
   *    mutations to their pre-attach values
   *  - removes the `compositionend` and `blur` listeners on the helper
   *    textarea
   *  - removes the `focus` listener and unpatches `helperTextarea.
   *    focus` to its native bound method
   *
   * Safe to call multiple times; second and subsequent calls are
   * no-ops (idempotent). Idempotency is on the same handle instance —
   * two handles from two attaches to the same terminal is undefined
   * (Preconditions forbid double-attach).
   */
  dispose(): void;
}

const KOREAN_CODEPOINT_RE = /[ᄀ-ᇿㄱ-ㆎ가-힣]/;

function isFullWidth(ch: string): boolean {
  const cp = ch.codePointAt(0) ?? 0;
  return (
    (cp >= 0x1100 && cp <= 0x115f) || // Hangul Jamo
    (cp >= 0x2e80 && cp <= 0x303e) || // CJK Radicals, Kangxi, CJK Symbols
    (cp >= 0x3040 && cp <= 0x33bf) || // Hiragana, Katakana, CJK Compat
    (cp >= 0x3400 && cp <= 0x4dbf) || // CJK Unified Ext A
    (cp >= 0x4e00 && cp <= 0xa4cf) || // CJK Unified, Yi
    (cp >= 0xa960 && cp <= 0xa97c) || // Hangul Jamo Extended-A
    (cp >= 0xac00 && cp <= 0xd7af) || // Hangul Syllables
    (cp >= 0xd7b0 && cp <= 0xd7ff) || // Hangul Jamo Extended-B
    (cp >= 0xf900 && cp <= 0xfaff) || // CJK Compat Ideographs
    (cp >= 0xfe30 && cp <= 0xfe6f) || // CJK Compat Forms
    (cp >= 0xff01 && cp <= 0xff60) || // Fullwidth Forms
    (cp >= 0xffe0 && cp <= 0xffe6) || // Fullwidth Signs
    (cp >= 0x20000 && cp <= 0x2fa1f) //  CJK Ext B-F, Compat Supplement
  );
}

/**
 * Responsibility: Install Canvas Terminal's Korean IME composition shim on the
 *   given xterm.js Terminal so that in-progress and committed Hangul render
 *   exactly once in WKWebView (Tauri on macOS), without the duplicate-prefix
 *   visual artefact triggered at composition-commit boundaries.
 *
 * Pipeline-position: Terminal construction (caller creates `terminal`,
 *   attaches addons, calls `terminal.open(container)`) -> THIS -> call site's
 *   own `terminal.onData` PTY forwarder. The shim sits between xterm.js's
 *   internal `triggerDataEvent` and the PTY by patching that method on
 *   `terminal._core.coreService`, intercepting Korean codepoints during
 *   composition.
 *
 * Inputs:
 *   - terminal: Terminal — an already-opened xterm.js Terminal whose
 *     `.textarea` is queryable (i.e. `terminal.open(container)` has been
 *     called). MUST have `allowProposedApi: true` if the caller depends on
 *     `_core` access, which this shim does. Caller must not double-attach
 *     the shim; behaviour with two concurrent attachments on the same
 *     Terminal is undefined.
 *   - container: HTMLElement — the DOM element passed to `terminal.open()`
 *     (or its parent that contains `.xterm-screen`). The shim queries
 *     `container.querySelector(".xterm-screen")` to position the overlay
 *     against the cell grid; falls back to `container` itself when the
 *     screen element is not yet rendered.
 *   - options: AttachKoreanImeShimOptions — see field-level docs above.
 *     `sessionId` is required; `webgl`, `defaultFontSize`,
 *     `onComposedFlush` are optional and have documented defaults /
 *     no-op semantics.
 *
 * Outputs: KoreanImeShimHandle — see type-level docs above. The handle's
 *   `dispose()` MUST be invoked during the caller's own teardown to avoid
 *   leaking document-level listeners across Terminal lifecycles.
 *
 * Side-effects:
 *   - mutates `terminal._core.coreService.triggerDataEvent` (replaces with a
 *     wrapper that defers single-codepoint Hangul characters by 20 ms to
 *     compensate for WKWebView's input-before-keydown event order)
 *   - mutates `terminal._core.coreService.isCursorHidden` (replaces the
 *     property with a getter/setter pair so shell-emitted DECTCEM cannot
 *     un-hide the cursor mid-composition)
 *   - appends a `<span>` overlay element under `.xterm-screen` (or the
 *     fallback container) and a `<style id="ime-cursor-blink-style">`
 *     element to `document.head` (only on first attach across the
 *     process; subsequent attachments reuse the existing style block)
 *   - adds document-level capture-phase `keydown` and `input` listeners
 *     (the only reliable way to observe WKWebView IME events) plus a
 *     `compositionend` and `blur` listener on `terminal.textarea`
 *   - invokes Tauri command `write_to_pty` when flushing committed
 *     compositions or terminator-suffixed flushes
 *
 * Preconditions:
 *   - `terminal.open(container)` has already been called (so
 *     `terminal.textarea` is non-null at first composition; for the
 *     edge case where the helper textarea is created lazily, the shim
 *     queries again at attach time and the caller MAY follow up with
 *     `handle.rebind()` once the textarea exists).
 *   - `terminal._core` is accessible (i.e. the caller has not enabled a
 *     stricter xterm.js wrapper that intercepts the private surface).
 *   - The shim is invoked at most once per Terminal instance.
 *
 * Postconditions:
 *   - Korean IME composition renders the current composing text exactly
 *     once at the cursor cell, without duplicating any already-committed
 *     prefix, on both WebGL and DOM renderers.
 *   - Every helper-originated PTY write (compositionend commit, blur
 *     flush, terminating-key flush) is followed by exactly one
 *     `onComposedFlush(committedText, terminator)` call when the
 *     callback is provided. `committedText` matches the payload
 *     written EXCLUDING any terminator; `terminator` reports the
 *     trailing key separately (or `null` when there was none). The
 *     callback fires AFTER the `write_to_pty` invoke is dispatched —
 *     not after it resolves, since the helper does not await the
 *     fire-and-forget promise.
 *   - All shim state is fully reachable from the returned handle's
 *     closure; calling `handle.dispose()` MUST leave the host application
 *     in a state equivalent to never having attached the shim (modulo
 *     the global `<style id="ime-cursor-blink-style">` block which is
 *     intentionally process-lifetime).
 *
 * Failure-modes:
 *   - Throws `TypeError` if `terminal._core?.coreService` is not
 *     accessible at attach time (xterm.js internal API drift). Caller
 *     should treat this as a hard upgrade-required signal; the shim
 *     refuses to attach silently because a partial attach would leave
 *     the visual bug present without any indication of why.
 *   - Degraded-overlay mode (NOT a true no-op) if
 *     `container.querySelector(".xterm-screen")` returns null AND
 *     `container` itself is not in the DOM tree: the overlay is not
 *     painted, but the `triggerDataEvent` patch, `isCursorHidden`
 *     descriptor swap, document-level capture listeners, and helper
 *     textarea bindings are STILL installed. `handle.rebind()` will
 *     retry the overlay attach once the screen/container becomes
 *     reachable, in addition to re-binding the helper textarea —
 *     callers can use this to recover overlay rendering after a
 *     deferred `terminal.open(...)` or layout change.
 *   - The `write_to_pty` invocation is fire-and-forget; rejected
 *     promises are swallowed (matching existing call sites). The shim
 *     does NOT surface PTY write failures because there is no useful
 *     recovery at this layer.
 *
 * Collaborators:
 *   - `@tauri-apps/api/core::invoke("write_to_pty", { sessionId, data })` —
 *     the only outbound IPC the shim performs.
 *   - `terminal._core._renderService.dimensions` (read-only) — for cell
 *     size used in overlay positioning.
 *   - `terminal.options.theme` (read-only) — for overlay fg/bg/cursor
 *     colors matching the host xterm theme.
 *   - `terminal.buffer.active.cursorX/Y` (read-only) — for overlay
 *     anchor coordinates.
 */
export function attachKoreanImeShim(
  terminal: Terminal,
  container: HTMLElement,
  options: AttachKoreanImeShimOptions,
): KoreanImeShimHandle {
  const { sessionId, defaultFontSize = 12, onComposedFlush } = options;
  // `options.webgl` is intentionally accepted but currently unused — preserved on
  // the contract per the skeleton's TSDoc for future renderer-asymmetric tweaks.
  void options.webgl;

  const core = (terminal as unknown as { _core?: { coreService?: CoreService } })
    ._core;
  const coreService = core?.coreService;
  if (!coreService) {
    throw new TypeError(
      "attachKoreanImeShim: terminal._core.coreService is not accessible " +
        "(xterm.js internal API drift)",
    );
  }

  let disposed = false;
  let isComposing = false;
  let imeStartPos = 0;
  let imeFlushGen = 0;
  let imeFragment = "";

  const overlayEl = document.createElement("span");
  overlayEl.style.cssText =
    `position:absolute;color:inherit;` +
    `font-family:${terminal.options.fontFamily ?? "monospace"};` +
    `font-size:${terminal.options.fontSize ?? defaultFontSize}px;` +
    `font-weight:${terminal.options.fontWeight ?? "normal"};` +
    `-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility;` +
    `pointer-events:none;` +
    `z-index:10;white-space:pre;display:none;padding:0;margin:0;`;
  const fakeCursorEl = document.createElement("span");
  fakeCursorEl.style.cssText =
    `display:inline-block;width:2px;vertical-align:top;` +
    `animation:ime-cursor-blink 1s step-end infinite;`;
  overlayEl.appendChild(fakeCursorEl);
  if (!document.getElementById("ime-cursor-blink-style")) {
    const styleEl = document.createElement("style");
    styleEl.id = "ime-cursor-blink-style";
    styleEl.textContent =
      `@keyframes ime-cursor-blink { 0%,50% { opacity: 1; } 50.01%,100% { opacity: 0; } }`;
    document.head.appendChild(styleEl);
  }

  let overlayAttached = false;
  const tryAttachOverlay = () => {
    if (overlayAttached || disposed) return;
    const screenElNow = container.querySelector(
      ".xterm-screen",
    ) as HTMLElement | null;
    if (screenElNow) {
      screenElNow.style.position = "relative";
      screenElNow.appendChild(overlayEl);
      overlayAttached = true;
    } else if (container.isConnected) {
      container.style.position = "relative";
      container.appendChild(overlayEl);
      overlayAttached = true;
    }
  };
  tryAttachOverlay();

  const origIsCursorHiddenDesc = Object.getOwnPropertyDescriptor(
    coreService,
    "isCursorHidden",
  );
  let _realHidden: boolean = Boolean(coreService.isCursorHidden);
  let cursorHidden = false;
  let cursorHiddenLock = false;
  Object.defineProperty(coreService, "isCursorHidden", {
    get() {
      return cursorHiddenLock ? true : _realHidden;
    },
    set(v: boolean) {
      if (!cursorHiddenLock) _realHidden = v;
    },
    configurable: true,
  });

  const origCursorBlink = terminal.options.cursorBlink;

  const hideCursor = () => {
    if (!cursorHidden) {
      cursorHiddenLock = true;
      terminal.options.cursorBlink = false;
      cursorHidden = true;
    }
  };
  const restoreCursorBlink = () => {
    if (cursorHidden) {
      cursorHiddenLock = false;
      terminal.options.cursorBlink = origCursorBlink ?? true;
      cursorHidden = false;
    }
  };

  const showOverlay = (text: string) => {
    imeFragment = text;
    while (overlayEl.firstChild && overlayEl.firstChild !== fakeCursorEl) {
      overlayEl.removeChild(overlayEl.firstChild);
    }
    if (!fakeCursorEl.parentNode) overlayEl.appendChild(fakeCursorEl);
    const dims = (
      terminal as unknown as {
        _core?: { _renderService?: { dimensions?: RenderDimensions } };
      }
    )._core?._renderService?.dimensions;
    if (dims) {
      const cx = terminal.buffer.active.cursorX;
      const cy = terminal.buffer.active.cursorY;
      const cellW = dims.css.cell.width;
      const cellH = dims.css.cell.height;
      const cursorColor = terminal.options.theme?.cursor ?? "#ffffff";
      overlayEl.style.fontSize = `${terminal.options.fontSize ?? defaultFontSize}px`;
      overlayEl.style.lineHeight = `${cellH}px`;
      overlayEl.style.height = `${cellH}px`;
      overlayEl.style.left = `${cx * cellW}px`;
      overlayEl.style.top = `${cy * cellH}px`;
      const bg = terminal.options.theme?.background ?? "#1a1a1a";
      const fg = terminal.options.theme?.foreground ?? "#e0e0e0";
      overlayEl.style.color = fg;
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
    overlayEl.style.display = text ? "" : "none";
    if (text) hideCursor();
  };

  const clearOverlay = () => {
    while (overlayEl.firstChild && overlayEl.firstChild !== fakeCursorEl) {
      overlayEl.removeChild(overlayEl.firstChild);
    }
    overlayEl.style.display = "none";
    imeFragment = "";
    restoreCursorBlink();
  };

  const emitFlush = (
    committedText: string,
    terminator: "\r" | "\x1b" | "\t" | null,
  ) => {
    if (!onComposedFlush) return;
    try {
      onComposedFlush(committedText, terminator);
    } catch {
      // Subscriber errors are non-fatal — never let a downstream
      // exception break the IME state machine.
    }
  };

  const onCompositionEnd = (e: CompositionEvent) => {
    let written: string | null = null;
    if (e.data && isComposing && imeFragment) {
      invoke("write_to_pty", { sessionId, data: e.data }).catch(() => {});
      written = e.data;
    }
    // Variant (b) per plan node 4: reset composition flag and overlay at the
    // syllable boundary so the next keydown(229) re-enters the
    // `if (!isComposing)` branch that updates imeStartPos. Without this,
    // imeStartPos stays anchored at the previous composition's start and
    // showOverlay(textarea.value.substring(imeStartPos)) re-paints the
    // already-committed prefix on top of the shell-echoed buffer.
    clearOverlay();
    isComposing = false;
    imeFlushGen++;
    if (written !== null) emitFlush(written, null);
  };

  const onTextareaBlur = () => {
    if (isComposing) {
      const composed = imeFragment;
      clearOverlay();
      if (composed) {
        invoke("write_to_pty", { sessionId, data: composed }).catch(() => {});
      }
      isComposing = false;
      imeFlushGen++;
      if (composed) emitFlush(composed, null);
    }
  };

  let helperTextarea: HTMLTextAreaElement | null = null;

  const docInput = (e: Event) => {
    if (e.target !== helperTextarea || !isComposing) return;
    const ie = e as InputEvent;
    if (
      ie.inputType === "insertReplacementText" ||
      ie.inputType === "insertText"
    ) {
      const ta = helperTextarea;
      if (ta) showOverlay(ta.value.substring(imeStartPos));
    }
  };
  document.addEventListener("input", docInput, true);

  const docKeyDown = (e: KeyboardEvent) => {
    if (e.target !== helperTextarea) return;
    const isEnter = e.key === "Enter" || e.code === "Enter";
    const isTerminating =
      isEnter ||
      e.key === "Escape" ||
      e.code === "Escape" ||
      e.key === "Tab" ||
      e.code === "Tab";
    if (e.keyCode === 229 && !isTerminating) {
      if (!isComposing) {
        // Variant (b): -1 because WKWebView fires `input` BEFORE `keydown`, so
        // textarea.value at keydown(229) time already contains the just-typed
        // jamo. Subtracting 1 anchors imeStartPos at the composition start.
        imeStartPos = Math.max(0, (helperTextarea?.value.length ?? 1) - 1);
      }
      isComposing = true;
      const ta = helperTextarea;
      if (ta) showOverlay(ta.value.substring(imeStartPos));
    } else if (!e.isComposing || isTerminating) {
      const isModifier =
        e.key === "Shift" ||
        e.key === "Control" ||
        e.key === "Alt" ||
        e.key === "Meta";
      if (isComposing && !isModifier) {
        const composed = imeFragment;
        clearOverlay();
        const keySuffix: "\r" | "\x1b" | "\t" | "" = isTerminating
          ? isEnter
            ? "\r"
            : e.key === "Escape" || e.code === "Escape"
              ? "\x1b"
              : "\t"
          : "";
        const data = composed + keySuffix;
        if (data) {
          invoke("write_to_pty", { sessionId, data }).catch(() => {});
        }
        imeFlushGen++;
        if (isTerminating) {
          e.stopImmediatePropagation();
          e.preventDefault();
        }
        if (composed || keySuffix) {
          emitFlush(composed, keySuffix === "" ? null : keySuffix);
        }
      }
      if (!isModifier) isComposing = false;
    }
  };
  document.addEventListener("keydown", docKeyDown, true);

  // Keep the raw original reference (for restoration on dispose) AND a bound
  // copy (for safe invocation through the wrapper — calling the raw function
  // via `origTriggerRaw(data)` would lose `this=coreService`).
  const origTriggerRaw = coreService.triggerDataEvent ?? null;
  const origTrigger = origTriggerRaw ? origTriggerRaw.bind(coreService) : null;
  if (origTrigger) {
    coreService.triggerDataEvent = (data: string, wasUserInput?: boolean) => {
      if (isComposing) return;
      // FIXME: 20ms empirically tuned for WKWebView on macOS; revalidate on major macOS bumps
      if (data.length === 1 && KOREAN_CODEPOINT_RE.test(data)) {
        const gen = imeFlushGen;
        setTimeout(() => {
          if (!disposed && !isComposing && gen === imeFlushGen) {
            origTrigger(data, wasUserInput);
          }
        }, 20);
        return;
      }
      origTrigger(data, wasUserInput);
    };
  }

  let nativeFocus: ((opts?: FocusOptions) => void) | null = null;
  let onFocus: (() => void) | null = null;

  const bindHelperTextarea = () => {
    if (disposed) return;
    const ta =
      terminal.textarea ??
      container.querySelector<HTMLTextAreaElement>(".xterm-helper-textarea");
    if (!ta) return;
    if (helperTextarea === ta) return;

    if (helperTextarea) {
      if (nativeFocus) helperTextarea.focus = nativeFocus;
      if (onFocus) helperTextarea.removeEventListener("focus", onFocus);
      helperTextarea.removeEventListener("compositionend", onCompositionEnd);
      helperTextarea.removeEventListener("blur", onTextareaBlur);
    }

    helperTextarea = ta;

    nativeFocus = ta.focus.bind(ta);
    const patchedFocus = (opts?: FocusOptions): void => {
      nativeFocus?.({ ...opts, preventScroll: true });
    };
    ta.focus = patchedFocus as typeof ta.focus;

    onFocus = () => {
      requestAnimationFrame(() => {
        document.documentElement.scrollTop = 0;
        document.documentElement.scrollLeft = 0;
        document.body.scrollTop = 0;
        document.body.scrollLeft = 0;
      });
    };
    ta.addEventListener("focus", onFocus);
    ta.addEventListener("compositionend", onCompositionEnd);
    ta.addEventListener("blur", onTextareaBlur);
  };
  bindHelperTextarea();

  const handle: KoreanImeShimHandle = {
    get overlayEl() {
      return disposed || !overlayAttached ? null : overlayEl;
    },
    rebind() {
      // Retry overlay attach in case `.xterm-screen` was not yet in the
      // DOM tree at attach time (degraded-overlay mode — see Failure-modes).
      // Idempotent: tryAttachOverlay short-circuits if already attached.
      tryAttachOverlay();
      bindHelperTextarea();
    },
    dispose() {
      if (disposed) return;
      disposed = true;

      document.removeEventListener("input", docInput, true);
      document.removeEventListener("keydown", docKeyDown, true);

      if (origTriggerRaw) {
        coreService.triggerDataEvent = origTriggerRaw;
      }

      if (origIsCursorHiddenDesc) {
        Object.defineProperty(
          coreService,
          "isCursorHidden",
          origIsCursorHiddenDesc,
        );
      } else {
        delete (coreService as { isCursorHidden?: boolean }).isCursorHidden;
      }

      terminal.options.cursorBlink = origCursorBlink;
      cursorHiddenLock = false;
      cursorHidden = false;

      if (overlayAttached && overlayEl.parentNode) {
        overlayEl.parentNode.removeChild(overlayEl);
      }
      overlayAttached = false;

      if (helperTextarea) {
        if (nativeFocus) helperTextarea.focus = nativeFocus;
        if (onFocus) helperTextarea.removeEventListener("focus", onFocus);
        helperTextarea.removeEventListener("compositionend", onCompositionEnd);
        helperTextarea.removeEventListener("blur", onTextareaBlur);
        helperTextarea = null;
      }
      nativeFocus = null;
      onFocus = null;
    },
  };

  return handle;
}

// xterm.js does not export TypeScript types for its `_core` private API.
// We declare the narrowest shapes we touch — kept inside this module so
// they don't leak into the public surface.

interface CoreService {
  isCursorHidden: boolean;
  triggerDataEvent?: (data: string, wasUserInput?: boolean) => void;
}

interface RenderDimensions {
  css: {
    cell: {
      width: number;
      height: number;
    };
  };
}
