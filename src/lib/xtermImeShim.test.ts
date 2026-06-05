import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Terminal } from "@xterm/xterm";
import { invoke } from "@tauri-apps/api/core";
import {
  attachKoreanImeShim,
  type AttachKoreanImeShimOptions,
  type KoreanImeShimHandle,
} from "./xtermImeShim";

// invoke is the only outbound IPC the shim performs; mock it so tests can
// assert on PTY writes without spinning up Tauri.
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(() => Promise.resolve()),
}));

// ---------------------------------------------------------------------------
// Minimal Terminal mock — only the surface the shim touches.
// ---------------------------------------------------------------------------

interface MockTerminalFixture {
  terminal: Terminal;
  container: HTMLElement;
  textarea: HTMLTextAreaElement;
  origTriggerCalls: Array<{ data: string; wasUserInput?: boolean }>;
  coreService: {
    isCursorHidden: boolean;
    triggerDataEvent?: (data: string, wasUserInput?: boolean) => void;
  };
}

function makeMockTerminal(): MockTerminalFixture {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const screenEl = document.createElement("div");
  screenEl.className = "xterm-screen";
  container.appendChild(screenEl);
  const textarea = document.createElement("textarea");
  textarea.className = "xterm-helper-textarea";
  container.appendChild(textarea);

  const origTriggerCalls: Array<{ data: string; wasUserInput?: boolean }> = [];
  const coreService = {
    isCursorHidden: false,
    triggerDataEvent(data: string, wasUserInput?: boolean) {
      origTriggerCalls.push({ data, wasUserInput });
    },
  };

  const terminal = {
    options: {
      fontSize: 12,
      fontFamily: "monospace",
      fontWeight: "normal",
      cursorBlink: true,
      theme: { cursor: "#fff", background: "#000", foreground: "#eee" },
    },
    textarea,
    buffer: { active: { cursorX: 0, cursorY: 0 } },
    _core: {
      coreService,
      _renderService: {
        dimensions: { css: { cell: { width: 8, height: 16 } } },
      },
    },
  } as unknown as Terminal;

  return { terminal, container, textarea, origTriggerCalls, coreService };
}

// ---------------------------------------------------------------------------
// WKWebView event synthesis helpers.
//
// WKWebView fires `input` BEFORE `keydown` for IME — these helpers preserve
// that order so the shim's state machine sees the same sequencing it sees in
// production.
// ---------------------------------------------------------------------------

function fireInput(
  target: HTMLElement,
  inputType: "insertText" | "insertReplacementText",
  data: string | null = null,
): void {
  const e = new InputEvent("input", {
    inputType,
    data,
    bubbles: true,
    cancelable: false,
  });
  target.dispatchEvent(e);
}

function fireKeydown(
  target: HTMLElement,
  init: { keyCode?: number; key?: string; code?: string; isComposing?: boolean } = {},
): KeyboardEvent {
  const e = new KeyboardEvent("keydown", {
    bubbles: true,
    cancelable: true,
    key: init.key ?? "Process",
    code: init.code ?? "",
    keyCode: init.keyCode ?? 229,
    isComposing: init.isComposing ?? false,
  });
  target.dispatchEvent(e);
  return e;
}

function fireCompositionEnd(target: HTMLElement, data: string): void {
  // happy-dom's CompositionEvent constructor does not honor `data` from the
  // init dictionary, so force the property on after construction. The shim
  // reads `e.data` to detect the committed text.
  const e = new CompositionEvent("compositionend", { bubbles: true });
  Object.defineProperty(e, "data", { value: data, configurable: true });
  target.dispatchEvent(e);
}

function fireBlur(target: HTMLElement): void {
  target.dispatchEvent(new FocusEvent("blur"));
}

/** Extracts the visible composing-text content from the overlay element. */
function overlayText(overlayEl: HTMLElement | null): string {
  if (!overlayEl) return "";
  return overlayEl.textContent ?? "";
}

/** Reads the most-recent invoke('write_to_pty', ...) calls. */
function ptyWrites(): Array<{ sessionId: string; data: string }> {
  const calls = (invoke as unknown as { mock: { calls: unknown[][] } }).mock.calls;
  const out: Array<{ sessionId: string; data: string }> = [];
  for (const call of calls) {
    if (call[0] === "write_to_pty") {
      out.push(call[1] as { sessionId: string; data: string });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Lifecycle bookkeeping — every test cleans up its handles + DOM.
// ---------------------------------------------------------------------------

let attachedHandles: KoreanImeShimHandle[] = [];

function attach(
  terminal: Terminal,
  container: HTMLElement,
  opts: AttachKoreanImeShimOptions = { sessionId: "s1" },
): KoreanImeShimHandle {
  const h = attachKoreanImeShim(terminal, container, opts);
  attachedHandles.push(h);
  return h;
}

beforeEach(() => {
  (invoke as unknown as { mockClear: () => void }).mockClear();
});

afterEach(() => {
  for (const h of attachedHandles) {
    try {
      h.dispose();
    } catch {
      /* already disposed */
    }
  }
  attachedHandles = [];
  document.body.innerHTML = "";
  // Intentional: the global <style id="ime-cursor-blink-style"> is process-lifetime.
});

// ===========================================================================
// Attach / dispose lifecycle
// ===========================================================================

describe("attachKoreanImeShim — attach", () => {
  it("throws TypeError when terminal._core.coreService is missing", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const broken = {
      options: {},
      buffer: { active: { cursorX: 0, cursorY: 0 } },
    } as unknown as Terminal;
    expect(() =>
      attachKoreanImeShim(broken, container, { sessionId: "s1" }),
    ).toThrow(TypeError);
  });

  it("appends overlay under .xterm-screen when present", () => {
    const { terminal, container } = makeMockTerminal();
    const handle = attach(terminal, container);
    expect(handle.overlayEl).not.toBeNull();
    expect(handle.overlayEl?.parentElement?.classList.contains("xterm-screen")).toBe(true);
  });

  it("falls back to container when .xterm-screen is absent but container is attached", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const textarea = document.createElement("textarea");
    textarea.className = "xterm-helper-textarea";
    container.appendChild(textarea);
    const origTriggerCalls: Array<{ data: string }> = [];
    const terminal = {
      options: { fontSize: 12, cursorBlink: true },
      textarea,
      buffer: { active: { cursorX: 0, cursorY: 0 } },
      _core: {
        coreService: {
          isCursorHidden: false,
          triggerDataEvent: (data: string) => origTriggerCalls.push({ data }),
        },
        _renderService: { dimensions: { css: { cell: { width: 8, height: 16 } } } },
      },
    } as unknown as Terminal;
    const handle = attach(terminal, container);
    expect(handle.overlayEl?.parentElement).toBe(container);
  });

  it("returns no-op handle (overlayEl=null) when container is detached and has no .xterm-screen", () => {
    const container = document.createElement("div"); // intentionally NOT appended to body
    const textarea = document.createElement("textarea");
    textarea.className = "xterm-helper-textarea";
    container.appendChild(textarea);
    const terminal = {
      options: { fontSize: 12, cursorBlink: true },
      textarea,
      buffer: { active: { cursorX: 0, cursorY: 0 } },
      _core: {
        coreService: { isCursorHidden: false, triggerDataEvent: () => {} },
        _renderService: { dimensions: { css: { cell: { width: 8, height: 16 } } } },
      },
    } as unknown as Terminal;
    const handle = attach(terminal, container);
    expect(handle.overlayEl).toBeNull();
  });
});

// ===========================================================================
// Variant (b) — commit-boundary anchor fix
// ===========================================================================

describe("attachKoreanImeShim — variant (b) commit-boundary fix", () => {
  it("anchors imeStartPos at composition start after compositionend (no duplicate prefix)", () => {
    const { terminal, container, textarea } = makeMockTerminal();
    const handle = attach(terminal, container);

    // === First composition: "한" ===
    // user types ㅎ — WKWebView order: input then keydown(229)
    textarea.value = "ㅎ";
    fireInput(textarea, "insertText", "ㅎ");
    fireKeydown(textarea, { keyCode: 229 });

    // user types ㅏ → composition updates to "하"
    textarea.value = "하";
    fireInput(textarea, "insertText", "ㅏ");
    fireKeydown(textarea, { keyCode: 229 });
    expect(overlayText(handle.overlayEl)).toBe("하");

    // user types ㄴ → composition updates to "한"
    textarea.value = "한";
    fireInput(textarea, "insertText", "ㄴ");
    fireKeydown(textarea, { keyCode: 229 });
    expect(overlayText(handle.overlayEl)).toBe("한");

    // === Commit boundary: IME finalizes "한" because user starts new syllable ===
    fireCompositionEnd(textarea, "한");
    expect(ptyWrites().map((c) => c.data)).toEqual(["한"]);
    // Variant (b) postcondition: overlay cleared so the about-to-be-painted
    // shell-echo of "한" isn't double-rendered.
    expect(handle.overlayEl?.style.display).toBe("none");

    // === Next composition: "ㄱ" — WKWebView retains "한" in textarea.value ===
    textarea.value = "한ㄱ";
    fireInput(textarea, "insertText", "ㄱ");
    fireKeydown(textarea, { keyCode: 229 });

    // Variant (b) win: overlay shows ONLY "ㄱ" (substring from re-anchored
    // imeStartPos), NOT "한ㄱ" (which is the duplicate-prefix bug).
    expect(overlayText(handle.overlayEl)).toBe("ㄱ");
  });
});

// ===========================================================================
// PTY write paths + onComposedFlush emission (Postcondition #2)
// ===========================================================================

describe("attachKoreanImeShim — onComposedFlush emission", () => {
  it("fires (text, null) on compositionend commit", () => {
    const { terminal, container, textarea } = makeMockTerminal();
    const onComposedFlush = vi.fn();
    attach(terminal, container, { sessionId: "s1", onComposedFlush });

    textarea.value = "한";
    fireInput(textarea, "insertText", "한");
    fireKeydown(textarea, { keyCode: 229 });
    fireCompositionEnd(textarea, "한");

    expect(onComposedFlush).toHaveBeenCalledTimes(1);
    expect(onComposedFlush).toHaveBeenCalledWith("한", null);
  });

  it("fires (text, null) on blur during composition", () => {
    const { terminal, container, textarea } = makeMockTerminal();
    const onComposedFlush = vi.fn();
    attach(terminal, container, { sessionId: "s1", onComposedFlush });

    textarea.value = "안";
    fireInput(textarea, "insertText", "안");
    fireKeydown(textarea, { keyCode: 229 });
    fireBlur(textarea);

    expect(onComposedFlush).toHaveBeenCalledWith("안", null);
    expect(ptyWrites().map((c) => c.data)).toEqual(["안"]);
  });

  it("fires (text, '\\r') and writes composed+terminator atomically on Enter mid-composition", () => {
    const { terminal, container, textarea } = makeMockTerminal();
    const onComposedFlush = vi.fn();
    attach(terminal, container, { sessionId: "s1", onComposedFlush });

    textarea.value = "안";
    fireInput(textarea, "insertText", "안");
    fireKeydown(textarea, { keyCode: 229 });

    fireKeydown(textarea, { key: "Enter", code: "Enter", keyCode: 13 });

    expect(onComposedFlush).toHaveBeenCalledWith("안", "\r");
    expect(ptyWrites().map((c) => c.data)).toEqual(["안\r"]);
  });

  it("fires (text, '\\x1b') on Escape mid-composition", () => {
    const { terminal, container, textarea } = makeMockTerminal();
    const onComposedFlush = vi.fn();
    attach(terminal, container, { sessionId: "s1", onComposedFlush });

    textarea.value = "안";
    fireInput(textarea, "insertText", "안");
    fireKeydown(textarea, { keyCode: 229 });
    fireKeydown(textarea, { key: "Escape", code: "Escape", keyCode: 27 });

    expect(onComposedFlush).toHaveBeenCalledWith("안", "\x1b");
    expect(ptyWrites().map((c) => c.data)).toEqual(["안\x1b"]);
  });

  it("fires (text, '\\t') on Tab mid-composition", () => {
    const { terminal, container, textarea } = makeMockTerminal();
    const onComposedFlush = vi.fn();
    attach(terminal, container, { sessionId: "s1", onComposedFlush });

    textarea.value = "안";
    fireInput(textarea, "insertText", "안");
    fireKeydown(textarea, { keyCode: 229 });
    fireKeydown(textarea, { key: "Tab", code: "Tab", keyCode: 9 });

    expect(onComposedFlush).toHaveBeenCalledWith("안", "\t");
    expect(ptyWrites().map((c) => c.data)).toEqual(["안\t"]);
  });

  it("swallows subscriber exceptions (state machine still progresses)", () => {
    const { terminal, container, textarea } = makeMockTerminal();
    const onComposedFlush = vi.fn(() => {
      throw new Error("subscriber boom");
    });
    const handle = attach(terminal, container, {
      sessionId: "s1",
      onComposedFlush,
    });

    textarea.value = "안";
    fireInput(textarea, "insertText", "안");
    fireKeydown(textarea, { keyCode: 229 });
    expect(() => fireCompositionEnd(textarea, "안")).not.toThrow();
    // State machine recovered — next composition still works.
    textarea.value = "안녕";
    fireInput(textarea, "insertText", "녕");
    fireKeydown(textarea, { keyCode: 229 });
    expect(overlayText(handle.overlayEl)).toBe("녕");
  });
});

// ===========================================================================
// JP/ZH non-Korean fixture floor (plan node 10 floor)
//
// Verifies the helper's state machine doesn't special-case Hangul in its
// docKeyDown/docInput/compositionend wiring — only the triggerDataEvent
// 20ms-defer path is Korean-specific (reKorean). JP/ZH compositions ride
// the same generic pipeline.
// ===========================================================================

describe("attachKoreanImeShim — JP/ZH non-regression fixture floor (Node 10)", () => {
  it("processes JP-like keydown(229) + insertReplacementText + compositionend with exactly one PTY write, no drop, overlay rendered once", () => {
    const { terminal, container, textarea } = makeMockTerminal();
    const onComposedFlush = vi.fn();
    const handle = attach(terminal, container, {
      sessionId: "s1",
      onComposedFlush,
    });

    // JP IME via WKWebView: insertReplacementText is the typical inputType
    // for IME commits / replacements (vs insertText for keystroke-by-keystroke).
    textarea.value = "こ";
    fireInput(textarea, "insertReplacementText", "こ");
    fireKeydown(textarea, { keyCode: 229 });
    // Overlay was painted exactly once via docKeyDown's showOverlay call.
    expect(overlayText(handle.overlayEl)).toBe("こ");

    fireCompositionEnd(textarea, "こ");

    // No drop: exactly one PTY write with the committed text.
    expect(ptyWrites().map((c) => c.data)).toEqual(["こ"]);
    // No duplicate: onComposedFlush fires exactly once with terminator=null.
    expect(onComposedFlush).toHaveBeenCalledTimes(1);
    expect(onComposedFlush).toHaveBeenCalledWith("こ", null);
    // Overlay cleared after compositionend (variant (b) postcondition).
    expect(handle.overlayEl?.style.display).toBe("none");
  });

  it("does NOT 20ms-defer non-Korean single characters through triggerDataEvent", () => {
    const { terminal, container, origTriggerCalls } = makeMockTerminal();
    attach(terminal, container);
    vi.useFakeTimers();

    // After attach, the wrapped triggerDataEvent is installed on coreService.
    const cs = (terminal as unknown as { _core: { coreService: { triggerDataEvent: (d: string) => void } } })._core.coreService;
    // JP character: not in Korean range — should NOT be deferred.
    cs.triggerDataEvent("こ");
    expect(origTriggerCalls.map((c) => c.data)).toEqual(["こ"]);

    // ASCII: not in Korean range — should NOT be deferred.
    cs.triggerDataEvent("a");
    expect(origTriggerCalls.map((c) => c.data)).toEqual(["こ", "a"]);

    vi.useRealTimers();
  });
});

// ===========================================================================
// Korean-character 20ms defer through triggerDataEvent (the keydown-after-input
// race compensator) — covered as a unit for completeness.
// ===========================================================================

describe("attachKoreanImeShim — Korean triggerDataEvent defer", () => {
  it("defers single Hangul characters by 20ms when not composing", () => {
    const { terminal, container, origTriggerCalls } = makeMockTerminal();
    attach(terminal, container);
    vi.useFakeTimers();

    const cs = (terminal as unknown as { _core: { coreService: { triggerDataEvent: (d: string) => void } } })._core.coreService;
    cs.triggerDataEvent("한");
    expect(origTriggerCalls).toHaveLength(0); // deferred

    vi.advanceTimersByTime(25);
    expect(origTriggerCalls.map((c) => c.data)).toEqual(["한"]);

    vi.useRealTimers();
  });

  it("drops deferred Korean characters if composition starts before the 20ms timer fires", () => {
    const { terminal, container, textarea, origTriggerCalls } = makeMockTerminal();
    attach(terminal, container);
    vi.useFakeTimers();

    const cs = (terminal as unknown as { _core: { coreService: { triggerDataEvent: (d: string) => void } } })._core.coreService;
    cs.triggerDataEvent("한");
    // Composition starts within the 20ms window:
    textarea.value = "한";
    fireInput(textarea, "insertText", "한");
    fireKeydown(textarea, { keyCode: 229 });

    vi.advanceTimersByTime(25);
    // The deferred trigger detected isComposing=true at fire time and aborted.
    expect(origTriggerCalls).toHaveLength(0);

    vi.useRealTimers();
  });
});

// ===========================================================================
// Dispose contract (supports plan node 9 acceptance for restoration)
// ===========================================================================

describe("attachKoreanImeShim — dispose restoration", () => {
  it("restores triggerDataEvent to the original reference", () => {
    const { terminal, container, coreService } = makeMockTerminal();
    const origTrigger = coreService.triggerDataEvent;
    const handle = attach(terminal, container);
    expect(coreService.triggerDataEvent).not.toBe(origTrigger);
    handle.dispose();
    expect(coreService.triggerDataEvent).toBe(origTrigger);
  });

  it("restores isCursorHidden property descriptor", () => {
    const { terminal, container, coreService } = makeMockTerminal();
    // Capture original descriptor BEFORE attach (data property, value=false).
    const before = Object.getOwnPropertyDescriptor(coreService, "isCursorHidden");
    const handle = attach(terminal, container);
    const duringAttach = Object.getOwnPropertyDescriptor(
      coreService,
      "isCursorHidden",
    );
    // While attached, it's an accessor (has getter/setter).
    expect(duringAttach?.get).toBeDefined();
    expect(duringAttach?.set).toBeDefined();
    handle.dispose();
    const after = Object.getOwnPropertyDescriptor(coreService, "isCursorHidden");
    // After dispose, it's the original data descriptor again.
    expect(after?.get).toBeUndefined();
    expect(after?.set).toBeUndefined();
    expect(after?.value).toBe(before?.value);
  });

  it("removes the overlay element from the DOM", () => {
    const { terminal, container } = makeMockTerminal();
    const handle = attach(terminal, container);
    const overlayEl = handle.overlayEl;
    expect(overlayEl?.parentElement).not.toBeNull();
    handle.dispose();
    expect(overlayEl?.parentElement).toBeNull();
    expect(handle.overlayEl).toBeNull();
  });

  it("removes document-level keydown/input listeners (no PTY writes after dispose)", () => {
    const { terminal, container, textarea } = makeMockTerminal();
    const handle = attach(terminal, container);
    handle.dispose();

    // After dispose, IME events on the textarea should be inert from the
    // shim's perspective (no PTY writes triggered).
    textarea.value = "한";
    fireInput(textarea, "insertText", "한");
    fireKeydown(textarea, { keyCode: 229 });
    fireCompositionEnd(textarea, "한");

    expect(ptyWrites()).toEqual([]);
  });

  it("restores cursorBlink to its pre-attach value", () => {
    const { terminal, container, textarea } = makeMockTerminal();
    terminal.options.cursorBlink = true;
    const handle = attach(terminal, container);

    // Compose to force hideCursor() — turns blink off
    textarea.value = "한";
    fireInput(textarea, "insertText", "한");
    fireKeydown(textarea, { keyCode: 229 });
    expect(terminal.options.cursorBlink).toBe(false);

    handle.dispose();
    expect(terminal.options.cursorBlink).toBe(true);
  });

  it("is idempotent — second dispose is a no-op", () => {
    const { terminal, container } = makeMockTerminal();
    const handle = attach(terminal, container);
    handle.dispose();
    expect(() => handle.dispose()).not.toThrow();
  });
});
