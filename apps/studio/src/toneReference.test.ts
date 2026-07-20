import { describe, expect, it, vi } from "vitest";

import {
  createShadingMask,
  createToneField,
  toneCalibration,
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

  it("maps pixel centers over an asymmetric committed Page Frame origin and extent", () => {
    const sampled: Array<readonly [number, number]> = [];
    rasterizeToneReference(
      source((point) => {
        sampled.push(point);
        return 0;
      }),
      { width: 20, height: 40 },
      2,
      2,
      { x: 2, y: 4, width: 12, height: 24 },
    );

    expect(sampled).toEqual([
      [5, 10],
      [11, 10],
      [5, 22],
      [11, 22],
    ]);
  });

  it.each([
    ["left", { x: -10, y: 0, width: 20, height: 10 }, 2, 1, [255, 0]],
    ["right", { x: 0, y: 0, width: 20, height: 10 }, 2, 1, [0, 255]],
    ["top", { x: 0, y: -10, width: 10, height: 20 }, 1, 2, [255, 0]],
    ["bottom", { x: 0, y: 0, width: 10, height: 20 }, 1, 2, [0, 255]],
  ] as const)(
    "renders %s padding as paper white without sampling beyond the Composition",
    (_side, pageFrame, width, height, expectedGray) => {
      const tone = vi.fn(() => 1);
      const mask = vi.fn(() => 1);
      const raster = rasterizeToneReference(
        source(tone, mask),
        { width: 10, height: 10 },
        width,
        height,
        pageFrame,
      );

      expect(
        Array.from({ length: width * height }, (_, index) =>
          raster.data[index * 4],
        ),
      ).toEqual(expectedGray);
      expect(tone).toHaveBeenCalledOnce();
      expect(mask).toHaveBeenCalledOnce();
    },
  );

  it("keeps mixed crop-and-padding white outside both Composition axes", () => {
    const tone = vi.fn(() => 1);
    const mask = vi.fn(() => 1);
    const raster = rasterizeToneReference(
      source(tone, mask),
      { width: 10, height: 10 },
      2,
      2,
      { x: 5, y: -5, width: 10, height: 10 },
    );

    expect(
      Array.from({ length: 4 }, (_, index) => raster.data[index * 4]),
    ).toEqual([255, 255, 0, 255]);
    expect(tone).toHaveBeenCalledOnce();
    expect(tone).toHaveBeenCalledWith([7.5, 2.5]);
    expect(mask).toHaveBeenCalledOnce();
    expect(mask).toHaveBeenCalledWith([7.5, 2.5]);
  });

  it("rasterizes Tone Calibration's two ramps and hard off-axis boundary to exact bytes", () => {
    const frame = { width: 10, height: 10 };
    const source = toneCalibration.generateToneSource!({}, frame);
    const raster = rasterizeToneReference(source, frame, 10, 10);
    const pixel = (x: number, y: number): number[] => {
      const offset = (y * raster.width + x) * 4;
      return [...raster.data.slice(offset, offset + 4)];
    };

    // The far-left exterior follows the background's downward 0 -> 1 ramp.
    expect([pixel(0, 0), pixel(0, 4), pixel(0, 9)]).toEqual([
      [242, 242, 242, 255],
      [140, 140, 140, 255],
      [13, 13, 13, 255],
    ]);

    // The central circle runs in the inverse direction, dark to light.
    expect([pixel(5, 1), pixel(5, 4), pixel(5, 8)]).toEqual([
      [16, 16, 16, 255],
      [112, 112, 112, 255],
      [239, 239, 239, 255],
    ]);

    // At y=2.5 (not the circle midline), adjacent exterior/interior centers
    // jump directly from the background to the inverse circle: no blend byte.
    expect([pixel(1, 2), pixel(2, 2)]).toEqual([
      [191, 191, 191, 255],
      [48, 48, 48, 255],
    ]);
  });

  it("returns a well-formed empty raster for an empty backing store", () => {
    expect(
      rasterizeToneReference(source(() => 1), { width: 100, height: 100 }, 0, 0),
    ).toEqual({ width: 0, height: 0, data: new Uint8ClampedArray() });
  });
});
