import { describe, expect, it, vi } from "vitest";

import { createDetailField } from "@harness/core";

import { rasterizeDetailReference } from "./detailReference";

describe("rasterizeDetailReference", () => {
  it("writes exact opaque grayscale bytes for smooth, strongest, and intermediate detail", () => {
    const raster = rasterizeDetailReference(
      createDetailField(([x]) => (x < 1 ? 0 : x < 2 ? 1 : 0.5)),
      { width: 3, height: 1 },
      3,
      1,
    );

    expect([...raster.data]).toEqual([
      0, 0, 0, 255,
      255, 255, 255, 255,
      128, 128, 128, 255,
    ]);
  });

  it("maps backing pixel centers into full Composition coordinates", () => {
    const sampled: Array<readonly [number, number]> = [];
    rasterizeDetailReference(
      createDetailField((point) => {
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

  it("maps pixel centers over an asymmetric committed Page Frame", () => {
    const sampled: Array<readonly [number, number]> = [];
    rasterizeDetailReference(
      createDetailField((point) => {
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
    ["left", { x: -10, y: 0, width: 20, height: 10 }, 2, 1, [0, 255]],
    ["right", { x: 0, y: 0, width: 20, height: 10 }, 2, 1, [255, 0]],
    ["top", { x: 0, y: -10, width: 10, height: 20 }, 1, 2, [0, 255]],
    ["bottom", { x: 0, y: 0, width: 10, height: 20 }, 1, 2, [255, 0]],
  ] as const)(
    "renders %s padding black without sampling beyond the Composition",
    (_side, pageFrame, width, height, expectedGray) => {
      const sample = vi.fn(() => 1);
      const raster = rasterizeDetailReference(
        createDetailField(sample),
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
      expect(sample).toHaveBeenCalledOnce();
    },
  );

  it("keeps asymmetric mixed crop-and-padding black outside both Composition axes", () => {
    const sample = vi.fn(() => 1);
    const raster = rasterizeDetailReference(
      createDetailField(sample),
      { width: 10, height: 10 },
      2,
      2,
      { x: 5, y: -5, width: 10, height: 10 },
    );

    expect(
      Array.from({ length: 4 }, (_, index) => raster.data[index * 4]),
    ).toEqual([0, 0, 255, 0]);
    expect(sample).toHaveBeenCalledOnce();
    expect(sample).toHaveBeenCalledWith([7.5, 2.5]);
  });

  it("returns a well-formed empty raster for an empty backing store", () => {
    expect(
      rasterizeDetailReference(
        createDetailField(() => 1),
        { width: 100, height: 100 },
        0,
        0,
      ),
    ).toEqual({ width: 0, height: 0, data: new Uint8ClampedArray() });
  });
});
