import { describe, expect, it, vi } from "vitest";

import { hiddenLinePass, type Scene } from "@harness/core";

import { outlineScene } from "./outlineScene";

describe("outlineScene processing seam", () => {
  it("applies the exact hidden-line pass to an already-sampled Scene", () => {
    const scene: Scene = {
      space: { width: 100, height: 100 },
      primitives: [
        {
          points: [
            [0, 0],
            [50, 0],
            [50, 50],
            [0, 50],
          ],
          closed: true,
          fill: { color: "tomato" },
        },
      ],
    };

    expect(outlineScene(scene, 2)).toEqual(
      hiddenLinePass(scene, { tolerance: 2 }),
    );
  });

  it("deep-equals the hidden-line result when the composition frame is disabled", () => {
    const scene: Scene = {
      space: { width: 120, height: 80 },
      primitives: [
        {
          points: [
            [10, 10],
            [60, 10],
            [35, 50],
          ],
          closed: true,
          fill: { color: "tomato" },
        },
      ],
    };

    expect(outlineScene(scene, 1, false)).toEqual(
      hiddenLinePass(scene, { tolerance: 1 }),
    );
  });

  it("appends one fill-free black open composition-frame path after hidden-line geometry", () => {
    const scene: Scene = {
      space: { width: 120, height: 80 },
      primitives: [
        {
          points: [
            [10, 10],
            [60, 10],
            [35, 50],
          ],
          closed: true,
          fill: { color: "tomato" },
        },
      ],
    };
    const hidden = hiddenLinePass(scene, { tolerance: 1 });
    const outlined = outlineScene(scene, 1, true);

    expect(outlined.primitives.slice(0, -1)).toEqual(hidden.primitives);
    expect(outlined.primitives).toHaveLength(hidden.primitives.length + 1);
    expect(outlined.primitives.at(-1)).toEqual({
      points: [
        [0, 0],
        [120, 0],
        [120, 80],
        [0, 80],
        [0, 0],
      ],
      stroke: { color: "black", width: 1 },
    });
  });

  it("forwards progress observation without changing output or frame ordering", () => {
    const scene: Scene = {
      space: { width: 12, height: 8 },
      primitives: [
        {
          points: [
            [1, 1],
            [6, 1],
            [3, 5],
          ],
          closed: true,
          fill: { color: "tomato" },
        },
      ],
    };
    const observer = vi.fn();

    const observed = outlineScene(scene, 0, true, observer);

    expect(observed).toEqual(outlineScene(scene, 0, true));
    expect(observer).toHaveBeenCalledWith(
      expect.objectContaining({ terminal: true }),
    );
    expect(observed.primitives.at(-1)?.points).toEqual([
      [0, 0],
      [12, 0],
      [12, 8],
      [0, 8],
      [0, 0],
    ]);
  });
});
