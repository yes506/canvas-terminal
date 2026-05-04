/**
 * Unit tests for `fsdProtocol.ts` parser + classifier.
 * 30+ cases covering valid, malformed, and discriminator paths.
 */

import { describe, it, expect } from "vitest";
import { parseFsdLine, classifyMismatch } from "./fsdProtocol";

const SN = "abcdef01";
const RN = "01234567";

function planLine(extra: Record<string, unknown> = {}): string {
  return `##FSD ${JSON.stringify({
    v: 1,
    cmd_id: "c1",
    sn: SN,
    rn: RN,
    run_id: "r1",
    type: "plan",
    goal: "list files",
    ...extra,
  })}`;
}

describe("parseFsdLine — happy path", () => {
  it("parses a minimal plan", () => {
    const r = parseFsdLine(planLine());
    expect(r.kind).toBe("ok");
  });

  it("parses the current bootstrap plan shape with an empty rn", () => {
    const r = parseFsdLine(planLine({ rn: "" }));
    expect(r.kind).toBe("ok");
  });

  it("parses a dispatch with one task", () => {
    const r = parseFsdLine(`##FSD ${JSON.stringify({
      v: 1, cmd_id: "c2", sn: SN, rn: RN, run_id: "r1",
      type: "dispatch", turn: 1,
      tasks: [{ task_id: "t-1-a", tool: "claude_code", instance_idx: 1, prompt: "review" }],
    })}`);
    expect(r.kind).toBe("ok");
  });

  it("parses done", () => {
    const r = parseFsdLine(`##FSD ${JSON.stringify({
      v: 1, cmd_id: "c3", sn: SN, rn: RN, run_id: "r1",
      type: "done", summary: "all good",
    })}`);
    expect(r.kind).toBe("ok");
  });

  it("parses blocked with optional fields", () => {
    const r = parseFsdLine(`##FSD ${JSON.stringify({
      v: 1, cmd_id: "c4", sn: SN, rn: RN, run_id: "r1",
      type: "blocked", reason: "auth-missing", missing_capability: "gemini-cli",
    })}`);
    expect(r.kind).toBe("ok");
  });

  it("tolerates leading whitespace (markdown indent)", () => {
    const r = parseFsdLine("    " + planLine());
    expect(r.kind).toBe("ok");
  });

  it("tolerates trailing whitespace", () => {
    const r = parseFsdLine(planLine() + "   ");
    expect(r.kind).toBe("ok");
  });
});

describe("parseFsdLine — skip (not a ##FSD line)", () => {
  it("skips empty line", () => {
    expect(parseFsdLine("")).toEqual({ kind: "skip" });
  });

  it("skips a normal output line", () => {
    expect(parseFsdLine("Hello, world!")).toEqual({ kind: "skip" });
  });

  it("skips a single # line", () => {
    expect(parseFsdLine("# heading")).toEqual({ kind: "skip" });
  });

  it("skips the §5.4 escape pattern (single hash + space + #FSD)", () => {
    // Per plan v5 §5.4: `# #FSD` is the parser-proof escape for examples.
    expect(parseFsdLine("# #FSD {bogus}")).toEqual({ kind: "skip" });
    expect(parseFsdLine("    # #FSD {whatever}")).toEqual({ kind: "skip" });
  });

  it("skips ###FSD (three hashes)", () => {
    // Three+ hashes don't match — only exactly ## works.
    // Actually ##FSD is a prefix of ###FSD so we need to verify regex.
    // The regex is /^\s*##FSD\s+.../ — ###FSD doesn't have ##FSD followed
    // by whitespace, it has ##FSD followed by # which isn't whitespace.
    expect(parseFsdLine("###FSD {something}")).toEqual({ kind: "skip" });
  });
});

describe("parseFsdLine — malformed", () => {
  it("rejects bad JSON", () => {
    const r = parseFsdLine("##FSD {not valid json");
    expect(r.kind).toBe("malformed");
  });

  it("rejects the stale prompt shape that used cmd instead of type", () => {
    const r = parseFsdLine(`##FSD ${JSON.stringify({
      v: 1,
      cmd_id: "c1",
      sn: SN,
      rn: "",
      run_id: "r1",
      cmd: "plan",
      goal: "x",
    })}`);
    expect(r).toEqual({ kind: "malformed", code: "shape", reason: "missing field: type" });
  });

  it("rejects when missing required field cmd_id", () => {
    const r = parseFsdLine(`##FSD ${JSON.stringify({
      v: 1, sn: SN, rn: RN, run_id: "r1", type: "plan", goal: "x",
    })}`);
    expect(r).toEqual({ kind: "malformed", code: "shape", reason: "missing field: cmd_id" });
  });

  it("rejects unknown verb", () => {
    const r = parseFsdLine(`##FSD ${JSON.stringify({
      v: 1, cmd_id: "c1", sn: SN, rn: RN, run_id: "r1", type: "explode",
    })}`);
    expect(r.kind).toBe("malformed");
  });

  it("rejects unsupported schema version", () => {
    const r = parseFsdLine(`##FSD ${JSON.stringify({
      v: 99, cmd_id: "c1", sn: SN, rn: RN, run_id: "r1", type: "plan", goal: "x",
    })}`);
    expect(r.kind).toBe("malformed");
    if (r.kind === "malformed") {
      expect(r.reason).toContain("v99");
    }
  });

  it("rejects plan with non-string goal", () => {
    const r = parseFsdLine(`##FSD ${JSON.stringify({
      v: 1, cmd_id: "c1", sn: SN, rn: RN, run_id: "r1", type: "plan", goal: 123,
    })}`);
    expect(r.kind).toBe("malformed");
  });

  it("rejects dispatch with missing tasks", () => {
    const r = parseFsdLine(`##FSD ${JSON.stringify({
      v: 1, cmd_id: "c1", sn: SN, rn: RN, run_id: "r1", type: "dispatch", turn: 1,
    })}`);
    expect(r.kind).toBe("malformed");
  });

  it("rejects dispatch with malformed task", () => {
    const r = parseFsdLine(`##FSD ${JSON.stringify({
      v: 1, cmd_id: "c1", sn: SN, rn: RN, run_id: "r1",
      type: "dispatch", turn: 1,
      tasks: [{ task_id: "t1", tool: "claude_code" /* missing prompt */ }],
    })}`);
    expect(r.kind).toBe("malformed");
  });

  it("rejects done without summary", () => {
    const r = parseFsdLine(`##FSD ${JSON.stringify({
      v: 1, cmd_id: "c1", sn: SN, rn: RN, run_id: "r1", type: "done",
    })}`);
    expect(r.kind).toBe("malformed");
  });

  it("rejects blocked without reason", () => {
    const r = parseFsdLine(`##FSD ${JSON.stringify({
      v: 1, cmd_id: "c1", sn: SN, rn: RN, run_id: "r1", type: "blocked",
    })}`);
    expect(r.kind).toBe("malformed");
  });

  it("rejects non-object payload", () => {
    const r = parseFsdLine(`##FSD [1,2,3]`);
    expect(r.kind).toBe("malformed");
  });
});

describe("parseFsdLine — typed shorthand classification (Phase 2.1)", () => {
  it("classifies bare `##FSD plan` as shorthand-plan (recoverable)", () => {
    const r = parseFsdLine("##FSD plan");
    expect(r.kind).toBe("malformed");
    if (r.kind === "malformed") {
      expect(r.code).toBe("shorthand-plan");
      expect(r.reason).toContain("requires a JSON object");
    }
  });

  it("classifies `##FSD dispatch` as shorthand-other (NOT recoverable)", () => {
    const r = parseFsdLine("##FSD dispatch");
    expect(r.kind).toBe("malformed");
    if (r.kind === "malformed") expect(r.code).toBe("shorthand-other");
  });

  it("classifies `##FSD done` as shorthand-other", () => {
    const r = parseFsdLine("##FSD done");
    expect(r.kind).toBe("malformed");
    if (r.kind === "malformed") expect(r.code).toBe("shorthand-other");
  });

  it("classifies `##FSD blocked` as shorthand-other", () => {
    const r = parseFsdLine("##FSD blocked");
    expect(r.kind).toBe("malformed");
    if (r.kind === "malformed") expect(r.code).toBe("shorthand-other");
  });

  it("does NOT match shorthand when JSON follows the verb (the regular path applies)", () => {
    // `##FSD plan {...}` is the proper full form, NOT a shorthand. Must reach
    // the JSON-parse branch and fail with code "json-parse" because `plan {` is
    // unparseable JSON. (The parser's full-form is `##FSD {"type":"plan", …}`.)
    const r = parseFsdLine("##FSD plan {}");
    expect(r.kind).toBe("malformed");
    if (r.kind === "malformed") expect(r.code).toBe("json-parse");
  });

  it("classifies bad JSON as json-parse (not shorthand-*)", () => {
    const r = parseFsdLine("##FSD {not valid json");
    expect(r.kind).toBe("malformed");
    if (r.kind === "malformed") expect(r.code).toBe("json-parse");
  });

  it("classifies missing-field-type as shape", () => {
    const r = parseFsdLine(`##FSD ${JSON.stringify({
      v: 1, cmd_id: "c1", sn: SN, rn: "", run_id: "r1", goal: "x",
    })}`);
    expect(r.kind).toBe("malformed");
    if (r.kind === "malformed") expect(r.code).toBe("shape");
  });
});

describe("classifyMismatch — discriminator (plan v5 §5.2)", () => {
  it("drops literal SESSION_NONCE placeholder", () => {
    const c = classifyMismatch({
      parsedJson: { sn: "<SESSION_NONCE>", rn: RN },
      activeSn: SN, activeRn: RN, insideEchoWindow: false,
    });
    expect(c).toBe("drop");
  });

  it("drops literal RUN_NONCE placeholder", () => {
    const c = classifyMismatch({
      parsedJson: { sn: SN, rn: "<RUN_NONCE>" },
      activeSn: SN, activeRn: RN, insideEchoWindow: false,
    });
    expect(c).toBe("drop");
  });

  it("drops mismatch inside echo window", () => {
    const c = classifyMismatch({
      parsedJson: { sn: "abadbeef", rn: RN },
      activeSn: SN, activeRn: RN, insideEchoWindow: true,
    });
    expect(c).toBe("drop");
  });

  it("strikes mismatch outside echo window", () => {
    const c = classifyMismatch({
      parsedJson: { sn: "abadbeef", rn: RN },
      activeSn: SN, activeRn: RN, insideEchoWindow: false,
    });
    expect(c).toBe("strike");
  });

  it("strikes both-mismatch outside echo window", () => {
    const c = classifyMismatch({
      parsedJson: { sn: "abadbeef", rn: "deadbeef" },
      activeSn: SN, activeRn: RN, insideEchoWindow: false,
    });
    expect(c).toBe("strike");
  });
});
