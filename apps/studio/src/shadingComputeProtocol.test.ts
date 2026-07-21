import { describe, expect, it } from "vitest";

import type { ParamSchema, Scene } from "@harness/core";

import {
  copyShadingComputeIdentity,
  createShadingComputeIdentity,
  isShadingComputeFailure,
  isShadingComputeIdentity,
  isShadingComputeProgress,
  isShadingComputeRequest,
  isShadingComputeResponse,
  isShadingComputeSuccess,
  isShadingWorkerMessage,
  shadingComputeIdentitiesEqual,
  type ShadingComputeIdentity,
} from "./shadingComputeProtocol";

const schema: ParamSchema = {
  zeta: { kind: "number", min: 0, max: 10, default: 1 },
  alpha: { kind: "color", default: "#112233" },
  middle: { kind: "number", min: 0, max: 10, default: 2 },
};

const imageAssetSchema: ParamSchema = {
  imageAsset: { kind: "image-asset", default: "portrait-default" },
};

const conditionalSchema: ParamSchema = {
  strategy: {
    kind: "choice",
    options: [
      { value: "scribble", label: "Scribble" },
      { value: "stippling", label: "Stippling" },
    ],
    default: "scribble",
  },
  scribbleDensity: {
    kind: "number",
    min: 0,
    max: 10,
    default: 1,
    activeWhen: { key: "strategy", equals: "scribble" },
  },
  scribbleFidelity: {
    kind: "number",
    min: 0,
    max: 10,
    default: 2,
    activeWhen: { key: "strategy", equals: "scribble" },
  },
  stippleDensity: {
    kind: "number",
    min: 0,
    max: 10,
    default: 3,
    activeWhen: { key: "strategy", equals: "stippling" },
  },
};

const widenedConditionalSchema: ParamSchema = {
  ...conditionalSchema,
  stippleRelaxation: {
    kind: "number",
    min: 0,
    max: 10,
    default: 0,
    identityDefault: "implicit",
    activeWhen: { key: "strategy", equals: "stippling" },
  },
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
      stroke: { color: "blue", width: 2, lineCap: "round" },
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
): ShadingComputeIdentity {
  return createShadingComputeIdentity({
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

function imageAssetIdentity(value: unknown): ShadingComputeIdentity {
  return createShadingComputeIdentity({
    sketchId: "photo-scribble",
    schema: imageAssetSchema,
    params: { imageAsset: value },
    seed: "seed",
    compositionFrame: { width: 120, height: 90 },
  });
}

function conditionalIdentity(
  params: Record<string, unknown>,
): ShadingComputeIdentity {
  return createShadingComputeIdentity({
    sketchId: "conditional",
    schema: conditionalSchema,
    params,
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
      pathLength: 123.5,
      polylineCount: 4,
      penLiftCount: 3,
      fidelity: { kind: "scribble", residualError: 0.02 },
    },
    computeTimeMs: 42.25,
  } as const;
}

function successWithFidelity(fidelity: unknown) {
  const candidate = structuredClone(success()) as Record<string, any>;
  candidate.diagnostics.fidelity = fidelity;
  return candidate;
}

function changed(
  mutate: (copy: Record<string, any>) => void,
): ShadingComputeIdentity {
  const copy = structuredClone(identity()) as Record<string, any>;
  mutate(copy);
  return copy as ShadingComputeIdentity;
}

describe("Shading compute identity", () => {
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
    expect(shadingComputeIdentitiesEqual(first, reordered)).toBe(true);
  });

  it("projects only the selected branch with schema defaults and declaration order", () => {
    const scribble = conditionalIdentity({
      scribbleFidelity: 8,
      stippleDensity: 9,
      extra: "ignored",
    });
    const stippling = conditionalIdentity({
      strategy: "stippling",
      scribbleDensity: 7,
      scribbleFidelity: 8,
      stippleDensity: 9,
      extra: "ignored",
    });

    expect(scribble.params).toEqual([
      { key: "strategy", value: "scribble" },
      { key: "scribbleDensity", value: 1 },
      { key: "scribbleFidelity", value: 8 },
    ]);
    expect(stippling.params).toEqual([
      { key: "strategy", value: "stippling" },
      { key: "stippleDensity", value: 9 },
    ]);
    expect(Object.isFrozen(stippling)).toBe(true);
    expect(Object.isFrozen(stippling.params)).toBe(true);
    expect(stippling.params.every(Object.isFrozen)).toBe(true);
  });

  it("omits only active implicit defaults from a synthetically widened schema", () => {
    const defaultRelaxation = createShadingComputeIdentity({
      sketchId: "conditional",
      schema: widenedConditionalSchema,
      params: {
        strategy: "stippling",
        stippleDensity: 7,
        stippleRelaxation: 0,
      },
      seed: "seed",
      compositionFrame: { width: 120, height: 90 },
    });
    const relaxed = createShadingComputeIdentity({
      sketchId: "conditional",
      schema: widenedConditionalSchema,
      params: {
        strategy: "stippling",
        stippleDensity: 7,
        stippleRelaxation: 3,
      },
      seed: "seed",
      compositionFrame: { width: 120, height: 90 },
    });
    const inactiveRetained = createShadingComputeIdentity({
      sketchId: "conditional",
      schema: widenedConditionalSchema,
      params: {
        strategy: "scribble",
        scribbleDensity: 4,
        scribbleFidelity: 5,
        stippleRelaxation: 3,
      },
      seed: "seed",
      compositionFrame: { width: 120, height: 90 },
    });

    expect(defaultRelaxation.params).toEqual([
      { key: "strategy", value: "stippling" },
      { key: "stippleDensity", value: 7 },
    ]);
    expect(relaxed.params).toEqual([
      { key: "strategy", value: "stippling" },
      { key: "stippleDensity", value: 7 },
      { key: "stippleRelaxation", value: 3 },
    ]);
    expect(inactiveRetained.params).toEqual([
      { key: "strategy", value: "scribble" },
      { key: "scribbleDensity", value: 4 },
      { key: "scribbleFidelity", value: 5 },
    ]);
  });

  it("ignores inactive edits but distinguishes active edits and restored branch values", () => {
    const scribble = conditionalIdentity({
      strategy: "scribble",
      scribbleDensity: 4,
      scribbleFidelity: 5,
      stippleDensity: 6,
    });
    const inactiveEdit = conditionalIdentity({
      strategy: "scribble",
      scribbleDensity: 4,
      scribbleFidelity: 5,
      stippleDensity: 9,
    });
    const activeEdit = conditionalIdentity({
      strategy: "scribble",
      scribbleDensity: 7,
      scribbleFidelity: 5,
      stippleDensity: 6,
    });
    const switched = conditionalIdentity({
      strategy: "stippling",
      scribbleDensity: 4,
      scribbleFidelity: 5,
      stippleDensity: 6,
    });
    const switchedWithRestoredEdit = conditionalIdentity({
      strategy: "stippling",
      scribbleDensity: 4,
      scribbleFidelity: 5,
      stippleDensity: 9,
    });

    expect(shadingComputeIdentitiesEqual(scribble, inactiveEdit)).toBe(true);
    expect(shadingComputeIdentitiesEqual(scribble, activeEdit)).toBe(false);
    expect(shadingComputeIdentitiesEqual(scribble, switched)).toBe(false);
    expect(
      shadingComputeIdentitiesEqual(switched, switchedWithRestoredEdit),
    ).toBe(false);
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

    expect(shadingComputeIdentitiesEqual(current, identity())).toBe(true);
    for (const mutate of mutations) {
      expect(shadingComputeIdentitiesEqual(current, changed(mutate))).toBe(
        false,
      );
    }
  });

  it("copies into isolated, deeply immutable cache ownership", () => {
    const source = structuredClone(identity()) as ShadingComputeIdentity;
    const copied = copyShadingComputeIdentity(source);
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
    const current = createShadingComputeIdentity({
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
    const cached = copyShadingComputeIdentity(current);

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
      shadingComputeIdentitiesEqual(
        current,
        imageAssetIdentity("unresolved://not-an-asset-id?variant=β"),
      ),
    ).toBe(false);
    expect(imageAssetIdentity("").params[0]?.value).toBe("");
  });

  it("preserves declared Choice strings and rejects invalid present values", () => {
    expect(
      createShadingComputeIdentity({
        sketchId: "tone-calibration",
        schema: conditionalSchema,
        params: { strategy: "stippling" },
        seed: "seed",
        compositionFrame: { width: 120, height: 90 },
      }).params,
    ).toEqual([
      { key: "strategy", value: "stippling" },
      { key: "stippleDensity", value: 3 },
    ]);
    for (const strategy of [1, undefined, "hatching"]) {
      expect(() =>
        createShadingComputeIdentity({
          sketchId: "tone-calibration",
          schema: conditionalSchema,
          params: { strategy },
          seed: "seed",
          compositionFrame: { width: 120, height: 90 },
        }),
      ).toThrow(/strategy/);
    }
  });

  it("rejects only non-string Image Asset parameter values", () => {
    for (const value of [undefined, null, 42, {}, [], new String("asset")]) {
      expect(() => imageAssetIdentity(value)).toThrow(/imageAsset/);
    }
  });

  it("defaults missing values and rejects mistyped or non-finite authored inputs", () => {
    expect(() => identity({ sketchId: "" })).toThrow(TypeError);
    expect(() =>
      identity({ params: { zeta: NaN, alpha: "#fff", middle: 1 } }),
    ).toThrow(/zeta/);
    expect(() =>
      identity({ params: { zeta: 1, alpha: 2, middle: 1 } }),
    ).toThrow(/alpha/);
    expect(identity({ params: { zeta: 1, alpha: "#fff" } }).params).toEqual([
      { key: "zeta", value: 1 },
      { key: "alpha", value: "#fff" },
      { key: "middle", value: 2 },
    ]);
    expect(() => identity({ seed: Infinity })).toThrow(TypeError);
    expect(() =>
      identity({ compositionFrame: { width: 0, height: 90 } }),
    ).toThrow(TypeError);
    expect(() =>
      identity({ compositionFrame: { width: 120, height: NaN } }),
    ).toThrow(TypeError);
  });
});

describe("Shading compute protocol guards", () => {
  it("accepts exact Scribble and Stippling fidelity variants at their boundaries", () => {
    for (const residualError of [0, 1]) {
      expect(
        isShadingComputeSuccess(
          successWithFidelity({ kind: "scribble", residualError }),
        ),
      ).toBe(true);
    }

    for (const distributionError of [0, 1.25, 2]) {
      expect(
        isShadingComputeSuccess(
          successWithFidelity({ kind: "stippling", distributionError }),
        ),
      ).toBe(true);
    }
  });

  it("accepts strict request, progress, success, and failure messages", () => {
    const request = { type: "compute", jobId: 7, identity: identity() };
    const progress = {
      type: "progress",
      jobId: 7,
      snapshot: {
        completedWorkUnits: 2,
        totalWorkUnits: 10,
        convergence: 0.25,
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

    expect(isShadingComputeRequest(request)).toBe(true);
    expect(isShadingComputeProgress(progress)).toBe(true);
    expect(isShadingComputeSuccess(completed)).toBe(true);
    expect(isShadingComputeSuccess(stoppedEarly)).toBe(true);
    expect(isShadingComputeFailure(failure)).toBe(true);
    expect(isShadingComputeResponse(completed)).toBe(true);
    expect(isShadingComputeResponse(failure)).toBe(true);
    expect(isShadingWorkerMessage(progress)).toBe(true);
    expect(isShadingWorkerMessage(completed)).toBe(true);
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
    expect(isShadingComputeProgress(progress)).toBe(true);
    expect(
      isShadingComputeProgress({
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
      isShadingComputeProgress({ ...progress, identity: identity() }),
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
      expect(isShadingComputeIdentity(candidate)).toBe(false);
    }
    expect(
      isShadingComputeRequest({
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
      { ...progress, snapshot: { ...progress.snapshot, convergence: -0.1 } },
      { ...progress, snapshot: { ...progress.snapshot, convergence: 1.1 } },
      { ...progress, snapshot: { ...progress.snapshot, convergence: NaN } },
      { ...progress, snapshot: { ...progress.snapshot, terminal: "no" } },
      { ...progress, snapshot: { ...progress.snapshot, extra: true } },
    ];
    for (const candidate of invalid) {
      expect(isShadingComputeProgress(candidate)).toBe(false);
    }
    expect(
      isShadingComputeRequest({ type: "compute", jobId: 1, identity: {} }),
    ).toBe(false);
    expect(
      isShadingComputeRequest({
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
      (copy) => (copy.scene.primitives[0].stroke.lineCap = "triangle"),
      (copy) => (copy.scene.primitives[0].hiddenLineRole = "unknown"),
    ];
    for (const mutate of mutations) {
      const candidate = structuredClone(success()) as Record<string, any>;
      mutate(candidate);
      expect(isShadingComputeSuccess(candidate)).toBe(false);
    }
  });

  it("rejects malformed, non-finite, and extra diagnostics", () => {
    const mutations: Array<(copy: Record<string, any>) => void> = [
      (copy) => (copy.diagnostics.extra = true),
      (copy) => (copy.diagnostics.termination = "unknown"),
      (copy) => (copy.diagnostics.pathLength = Infinity),
      (copy) => (copy.diagnostics.polylineCount = 1.5),
      (copy) => (copy.diagnostics.penLiftCount = -1),
      (copy) => (copy.diagnostics.penLiftCount = 2),
      (copy) => (copy.diagnostics.fidelity.extra = true),
      (copy) => (copy.diagnostics.fidelity.kind = "unknown"),
      (copy) => (copy.diagnostics.fidelity.residualError = -0.1),
      (copy) => (copy.diagnostics.fidelity.residualError = 1.1),
      (copy) => (copy.diagnostics.fidelity.residualError = NaN),
      (copy) => (copy.diagnostics.fidelity.residualError = Infinity),
      (copy) => (copy.computeTimeMs = NaN),
      (copy) => (copy.computeTimeMs = -1),
    ];
    for (const mutate of mutations) {
      const candidate = structuredClone(success()) as Record<string, any>;
      mutate(candidate);
      expect(isShadingComputeSuccess(candidate)).toBe(false);
    }
  });

  it("rejects malformed, out-of-range, mixed, and extra Stippling fidelity", () => {
    const malformedFidelity: readonly unknown[] = [
      null,
      { kind: "stippling" },
      { kind: "stippling", distributionError: "1.25" },
      { kind: "stippling", distributionError: -0.1 },
      { kind: "stippling", distributionError: 2.1 },
      { kind: "stippling", distributionError: NaN },
      { kind: "stippling", distributionError: Infinity },
      { kind: "stippling", distributionError: 1.25, residualError: 0.1 },
      { kind: "stippling", distributionError: 1.25, extra: true },
      { kind: "scribble", residualError: 0.1, distributionError: 1.25 },
    ];

    for (const fidelity of malformedFidelity) {
      expect(
        isShadingComputeSuccess(successWithFidelity(fidelity)),
      ).toBe(false);
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

    expect(isShadingComputeProgress(completed)).toBe(false);
    expect(isShadingComputeFailure(completed)).toBe(false);
    expect(isShadingComputeSuccess(failure)).toBe(false);
    expect(isShadingComputeRequest(completed)).toBe(false);
  });
});
