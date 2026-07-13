import { describe, expect, it } from "vitest";

import type { ParamSchema, Scene } from "@harness/core";

import {
  createOutlineComputeIdentity,
  isOutlineComputeProgress,
  isOutlineComputeRequest,
  isOutlineComputeResponse,
  outlineComputeIdentitiesEqual,
  type OutlineComputeIdentity,
} from "./outlineComputeProtocol";

const schema: ParamSchema = {
  zeta: { kind: "number", min: 0, max: 10, default: 1 },
  alpha: { kind: "color", default: "#112233" },
};

const scene: Scene = {
  space: { width: 100, height: 80 },
  background: { color: "ivory" },
  primitives: [
    {
      points: [
        [1, 2],
        [30, 4],
        [5, 60],
      ],
      closed: true,
      fill: { color: "red" },
      stroke: { color: "blue", width: 2 },
    },
    {
      points: [
        [70, 10],
        [90, 20],
      ],
      stroke: { color: "black", width: 1 },
    },
  ],
};

function identity(): OutlineComputeIdentity {
  return createOutlineComputeIdentity({
    sketchId: "triangles",
    schema,
    params: { zeta: 3, alpha: "#abcdef", ignored: 99 },
    seed: "seed",
    sampledT: 1.5,
    compositionFrame: { width: 120, height: 90 },
    tolerance: 0.25,
    includeFrame: true,
    sourceScene: scene,
  });
}

function changed(
  update: (copy: Record<string, any>) => void,
): OutlineComputeIdentity {
  const copy = structuredClone(identity()) as Record<string, any>;
  update(copy);
  return copy as unknown as OutlineComputeIdentity;
}

describe("outline compute identity", () => {
  it("takes a sorted, deeply immutable snapshot of schema-backed inputs", () => {
    const snapshot = identity();
    expect(snapshot.params).toEqual([
      { key: "alpha", value: "#abcdef" },
      { key: "zeta", value: 3 },
    ]);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.params)).toBe(true);
    expect(Object.isFrozen(snapshot.sourceScene.primitives[0]?.points[0])).toBe(
      true,
    );

    scene.space.width = 999;
    scene.primitives[0]!.points[0]![0] = 999;
    expect(snapshot.sourceScene.space.width).toBe(100);
    expect(snapshot.sourceScene.primitives[0]?.points[0]?.[0]).toBe(1);
    scene.space.width = 100;
    scene.primitives[0]!.points[0]![0] = 1;
  });

  it("compares every outline-affecting field exactly", () => {
    const original = identity();
    const mutations: Array<(copy: Record<string, any>) => void> = [
      (copy) => (copy.sketchId = "other"),
      (copy) => (copy.params[0].key = "beta"),
      (copy) => (copy.params[0].value = "#000000"),
      (copy) => (copy.seed = "other"),
      (copy) => (copy.sampledT = 1.5000000000000002),
      (copy) => (copy.compositionFrame.width = 121),
      (copy) => (copy.compositionFrame.height = 91),
      (copy) => (copy.tolerance = 0.25000000000000006),
      (copy) => (copy.includeFrame = false),
      (copy) => (copy.sourceScene.space.width = 101),
      (copy) => (copy.sourceScene.space.height = 81),
      (copy) => (copy.sourceScene.background.color = "white"),
      (copy) => delete copy.sourceScene.background,
      (copy) => (copy.sourceScene.primitives[0].closed = false),
      (copy) => delete copy.sourceScene.primitives[0].closed,
      (copy) => (copy.sourceScene.primitives[0].fill.color = "green"),
      (copy) => delete copy.sourceScene.primitives[0].fill,
      (copy) => (copy.sourceScene.primitives[0].stroke.color = "black"),
      (copy) => (copy.sourceScene.primitives[0].stroke.width = 3),
      (copy) => delete copy.sourceScene.primitives[0].stroke,
      (copy) => (copy.sourceScene.primitives[0].points[0][0] = 1 + Number.EPSILON),
      (copy) => (copy.sourceScene.primitives[0].points[0][1] = 3),
      (copy) => copy.sourceScene.primitives[0].points.push([9, 9]),
      (copy) => copy.sourceScene.primitives.push(structuredClone(copy.sourceScene.primitives[0])),
      (copy) => copy.sourceScene.primitives.reverse(),
    ];
    expect(outlineComputeIdentitiesEqual(original, structuredClone(original))).toBe(
      true,
    );
    for (const mutate of mutations) {
      expect(outlineComputeIdentitiesEqual(original, changed(mutate))).toBe(false);
    }
  });

  it("uses Object.is rather than rounded or JSON equality", () => {
    const original = identity();
    expect(
      outlineComputeIdentitiesEqual(
        changed((copy) => (copy.tolerance = -0)),
        changed((copy) => (copy.tolerance = 0)),
      ),
    ).toBe(false);
    expect(outlineComputeIdentitiesEqual(original, identity())).toBe(true);
  });
});

describe("outline compute protocol guards", () => {
  it("accepts complete requests and responses", () => {
    const current = identity();
    expect(
      isOutlineComputeRequest({ type: "compute", jobId: 1, identity: current }),
    ).toBe(true);
    expect(
      isOutlineComputeResponse({
        type: "success",
        jobId: 1,
        identity: current,
        scene,
      }),
    ).toBe(true);
    expect(
      isOutlineComputeProgress({
        type: "progress",
        jobId: 1,
        snapshot: {
          completedWorkUnits: 4,
          totalWorkUnits: 10,
          terminal: false,
        },
      }),
    ).toBe(true);
    expect(
      isOutlineComputeProgress({
        type: "progress",
        jobId: 1,
        snapshot: {
          completedWorkUnits: 0,
          totalWorkUnits: 0,
          terminal: true,
        },
      }),
    ).toBe(true);
    expect(
      isOutlineComputeResponse({
        type: "failure",
        jobId: 1,
        identity: current,
        error: "bad",
      }),
    ).toBe(true);
  });

  it.each([null, {}, { type: "compute" }, { type: "compute", jobId: 0 }])(
    "rejects malformed request %o",
    (candidate) => expect(isOutlineComputeRequest(candidate)).toBe(false),
  );

  it.each([null, {}, { type: "success" }, { type: "failure", error: 4 }])(
    "rejects malformed response %o",
    (candidate) => expect(isOutlineComputeResponse(candidate)).toBe(false),
  );

  it.each([
    null,
    {},
    { type: "progress", jobId: 0, snapshot: {} },
    {
      type: "progress",
      jobId: 1.5,
      snapshot: { completedWorkUnits: 0, totalWorkUnits: 1, terminal: false },
    },
    {
      type: "progress",
      jobId: 1,
      snapshot: { completedWorkUnits: -1, totalWorkUnits: 1, terminal: false },
    },
    {
      type: "progress",
      jobId: 1,
      snapshot: { completedWorkUnits: 2, totalWorkUnits: 1, terminal: false },
    },
    {
      type: "progress",
      jobId: 1,
      snapshot: {
        completedWorkUnits: Number.NaN,
        totalWorkUnits: 1,
        terminal: false,
      },
    },
    {
      type: "progress",
      jobId: 1,
      snapshot: {
        completedWorkUnits: 0,
        totalWorkUnits: Infinity,
        terminal: false,
      },
    },
    {
      type: "progress",
      jobId: 1,
      snapshot: { completedWorkUnits: 0, totalWorkUnits: 1, terminal: true },
    },
  ])("rejects malformed progress %o", (candidate) => {
    expect(isOutlineComputeProgress(candidate)).toBe(false);
  });
});
