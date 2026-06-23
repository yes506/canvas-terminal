import { describe, it, expect } from "vitest";
import type { Terminal } from "@xterm/xterm";
import { ScrollbackPolicy } from "./ScrollbackPolicy";

describe("ScrollbackPolicy", () => {
  it("caps mini <= main", () => {
    const p = new ScrollbackPolicy({ main: 10000, mini: 2000 });
    expect(p.limitFor("mini")).toBeLessThanOrEqual(p.limitFor("main"));
    expect(p.limitFor("main")).toBe(10000);
    expect(p.limitFor("mini")).toBe(2000);
  });

  it("enforce writes the resolved cap onto the terminal options", () => {
    const fake = { options: {} as { scrollback?: number } } as unknown as Terminal;
    const p = new ScrollbackPolicy({ main: 500, mini: 100 });
    p.enforce(fake, "mini");
    expect((fake.options as { scrollback?: number }).scrollback).toBe(100);
    p.enforce(fake, "main");
    expect((fake.options as { scrollback?: number }).scrollback).toBe(500);
  });

  it("enforce swallows a disposed-terminal throw", () => {
    const throwing = {
      get options(): never {
        throw new Error("disposed");
      },
    } as unknown as Terminal;
    const p = new ScrollbackPolicy();
    expect(() => p.enforce(throwing, "main")).not.toThrow();
  });
});
