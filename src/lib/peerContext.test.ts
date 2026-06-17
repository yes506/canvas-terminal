import { describe, it, expect, beforeEach, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import {
  sanitizeCollabSessionId,
  loadActive,
  loadLastArchive,
  listArchives,
  hasContextsBreadcrumb,
  loadSnapshot,
} from "./peerContext";

// Mock the Tauri invoke to avoid native calls.
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(null),
}));

const SESSION_A = "session-1-1700000000000";
const SESSION_B = "session-2-1700000009999";

beforeEach(() => {
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockResolvedValue(null);
});

describe("sanitizeCollabSessionId (sanitize contract — must match the Rust writer)", () => {
  it("keeps [A-Za-z0-9_-] and drops everything else", () => {
    expect(sanitizeCollabSessionId("session-1-123")).toBe("session-1-123");
    expect(sanitizeCollabSessionId("a/b\\c..d e")).toBe("abcde");
    expect(sanitizeCollabSessionId("../../etc/passwd")).toBe("etcpasswd");
    expect(sanitizeCollabSessionId("foo_bar-9")).toBe("foo_bar-9");
  });

  it("is idempotent", () => {
    const once = sanitizeCollabSessionId("we!rd/id");
    expect(sanitizeCollabSessionId(once)).toBe(once);
  });
});

describe("loadActive — session-scoped active path (N11)", () => {
  it("reads contexts/<session>/<handle>.jsonl", async () => {
    vi.mocked(invoke).mockResolvedValue(null);
    await loadActive("claude1", SESSION_A);
    expect(invoke).toHaveBeenCalledWith("read_memory_file", {
      relativePath: `contexts/${SESSION_A}/claude1.jsonl`,
    });
  });

  it("two sessions' claude1 read DISTINCT files (collision fix core)", async () => {
    vi.mocked(invoke).mockResolvedValue(null);
    await loadActive("claude1", SESSION_A);
    await loadActive("claude1", SESSION_B);
    const paths = vi
      .mocked(invoke)
      .mock.calls.map((c) => (c[1] as { relativePath: string }).relativePath);
    expect(paths[0]).not.toBe(paths[1]);
    expect(paths[0]).toBe(`contexts/${SESSION_A}/claude1.jsonl`);
    expect(paths[1]).toBe(`contexts/${SESSION_B}/claude1.jsonl`);
  });
});

describe("loadLastArchive — session-scoped archive path (N12)", () => {
  it("reads contexts/<session>/<handle>.<N>.jsonl", async () => {
    vi.mocked(invoke).mockResolvedValue(null);
    await loadLastArchive("codex2", 3, SESSION_A);
    expect(invoke).toHaveBeenCalledWith("read_memory_file", {
      relativePath: `contexts/${SESSION_A}/codex2.3.jsonl`,
    });
  });
});

describe("listArchives — session-scoped list + regex (N13)", () => {
  it("returns only THIS session's archives; excludes cross-session and legacy-flat", async () => {
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "list_memory_files") {
        return [
          `contexts/${SESSION_A}/claude1.1.jsonl`,
          `contexts/${SESSION_A}/claude1.2.jsonl`,
          `contexts/${SESSION_B}/claude1.5.jsonl`, // other session
          `contexts/claude1.9.jsonl`, // legacy flat (un-namespaced)
          `contexts/${SESSION_A}/claude1.jsonl`, // active, not an archive
        ];
      }
      return null;
    });
    const indices = await listArchives("claude1", SESSION_A);
    expect(indices).toEqual([1, 2]);
  });

  it("returns [] on IPC failure", async () => {
    vi.mocked(invoke).mockRejectedValue(new Error("ipc down"));
    expect(await listArchives("claude1", SESSION_A)).toEqual([]);
  });
});

describe("hasContextsBreadcrumb — session-scoped, no cross-session over-report (N14)", () => {
  it("true when this session has a mirror file", async () => {
    vi.mocked(invoke).mockResolvedValue([
      `contexts/${SESSION_A}/claude1.jsonl`,
    ]);
    expect(await hasContextsBreadcrumb(SESSION_A)).toBe(true);
  });

  it("false when only a DIFFERENT session has mirror files", async () => {
    vi.mocked(invoke).mockResolvedValue([
      `contexts/${SESSION_B}/claude1.jsonl`,
    ]);
    expect(await hasContextsBreadcrumb(SESSION_A)).toBe(false);
  });

  it("false for null collabSessionId", async () => {
    vi.mocked(invoke).mockResolvedValue([
      `contexts/${SESSION_A}/claude1.jsonl`,
    ]);
    expect(await hasContextsBreadcrumb(null)).toBe(false);
  });

  it("false on IPC failure", async () => {
    vi.mocked(invoke).mockRejectedValue(new Error("ipc down"));
    expect(await hasContextsBreadcrumb(SESSION_A)).toBe(false);
  });
});

describe("loadSnapshot — threads collabSessionId to all readers (N14b)", () => {
  it("scopes the active read to the session", async () => {
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "list_memory_files") return [];
      return null; // read_memory_file
    });
    const snap = await loadSnapshot("claude1", SESSION_A);
    expect(snap.agent_handle).toBe("claude1");
    const readCalls = vi
      .mocked(invoke)
      .mock.calls.filter((c) => c[0] === "read_memory_file");
    expect(
      readCalls.some(
        (c) =>
          (c[1] as { relativePath: string }).relativePath ===
          `contexts/${SESSION_A}/claude1.jsonl`,
      ),
    ).toBe(true);
  });
});
