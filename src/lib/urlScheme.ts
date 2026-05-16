import type { SchemeClassification } from "../types/browser";

/**
 * URL-scheme classifier for the browser address bar — Phase 1 Q5
 * ALLOW/FILTER/DENY policy. Pure function, unit-testable in Vitest
 * without Tauri.
 *
 * Cross-reference requirement (Phase-3 Round-2 G3):
 * If you change the ALLOW/FILTER/DENY matrix below, ALSO update
 * `src-tauri/src/commands/browser.rs::validate_browser_url`.
 * Phase 6 validation includes a manual cross-matrix check.
 */

export interface UrlSchemeClassifier {
  /**
   * Responsibility: Classify a user-supplied address-bar input into
   * ALLOW / FILTER / DENY per the Phase-1 Q5 URL policy.
   *
   * Pipeline-position:
   *   AddressBar.handleSubmit → THIS → (allow→invoke navigate_browser
   *   / filter→browserStore.setError / deny→browserStore.setError)
   *
   * Inputs:
   *   - input: string — raw user input from the URL bar; may have
   *     leading/trailing whitespace, mixed-case scheme, or no scheme
   *     (treated as search-shorthand → deferred to v2, return filter
   *     with reason="scheme required" for v1).
   *
   * Outputs: SchemeClassification — tagged union with action and
   *   either normalizedUrl (allow) or reason (filter/deny).
   *
   * Side-effects: None. Pure function.
   *
   * Preconditions: None. Tolerant of empty string, malformed URLs,
   *   any scheme. The function is total over its input domain.
   *
   * Postconditions: Return value is one of three variants — never
   *   throws. Idempotent: repeated calls with the same input yield
   *   identical results.
   *
   * Failure-modes: None. (Total function over its preconditions.)
   *   Malformed URLs are categorized as `{action:"filter", reason:
   *   "...could not parse..."}` rather than thrown.
   *
   * Collaborators: None. Pure standard-lib URL parsing.
   */
  classifyScheme(input: string): SchemeClassification;
}

/**
 * Phase-5 type-only placeholder.
 *
 * IMPORTANT (Phase-5 Round-1 codex2 P1 / codex3 #3 correction):
 * `declare const` is erased at TS emit time and produces NO runtime
 * binding. Type-checking succeeds, but any runtime import like
 * `import { classifyScheme } from "./urlScheme"` followed by an
 * actual call WILL FAIL at module load with "classifyScheme is not
 * a function". Treat this export as a **type-check-only** signature
 * placeholder; implementation must REPLACE this `declare const`
 * with a real `export const classifyScheme: UrlSchemeClassifier
 * ["classifyScheme"] = (input) => { ... }` or
 * `export function classifyScheme(input) { ... }` form before any
 * runtime consumer can use it.
 */
export declare const classifyScheme: UrlSchemeClassifier["classifyScheme"];
