import { describe, it, expect } from "vitest";
import { classifyScheme } from "./urlScheme";

describe("classifyScheme", () => {
  describe("ALLOW", () => {
    it("allows http URLs", () => {
      const r = classifyScheme("http://example.com");
      expect(r.action).toBe("allow");
      if (r.action === "allow") {
        expect(r.normalizedUrl).toContain("http://example.com");
      }
    });

    it("allows https URLs", () => {
      const r = classifyScheme("https://example.com/path?q=1");
      expect(r.action).toBe("allow");
    });

    it("allows about:blank", () => {
      const r = classifyScheme("about:blank");
      expect(r.action).toBe("allow");
      if (r.action === "allow") {
        expect(r.normalizedUrl).toBe("about:blank");
      }
    });

    it("trims whitespace", () => {
      const r = classifyScheme("  https://example.com  ");
      expect(r.action).toBe("allow");
    });

    it("accepts uppercase schemes", () => {
      const r = classifyScheme("HTTPS://EXAMPLE.COM");
      expect(r.action).toBe("allow");
    });

    it("treats scheme-less inputs as https", () => {
      const r = classifyScheme("example.com");
      expect(r.action).toBe("allow");
      if (r.action === "allow") {
        expect(r.normalizedUrl).toContain("https://example.com");
      }
    });
  });

  describe("FILTER", () => {
    it("filters javascript: URLs", () => {
      const r = classifyScheme("javascript:alert(1)");
      expect(r.action).toBe("filter");
      if (r.action === "filter") {
        expect(r.reason).toContain("javascript");
      }
    });

    it("filters data: URLs", () => {
      const r = classifyScheme("data:text/html,hello");
      expect(r.action).toBe("filter");
    });

    it("filters tauri: URLs", () => {
      const r = classifyScheme("tauri://internal");
      expect(r.action).toBe("filter");
    });

    it("filters tauri-localhost: URLs", () => {
      const r = classifyScheme("tauri-localhost://x");
      expect(r.action).toBe("filter");
    });

    it("filters vbscript: URLs", () => {
      const r = classifyScheme("vbscript:msgbox");
      expect(r.action).toBe("filter");
    });

    it("filters empty input", () => {
      const r = classifyScheme("");
      expect(r.action).toBe("filter");
    });

    it("filters whitespace-only input", () => {
      const r = classifyScheme("   ");
      expect(r.action).toBe("filter");
    });

    it("filters unknown schemes", () => {
      const r = classifyScheme("ftp://example.com");
      expect(r.action).toBe("filter");
    });
  });

  describe("DENY", () => {
    it("denies file: URLs", () => {
      const r = classifyScheme("file:///etc/passwd");
      expect(r.action).toBe("deny");
      if (r.action === "deny") {
        expect(r.reason).toContain("file:");
      }
    });
  });

  // C1 THREE-way invariant — mirror of
  // src-tauri/src/commands/browser.rs::validate_browser_url localfile
  // tests; if either side adds a case, the other side adds the same
  // case. v1 shape is `localfile://localhost/<22 url-safe-base64>` (C9).
  describe("LOCALFILE (C1 / C9)", () => {
    const TOKEN_22 = "0123456789abcdefghijkl"; // exactly 22 url-safe-base64 chars

    it("allows well-formed localfile shape", () => {
      const url = `localfile://localhost/${TOKEN_22}`;
      const r = classifyScheme(url);
      expect(r.action).toBe("allow");
      if (r.action === "allow") {
        expect(r.normalizedUrl).toBe(url);
      }
    });

    it("filters localfile with wrong host", () => {
      const r = classifyScheme(`localfile://foo/${TOKEN_22}`);
      expect(r.action).toBe("filter");
    });

    it("filters localfile with missing host", () => {
      const r = classifyScheme(`localfile:///${TOKEN_22}`);
      expect(r.action).toBe("filter");
    });

    it("filters localfile with authority-only (no path)", () => {
      const r = classifyScheme(`localfile://${TOKEN_22}`);
      expect(r.action).toBe("filter");
    });

    it("filters localfile with token length != 22", () => {
      const r = classifyScheme(`localfile://localhost/${TOKEN_22.slice(0, 21)}`);
      expect(r.action).toBe("filter");
    });

    it("filters localfile with invalid alphabet (slash inside token)", () => {
      const r = classifyScheme("localfile://localhost/0123456789a/cdefghijkl");
      expect(r.action).toBe("filter");
    });

    it("filters localfile with query string", () => {
      const r = classifyScheme(`localfile://localhost/${TOKEN_22}?evil=1`);
      expect(r.action).toBe("filter");
    });

    it("filters localfile with fragment", () => {
      const r = classifyScheme(`localfile://localhost/${TOKEN_22}#frag`);
      expect(r.action).toBe("filter");
    });
  });
});
