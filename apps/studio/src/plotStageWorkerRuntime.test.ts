import { describe, expect, it, vi } from "vitest";

import {
  createRegistry,
  defaultParams,
  type ParamSchema,
  type Params,
  type PlotSequenceDeclaration,
  type PlotStageDependencies,
  type PlotStageGeneratorInput,
  type Scene,
  type SketchEnvironment,
  type StatelessSketch,
} from "@harness/core";

import {
  createPlotStagePreparationIdentity,
  createPlotStageRegistrationIdentity,
  type PlotStagePreparationRequest,
} from "./plotStagePreparationProtocol";
import {
  handlePlotStageWorkerMessage,
  type PlotStageEnvironmentResolver,
} from "./plotStageWorkerRuntime";

const frame = { width: 120, height: 90 };
const assetId = "pinecone-4330aa0314f7";

function sceneFor(
  input: Readonly<PlotStageGeneratorInput>,
  x = 1,
): Scene {
  return {
    space: {
      width: input.frame.width,
      height: input.frame.height,
    },
    primitives: [
      {
        points: [
          [x, 2],
          [3, 4],
        ],
        stroke: { color: "guide", width: 0.5 },
      },
    ],
  };
}

function harness(
  stageADependencies: PlotStageDependencies = {
    usesSeed: false,
    usesTime: false,
  },
) {
  const schema: ParamSchema = {
    sourceImage: { kind: "image-asset", default: assetId },
    sharedScale: { kind: "number", min: 0, max: 10, default: 2 },
    stageAGain: { kind: "number", min: 0, max: 10, default: 3 },
    stageAMode: {
      kind: "choice",
      options: [
        { value: "soft", label: "Soft" },
        { value: "hard", label: "Hard" },
      ],
      default: "soft",
    },
    stageBGain: { kind: "number", min: 0, max: 10, default: 4 },
    primaryGain: { kind: "number", min: 0, max: 10, default: 5 },
  };
  const stageAGenerator = vi.fn(
    (input: Readonly<PlotStageGeneratorInput>) => sceneFor(input, 1),
  );
  const stageBGenerator = vi.fn(
    (input: Readonly<PlotStageGeneratorInput>) => sceneFor(input, 8),
  );
  const declaration: PlotSequenceDeclaration = {
    sharedParameters: [
      { schemaKey: "sourceImage", key: "imageAsset" },
      { schemaKey: "sharedScale", key: "scale" },
    ],
    stages: [
      {
        id: "support-a",
        name: "Support A",
        source: {
          kind: "generator",
          generatorId: "reused-generator",
          generate: stageAGenerator,
        },
        parameters: [
          { schemaKey: "stageAGain", key: "gain" },
          { schemaKey: "stageAMode", key: "mode" },
        ],
        dependencies: stageADependencies,
      },
      {
        id: "support-b",
        name: "Support B",
        source: {
          kind: "generator",
          generatorId: "reused-generator",
          generate: stageBGenerator,
        },
        parameters: [{ schemaKey: "stageBGain", key: "gain" }],
        dependencies: { usesSeed: false, usesTime: false },
      },
      {
        id: "primary",
        name: "Primary",
        source: { kind: "primary", generatorId: "owner" },
        parameters: [{ schemaKey: "primaryGain", key: "gain" }],
        dependencies: { usesSeed: true, usesTime: false },
      },
    ],
  };
  const sketch: StatelessSketch = {
    id: "test-sequence",
    name: "Test Sequence",
    schema,
    plotSequence: declaration,
    generate: (_params, _seed, _t, compositionFrame) => ({
      space: compositionFrame,
      primitives: [],
    }),
  };
  const params: Params = {
    ...defaultParams(schema),
    sharedScale: 2.5,
    stageAGain: 7,
    stageAMode: "hard",
    stageBGain: 8,
  };
  const sketchRegistry = createRegistry([sketch]);

  function request(
    stageId = "support-a",
    seed: string | number = "sequence-seed",
    sampledT = 12.5,
  ): PlotStagePreparationRequest {
    return {
      type: "compute",
      jobId: 17,
      identity: createPlotStagePreparationIdentity({
        sketchId: sketch.id,
        schema,
        declaration,
        stageId,
        params,
        seed,
        sampledT,
        compositionFrame: frame,
      }),
      registrationIdentity: createPlotStageRegistrationIdentity({
        schema,
        declaration,
        params,
        compositionFrame: frame,
      }),
      seed,
      sampledT,
    };
  }

  return {
    schema,
    declaration,
    params,
    sketchRegistry,
    stageAGenerator,
    stageBGenerator,
    request,
  };
}

function resolvedEnvironment(): SketchEnvironment {
  return {
    imageAssets(id) {
      return id === assetId
        ? {
            width: 1,
            height: 1,
            data: new Uint8ClampedArray([1, 2, 3, 255]),
          }
        : undefined;
    },
  };
}

function environmentResolver() {
  return vi.fn(
    async (
      _schema: ParamSchema,
      _params: Params,
    ): Promise<SketchEnvironment> => resolvedEnvironment(),
  );
}

describe("Plot Stage worker runtime", () => {
  it("reconstructs owning aliases/assets but invokes the Stage with only canonical inputs", async () => {
    const test = harness();
    const resolveEnvironment = environmentResolver();
    const input = test.request();

    const response = await handlePlotStageWorkerMessage(input, {
      sketchRegistry: test.sketchRegistry,
      resolveEnvironment,
    });

    expect(response).toEqual({
      type: "success",
      jobId: 17,
      identity: input.identity,
      registrationIdentity: input.registrationIdentity,
      scene: sceneFor(
        {
          params: {},
          seed: input.seed,
          t: input.sampledT,
          frame,
        },
        1,
      ),
    });
    const [resolvedSchema, owningParams] =
      resolveEnvironment.mock.calls[0]!;
    expect(Object.keys(resolvedSchema)).toEqual([
      "sourceImage",
      "sharedScale",
      "stageAGain",
      "stageAMode",
    ]);
    expect(owningParams).toEqual({
      sourceImage: assetId,
      sharedScale: 2.5,
      stageAGain: 7,
      stageAMode: "hard",
    });

    expect(test.stageAGenerator).toHaveBeenCalledTimes(1);
    const generatorInput = test.stageAGenerator.mock.calls[0]![0];
    expect(Object.keys(generatorInput.params)).toEqual([
      "imageAsset",
      "scale",
      "gain",
      "mode",
    ]);
    expect(generatorInput.params).toEqual({
      imageAsset: assetId,
      scale: 2.5,
      gain: 7,
      mode: "hard",
    });
    expect(generatorInput.params).not.toHaveProperty("stageAGain");
    expect(generatorInput.seed).toBe("sequence-seed");
    expect(generatorInput.t).toBe(12.5);
    expect(generatorInput.environment).toBeDefined();
  });

  it("addresses duplicate generator IDs by stable Stage instance ID", async () => {
    const test = harness();
    const input = test.request("support-b");

    const response = await handlePlotStageWorkerMessage(input, {
      sketchRegistry: test.sketchRegistry,
      resolveEnvironment: environmentResolver(),
    });

    expect(response).toMatchObject({
      type: "success",
      scene: { primitives: [{ points: [[8, 2], [3, 4]] }] },
    });
    expect(test.stageAGenerator).not.toHaveBeenCalled();
    expect(test.stageBGenerator).toHaveBeenCalledTimes(1);
    expect(test.stageBGenerator.mock.calls[0]![0].params).toEqual({
      imageAsset: assetId,
      scale: 2.5,
      gain: 8,
    });
  });

  it("passes unconditional Seed/time unchanged when both are omitted from retained identity", async () => {
    const test = harness();
    const input = test.request();
    const changed = {
      ...input,
      seed: "invocation-only-seed",
      sampledT: 88.75,
    };
    expect(changed.identity).not.toHaveProperty("seed");
    expect(changed.identity).not.toHaveProperty("sampledT");

    await handlePlotStageWorkerMessage(changed, {
      sketchRegistry: test.sketchRegistry,
      resolveEnvironment: environmentResolver(),
    });

    const generatorInput = test.stageAGenerator.mock.calls[0]![0];
    expect(generatorInput.seed).toBe("invocation-only-seed");
    expect(generatorInput.t).toBe(88.75);
  });

  it("requires dependent identity Seed/time to be present and equal to invocation", async () => {
    const test = harness({ usesSeed: true, usesTime: true });
    const resolveEnvironment = environmentResolver();
    const input = test.request();
    expect(input.identity).toMatchObject({
      seed: "sequence-seed",
      sampledT: 12.5,
    });

    const mismatched = { ...input, sampledT: 13 };
    await expect(
      handlePlotStageWorkerMessage(mismatched, {
        sketchRegistry: test.sketchRegistry,
        resolveEnvironment,
      }),
    ).resolves.toMatchObject({
      type: "failure",
      error:
        "Plot Stage request does not match test-sequence/support-a declaration",
    });
    expect(resolveEnvironment).not.toHaveBeenCalled();
    expect(test.stageAGenerator).not.toHaveBeenCalled();

    const missing = structuredClone(input) as any;
    delete missing.identity.seed;
    await expect(
      handlePlotStageWorkerMessage(missing, {
        sketchRegistry: test.sketchRegistry,
        resolveEnvironment,
      }),
    ).resolves.toMatchObject({ type: "failure" });
    expect(resolveEnvironment).not.toHaveBeenCalled();
  });

  it("rejects undeclared retained dependencies", async () => {
    const test = harness();
    const input = structuredClone(test.request()) as any;
    input.identity.seed = input.seed;

    await expect(
      handlePlotStageWorkerMessage(input, {
        sketchRegistry: test.sketchRegistry,
        resolveEnvironment: environmentResolver(),
      }),
    ).resolves.toMatchObject({
      type: "failure",
      error:
        "Plot Stage request does not match test-sequence/support-a declaration",
    });
    expect(test.stageAGenerator).not.toHaveBeenCalled();
  });

  it.each([
    [
      "omitted entry",
      (value: any): void => {
        value.identity.params.pop();
      },
      "failure",
    ],
    [
      "extra entry",
      (value: any): void => {
        value.identity.params.push({ key: "extra", value: 1 });
      },
      "failure",
    ],
    [
      "reordered entries",
      (value: any): void => {
        value.identity.params.splice(
          2,
          2,
          value.identity.params[3],
          value.identity.params[2],
        );
      },
      "failure",
    ],
    [
      "wrong canonical key",
      (value: any): void => {
        value.identity.params[2].key = "stageAGain";
      },
      "failure",
    ],
    [
      "wrong numeric type",
      (value: any): void => {
        value.identity.params[2].value = "7";
      },
      "failure",
    ],
    [
      "undeclared Choice",
      (value: any): void => {
        value.identity.params[3].value = "medium";
      },
      "failure",
    ],
    [
      "duplicate canonical key",
      (value: any): void => {
        value.identity.params[3].key = "gain";
      },
      "null",
    ],
    [
      "non-finite numeric value",
      (value: any): void => {
        value.identity.params[2].value = NaN;
      },
      "null",
    ],
    [
      "reordered registration entries",
      (value: any): void => {
        value.registrationIdentity.params.reverse();
      },
      "null",
    ],
  ] as const)(
    "rejects %s before asset resolution or generation",
    async (_case, mutate, expected) => {
      const test = harness();
      const resolveEnvironment = environmentResolver();
      const input = structuredClone(test.request()) as any;
      mutate(input);

      const response = await handlePlotStageWorkerMessage(input, {
        sketchRegistry: test.sketchRegistry,
        resolveEnvironment,
      });

      if (expected === "null") {
        expect(response).toBeNull();
      } else {
        expect(response).toMatchObject({ type: "failure" });
      }
      expect(resolveEnvironment).not.toHaveBeenCalled();
      expect(test.stageAGenerator).not.toHaveBeenCalled();
    },
  );

  it("rejects malformed Image Asset IDs before resolution without substitution", async () => {
    const test = harness();
    const resolveEnvironment = environmentResolver();
    const input = structuredClone(test.request()) as any;
    input.identity.params[0].value = "../not-an-asset";
    input.registrationIdentity.params[0].value = "../not-an-asset";

    await expect(
      handlePlotStageWorkerMessage(input, {
        sketchRegistry: test.sketchRegistry,
        resolveEnvironment,
      }),
    ).resolves.toMatchObject({
      type: "failure",
      error: "Plot Stage Image Asset `sourceImage` is invalid",
    });
    expect(resolveEnvironment).not.toHaveBeenCalled();
    expect(test.stageAGenerator).not.toHaveBeenCalled();
  });

  it("keeps asset-resolution failures Stage-local and bounded", async () => {
    const test = harness();
    const longMessage = `asset failed ${"x".repeat(700)}`;
    const resolveEnvironment: PlotStageEnvironmentResolver = vi.fn(
      async () => {
        throw new Error(longMessage);
      },
    );

    const response = await handlePlotStageWorkerMessage(test.request(), {
      sketchRegistry: test.sketchRegistry,
      resolveEnvironment,
    });

    expect(response).toMatchObject({ type: "failure", jobId: 17 });
    if (response?.type !== "failure") throw new Error("expected failure");
    expect(response.error).toHaveLength(500);
    expect(longMessage.startsWith(response.error)).toBe(true);
    expect(test.stageAGenerator).not.toHaveBeenCalled();
  });

  it("rejects the Primary Stage before resolving assets", async () => {
    const test = harness();
    const resolveEnvironment = environmentResolver();

    await expect(
      handlePlotStageWorkerMessage(test.request("primary"), {
        sketchRegistry: test.sketchRegistry,
        resolveEnvironment,
      }),
    ).resolves.toMatchObject({
      type: "failure",
      error:
        "Plot Stage `primary` is Primary and cannot use the supporting Stage worker",
    });
    expect(resolveEnvironment).not.toHaveBeenCalled();
  });

  it.each([
    [
      "extra Scene field",
      (input: Readonly<PlotStageGeneratorInput>): Scene =>
        ({
          ...sceneFor(input),
          pageFrame: { width: 10, height: 10 },
        }) as unknown as Scene,
    ],
    [
      "mismatched Scene space",
      (input: Readonly<PlotStageGeneratorInput>): Scene => ({
        ...sceneFor(input),
        space: { width: input.frame.width + 1, height: input.frame.height },
      }),
    ],
    [
      "non-finite geometry",
      (input: Readonly<PlotStageGeneratorInput>): Scene =>
        ({
          ...sceneFor(input),
          primitives: [{ points: [[NaN, 2]] }],
        }) as unknown as Scene,
    ],
  ])("turns %s into a validated domain failure", async (_case, result) => {
    const test = harness();
    test.stageAGenerator.mockImplementation(result);

    await expect(
      handlePlotStageWorkerMessage(test.request(), {
        sketchRegistry: test.sketchRegistry,
        resolveEnvironment: environmentResolver(),
      }),
    ).resolves.toMatchObject({
      type: "failure",
      error: "Plot Stage worker produced an invalid Scene",
    });
  });

  it.each([null, {}, { type: "compute" }, { type: "preview" }])(
    "ignores malformed or foreign messages: %o",
    async (candidate) => {
      const test = harness();
      const resolveEnvironment = environmentResolver();
      await expect(
        handlePlotStageWorkerMessage(candidate, {
          sketchRegistry: test.sketchRegistry,
          resolveEnvironment,
        }),
      ).resolves.toBeNull();
      expect(resolveEnvironment).not.toHaveBeenCalled();
      expect(test.stageAGenerator).not.toHaveBeenCalled();
    },
  );
});
