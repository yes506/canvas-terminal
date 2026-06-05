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
   * Optional callback fired AFTER the shim has written a flushed
   * composition (composed Korean text + an optional terminating key)
   * to the PTY via `write_to_pty`. The PTY pane uses this to update
   * its line-buffer for in-app command detection (e.g. the
   * `collaborator` keyword); the collaborator-pane mini terminal
   * does not subscribe.
   *
   * @param committedText The fragment that was just sent (excluding terminator).
   * @param terminator `\r` (Enter) | `\x1b` (Escape) | `\t` (Tab) | `null` (no terminator).
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
   * in-progress composition overlay. Exposed so call sites that
   * previously held a direct ref (e.g. `managed.imeOverlayEl`) can
   * continue to release that ref during their own dispose path. May
   * be `null` if the shim has already been disposed.
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
   * Tears down everything the shim attached:
   *  - removes document-level `keydown` and `input` capture listeners
   *  - restores `terminal._core.coreService.triggerDataEvent` to the
   *    original implementation captured at attach time
   *  - removes the overlay element from the DOM
   *  - restores cursor visibility and unfreezes the
   *    `isCursorHidden` getter/setter override
   *  - removes the `compositionend` and `blur` listeners on the helper
   *    textarea
   *
   * Safe to call multiple times; subsequent calls are no-ops.
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
 *   - Successful flush via `write_to_pty` is followed by the
 *     `onComposedFlush` callback (when provided) with the same payload
 *     PLUS the terminator. Caller's `onComposedFlush` MUST NOT itself
 *     write to the PTY for the same payload — it is a notification, not
 *     a forwarder.
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
