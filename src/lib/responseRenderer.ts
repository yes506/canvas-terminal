import { marked } from "marked";
import html2canvas from "html2canvas";

type ResponseFormat = "svg" | "html" | "markdown" | "text";

function detectFormat(content: string): ResponseFormat {
  const trimmed = content.trim();

  // SVG detection
  if (/^<svg[\s>]/i.test(trimmed) || (/^<\?xml/i.test(trimmed) && trimmed.includes("<svg"))) {
    return "svg";
  }

  // Full HTML document
  if (/^<!doctype\s+html/i.test(trimmed) || /^<html[\s>]/i.test(trimmed)) {
    return "html";
  }

  // Markdown indicators: headings, bold, lists, code blocks, tables, links
  const mdPatterns = [
    /^#{1,6}\s/m,       // headings
    /\*\*.+\*\*/,       // bold
    /^[-*+]\s/m,        // unordered lists
    /^\d+\.\s/m,        // ordered lists
    /^```/m,            // code fences
    /^\|.+\|$/m,        // tables
    /\[.+\]\(.+\)/,     // links
  ];
  if (mdPatterns.some((p) => p.test(trimmed))) {
    return "markdown";
  }

  return "text";
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function toHtml(content: string, format: ResponseFormat): string {
  switch (format) {
    case "svg":
      return `<div class="svg-container">${content}</div>`;
    case "html": {
      const bodyMatch = content.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
      return bodyMatch ? bodyMatch[1] : content;
    }
    case "markdown":
      return marked.parse(content) as string;
    case "text":
      return `<pre>${escapeHtml(content)}</pre>`;
  }
}

const RENDER_STYLES = `
  * { margin: 0; padding: 0; box-sizing: border-box; }
  :root { color: #d4d4d4; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; font-size: 14px; line-height: 1.6; }
  h1, h2, h3, h4, h5, h6 { color: #e0e0e0; margin: 0.6em 0 0.3em; }
  h1 { font-size: 1.5em; } h2 { font-size: 1.3em; } h3 { font-size: 1.15em; }
  p { margin: 0.4em 0; }
  pre { background: #2d2d2d; padding: 12px; border-radius: 6px; overflow-x: auto; margin: 0.5em 0; white-space: pre-wrap; word-break: break-word; font-family: 'JetBrainsMono Nerd Font Mono', 'Noto Sans Mono CJK KR', 'D2Coding', 'JetBrains Mono', monospace; font-size: 13px; }
  code { background: #2d2d2d; padding: 2px 5px; border-radius: 3px; font-family: 'JetBrainsMono Nerd Font Mono', 'Noto Sans Mono CJK KR', 'D2Coding', 'JetBrains Mono', monospace; font-size: 0.9em; }
  pre code { background: none; padding: 0; }
  ul, ol { padding-left: 1.5em; margin: 0.4em 0; }
  li { margin: 0.2em 0; }
  strong { color: #ffffff; }
  em { color: #c5c5c5; }
  a { color: #6db3f2; text-decoration: none; }
  blockquote { border-left: 3px solid #555; padding-left: 12px; margin: 0.5em 0; color: #aaa; }
  table { border-collapse: collapse; margin: 0.5em 0; width: 100%; }
  th, td { border: 1px solid #444; padding: 6px 10px; text-align: left; }
  th { background: #2d2d2d; color: #e0e0e0; }
  hr { border: none; border-top: 1px solid #444; margin: 0.8em 0; }
  img { max-width: 100%; }
  .svg-container svg { max-width: 100%; height: auto; }
`;

/**
 * Renders an AI text response (markdown, SVG, HTML, plain text) into a PNG data URL.
 * Uses an offscreen DOM container + html2canvas for rasterization.
 */
export async function renderResponseToDataUrl(content: string): Promise<string> {
  const format = detectFormat(content);
  const htmlContent = toHtml(content, format);

  // For SVG, try direct canvas rasterization first (higher fidelity than html2canvas)
  if (format === "svg" && content.trim()) {
    try {
      return await rasterizeSvg(content);
    } catch {
      // Fall through to html2canvas approach
    }
  }

  const container = document.createElement("div");
  container.style.cssText =
    "position:fixed;top:-9999px;left:-9999px;width:600px;padding:24px;background:#1e1e1e;";

  const style = document.createElement("style");
  style.textContent = RENDER_STYLES;
  container.appendChild(style);

  const inner = document.createElement("div");
  inner.innerHTML = htmlContent;
  container.appendChild(inner);

  document.body.appendChild(container);

  try {
    const canvas = await html2canvas(container, {
      backgroundColor: "#1e1e1e",
      scale: window.devicePixelRatio,
      useCORS: true,
    });
    return canvas.toDataURL("image/png");
  } finally {
    document.body.removeChild(container);
  }
}

/** Rasterize raw SVG content to PNG via Image + Canvas (higher fidelity for SVGs). */
function rasterizeSvg(svgContent: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const svgBlob = new Blob([svgContent], { type: "image/svg+xml;charset=utf-8" });
    const url = URL.createObjectURL(svgBlob);
    const img = new window.Image();
    img.onload = () => {
      const dpr = window.devicePixelRatio;
      const w = img.naturalWidth || 600;
      const h = img.naturalHeight || 400;
      const canvas = document.createElement("canvas");
      canvas.width = w * dpr;
      canvas.height = h * dpr;
      const ctx = canvas.getContext("2d")!;
      ctx.scale(dpr, dpr);
      // Dark background to match canvas theme
      ctx.fillStyle = "#1e1e1e";
      ctx.fillRect(0, 0, w, h);
      ctx.drawImage(img, 0, 0, w, h);
      URL.revokeObjectURL(url);
      resolve(canvas.toDataURL("image/png"));
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Failed to rasterize SVG"));
    };
    img.src = url;
  });
}
