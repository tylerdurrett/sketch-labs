import { describe, expect, it, vi } from "vitest";

import { resolveCompositionFrame, type Scene, type Sketch } from "@harness/core";

import { outlineScene } from "./outlineScene";

describe("outlineScene Composition Frame seam", () => {
  it("generates the requested t in the explicit frame before hidden-line processing", () => {
    const frame = resolveCompositionFrame(2);
    const scene: Scene = { space: frame, primitives: [] };
    const generate = vi.fn(() => scene);
    const sketch = {
      id: "frame-probe",
      name: "Frame probe",
      schema: {},
      generate,
    } as Sketch;

    expect(outlineScene(sketch, { density: 3 }, 17, 2.5, frame)).toEqual(scene);
    expect(generate).toHaveBeenCalledWith({ density: 3 }, 17, 2.5, frame);
  });
});
