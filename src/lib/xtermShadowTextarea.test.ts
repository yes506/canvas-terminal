import { afterEach, describe, expect, it } from "vitest";
import type { Terminal } from "@xterm/xterm";
import { createShadowTextarea } from "./xtermShadowTextarea";

// ---------------------------------------------------------------------------
// Minimal Terminal mock — only the surface ShadowTextarea reads.
// ---------------------------------------------------------------------------

interface MockFixture {
  terminal: Terminal;
  container: HTMLElement;
  screenEl: HTMLElement;
  cursorX: { value: number };
  cursorY: { value: number };
  cellSize: { width: number; height: number };
}

function makeMock(): MockFixture {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const screenEl = document.createElement("div");
  screenEl.className = "xterm-screen";
  container.appendChild(screenEl);

  const cursorX = { value: 0 };
  const cursorY = { value: 0 };
  const cellSize = { width: 8, height: 16 };

  const terminal = {
    options: { fontFamily: "monospace", fontSize: 12 },
    buffer: {
      active: {
        get cursorX() {
          return cursorX.value;
        },
        get cursorY() {
          return cursorY.value;
        },
      },
    },
    _core: {
      _renderService: {
        dimensions: {
          css: {
            cell: {
              get width() {
                return cellSize.width;
              },
              get height() {
                return cellSize.height;
              },
            },
          },
        },
      },
    },
  } as unknown as Terminal;

  return { terminal, container, screenEl, cursorX, cursorY, cellSize };
}

afterEach(() => {
  document.body.innerHTML = "";
});

// ---------------------------------------------------------------------------
// Lifecycle: mount / repositionToCursor / clearValue / dispose
// ---------------------------------------------------------------------------

describe("createShadowTextarea — mount", () => {
  it("appends a textarea under .xterm-screen when present", () => {
    const fx = makeMock();
    createShadowTextarea(fx.terminal, fx.container, 12);
    const tas = fx.screenEl.querySelectorAll("textarea");
    expect(tas.length).toBe(1);
    expect(tas[0].className).toBe("xterm-shadow-textarea");
  });

  it("falls back to container when .xterm-screen is absent but container is connected", () => {
    const fx = makeMock();
    fx.screenEl.remove();
    createShadowTextarea(fx.terminal, fx.container, 12);
    const tas = fx.container.querySelectorAll("textarea");
    expect(tas.length).toBe(1);
  });

  it("forces position:relative on the parent if it was static", () => {
    const fx = makeMock();
    createShadowTextarea(fx.terminal, fx.container, 12);
    expect(fx.screenEl.style.position).toBe("relative");
  });

  it("applies pointer-events:none so .xterm-screen still receives mouse drags", () => {
    const fx = makeMock();
    createShadowTextarea(fx.terminal, fx.container, 12);
    const ta = fx.screenEl.querySelector("textarea")!;
    expect(ta.style.pointerEvents).toBe("none");
  });

  it("applies opacity:0 + caret-color:transparent so the textarea is invisible", () => {
    const fx = makeMock();
    createShadowTextarea(fx.terminal, fx.container, 12);
    const ta = fx.screenEl.querySelector("textarea")!;
    expect(ta.style.opacity).toBe("0");
    expect(ta.style.caretColor).toBe("transparent");
  });

  it("sets aria-hidden so screen readers skip the input sink", () => {
    const fx = makeMock();
    createShadowTextarea(fx.terminal, fx.container, 12);
    const ta = fx.screenEl.querySelector("textarea")!;
    expect(ta.getAttribute("aria-hidden")).toBe("true");
  });
});

// ---------------------------------------------------------------------------
// repositionToCursor reads the cursor cell + cellW/cellH
// ---------------------------------------------------------------------------

describe("createShadowTextarea — repositionToCursor", () => {
  it("places the textarea at cursorX*cellW, cursorY*cellH", () => {
    const fx = makeMock();
    fx.cursorX.value = 3;
    fx.cursorY.value = 5;
    const shadow = createShadowTextarea(fx.terminal, fx.container, 12);
    shadow.repositionToCursor();
    const ta = fx.screenEl.querySelector("textarea")!;
    expect(ta.style.left).toBe(`${3 * 8}px`);
    expect(ta.style.top).toBe(`${5 * 16}px`);
  });

  it("sizes to a single cell (cellW × cellH)", () => {
    const fx = makeMock();
    fx.cellSize.width = 10;
    fx.cellSize.height = 20;
    const shadow = createShadowTextarea(fx.terminal, fx.container, 12);
    shadow.repositionToCursor();
    const ta = fx.screenEl.querySelector("textarea")!;
    expect(ta.style.width).toBe("10px");
    expect(ta.style.height).toBe("20px");
  });

  it("falls back to default cell dims when _core.dimensions is missing", () => {
    const fx = makeMock();
    delete (fx.terminal as unknown as { _core: { _renderService?: unknown } })
      ._core._renderService;
    const shadow = createShadowTextarea(fx.terminal, fx.container, 12);
    shadow.repositionToCursor();
    const ta = fx.screenEl.querySelector("textarea")!;
    expect(ta.style.width).toBe("8px");
    expect(ta.style.height).toBe("16px");
  });
});

// ---------------------------------------------------------------------------
// clearValue resets .value (idempotent if already empty)
// ---------------------------------------------------------------------------

describe("createShadowTextarea — clearValue", () => {
  it("resets a non-empty value to empty", () => {
    const fx = makeMock();
    const shadow = createShadowTextarea(fx.terminal, fx.container, 12);
    const ta = fx.screenEl.querySelector("textarea")! as HTMLTextAreaElement;
    ta.value = "stale";
    shadow.clearValue();
    expect(ta.value).toBe("");
  });

  it("no-op when value is already empty", () => {
    const fx = makeMock();
    const shadow = createShadowTextarea(fx.terminal, fx.container, 12);
    const ta = fx.screenEl.querySelector("textarea")! as HTMLTextAreaElement;
    shadow.clearValue();
    expect(ta.value).toBe("");
  });
});

// ---------------------------------------------------------------------------
// isFocused mirrors document.activeElement
// ---------------------------------------------------------------------------

describe("createShadowTextarea — isFocused", () => {
  it("returns false before focus() is called", () => {
    const fx = makeMock();
    const shadow = createShadowTextarea(fx.terminal, fx.container, 12);
    expect(shadow.isFocused()).toBe(false);
  });

  it("returns true after focus() is called and shadow owns document.activeElement", () => {
    const fx = makeMock();
    const shadow = createShadowTextarea(fx.terminal, fx.container, 12);
    shadow.focus();
    // happy-dom respects .focus() for elements with tabindex.
    expect(shadow.isFocused()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// dispose removes DOM
// ---------------------------------------------------------------------------

describe("createShadowTextarea — dispose", () => {
  it("removes the textarea from the DOM", () => {
    const fx = makeMock();
    const shadow = createShadowTextarea(fx.terminal, fx.container, 12);
    expect(fx.screenEl.querySelectorAll("textarea").length).toBe(1);
    shadow.dispose();
    expect(fx.screenEl.querySelectorAll("textarea").length).toBe(0);
  });

  it("textareaEl getter returns null after dispose", () => {
    const fx = makeMock();
    const shadow = createShadowTextarea(fx.terminal, fx.container, 12);
    shadow.dispose();
    expect(shadow.textareaEl).toBeNull();
  });

  it("is idempotent (second dispose is a no-op)", () => {
    const fx = makeMock();
    const shadow = createShadowTextarea(fx.terminal, fx.container, 12);
    shadow.dispose();
    expect(() => shadow.dispose()).not.toThrow();
  });

  it("repositionToCursor / clearValue / focus after dispose are no-ops", () => {
    const fx = makeMock();
    const shadow = createShadowTextarea(fx.terminal, fx.container, 12);
    shadow.dispose();
    expect(() => shadow.repositionToCursor()).not.toThrow();
    expect(() => shadow.clearValue()).not.toThrow();
    expect(() => shadow.focus()).not.toThrow();
    expect(shadow.isFocused()).toBe(false);
  });
});
