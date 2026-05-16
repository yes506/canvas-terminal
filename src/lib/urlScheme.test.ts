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
});
