/**
 * Shared two-drawer width clamp — the math Phase-1 in-scope bullet
 * #10 promised. Pure function, callable from BrowserDrawer's drag
 * handler (and adoptable by App.tsx's existing canvas drag handler).
 */

export interface ClampInput {
  proposedWidth: number;
  containerWidth: number;
  siblingDrawerWidth: number;
  selfMinWidth?: number;     // default 280
  terminalMinWidth?: number; // default 48 (matches existing canvas clamp)
}

export interface DrawerLayoutClamp {
  /**
   * Responsibility: Clamp a proposed drawer width so the layout
   * always satisfies `selfMinWidth ≤ result ≤ (containerWidth -
   * siblingDrawerWidth - terminalMinWidth)`.
   *
   * Pipeline-position:
   *   BrowserDrawer.handleDragStart (or App.tsx canvas drag) → THIS
   *   → browserStore.setDrawerWidth (or canvasStore equivalent).
   *
   * Inputs:
   *   - input.proposedWidth: number — the cursor-derived drawer
   *     width the user is asking for, in CSS pixels.
   *   - input.containerWidth: number — total flex-container width
   *     (App.tsx ref), in CSS pixels.
   *   - input.siblingDrawerWidth: number — current width of the
   *     OTHER drawer (canvas if computing for browser; browser if
   *     computing for canvas). 0 if sibling is closed.
   *   - input.selfMinWidth: number — minimum width for THIS drawer.
   *     Defaults to 280 to match existing canvas-drawer clamp.
   *   - input.terminalMinWidth: number — minimum width reserved for
   *     the terminal column. Defaults to 48 (matches `App.tsx:71`
   *     `containerWidth - 48` logic).
   *
   * Outputs: number — clamped drawer width in CSS pixels. Always
   *   ≥ selfMinWidth and ≤ (containerWidth - siblingDrawerWidth -
   *   terminalMinWidth), unless the container is too small to
   *   honor both drawers' minimums simultaneously, in which case
   *   the result equals selfMinWidth (caller's responsibility to
   *   detect and react — typically by warning or closing siblings).
   *
   * Side-effects: None. Pure arithmetic.
   *
   * Preconditions: All numeric inputs are finite (no NaN, no
   *   Infinity). Negative numbers are tolerated but treated as 0.
   *
   * Postconditions: Return value is a finite non-negative number.
   *   Idempotent: same inputs always yield same output.
   *
   * Failure-modes: None. (Total function.)
   *
   * Collaborators: None. Pure arithmetic.
   */
  clampDrawerWidth(input: ClampInput): number;
}

/**
 * Phase-5 type-only placeholder. Same caveat as
 * `urlScheme.ts::classifyScheme` — `declare const` is erased at TS
 * emit time and has NO runtime binding. Implementation must replace
 * with `export const clampDrawerWidth: DrawerLayoutClamp
 * ["clampDrawerWidth"] = ...` (or function form) before any runtime
 * consumer can use it.
 */
export declare const clampDrawerWidth: DrawerLayoutClamp["clampDrawerWidth"];
