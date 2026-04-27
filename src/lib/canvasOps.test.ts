import { describe, it, expect } from "vitest";
import * as fabric from "fabric";
import { exportImportedMarkdown } from "./canvasOps";

describe("exportImportedMarkdown", () => {
  // Mock just the surface area exportImportedMarkdown touches.
  // Avoids constructing a real fabric.Canvas (happy-dom can't render it,
  // and the lib-under-test only iterates getObjects()).
  type CanvasMock = Pick<fabric.Canvas, "getObjects">;
  const makeCanvas = (objects: object[]): fabric.Canvas =>
    ({ getObjects: () => objects } as CanvasMock as fabric.Canvas);

  it("returns null for an empty canvas", () => {
    expect(exportImportedMarkdown(makeCanvas([]))).toBe(null);
  });

  it("returns null when no object carries markdownSource", () => {
    expect(exportImportedMarkdown(makeCanvas([{}, { other: "data" }]))).toBe(null);
  });

  it("concatenates markdownSource of multiple imported objects with separators", () => {
    const a = { markdownSource: "# A" };
    const b = { markdownSource: "# B" };
    const out = exportImportedMarkdown(makeCanvas([a, b]));
    expect(out).toBe("# A\n\n---\n\n# B");
  });

  it("ignores objects without markdownSource alongside ones that have it", () => {
    const out = exportImportedMarkdown(
      makeCanvas([{ markdownSource: "first" }, {}, { markdownSource: "third" }]),
    );
    expect(out).toBe("first\n\n---\n\nthird");
  });
});
