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
 * Implemented during Phase-6+ (downstream task). Skeleton stub —
 * type-only export so downstream code can import without runtime
 * resolution failure.
 */
export declare const classifyScheme: UrlSchemeClassifier["classifyScheme"];
