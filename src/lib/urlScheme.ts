import type { SchemeClassification } from "../types/browser";

/**
 * URL-scheme classifier for the browser address bar — Phase 1 Q5
 * ALLOW/FILTER/DENY policy. Pure function, unit-testable in Vitest.
 *
 * Cross-reference requirement (Phase-3 Round-2 G3):
 * If you change the ALLOW/FILTER/DENY matrix below, ALSO update
 * `src-tauri/src/commands/browser.rs::validate_browser_url`.
 */

const FILTER_SCHEMES = [
  "javascript:",
  "data:",
  "tauri:",
  "tauri-localhost:",
  "vbscript:",
];

export function classifyScheme(input: string): SchemeClassification {
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    return { action: "filter", reason: "empty input" };
  }

  const lower = trimmed.toLowerCase();

  for (const sch of FILTER_SCHEMES) {
    if (lower.startsWith(sch)) {
      return {
        action: "filter",
        reason: `${sch.replace(":", "")} URLs blocked`,
      };
    }
  }
  if (lower.startsWith("file:")) {
    return { action: "deny", reason: "file: URLs disabled in v1" };
  }
  if (lower.startsWith("localfile:")) {
    // C1 THREE-way invariant — mirrors
    // src-tauri/src/commands/localfile.rs::validate_localfile_url_shape.
    // v1 shape is `localfile://localhost/<22 url-safe-base64>` (C9).
    const PREFIX = "localfile://localhost/";
    if (!trimmed.startsWith(PREFIX)) {
      return { action: "filter", reason: "localfile shape mismatch" };
    }
    const token = trimmed.slice(PREFIX.length);
    if (token.length !== 22 || !/^[A-Za-z0-9_-]{22}$/.test(token)) {
      return { action: "filter", reason: "localfile shape mismatch" };
    }
    return { action: "allow", normalizedUrl: trimmed };
  }
  if (lower === "about:blank") {
    return { action: "allow", normalizedUrl: "about:blank" };
  }

  try {
    const u = new URL(trimmed);
    if (u.protocol === "http:" || u.protocol === "https:") {
      return { action: "allow", normalizedUrl: u.toString() };
    }
    return { action: "filter", reason: `scheme '${u.protocol}' not allowed` };
  } catch (_e) {
    // Permissive fallback: scheme-less inputs treated as https://<input>.
    if (!/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) {
      try {
        const u = new URL(`https://${trimmed}`);
        return { action: "allow", normalizedUrl: u.toString() };
      } catch {
        // fall through
      }
    }
    return { action: "filter", reason: "cannot parse URL" };
  }
}
