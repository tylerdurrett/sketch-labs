import { describe, expect, it } from "vitest";

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
});
