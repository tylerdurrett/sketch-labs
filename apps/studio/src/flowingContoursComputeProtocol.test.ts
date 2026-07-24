import { describe, expect, it } from "vitest";

import {
  defaultParams,
  flowingContours,
  type Scene,
} from "@harness/core";

import {
  createFlowingContoursComputeIdentity,
  flowingContoursComputeIdentitiesEqual,
  isFlowingContoursComputeIdentity,
  isFlowingContoursComputeResponse,
  isFlowingContoursComputeSuccess,
} from "./flowingContoursComputeProtocol";

const frame = { width: 120, height: 90 };
const scene: Scene = {
  space: frame,
  primitives: [
    {
      points: [
        [1, 2],
        [3, 4],
      ],
      stroke: { color: "black", width: 1, lineCap: "round" },
      hiddenLineRole: "source",
    },
  ],
};

function identity() {
  return createFlowingContoursComputeIdentity({
    sketchId: flowingContours.id,
    schema: flowingContours.schema,
    params: {
      extra: "ignored",
      ...defaultParams(flowingContours.schema),
    },
    seed: "seed",
    compositionFrame: frame,
  });
}

describe("Flowing Contours compute protocol", () => {
  it("projects schema params in declaration order and retains only asset identity", () => {
    const value = identity();
    expect(value.sketchId).toBe("flowing-contours");
    expect(value.params.map(({ key }) => key)).toEqual(
      Object.keys(flowingContours.schema),
    );
    expect(value.params[0]).toEqual({
      key: "imageAsset",
      value: defaultParams(flowingContours.schema).imageAsset,
    });
    expect(isFlowingContoursComputeIdentity(value)).toBe(true);
    expect(
      flowingContoursComputeIdentitiesEqual(value, structuredClone(value)),
    ).toBe(true);
  });

  it("rejects every non-canonical worker opt-in id", () => {
    expect(() =>
      createFlowingContoursComputeIdentity({
        sketchId: "photo-scribble",
        schema: flowingContours.schema,
        params: defaultParams(flowingContours.schema),
        seed: 1,
        compositionFrame: frame,
      }),
    ).toThrow(/registered id/);
  });

  it("strictly validates structured-cloned Scene output and exact frame", () => {
    const success = {
      type: "success",
      jobId: 1,
      identity: identity(),
      scene,
      computeTimeMs: 12.5,
    };
    expect(isFlowingContoursComputeSuccess(success)).toBe(true);
    expect(isFlowingContoursComputeResponse(structuredClone(success))).toBe(
      true,
    );

    const extra = structuredClone(success) as Record<string, any>;
    extra.scene.primitives[0].unexpected = true;
    expect(isFlowingContoursComputeSuccess(extra)).toBe(false);

    const wrongFrame = structuredClone(success) as Record<string, any>;
    wrongFrame.scene.space.width += 1;
    expect(isFlowingContoursComputeSuccess(wrongFrame)).toBe(false);

    const nonFinite = structuredClone(success) as Record<string, any>;
    nonFinite.scene.primitives[0].points[0][0] = Number.NaN;
    expect(isFlowingContoursComputeSuccess(nonFinite)).toBe(false);
  });
});
