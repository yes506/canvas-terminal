import { describe, it, expect, vi } from "vitest";

// html2canvas can't run inside happy-dom (it relies on DOM cloning APIs that
// happy-dom doesn't fully implement). Stub it before the module under test loads.
vi.mock("html2canvas", () => ({
  default: vi.fn().mockResolvedValue({
    toDataURL: () =>
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  }),
}));

const { getDocumentExtensions, isDocumentFile, renderDocument } = await import(
  "./documentRenderer"
);

describe("documentRenderer — markdown support", () => {
  it("includes 'md' in supported extensions", () => {
    expect(getDocumentExtensions()).toContain("md");
  });

  it("isDocumentFile('md') returns true", () => {
    expect(isDocumentFile("md")).toBe(true);
  });

  it("isDocumentFile is case-insensitive for 'MD'", () => {
    expect(isDocumentFile("MD")).toBe(true);
  });

  it("preserves the existing document extensions", () => {
    const exts = getDocumentExtensions();
    expect(exts).toEqual(
      expect.arrayContaining([
        "pdf",
        "docx",
        "xlsx",
        "xls",
        "csv",
        "tsv",
        "hwp",
        "hwpx",
        "md",
      ]),
    );
  });
});

describe("renderDocument — md branch", () => {
  // Helper: UTF-8 string -> base64 (mirrors what the Tauri backend produces).
  function utf8ToBase64(s: string): string {
    const bytes = new TextEncoder().encode(s);
    let bin = "";
    for (const b of bytes) bin += String.fromCharCode(b);
    return btoa(bin);
  }

  it("preserves UTF-8 source byte-for-byte (Korean + emoji)", async () => {
    const source = "# 안녕 🌟\n- 항목 1\n- 항목 2\n\n```js\nconst x = '한글';\n```";
    const b64 = utf8ToBase64(source);
    const result = await renderDocument(b64, "md");
    expect(result.format).toBe("md");
    expect(result.markdownSource).toBe(source);
    expect(result.pages).toHaveLength(1);
    // dataUrl should be a non-trivial PNG produced by html2canvas.
    expect(result.pages[0].dataUrl.startsWith("data:image/png;base64,")).toBe(true);
    expect(result.pages[0].dataUrl.length).toBeGreaterThan(100);
  });

  it("does not corrupt high Unicode codepoints during base64 -> string round-trip", async () => {
    // Verifies the TextDecoder('utf-8') path. A naive `atob()` would mangle this.
    const source = "Café — 𝕳ello";
    const b64 = utf8ToBase64(source);
    const result = await renderDocument(b64, "md");
    expect(result.markdownSource).toBe(source);
  });
});
