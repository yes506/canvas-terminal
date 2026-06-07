import { Terminal } from "@xterm/xterm";

/**
 * Transparent HTML `<textarea>` mounted as a sibling of `.xterm-screen`,
 * cell-aligned to the xterm cursor cell. Owns composition / keydown /
 * clipboard / beforeinput events for Korean (and JP/ZH) IME — replacing
 * xterm's `.xterm-helper-textarea` as the focus + composition target.
 *
 * Defaults to `pointer-events: none` so xterm's selection-drag layer
 * (`.xterm-screen` mousedown) still receives clicks. The textarea is
 * fully transparent (opacity 0 + caret-color transparent) so the
 * cursor-overlay span paints the visible composition state.
 *
 * State: focus owner, value buffer for composition.
 * Lifecycle: mounted in `mount`, repositioned per cursor advance,
 *   torn down in `dispose`.
 * Collaboration boundary: only `Terminal.buffer.active.cursorX/Y`
 *   and `_core._renderService.dimensions` (read-only); no PTY writes,
 *   no xterm internal mutation.
 * Failure domain: degraded mode if the screen element is absent at
 *   mount time — the textarea is still created but positioned at the
 *   container origin until `repositionToCursor` runs.
 */
export interface ShadowTextarea {
  /** The mounted DOM element. `null` after `dispose`. */
  readonly textareaEl: HTMLTextAreaElement | null;
  /** True when `document.activeElement === textareaEl`. */
  isFocused(): boolean;
  /** Sync focus to the shadow textarea (`{ preventScroll: true }`). */
  focus(): void;
  /** Realign over the current xterm cursor cell (cellW × cellH). */
  repositionToCursor(): void;
  /** Reset `.value` to empty. Defensive against stale-value accumulation. */
  clearValue(): void;
  /** Remove DOM + drop internal refs. Idempotent. */
  dispose(): void;
}

interface RenderDimensions {
  css: {
    cell: {
      width: number;
      height: number;
    };
  };
}

interface XtermCoreShape {
  _renderService?: {
    dimensions?: RenderDimensions;
  };
}

const DEFAULT_CELL_WIDTH = 8;
const DEFAULT_CELL_HEIGHT = 16;

function readCellDimensions(terminal: Terminal): {
  width: number;
  height: number;
} {
  const dims = (
    terminal as unknown as { _core?: XtermCoreShape }
  )._core?._renderService?.dimensions;
  if (!dims) {
    return { width: DEFAULT_CELL_WIDTH, height: DEFAULT_CELL_HEIGHT };
  }
  return { width: dims.css.cell.width, height: dims.css.cell.height };
}

/**
 * Mount a transparent shadow textarea over the xterm cell grid.
 *
 * The returned `ShadowTextarea` owns its DOM element until `dispose`
 * is called. Repeated `mount` calls per `attachKoreanImeShim` are not
 * supported — the orchestrator creates one shadow per attach.
 *
 * Mounting strategy:
 *   1. Prefer `.xterm-screen` as the parent so the textarea participates
 *      in the same positioned ancestor as the cell grid.
 *   2. Fall back to `container` if `.xterm-screen` is not yet in the
 *      DOM tree (degraded mode — `repositionToCursor` retries the
 *      preferred parent on layout change via the orchestrator's
 *      `rebind`).
 *
 * Style discipline:
 *   - `position: absolute` against the positioned parent.
 *   - `opacity: 0` + `caret-color: transparent`: invisible to the user.
 *   - `pointer-events: none`: xterm's selection-drag layer receives
 *     mouse events; the shadow is a "input sink only" element.
 *   - `overflow: hidden`: wheel events bubble naturally to
 *     `.xterm-viewport` for trackpad scroll.
 *   - One cell wide × one cell tall: minimal hit target; the visible
 *     composition state is painted by the cursor overlay span.
 */
export function createShadowTextarea(
  terminal: Terminal,
  container: HTMLElement,
  defaultFontSize: number,
): ShadowTextarea {
  let disposed = false;
  let mountedParent: HTMLElement | null = null;
  let textareaEl: HTMLTextAreaElement | null = document.createElement("textarea");

  // ARIA: hide from screen readers; it's a transparent input sink.
  textareaEl.setAttribute("aria-hidden", "true");
  textareaEl.setAttribute("autocapitalize", "off");
  textareaEl.setAttribute("autocomplete", "off");
  textareaEl.setAttribute("autocorrect", "off");
  textareaEl.setAttribute("spellcheck", "false");
  textareaEl.setAttribute("tabindex", "0");
  textareaEl.className = "xterm-shadow-textarea";

  const fontSize = terminal.options.fontSize ?? defaultFontSize;
  const fontFamily = terminal.options.fontFamily ?? "monospace";

  const baseStyle =
    `position:absolute;` +
    `top:0;left:0;` +
    `width:${DEFAULT_CELL_WIDTH}px;` +
    `height:${DEFAULT_CELL_HEIGHT}px;` +
    `opacity:0;` +
    `caret-color:transparent;` +
    `background:transparent;` +
    `border:none;` +
    `outline:none;` +
    `padding:0;margin:0;` +
    `resize:none;` +
    `overflow:hidden;` +
    `pointer-events:none;` +
    `z-index:10;` +
    `font-family:${fontFamily};` +
    `font-size:${fontSize}px;` +
    `white-space:pre;` +
    `color:transparent;`;
  textareaEl.style.cssText = baseStyle;

  function tryMount(): void {
    if (!textareaEl || disposed) return;
    const screenEl = container.querySelector<HTMLElement>(".xterm-screen");
    // Round-1 fold (convergent LOW-MED from @claude2 / @claude3 /
    // @codex1): if currently parked on the container fallback AND
    // `.xterm-screen` is now reachable, re-anchor under it. The
    // previous version short-circuited unconditionally on
    // `mountedParent`, so a deferred layout that brought
    // `.xterm-screen` into view never moved the textarea — breaking
    // the rebind contract.
    if (mountedParent && screenEl && mountedParent !== screenEl) {
      // Re-anchor to the preferred parent.
      if (!screenEl.style.position || screenEl.style.position === "static") {
        screenEl.style.position = "relative";
      }
      screenEl.appendChild(textareaEl);
      mountedParent = screenEl;
      return;
    }
    if (mountedParent) return;
    if (screenEl) {
      const prevPosition = screenEl.style.position;
      if (!prevPosition || prevPosition === "static") {
        screenEl.style.position = "relative";
      }
      screenEl.appendChild(textareaEl);
      mountedParent = screenEl;
      return;
    }
    if (container.isConnected) {
      if (!container.style.position || container.style.position === "static") {
        container.style.position = "relative";
      }
      container.appendChild(textareaEl);
      mountedParent = container;
    }
  }

  tryMount();

  function repositionToCursor(): void {
    if (disposed || !textareaEl) return;
    // Always re-run tryMount — it is now idempotent against the
    // preferred parent AND re-anchors from container fallback to
    // .xterm-screen when the screen element appears after attach time
    // (round-1 fold per @claude2 / @claude3 / @codex1).
    tryMount();
    const { width: cellW, height: cellH } = readCellDimensions(terminal);
    const cx = terminal.buffer.active.cursorX;
    const cy = terminal.buffer.active.cursorY;
    textareaEl.style.width = `${cellW}px`;
    textareaEl.style.height = `${cellH}px`;
    textareaEl.style.left = `${cx * cellW}px`;
    textareaEl.style.top = `${cy * cellH}px`;
  }

  function clearValue(): void {
    if (!textareaEl) return;
    if (textareaEl.value !== "") {
      textareaEl.value = "";
    }
  }

  function isFocused(): boolean {
    return !!textareaEl && document.activeElement === textareaEl;
  }

  function focus(): void {
    if (!textareaEl || disposed) return;
    try {
      textareaEl.focus({ preventScroll: true });
    } catch {
      // happy-dom or older browsers may not honor preventScroll —
      // fall back to bare focus().
      textareaEl.focus();
    }
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    if (textareaEl && textareaEl.parentNode) {
      textareaEl.parentNode.removeChild(textareaEl);
    }
    textareaEl = null;
    mountedParent = null;
  }

  return {
    get textareaEl() {
      return disposed ? null : textareaEl;
    },
    isFocused,
    focus,
    repositionToCursor,
    clearValue,
    dispose,
  };
}
