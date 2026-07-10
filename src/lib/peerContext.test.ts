import { describe, it, expect, beforeEach, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import {
  loadActive,
  loadLastArchive,
  listArchives,
  hasContextsBreadcrumb,
  loadSnapshot,
} from "./peerContext";

// Mock the Tauri invoke to avoid native calls. The reader goes through the
// scoped facade (`scopedMemoryIpc`), which forwards to these command names
// with a `collabSessionId` scope argument — the Rust side roots every path
// at `session-<pid>/<collabSessionId>/`, so the reader's relative paths are
// plain `contexts/…` with NO session segment. (The former TS
// `sanitizeCollabSessionId` mirror is deleted; sanitization is Rust-only.)
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(null),
}));

const SESSION_A = "session-1-1700000000000";
const SESSION_B = "session-2-1700000009999";

beforeEach(() => {
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockResolvedValue(null);
});

describe("loadActive — session-scoped active path (N11)", () => {
  it("reads contexts/<handle>.jsonl scoped to the session", async () => {
    vi.mocked(invoke).mockResolvedValue(null);
    await loadActive("claude1", SESSION_A);
    expect(invoke).toHaveBeenCalledWith("read_memory_file", {
      collabSessionId: SESSION_A,
      relativePath: "contexts/claude1.jsonl",
    });
  });

  it("two sessions' claude1 read under DISTINCT scopes (collision fix core)", async () => {
    vi.mocked(invoke).mockResolvedValue(null);
    await loadActive("claude1", SESSION_A);
    await loadActive("claude1", SESSION_B);
    const scopes = vi
      .mocked(invoke)
      .mock.calls.map((c) => (c[1] as { collabSessionId: string }).collabSessionId);
    expect(scopes[0]).toBe(SESSION_A);
    expect(scopes[1]).toBe(SESSION_B);
    expect(scopes[0]).not.toBe(scopes[1]);
  });
});

describe("loadLastArchive — session-scoped archive path (N12)", () => {
  it("reads contexts/<handle>.<N>.jsonl scoped to the session", async () => {
    vi.mocked(invoke).mockResolvedValue(null);
    await loadLastArchive("codex2", 3, SESSION_A);
    expect(invoke).toHaveBeenCalledWith("read_memory_file", {
      collabSessionId: SESSION_A,
      relativePath: "contexts/codex2.3.jsonl",
    });
  });
});

describe("listArchives — session-scoped list + regex (N13)", () => {
  it("scopes the list IPC to the session and parses archive indices", async () => {
    vi.mocked(invoke).mockImplementation(async (cmd: string, args?: unknown) => {
      if (cmd === "list_memory_files") {
        // The scoped IPC only ever returns THIS session's files — the
        // session segment is structural (Rust walk root), not a path
        // prefix the reader must filter on.
        expect((args as { collabSessionId: string }).collabSessionId).toBe(SESSION_A);
        return [
          "contexts/claude1.1.jsonl",
          "contexts/claude1.2.jsonl",
          "contexts/claude1.jsonl", // active, not an archive
          "contexts/codex1.5.jsonl", // sibling agent — excluded by handle
          "task-9.done.json", // unrelated session file
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
    vi.mocked(invoke).mockResolvedValue(["contexts/claude1.jsonl"]);
    expect(await hasContextsBreadcrumb(SESSION_A)).toBe(true);
  });

  it("true when only an archive exists (no active)", async () => {
    vi.mocked(invoke).mockResolvedValue(["contexts/claude1.1.jsonl"]);
    expect(await hasContextsBreadcrumb(SESSION_A)).toBe(true);
  });

  it("false when the session has no mirror files (list is scoped, so other sessions' files never appear)", async () => {
    vi.mocked(invoke).mockResolvedValue(["conversation-x.md", "task-1.done.json"]);
    expect(await hasContextsBreadcrumb(SESSION_A)).toBe(false);
  });

  it("passes the session scope to the list IPC", async () => {
    vi.mocked(invoke).mockResolvedValue([]);
    await hasContextsBreadcrumb(SESSION_A);
    expect(invoke).toHaveBeenCalledWith("list_memory_files", {
      collabSessionId: SESSION_A,
    });
  });

  it("false for null collabSessionId", async () => {
    vi.mocked(invoke).mockResolvedValue(["contexts/claude1.jsonl"]);
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
          (c[1] as { collabSessionId: string; relativePath: string })
            .collabSessionId === SESSION_A &&
          (c[1] as { relativePath: string }).relativePath ===
            "contexts/claude1.jsonl",
      ),
    ).toBe(true);
  });
});
