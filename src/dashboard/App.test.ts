import { describe, it, expect } from "vitest";
import { encodePathForUrl } from "./App";

// collab-isolation-agy node 14 smoke test: the dashboard snapshot now lists
// NESTED per-session paths (`<collabSessionId>/conversation-….md`,
// `<collabSessionId>/contexts/<agent>.jsonl`) instead of the former
// root-level flat names. The SPA renders `f.path` verbatim (no filename
// grouping logic to regress), so the load-bearing piece to lock is the
// file-viewer URL encoding: per-segment encodeURIComponent with `/`
// preserved as the separator, matching the axum route
// `/api/sessions/current/files/*path`.
describe("dashboard encodePathForUrl — nested per-session paths (node 14)", () => {
  it("preserves slashes as segment separators for nested session paths", () => {
    expect(encodePathForUrl("session-1-123/conversation-session-1-123.md")).toBe(
      "session-1-123/conversation-session-1-123.md",
    );
    expect(encodePathForUrl("session-1-123/contexts/claude1.jsonl")).toBe(
      "session-1-123/contexts/claude1.jsonl",
    );
  });

  it("percent-encodes unsafe characters WITHIN a segment only", () => {
    expect(encodePathForUrl("sid/task a#1.md")).toBe("sid/task%20a%231.md");
    // A '?' must not terminate the URL path.
    expect(encodePathForUrl("sid/what?.md")).toBe("sid/what%3F.md");
  });

  it("handles the deepest layout level (contexts archives)", () => {
    expect(encodePathForUrl("session-2-999/contexts/claude1.12.jsonl")).toBe(
      "session-2-999/contexts/claude1.12.jsonl",
    );
  });
});
