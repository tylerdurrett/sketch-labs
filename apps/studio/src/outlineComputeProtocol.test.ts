import { describe, expect, it } from "vitest";

import type { ParamSchema, Scene } from "@harness/core";

import {
  createHiddenLineExportSnapshot,
  createOutlineComputeIdentity,
  isHiddenLineWorkerMessage,
  isOutlineComputeProgress,
  isOutlineComputeRequest,
  isOutlineComputeResponse,
  mutableScene,
  outlineComputeIdentitiesEqual,
  outlineGeometryIdentitiesEqual,
  type CompletedSceneOutlineComputeIdentity,
  type LegacyOutlineComputeIdentity,
  type SpecializedOutlineComputeIdentity,
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
      hiddenLineRole: "occluder",
    },
    {
      points: [
        [70, 10],
        [90, 20],
      ],
      stroke: { color: "black", width: 1 },
      hiddenLineRole: "source",
    },
  ],
};

function identity(): LegacyOutlineComputeIdentity {
  return createOutlineComputeIdentity({
    sketchId: "triangles",
    schema,
    params: { zeta: 3, alpha: "#abcdef", ignored: 99 },
    seed: "seed",
    sampledT: 1.5,
    compositionFrame: { width: 120, height: 90 },
    tolerance: 0.25,
    sourceScene: scene,
  });
}

function targetedIdentity(): SpecializedOutlineComputeIdentity {
  return createOutlineComputeIdentity({
    sketchId: "triangles",
    schema,
    params: { zeta: 3, alpha: "#abcdef" },
    seed: "seed",
    sampledT: 1.5,
    compositionFrame: { width: 120, height: 90 },
    tolerance: 0.25,
    outlineTarget: {
      toolWidthMillimeters: 0.3,
      millimetersPerSceneUnit: 0.18,
    },
  });
}

function completedSceneIdentity(): CompletedSceneOutlineComputeIdentity {
  return createOutlineComputeIdentity({
    sketchId: "triangles",
    schema,
    params: { zeta: 3, alpha: "#abcdef" },
    seed: "seed",
    sampledT: 1.5,
    compositionFrame: { width: 120, height: 90 },
    tolerance: 0.25,
    sourceScene: scene,
    outlineTarget: {
      toolWidthMillimeters: 0.3,
      millimetersPerSceneUnit: 0.18,
    },
  });
}

function changed(
  update: (copy: Record<string, any>) => void,
): LegacyOutlineComputeIdentity {
  const copy = structuredClone(identity()) as Record<string, any>;
  update(copy);
  return copy as unknown as LegacyOutlineComputeIdentity;
}

function changedTargeted(
  update: (copy: Record<string, any>) => void,
): SpecializedOutlineComputeIdentity {
  const copy = structuredClone(targetedIdentity()) as Record<string, any>;
  update(copy);
  return copy as unknown as SpecializedOutlineComputeIdentity;
}

function changedCompleted(
  update: (copy: Record<string, any>) => void,
): CompletedSceneOutlineComputeIdentity {
  const copy = structuredClone(completedSceneIdentity()) as Record<string, any>;
  update(copy);
  return copy as unknown as CompletedSceneOutlineComputeIdentity;
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
    expect(snapshot.sourceScene.primitives[0]?.hiddenLineRole).toBe("occluder");
    expect(snapshot.sourceScene.primitives[1]?.hiddenLineRole).toBe("source");
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
      (copy) => (copy.sourceScene.primitives[0].hiddenLineRole = "both"),
      (copy) => delete copy.sourceScene.primitives[0].hiddenLineRole,
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

  it("keys reusable geometry by every normalized input and deep legacy Scene field", () => {
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
      (copy) => (copy.sourceScene.primitives[0].hiddenLineRole = "both"),
      (copy) => delete copy.sourceScene.primitives[0].hiddenLineRole,
      (copy) => (copy.sourceScene.primitives[0].points[0][0] += Number.EPSILON),
      (copy) => (copy.sourceScene.primitives[0].points[0][1] = 3),
      (copy) => copy.sourceScene.primitives[0].points.push([9, 9]),
      (copy) => copy.sourceScene.primitives.push(
        structuredClone(copy.sourceScene.primitives[0]),
      ),
      (copy) => copy.sourceScene.primitives.reverse(),
    ];

    expect(
      outlineGeometryIdentitiesEqual(original, structuredClone(original)),
    ).toBe(true);
    for (const mutate of mutations) {
      expect(outlineGeometryIdentitiesEqual(original, changed(mutate))).toBe(
        false,
      );
    }
  });

  it("reuses both opt-in identity kinds across OutlineTarget-only changes", () => {
    const specialized = targetedIdentity();
    const specializedTargetChange = changedTargeted((copy) => {
      copy.outlineTarget.toolWidthMillimeters = 0.31;
      copy.outlineTarget.millimetersPerSceneUnit = 0.2;
    });
    const completed = completedSceneIdentity();
    const completedTargetChange = changedCompleted((copy) => {
      copy.outlineTarget.toolWidthMillimeters = 0.31;
      copy.outlineTarget.millimetersPerSceneUnit = 0.2;
    });

    expect(
      outlineGeometryIdentitiesEqual(specialized, specializedTargetChange),
    ).toBe(true);
    expect(
      outlineComputeIdentitiesEqual(specialized, specializedTargetChange),
    ).toBe(false);
    expect(
      outlineGeometryIdentitiesEqual(completed, completedTargetChange),
    ).toBe(true);
    expect(
      outlineComputeIdentitiesEqual(completed, completedTargetChange),
    ).toBe(false);
  });

  it("never reuses across source kinds or absent/present source Scenes", () => {
    const identities = [identity(), targetedIdentity(), completedSceneIdentity()];
    for (const left of identities) {
      for (const right of identities) {
        expect(outlineGeometryIdentitiesEqual(left, right)).toBe(left === right);
      }
    }
  });

  it("requires an exact completed source Scene while ignoring only its target", () => {
    const original = completedSceneIdentity();
    const mutations: Array<(copy: Record<string, any>) => void> = [
      (copy) => (copy.sketchId = "other"),
      (copy) => (copy.params[0].value = "#000000"),
      (copy) => (copy.seed = "other"),
      (copy) => (copy.sampledT = 1.5000000000000002),
      (copy) => (copy.compositionFrame.width = 121),
      (copy) => (copy.compositionFrame.height = 91),
      (copy) => (copy.tolerance = 0.25000000000000006),
      (copy) => (copy.sourceScene.space.width = 101),
      (copy) => (copy.sourceScene.background.color = "white"),
      (copy) => (copy.sourceScene.primitives[0].closed = false),
      (copy) => (copy.sourceScene.primitives[0].fill.color = "green"),
      (copy) => (copy.sourceScene.primitives[0].stroke.color = "black"),
      (copy) => (copy.sourceScene.primitives[0].stroke.width = 3),
      (copy) => (copy.sourceScene.primitives[0].hiddenLineRole = "both"),
      (copy) => (copy.sourceScene.primitives[0].points[0][0] = 2),
      (copy) => copy.sourceScene.primitives.reverse(),
    ];

    for (const mutate of mutations) {
      expect(
        outlineGeometryIdentitiesEqual(original, changedCompleted(mutate)),
      ).toBe(false);
    }
  });

  it("keeps Page Frame and includeFrame outside expensive identity", () => {
    const original = identity();
    expect(original).not.toHaveProperty("includeFrame");
    expect(original).not.toHaveProperty("pageFrame");

    const withFinalizationFields = {
      ...structuredClone(original),
      includeFrame: false,
      pageFrame: { x: 10, y: 5, width: 80, height: 60 },
    };
    expect(
      outlineComputeIdentitiesEqual(
        original,
        withFinalizationFields as LegacyOutlineComputeIdentity,
      ),
    ).toBe(true);
  });

  it("keys specialized results by every frozen derivation input", () => {
    const target = targetedIdentity();
    const mutations: Array<(copy: Record<string, any>) => void> = [
      (copy) => (copy.sketchId = "other-sketch"),
      (copy) => (copy.params[0].value = "#000000"),
      (copy) => (copy.params[1].value = 4),
      (copy) => (copy.seed = "other-seed"),
      (copy) => (copy.sampledT = 1.5000000000000002),
      (copy) => (copy.compositionFrame.width = 121),
      (copy) => (copy.compositionFrame.height = 91),
      (copy) => (copy.outlineTarget.toolWidthMillimeters = 0.31),
      (copy) => (copy.outlineTarget.millimetersPerSceneUnit = 0.2),
      (copy) => (copy.tolerance = 0.25000000000000006),
    ];

    expect(Object.isFrozen(target.outlineTarget)).toBe(true);
    expect(target.sourceKind).toBe("specialized-sketch");
    expect("sourceScene" in target).toBe(false);
    expect(outlineComputeIdentitiesEqual(target, targetedIdentity())).toBe(true);
    for (const mutate of mutations) {
      expect(
        outlineComputeIdentitiesEqual(target, changedTargeted(mutate)),
      ).toBe(false);
    }
    expect(outlineComputeIdentitiesEqual(target, identity())).toBe(false);
  });

  it("copies and keys completed-Scene specialization by both Scene and target", () => {
    const completed = completedSceneIdentity();
    expect(completed.sourceKind).toBe("completed-scene-sketch");
    expect(Object.isFrozen(completed.sourceScene)).toBe(true);
    expect(Object.isFrozen(completed.sourceScene.primitives[0]?.points[0])).toBe(
      true,
    );
    expect(Object.isFrozen(completed.outlineTarget)).toBe(true);
    expect(
      outlineComputeIdentitiesEqual(completed, completedSceneIdentity()),
    ).toBe(true);

    for (const mutate of [
      (copy: Record<string, any>) =>
        (copy.sourceScene.primitives[0].points[0][0] = 2),
      (copy: Record<string, any>) =>
        (copy.sourceScene.primitives[0].hiddenLineRole = "both"),
      (copy: Record<string, any>) =>
        (copy.outlineTarget.toolWidthMillimeters = 0.31),
      (copy: Record<string, any>) =>
        (copy.outlineTarget.millimetersPerSceneUnit = 0.2),
    ]) {
      expect(
        outlineComputeIdentitiesEqual(completed, changedCompleted(mutate)),
      ).toBe(false);
    }
    expect(outlineComputeIdentitiesEqual(completed, identity())).toBe(false);
    expect(outlineComputeIdentitiesEqual(completed, targetedIdentity())).toBe(
      false,
    );
  });

  it("restores source and occluder roles without inventing omitted fields", () => {
    const restored = mutableScene(identity().sourceScene);
    const omitted = changed((copy) => {
      delete copy.sourceScene.primitives[1].hiddenLineRole;
    });

    expect(restored.primitives[0]?.hiddenLineRole).toBe("occluder");
    expect(restored.primitives[1]?.hiddenLineRole).toBe("source");
    expect(
      "hiddenLineRole" in mutableScene(omitted.sourceScene).primitives[1]!,
    ).toBe(false);
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

  it("rejects non-positive or non-finite specialized tool targets", () => {
    for (const outlineTarget of [
      { toolWidthMillimeters: 0, millimetersPerSceneUnit: 0.18 },
      { toolWidthMillimeters: 0.3, millimetersPerSceneUnit: Infinity },
    ]) {
      expect(() =>
        createOutlineComputeIdentity({
          sketchId: "triangles",
          schema,
          params: { zeta: 3, alpha: "#abcdef" },
          seed: "seed",
          sampledT: 0,
          compositionFrame: { width: 100, height: 80 },
          tolerance: 0,
          outlineTarget,
        }),
      ).toThrow(/Outline compute identity contains an invalid value/);
    }
  });

  it("validates completed-Scene identities without accepting either half alone", () => {
    const completed = completedSceneIdentity();
    expect(
      isOutlineComputeRequest({ type: "compute", jobId: 1, identity: completed }),
    ).toBe(true);

    const withoutScene = structuredClone(completed) as unknown as Record<
      string,
      unknown
    >;
    delete withoutScene.sourceScene;
    const withoutTarget = structuredClone(completed) as unknown as Record<
      string,
      unknown
    >;
    delete withoutTarget.outlineTarget;
    expect(
      isOutlineComputeRequest({ type: "compute", jobId: 1, identity: withoutScene }),
    ).toBe(false);
    expect(
      isOutlineComputeRequest({ type: "compute", jobId: 1, identity: withoutTarget }),
    ).toBe(false);
  });

  it("rejects identities that mix legacy and specialized sources", () => {
    const mixedSpecialized = structuredClone(targetedIdentity()) as unknown as Record<
      string,
      unknown
    >;
    mixedSpecialized.sourceScene = scene;
    const mixedLegacy = structuredClone(identity()) as unknown as Record<
      string,
      unknown
    >;
    mixedLegacy.outlineTarget = {
      toolWidthMillimeters: 0.3,
      millimetersPerSceneUnit: 0.18,
    };

    expect(isOutlineComputeRequest({
      type: "compute",
      jobId: 1,
      identity: mixedSpecialized,
    })).toBe(false);
    expect(isOutlineComputeRequest({
      type: "compute",
      jobId: 1,
      identity: mixedLegacy,
    })).toBe(false);
  });

  it("rejects unknown hidden-line roles in requests and response Scenes", () => {
    const malformedRequest = structuredClone({
      type: "compute",
      jobId: 1,
      identity: identity(),
    }) as Record<string, any>;
    malformedRequest.identity.sourceScene.primitives[0].hiddenLineRole =
      "grass-mask";

    const malformedScene = structuredClone(scene) as Record<string, any>;
    malformedScene.primitives[0].hiddenLineRole = "grass-mask";

    expect(isOutlineComputeRequest(malformedRequest)).toBe(false);
    expect(
      isOutlineComputeResponse({
        type: "success",
        jobId: 1,
        identity: identity(),
        scene: malformedScene,
      }),
    ).toBe(false);
  });

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
        completedWorkUnits: 0.5,
        totalWorkUnits: 1,
        terminal: false,
      },
    },
    {
      type: "progress",
      jobId: 1,
      snapshot: {
        completedWorkUnits: 1,
        totalWorkUnits: 1.5,
        terminal: false,
      },
    },
    {
      type: "progress",
      jobId: 1,
      snapshot: {
        completedWorkUnits: Number.MAX_SAFE_INTEGER + 1,
        totalWorkUnits: Number.MAX_SAFE_INTEGER + 1,
        terminal: true,
      },
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

  it("accepts only exact, identity-free hidden-line status envelopes", () => {
    const progress = {
      type: "derivation-progress",
      jobKind: "export",
      owner: "hidden-line-export",
      jobId: 4,
      snapshot: {
        completedWorkUnits: 2,
        totalWorkUnits: 10,
        terminal: false,
      },
    };
    const finalizing = {
      type: "finalizing",
      jobKind: "export",
      owner: "hidden-line-export",
      jobId: 4,
    };

    expect(isHiddenLineWorkerMessage(progress)).toBe(true);
    expect(isHiddenLineWorkerMessage(finalizing)).toBe(true);
    expect(Object.keys(progress)).toEqual([
      "type",
      "jobKind",
      "owner",
      "jobId",
      "snapshot",
    ]);
    expect(Object.keys(finalizing)).toEqual([
      "type",
      "jobKind",
      "owner",
      "jobId",
    ]);
    expect("identity" in progress).toBe(false);
    expect("identity" in finalizing).toBe(false);

    for (const malformed of [
      { ...progress, identity: identity() },
      { ...progress, sourceScene: scene },
      { ...progress, extra: true },
      { ...progress, jobKind: "preview" },
      { ...progress, owner: "outline-preview" },
      { ...progress, snapshot: { ...progress.snapshot, extra: true } },
      { ...progress, snapshot: { ...progress.snapshot, terminal: true } },
      { ...finalizing, identity: identity() },
      { ...finalizing, sourceScene: scene },
      { ...finalizing, jobKind: "preview", owner: "outline-preview" },
      { ...finalizing, extra: true },
    ]) {
      expect(isHiddenLineWorkerMessage(malformed)).toBe(false);
    }
  });

  it("retains full exact identity validation on hidden-line terminal messages", () => {
    const current = identity();
    const snapshot = createHiddenLineExportSnapshot({
      identity: current,
      profile: {
        width: 100,
        height: 80,
        insets: { top: 5, right: 5, bottom: 5, left: 5 },
        includeFrame: false,
        toolWidthMillimeters: 0.3,
      },
      metadata: "test",
      includePaperMargins: true,
      filename: "test.svg",
    });
    const complete = {
      type: "complete",
      jobKind: "export",
      owner: "hidden-line-export",
      jobId: 4,
      identity: snapshot.identity,
      svg: "<svg/>",
      filename: snapshot.filename,
      completedOutline: { identity: snapshot.identity, scene },
    };
    const failure = {
      type: "failure",
      jobKind: "export",
      owner: "hidden-line-export",
      jobId: 4,
      identity: snapshot.identity,
      error: "failed",
    };

    expect(isHiddenLineWorkerMessage(complete)).toBe(true);
    expect(isHiddenLineWorkerMessage(failure)).toBe(true);
    expect(
      isHiddenLineWorkerMessage({
        ...complete,
        identity: changed((copy) => {
          copy.sourceScene.primitives[0].points[0][0] = 999;
        }),
      }),
    ).toBe(false);
    expect(
      isHiddenLineWorkerMessage({
        ...failure,
        identity: { ...snapshot.identity, sourceScene: null },
      }),
    ).toBe(false);
  });
});
