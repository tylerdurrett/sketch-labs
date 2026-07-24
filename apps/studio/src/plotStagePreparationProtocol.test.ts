import { describe, expect, it } from "vitest";

import {
  defaultParams,
  photoScribble,
  type Params,
  type PlotSequenceDeclaration,
} from "@harness/core";

import {
  copyPlotStagePreparationIdentity,
  copyPlotStageRegistrationIdentity,
  createPlotStagePreparationIdentity,
  createPlotStageRegistrationIdentity,
  isPlotStagePreparationRequest,
  isPlotStagePreparationResponse,
  isPlotStageWorkerMessage,
  plotStagePreparationIdentitiesEqual,
  plotStageRegistrationIdentitiesEqual,
} from "./plotStagePreparationProtocol";

const declaration = photoScribble.plotSequence!;
const frame = { width: 320, height: 180 };
const params: Params = {
  ...defaultParams(photoScribble.schema),
  watercolorGamma: 1.3,
  watercolorContrast: 1.4,
};

function registrationIdentity() {
  return createPlotStageRegistrationIdentity({
    schema: photoScribble.schema,
    declaration,
    params,
    compositionFrame: frame,
  });
}

function preparationIdentity(
  source: PlotSequenceDeclaration = declaration,
  stageId = "watercolor-forms",
) {
  return createPlotStagePreparationIdentity({
    sketchId: photoScribble.id,
    schema: photoScribble.schema,
    declaration: source,
    stageId,
    params,
    seed: "sequence-seed",
    sampledT: 4.25,
    compositionFrame: frame,
  });
}

function request() {
  return {
    type: "compute" as const,
    jobId: 7,
    identity: preparationIdentity(),
    registrationIdentity: registrationIdentity(),
    seed: "sequence-seed",
    sampledT: 4.25,
  };
}

describe("Plot Stage preparation protocol", () => {
  it("projects exact shared-then-owned canonical order without owning aliases", () => {
    const identity = preparationIdentity();

    expect(identity).toEqual({
      sketchId: "photo-scribble",
      stageId: "watercolor-forms",
      params: [
        {
          key: "imageAsset",
          value: params.imageAsset,
        },
        { key: "gamma", value: 1.3 },
        { key: "contrast", value: 1.4 },
        { key: "pivot", value: params.watercolorPivot },
        { key: "formDetail", value: params.watercolorFormDetail },
        {
          key: "colorSensitivity",
          value: params.watercolorColorSensitivity,
        },
        {
          key: "boundaryStrength",
          value: params.watercolorBoundaryStrength,
        },
        {
          key: "boundarySmoothing",
          value: params.watercolorBoundarySmoothing,
        },
      ],
      compositionFrame: frame,
    });
    expect(identity.params).not.toContainEqual(
      expect.objectContaining({ key: "watercolorGamma" }),
    );
    expect(Object.isFrozen(identity)).toBe(true);
    expect(Object.isFrozen(identity.params)).toBe(true);
    expect(Object.isFrozen(identity.compositionFrame)).toBe(true);
  });

  it("keeps registration shared-only and independent of Stage-owned values", () => {
    const first = registrationIdentity();
    const changed = createPlotStageRegistrationIdentity({
      schema: photoScribble.schema,
      declaration,
      params: { ...params, watercolorGamma: 2.7 },
      compositionFrame: frame,
    });

    expect(first.params).toEqual([
      { key: "imageAsset", value: params.imageAsset },
    ]);
    expect(plotStageRegistrationIdentitiesEqual(first, changed)).toBe(true);
    expect(first).not.toHaveProperty("stageId");
    expect(first).not.toHaveProperty("seed");
    expect(first).not.toHaveProperty("sampledT");
  });

  it.each([
    [{ usesSeed: false, usesTime: false }, []],
    [{ usesSeed: true, usesTime: false }, ["seed"]],
    [{ usesSeed: false, usesTime: true }, ["sampledT"]],
    [{ usesSeed: true, usesTime: true }, ["seed", "sampledT"]],
  ] as const)(
    "derives optional identity fields strictly from %o",
    (dependencies, optionalKeys) => {
      const stages = declaration.stages.map((stage) =>
        stage.id === "watercolor-forms"
          ? { ...stage, dependencies }
          : stage,
      );
      const identity = preparationIdentity({ ...declaration, stages });

      expect(
        ["seed", "sampledT"].filter((key) =>
          Object.prototype.hasOwnProperty.call(identity, key),
        ),
      ).toEqual(optionalKeys);
      if (dependencies.usesSeed) {
        expect(identity.seed).toBe("sequence-seed");
      }
      if (dependencies.usesTime) {
        expect(identity.sampledT).toBe(4.25);
      }
    },
  );

  it("copies identities deeply and compares every ordered value and dependency field", () => {
    const registration = registrationIdentity();
    const identity = preparationIdentity();
    const registrationCopy =
      copyPlotStageRegistrationIdentity(registration);
    const identityCopy = copyPlotStagePreparationIdentity(identity);

    expect(registrationCopy).not.toBe(registration);
    expect(registrationCopy.params).not.toBe(registration.params);
    expect(identityCopy).not.toBe(identity);
    expect(identityCopy.params).not.toBe(identity.params);
    expect(plotStageRegistrationIdentitiesEqual(registration, registrationCopy))
      .toBe(true);
    expect(plotStagePreparationIdentitiesEqual(identity, identityCopy)).toBe(
      true,
    );

    const changed = structuredClone(identityCopy) as any;
    changed.params[1]!.value = 9;
    expect(plotStagePreparationIdentitiesEqual(identity, changed)).toBe(false);
  });

  it.each([
    ["extra request field", (value: any) => (value.extra = true)],
    ["missing invocation Seed", (value: any) => delete value.seed],
    ["non-finite invocation time", (value: any) => (value.sampledT = NaN)],
    [
      "duplicate canonical entry",
      (value: any) => value.identity.params.push(value.identity.params[0]),
    ],
    [
      "non-finite parameter",
      (value: any) => (value.identity.params[1].value = Infinity),
    ],
    [
      "registration mismatch",
      (value: any) => (value.registrationIdentity.params[0].value = "other"),
    ],
    [
      "registration frame mismatch",
      (value: any) => (value.registrationIdentity.compositionFrame.width = 99),
    ],
  ])("rejects %s structurally", (_case, mutate) => {
    const candidate = structuredClone(request());
    mutate(candidate);
    expect(isPlotStagePreparationRequest(candidate)).toBe(false);
  });

  it("validates ordinary unfinalized Scenes and rejects output-only extras", () => {
    const base = {
      type: "success" as const,
      jobId: 7,
      identity: preparationIdentity(),
      registrationIdentity: registrationIdentity(),
      scene: {
        space: frame,
        primitives: [
          {
            points: [
              [1, 2],
              [3, 4],
            ],
            stroke: { color: "pink", width: 0.5 },
          },
        ],
      },
    };

    expect(isPlotStagePreparationResponse(base)).toBe(true);
    expect(
      isPlotStagePreparationResponse({
        ...base,
        scene: { ...base.scene, pageFrame: { width: 1, height: 1 } },
      }),
    ).toBe(false);
    expect(
      isPlotStagePreparationResponse({
        ...base,
        scene: {
          ...base.scene,
          space: { width: frame.width + 1, height: frame.height },
        },
      }),
    ).toBe(false);
  });

  it("has no fabricated percentage/progress message shape", () => {
    expect(
      isPlotStageWorkerMessage({
        type: "progress",
        jobId: 7,
        percentage: 50,
      }),
    ).toBe(false);
  });

  it("rejects invalid authored values at identity creation", () => {
    expect(() =>
      createPlotStagePreparationIdentity({
        sketchId: photoScribble.id,
        schema: photoScribble.schema,
        declaration,
        stageId: "watercolor-forms",
        params: { ...params, watercolorGamma: Number.NaN },
        seed: "seed",
        sampledT: 0,
        compositionFrame: frame,
      }),
    ).toThrow(/watercolorGamma must be finite/);
  });
});
