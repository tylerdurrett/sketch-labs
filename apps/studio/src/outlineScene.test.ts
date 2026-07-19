import { describe, expect, it, vi } from "vitest";

import {
  DEFAULT_STROKE,
  hiddenLinePass,
  type PageFrame,
  type Scene,
} from "@harness/core";

import {
  finalizeOutlineScene,
  outlineScene,
  type OutlineFinalizationStrokePolicy,
} from "./outlineScene";

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

function pageRectangle(width: number, height: number, strokeWidth = 1) {
  return {
    points: [
      [0, 0],
      [width, 0],
      [width, height],
      [0, height],
      [0, 0],
    ],
    stroke: { ...DEFAULT_STROKE, width: strokeWidth },
  };
}

const physicalToolPolicy: OutlineFinalizationStrokePolicy = {
  kind: "physical-tool",
  target: {
    toolWidthMillimeters: 0.5,
    millimetersPerSceneUnit: 0.25,
  },
};

const legacyPolicy: OutlineFinalizationStrokePolicy = {
  ...physicalToolPolicy,
  kind: "legacy-scene",
};

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

  it("retargets every surviving opt-in stroke to the current physical width", () => {
    const base: Scene = {
      ...source,
      primitives: [
        source.primitives[0]!,
        {
          points: [
            [10, 10],
            [20, 20],
          ],
          stroke: { color: "navy", width: 9 },
        },
        {
          points: [
            [5, 5],
            [20, 5],
            [20, 20],
            [5, 20],
          ],
          closed: true,
          fill: { color: "paper" },
        },
      ],
    };
    const before = structuredClone(base);

    const finalized = finalizeOutlineScene(
      base,
      { x: 0, y: 0, width: 50, height: 40 },
      false,
      physicalToolPolicy,
    );

    expect(
      finalized.primitives
        .filter((primitive) => primitive.stroke !== undefined)
        .map((primitive) => primitive.stroke),
    ).toEqual([
      { color: "tomato", width: 2 },
      { color: "navy", width: 2 },
    ]);
    expect(
      finalized.primitives.find((primitive) => primitive.fill !== undefined)
        ?.stroke,
    ).toBeUndefined();
    expect(base).toEqual(before);
  });

  it("preserves authored legacy widths while carrying a current physical target", () => {
    const finalized = finalizeOutlineScene(source, null, false, legacyPolicy);

    expect(finalized).toBe(source);
    expect(finalized.primitives[0]?.stroke).toEqual({
      color: "tomato",
      width: 2,
    });
  });

  it.each([physicalToolPolicy, legacyPolicy])(
    "uses the current physical width for the Harness Page outline ($kind)",
    (policy) => {
      const finalized = finalizeOutlineScene(source, null, true, policy);

      expect(finalized.primitives.at(-1)).toEqual(
        pageRectangle(100, 80, 2),
      );
      expect(finalized.primitives.at(-1)?.stroke).not.toBe(DEFAULT_STROKE);
    },
  );

  it("rejects invalid current physical targets", () => {
    expect(() =>
      finalizeOutlineScene(source, null, false, {
        kind: "physical-tool",
        target: {
          toolWidthMillimeters: 0,
          millimetersPerSceneUnit: 0.2,
        },
      }),
    ).toThrow(/toolWidthMillimeters must be finite and positive/);
    expect(() =>
      finalizeOutlineScene(source, null, true, {
        kind: "legacy-scene",
        target: {
          toolWidthMillimeters: 0.3,
          millimetersPerSceneUnit: Number.NaN,
        },
      }),
    ).toThrow(/millimetersPerSceneUnit must be finite and positive/);
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
