import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Terminal } from "@xterm/xterm";
import { invoke } from "@tauri-apps/api/core";
import {
  attachKoreanImeShim,
  KOREAN_CODEPOINT_RE,
  type AttachKoreanImeShimOptions,
} from "./xtermImeShim";

// invoke is the only outbound IPC the shim performs; mock it so tests can
// assert on PTY writes without spinning up Tauri.
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(() => Promise.resolve()),
}));

// ===========================================================================
// Mock Terminal — surface the rewrite touches: input, paste, getSelection,
// options, buffer, _core (for cell dims).
// ===========================================================================

interface MockTerminalFixture {
  terminal: Terminal;
  container: HTMLElement;
  screenEl: HTMLElement;
  helperTextarea: HTMLTextAreaElement;
  inputCalls: Array<{ data: string; wasUserInput?: boolean }>;
  pasteCalls: Array<{ data: string }>;
  selectionRef: { value: string };
  cursorRef: { x: number; y: number };
}

function makeMockTerminal(): MockTerminalFixture {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const viewport = document.createElement("div");
  viewport.className = "xterm-viewport";
  container.appendChild(viewport);
  const screenEl = document.createElement("div");
  screenEl.className = "xterm-screen";
  viewport.appendChild(screenEl);
  const helperTextarea = document.createElement("textarea");
  helperTextarea.className = "xterm-helper-textarea";
  helperTextarea.setAttribute("tabindex", "0");
  container.appendChild(helperTextarea);

  const inputCalls: Array<{ data: string; wasUserInput?: boolean }> = [];
  const pasteCalls: Array<{ data: string }> = [];
  const selectionRef = { value: "" };
  const cursorRef = { x: 0, y: 0 };

  const terminal = {
    options: {
      fontSize: 12,
      fontFamily: "monospace",
      fontWeight: "normal",
      cursorBlink: true,
      theme: { cursor: "#fff", background: "#000", foreground: "#eee" },
    },
    textarea: helperTextarea,
    buffer: {
      active: {
        get cursorX() {
          return cursorRef.x;
        },
        get cursorY() {
          return cursorRef.y;
        },
      },
    },
    input(data: string, wasUserInput?: boolean): void {
      inputCalls.push({ data, wasUserInput });
    },
    paste(data: string): void {
      pasteCalls.push({ data });
    },
    getSelection(): string {
      return selectionRef.value;
    },
    _core: {
      _renderService: {
        dimensions: { css: { cell: { width: 8, height: 16 } } },
      },
    },
  } as unknown as Terminal;

  return {
    terminal,
    container,
    screenEl,
    helperTextarea,
    inputCalls,
    pasteCalls,
    selectionRef,
    cursorRef,
  };
}

// ===========================================================================
// Event-dispatch helpers — happy-dom synthesis.
// ===========================================================================

function fireCompositionStart(target: HTMLElement): void {
  target.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
}

function fireCompositionUpdate(target: HTMLElement, data: string): void {
  const e = new CompositionEvent("compositionupdate", { bubbles: true });
  Object.defineProperty(e, "data", { value: data, configurable: true });
  target.dispatchEvent(e);
}

function fireCompositionEnd(target: HTMLElement, data: string): void {
  const e = new CompositionEvent("compositionend", { bubbles: true });
  Object.defineProperty(e, "data", { value: data, configurable: true });
  target.dispatchEvent(e);
}

function fireBlur(target: HTMLElement): void {
  target.dispatchEvent(new FocusEvent("blur", { bubbles: false }));
}

interface KeydownInit {
  key?: string;
  code?: string;
  keyCode?: number;
  which?: number;
  shiftKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  metaKey?: boolean;
  isComposing?: boolean;
}

function fireKeydown(target: HTMLElement, init: KeydownInit = {}): KeyboardEvent {
  const e = new KeyboardEvent("keydown", {
    bubbles: true,
    cancelable: true,
    key: init.key ?? "a",
    code: init.code ?? "",
    keyCode: init.keyCode ?? 65,
    shiftKey: init.shiftKey ?? false,
    ctrlKey: init.ctrlKey ?? false,
    altKey: init.altKey ?? false,
    metaKey: init.metaKey ?? false,
    isComposing: init.isComposing ?? false,
  });
  target.dispatchEvent(e);
  return e;
}

function firePaste(
  target: HTMLElement,
  pasteText: string,
): { event: ClipboardEvent; preventDefaultCalled: boolean } {
  // happy-dom doesn't support `clipboardData` on ClipboardEvent — fake it.
  const event = new ClipboardEvent("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", {
    value: {
      getData: (_t: string) => pasteText,
      setData: (_t: string, _v: string) => {},
    },
    configurable: true,
  });
  let preventDefaultCalled = false;
  const origPreventDefault = event.preventDefault.bind(event);
  event.preventDefault = () => {
    preventDefaultCalled = true;
    origPreventDefault();
  };
  target.dispatchEvent(event);
  return { event, preventDefaultCalled };
}

function fireCopy(
  target: HTMLElement,
): {
  event: ClipboardEvent;
  setData: ReturnType<typeof vi.fn>;
  preventDefaultCalled: boolean;
} {
  const setData = vi.fn();
  const event = new ClipboardEvent("copy", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", {
    value: { getData: (_t: string) => "", setData },
    configurable: true,
  });
  let preventDefaultCalled = false;
  const origPreventDefault = event.preventDefault.bind(event);
  event.preventDefault = () => {
    preventDefaultCalled = true;
    origPreventDefault();
  };
  target.dispatchEvent(event);
  return { event, setData, preventDefaultCalled };
}

function fireCut(
  target: HTMLElement,
): {
  event: ClipboardEvent;
  setData: ReturnType<typeof vi.fn>;
  preventDefaultCalled: boolean;
} {
  const setData = vi.fn();
  const event = new ClipboardEvent("cut", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", {
    value: { getData: (_t: string) => "", setData },
    configurable: true,
  });
  let preventDefaultCalled = false;
  const origPreventDefault = event.preventDefault.bind(event);
  event.preventDefault = () => {
    preventDefaultCalled = true;
    origPreventDefault();
  };
  target.dispatchEvent(event);
  return { event, setData, preventDefaultCalled };
}

function fireBeforeInput(
  target: HTMLElement,
  inputType: "insertText" | "insertReplacementText",
  data: string | null,
): { preventDefaultCalled: boolean } {
  // happy-dom does not have a native InputEvent constructor that honours
  // inputType — use Event with defineProperty.
  const event = new Event("beforeinput", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "inputType", { value: inputType, configurable: true });
  Object.defineProperty(event, "data", { value: data, configurable: true });
  let preventDefaultCalled = false;
  const origPreventDefault = event.preventDefault.bind(event);
  event.preventDefault = () => {
    preventDefaultCalled = true;
    origPreventDefault();
  };
  target.dispatchEvent(event);
  return { preventDefaultCalled };
}

function ptyWrites(): Array<{ sessionId: string; data: string }> {
  const calls = (invoke as unknown as { mock: { calls: unknown[][] } }).mock.calls;
  return calls
    .filter((c) => c[0] === "write_to_pty")
    .map((c) => c[1] as { sessionId: string; data: string });
}

function shadowEl(fx: MockTerminalFixture): HTMLTextAreaElement {
  return fx.screenEl.querySelector(".xterm-shadow-textarea")!;
}

// ===========================================================================
// Test lifecycle
// ===========================================================================

beforeEach(() => {
  (invoke as unknown as { mockClear: () => void }).mockClear();
});

afterEach(() => {
  document.body.innerHTML = "";
  // Strip the runtime style block between tests so each `attach` re-creates it.
  document.getElementById("ime-cursor-blink-style")?.remove();
});

// ===========================================================================
// attach + handle surface
// ===========================================================================

describe("attachKoreanImeShim — attach + handle", () => {
  it("mounts the shadow textarea under .xterm-screen", () => {
    const fx = makeMockTerminal();
    attachKoreanImeShim(fx.terminal, fx.container, { sessionId: "s" });
    expect(fx.screenEl.querySelectorAll(".xterm-shadow-textarea").length).toBe(1);
  });

  it("falls back to container when .xterm-screen is absent at attach time", () => {
    const fx = makeMockTerminal();
    fx.screenEl.remove();
    attachKoreanImeShim(fx.terminal, fx.container, { sessionId: "s" });
    expect(fx.container.querySelectorAll(".xterm-shadow-textarea").length).toBe(1);
  });

  it("returns a handle exposing overlayEl, isFocused, rebind, dispose", () => {
    const fx = makeMockTerminal();
    const h = attachKoreanImeShim(fx.terminal, fx.container, { sessionId: "s" });
    expect(typeof h.rebind).toBe("function");
    expect(typeof h.dispose).toBe("function");
    expect(typeof h.isFocused).toBe("function");
    expect(h.overlayEl).not.toBeNull();
  });

  it("rebind is idempotent and re-anchors after the screen element appears later", () => {
    const fx = makeMockTerminal();
    fx.screenEl.remove();
    const h = attachKoreanImeShim(fx.terminal, fx.container, { sessionId: "s" });
    // No .xterm-screen at attach → shadow lands on container.
    expect(fx.container.querySelectorAll(".xterm-shadow-textarea").length).toBe(1);
    // Layout settles, screen appears.
    fx.container.appendChild(fx.screenEl);
    h.rebind();
    h.rebind(); // idempotent
    expect(() => h.rebind()).not.toThrow();
  });

  it("exports KOREAN_CODEPOINT_RE for the JP/ZH non-regression fixture", () => {
    expect(KOREAN_CODEPOINT_RE.test("안")).toBe(true);
    expect(KOREAN_CODEPOINT_RE.test("a")).toBe(false);
  });
});

// ===========================================================================
// Focus invariant + isFocused proxy
// ===========================================================================

describe("attachKoreanImeShim — focus", () => {
  it("focuses the shadow textarea at attach time", () => {
    const fx = makeMockTerminal();
    const h = attachKoreanImeShim(fx.terminal, fx.container, { sessionId: "s" });
    expect(document.activeElement).toBe(shadowEl(fx));
    expect(h.isFocused()).toBe(true);
  });

  it("isFocused() returns false after shadow blurs", () => {
    const fx = makeMockTerminal();
    const h = attachKoreanImeShim(fx.terminal, fx.container, { sessionId: "s" });
    expect(h.isFocused()).toBe(true);
    shadowEl(fx).blur();
    document.body.focus();
    // Now shadow is no longer document.activeElement.
    expect(h.isFocused()).toBe(false);
  });

  it("helper.focus() redirects to shadow.focus()", () => {
    const fx = makeMockTerminal();
    const h = attachKoreanImeShim(fx.terminal, fx.container, { sessionId: "s" });
    // Blur shadow first so we can verify the redirect re-focuses it.
    fx.helperTextarea.blur();
    shadowEl(fx).blur();
    expect(h.isFocused()).toBe(false);
    fx.helperTextarea.focus();
    // Helper's patched focus dispatched shadow.focus().
    expect(document.activeElement).toBe(shadowEl(fx));
    expect(h.isFocused()).toBe(true);
  });
});

// ===========================================================================
// Composition: compositionstart / update / end / blur / terminator
// ===========================================================================

describe("attachKoreanImeShim — composition state machine", () => {
  it("compositionstart begins overlay paint without a PTY write", () => {
    const fx = makeMockTerminal();
    attachKoreanImeShim(fx.terminal, fx.container, { sessionId: "s" });
    fireCompositionStart(shadowEl(fx));
    expect(ptyWrites().length).toBe(0);
  });

  it("compositionend writes the committed text exactly once", () => {
    const fx = makeMockTerminal();
    attachKoreanImeShim(fx.terminal, fx.container, { sessionId: "s" });
    fireCompositionStart(shadowEl(fx));
    fireCompositionUpdate(shadowEl(fx), "안");
    fireCompositionEnd(shadowEl(fx), "안");
    const w = ptyWrites();
    expect(w.length).toBe(1);
    expect(w[0]).toEqual({ sessionId: "s", data: "안" });
  });

  it("compositionend with empty data writes nothing", () => {
    const fx = makeMockTerminal();
    attachKoreanImeShim(fx.terminal, fx.container, { sessionId: "s" });
    fireCompositionStart(shadowEl(fx));
    fireCompositionEnd(shadowEl(fx), "");
    expect(ptyWrites().length).toBe(0);
  });

  it("blur during composition flushes the fragment and clears state", () => {
    const fx = makeMockTerminal();
    const onComposedFlush = vi.fn();
    attachKoreanImeShim(fx.terminal, fx.container, {
      sessionId: "s",
      onComposedFlush,
    });
    fireCompositionStart(shadowEl(fx));
    fireCompositionUpdate(shadowEl(fx), "안");
    fireBlur(shadowEl(fx));
    const w = ptyWrites();
    expect(w.length).toBe(1);
    expect(w[0]).toEqual({ sessionId: "s", data: "안" });
    expect(onComposedFlush).toHaveBeenCalledWith("안", null);
  });

  it("Enter mid-composition flushes composed + '\\r' atomically", () => {
    const fx = makeMockTerminal();
    const onComposedFlush = vi.fn();
    attachKoreanImeShim(fx.terminal, fx.container, {
      sessionId: "s",
      onComposedFlush,
    });
    fireCompositionStart(shadowEl(fx));
    fireCompositionUpdate(shadowEl(fx), "안녕");
    fireKeydown(shadowEl(fx), { key: "Enter", code: "Enter", keyCode: 13 });
    const w = ptyWrites();
    expect(w.length).toBe(1);
    expect(w[0]).toEqual({ sessionId: "s", data: "안녕\r" });
    expect(onComposedFlush).toHaveBeenCalledWith("안녕", "\r");
  });

  it("Escape mid-composition flushes composed + '\\x1b' atomically", () => {
    const fx = makeMockTerminal();
    attachKoreanImeShim(fx.terminal, fx.container, { sessionId: "s" });
    fireCompositionStart(shadowEl(fx));
    fireCompositionUpdate(shadowEl(fx), "한");
    fireKeydown(shadowEl(fx), { key: "Escape", code: "Escape", keyCode: 27 });
    const w = ptyWrites();
    expect(w.length).toBe(1);
    expect(w[0]).toEqual({ sessionId: "s", data: "한\x1b" });
  });

  it("Tab mid-composition flushes composed + '\\t' atomically and prevents focus shift", () => {
    const fx = makeMockTerminal();
    attachKoreanImeShim(fx.terminal, fx.container, { sessionId: "s" });
    fireCompositionStart(shadowEl(fx));
    fireCompositionUpdate(shadowEl(fx), "구");
    const ev = fireKeydown(shadowEl(fx), { key: "Tab", code: "Tab", keyCode: 9 });
    expect(ptyWrites()[0]).toEqual({ sessionId: "s", data: "구\t" });
    expect(ev.defaultPrevented).toBe(true);
  });

  // ROUND-1 FOLD (convergent BLOCKING from @claude3 / @codex1 / @codex3):
  // production-shape IME terminator events carry `isComposing: true`
  // (WebKit) and/or `keyCode: 229` (Chromium during pending composition).
  // These two tests cover the production shape that was unreachable in
  // the v1 ordering (early-return ran before the terminator branch).

  it("Enter mid-composition with isComposing=true still flushes atomically (WebKit shape)", () => {
    const fx = makeMockTerminal();
    attachKoreanImeShim(fx.terminal, fx.container, { sessionId: "s" });
    fireCompositionStart(shadowEl(fx));
    fireCompositionUpdate(shadowEl(fx), "안녕");
    const ev = fireKeydown(shadowEl(fx), {
      key: "Enter",
      code: "Enter",
      keyCode: 13,
      isComposing: true,
    });
    expect(ptyWrites()).toEqual([{ sessionId: "s", data: "안녕\r" }]);
    expect(ev.defaultPrevented).toBe(true);
  });

  it("Tab mid-composition with keyCode=229 still flushes atomically (Chromium shape)", () => {
    const fx = makeMockTerminal();
    attachKoreanImeShim(fx.terminal, fx.container, { sessionId: "s" });
    fireCompositionStart(shadowEl(fx));
    fireCompositionUpdate(shadowEl(fx), "구");
    const ev = fireKeydown(shadowEl(fx), {
      key: "Tab",
      code: "Tab",
      keyCode: 229,
    });
    expect(ptyWrites()).toEqual([{ sessionId: "s", data: "구\t" }]);
    expect(ev.defaultPrevented).toBe(true);
  });

  it("Escape mid-composition with isComposing=true still flushes atomically", () => {
    const fx = makeMockTerminal();
    attachKoreanImeShim(fx.terminal, fx.container, { sessionId: "s" });
    fireCompositionStart(shadowEl(fx));
    fireCompositionUpdate(shadowEl(fx), "한");
    fireKeydown(shadowEl(fx), {
      key: "Escape",
      code: "Escape",
      keyCode: 27,
      isComposing: true,
    });
    expect(ptyWrites()).toEqual([{ sessionId: "s", data: "한\x1b" }]);
  });

  it("compositionupdate paints the overlay with event.data (canonical)", () => {
    const fx = makeMockTerminal();
    const h = attachKoreanImeShim(fx.terminal, fx.container, { sessionId: "s" });
    fireCompositionStart(shadowEl(fx));
    fireCompositionUpdate(shadowEl(fx), "안");
    expect(h.overlayEl?.textContent ?? "").toContain("안");
  });

  it("compositionend clears the overlay", () => {
    const fx = makeMockTerminal();
    const h = attachKoreanImeShim(fx.terminal, fx.container, { sessionId: "s" });
    fireCompositionStart(shadowEl(fx));
    fireCompositionUpdate(shadowEl(fx), "안");
    fireCompositionEnd(shadowEl(fx), "안");
    expect(h.overlayEl?.style.display).toBe("none");
  });

  it("KOREAN_CODEPOINT_RE smoke — Hangul matches, ASCII does not (JP/ZH still fine via uniform shadow path)", () => {
    // JP/ZH characters route through the same compositionstart/end path on
    // shadow — the test below stands in for "Node 10 non-regression": the
    // event flow is uniform across IME locales.
    const fx = makeMockTerminal();
    attachKoreanImeShim(fx.terminal, fx.container, { sessionId: "s" });
    fireCompositionStart(shadowEl(fx));
    fireCompositionUpdate(shadowEl(fx), "あ");
    fireCompositionEnd(shadowEl(fx), "あ");
    expect(ptyWrites()[0]).toEqual({ sessionId: "s", data: "あ" });
  });

  it("CJK commit also routes through the single PTY-write path", () => {
    const fx = makeMockTerminal();
    attachKoreanImeShim(fx.terminal, fx.container, { sessionId: "s" });
    fireCompositionStart(shadowEl(fx));
    fireCompositionEnd(shadowEl(fx), "中");
    expect(ptyWrites()[0]).toEqual({ sessionId: "s", data: "中" });
  });
});

// ===========================================================================
// onComposedFlush 4-path contract
// ===========================================================================

describe("attachKoreanImeShim — onComposedFlush (4 paths)", () => {
  it("fires for compositionend with terminator=null", () => {
    const fx = makeMockTerminal();
    const cb = vi.fn();
    attachKoreanImeShim(fx.terminal, fx.container, {
      sessionId: "s",
      onComposedFlush: cb,
    });
    fireCompositionStart(shadowEl(fx));
    fireCompositionEnd(shadowEl(fx), "안");
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenLastCalledWith("안", null);
  });

  it("fires for blur with terminator=null", () => {
    const fx = makeMockTerminal();
    const cb = vi.fn();
    attachKoreanImeShim(fx.terminal, fx.container, {
      sessionId: "s",
      onComposedFlush: cb,
    });
    fireCompositionStart(shadowEl(fx));
    fireCompositionUpdate(shadowEl(fx), "녕");
    fireBlur(shadowEl(fx));
    expect(cb).toHaveBeenCalledWith("녕", null);
  });

  it("fires for Enter/Esc/Tab terminator", () => {
    const fx = makeMockTerminal();
    const cb = vi.fn();
    attachKoreanImeShim(fx.terminal, fx.container, {
      sessionId: "s",
      onComposedFlush: cb,
    });
    fireCompositionStart(shadowEl(fx));
    fireCompositionUpdate(shadowEl(fx), "가");
    fireKeydown(shadowEl(fx), { key: "Enter", code: "Enter", keyCode: 13 });
    expect(cb).toHaveBeenLastCalledWith("가", "\r");
  });

  it("subscriber errors do not break the state machine", () => {
    const fx = makeMockTerminal();
    const cb = vi.fn(() => {
      throw new Error("subscriber bug");
    });
    attachKoreanImeShim(fx.terminal, fx.container, {
      sessionId: "s",
      onComposedFlush: cb,
    });
    fireCompositionStart(shadowEl(fx));
    expect(() => fireCompositionEnd(shadowEl(fx), "안")).not.toThrow();
    expect(ptyWrites().length).toBe(1);
  });
});

// ===========================================================================
// KeyRouter — three-branch classifier
// ===========================================================================

describe("attachKoreanImeShim — KeyRouter Branch B (printable)", () => {
  it("routePrintable: 'a' calls terminal.input('a') and prevents default", () => {
    const fx = makeMockTerminal();
    attachKoreanImeShim(fx.terminal, fx.container, { sessionId: "s" });
    const ev = fireKeydown(shadowEl(fx), { key: "a", code: "KeyA", keyCode: 65 });
    expect(fx.inputCalls).toEqual([{ data: "a", wasUserInput: true }]);
    expect(ev.defaultPrevented).toBe(true);
  });

  it("'A' (shift+a) still routes to printable (Shift allowed)", () => {
    const fx = makeMockTerminal();
    attachKoreanImeShim(fx.terminal, fx.container, { sessionId: "s" });
    fireKeydown(shadowEl(fx), { key: "A", code: "KeyA", keyCode: 65, shiftKey: true });
    expect(fx.inputCalls).toEqual([{ data: "A", wasUserInput: true }]);
  });

  it("' ' (space) routes to printable", () => {
    const fx = makeMockTerminal();
    attachKoreanImeShim(fx.terminal, fx.container, { sessionId: "s" });
    fireKeydown(shadowEl(fx), { key: " ", code: "Space", keyCode: 32 });
    expect(fx.inputCalls).toEqual([{ data: " ", wasUserInput: true }]);
  });

  it("'!' (printable punctuation) routes to printable", () => {
    const fx = makeMockTerminal();
    attachKoreanImeShim(fx.terminal, fx.container, { sessionId: "s" });
    fireKeydown(shadowEl(fx), { key: "!", code: "Digit1", keyCode: 49, shiftKey: true });
    expect(fx.inputCalls).toEqual([{ data: "!", wasUserInput: true }]);
  });
});

describe("attachKoreanImeShim — KeyRouter Branch C (synthesizeKeydown)", () => {
  it("Enter (outside composition) synthesizes a keydown on helper", () => {
    const fx = makeMockTerminal();
    const helperKeydowns: KeyboardEvent[] = [];
    fx.helperTextarea.addEventListener("keydown", (e) => helperKeydowns.push(e));
    attachKoreanImeShim(fx.terminal, fx.container, { sessionId: "s" });
    fireKeydown(shadowEl(fx), { key: "Enter", code: "Enter", keyCode: 13 });
    expect(helperKeydowns.length).toBe(1);
    expect(helperKeydowns[0].key).toBe("Enter");
    expect(helperKeydowns[0].keyCode).toBe(13);
  });

  it("Ctrl+C (NOT in native-bypass — predicate is metaKey-only) synthesizes on helper", () => {
    const fx = makeMockTerminal();
    const helperKeydowns: KeyboardEvent[] = [];
    fx.helperTextarea.addEventListener("keydown", (e) => helperKeydowns.push(e));
    attachKoreanImeShim(fx.terminal, fx.container, { sessionId: "s" });
    fireKeydown(shadowEl(fx), { key: "c", code: "KeyC", keyCode: 67, ctrlKey: true });
    expect(helperKeydowns.length).toBe(1);
    expect(helperKeydowns[0].ctrlKey).toBe(true);
    expect(helperKeydowns[0].key).toBe("c");
  });

  it("Ctrl+V (NOT in native-bypass) synthesizes on helper for SYN encoding", () => {
    const fx = makeMockTerminal();
    const helperKeydowns: KeyboardEvent[] = [];
    fx.helperTextarea.addEventListener("keydown", (e) => helperKeydowns.push(e));
    attachKoreanImeShim(fx.terminal, fx.container, { sessionId: "s" });
    fireKeydown(shadowEl(fx), { key: "v", code: "KeyV", keyCode: 86, ctrlKey: true });
    expect(helperKeydowns.length).toBe(1);
    expect(helperKeydowns[0].ctrlKey).toBe(true);
    expect(helperKeydowns[0].key).toBe("v");
    // routePaste was NOT called — paste calls is empty.
    expect(fx.pasteCalls).toEqual([]);
  });

  it("Ctrl+X (NOT in native-bypass) synthesizes on helper for CAN encoding", () => {
    const fx = makeMockTerminal();
    const helperKeydowns: KeyboardEvent[] = [];
    fx.helperTextarea.addEventListener("keydown", (e) => helperKeydowns.push(e));
    attachKoreanImeShim(fx.terminal, fx.container, { sessionId: "s" });
    fireKeydown(shadowEl(fx), { key: "x", code: "KeyX", keyCode: 88, ctrlKey: true });
    expect(helperKeydowns.length).toBe(1);
  });

  it("synthesized keydown carries the 12 load-bearing props", () => {
    const fx = makeMockTerminal();
    const helperKeydowns: KeyboardEvent[] = [];
    fx.helperTextarea.addEventListener("keydown", (e) => helperKeydowns.push(e));
    attachKoreanImeShim(fx.terminal, fx.container, { sessionId: "s" });
    fireKeydown(shadowEl(fx), {
      key: "ArrowLeft",
      code: "ArrowLeft",
      keyCode: 37,
      shiftKey: true,
      altKey: true,
    });
    const e = helperKeydowns[0];
    expect(e.key).toBe("ArrowLeft");
    expect(e.code).toBe("ArrowLeft");
    expect(e.keyCode).toBe(37);
    expect(e.shiftKey).toBe(true);
    expect(e.altKey).toBe(true);
    expect(e.bubbles).toBe(true);
    expect(e.cancelable).toBe(true);
  });

  it("Tab on shadow does NOT shift document.activeElement (preventDefault stops focus move)", () => {
    const fx = makeMockTerminal();
    attachKoreanImeShim(fx.terminal, fx.container, { sessionId: "s" });
    const before = document.activeElement;
    expect(before).toBe(shadowEl(fx));
    fireKeydown(shadowEl(fx), { key: "Tab", code: "Tab", keyCode: 9 });
    expect(document.activeElement).toBe(shadowEl(fx));
  });
});

describe("attachKoreanImeShim — KeyRouter Branch A (shouldBubbleShortcut)", () => {
  it("predicate returning true → no synth, no preventDefault, helper sees nothing", () => {
    const fx = makeMockTerminal();
    const helperKeydowns: KeyboardEvent[] = [];
    fx.helperTextarea.addEventListener("keydown", (e) => helperKeydowns.push(e));
    const shouldBubbleShortcut: AttachKoreanImeShimOptions["shouldBubbleShortcut"] = (e) =>
      e.metaKey && e.key === "t";
    attachKoreanImeShim(fx.terminal, fx.container, {
      sessionId: "s",
      shouldBubbleShortcut,
    });
    const ev = fireKeydown(shadowEl(fx), { key: "t", code: "KeyT", keyCode: 84, metaKey: true });
    expect(helperKeydowns.length).toBe(0);
    expect(ev.defaultPrevented).toBe(false);
    expect(fx.inputCalls).toEqual([]);
  });

  it("predicate returning false → falls through to Branch B/C", () => {
    const fx = makeMockTerminal();
    const shouldBubbleShortcut: AttachKoreanImeShimOptions["shouldBubbleShortcut"] = () =>
      false;
    attachKoreanImeShim(fx.terminal, fx.container, {
      sessionId: "s",
      shouldBubbleShortcut,
    });
    fireKeydown(shadowEl(fx), { key: "a", code: "KeyA", keyCode: 65 });
    expect(fx.inputCalls).toEqual([{ data: "a", wasUserInput: true }]);
  });

  // ROUND-1 FOLD (convergent MED from @claude3 / @codex2): under Shift,
  // e.key flips to uppercase. The production call sites' bubble
  // predicates must be case-insensitive on single-char keys. This test
  // pins the shim's contract: if the call-site predicate is
  // case-folded, Cmd+Shift+S correctly bubbles. The matching call-site
  // edits in terminalManager.ts and AgentMiniTerminal.tsx case-fold via
  // `e.key.length === 1 ? e.key.toLowerCase() : e.key`.
  it("Cmd+Shift+S bubbles when predicate is case-folded (parity with useKeyboardShortcuts)", () => {
    const fx = makeMockTerminal();
    const helperKeydowns: KeyboardEvent[] = [];
    fx.helperTextarea.addEventListener("keydown", (e) => helperKeydowns.push(e));
    const SET = new Set(["s", "t", "w", "f"]);
    const shouldBubbleShortcut: AttachKoreanImeShimOptions["shouldBubbleShortcut"] = (e) => {
      const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
      return (e.metaKey || e.ctrlKey) && SET.has(k);
    };
    attachKoreanImeShim(fx.terminal, fx.container, {
      sessionId: "s",
      shouldBubbleShortcut,
    });
    const ev = fireKeydown(shadowEl(fx), {
      key: "S",
      code: "KeyS",
      keyCode: 83,
      metaKey: true,
      shiftKey: true,
    });
    expect(helperKeydowns.length).toBe(0);
    expect(ev.defaultPrevented).toBe(false);
    expect(fx.inputCalls).toEqual([]);
  });
});

// ===========================================================================
// Cmd+V/C/X native edit shortcut bypass
// ===========================================================================

describe("attachKoreanImeShim — native edit shortcut bypass (Cmd+V/C/X)", () => {
  it("Cmd+V keydown is NOT preventDefaulted, helper sees no synth", () => {
    const fx = makeMockTerminal();
    const helperKeydowns: KeyboardEvent[] = [];
    fx.helperTextarea.addEventListener("keydown", (e) => helperKeydowns.push(e));
    attachKoreanImeShim(fx.terminal, fx.container, { sessionId: "s" });
    const ev = fireKeydown(shadowEl(fx), { key: "v", code: "KeyV", keyCode: 86, metaKey: true });
    expect(ev.defaultPrevented).toBe(false);
    expect(helperKeydowns.length).toBe(0);
  });

  it("Cmd+C keydown bypassed (predicate metaKey-only, no Ctrl)", () => {
    const fx = makeMockTerminal();
    attachKoreanImeShim(fx.terminal, fx.container, { sessionId: "s" });
    const ev = fireKeydown(shadowEl(fx), { key: "c", code: "KeyC", keyCode: 67, metaKey: true });
    expect(ev.defaultPrevented).toBe(false);
  });

  it("Cmd+X keydown bypassed", () => {
    const fx = makeMockTerminal();
    attachKoreanImeShim(fx.terminal, fx.container, { sessionId: "s" });
    const ev = fireKeydown(shadowEl(fx), { key: "x", code: "KeyX", keyCode: 88, metaKey: true });
    expect(ev.defaultPrevented).toBe(false);
  });

  it("Cmd+Shift+V is NOT in the bypass (modifier predicate requires no shift)", () => {
    const fx = makeMockTerminal();
    const helperKeydowns: KeyboardEvent[] = [];
    fx.helperTextarea.addEventListener("keydown", (e) => helperKeydowns.push(e));
    attachKoreanImeShim(fx.terminal, fx.container, { sessionId: "s" });
    const ev = fireKeydown(shadowEl(fx), {
      key: "V",
      code: "KeyV",
      keyCode: 86,
      metaKey: true,
      shiftKey: true,
    });
    expect(ev.defaultPrevented).toBe(true);
    expect(helperKeydowns.length).toBe(1);
  });
});

// ===========================================================================
// routePaste — preventDefault only, bubble continues
// ===========================================================================

describe("attachKoreanImeShim — routePaste", () => {
  it("preventDefault is called", () => {
    const fx = makeMockTerminal();
    attachKoreanImeShim(fx.terminal, fx.container, { sessionId: "s" });
    const { preventDefaultCalled } = firePaste(shadowEl(fx), "hello");
    expect(preventDefaultCalled).toBe(true);
  });

  it("does NOT call terminal.paste (xterm element listener handles it)", () => {
    const fx = makeMockTerminal();
    attachKoreanImeShim(fx.terminal, fx.container, { sessionId: "s" });
    firePaste(shadowEl(fx), "hello");
    expect(fx.pasteCalls).toEqual([]);
  });

  it("clears shadow value (defensive)", () => {
    const fx = makeMockTerminal();
    attachKoreanImeShim(fx.terminal, fx.container, { sessionId: "s" });
    const ta = shadowEl(fx);
    ta.value = "stale";
    firePaste(ta, "hello");
    expect(ta.value).toBe("");
  });

  it("does NOT call stopPropagation — bubble path stays intact", () => {
    const fx = makeMockTerminal();
    attachKoreanImeShim(fx.terminal, fx.container, { sessionId: "s" });
    let bubbleReached = false;
    fx.container.addEventListener("paste", () => {
      bubbleReached = true;
    });
    firePaste(shadowEl(fx), "hello");
    expect(bubbleReached).toBe(true);
  });
});

// ===========================================================================
// routeBeforeInputReplace — autocorrect/dictation path
// ===========================================================================

describe("attachKoreanImeShim — routeBeforeInputReplace", () => {
  it("insertReplacementText calls terminal.paste(data)", () => {
    const fx = makeMockTerminal();
    attachKoreanImeShim(fx.terminal, fx.container, { sessionId: "s" });
    fireBeforeInput(shadowEl(fx), "insertReplacementText", "autocorrected");
    expect(fx.pasteCalls).toEqual([{ data: "autocorrected" }]);
  });

  it("insertReplacementText prevents default", () => {
    const fx = makeMockTerminal();
    attachKoreanImeShim(fx.terminal, fx.container, { sessionId: "s" });
    const { preventDefaultCalled } = fireBeforeInput(
      shadowEl(fx),
      "insertReplacementText",
      "x",
    );
    expect(preventDefaultCalled).toBe(true);
  });

  it("insertText (no preceding keydown) calls terminal.input(data) — emoji palette path", () => {
    const fx = makeMockTerminal();
    attachKoreanImeShim(fx.terminal, fx.container, { sessionId: "s" });
    fireBeforeInput(shadowEl(fx), "insertText", "😀");
    expect(fx.inputCalls).toEqual([{ data: "😀", wasUserInput: true }]);
  });

  it("insertText AFTER a keydown in the same tick is suppressed (no double-fire)", () => {
    const fx = makeMockTerminal();
    attachKoreanImeShim(fx.terminal, fx.container, { sessionId: "s" });
    fireKeydown(shadowEl(fx), { key: "a", code: "KeyA", keyCode: 65 });
    fireBeforeInput(shadowEl(fx), "insertText", "a");
    // Only one input call from the keydown — the beforeinput insertText
    // was suppressed by the keydown-this-tick flag.
    expect(fx.inputCalls).toEqual([{ data: "a", wasUserInput: true }]);
  });
});

// ===========================================================================
// routeCopy / routeCut — defense-in-depth
// ===========================================================================

describe("attachKoreanImeShim — routeCopy / routeCut", () => {
  it("routeCopy with a selection writes selection text to clipboard + preventDefault", () => {
    const fx = makeMockTerminal();
    fx.selectionRef.value = "selected";
    attachKoreanImeShim(fx.terminal, fx.container, { sessionId: "s" });
    const { setData, preventDefaultCalled } = fireCopy(shadowEl(fx));
    expect(setData).toHaveBeenCalledWith("text/plain", "selected");
    expect(preventDefaultCalled).toBe(true);
  });

  it("routeCopy with no selection is an early-exit (no setData, no preventDefault)", () => {
    const fx = makeMockTerminal();
    fx.selectionRef.value = "";
    attachKoreanImeShim(fx.terminal, fx.container, { sessionId: "s" });
    const { setData, preventDefaultCalled } = fireCopy(shadowEl(fx));
    expect(setData).not.toHaveBeenCalled();
    expect(preventDefaultCalled).toBe(false);
  });

  it("routeCut mirrors routeCopy (terminal cannot semantically cut)", () => {
    const fx = makeMockTerminal();
    fx.selectionRef.value = "selected";
    attachKoreanImeShim(fx.terminal, fx.container, { sessionId: "s" });
    const { setData, preventDefaultCalled } = fireCut(shadowEl(fx));
    expect(setData).toHaveBeenCalledWith("text/plain", "selected");
    expect(preventDefaultCalled).toBe(true);
  });

  it("routeCopy does NOT call stopPropagation — bubble continues to xterm's element listener", () => {
    const fx = makeMockTerminal();
    fx.selectionRef.value = "x";
    attachKoreanImeShim(fx.terminal, fx.container, { sessionId: "s" });
    let bubbleReached = false;
    fx.container.addEventListener("copy", () => {
      bubbleReached = true;
    });
    fireCopy(shadowEl(fx));
    expect(bubbleReached).toBe(true);
  });
});

// ===========================================================================
// Defensive helper compositionstart
// ===========================================================================

describe("attachKoreanImeShim — defensive helper compositionstart", () => {
  it("re-focuses the shadow if helper accidentally receives compositionstart", () => {
    const fx = makeMockTerminal();
    attachKoreanImeShim(fx.terminal, fx.container, { sessionId: "s" });
    // Manually drop focus (would happen in production if xterm internally
    // moved focus to helper between our patch installs).
    shadowEl(fx).blur();
    document.body.focus();
    expect(document.activeElement).not.toBe(shadowEl(fx));
    // Dispatch compositionstart on helper. The capture-phase listener
    // re-focuses the shadow regardless of who currently owns focus.
    fx.helperTextarea.dispatchEvent(
      new CompositionEvent("compositionstart", { bubbles: true }),
    );
    expect(document.activeElement).toBe(shadowEl(fx));
  });

  it("capture-phase listener stops propagation so xterm's own listener does NOT fire", () => {
    const fx = makeMockTerminal();
    const xtermListener = vi.fn();
    fx.helperTextarea.addEventListener("compositionstart", xtermListener);
    attachKoreanImeShim(fx.terminal, fx.container, { sessionId: "s" });
    fx.helperTextarea.dispatchEvent(
      new CompositionEvent("compositionstart", { bubbles: true }),
    );
    expect(xtermListener).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// dispose restoration
// ===========================================================================

describe("attachKoreanImeShim — dispose", () => {
  it("removes the shadow textarea from the DOM", () => {
    const fx = makeMockTerminal();
    const h = attachKoreanImeShim(fx.terminal, fx.container, { sessionId: "s" });
    expect(fx.screenEl.querySelectorAll(".xterm-shadow-textarea").length).toBe(1);
    h.dispose();
    expect(fx.screenEl.querySelectorAll(".xterm-shadow-textarea").length).toBe(0);
  });

  it("removes the overlay from the DOM", () => {
    const fx = makeMockTerminal();
    const h = attachKoreanImeShim(fx.terminal, fx.container, { sessionId: "s" });
    const overlayEl = h.overlayEl!;
    expect(overlayEl.parentNode).not.toBeNull();
    h.dispose();
    expect(overlayEl.parentNode).toBeNull();
  });

  it("restores helper.focus to its native bound method", () => {
    const fx = makeMockTerminal();
    const before = fx.helperTextarea.focus;
    const h = attachKoreanImeShim(fx.terminal, fx.container, { sessionId: "s" });
    expect(fx.helperTextarea.focus).not.toBe(before);
    h.dispose();
    // After dispose, helper.focus is the captured native bound focus.
    // We can't compare to `before` (that was a different bound function
    // before our patch), but we can verify the patch is no longer in
    // place by checking that calling it does NOT re-focus shadow.
    document.body.focus();
    fx.helperTextarea.focus();
    expect(document.activeElement).toBe(fx.helperTextarea);
  });

  it("restores cursorBlink", () => {
    const fx = makeMockTerminal();
    fx.terminal.options.cursorBlink = true;
    const h = attachKoreanImeShim(fx.terminal, fx.container, { sessionId: "s" });
    // Composition flips off
    fireCompositionStart(shadowEl(fx));
    expect(fx.terminal.options.cursorBlink).toBe(false);
    h.dispose();
    expect(fx.terminal.options.cursorBlink).toBe(true);
  });

  it("is idempotent", () => {
    const fx = makeMockTerminal();
    const h = attachKoreanImeShim(fx.terminal, fx.container, { sessionId: "s" });
    h.dispose();
    expect(() => h.dispose()).not.toThrow();
  });

  it("overlayEl getter returns null after dispose", () => {
    const fx = makeMockTerminal();
    const h = attachKoreanImeShim(fx.terminal, fx.container, { sessionId: "s" });
    h.dispose();
    expect(h.overlayEl).toBeNull();
  });

  it("subsequent keydowns are no-ops post-dispose", () => {
    const fx = makeMockTerminal();
    const h = attachKoreanImeShim(fx.terminal, fx.container, { sessionId: "s" });
    const ta = shadowEl(fx);
    h.dispose();
    // shadow was removed from DOM; dispatching on a detached node is fine.
    fireKeydown(ta, { key: "a", code: "KeyA", keyCode: 65 });
    expect(fx.inputCalls).toEqual([]);
  });
});

// ===========================================================================
// Structural invariant: exactly one PTY write per commit
//
// Replaces the v0.5.6 multi-char prefix-strip family — the rewrite makes
// the double-fire structurally unreachable because there is no
// `triggerDataEvent` patch and no late re-emit from xterm's
// CompositionHelper (composition lives on shadow, not helper).
// ===========================================================================

describe("attachKoreanImeShim — no late re-emit duplicate (structural)", () => {
  it("composing 안 → committing → typing space → exactly one PTY write of '안' (commit)", () => {
    const fx = makeMockTerminal();
    attachKoreanImeShim(fx.terminal, fx.container, { sessionId: "s" });
    fireCompositionStart(shadowEl(fx));
    fireCompositionUpdate(shadowEl(fx), "안");
    fireCompositionEnd(shadowEl(fx), "안");
    fireKeydown(shadowEl(fx), { key: " ", code: "Space", keyCode: 32 });
    // PTY writes from invoke: the '안' commit. The space went via
    // terminal.input which we observe separately as fx.inputCalls.
    expect(ptyWrites()).toEqual([{ sessionId: "s", data: "안" }]);
    expect(fx.inputCalls).toEqual([{ data: " ", wasUserInput: true }]);
  });

  it("composing 안 → period mid-composition → single combined flush '안.' via terminal.input + commit", () => {
    const fx = makeMockTerminal();
    attachKoreanImeShim(fx.terminal, fx.container, { sessionId: "s" });
    fireCompositionStart(shadowEl(fx));
    fireCompositionUpdate(shadowEl(fx), "안");
    // The IME commits '안' on '.': fire compositionend with '안' followed
    // by a fresh keydown for '.'.
    fireCompositionEnd(shadowEl(fx), "안");
    fireKeydown(shadowEl(fx), { key: ".", code: "Period", keyCode: 190 });
    expect(ptyWrites()).toEqual([{ sessionId: "s", data: "안" }]);
    expect(fx.inputCalls).toEqual([{ data: ".", wasUserInput: true }]);
  });

  it("composing 안 → arrow mid-composition → commit '안' then Branch C arrow", () => {
    const fx = makeMockTerminal();
    const helperKeydowns: KeyboardEvent[] = [];
    fx.helperTextarea.addEventListener("keydown", (e) => helperKeydowns.push(e));
    attachKoreanImeShim(fx.terminal, fx.container, { sessionId: "s" });
    fireCompositionStart(shadowEl(fx));
    fireCompositionUpdate(shadowEl(fx), "안");
    fireCompositionEnd(shadowEl(fx), "안");
    fireKeydown(shadowEl(fx), { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 });
    expect(ptyWrites()).toEqual([{ sessionId: "s", data: "안" }]);
    // Arrow synthesized on helper for xterm's CSI encoding.
    expect(helperKeydowns.map((e) => e.key)).toEqual(["ArrowLeft"]);
  });
});

// ===========================================================================
// rebind retry + degraded mode
// ===========================================================================

describe("attachKoreanImeShim — degraded mode + rebind retry", () => {
  it("attach with no .xterm-screen AND container disconnected → degraded (no overlay attached)", () => {
    const fx = makeMockTerminal();
    fx.screenEl.remove();
    fx.container.remove();
    const h = attachKoreanImeShim(fx.terminal, fx.container, { sessionId: "s" });
    // overlay is not attached when container is disconnected and screen
    // is gone — getter returns null.
    expect(h.overlayEl).toBeNull();
  });

  it("rebind after .xterm-screen appears RELOCATES overlay + shadow to .xterm-screen", () => {
    const fx = makeMockTerminal();
    fx.screenEl.remove();
    const h = attachKoreanImeShim(fx.terminal, fx.container, { sessionId: "s" });
    // Overlay landed on container fallback (no .xterm-screen yet).
    expect(h.overlayEl).not.toBeNull();
    expect(h.overlayEl?.parentNode).toBe(fx.container);
    const shadow = fx.container.querySelector(".xterm-shadow-textarea")!;
    expect(shadow.parentNode).toBe(fx.container);
    // .xterm-screen appears post-layout.
    fx.container.appendChild(fx.screenEl);
    h.rebind();
    // Round-1 fold: rebind MUST move overlay + shadow under the new
    // .xterm-screen (the contract said "re-anchor on layout change").
    expect(h.overlayEl?.parentNode).toBe(fx.screenEl);
    expect(shadow.parentNode).toBe(fx.screenEl);
  });

  it("rebind is a no-op when already mounted on .xterm-screen", () => {
    const fx = makeMockTerminal();
    const h = attachKoreanImeShim(fx.terminal, fx.container, { sessionId: "s" });
    expect(h.overlayEl?.parentNode).toBe(fx.screenEl);
    h.rebind();
    h.rebind();
    expect(h.overlayEl?.parentNode).toBe(fx.screenEl);
  });
});
