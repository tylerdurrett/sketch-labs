import { describe, expect, it } from "vitest";

import type { ParamSchema, Scene } from "@harness/core";

import {
  copyScribbleComputeIdentity,
  createScribbleComputeIdentity,
  isScribbleComputeFailure,
  isScribbleComputeIdentity,
  isScribbleComputeProgress,
  isScribbleComputeRequest,
  isScribbleComputeResponse,
  isScribbleComputeSuccess,
  isScribbleWorkerMessage,
  scribbleComputeIdentitiesEqual,
  type ScribbleComputeIdentity,
} from "./scribbleComputeProtocol";

const schema: ParamSchema = {
  zeta: { kind: "number", min: 0, max: 10, default: 1 },
  alpha: { kind: "color", default: "#112233" },
  middle: { kind: "number", min: 0, max: 10, default: 2 },
};

const imageAssetSchema: ParamSchema = {
  imageAsset: { kind: "image-asset", default: "portrait-default" },
};

const scene: Scene = {
  space: { width: 120, height: 90 },
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
      hiddenLineRole: "both",
    },
  ],
};

function identity(
  overrides: Partial<{
    sketchId: string;
    params: Record<string, unknown>;
    seed: string | number;
    compositionFrame: { width: number; height: number };
  }> = {},
): ScribbleComputeIdentity {
  return createScribbleComputeIdentity({
    sketchId: overrides.sketchId ?? "tone-calibration",
    schema,
    // Deliberately differs from both schema order and alphabetical order.
    params: overrides.params ?? {
      middle: 8,
      zeta: 3,
      ignored: 99,
      alpha: "#abcdef",
    },
    seed: overrides.seed ?? "seed",
    compositionFrame: overrides.compositionFrame ?? {
      width: 120,
      height: 90,
    },
  });
}

function imageAssetIdentity(value: unknown): ScribbleComputeIdentity {
  return createScribbleComputeIdentity({
    sketchId: "photo-scribble",
    schema: imageAssetSchema,
    params: { imageAsset: value },
    seed: "seed",
    compositionFrame: { width: 120, height: 90 },
  });
}

function success() {
  return {
    type: "success",
    jobId: 7,
    identity: identity(),
    scene: structuredClone(scene),
    diagnostics: {
      termination: "completed",
      residualError: 0.02,
      pathLength: 123.5,
      polylineCount: 4,
      penLiftCount: 3,
    },
    computeTimeMs: 42.25,
  } as const;
}

function changed(
  mutate: (copy: Record<string, any>) => void,
): ScribbleComputeIdentity {
  const copy = structuredClone(identity()) as Record<string, any>;
  mutate(copy);
  return copy as ScribbleComputeIdentity;
}

describe("Scribble compute identity", () => {
  it("uses canonical schema declaration order, independent of params order", () => {
    const first = identity();
    const reordered = identity({
      params: { alpha: "#abcdef", middle: 8, zeta: 3 },
    });

    expect(first.params).toEqual([
      { key: "zeta", value: 3 },
      { key: "alpha", value: "#abcdef" },
      { key: "middle", value: 8 },
    ]);
    expect(scribbleComputeIdentitiesEqual(first, reordered)).toBe(true);
  });

  it("does not include extra params or any Outline-only derivation inputs", () => {
    const current = identity();

    expect(Object.keys(current)).toEqual([
      "sketchId",
      "params",
      "seed",
      "compositionFrame",
    ]);
    expect(current.params.some(({ key }) => key === "ignored")).toBe(false);
    expect(current).not.toHaveProperty("sampledT");
    expect(current).not.toHaveProperty("tolerance");
    expect(current).not.toHaveProperty("includeFrame");
    expect(current).not.toHaveProperty("sourceScene");
  });

  it("distinguishes every input change and never aliases Sketches", () => {
    const current = identity();
    const mutations: Array<(copy: Record<string, any>) => void> = [
      (copy) => (copy.sketchId = "scribble-moon"),
      (copy) => (copy.params[0].key = "other"),
      (copy) => (copy.params[0].value = 3 + 1e-12),
      (copy) => (copy.params[1].value = "#000000"),
      (copy) => copy.params.reverse(),
      (copy) => (copy.seed = "other-seed"),
      (copy) => (copy.compositionFrame.width = 121),
      (copy) => (copy.compositionFrame.height = 91),
    ];

    expect(scribbleComputeIdentitiesEqual(current, identity())).toBe(true);
    for (const mutate of mutations) {
      expect(scribbleComputeIdentitiesEqual(current, changed(mutate))).toBe(
        false,
      );
    }
  });

  it("copies into isolated, deeply immutable cache ownership", () => {
    const source = structuredClone(identity()) as ScribbleComputeIdentity;
    const copied = copyScribbleComputeIdentity(source);
    (source.params[0] as { key: string }).key = "mutated";
    (source.compositionFrame as { width: number }).width = 999;

    expect(copied.params[0]?.key).toBe("zeta");
    expect(copied.compositionFrame.width).toBe(120);
    expect(Object.isFrozen(copied)).toBe(true);
    expect(Object.isFrozen(copied.params)).toBe(true);
    expect(Object.isFrozen(copied.params[0])).toBe(true);
    expect(Object.isFrozen(copied.compositionFrame)).toBe(true);
  });

  it("keeps an Image Asset parameter as its opaque ID only", () => {
    const current = createScribbleComputeIdentity({
      sketchId: "photo-scribble",
      schema: imageAssetSchema,
      params: {
        imageAsset: "portrait-a1b2c3d4",
        raster: { width: 640, height: 480, pixels: [1, 2, 3, 4] },
        decodedImage: { src: "data:image/png;base64,opaque" },
      },
      seed: "seed",
      compositionFrame: { width: 120, height: 90 },
    });
    const cached = copyScribbleComputeIdentity(current);

    expect(current.params).toEqual([
      { key: "imageAsset", value: "portrait-a1b2c3d4" },
    ]);
    expect(cached.params).toEqual(current.params);
    expect(Object.keys(cached.params[0]!)).toEqual(["key", "value"]);
    expect(JSON.stringify(cached)).not.toContain("raster");
    expect(JSON.stringify(cached)).not.toContain("decodedImage");
  });

  it("treats every Image Asset string as an exact identity value", () => {
    const unresolved = "  unresolved://not-an-asset-id?variant=β\n";
    const current = imageAssetIdentity(unresolved);

    expect(current.params).toEqual([
      { key: "imageAsset", value: unresolved },
    ]);
    expect(
      scribbleComputeIdentitiesEqual(
        current,
        imageAssetIdentity("unresolved://not-an-asset-id?variant=β"),
      ),
    ).toBe(false);
    expect(imageAssetIdentity("").params[0]?.value).toBe("");
  });

  it("rejects only non-string Image Asset parameter values", () => {
    for (const value of [undefined, null, 42, {}, [], new String("asset")]) {
      expect(() => imageAssetIdentity(value)).toThrow(/imageAsset/);
    }
  });

  it("rejects missing, mistyped, and non-finite authored inputs", () => {
    expect(() => identity({ sketchId: "" })).toThrow(TypeError);
    expect(() =>
      identity({ params: { zeta: NaN, alpha: "#fff", middle: 1 } }),
    ).toThrow(/zeta/);
    expect(() =>
      identity({ params: { zeta: 1, alpha: 2, middle: 1 } }),
    ).toThrow(/alpha/);
    expect(() => identity({ params: { zeta: 1, alpha: "#fff" } })).toThrow(
      /middle/,
    );
    expect(() => identity({ seed: Infinity })).toThrow(TypeError);
    expect(() =>
      identity({ compositionFrame: { width: 0, height: 90 } }),
    ).toThrow(TypeError);
    expect(() =>
      identity({ compositionFrame: { width: 120, height: NaN } }),
    ).toThrow(TypeError);
  });
});

describe("Scribble compute protocol guards", () => {
  it("accepts strict request, progress, success, and failure messages", () => {
    const request = { type: "compute", jobId: 7, identity: identity() };
    const progress = {
      type: "progress",
      jobId: 7,
      snapshot: {
        completedWorkUnits: 2,
        totalWorkUnits: 10,
        terminal: false,
      },
    };
    const completed = success();
    const stoppedEarly = {
      ...completed,
      diagnostics: {
        ...completed.diagnostics,
        termination: "stopped-early",
      },
    };
    const failure = {
      type: "failure",
      jobId: 7,
      identity: identity(),
      error: "safe failure",
    };

    expect(isScribbleComputeRequest(request)).toBe(true);
    expect(isScribbleComputeProgress(progress)).toBe(true);
    expect(isScribbleComputeSuccess(completed)).toBe(true);
    expect(isScribbleComputeSuccess(stoppedEarly)).toBe(true);
    expect(isScribbleComputeFailure(failure)).toBe(true);
    expect(isScribbleComputeResponse(completed)).toBe(true);
    expect(isScribbleComputeResponse(failure)).toBe(true);
    expect(isScribbleWorkerMessage(progress)).toBe(true);
    expect(isScribbleWorkerMessage(completed)).toBe(true);
  });

  it("accepts early terminal progress and keeps it compact and identity-free", () => {
    const progress = {
      type: "progress",
      jobId: 7,
      snapshot: {
        completedWorkUnits: 2,
        totalWorkUnits: 10,
        terminal: true,
      },
    };
    expect(isScribbleComputeProgress(progress)).toBe(true);
    expect(
      isScribbleComputeProgress({
        ...progress,
        snapshot: {
          completedWorkUnits: 0,
          totalWorkUnits: 0,
          terminal: true,
        },
      }),
    ).toBe(true);
    expect(progress).not.toHaveProperty("identity");
    expect(
      isScribbleComputeProgress({ ...progress, identity: identity() }),
    ).toBe(false);
  });

  it("rejects extra fields at every request and identity level", () => {
    const current = identity();
    const invalidIdentities = [
      { ...current, extra: true },
      {
        ...current,
        compositionFrame: { ...current.compositionFrame, extra: 1 },
      },
      {
        ...current,
        params: [
          { ...current.params[0], extra: true },
          ...current.params.slice(1),
        ],
      },
      { ...current, params: [...current.params, current.params[0]] },
    ];

    for (const candidate of invalidIdentities) {
      expect(isScribbleComputeIdentity(candidate)).toBe(false);
    }
    expect(
      isScribbleComputeRequest({
        type: "compute",
        jobId: 7,
        identity: current,
        extra: true,
      }),
    ).toBe(false);
  });

  it("rejects malformed job ids, identities, and progress snapshots", () => {
    const current = identity();
    const progress = {
      type: "progress",
      jobId: 7,
      snapshot: {
        completedWorkUnits: 2,
        totalWorkUnits: 10,
        terminal: false,
      },
    };
    const invalid = [
      { ...progress, jobId: 0 },
      { ...progress, jobId: 1.5 },
      {
        ...progress,
        snapshot: { ...progress.snapshot, completedWorkUnits: -1 },
      },
      {
        ...progress,
        snapshot: { ...progress.snapshot, completedWorkUnits: 11 },
      },
      {
        ...progress,
        snapshot: { ...progress.snapshot, totalWorkUnits: Infinity },
      },
      { ...progress, snapshot: { ...progress.snapshot, terminal: "no" } },
      { ...progress, snapshot: { ...progress.snapshot, extra: true } },
    ];
    for (const candidate of invalid) {
      expect(isScribbleComputeProgress(candidate)).toBe(false);
    }
    expect(
      isScribbleComputeRequest({ type: "compute", jobId: 1, identity: {} }),
    ).toBe(false);
    expect(
      isScribbleComputeRequest({
        type: "compute",
        jobId: 1,
        identity: current,
      }),
    ).toBe(true);
  });

  it("rejects non-finite and extra fields throughout complete Scenes", () => {
    const mutations: Array<(copy: Record<string, any>) => void> = [
      (copy) => (copy.extra = true),
      (copy) => (copy.scene.extra = true),
      (copy) => (copy.scene.space.extra = true),
      (copy) => (copy.scene.space.width = Infinity),
      (copy) => (copy.scene.space.height = 0),
      (copy) => (copy.scene.background.extra = true),
      (copy) => (copy.scene.primitives[0].extra = true),
      (copy) => (copy.scene.primitives[0].points[0][0] = NaN),
      (copy) => copy.scene.primitives[0].points[0].push(3),
      (copy) => (copy.scene.primitives[0].fill.extra = true),
      (copy) => (copy.scene.primitives[0].stroke.extra = true),
      (copy) => (copy.scene.primitives[0].stroke.width = Infinity),
      (copy) => (copy.scene.primitives[0].hiddenLineRole = "unknown"),
    ];
    for (const mutate of mutations) {
      const candidate = structuredClone(success()) as Record<string, any>;
      mutate(candidate);
      expect(isScribbleComputeSuccess(candidate)).toBe(false);
    }
  });

  it("rejects malformed, non-finite, and extra diagnostics", () => {
    const mutations: Array<(copy: Record<string, any>) => void> = [
      (copy) => (copy.diagnostics.extra = true),
      (copy) => (copy.diagnostics.termination = "unknown"),
      (copy) => (copy.diagnostics.residualError = -0.1),
      (copy) => (copy.diagnostics.residualError = 1.1),
      (copy) => (copy.diagnostics.pathLength = Infinity),
      (copy) => (copy.diagnostics.polylineCount = 1.5),
      (copy) => (copy.diagnostics.penLiftCount = -1),
      (copy) => (copy.diagnostics.penLiftCount = 2),
      (copy) => (copy.computeTimeMs = NaN),
      (copy) => (copy.computeTimeMs = -1),
    ];
    for (const mutate of mutations) {
      const candidate = structuredClone(success()) as Record<string, any>;
      mutate(candidate);
      expect(isScribbleComputeSuccess(candidate)).toBe(false);
    }
  });

  it("does not accept one domain message as another", () => {
    const completed = success();
    const failure = {
      type: "failure",
      jobId: 7,
      identity: identity(),
      error: "safe failure",
    };

    expect(isScribbleComputeProgress(completed)).toBe(false);
    expect(isScribbleComputeFailure(completed)).toBe(false);
    expect(isScribbleComputeSuccess(failure)).toBe(false);
    expect(isScribbleComputeRequest(completed)).toBe(false);
  });
});
