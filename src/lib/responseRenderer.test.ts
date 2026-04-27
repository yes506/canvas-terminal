// @vitest-environment jsdom
//
// jsdom is used here (overriding the global happy-dom env in vitest.config.ts)
// because importing DOMPurify under happy-dom v20 leaves a `BrowserFrameNavigator`
// task pending after teardown, which logs a noisy "AsyncTaskManager has been
// destroyed" stderr line — fine for assertions but it pollutes CI output and
// would mask a real error in the same logs. jsdom doesn't trigger that path.
//
// This directive is scoped to this file only; every other test still uses happy-dom.

import { describe, it, expect } from "vitest";
import { toSanitizedHtml } from "./responseRenderer";

// These tests assert against the pure helper (HTML string output).
// `renderResponseToDataUrl` itself returns a PNG data URL and is not directly
// assertable for sanitization rules — that's why `toSanitizedHtml` is exported.

// Helper: markdown-detected wrapper so inline HTML is emitted as live tags by
// `marked.parse` rather than escaped into <pre> by the text fallback.
const md = (raw: string) => `# heading\n\n${raw}`;

describe("toSanitizedHtml — sanitize: true", () => {
  it("strips on* event handlers from inline HTML inside markdown", () => {
    const html = toSanitizedHtml(md("<img onerror='alert(1)' src='x'>"), {
      sanitize: true,
    });
    expect(html).not.toContain("onerror");
    // Image tag itself is also stripped (FORBID_TAGS) so html2canvas can't fetch.
    expect(html).not.toContain("<img");
  });

  it("strips <svg> entirely (USE_PROFILES.html excludes SVG)", () => {
    const html = toSanitizedHtml(md("<svg onload='alert(1)'></svg>"), {
      sanitize: true,
    });
    expect(html).not.toContain("<svg");
    expect(html).not.toContain("onload");
  });

  it("strips images produced by markdown ![](url) syntax to prevent outbound fetches", () => {
    const html = toSanitizedHtml("![pic](https://example.com/x.png)", {
      sanitize: true,
    });
    expect(html).not.toContain("<img");
    expect(html).not.toContain("example.com");
  });

  it("strips <iframe> (excluded by USE_PROFILES.html)", () => {
    const html = toSanitizedHtml(md("<iframe src='https://x'></iframe>"), {
      sanitize: true,
    });
    expect(html).not.toContain("<iframe");
  });

  it("preserves benign markdown structure (headings, lists, code)", () => {
    const html = toSanitizedHtml(
      "# Title\n- one\n- two\n\n```js\nconst x = 1;\n```",
      { sanitize: true },
    );
    expect(html).toContain("<h1");
    expect(html).toContain("<ul");
    expect(html).toContain("<code");
  });
});

describe("toSanitizedHtml — sanitize: false (default-off path)", () => {
  it("does not strip <img> when sanitize is omitted", () => {
    const html = toSanitizedHtml(md("<img onerror='alert(1)' src='x'>"));
    // Default-off must preserve existing AI-response rendering exactly.
    expect(html).toContain("onerror");
    expect(html).toContain("<img");
  });
});

describe("toSanitizedHtml — format override (used by .md import)", () => {
  it("forces markdown parsing for plain-text inputs that detectFormat would call 'text'", () => {
    // Without `format: "markdown"`, this would render as <pre>hello world</pre>
    // because `detectFormat` only recognizes markdown via headings/lists/etc.
    const html = toSanitizedHtml("hello world", {
      sanitize: true,
      format: "markdown",
    });
    expect(html).not.toContain("<pre>");
    expect(html).toContain("hello world");
    // `marked.parse` wraps a paragraph in <p>...</p>.
    expect(html).toContain("<p>");
  });

  it("strips raw <svg> when sanitize is true and the file is forced to markdown", () => {
    // Closes @codex1's HIGH finding: a `.md` file whose content is raw SVG used to take
    // the SVG fast-path and bypass DOMPurify entirely. With format: "markdown" plus the
    // sanitize-aware fast-path skip in renderResponseToDataUrl, this is no longer possible.
    const html = toSanitizedHtml("<svg onload='alert(1)'></svg>", {
      sanitize: true,
      format: "markdown",
    });
    expect(html).not.toContain("<svg");
    expect(html).not.toContain("onload");
  });
});
