import { Terminal } from "@xterm/xterm";

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
   * `.xterm-helper-textarea`. Idempotent when called repeatedly with
   * the same underlying element. Call this after a terminal layout
   * change (e.g. reattachment to a new container) that may have
   * replaced the textarea node.
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
 *   - Returns gracefully (no-op shim with valid handle) if
 *     `container.querySelector(".xterm-screen")` returns null AND
 *     `container` itself is not in the DOM tree; the overlay simply
 *     never paints. Caller's typing path continues to work via the
 *     unwrapped `triggerDataEvent` fall-through. This is the
 *     non-attached-yet case; `handle.rebind()` may rescue it once the
 *     element is in the tree.
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
 *
 * Note for the implementer (downstream of this skeleton): the central
 * bugfix delta from the existing inline shims lives in the
 * `compositionend` listener AND in the `keydown(229)` branch. Per the
 * planner's Phase 3 hypothesis (OQ2c + OQ3 render-only), the existing
 * shims fail to advance `imeStartPos` after a composition commits when
 * the very next keystroke begins a new composition without an
 * intervening non-IME key — so `showOverlay(textarea.value.substring(
 * imeStartPos))` re-paints the just-committed prefix on top of the
 * shell-echoed buffer. The implementer MUST first capture the
 * controlled keystroke trace (decomposition Node 1) and the buffer/PTY
 * dump (Node 2) before committing to the precise variant; the simplest
 * candidates are (a) set `imeStartPos = textarea.value.length` inside
 * `onCompositionEnd` after the `write_to_pty` invocation, or (b) reset
 * `isComposing = false` in `onCompositionEnd` so the next keydown(229)
 * re-enters the `if (!isComposing)` branch that already updates
 * `imeStartPos`. The trace MUST validate the chosen variant on both
 * surfaces (PTY pane WebGL + collab pane DOM renderer) before the
 * implementer claims completion. If the trace falsifies the render-only
 * hypothesis (buffer also contains the duplicate), escalate back to
 * planner — the fix surface moves and Path B's helper extraction
 * scope may need to widen.
 */
export declare function attachKoreanImeShim(
  terminal: Terminal,
  container: HTMLElement,
  options: AttachKoreanImeShimOptions,
): KoreanImeShimHandle;
