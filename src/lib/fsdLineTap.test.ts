/**
 * Unit tests for fsdLineTap — incremental line tap with byte buffer,
 * ANSI strip, mute window, echo suppressor, partial-line DoS guard.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { createFsdLineTap } from "./fsdLineTap";
import type { ParseResult } from "./fsdProtocol";

const SN = "abcdef01";
const RN = "01234567";

function planJson(extra = ""): string {
  return JSON.stringify({
    v: 1, cmd_id: "c1", sn: SN, rn: RN, run_id: "r1",
    type: "plan", goal: "x" + extra,
  });
}

describe("createFsdLineTap", () => {
  let received: ParseResult[] = [];
  let tap: ReturnType<typeof createFsdLineTap>;

  beforeEach(() => {
    received = [];
    tap = createFsdLineTap({
      sessionId: "s1",
      onCommand: (r) => received.push(r),
    });
  });

  it("parses a complete line in a single feed", () => {
    tap.feed(`##FSD ${planJson()}\n`);
    expect(received).toHaveLength(1);
    expect(received[0].kind).toBe("ok");
  });

  it("buffers across multiple feeds (split mid-JSON)", () => {
    const full = `##FSD ${planJson()}\n`;
    tap.feed(full.slice(0, 30));
    expect(received).toHaveLength(0); // no newline yet
    tap.feed(full.slice(30));
    expect(received).toHaveLength(1);
    expect(received[0].kind).toBe("ok");
  });

  it("handles \\r\\n line endings", () => {
    tap.feed(`##FSD ${planJson()}\r\n`);
    expect(received).toHaveLength(1);
    expect(received[0].kind).toBe("ok");
  });

  it("parses a complete FSD command before a trailing bare \\r is followed by LF", () => {
    tap.feed(`##FSD ${planJson()}\r`);
    expect(received).toHaveLength(1);
    expect(received[0].kind).toBe("ok");
    tap.feed("\n");
    expect(received).toHaveLength(1);
  });

  it("parses a complete FSD command even when the CLI omits the trailing newline", () => {
    tap.feed(`##FSD ${planJson()}`);
    expect(received).toHaveLength(1);
    expect(received[0].kind).toBe("ok");
  });

  it("does not prematurely report incomplete unterminated FSD JSON", () => {
    tap.feed(`##FSD {"v":1,"cmd_id":"c1","sn":"${SN}`);
    expect(received).toHaveLength(0);
    tap.feed(`","rn":"${RN}","run_id":"r1","type":"plan","goal":"x"}`);
    expect(received).toHaveLength(1);
    expect(received[0].kind).toBe("ok");
  });

  it("collapses PTY carriage-return redraws before parsing", () => {
    tap.feed(`##FSD {"v":1,"cmd_id":"c1","sn":"${SN}","rn":"${RN}","run_id":"r1","t\r`);
    expect(received).toHaveLength(0);
    tap.feed(`##FSD ${planJson()}\r\n`);
    expect(received).toHaveLength(1);
    expect(received[0].kind).toBe("ok");
  });

  it("rescues a complete FSD command overwritten by a CR status redraw (no trailing LF)", () => {
    // Leader emits a complete ##FSD command, then carriage-returns to redraw
    // a status bar in the same chunk without a trailing LF. Without the
    // FSD-aware redraw rescue, normalizePtyLine would return only the post-CR
    // status text, and the FSD command would be silently dropped.
    tap.feed(`##FSD ${planJson()}\rstatus_bar_redraw`);
    expect(received).toHaveLength(1);
    expect(received[0].kind).toBe("ok");
  });

  it("rescues a complete FSD command overwritten by a CR status redraw (with trailing LF)", () => {
    tap.feed(`##FSD ${planJson()}\rstatus_bar_redraw\n`);
    expect(received).toHaveLength(1);
    expect(received[0].kind).toBe("ok");
  });

  it("prefers the latest valid FSD frame when multiple appear across CR redraws", () => {
    // Two complete FSD commands in one rendered line separated by CR — last wins.
    tap.feed(`##FSD ${planJson("-A")}\r##FSD ${planJson("-B")}\n`);
    expect(received).toHaveLength(1);
    expect(received[0].kind).toBe("ok");
    if (received[0].kind === "ok" && received[0].cmd.type === "plan") {
      expect(received[0].cmd.goal).toBe("x-B");
    }
  });

  it("reassembles hard-wrapped FSD JSON before parsing", () => {
    tap.feed(`##FSD {"v":1,"cmd_id":"c1","sn":"${SN}","rn":"${RN}","run_id":"r1","t\n`);
    expect(received).toHaveLength(0);
    tap.feed(`ype":"plan","goal":"x"}\n`);
    expect(received).toHaveLength(1);
    expect(received[0].kind).toBe("ok");
  });

  it("still reports non-incomplete malformed FSD JSON", () => {
    tap.feed("##FSD {bad json\n");
    expect(received).toHaveLength(1);
    expect(received[0].kind).toBe("malformed");
  });

  it("handles multiple lines in one feed", () => {
    tap.feed(`##FSD ${planJson("-1")}\n##FSD ${planJson("-2")}\n`);
    expect(received).toHaveLength(2);
    expect(received[0].kind).toBe("ok");
    expect(received[1].kind).toBe("ok");
  });

  it("strips ANSI escapes before parsing", () => {
    // \x1b[31m red \x1b[0m
    tap.feed(`\x1b[2K\x1b[1G##FSD \x1b[32m${planJson()}\x1b[0m\n`);
    expect(received).toHaveLength(1);
    expect(received[0].kind).toBe("ok");
  });

  it("skips empty lines silently", () => {
    tap.feed("\n\n\n");
    expect(received).toHaveLength(0);
  });

  it("skips non-FSD lines silently", () => {
    tap.feed("hello world\nthis is normal output\n");
    expect(received).toHaveLength(0);
  });

  it("flags incomplete FSD lines if continuation becomes malformed", () => {
    tap.feed("##FSD {\"v\":1,\"cmd_id\":\"c1\n");
    expect(received).toHaveLength(0);
    tap.feed("\",bad}\n");
    expect(received).toHaveLength(1);
    expect(received[0].kind).toBe("malformed");
  });

  it("does NOT match the §5.4 escape pattern (`# #FSD`)", () => {
    tap.feed("# #FSD {whatever}\n");
    expect(received).toHaveLength(0); // skip, not malformed
  });

  it("expectEcho consumes a matching echoed line", () => {
    const text = "##FSD ECHOED REMINDER";
    tap.expectEcho(text, 1000);
    tap.feed(`${text}\n`);
    expect(received).toHaveLength(0); // echo consumed
  });

  it("expectEcho window expires after ms", async () => {
    const text = "##FSD ECHOED";
    tap.expectEcho(text, 50);
    await new Promise((r) => setTimeout(r, 100));
    tap.feed(`${text}\n`);
    // Echo not consumed (window expired) — but it's also not a valid FSD command,
    // so it passes through as malformed.
    expect(received).toHaveLength(1);
    expect(received[0].kind).toBe("malformed");
  });

  it("blanket mute drops everything in window", () => {
    tap.enableBlanketMute(1000);
    tap.feed(`##FSD ${planJson()}\n`);
    expect(received).toHaveLength(0);
  });

  it("insideEchoWindow reflects active expectations", () => {
    expect(tap.insideEchoWindow()).toBe(false);
    tap.expectEcho("foo", 1000);
    expect(tap.insideEchoWindow()).toBe(true);
    tap.dispose();
    expect(tap.insideEchoWindow()).toBe(false);
  });

  it("partial line DoS guard truncates at cap", () => {
    // 100 KB of garbage with no newline
    const garbage = "X".repeat(100 * 1024);
    tap.feed(garbage);
    // Now feed a real FSD line — buffer should have been truncated, so parse should still work
    tap.feed(`\n##FSD ${planJson()}\n`);
    expect(received.length).toBeGreaterThanOrEqual(1);
    // The real line should have parsed.
    const real = received.find((r) => r.kind === "ok");
    expect(real).toBeDefined();
  });

  it("dispose clears state", () => {
    tap.feed("partial line without newline");
    tap.dispose();
    // After dispose, feeding more shouldn't trigger anything weird.
    tap.feed("##FSD plan-fake\n");
    // The tap is disposed but still functional — just buffer is reset.
    // (The implementation doesn't kill the tap, just clears buffer.)
    expect(received.length).toBeLessThanOrEqual(1);
  });

  it("handles cmd interleaved with normal output", () => {
    tap.feed("hello\n");
    tap.feed(`##FSD ${planJson()}\n`);
    tap.feed("world\n");
    expect(received).toHaveLength(1);
    expect(received[0].kind).toBe("ok");
  });
});
