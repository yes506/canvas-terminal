import { describe, it, expect } from "vitest";
import { clampDrawerWidth, resolveDrawerWidths } from "./drawerLayout";

describe("clampDrawerWidth", () => {
  it("returns proposed width when within bounds", () => {
    expect(
      clampDrawerWidth({
        proposedWidth: 500,
        containerWidth: 1200,
        siblingDrawerWidth: 0,
      }),
    ).toBe(500);
  });

  it("clamps below selfMinWidth", () => {
    expect(
      clampDrawerWidth({
        proposedWidth: 100,
        containerWidth: 1200,
        siblingDrawerWidth: 0,
      }),
    ).toBe(280);
  });

  it("clamps above upper bound (containerWidth - sibling - terminalMin)", () => {
    expect(
      clampDrawerWidth({
        proposedWidth: 9999,
        containerWidth: 1200,
        siblingDrawerWidth: 300,
      }),
    ).toBe(1200 - 300 - 48);
  });

  it("respects siblingDrawerWidth", () => {
    expect(
      clampDrawerWidth({
        proposedWidth: 800,
        containerWidth: 1200,
        siblingDrawerWidth: 400,
      }),
    ).toBe(1200 - 400 - 48);
  });

  it("returns selfMinWidth when container is too small to honor both drawers", () => {
    expect(
      clampDrawerWidth({
        proposedWidth: 300,
        containerWidth: 500,
        siblingDrawerWidth: 400,
      }),
    ).toBe(280);
  });

  it("honors custom selfMinWidth and terminalMinWidth overrides", () => {
    expect(
      clampDrawerWidth({
        proposedWidth: 9999,
        containerWidth: 1000,
        siblingDrawerWidth: 200,
        selfMinWidth: 100,
        terminalMinWidth: 100,
      }),
    ).toBe(700);
  });

  it("tolerates NaN/Infinity inputs", () => {
    expect(
      clampDrawerWidth({
        proposedWidth: Number.NaN,
        containerWidth: 1200,
        siblingDrawerWidth: 0,
      }),
    ).toBe(280); // proposed -> 0 -> clamped up to selfMin
    // Infinity is non-finite; treated as 0 (safer-on-bad-input) which
    // then clamps up to selfMin. NOT treated as "maximum"; the impl
    // deliberately fails closed on invalid numeric input.
    expect(
      clampDrawerWidth({
        proposedWidth: Number.POSITIVE_INFINITY,
        containerWidth: 1200,
        siblingDrawerWidth: 0,
      }),
    ).toBe(280);
  });

  it("tolerates negative inputs (treats as 0)", () => {
    expect(
      clampDrawerWidth({
        proposedWidth: -50,
        containerWidth: 1200,
        siblingDrawerWidth: -10,
      }),
    ).toBe(280);
  });
});

describe("resolveDrawerWidths", () => {
  it("preserves both intents when container is roomy", () => {
    const { canvasEffective, browserEffective } = resolveDrawerWidths({
      canvasIntent: 350,
      browserIntent: 350,
      containerWidth: 1400,
      canvasOpen: true,
      browserOpen: true,
    });
    expect(canvasEffective).toBe(350);
    expect(browserEffective).toBe(350);
  });

  it("clamps both intents to selfMin under squeeze (minWidth=800 scenario)", () => {
    // Reproduces the user-reported snapshot: drag canvas to 490 + browser
    // to 600 at 1400-px window, then shrink to 800 px. Helper must keep
    // both drawers at 280 (degraded mode); terminal absorbs the rest.
    const { canvasEffective, browserEffective } = resolveDrawerWidths({
      canvasIntent: 490,
      browserIntent: 600,
      containerWidth: 800,
      canvasOpen: true,
      browserOpen: true,
    });
    expect(canvasEffective).toBe(280);
    expect(browserEffective).toBe(280);
    // Terminal budget = 800 - 280 - 280 - 2*4 (two handles) = 232 px > 48 min ✓
    const terminal =
      800 - canvasEffective - browserEffective - /* handles */ 8;
    expect(terminal).toBeGreaterThanOrEqual(48);
  });

  it("expands back toward stored intent when window grows (UX win from E1)", () => {
    // Same intents, container grows from 800 -> 1400. Effective widths
    // automatically grow back to intents — no manual restore needed.
    const r = resolveDrawerWidths({
      canvasIntent: 490,
      browserIntent: 600,
      containerWidth: 1400,
      canvasOpen: true,
      browserOpen: true,
    });
    expect(r.canvasEffective).toBe(490);
    expect(r.browserEffective).toBe(600);
  });

  it("treats a materialized null-fallback canvas intent as a normal number", () => {
    // Caller's responsibility: materialize null → Math.max(280, 0.35*container).
    // Helper sees only the numeric result and treats it like any other intent.
    // (0.35 * 1400 is 489.99999... due to IEEE 754; the helper is unaffected
    // by sub-px precision — it just passes the number through clampDrawerWidth.)
    const containerWidth = 1400;
    const materializedCanvasIntent = Math.max(280, 0.35 * containerWidth);
    expect(materializedCanvasIntent).toBeCloseTo(490, 5);
    const r = resolveDrawerWidths({
      canvasIntent: materializedCanvasIntent,
      browserIntent: 600,
      containerWidth,
      canvasOpen: true,
      browserOpen: true,
    });
    expect(r.canvasEffective).toBeCloseTo(490, 5);
    expect(r.browserEffective).toBe(600);
  });

  it("budgets only one handle when only one drawer is open", () => {
    // canvas closed, browser open → 1 handle (4 px), not 2 (8 px).
    const r = resolveDrawerWidths({
      canvasIntent: 0, // ignored because canvasOpen=false
      browserIntent: 9999, // intentionally over: upper bound determines effective
      containerWidth: 1000,
      canvasOpen: false,
      browserOpen: true,
    });
    expect(r.canvasEffective).toBe(0);
    // upperBound = container - sibling(0) - (terminalMin + 1*handleWidth)
    //            = 1000 - 0 - (48 + 4) = 948
    expect(r.browserEffective).toBe(948);
  });

  it("returns 0 for both effective when neither drawer is open", () => {
    const r = resolveDrawerWidths({
      canvasIntent: 500,
      browserIntent: 500,
      containerWidth: 1200,
      canvasOpen: false,
      browserOpen: false,
    });
    expect(r.canvasEffective).toBe(0);
    expect(r.browserEffective).toBe(0);
  });

  it("honors custom handleWidth override (e.g. for tests with explicit widths)", () => {
    // With handleWidth=10, total handles budget = 20 px (2 drawers open).
    const r = resolveDrawerWidths({
      canvasIntent: 9999,
      browserIntent: 9999,
      containerWidth: 1000,
      canvasOpen: true,
      browserOpen: true,
      handleWidth: 10,
    });
    // Each clamp: upperBound = 1000 - other_intent(9999) - (48 + 20) = negative
    // → falls back to selfMin = 280.
    expect(r.canvasEffective).toBe(280);
    expect(r.browserEffective).toBe(280);
  });
});
