import { describe, it, expect } from "vitest";
import {
  ZOOM_STEPS,
  ZOOM_DEFAULT,
  nextZoomStep,
  prevZoomStep,
} from "./browserStore";

describe("browser zoom step helpers", () => {
  const FLOOR = ZOOM_STEPS[0];
  const CEIL = ZOOM_STEPS[ZOOM_STEPS.length - 1];

  it("exposes a Chrome-style ladder with 1.0 in the middle", () => {
    expect(ZOOM_DEFAULT).toBe(1.0);
    expect(ZOOM_STEPS).toContain(1.0);
    expect(FLOOR).toBe(0.25);
    expect(CEIL).toBe(5.0);
  });

  describe("nextZoomStep", () => {
    it("advances to the next-higher step from an exact ladder value", () => {
      expect(nextZoomStep(1.0)).toBe(1.1);
      expect(nextZoomStep(0.9)).toBe(1.0);
      expect(nextZoomStep(2.0)).toBe(2.5);
    });

    it("returns the ceiling unchanged at the top of the ladder", () => {
      expect(nextZoomStep(CEIL)).toBe(CEIL);
    });

    it("returns the second step when called on the floor", () => {
      expect(nextZoomStep(FLOOR)).toBe(0.33);
    });

    it("snaps to the nearest-bracketing-higher step from a mid-step input", () => {
      // 1.05 sits between 1.0 and 1.1 → next is 1.1.
      expect(nextZoomStep(1.05)).toBe(1.1);
      // 0.42 sits between 0.33 and 0.5 → next is 0.5.
      expect(nextZoomStep(0.42)).toBe(0.5);
    });

    it("clamps absurd inputs", () => {
      expect(nextZoomStep(-10)).toBe(0.33);
      expect(nextZoomStep(100)).toBe(CEIL);
    });
  });

  describe("prevZoomStep", () => {
    it("retreats to the next-lower step from an exact ladder value", () => {
      expect(prevZoomStep(1.0)).toBe(0.9);
      expect(prevZoomStep(1.1)).toBe(1.0);
      expect(prevZoomStep(0.33)).toBe(0.25);
    });

    it("returns the floor unchanged at the bottom of the ladder", () => {
      expect(prevZoomStep(FLOOR)).toBe(FLOOR);
    });

    it("returns the penultimate step when called on the ceiling", () => {
      expect(prevZoomStep(CEIL)).toBe(4.0);
    });

    it("snaps to the nearest-bracketing-lower step from a mid-step input", () => {
      // 1.05 sits between 1.0 and 1.1 → prev is 1.0.
      expect(prevZoomStep(1.05)).toBe(1.0);
      // 0.42 sits between 0.33 and 0.5 → prev is 0.33.
      expect(prevZoomStep(0.42)).toBe(0.33);
    });

    it("clamps absurd inputs", () => {
      expect(prevZoomStep(-10)).toBe(FLOOR);
      expect(prevZoomStep(100)).toBe(4.0);
    });
  });
});
