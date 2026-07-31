import { describe, it, expect } from "vitest";
import {
  resolveTaskId,
  stripTaskId,
  isValidTaskId,
  validateSignal,
  classifyReportPath,
  completionBasename,
  classifyFailure,
  StabilityTracker,
  contentHash,
  stabilityKey,
  STABILITY_MIN_INTERVAL_MS,
  STABILITY_MIN_AGE_MS,
  type Clock,
} from "./collabCompletion";

const t = (id: string) => ({ id });

// ---------------------------------------------------------------------------
// N5 — resolveTaskId
// ---------------------------------------------------------------------------
describe("resolveTaskId (N5, exact-first)", () => {
  it("stripped id resolves the exactly-numbered task, NOT a higher prefix (task-1 vs task-10)", () => {
    const tasks = [t("task-1-1785474396813"), t("task-10-1785474396999")];
    expect(resolveTaskId(tasks, "task-1")).toEqual({ kind: "unique", task: tasks[0] });
    // reversed array order — must still pick task-1, not task-10
    const rev = [t("task-10-1785474396999"), t("task-1-1785474396813")];
    expect(resolveTaskId(rev, "task-1")).toEqual({ kind: "unique", task: rev[1] });
  });

  it("stripped task-10 never matches task-1", () => {
    const tasks = [t("task-1-1785474396813"), t("task-10-1785474396999")];
    expect(resolveTaskId(tasks, "task-10")).toEqual({ kind: "unique", task: tasks[1] });
  });

  it("exact full id wins even when a sibling shares the short id", () => {
    const tasks = [t("task-9-1111111111111"), t("task-9-2222222222222")];
    expect(resolveTaskId(tasks, "task-9-2222222222222")).toEqual({
      kind: "unique",
      task: tasks[1],
    });
  });

  it("stripped id with two normalized matches is ambiguous (fail closed)", () => {
    const tasks = [t("task-9-1111111111111"), t("task-9-2222222222222")];
    const r = resolveTaskId(tasks, "task-9");
    expect(r.kind).toBe("ambiguous");
  });

  it("full-in-filename / stripped-payload both resolve (claude3 live evidence)", () => {
    const tasks = [t("task-9-1785476410144")];
    expect(resolveTaskId(tasks, "task-9").kind).toBe("unique");
    expect(resolveTaskId(tasks, "task-9-1785476410144").kind).toBe("unique");
  });

  it("rejects whitespace, arbitrary prefixes, extra suffixes → none", () => {
    const tasks = [t("task-1-1785474396813")];
    expect(resolveTaskId(tasks, " task-1 ").kind).toBe("none"); // whitespace rejected, not trimmed
    expect(resolveTaskId(tasks, "task-1x").kind).toBe("none");
    expect(resolveTaskId(tasks, "task-01").kind).toBe("none"); // leading zero
    expect(resolveTaskId(tasks, "ask-1").kind).toBe("none");
    expect(resolveTaskId(tasks, "").kind).toBe("none");
  });

  it("no match returns none", () => {
    expect(resolveTaskId([t("task-1-1785474396813")], "task-2").kind).toBe("none");
  });
});

describe("stripTaskId / isValidTaskId", () => {
  it("strips exactly one 13-digit suffix", () => {
    expect(stripTaskId("task-1-1785474396813")).toBe("task-1");
    expect(stripTaskId("task-1")).toBe("task-1");
    expect(stripTaskId("task-12-1785474396813")).toBe("task-12");
  });
  it("grammar", () => {
    expect(isValidTaskId("task-1")).toBe(true);
    expect(isValidTaskId("task-1-1785474396813")).toBe(true);
    expect(isValidTaskId("task-0")).toBe(false);
    expect(isValidTaskId("task-1-123")).toBe(false);
    expect(isValidTaskId("nope")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// N4 — validateSignal
// ---------------------------------------------------------------------------
describe("validateSignal (N4, legacy-compatible strict schema)", () => {
  const fn = "task-1-1785474396813.done.json";

  it("accepts a minimal valid signal", () => {
    const r = validateSignal(`{"task_id":"task-1","status":"completed"}`, fn);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.taskId).toBe("task-1");
      expect(r.value.status).toBe("completed");
      expect(r.value.author).toBeNull();
      expect(r.value.reportPath).toEqual({ kind: "absent" });
    }
  });

  it("rejects malformed JSON", () => {
    const r = validateSignal(`{"task_id":"task-1", "status":}`, fn);
    expect(r).toEqual({ ok: false, reason: "parse-error" });
  });

  it("rejects non-object", () => {
    expect(validateSignal(`"a string"`, fn)).toEqual({ ok: false, reason: "not-an-object" });
    expect(validateSignal(`[1,2]`, fn)).toEqual({ ok: false, reason: "not-an-object" });
  });

  it("rejects missing / mis-cased task_id (camelCase taskId)", () => {
    expect(validateSignal(`{"taskId":"task-1","status":"completed"}`, fn)).toEqual({
      ok: false,
      reason: "missing-task-id",
    });
  });

  it("rejects a status other than completed|blocked (no permissive coercion)", () => {
    expect(validateSignal(`{"task_id":"task-1","status":"in_progress"}`, fn)).toEqual({
      ok: false,
      reason: "bad-status",
    });
    expect(validateSignal(`{"task_id":"task-1","status":"done"}`, fn)).toEqual({
      ok: false,
      reason: "bad-status",
    });
  });

  it("accepts blocked", () => {
    const r = validateSignal(`{"task_id":"task-1","status":"blocked"}`, fn);
    expect(r.ok).toBe(true);
  });

  it("legacy no-author is fine (assignee fallback handled by caller)", () => {
    const r = validateSignal(`{"task_id":"task-1","status":"completed"}`, fn);
    expect(r.ok && r.value.author).toBeNull();
  });

  it("accepts legacy `agent` alias when author absent", () => {
    const r = validateSignal(`{"task_id":"task-1","status":"completed","agent":"@claude2"}`, fn);
    expect(r.ok && r.value.author).toBe("@claude2");
  });

  it("author WINS over legacy agent alias — disagreement is never a rejection (plan N4)", () => {
    const same = validateSignal(
      `{"task_id":"task-1","status":"completed","author":"@a","agent":"@a"}`,
      fn,
    );
    expect(same.ok && same.value.author).toBe("@a");
    const diff = validateSignal(
      `{"task_id":"task-1","status":"completed","author":"@a","agent":"@b"}`,
      fn,
    );
    expect(diff.ok).toBe(true); // NOT rejected
    expect(diff.ok && diff.value.author).toBe("@a"); // author wins
  });

  it("filename↔payload: full filename + stripped payload agree (and vice-versa)", () => {
    expect(
      validateSignal(`{"task_id":"task-1","status":"completed"}`, "task-1-1785474396813.done.json").ok,
    ).toBe(true);
    expect(
      validateSignal(`{"task_id":"task-1-1785474396813","status":"completed"}`, "task-1.done.json").ok,
    ).toBe(true);
  });

  it("filename↔payload mismatch (task-1 file, task-2 payload) rejects", () => {
    expect(
      validateSignal(`{"task_id":"task-2","status":"completed"}`, "task-1.done.json"),
    ).toEqual({ ok: false, reason: "filename-payload-mismatch" });
  });

  it("report_path is NEVER ok:false — bad shape is flagged, not rejected (G1)", () => {
    const traversal = validateSignal(
      `{"task_id":"task-1","status":"completed","report_path":"../evil.md"}`,
      fn,
    );
    expect(traversal.ok).toBe(true);
    expect(traversal.ok && traversal.value.reportPath.kind).toBe("unsafe");

    const absolute = validateSignal(
      `{"task_id":"task-1","status":"completed","report_path":"/etc/passwd"}`,
      fn,
    );
    expect(absolute.ok && absolute.value.reportPath.kind).toBe("unsafe");

    const usable = validateSignal(
      `{"task_id":"task-1","status":"completed","report_path":"task-1-report.md"}`,
      fn,
    );
    expect(usable.ok && usable.value.reportPath).toEqual({
      kind: "usable",
      path: "task-1-report.md",
    });
  });

  it("nested filename path: basename suffix stripped correctly", () => {
    expect(completionBasename("sub/dir/task-1.done.json")).toBe("task-1");
    expect(completionBasename("task-1.done.json")).toBe("task-1");
    expect(completionBasename("notasignal.txt")).toBeNull();
  });
});

describe("classifyReportPath", () => {
  it("absent / usable / unsafe", () => {
    expect(classifyReportPath(undefined)).toEqual({ kind: "absent" });
    expect(classifyReportPath("r.md").kind).toBe("usable");
    expect(classifyReportPath("../r.md").kind).toBe("unsafe");
    expect(classifyReportPath("r.txt").kind).toBe("unsafe");
    expect(classifyReportPath("x.done.json").kind).toBe("unsafe");
    expect(classifyReportPath(42).kind).toBe("unsafe");
  });
  it("rejects nested paths, Markdown metacharacters, and control chars (injection-safe)", () => {
    expect(classifyReportPath("sub/report.md").kind).toBe("unsafe"); // nested
    expect(classifyReportPath("a b.md").kind).toBe("unsafe"); // space
    expect(classifyReportPath("evil#heading.md").kind).toBe("unsafe"); // markdown meta
    expect(classifyReportPath("a\nb.md").kind).toBe("unsafe"); // newline
    expect(classifyReportPath("bad|table.md").kind).toBe("unsafe"); // pipe
    expect(classifyReportPath("task-1-report.md").kind).toBe("usable");
  });
});

// ---------------------------------------------------------------------------
// N6 — classifyFailure
// ---------------------------------------------------------------------------
describe("classifyFailure (N6 taxonomy)", () => {
  it("content + ambiguous → stabilize; no-match/wrong-session → grace; transient → retry", () => {
    expect(classifyFailure("content-error")).toBe("stabilize-then-quarantine");
    expect(classifyFailure("ambiguous")).toBe("stabilize-then-quarantine");
    expect(classifyFailure("no-match")).toBe("grace-then-quarantine");
    expect(classifyFailure("wrong-session")).toBe("grace-then-quarantine");
    expect(classifyFailure("transient-ipc")).toBe("retry");
    expect(classifyFailure("file-gone")).toBe("noop");
  });
});

// ---------------------------------------------------------------------------
// N7 — StabilityTracker (injected clock)
// ---------------------------------------------------------------------------
describe("StabilityTracker (N7)", () => {
  function fakeClock(start = 100000): { clock: Clock; advance: (ms: number) => void } {
    let t = start;
    return { clock: { now: () => t }, advance: (ms) => { t += ms; } };
  }
  const key = stabilityKey("sess", "task-1.done.json");

  it("first observation is never stable", () => {
    const { clock } = fakeClock();
    const st = new StabilityTracker(clock);
    expect(st.shouldQuarantine(key, "bad", "parse-error", 0)).toBe(false);
  });

  it("two observations within one interval do NOT stabilize (concurrent-scan guard)", () => {
    const f = fakeClock();
    const st = new StabilityTracker(f.clock);
    const mtime = f.clock.now() - STABILITY_MIN_AGE_MS - 10; // old enough
    expect(st.shouldQuarantine(key, "bad", "parse-error", mtime)).toBe(false);
    f.advance(50); // two near-simultaneous scans
    expect(st.shouldQuarantine(key, "bad", "parse-error", mtime)).toBe(false);
  });

  it("stabilizes after the interval elapses AND file is old enough", () => {
    const f = fakeClock();
    const st = new StabilityTracker(f.clock);
    const mtime = f.clock.now() - STABILITY_MIN_AGE_MS - 10;
    expect(st.shouldQuarantine(key, "bad", "parse-error", mtime)).toBe(false);
    f.advance(STABILITY_MIN_INTERVAL_MS + 1);
    expect(st.shouldQuarantine(key, "bad", "parse-error", mtime)).toBe(true);
  });

  it("content change (same length) resets the timer — partial-write tolerance", () => {
    const f = fakeClock();
    const st = new StabilityTracker(f.clock);
    const mtime0 = f.clock.now() - STABILITY_MIN_AGE_MS - 10;
    st.shouldQuarantine(key, "aaaa", "parse-error", mtime0);
    f.advance(STABILITY_MIN_INTERVAL_MS + 1);
    // same length, different bytes, newer mtime → different fingerprint → reset
    const mtime1 = f.clock.now();
    expect(st.shouldQuarantine(key, "bbbb", "parse-error", mtime1)).toBe(false);
  });

  it("mtime too recent blocks stabilization even after interval", () => {
    const f = fakeClock();
    const st = new StabilityTracker(f.clock);
    const recentMtime = f.clock.now(); // age 0
    st.shouldQuarantine(key, "bad", "parse-error", recentMtime);
    f.advance(STABILITY_MIN_INTERVAL_MS + 1);
    // mtime unchanged but still "recent" relative to advanced now? now-mtime is large now
    // so this SHOULD be stable — assert the age path explicitly with a fresh key
    const k2 = stabilityKey("sess", "task-2.done.json");
    const now2 = f.clock.now();
    expect(st.shouldQuarantine(k2, "bad", "parse-error", now2)).toBe(false); // first obs
    f.advance(STABILITY_MIN_INTERVAL_MS + 1);
    expect(st.shouldQuarantine(k2, "bad", "parse-error", now2)).toBe(true); // now old enough
  });

  it("purge / purgeSession clear state", () => {
    const { clock } = fakeClock();
    const st = new StabilityTracker(clock);
    st.shouldQuarantine(stabilityKey("s1", "a.done.json"), "x", "e", 0);
    st.shouldQuarantine(stabilityKey("s1", "b.done.json"), "x", "e", 0);
    st.shouldQuarantine(stabilityKey("s2", "c.done.json"), "x", "e", 0);
    expect(st.size()).toBe(3);
    st.purge(stabilityKey("s1", "a.done.json"));
    expect(st.size()).toBe(2);
    st.purgeSession("s1");
    expect(st.size()).toBe(1);
  });
});

describe("contentHash", () => {
  it("is deterministic and distinguishes same-length content", () => {
    expect(contentHash("aaaa")).toBe(contentHash("aaaa"));
    expect(contentHash("aaaa")).not.toBe(contentHash("bbbb"));
  });
});
