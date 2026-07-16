import { describe, expect, it } from "vitest";

import {
  createShadingMask,
  createToneField,
  type ToneSource,
} from "@harness/core";

import { rasterizeToneReference } from "./toneReference";

function source(
  tone: (point: readonly [number, number]) => number,
  mask: (point: readonly [number, number]) => number = () => 1,
): ToneSource {
  return {
    toneField: createToneField(tone),
    shadingMask: createShadingMask(mask),
  };
}

describe("rasterizeToneReference", () => {
  it("writes exact opaque grayscale bytes for paper, ink, and soft permission", () => {
    const raster = rasterizeToneReference(
      source(
        ([x]) => (x < 1 ? 0 : 1),
        ([x]) => (x < 2 ? 1 : 0.5),
      ),
      { width: 3, height: 1 },
      3,
      1,
    );

    expect([...raster.data]).toEqual([
      255, 255, 255, 255,
      0, 0, 0, 255,
      128, 128, 128, 255,
    ]);
  });

  it("maps backing pixel centers into Composition Frame coordinates", () => {
    const sampled: Array<readonly [number, number]> = [];
    rasterizeToneReference(
      source((point) => {
        sampled.push(point);
        return 0;
      }),
      { width: 20, height: 40 },
      2,
      2,
    );

    expect(sampled).toEqual([
      [5, 10],
      [15, 10],
      [5, 30],
      [15, 30],
    ]);
  });

  it("returns a well-formed empty raster for an empty backing store", () => {
    expect(
      rasterizeToneReference(source(() => 1), { width: 100, height: 100 }, 0, 0),
    ).toEqual({ width: 0, height: 0, data: new Uint8ClampedArray() });
  });
});
