import { describe, it, expect } from "vitest";
import { WebglContextBudget } from "./WebglContextBudget";

describe("WebglContextBudget", () => {
  it("grants up to the cap, then denies", () => {
    const b = new WebglContextBudget(2);
    expect(b.acquire("a").granted).toBe(true);
    expect(b.acquire("b").granted).toBe(true);
    const denied = b.acquire("c");
    expect(denied.granted).toBe(false);
    expect(denied.reason).toContain("cap reached");
    expect(b.activeCount()).toBe(2);
  });

  it("is idempotent on re-acquire (no double-count)", () => {
    const b = new WebglContextBudget(2);
    b.acquire("a");
    const again = b.acquire("a");
    expect(again.granted).toBe(true);
    expect(again.reason).toBe("already granted");
    expect(b.activeCount()).toBe(1);
  });

  it("frees a slot on release and tolerates unknown/double release", () => {
    const b = new WebglContextBudget(1);
    b.acquire("a");
    expect(b.acquire("b").granted).toBe(false); // full
    b.release("a");
    expect(b.activeCount()).toBe(0);
    b.release("a"); // double release — no underflow
    b.release("ghost"); // unknown — tolerated
    expect(b.activeCount()).toBe(0);
    expect(b.acquire("b").granted).toBe(true); // slot reusable
  });
});
