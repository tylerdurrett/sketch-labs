import { describe, expect, it, vi } from "vitest";

import {
  DEFAULT_STROKE,
  hiddenLinePass,
  type PageFrame,
  type Scene,
} from "@harness/core";

import { finalizeOutlineScene, outlineScene } from "./outlineScene";

const source: Scene = {
  space: { width: 100, height: 80 },
  primitives: [
    {
      points: [
        [0, 0],
        [100, 80],
      ],
      stroke: { color: "tomato", width: 2 },
    },
  ],
  background: { color: "ivory" },
};

function pageRectangle(width: number, height: number) {
  return {
    points: [
      [0, 0],
      [width, 0],
      [width, height],
      [0, height],
      [0, 0],
    ],
    stroke: DEFAULT_STROKE,
  };
}

describe("outlineScene expensive processing seam", () => {
  it("applies the exact hidden-line pass to an already-sampled Scene", () => {
    expect(outlineScene(source, 2)).toEqual(
      hiddenLinePass(source, { tolerance: 2 }),
    );
  });

  it("forwards progress observation without changing output", () => {
    const observer = vi.fn();

    const observed = outlineScene(source, 0, observer);

    expect(observed).toEqual(outlineScene(source));
    expect(observer).toHaveBeenCalledWith(
      expect.objectContaining({ terminal: true }),
    );
  });

  it("does not mutate its source Scene", () => {
    const before = structuredClone(source);

    outlineScene(source, 1);

    expect(source).toEqual(before);
  });
});

describe("finalizeOutlineScene cheap Page finalization seam", () => {
  it("keeps unframed output in source Composition space", () => {
    const finalized = finalizeOutlineScene(source, null, false);

    expect(finalized).toBe(source);
    expect(finalized.space).toEqual({ width: 100, height: 80 });
    expect(finalized.primitives).toEqual(source.primitives);
  });

  it("appends an open black Page rectangle last in unframed Composition space", () => {
    const finalized = finalizeOutlineScene(source, null, true);

    expect(finalized.primitives.slice(0, -1)).toEqual(source.primitives);
    expect(finalized.primitives.at(-1)).toEqual(pageRectangle(100, 80));
    expect(finalized.primitives.at(-1)).not.toHaveProperty("closed");
    expect(finalized.primitives.at(-1)).not.toHaveProperty("fill");
  });

  it.each([
    {
      name: "crop",
      frame: { x: 20, y: 10, width: 60, height: 40 },
      expectedPoints: [
        [0, 20],
        [60, 20],
      ],
    },
    {
      name: "pad",
      frame: { x: -10, y: -20, width: 120, height: 120 },
      expectedPoints: [
        [10, 50],
        [110, 50],
      ],
    },
    {
      name: "mixed crop and pad",
      frame: { x: -10, y: 10, width: 80, height: 90 },
      expectedPoints: [
        [10, 20],
        [80, 20],
      ],
    },
  ] satisfies ReadonlyArray<{
    name: string;
    frame: PageFrame;
    expectedPoints: number[][];
  }>)(
    "applies a $name Page Frame before appending the exact final Page rectangle",
    ({ frame, expectedPoints }) => {
      const framingSource: Scene = {
        space: source.space,
        primitives: [
          {
            points: [
              [0, 30],
              [100, 30],
            ],
          },
        ],
      };
      const finalized = finalizeOutlineScene(framingSource, frame, true);

      expect(finalized.space).toEqual({
        width: frame.width,
        height: frame.height,
      });
      expect(finalized.primitives[0]?.points).toEqual(expectedPoints);
      expect(finalized.primitives.at(-1)).toEqual(
        pageRectangle(frame.width, frame.height),
      );
      expect(finalized.primitives).toHaveLength(
        finalizeOutlineScene(framingSource, frame, false).primitives.length + 1,
      );
    },
  );

  it("still applies a committed Page Frame when the Page rectangle is disabled", () => {
    const frame: PageFrame = { x: -10, y: 10, width: 80, height: 90 };
    const finalized = finalizeOutlineScene(source, frame, false);

    expect(finalized.space).toEqual({ width: 80, height: 90 });
    expect(finalized.primitives).not.toContainEqual(pageRectangle(80, 90));
  });

  it("toggles only cheap finalization around the same retained base", () => {
    const frame: PageFrame = { x: -10, y: -20, width: 120, height: 120 };
    const base = structuredClone(source);
    const before = structuredClone(base);

    const hidden = finalizeOutlineScene(base, frame, false);
    const visible = finalizeOutlineScene(base, frame, true);
    const hiddenAgain = finalizeOutlineScene(base, frame, false);
    finalizeOutlineScene(base, null, true);
    finalizeOutlineScene(base, null, false);

    expect(hiddenAgain).toEqual(hidden);
    expect(visible.primitives.slice(0, -1)).toEqual(hidden.primitives);
    expect(base).toEqual(before);
  });
});
