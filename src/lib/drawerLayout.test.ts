import { describe, it, expect } from "vitest";
import { clampDrawerWidth } from "./drawerLayout";

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
