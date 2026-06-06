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
  init: {
    keyCode?: number;
    key?: string;
    code?: string;
    isComposing?: boolean;
    shiftKey?: boolean;
    ctrlKey?: boolean;
    altKey?: boolean;
    metaKey?: boolean;
  } = {},
): KeyboardEvent {
  const e = new KeyboardEvent("keydown", {
    bubbles: true,
    cancelable: true,
    key: init.key ?? "Process",
    code: init.code ?? "",
    keyCode: init.keyCode ?? 229,
    isComposing: init.isComposing ?? false,
    shiftKey: init.shiftKey ?? false,
    ctrlKey: init.ctrlKey ?? false,
    altKey: init.altKey ?? false,
    metaKey: init.metaKey ?? false,
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

  it("enters degraded-overlay mode (overlayEl=null, other patches still installed) when container is detached and has no .xterm-screen", () => {
    const container = document.createElement("div"); // intentionally NOT appended to body
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
    expect(handle.overlayEl).toBeNull();
    // Per the Failure-modes doc: degraded-overlay mode still patches
    // triggerDataEvent (wrapper installed → captured by ASCII path test).
    const cs = (
      terminal as unknown as {
        _core: { coreService: { triggerDataEvent: (d: string) => void } };
      }
    )._core.coreService;
    cs.triggerDataEvent("a");
    expect(origTriggerCalls.map((c) => c.data)).toEqual(["a"]);
  });

  it("rebind() retries overlay attach after the container becomes reachable (F2 — round-2 fold)", () => {
    // Start with a detached container — overlay attach fails initially.
    const container = document.createElement("div");
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

    // Caller mounts the container + adds an .xterm-screen (the production
    // case where terminal.open(...) ran AFTER attachKoreanImeShim was
    // called, or where layout deferred screen rendering).
    document.body.appendChild(container);
    const screenEl = document.createElement("div");
    screenEl.className = "xterm-screen";
    container.appendChild(screenEl);

    handle.rebind();

    // Overlay is now attached under .xterm-screen.
    expect(handle.overlayEl).not.toBeNull();
    expect(
      handle.overlayEl?.parentElement?.classList.contains("xterm-screen"),
    ).toBe(true);
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
// 20ms-defer path is Korean-specific (KOREAN_CODEPOINT_RE). JP/ZH compositions ride
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

  // Round-1 fold supplementary (codex1/claude3 F1 + round-2
  // clarification): the plan.md Node 10 fixture floor at success
  // criterion 5 / Node 10 (b) literally enumerates a THREE-event
  // sequence: `keydown(229) + insertReplacementText + compositionend`.
  // The test in the previous `it(...)` block above ("processes JP-like
  // keydown(229) + insertReplacementText + compositionend with exactly
  // one PTY write") covers that 3-event sequence and PASSES with one
  // PTY write — Node 10's literal text is satisfied.
  //
  // The 4-event test below is OUTSIDE the plan's enumerated fixture: it
  // inserts xterm.js's internal `coreService.triggerDataEvent(...)`
  // between `input` and `keydown(229)`. xterm's CompositionHelper can
  // call triggerDataEvent synchronously during the `input` event for
  // committed text. For Korean the wrapper holds bytes back for 20ms
  // and discards them if a new composition starts. For non-Korean
  // (JP/ZH/etc), the wrapper at xtermImeShim.ts:570-580 falls through
  // immediately to origTrigger because KOREAN_CODEPOINT_RE.test(data)
  // is false. Then the shim's compositionend handler ALSO direct-writes
  // "こ" via invoke("write_to_pty") → PTY receives bytes twice.
  //
  // This is PRE-EXISTING behavior carried from the inline shims
  // (reKorean-only check is identical — same code, same residual). The
  // intent.korean-ime-dup-render.md::Out of scope clause covers JP/ZH
  // feature support with non-regression as the only acceptance gate;
  // identical-to-pre-refactor = no regression. Fixing the residual
  // would require widening KOREAN_CODEPOINT_RE to all single-codepoint
  // CJK ranges — that is OUTSIDE this planner's committed scope and
  // requires a separate intent / planner re-open.
  //
  // The test below PINS the current 4-event behavior so future
  // refactors of the wrapper don't silently change it. Live JP IME
  // acceptance smoke (plan node 10 ceiling) remains the authoritative
  // check for JP rendering.
  it("4-event ordering outside plan's Node 10 3-event fixture: input → triggerDataEvent → keydown(229) → compositionend pins pre-existing JP/ZH non-Korean fall-through (non-regression vs inline shims; plan widening would need planner re-open)", () => {
    const { terminal, container, textarea, origTriggerCalls } =
      makeMockTerminal();
    attach(terminal, container);

    const cs = (
      terminal as unknown as {
        _core: { coreService: { triggerDataEvent: (d: string) => void } };
      }
    )._core.coreService;

    // Simulated production order for a JP IME composing-then-committing
    // a single hiragana "こ":
    //   1. WKWebView fires `input` (insertReplacementText, data="こ")
    //   2. xterm's input handler calls coreService.triggerDataEvent("こ")
    //      synchronously — isComposing is still false because keydown(229)
    //      hasn't fired yet AND the Korean defer doesn't apply (non-Korean
    //      codepoint), so origTrigger fires immediately
    //   3. WKWebView fires `keydown(229)` → shim sets isComposing=true,
    //      paints overlay
    //   4. WKWebView fires `compositionend(data="こ")` → shim direct-writes
    //      "こ" to PTY via invoke
    //
    // Result: PTY receives 2x "こ" — one via origTrigger fall-through
    // (terminal.onData → PTY), one via direct invoke from compositionend.
    textarea.value = "こ";
    fireInput(textarea, "insertReplacementText", "こ");
    cs.triggerDataEvent("こ");
    fireKeydown(textarea, { keyCode: 229 });
    fireCompositionEnd(textarea, "こ");

    // Pinned residual: 1 origTrigger call (the non-Korean fall-through)
    // AND 1 direct PTY write (the compositionend direct-write).
    expect(origTriggerCalls.map((c) => c.data)).toEqual(["こ"]);
    expect(ptyWrites().map((c) => c.data)).toEqual(["こ"]);
    // Combined: PTY sees the byte twice (1 + 1). This is the residual
    // duplicate the test name calls out — accepted as out-of-scope for
    // korean-ime-dup-render; tracked by the JP IME live acceptance gate.
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

// ===========================================================================
// T1–T4 regression tests — korean-ime-dup-period-arrow cycle
//
// Phase 0 hypothesis tree (case d) is the validated production mechanism:
//   1. compositionend("요") fires → shim's handler writes "요" via invoke,
//      clears overlay, sets isComposing=false, increments imeFlushGen.
//   2. xterm.js's internal CompositionHelper batches the committed text and
//      calls coreService.triggerDataEvent("요") LATER (after our handler ran).
//   3. The wrapper sees isComposing=false, defers 20ms, captures
//      gen=imeFlushGen (the post-increment value from step 1).
//   4. No new composition starts within 20ms → imeFlushGen unchanged → timer
//      fires → origTrigger("요") → second "요" lands at PTY via
//      terminal.onData → terminal.write subscriber.
// The user's reported period+arrow keystroke pair is a visibility trigger
// (forces terminal redraw exposing already-buffered duplicate bytes), not
// the causal mechanism.
//
// JSDOM simulation: fireCompositionEnd is synchronous (per round-2 fold
// F3' — see plan.md), so we drive case (d) by firing compositionend
// BEFORE the deferred cs.triggerDataEvent("요"). The race observable
// (origTriggerCalls contains "요" duplicating compositionend's invoke)
// matches what production case (d) produces.
//
// Fix variant: B4 (post-compositionend defer dedup at node 9 /
// triggerDataEvent wrapper). lastCompositionCommit={text, gen} is stored
// AFTER imeFlushGen++ inside onCompositionEnd; the deferred trigger
// suppresses origTrigger when data and gen match.
// ===========================================================================

describe("attachKoreanImeShim — T1: compose → period (no duplicate)", () => {
  it("commits '요' once via compositionend; '.' flows through xterm without duplication (case b positive control)", () => {
    // Dispatch sequence: compose, period during composition (browser still
    // mid-compose → e.isComposing=true → node 7's outer condition
    // `!e.isComposing || isTerminating` is false → period bypasses node 7),
    // textarea.value mutation updates imeFragment via docInput, then
    // compositionend commits "요" via the shim's invoke. The "." would
    // flow through xterm's input handler downstream — simulated here as
    // cs.triggerDataEvent(".") (ASCII → wrapper falls through to
    // origTrigger immediately, no Korean defer).
    const { terminal, container, textarea, origTriggerCalls } =
      makeMockTerminal();
    const onComposedFlush = vi.fn();
    attach(terminal, container, { sessionId: "s1", onComposedFlush });
    const cs = (
      terminal as unknown as {
        _core: {
          coreService: {
            triggerDataEvent: (d: string, w?: boolean) => void;
          };
        };
      }
    )._core.coreService;

    textarea.value = "요";
    fireInput(textarea, "insertText", "요");
    fireKeydown(textarea, { keyCode: 229 });
    fireKeydown(textarea, {
      keyCode: 190,
      key: ".",
      code: "Period",
      isComposing: true,
    });
    textarea.value = "요.";
    fireInput(textarea, "insertText", ".");
    fireCompositionEnd(textarea, "요");
    cs.triggerDataEvent(".", true);

    expect(ptyWrites().map((c) => c.data)).toEqual(["요"]);
    expect(origTriggerCalls.map((c) => c.data)).toEqual(["."]);
    expect(onComposedFlush).toHaveBeenCalledTimes(1);
    expect(onComposedFlush).toHaveBeenCalledWith("요", null);
  });
});

describe("attachKoreanImeShim — T2: compose → arrow (no duplicate)", () => {
  it("commits '요' once via node 7 stale-state; CSI flows through xterm without duplication (case b positive control)", () => {
    // Dispatch sequence: compose, then ArrowRight with e.isComposing=false
    // (browser composition already ended at the shim's perspective). Node
    // 7's outer condition is true, isComposing(shim)===true,
    // e.key="ArrowRight" is not a modifier → inner block writes "요" via
    // invoke and clears isComposing(shim). The arrow CSI is emitted
    // downstream by xterm — simulated as cs.triggerDataEvent("\x1b[C")
    // (multi-byte, not single Korean codepoint → wrapper falls through
    // to origTrigger immediately).
    const { terminal, container, textarea, origTriggerCalls } =
      makeMockTerminal();
    const onComposedFlush = vi.fn();
    attach(terminal, container, { sessionId: "s1", onComposedFlush });
    const cs = (
      terminal as unknown as {
        _core: {
          coreService: {
            triggerDataEvent: (d: string, w?: boolean) => void;
          };
        };
      }
    )._core.coreService;

    textarea.value = "요";
    fireInput(textarea, "insertText", "요");
    fireKeydown(textarea, { keyCode: 229 });
    fireKeydown(textarea, {
      keyCode: 39,
      key: "ArrowRight",
      isComposing: false,
    });
    cs.triggerDataEvent("\x1b[C", true);

    expect(ptyWrites().map((c) => c.data)).toEqual(["요"]);
    expect(origTriggerCalls.map((c) => c.data)).toEqual(["\x1b[C"]);
    expect(onComposedFlush).toHaveBeenCalledTimes(1);
    expect(onComposedFlush).toHaveBeenCalledWith("요", null);
  });
});

describe("attachKoreanImeShim — T3: compose → period → arrow (case d, full repro)", () => {
  it("suppresses xterm's post-compositionend deferred Korean re-emit (case d)", () => {
    // Negative-baseline (Phase 0 Step 5 + Success Criterion #5, signal #2):
    // pre-fix, origTriggerCalls contains "요" duplicating the compositionend
    // invoke — combined-channel observable per plan.md Success Criterion #5
    // signal #2 ("ptyWrites... length === 1 AND origTriggerCalls... length
    // === 1"). Post-fix, B4's lastCompositionCommit dedup suppresses the
    // deferred origTrigger.
    const { terminal, container, textarea, origTriggerCalls } = makeMockTerminal();
    const onComposedFlush = vi.fn();
    attach(terminal, container, { sessionId: "s1", onComposedFlush });
    vi.useFakeTimers();
    const cs = (
      terminal as unknown as {
        _core: {
          coreService: {
            triggerDataEvent: (d: string, w?: boolean) => void;
          };
        };
      }
    )._core.coreService;

    // 1. Compose "요" — input then keydown(229) per WKWebView ordering.
    textarea.value = "요";
    fireInput(textarea, "insertText", "요");
    fireKeydown(textarea, { keyCode: 229 });

    // 2. Compositionend commits "요" via the shim's invoke. With B4,
    //    lastCompositionCommit = { text: "요", gen: imeFlushGen (post-++) }.
    fireCompositionEnd(textarea, "요");

    // 3. Models xterm's CompositionHelper batched re-emit of the committed
    //    text via coreService.triggerDataEvent("요"). The wrapper sees
    //    isComposing=false, defers 20ms, captures gen=imeFlushGen.
    cs.triggerDataEvent("요", true);

    // 4. User's reported period+arrow keystrokes — pure noise for the
    //    race (shim's isComposing is already false from step 2, so
    //    node 7's stale-state inner check skips). Included to mirror
    //    the user's flow shape.
    fireKeydown(textarea, {
      keyCode: 190,
      key: ".",
      code: "Period",
      isComposing: false,
    });
    fireKeydown(textarea, {
      keyCode: 39,
      key: "ArrowRight",
      isComposing: false,
    });

    // 5. Drive the 20ms defer past its threshold.
    vi.advanceTimersByTime(25);

    // POST-FIX: exactly one "요" reached PTY (the compositionend invoke);
    // the deferred origTrigger("요") was suppressed by B4's
    // lastCompositionCommit gen+text dedup.
    expect(ptyWrites().map((c) => c.data)).toEqual(["요"]);
    expect(origTriggerCalls.map((c) => c.data)).toEqual([]);
    expect(onComposedFlush).toHaveBeenCalledTimes(1);
    expect(onComposedFlush).toHaveBeenCalledWith("요", null);

    vi.useRealTimers();
  });
});

describe("attachKoreanImeShim — T4: modifier-augmented arrow (no duplicate)", () => {
  // T4 confirms docKeyDown's isModifier check at xtermImeShim.ts (in node 7
  // else-branch) examines e.key — which is "ArrowRight" for both Shift+Arrow
  // and Cmd+Arrow, NOT "Shift" / "Meta" — so the modifier flag does NOT
  // route around node 7 and the same fix coverage as T2 applies. Two
  // separate it() blocks (not it.each) per plan round-2 fold (claude4 G4).
  it("T4-shift: shiftKey + ArrowRight behaves identically to T2 (modifier flag does not bypass node 7)", () => {
    const { terminal, container, textarea, origTriggerCalls } =
      makeMockTerminal();
    const onComposedFlush = vi.fn();
    attach(terminal, container, { sessionId: "s1", onComposedFlush });
    const cs = (
      terminal as unknown as {
        _core: {
          coreService: {
            triggerDataEvent: (d: string, w?: boolean) => void;
          };
        };
      }
    )._core.coreService;

    textarea.value = "요";
    fireInput(textarea, "insertText", "요");
    fireKeydown(textarea, { keyCode: 229 });
    fireKeydown(textarea, {
      keyCode: 39,
      key: "ArrowRight",
      isComposing: false,
      shiftKey: true,
    });
    cs.triggerDataEvent("\x1b[1;2C", true); // Shift+Right CSI

    expect(ptyWrites().map((c) => c.data)).toEqual(["요"]);
    expect(origTriggerCalls.map((c) => c.data)).toEqual(["\x1b[1;2C"]);
    expect(onComposedFlush).toHaveBeenCalledTimes(1);
    expect(onComposedFlush).toHaveBeenCalledWith("요", null);
  });

  it("T4-meta: metaKey + ArrowRight behaves identically to T2 (modifier flag does not bypass node 7)", () => {
    const { terminal, container, textarea, origTriggerCalls } =
      makeMockTerminal();
    const onComposedFlush = vi.fn();
    attach(terminal, container, { sessionId: "s1", onComposedFlush });
    const cs = (
      terminal as unknown as {
        _core: {
          coreService: {
            triggerDataEvent: (d: string, w?: boolean) => void;
          };
        };
      }
    )._core.coreService;

    textarea.value = "요";
    fireInput(textarea, "insertText", "요");
    fireKeydown(textarea, { keyCode: 229 });
    fireKeydown(textarea, {
      keyCode: 39,
      key: "ArrowRight",
      isComposing: false,
      metaKey: true,
    });
    cs.triggerDataEvent("\x1b[1;9C", true); // Meta+Right CSI (xterm meta-as-CSI config)

    expect(ptyWrites().map((c) => c.data)).toEqual(["요"]);
    expect(origTriggerCalls.map((c) => c.data)).toEqual(["\x1b[1;9C"]);
    expect(onComposedFlush).toHaveBeenCalledTimes(1);
    expect(onComposedFlush).toHaveBeenCalledWith("요", null);
  });
});

// ===========================================================================
// Round-1 implementer-review fold (4/5 convergent: @codex2 HIGH, @codex3 MED,
// @codex4 HIGH, @claude4 LOW) — B4 dedup token must not be open-ended.
//
// The initial B4 implementation set `lastCompositionCommit` on every
// commit and only cleared it on the next `imeFlushGen`-bumping IME action
// (compositionend / blur / node-7 stale-state). Inside that window any
// legitimate same-syllable `triggerDataEvent("요")` (single-Hangul paste,
// programmatic terminal input, plugin emission, etc.) was silently dropped.
//
// Fold: two complementary safeguards
//   1. **Consume on suppress** — when the wrapper's 20 ms defer fires and
//      the B4 inner check matches, clear `lastCompositionCommit` before
//      `return`. The first xterm CompositionHelper post-commit re-emit
//      is suppressed; any subsequent same-syllable trigger passes through.
//   2. **Time-bound (40 ms)** — `onCompositionEnd` / `onTextareaBlur`
//      schedule a `setTimeout(40)` that nulls `lastCompositionCommit` if
//      it still references the same commit (token-identity check keeps
//      a newer commit safe from a stale clear).
// Combined, both close the "second trigger in same gen" and "no trigger
// ever arrives" long-tail windows.
// ===========================================================================

describe("attachKoreanImeShim — round-1 fold: B4 dedup token lifetime", () => {
  it("T5 (time-bound): a later legitimate triggerDataEvent('요') passes through after the 40ms post-commit dedup window expires", () => {
    const { terminal, container, textarea, origTriggerCalls } =
      makeMockTerminal();
    const onComposedFlush = vi.fn();
    attach(terminal, container, { sessionId: "s1", onComposedFlush });
    vi.useFakeTimers();
    const cs = (
      terminal as unknown as {
        _core: {
          coreService: {
            triggerDataEvent: (d: string, w?: boolean) => void;
          };
        };
      }
    )._core.coreService;

    // 1. Commit "요" via compositionend. Sets lastCompositionCommit and
    //    schedules the 40 ms safety clear.
    textarea.value = "요";
    fireInput(textarea, "insertText", "요");
    fireKeydown(textarea, { keyCode: 229 });
    fireCompositionEnd(textarea, "요");

    // 2. Drive past the 40 ms safety window. No xterm CompositionHelper
    //    re-emit arrives (the case-(d) window passed unused). The safety
    //    timer fires → lastCompositionCommit cleared.
    vi.advanceTimersByTime(60);

    // 3. Later legitimate triggerDataEvent("요") (e.g., single-Hangul
    //    paste, plugin emission, or programmatic terminal input). With
    //    the token cleared, this schedules a normal 20 ms defer.
    cs.triggerDataEvent("요", true);
    vi.advanceTimersByTime(25);

    // Pass-through: dedup did not fire (token was already null).
    expect(origTriggerCalls.map((c) => c.data)).toEqual(["요"]);
    expect(ptyWrites().map((c) => c.data)).toEqual(["요"]);

    vi.useRealTimers();
  });

  it("T8 (non-matching Hangul preserves token): a non-matching single-Hangul triggerDataEvent does NOT consume the dedup token meant for the matching duplicate", () => {
    // Round-3 implementer-review fold (3/5 convergent: @codex2 MED,
    // @codex3 MED, @codex4 LOW). Round-2's claim-at-schedule
    // captured AND nullified the live token unconditionally for any
    // single-Hangul triggerDataEvent. A non-matching event ("한")
    // arriving between compositionend("요") and xterm's case-(d)
    // re-emit of "요" would consume the "요" token, leaving the
    // actual duplicate uncovered → it would escape via origTrigger.
    // Round-3 fix: claim only when data + gen match the live commit.
    // Non-matching events pass through normally without touching the
    // live token; the matching duplicate later captures and suppresses.
    const { terminal, container, textarea, origTriggerCalls } =
      makeMockTerminal();
    const onComposedFlush = vi.fn();
    attach(terminal, container, { sessionId: "s1", onComposedFlush });
    vi.useFakeTimers();
    const cs = (
      terminal as unknown as {
        _core: {
          coreService: {
            triggerDataEvent: (d: string, w?: boolean) => void;
          };
        };
      }
    )._core.coreService;

    // 1. Commit "요" at t=0. Live token = {text:"요", gen:1}.
    textarea.value = "요";
    fireInput(textarea, "insertText", "요");
    fireKeydown(textarea, { keyCode: 229 });
    fireCompositionEnd(textarea, "요");

    // 2. Non-matching single-Hangul event "한" arrives at t=10 ms
    //    (e.g., paste of a different syllable while "요" commit is
    //    still pending its case-(d) re-emit window). Round-3 fix:
    //    isCandidate is false ("한" !== "요"), so the live token
    //    is NOT nullified; "한" gets a normal 20 ms defer with
    //    claim=null and will pass through.
    vi.advanceTimersByTime(10);
    cs.triggerDataEvent("한", true);

    // 3. The actual delayed xterm CompositionHelper duplicate of "요"
    //    arrives at t=25 ms. isCandidate is true (live still set,
    //    data + gen match), so we capture+null. Defer scheduled at
    //    t=45 ms → suppress.
    vi.advanceTimersByTime(15);
    cs.triggerDataEvent("요", true);

    // 4. Advance past both 20 ms defers AND the 40 ms safety clear.
    vi.advanceTimersByTime(30);

    // POST-FOLD: "한" passes through (non-matching); "요" duplicate
    // suppressed.
    // PRE-FOLD (round-2): claim=X consumed at t=10 by "한"; "요" at
    //   t=25 captures claim=null; "한" defer falls through (mismatch);
    //   "요" defer falls through (claim=null) → BOTH "한" AND "요"
    //   land in origTriggerCalls → duplicate escapes.
    expect(origTriggerCalls.map((c) => c.data)).toEqual(["한"]);
    expect(ptyWrites().map((c) => c.data)).toEqual(["요"]);
    expect(onComposedFlush).toHaveBeenCalledTimes(1);
    expect(onComposedFlush).toHaveBeenCalledWith("요", null);

    vi.useRealTimers();
  });

  it("T7 (delayed duplicate inside 40ms window): a delayed xterm CompositionHelper re-emit at t=25ms is suppressed via claim-at-schedule (race-free against safety clear)", () => {
    // Round-2 implementer-review fold (3/5 convergent: @codex2 MEDIUM,
    // @codex3 HIGH, @codex4 HIGH). Pre-fold (round-1) failed this case:
    // the 40 ms safety clear runs at t=40 ms (15 ms BEFORE the duplicate's
    // 20 ms defer callback at t=45 ms), nulling lastCompositionCommit
    // before suppression can fire → duplicate escapes via origTrigger.
    // Round-2 fix: claim-at-schedule binds the live token into the defer
    // closure at trigger-arrival time, so the suppression decision is
    // race-free against the safety clear.
    const { terminal, container, textarea, origTriggerCalls } =
      makeMockTerminal();
    const onComposedFlush = vi.fn();
    attach(terminal, container, { sessionId: "s1", onComposedFlush });
    vi.useFakeTimers();
    const cs = (
      terminal as unknown as {
        _core: {
          coreService: {
            triggerDataEvent: (d: string, w?: boolean) => void;
          };
        };
      }
    )._core.coreService;

    // 1. Commit "요" at t=0. Sets lastCompositionCommit; schedules 40 ms
    //    safety clear for t=40.
    textarea.value = "요";
    fireInput(textarea, "insertText", "요");
    fireKeydown(textarea, { keyCode: 229 });
    fireCompositionEnd(textarea, "요");

    // 2. Simulate xterm's CompositionHelper post-commit latency — the
    //    duplicate re-emit arrives at t=25 ms, well inside the documented
    //    40 ms dedup window. Its own 20 ms defer schedules for t=45 ms.
    vi.advanceTimersByTime(25);
    cs.triggerDataEvent("요", true);

    // 3. Advance past both the safety timer (fires at t=40) AND the
    //    defer (fires at t=45). Pre-fold: safety fires first, nullifies
    //    token, defer sees null → origTrigger("요"). Post-fold: claim
    //    was captured at t=25 (in-closure), so defer at t=45 still
    //    matches → suppress.
    vi.advanceTimersByTime(25);

    expect(ptyWrites().map((c) => c.data)).toEqual(["요"]);
    expect(origTriggerCalls.map((c) => c.data)).toEqual([]);
    expect(onComposedFlush).toHaveBeenCalledTimes(1);
    expect(onComposedFlush).toHaveBeenCalledWith("요", null);

    vi.useRealTimers();
  });

  it("T6 (consume-on-suppress): after the first case-(d) suppression, a later legitimate triggerDataEvent('요') in the same generation passes through", () => {
    const { terminal, container, textarea, origTriggerCalls } =
      makeMockTerminal();
    const onComposedFlush = vi.fn();
    attach(terminal, container, { sessionId: "s1", onComposedFlush });
    vi.useFakeTimers();
    const cs = (
      terminal as unknown as {
        _core: {
          coreService: {
            triggerDataEvent: (d: string, w?: boolean) => void;
          };
        };
      }
    )._core.coreService;

    // 1. Commit "요" via compositionend.
    textarea.value = "요";
    fireInput(textarea, "insertText", "요");
    fireKeydown(textarea, { keyCode: 229 });
    fireCompositionEnd(textarea, "요");

    // 2. Case-(d) xterm CompositionHelper re-emit. Wrapper defers; timer
    //    fires within the window → dedup suppress + consume.
    cs.triggerDataEvent("요", true);
    vi.advanceTimersByTime(25);
    expect(origTriggerCalls.map((c) => c.data)).toEqual([]);

    // 3. Later legitimate same-syllable triggerDataEvent in the same
    //    imeFlushGen generation (no intervening IME activity). With the
    //    token consumed by step 2's suppression, this passes through.
    cs.triggerDataEvent("요", true);
    vi.advanceTimersByTime(25);

    expect(origTriggerCalls.map((c) => c.data)).toEqual(["요"]);
    expect(ptyWrites().map((c) => c.data)).toEqual(["요"]);

    vi.useRealTimers();
  });
});

// ===========================================================================
// korean-ime-dup-space: multi-char prefix-strip dedup path (N2-N5)
// ===========================================================================

describe("attachKoreanImeShim — multi-char prefix strip", () => {
  it("T-space (positive repro): drops late '녕 ' substring; the synchronous _keyDown space survives once", () => {
    // Repro from task-1-claude1-report.md: typing 녕 then SPACE mid-composition.
    // Under Order B (WKWebView Korean IME) the trailing space is emitted via
    // xterm._keyDown's synchronous triggerDataEvent(" ") BEFORE the late
    // CompositionHelper setTimeout(0) substring "녕 " arrives. The new
    // prefix-strip drops the entire late substring (P6 FULL SUPPRESSION) so
    // the user sees "녕 " (one space), not "녕 녕 " (re-emitted prefix) or
    // "녕  " (re-emitted trailing).
    const { terminal, container, textarea, origTriggerCalls } =
      makeMockTerminal();
    const onComposedFlush = vi.fn();
    attach(terminal, container, { sessionId: "s1", onComposedFlush });
    vi.useFakeTimers();
    const cs = (
      terminal as unknown as {
        _core: {
          coreService: {
            triggerDataEvent: (d: string, w?: boolean) => void;
          };
        };
      }
    )._core.coreService;

    // 1. Commit "녕" via compositionend.
    textarea.value = "녕";
    fireInput(textarea, "insertText", "녕");
    fireKeydown(textarea, { keyCode: 229 });
    fireCompositionEnd(textarea, "녕");

    // 2. Order B trailing: xterm._keyDown synchronously emits ASCII " ".
    textarea.value = "녕 ";
    cs.triggerDataEvent(" ", true);

    // 3. xterm CompositionHelper late substring re-emit:
    //    textarea.value.substring(start) = "녕 ". New prefix-strip drops it.
    cs.triggerDataEvent("녕 ", true);

    // 4. Drain the 40 ms safety-clear timer cleanly.
    vi.advanceTimersByTime(60);

    // Direct PTY writes: only "녕" from onCompositionEnd's invoke().
    expect(ptyWrites().map((c) => c.data)).toEqual(["녕"]);
    // Indirect via origTrigger: exactly one space — NOT [" ", " "] (which
    // a re-emit-trailing fix would produce) and NOT [" ", "녕 "] (which
    // baseline produces).
    expect(origTriggerCalls.map((c) => c.data)).toEqual([" "]);
    expect(onComposedFlush).toHaveBeenCalledTimes(1);
    expect(onComposedFlush).toHaveBeenCalledWith("녕", null);

    vi.useRealTimers();
  });

  it("T-digit (positive repro, ASCII generality): drops late '녕2' substring; the digit survives once", () => {
    // Same Order-B mechanism as T-space; this pins generality across ASCII
    // trailing chars (digits are not terminators and do not end composition
    // before xterm's setTimeout(0) fires).
    const { terminal, container, textarea, origTriggerCalls } =
      makeMockTerminal();
    const onComposedFlush = vi.fn();
    attach(terminal, container, { sessionId: "s1", onComposedFlush });
    vi.useFakeTimers();
    const cs = (
      terminal as unknown as {
        _core: {
          coreService: {
            triggerDataEvent: (d: string, w?: boolean) => void;
          };
        };
      }
    )._core.coreService;

    textarea.value = "녕";
    fireInput(textarea, "insertText", "녕");
    fireKeydown(textarea, { keyCode: 229 });
    fireCompositionEnd(textarea, "녕");

    textarea.value = "녕2";
    cs.triggerDataEvent("2", true);
    cs.triggerDataEvent("녕2", true);

    vi.advanceTimersByTime(60);

    expect(ptyWrites().map((c) => c.data)).toEqual(["녕"]);
    expect(origTriggerCalls.map((c) => c.data)).toEqual(["2"]);
    expect(onComposedFlush).toHaveBeenCalledTimes(1);
    expect(onComposedFlush).toHaveBeenCalledWith("녕", null);

    vi.useRealTimers();
  });

  it("T-non-matching-multi-char (over-suppression guard): an unrelated multi-char payload after a commit flows through verbatim", () => {
    // After "녕" commits, simulate an emission of "한자" (e.g. a paste
    // landing inside the 40 ms dedup window). The strip's prefix check
    // ("한자".startsWith("녕")) is false, so the strip does NOT fire and
    // the payload reaches origTrigger verbatim. Prevents over-suppression
    // of legitimate multi-char pastes / IME emissions that happen to
    // coincide with the dedup window.
    const { terminal, container, textarea, origTriggerCalls } =
      makeMockTerminal();
    const onComposedFlush = vi.fn();
    attach(terminal, container, { sessionId: "s1", onComposedFlush });
    vi.useFakeTimers();
    const cs = (
      terminal as unknown as {
        _core: {
          coreService: {
            triggerDataEvent: (d: string, w?: boolean) => void;
          };
        };
      }
    )._core.coreService;

    textarea.value = "녕";
    fireInput(textarea, "insertText", "녕");
    fireKeydown(textarea, { keyCode: 229 });
    fireCompositionEnd(textarea, "녕");

    // Paste of "한자" landing during the dedup window — different syllables,
    // does not start with the live token's text.
    cs.triggerDataEvent("한자", true);

    vi.advanceTimersByTime(60);

    // Strip does NOT fire (prefix mismatch); payload flows through verbatim.
    expect(origTriggerCalls.map((c) => c.data)).toEqual(["한자"]);
    // No additional PTY writes beyond the original commit.
    expect(ptyWrites().map((c) => c.data)).toEqual(["녕"]);

    vi.useRealTimers();
  });

  it("T-replaced-token (defense-in-depth): after the live token has been replaced by a subsequent commit, a stale-prefix multi-char payload flows through verbatim", () => {
    // Setup: commit "녕" (sets live = {text:"녕", gen:1}). Drive a SECOND
    // composition that commits "어" — this replaces lastCompositionCommit
    // to {text:"어", gen:2} AND advances imeFlushGen. Then fire a stale-
    // prefix multi-char payload "녕 ". The strip MUST NOT fire — the prefix
    // check ("녕 ".startsWith("어")) fails first; the gen check is defense-
    // in-depth that would also catch it if lastCompositionCommit ever
    // decoupled from imeFlushGen in a future refactor.
    const { terminal, container, textarea, origTriggerCalls } =
      makeMockTerminal();
    const onComposedFlush = vi.fn();
    attach(terminal, container, { sessionId: "s1", onComposedFlush });
    vi.useFakeTimers();
    const cs = (
      terminal as unknown as {
        _core: {
          coreService: {
            triggerDataEvent: (d: string, w?: boolean) => void;
          };
        };
      }
    )._core.coreService;

    // 1. First composition commits "녕".
    textarea.value = "녕";
    fireInput(textarea, "insertText", "녕");
    fireKeydown(textarea, { keyCode: 229 });
    fireCompositionEnd(textarea, "녕");

    // 2. Second composition commits "어" — replaces the live token's text
    //    AND advances imeFlushGen (post-increment at compositionend).
    textarea.value = "어";
    fireInput(textarea, "insertText", "어");
    fireKeydown(textarea, { keyCode: 229 });
    fireCompositionEnd(textarea, "어");

    // 3. Stale-prefix multi-char payload — first composition's text is no
    //    longer the live token's text. Strip must not fire.
    cs.triggerDataEvent("녕 ", true);

    vi.advanceTimersByTime(60);

    // Strip does NOT fire (prefix check rejects); payload flows through.
    expect(origTriggerCalls.map((c) => c.data)).toEqual(["녕 "]);
    // Two PTY writes from the two compositionend commits.
    expect(ptyWrites().map((c) => c.data)).toEqual(["녕", "어"]);
    expect(onComposedFlush).toHaveBeenCalledTimes(2);

    vi.useRealTimers();
  });
});
