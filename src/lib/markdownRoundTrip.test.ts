import { describe, it, expect } from "vitest";
import * as fabric from "fabric";

// End-to-end regression for the metadata persistence path used by Cmd+S → Cmd+O
// → Cmd+Shift+S. We test at the fabric **object** level (not canvas) because
// happy-dom's <canvas> doesn't provide a real 2D context, and StaticCanvas
// renders during loadFromJSON. Object serialization runs the same code path
// for custom properties, so this is a faithful proxy.
//
// This is the test @claude2 (task-32) flagged as missing — the only check that
// `markdownSource` survives a full save/reopen so the user-facing
// "import → save → reopen → export" flow doesn't silently drop metadata.

describe("markdownSource toObject / fromObject round-trip", () => {
  it("preserves markdownSource when propertiesToInclude lists it", async () => {
    const original = "# 안녕 🌟\n- 항목";
    const rect = new fabric.Rect({ width: 1, height: 1 });
    (rect as fabric.FabricObject & { markdownSource?: string }).markdownSource = original;

    // toObject(propertiesToInclude) is the same machinery canvas.toJSON([...]) uses.
    const obj = (rect.toObject as (props?: string[]) => Record<string, unknown>)([
      "markdownSource",
    ]);
    expect(obj.markdownSource).toBe(original);

    // Serialize/deserialize through JSON.
    const json = JSON.stringify(obj);
    const restoredObj = JSON.parse(json) as Record<string, unknown>;
    const restored = (await fabric.Rect.fromObject(restoredObj)) as fabric.FabricObject & {
      markdownSource?: string;
    };
    expect(restored.markdownSource).toBe(original);
  });

  it("drops markdownSource when toObject is called WITHOUT propertiesToInclude (control)", () => {
    // Negative control: confirms propertiesToInclude is what makes the round-trip work,
    // not a fabric default. If this test ever starts passing without the argument,
    // fabric's defaults changed — we can simplify the production code.
    const rect = new fabric.Rect({ width: 1, height: 1 });
    (rect as fabric.FabricObject & { markdownSource?: string }).markdownSource = "src";

    const obj = rect.toObject();
    expect((obj as { markdownSource?: string }).markdownSource).toBeUndefined();
  });
});
