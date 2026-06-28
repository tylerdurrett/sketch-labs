import { describe, expect, it } from "vitest";

import { computeContainFit } from "./canvas-fit";

describe("computeContainFit", () => {
  it("letterboxes a wide non-square space, centering on the shorter (vertical) axis", () => {
    // 800x400 (2:1) into 1000x1000: width is the binding axis.
    // scale = min(1000/800, 1000/400) = min(1.25, 2.5) = 1.25.
    // scaled height = 400 * 1.25 = 500, leaving 500px split top/bottom = 250.
    const fit = computeContainFit(800, 400, 1000, 1000);

    expect(fit.scale).toBe(1.25);
    expect(fit.offsetX).toBe(0);
    expect(fit.offsetY).toBe(250);
  });

  it("letterboxes a tall non-square space, centering on the shorter (horizontal) axis", () => {
    // 400x800 (1:2) into 1000x1000: height is the binding axis.
    // scale = min(1000/400, 1000/800) = min(2.5, 1.25) = 1.25.
    // scaled width = 400 * 1.25 = 500, leaving 500px split left/right = 250.
    const fit = computeContainFit(400, 800, 1000, 1000);

    expect(fit.scale).toBe(1.25);
    expect(fit.offsetX).toBe(250);
    expect(fit.offsetY).toBe(0);
  });

  it("applies a single uniform scale (no per-axis distortion)", () => {
    // A non-square surface AND a non-square space: the scale must still be a
    // single factor, not pixelW/spaceW vs pixelH/spaceH chosen per axis.
    const fit = computeContainFit(800, 400, 1600, 600);

    // min(1600/800, 600/400) = min(2, 1.5) = 1.5 on BOTH axes.
    expect(fit.scale).toBe(1.5);
    // scaled = 1200x600 inside 1600x600 → 400px horizontal slack, centered.
    expect(fit.offsetX).toBe(200);
    expect(fit.offsetY).toBe(0);
  });

  it("fills a square space into a square surface with no offset (sanity)", () => {
    // The circles case: 1000x1000 into 1000x1000.
    const fit = computeContainFit(1000, 1000, 1000, 1000);

    expect(fit.scale).toBe(1);
    expect(fit.offsetX).toBe(0);
    expect(fit.offsetY).toBe(0);
  });
});
