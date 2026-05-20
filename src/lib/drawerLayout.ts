/**
 * Shared two-drawer width clamp — Phase-1 in-scope bullet #10 math.
 * Pure function, callable from BrowserDrawer's drag handler (and
 * adoptable by App.tsx's canvas drag handler).
 */

export interface ClampInput {
  proposedWidth: number;
  containerWidth: number;
  siblingDrawerWidth: number;
  selfMinWidth?: number; // default 280
  terminalMinWidth?: number; // default 48
}

export function clampDrawerWidth(input: ClampInput): number {
  const proposed = Number.isFinite(input.proposedWidth)
    ? Math.max(0, input.proposedWidth)
    : 0;
  const container = Number.isFinite(input.containerWidth)
    ? Math.max(0, input.containerWidth)
    : 0;
  const sibling = Number.isFinite(input.siblingDrawerWidth)
    ? Math.max(0, input.siblingDrawerWidth)
    : 0;
  const selfMin = input.selfMinWidth ?? 280;
  const terminalMin = input.terminalMinWidth ?? 48;

  const upperBound = container - sibling - terminalMin;
  if (upperBound < selfMin) {
    // Container too small to honor both drawers' minimums; return selfMin
    // and let the caller react.
    return selfMin;
  }
  return Math.min(Math.max(proposed, selfMin), upperBound);
}

/**
 * Pair-resolver: computes effective rendered widths for both drawers given
 * their stored INTENTS (user-dragged widths) and the current container size.
 *
 * The caller is responsible for materializing any null-sentinel intents
 * before calling this (e.g. canvas drawer's pre-first-drag null →
 * `Math.max(280, 0.35 * containerWidth)`). Helper inputs are purely numeric.
 *
 * Order-independence: each drawer's effective is computed against the
 * OTHER drawer's INTENT (not effective), so the result does not depend on
 * which side is evaluated first. Trade-off — at extreme asymmetric
 * intents (one drawer's intent far exceeds available budget, the other's
 * fits), the intent-sibling formulation can leave proportionally some
 * width unallocated to the terminal that a sibling-effective formulation
 * would recover. Acceptable for v1; a future fixed-point iteration could
 * close the gap if product cares.
 *
 * Handle budgeting: each open drawer contributes one drag handle of
 * `handleWidth` px (default 4 — Tailwind `w-1` = 0.25rem). The total is
 * folded into the terminal reserve so per-drawer clamps don't claim the
 * handle pixels.
 */
export interface ResolveDrawerWidthsInput {
  /** User's intended canvas drawer width (must be materialized — no null). */
  canvasIntent: number;
  /** User's intended browser drawer width. */
  browserIntent: number;
  containerWidth: number;
  canvasOpen: boolean;
  browserOpen: boolean;
  canvasMin?: number;       // default 280
  browserMin?: number;      // default 280
  terminalMin?: number;     // default 48
  /** Per-handle width in px. Default 4 (Tailwind w-1). */
  handleWidth?: number;
}

export interface ResolveDrawerWidthsOutput {
  canvasEffective: number;
  browserEffective: number;
}

export function resolveDrawerWidths(
  input: ResolveDrawerWidthsInput,
): ResolveDrawerWidthsOutput {
  const canvasOpen = input.canvasOpen;
  const browserOpen = input.browserOpen;
  const handleWidth = input.handleWidth ?? 4;
  const tMin = input.terminalMin ?? 48;

  // One drag handle is rendered per open drawer (between the drawer and
  // the terminal). Total handle budget = open-count × handleWidth.
  const handleCount = (canvasOpen ? 1 : 0) + (browserOpen ? 1 : 0);
  const handlesTotal = handleCount * handleWidth;

  const canvasEffective = !canvasOpen
    ? 0
    : clampDrawerWidth({
        proposedWidth: input.canvasIntent,
        containerWidth: input.containerWidth,
        // Sibling = OTHER drawer's intent (not effective) — order-free
        siblingDrawerWidth: browserOpen ? input.browserIntent : 0,
        selfMinWidth: input.canvasMin ?? 280,
        terminalMinWidth: tMin + handlesTotal,
      });

  const browserEffective = !browserOpen
    ? 0
    : clampDrawerWidth({
        proposedWidth: input.browserIntent,
        containerWidth: input.containerWidth,
        siblingDrawerWidth: canvasOpen ? input.canvasIntent : 0,
        selfMinWidth: input.browserMin ?? 280,
        terminalMinWidth: tMin + handlesTotal,
      });

  return { canvasEffective, browserEffective };
}
