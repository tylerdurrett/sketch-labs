import { describe, expect, it, vi } from "vitest";

import {
  defaultParams,
  scribbleMoon,
  toneCalibration,
  type ParamSchema,
  type Scene,
  type ScribbleArtwork,
  type ScribbleProgress,
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
      seed: "seed",
      compositionFrame: overrides.frame ?? scene.space,
    }),
  };
}

describe("Scribble worker runtime", () => {
  it("returns the executor's complete Scene, diagnostics, and finite elapsed time", () => {
    const input = request();
    const execute = vi.fn((..._args: Parameters<ScribbleArtworkExecutor>) =>
      artwork,
    );
    const clock = [10.25, 52.75];

    const response = handleScribbleWorkerMessage(
      input,
      execute,
      undefined,
      () => clock.shift() ?? 52.75,
    );

    expect(execute).toHaveBeenCalledWith(
      toneCalibration.generateScribbleArtwork,
      input.identity,
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
  ])("normalizes an unusable clock interval to zero", (startedAt, endedAt) => {
    const clock = [startedAt, endedAt];
    const response = handleScribbleWorkerMessage(
      request(),
      () => artwork,
      undefined,
      () => clock.shift() ?? endedAt,
    );

    expect(response).toMatchObject({ type: "success", computeTimeMs: 0 });
  });

  it("emits first, interval, and terminal progress before success", () => {
    const events: ScribbleWorkerMessage[] = [];
    const clock = [1_000, 1_000, 1_025, 1_099, 1_100, 1_150, 1_200];
    const execute: ScribbleArtworkExecutor = (
      _generate,
      _identity,
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

    const response = handleScribbleWorkerMessage(
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

  it("always emits terminal progress when its count equals an ordinary snapshot", () => {
    const progress: ScribbleProgress[] = [];
    const execute: ScribbleArtworkExecutor = (
      _generate,
      _identity,
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

    handleScribbleWorkerMessage(
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
    (candidate) => {
      const execute = vi.fn(
        (..._args: Parameters<ScribbleArtworkExecutor>) => artwork,
      );
      expect(handleScribbleWorkerMessage(candidate, execute)).toBeNull();
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
    (_case, mutate) => {
      const input = structuredClone(request()) as Record<string, any>;
      mutate(input.identity.params);
      const execute = vi.fn(
        (..._args: Parameters<ScribbleArtworkExecutor>) => artwork,
      );

      expect(handleScribbleWorkerMessage(input, execute)).toMatchObject({
        type: "failure",
        error:
          "Scribble request parameters do not match tone-calibration schema",
      });
      expect(execute).not.toHaveBeenCalled();
    },
  );

  it("blocks malformed progress before posting a bounded safe failure", () => {
    const emitted = vi.fn();
    const execute: ScribbleArtworkExecutor = (
      _generate,
      _identity,
      observer,
    ) => {
      observer?.({
        completedWorkUnits: 2,
        totalWorkUnits: 1,
        terminal: false,
      });
      return artwork;
    };

    const response = handleScribbleWorkerMessage(
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

  it("turns thrown and malformed results into safe bounded domain failures", () => {
    const longMessage = `geometry ${"x".repeat(700)}`;
    const thrown = handleScribbleWorkerMessage(request(), () => {
      throw new Error(longMessage);
    });
    const malformed = handleScribbleWorkerMessage(
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

  it("requires the selected registry Sketch to own the Scribble hook", () => {
    const response = handleScribbleWorkerMessage(
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
    (sketch) => {
      const params = {
        ...defaultParams(sketch.schema),
        pathDensity: 0.5,
        scribbleScale: 2,
        toneFidelity: 0,
      };
      const response = handleScribbleWorkerMessage(
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
});
