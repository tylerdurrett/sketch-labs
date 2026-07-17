import { describe, expect, it, vi } from "vitest";

import {
  defaultParams,
  photoScribble,
  PHOTO_SCRIBBLE_DEFAULT_IMAGE_ASSET_ID,
  scribbleMoon,
  toneCalibration,
  type DecodedPixels,
  type ParamSchema,
  type Scene,
  type ScribbleArtwork,
  type ScribbleProgress,
  type SketchEnvironment,
} from "@harness/core";

import {
  createScribbleComputeIdentity,
  type ScribbleComputeRequest,
  type ScribbleWorkerMessage,
} from "./scribbleComputeProtocol";
import {
  handleScribbleWorkerMessage,
  type ScribbleArtworkExecutor,
} from "./scribbleWorkerRuntime";

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

const artwork: ScribbleArtwork = {
  scene,
  diagnostics: {
    termination: "completed",
    residualError: 0.02,
    pathLength: Math.sqrt(8),
    polylineCount: 1,
    penLiftCount: 0,
  },
};

function request(
  overrides: Partial<{
    sketchId: string;
    schema: ParamSchema;
    params: Record<string, string | number>;
    frame: { width: number; height: number };
    seed: string | number;
  }> = {},
): ScribbleComputeRequest {
  const sketchId = overrides.sketchId ?? toneCalibration.id;
  return {
    type: "compute",
    jobId: 7,
    identity: createScribbleComputeIdentity({
      sketchId,
      schema: overrides.schema ?? toneCalibration.schema,
      params: overrides.params ?? defaultParams(toneCalibration.schema),
      seed: overrides.seed ?? "seed",
      compositionFrame: overrides.frame ?? scene.space,
    }),
  };
}

describe("Scribble worker runtime", () => {
  it("returns the executor's complete Scene, diagnostics, and finite elapsed time", async () => {
    const input = request();
    const execute = vi.fn((..._args: Parameters<ScribbleArtworkExecutor>) =>
      artwork,
    );
    const clock = [10.25, 52.75];

    const response = await handleScribbleWorkerMessage(
      input,
      execute,
      undefined,
      () => clock.shift() ?? 52.75,
    );

    expect(execute).toHaveBeenCalledWith(
      toneCalibration.generateScribbleArtwork,
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
    const response = await handleScribbleWorkerMessage(
      request(),
      () => artwork,
      undefined,
      () => clock.shift() ?? endedAt,
    );

    expect(response).toMatchObject({ type: "success", computeTimeMs: 0 });
  });

  it("emits first, interval, and terminal progress before success", async () => {
    const events: ScribbleWorkerMessage[] = [];
    const clock = [1_000, 1_000, 1_025, 1_099, 1_100, 1_150, 1_200];
    const execute: ScribbleArtworkExecutor = (
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

    const response = await handleScribbleWorkerMessage(
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
    const progress: ScribbleProgress[] = [];
    const execute: ScribbleArtworkExecutor = (
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

    await handleScribbleWorkerMessage(
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
    "rejects malformed or non-Scribble input before execution: %o",
    async (candidate) => {
      const execute = vi.fn(
        (..._args: Parameters<ScribbleArtworkExecutor>) => artwork,
      );
      expect(await handleScribbleWorkerMessage(candidate, execute)).toBeNull();
      expect(execute).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["missing", (params: any[]) => params.pop()],
    ["extra", (params: any[]) => params.push({ key: "extra", value: 1 })],
    ["reordered", (params: any[]) => params.reverse()],
    ["wrong-kind", (params: any[]) => (params[0].value = "not-a-number")],
  ])(
    "rejects %s params that are structurally valid but not schema-canonical",
    async (_case, mutate) => {
      const input = structuredClone(request()) as Record<string, any>;
      mutate(input.identity.params);
      const execute = vi.fn(
        (..._args: Parameters<ScribbleArtworkExecutor>) => artwork,
      );
      const resolveEnvironment = vi.fn(async (): Promise<SketchEnvironment> => ({
        imageAssets: () => undefined,
      }));

      expect(
        await handleScribbleWorkerMessage(
          input,
          execute,
          undefined,
          () => 0,
          resolveEnvironment,
        ),
      ).toMatchObject({
        type: "failure",
        error:
          "Scribble request parameters do not match tone-calibration schema",
      });
      expect(resolveEnvironment).not.toHaveBeenCalled();
      expect(execute).not.toHaveBeenCalled();
    },
  );

  it("blocks malformed progress before posting a bounded safe failure", async () => {
    const emitted = vi.fn();
    const execute: ScribbleArtworkExecutor = (
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

    const response = await handleScribbleWorkerMessage(
      request(),
      execute,
      emitted,
      () => 0,
    );

    expect(emitted).not.toHaveBeenCalled();
    expect(response).toMatchObject({
      type: "failure",
      error: "Scribble worker produced invalid progress",
    });
  });

  it("turns thrown and malformed results into safe bounded domain failures", async () => {
    const longMessage = `geometry ${"x".repeat(700)}`;
    const thrown = await handleScribbleWorkerMessage(request(), () => {
      throw new Error(longMessage);
    });
    const malformed = await handleScribbleWorkerMessage(
      request(),
      () => ({
        ...artwork,
        diagnostics: { ...artwork.diagnostics, residualError: Number.NaN },
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
      error: "Scribble worker produced an invalid result",
    });
  });

  it("requires the selected registry Sketch to own the Scribble hook", async () => {
    const response = await handleScribbleWorkerMessage(
      request({
        sketchId: "circles",
        schema: {},
        params: {},
      }),
    );

    expect(response).toMatchObject({
      type: "failure",
      error: "Sketch circles has no Scribble artwork generator",
    });
  });

  it.each([toneCalibration, scribbleMoon])(
    "executes the real $id registry hook with complete diagnostics",
    async (sketch) => {
      const params = {
        ...defaultParams(sketch.schema),
        pathDensity: 0.5,
        scribbleScale: 2,
        toneFidelity: 0,
      };
      const response = await handleScribbleWorkerMessage(
        request({
          sketchId: sketch.id,
          schema: sketch.schema,
          params,
          frame: { width: 80, height: 60 },
        }),
        undefined,
        undefined,
        () => 10,
      );

      expect(response).toMatchObject({
        type: "success",
        identity: { sketchId: sketch.id },
        scene: { space: { width: 80, height: 60 } },
        diagnostics: {
          termination: expect.stringMatching(/^(completed|budget-exhausted)$/),
          residualError: expect.any(Number),
          pathLength: expect.any(Number),
          polylineCount: expect.any(Number),
          penLiftCount: expect.any(Number),
        },
        computeTimeMs: 0,
      });
    },
  );

  it(
    "validates first, resolves opaque IDs per job, and enters compute with only worker-owned pixels",
    async () => {
      const input = request({
        sketchId: photoScribble.id,
        schema: photoScribble.schema,
        params: {
          ...defaultParams(photoScribble.schema),
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
        (...args: Parameters<ScribbleArtworkExecutor>) =>
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

      const pending = handleScribbleWorkerMessage(
        input,
        execute,
        undefined,
        () => 5,
        resolveEnvironment,
      );
      await Promise.resolve();

      expect(resolveEnvironment).toHaveBeenCalledWith(
        photoScribble.schema,
        expect.objectContaining({
          imageAsset: PHOTO_SCRIBBLE_DEFAULT_IMAGE_ASSET_ID,
        }),
      );
      expect(execute).not.toHaveBeenCalled();
      expect(JSON.stringify(input)).not.toMatch(/data|pixels|bitmap|blob/i);

      finishResolution?.(environment);
      const response = await pending;

      expect(execute).toHaveBeenCalledWith(
        photoScribble.generateScribbleArtwork,
        input.identity,
        environment,
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

  it("turns resolution failure into a bounded safe failure before generation", async () => {
    const execute = vi.fn(
      (..._args: Parameters<ScribbleArtworkExecutor>) => artwork,
    );
    const response = await handleScribbleWorkerMessage(
      request(),
      execute,
      undefined,
      () => 0,
      async () => {
        throw new Error(`decode ${"x".repeat(700)}`);
      },
    );

    expect(execute).not.toHaveBeenCalled();
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
    const execute: ScribbleArtworkExecutor = (
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
    await handleScribbleWorkerMessage(
      first,
      execute,
      undefined,
      () => 0,
      resolveEnvironment,
    );
    await handleScribbleWorkerMessage(
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
