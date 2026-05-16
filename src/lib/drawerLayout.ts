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
