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

  // Round-2 fold (codex1/claude3 F1): document the production-adjacent
  // duplicate-write path that the JP/ZH fixture floor above does NOT
  // exercise. The shared IME state machine has no Korean-only branch in
  // docInput/docKeyDown/compositionend, but the `triggerDataEvent`
  // wrapper IS Korean-only (20ms defer only for KOREAN_CODEPOINT_RE).
  // In production, xterm.js's CompositionHelper can call
  // `coreService.triggerDataEvent(data)` synchronously during the
  // `input` event (or via setTimeout(0) from compositionend) for any
  // committed text. For Korean the wrapper holds the bytes back for
  // 20ms and discards them if a new composition starts. For non-Korean
  // (JP/ZH/etc), the wrapper falls through immediately.
  //
  // If xterm fires triggerDataEvent("こ") AND the shim's compositionend
  // handler also direct-writes "こ" via `invoke("write_to_pty")`, the
  // PTY receives the bytes twice. This is a PRE-EXISTING residual from
  // the original inline shims (reKorean-only check is identical), not
  // a regression introduced by the helper extraction. The test below
  // PINS this behavior so a future wrapper refactor doesn't silently
  // change it. JP/ZH live acceptance (plan node 10 manual ceiling)
  // remains the authoritative check; fixing the residual is out of
  // scope for korean-ime-dup-render and would require widening the
  // 20ms-defer to all single-codepoint CJK ranges.
  it("pins residual duplicate-write behavior for JP/ZH when xterm fires triggerDataEvent between input and compositionend (out-of-scope residual; documents current behavior)", () => {
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
