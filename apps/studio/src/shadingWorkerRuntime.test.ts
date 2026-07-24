import { describe, expect, it, vi } from "vitest";

import {
  defaultParams,
  photoScribble,
  PHOTO_SCRIBBLE_DEFAULT_IMAGE_ASSET_ID,
  registry,
  scribbleMoon,
  toneCalibration,
  type DecodedPixels,
  type ParamSchema,
  type PlotSequenceDeclaration,
  type Scene,
  type ShadingArtwork,
  type ShadingProgress,
  type SketchEnvironment,
  type StatelessSketch,
} from "@harness/core";

import {
  createShadingComputeIdentity,
  shadingIdentityProjection,
  shadingIdentitySchema,
  type ShadingComputeRequest,
  type ShadingWorkerMessage,
} from "./shadingComputeProtocol";
import {
  handleShadingWorkerMessage,
  type ShadingArtworkExecutor,
} from "./shadingWorkerRuntime";

const scene: Scene = {
  space: { width: 120, height: 90 },
  primitives: [
    {
      points: [
        [1, 2],
        [3, 4],
      ],
      stroke: { color: "black", width: 1 },
    },
  ],
};

const artwork: ShadingArtwork = {
  scene,
  diagnostics: {
    termination: "completed",
    pathLength: Math.sqrt(8),
    polylineCount: 1,
    penLiftCount: 0,
    fidelity: { kind: "scribble", residualError: 0.02 },
  },
};

function request(
  overrides: Partial<{
    sketchId: string;
    schema: ParamSchema;
    params: Record<string, string | number>;
    plotSequence: PlotSequenceDeclaration;
    frame: { width: number; height: number };
    seed: string | number;
  }> = {},
): ShadingComputeRequest {
  const sketchId = overrides.sketchId ?? toneCalibration.id;
  const schema = overrides.schema ?? toneCalibration.schema;
  const plotSequence =
    overrides.plotSequence ??
    (sketchId === photoScribble.id
      ? photoScribble.plotSequence
      : undefined);
  const projection = shadingIdentityProjection({
    schema,
    ...(plotSequence === undefined ? {} : { plotSequence }),
  });
  return {
    type: "compute",
    jobId: 7,
    identity: createShadingComputeIdentity({
      sketchId,
      schema: projection.schema,
      schemaKeys: projection.schemaKeys,
      params: overrides.params ?? defaultParams(toneCalibration.schema),
      seed: overrides.seed ?? "seed",
      compositionFrame: overrides.frame ?? scene.space,
    }),
  };
}

describe("Shading worker runtime", () => {
  it("returns the executor's complete Scene, diagnostics, and finite elapsed time", async () => {
    const input = request();
    const execute = vi.fn((..._args: Parameters<ShadingArtworkExecutor>) =>
      artwork,
    );
    const clock = [10.25, 52.75];

    const response = await handleShadingWorkerMessage(
      input,
      execute,
      undefined,
      () => clock.shift() ?? 52.75,
    );

    expect(execute).toHaveBeenCalledWith(
      toneCalibration.generateShadingArtwork,
      input.identity,
      expect.objectContaining({ imageAssets: expect.any(Function) }),
      undefined,
    );
    expect(response).toEqual({
      type: "success",
      jobId: 7,
      identity: input.identity,
      scene,
      diagnostics: artwork.diagnostics,
      computeTimeMs: 42.5,
    });
  });

  it.each([
    [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY],
    [50, 40],
  ])("normalizes an unusable clock interval to zero", async (startedAt, endedAt) => {
    const clock = [startedAt, endedAt];
    const response = await handleShadingWorkerMessage(
      request(),
      () => artwork,
      undefined,
      () => clock.shift() ?? endedAt,
    );

    expect(response).toMatchObject({ type: "success", computeTimeMs: 0 });
  });

  it("emits first, interval, and terminal progress before success", async () => {
    const events: ShadingWorkerMessage[] = [];
    const clock = [1_000, 1_000, 1_025, 1_099, 1_100, 1_150, 1_200];
    const execute: ShadingArtworkExecutor = (
      _generate,
      _identity,
      _environment,
      observer,
    ) => {
      for (const completedWorkUnits of [10, 20, 30, 40, 50]) {
        observer?.({
          completedWorkUnits,
          totalWorkUnits: 100,
          terminal: false,
        });
      }
      observer?.({
        completedWorkUnits: 100,
        totalWorkUnits: 100,
        terminal: true,
      });
      return artwork;
    };

    const response = await handleShadingWorkerMessage(
      request(),
      execute,
      (progress) => events.push(progress),
      () => clock.shift() ?? 1_200,
    );
    if (response !== null) events.push(response);

    expect(events).toEqual([
      expect.objectContaining({
        type: "progress",
        snapshot: expect.objectContaining({ completedWorkUnits: 10 }),
      }),
      expect.objectContaining({
        type: "progress",
        snapshot: expect.objectContaining({ completedWorkUnits: 40 }),
      }),
      expect.objectContaining({
        type: "progress",
        snapshot: {
          completedWorkUnits: 100,
          totalWorkUnits: 100,
          terminal: true,
        },
      }),
      expect.objectContaining({
        type: "success",
        computeTimeMs: 200,
      }),
    ]);
    expect(Object.keys(events[0]!)).toEqual(["type", "jobId", "snapshot"]);
  });

  it("always emits terminal progress when its count equals an ordinary snapshot", async () => {
    const progress: ShadingProgress[] = [];
    const execute: ShadingArtworkExecutor = (
      _generate,
      _identity,
      _environment,
      observer,
    ) => {
      observer?.({
        completedWorkUnits: 10,
        totalWorkUnits: 100,
        terminal: false,
      });
      observer?.({
        completedWorkUnits: 10,
        totalWorkUnits: 100,
        terminal: true,
      });
      return artwork;
    };

    await handleShadingWorkerMessage(
      request(),
      execute,
      (message) => progress.push(message.snapshot),
      () => 0,
    );

    expect(progress).toEqual([
      { completedWorkUnits: 10, totalWorkUnits: 100, terminal: false },
      { completedWorkUnits: 10, totalWorkUnits: 100, terminal: true },
    ]);
  });

  it.each([null, {}, { type: "compute" }, { type: "preview" }])(
    "rejects malformed or non-Shading input before execution: %o",
    async (candidate) => {
      const execute = vi.fn(
        (..._args: Parameters<ShadingArtworkExecutor>) => artwork,
      );
      expect(await handleShadingWorkerMessage(candidate, execute)).toBeNull();
      expect(execute).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["missing active", (params: any[]) => params.pop()],
    [
      "extra inactive",
      (params: any[]) =>
        params.push({ key: "stippleDensity", value: 1 }),
    ],
    [
      "wrong order",
      (params: any[]) =>
        params.splice(1, 2, params[2], params[1]),
    ],
    [
      "wrong kind",
      (params: any[]) =>
        (params.find(({ key }) => key === "pathDensity").value = "1"),
    ],
    ["wrong type", (params: any[]) => (params[0].value = 1)],
    ["wrong value", (params: any[]) => (params[0].value = "hatching")],
    ["cross-branch", (params: any[]) => (params[0].value = "stippling")],
  ])(
    "rejects %s Tone params before environment resolution or execution",
    async (_case, mutate) => {
      const input = structuredClone(
        request({
          params: {
            ...defaultParams(toneCalibration.schema),
            strategy: "scribble",
            pathDensity: 0.5,
            scribbleScale: 2,
            toneFidelity: 0,
          },
        }),
      ) as Record<string, any>;
      mutate(input.identity.params);
      const execute = vi.fn(
        (..._args: Parameters<ShadingArtworkExecutor>) => artwork,
      );
      const resolveEnvironment = vi.fn(async (): Promise<SketchEnvironment> => ({
        imageAssets: () => undefined,
      }));

      expect(
        await handleShadingWorkerMessage(
          input,
          execute,
          undefined,
          () => 0,
          resolveEnvironment,
        ),
      ).toMatchObject({
        type: "failure",
        error:
          "Shading request parameters do not match tone-calibration schema",
      });
      expect(resolveEnvironment).not.toHaveBeenCalled();
      expect(execute).not.toHaveBeenCalled();
    },
  );

  it("blocks malformed progress before posting a bounded safe failure", async () => {
    const emitted = vi.fn();
    const execute: ShadingArtworkExecutor = (
      _generate,
      _identity,
      _environment,
      observer,
    ) => {
      observer?.({
        completedWorkUnits: 2,
        totalWorkUnits: 1,
        terminal: false,
      });
      return artwork;
    };

    const response = await handleShadingWorkerMessage(
      request(),
      execute,
      emitted,
      () => 0,
    );

    expect(emitted).not.toHaveBeenCalled();
    expect(response).toMatchObject({
      type: "failure",
      error: "Shading worker produced invalid progress",
    });
  });

  it("turns thrown and malformed results into safe bounded domain failures", async () => {
    const longMessage = `geometry ${"x".repeat(700)}`;
    const thrown = await handleShadingWorkerMessage(request(), () => {
      throw new Error(longMessage);
    });
    const malformed = await handleShadingWorkerMessage(
      request(),
      () => ({
        ...artwork,
        diagnostics: {
          ...artwork.diagnostics,
          fidelity: {
            ...artwork.diagnostics.fidelity,
            residualError: Number.NaN,
          },
        },
      }),
      undefined,
      () => Number.POSITIVE_INFINITY,
    );

    expect(thrown).toMatchObject({ type: "failure" });
    if (thrown?.type !== "failure") throw new Error("expected failure");
    expect(thrown.error).toHaveLength(500);
    expect(longMessage.startsWith(thrown.error)).toBe(true);
    expect(malformed).toMatchObject({
      type: "failure",
      error: "Shading worker produced an invalid result",
    });
  });

  it("requires the selected registry Sketch to own the Shading hook", async () => {
    const response = await handleShadingWorkerMessage(
      request({
        sketchId: "circles",
        schema: {},
        params: {},
      }),
    );

    expect(response).toMatchObject({
      type: "failure",
      error: "Sketch circles has no Shading artwork generator",
    });
  });

  it.each([
    {
      strategy: "scribble",
      params: {
        ...defaultParams(toneCalibration.schema),
        strategy: "scribble",
        pathDensity: 0.5,
        scribbleScale: 2,
        toneFidelity: 0,
        stopPoint: 0,
      },
      keys: [
        "strategy",
        "pathDensity",
        "scribbleScale",
        "momentum",
        "chaos",
        "toneFidelity",
        "stopPoint",
      ],
      metric: "residualError",
      termination: /^(completed|budget-exhausted|stopped-early)$/,
    },
    {
      strategy: "stippling",
      params: {
        ...defaultParams(toneCalibration.schema),
        strategy: "stippling",
        stippleDensity: 0.25,
        distributionFidelity: 0,
      },
      keys: ["strategy", "stippleDensity", "distributionFidelity"],
      metric: "distributionError",
      termination: /^(completed|budget-exhausted)$/,
    },
  ])(
    "executes Tone Calibration's real $strategy generator from exactly its active branch",
    async ({ strategy, params, keys, metric, termination }) => {
      const response = await handleShadingWorkerMessage(
        request({
          sketchId: toneCalibration.id,
          schema: toneCalibration.schema,
          params,
          frame: { width: 40, height: 30 },
        }),
        undefined,
        undefined,
        () => 10,
      );

      expect(response).toMatchObject({
        type: "success",
        identity: { sketchId: toneCalibration.id },
        scene: { space: { width: 40, height: 30 } },
        diagnostics: {
          termination: expect.stringMatching(termination),
          pathLength: expect.any(Number),
          polylineCount: expect.any(Number),
          penLiftCount: expect.any(Number),
          fidelity: expect.objectContaining({
            kind: strategy,
            [metric]: expect.any(Number),
          }),
        },
        computeTimeMs: 0,
      });
      if (response?.type !== "success") throw new Error("expected success");
      expect(response.identity.params.map(({ key }) => key)).toEqual(keys);
      expect(response.identity.params).toHaveLength(keys.length);
      expect(Object.keys(response.diagnostics.fidelity)).toEqual([
        "kind",
        metric,
      ]);
      if (strategy === "stippling") {
        expect(response.scene.primitives.length).toBeGreaterThan(0);
        expect(
          response.scene.primitives.every(
            ({ stroke }) => stroke?.lineCap === "round",
          ),
        ).toBe(true);
      }
    },
  );

  it("keeps every unconditional Scribble Moon schema param and executes its real generator", async () => {
    const params = {
      ...defaultParams(scribbleMoon.schema),
      pathDensity: 0.5,
      scribbleScale: 2,
      toneFidelity: 0,
      stopPoint: 0,
    };
    const input = request({
      sketchId: scribbleMoon.id,
      schema: scribbleMoon.schema,
      params,
      frame: { width: 40, height: 30 },
    });

    expect(input.identity.params.map(({ key }) => key)).toEqual(
      Object.keys(scribbleMoon.schema),
    );

    const response = await handleShadingWorkerMessage(
      input,
      undefined,
      undefined,
      () => 10,
    );

    expect(response).toMatchObject({
      type: "success",
      scene: { space: { width: 40, height: 30 } },
      diagnostics: {
        fidelity: {
          kind: "scribble",
          residualError: expect.any(Number),
        },
      },
    });
  });

  it.each([
    [
      "a sibling Watercolor parameter",
      (params: any[]) =>
        params.push({ key: "watercolorGamma", value: 1 }),
    ],
    [
      "non-authored Primary order",
      (params: any[]) => params.reverse(),
    ],
  ])(
    "rejects Sequence Shading identity with %s before environment resolution",
    async (_case, mutate) => {
      const input = structuredClone(
        request({
          sketchId: photoScribble.id,
          schema: photoScribble.schema,
          params: defaultParams(photoScribble.schema) as Record<
            string,
            string | number
          >,
        }),
      ) as Record<string, any>;
      mutate(input.identity.params);
      const execute = vi.fn(
        (..._args: Parameters<ShadingArtworkExecutor>) => artwork,
      );
      const resolveEnvironment = vi.fn(async (): Promise<SketchEnvironment> => ({
        imageAssets: () => undefined,
      }));

      expect(
        await handleShadingWorkerMessage(
          input,
          execute,
          undefined,
          () => 0,
          resolveEnvironment,
        ),
      ).toMatchObject({
        type: "failure",
        error:
          "Shading request parameters do not match photo-scribble schema",
      });
      expect(resolveEnvironment).not.toHaveBeenCalled();
      expect(execute).not.toHaveBeenCalled();
    },
  );

  it("canonicalizes integer-like Sequence keys in authored order", async () => {
    const schema = {
      "2": { kind: "number", min: 0, max: 10, default: 2 },
      "10": { kind: "number", min: 0, max: 10, default: 10 },
      alpha: { kind: "number", min: 0, max: 10, default: 1 },
    } satisfies ParamSchema;
    const plotSequence: PlotSequenceDeclaration = {
      sharedParameters: [{ schemaKey: "10", key: "shared" }],
      stages: [
        {
          id: "ink",
          name: "Ink",
          source: { kind: "primary", generatorId: "indexed-ink" },
          parameters: [
            { schemaKey: "2", key: "two" },
            { schemaKey: "alpha", key: "alpha" },
          ],
          dependencies: { usesSeed: true, usesTime: false },
        },
      ],
    };
    const sketch: StatelessSketch = {
      id: "indexed-ink",
      name: "Indexed Ink",
      schema,
      plotSequence,
      generate: () => scene,
      generateShadingArtwork: () => artwork,
    };
    const projection = shadingIdentityProjection(sketch);
    const input: ShadingComputeRequest = {
      type: "compute",
      jobId: 7,
      identity: createShadingComputeIdentity({
        sketchId: sketch.id,
        schema: projection.schema,
        schemaKeys: projection.schemaKeys,
        params: { "2": 4, "10": 8, alpha: 3 },
        seed: "seed",
        compositionFrame: scene.space,
      }),
    };
    const get = vi.spyOn(registry, "get").mockReturnValue(sketch);
    const execute = vi.fn(
      (..._args: Parameters<ShadingArtworkExecutor>) => artwork,
    );
    const resolveEnvironment = vi.fn(async (): Promise<SketchEnvironment> => ({
      imageAssets: () => undefined,
    }));

    try {
      expect(input.identity.params.map(({ key }) => key)).toEqual([
        "10",
        "2",
        "alpha",
      ]);
      expect(
        await handleShadingWorkerMessage(
          input,
          execute,
          undefined,
          () => 0,
          resolveEnvironment,
        ),
      ).toMatchObject({ type: "success" });
      expect(resolveEnvironment).toHaveBeenCalledOnce();
      expect(execute).toHaveBeenCalledOnce();

      const reordered = structuredClone(input) as Record<string, any>;
      reordered.identity.params = [
        reordered.identity.params[1],
        reordered.identity.params[0],
        reordered.identity.params[2],
      ];
      resolveEnvironment.mockClear();
      execute.mockClear();

      expect(
        await handleShadingWorkerMessage(
          reordered,
          execute,
          undefined,
          () => 0,
          resolveEnvironment,
        ),
      ).toMatchObject({
        type: "failure",
        error: "Shading request parameters do not match indexed-ink schema",
      });
      expect(resolveEnvironment).not.toHaveBeenCalled();
      expect(execute).not.toHaveBeenCalled();
    } finally {
      get.mockRestore();
    }
  });

  it(
    "validates first, resolves opaque IDs per job, and enters compute with only worker-owned pixels",
    async () => {
      const input = request({
        sketchId: photoScribble.id,
        schema: photoScribble.schema,
        params: {
          ...defaultParams(photoScribble.schema),
          detailInfluence: 1,
          pathDensity: 0.5,
          scribbleScale: 2,
          toneFidelity: 1,
        },
        frame: { width: 24, height: 16 },
      });
      const pixels: DecodedPixels = {
        width: 2,
        height: 2,
        data: Uint8ClampedArray.from([
          0, 0, 0, 255, 32, 32, 32, 255,
          64, 64, 64, 255, 96, 96, 96, 255,
        ]),
      };
      const environment: SketchEnvironment = {
        imageAssets: (id) =>
          id === PHOTO_SCRIBBLE_DEFAULT_IMAGE_ASSET_ID ? pixels : undefined,
      };
      let finishResolution: ((value: SketchEnvironment) => void) | undefined;
      const resolveEnvironment = vi.fn(
        () =>
          new Promise<SketchEnvironment>((resolve) => {
            finishResolution = resolve;
          }),
      );
      const execute = vi.fn(
        (...args: Parameters<ShadingArtworkExecutor>) =>
          args[0](
            Object.fromEntries(
              args[1].params.map(({ key, value }) => [key, value]),
            ),
            args[1].seed,
            args[1].compositionFrame,
            args[3],
            args[2],
          ),
      );

      const pending = handleShadingWorkerMessage(
        input,
        execute,
        undefined,
        () => 5,
        resolveEnvironment,
      );
      await Promise.resolve();

      expect(resolveEnvironment).toHaveBeenCalledWith(
        shadingIdentitySchema(photoScribble),
        expect.objectContaining({
          imageAsset: PHOTO_SCRIBBLE_DEFAULT_IMAGE_ASSET_ID,
        }),
      );
      expect(execute).not.toHaveBeenCalled();
      expect(JSON.stringify(input)).not.toMatch(/data|pixels|bitmap|blob/i);

      finishResolution?.(environment);
      const response = await pending;

      expect(execute).toHaveBeenCalledWith(
        photoScribble.generateShadingArtwork,
        input.identity,
        expect.objectContaining({
          imageAssets: environment.imageAssets,
          getPreparedImageDetailAnalysis: expect.any(Function),
        }),
        undefined,
      );
      expect(response).toMatchObject({
        type: "success",
        identity: { sketchId: "photo-scribble" },
        diagnostics: { polylineCount: expect.any(Number) },
      });
      if (response?.type !== "success") throw new Error("expected success");
      expect(response.scene.primitives.length).toBeGreaterThan(0);
      expect(response.diagnostics.polylineCount).toBeGreaterThan(0);
      expect(JSON.stringify(response)).not.toMatch(/data|pixels|bitmap|blob/i);
    },
  );

  it("skips Detail preparation at zero influence", async () => {
    const input = request({
      sketchId: photoScribble.id,
      schema: photoScribble.schema,
      params: {
        ...defaultParams(photoScribble.schema),
        detailInfluence: 0,
      },
    });
    const environment: SketchEnvironment = {
      imageAssets: () => ({
        width: 1,
        height: 1,
        data: Uint8ClampedArray.from([0, 0, 0, 255]),
      }),
    };
    const execute = vi.fn(
      (..._args: Parameters<ShadingArtworkExecutor>) => artwork,
    );

    const response = await handleShadingWorkerMessage(
      input,
      execute,
      undefined,
      () => 0,
      async () => environment,
    );

    expect(response).toMatchObject({ type: "success" });
    expect(execute).toHaveBeenCalledWith(
      photoScribble.generateShadingArtwork,
      input.identity,
      environment,
      undefined,
    );
    expect(environment.getPreparedImageDetailAnalysis).toBeUndefined();
  });

  it("turns resolution failure into a bounded safe failure before generation", async () => {
    const execute = vi.fn(
      (..._args: Parameters<ShadingArtworkExecutor>) => artwork,
    );
    const emitProgress = vi.fn();
    const response = await handleShadingWorkerMessage(
      request(),
      execute,
      emitProgress,
      () => 0,
      async () => {
        throw new Error(`decode ${"x".repeat(700)}`);
      },
    );

    expect(execute).not.toHaveBeenCalled();
    expect(emitProgress).not.toHaveBeenCalled();
    expect(response).toMatchObject({ type: "failure" });
    if (response?.type !== "failure") throw new Error("expected failure");
    expect(response.error).toHaveLength(500);
  });

  it("resolves a fresh worker-owned environment for a seed-only replacement", async () => {
    const params = defaultParams(photoScribble.schema) as Record<
      string,
      string | number
    >;
    const environments: SketchEnvironment[] = [
      { imageAssets: () => undefined },
      { imageAssets: () => undefined },
    ];
    const resolveEnvironment = vi.fn(async () => environments.shift()!);
    const received: SketchEnvironment[] = [];
    const execute: ShadingArtworkExecutor = (
      _generate,
      _identity,
      environment,
    ) => {
      received.push(environment);
      return artwork;
    };

    const first = request({
      sketchId: photoScribble.id,
      schema: photoScribble.schema,
      params,
      seed: "first",
    });
    const second = request({
      sketchId: photoScribble.id,
      schema: photoScribble.schema,
      params,
      seed: "second",
    });
    await handleShadingWorkerMessage(
      first,
      execute,
      undefined,
      () => 0,
      resolveEnvironment,
    );
    await handleShadingWorkerMessage(
      second,
      execute,
      undefined,
      () => 0,
      resolveEnvironment,
    );

    expect(resolveEnvironment).toHaveBeenCalledTimes(2);
    expect(resolveEnvironment.mock.calls[0]).toEqual(
      resolveEnvironment.mock.calls[1],
    );
    expect(received).toHaveLength(2);
    expect(received[0]).not.toBe(received[1]);
    expect(first.identity.params).toEqual(second.identity.params);
    expect(first.identity.seed).not.toBe(second.identity.seed);
  });
});
