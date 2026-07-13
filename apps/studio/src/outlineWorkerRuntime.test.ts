import { describe, expect, it, vi } from "vitest";

import { hiddenLinePass, type ParamSchema, type Scene } from "@harness/core";

import { createOutlineComputeIdentity } from "./outlineComputeProtocol";
import { outlineScene } from "./outlineScene";
import { handleOutlineWorkerMessage } from "./outlineWorkerRuntime";

const source: Scene = {
  space: { width: 40, height: 30 },
  background: { color: "paper" },
  primitives: [
    {
      points: [
        [1, 1],
        [20, 1],
        [10, 20],
      ],
      closed: true,
      fill: { color: "red" },
    },
  ],
};
const schema: ParamSchema = {};

function request(includeFrame = false, tolerance = 0) {
  return {
    type: "compute" as const,
    jobId: 7,
    identity: createOutlineComputeIdentity({
      sketchId: "test",
      schema,
      params: {},
      seed: 1,
      sampledT: 0,
      compositionFrame: source.space,
      tolerance,
      includeFrame,
      sourceScene: source,
    }),
  };
}

describe("outline worker runtime", () => {
  it("returns direct outlineScene parity, including background and tolerance", () => {
    const response = handleOutlineWorkerMessage(request(false, 0.5));
    expect(response).toMatchObject({ type: "success", jobId: 7 });
    if (response?.type !== "success") throw new Error("expected success");
    expect(response.scene).toEqual(outlineScene(source, 0.5, false));
    expect(response.scene).toEqual(hiddenLinePass(source, { tolerance: 0.5 }));
    expect(response.scene.background).toBeUndefined();
  });

  it("includes the authored frame through the shared seam", () => {
    const response = handleOutlineWorkerMessage(request(true));
    if (response?.type !== "success") throw new Error("expected success");
    expect(response.scene).toEqual(outlineScene(source, 0, true));
  });

  it("emits compact terminal progress before success for zero work", () => {
    const empty: Scene = { space: source.space, primitives: [] };
    const emptyRequest = {
      ...request(),
      identity: createOutlineComputeIdentity({
        sketchId: "empty",
        schema,
        params: {},
        seed: 1,
        sampledT: 0,
        compositionFrame: empty.space,
        tolerance: 0,
        includeFrame: false,
        sourceScene: empty,
      }),
    };
    const events: unknown[] = [];

    const response = handleOutlineWorkerMessage(
      emptyRequest,
      outlineScene,
      (progress) => events.push(progress),
      () => 0,
    );
    events.push(response);

    expect(events).toEqual([
      {
        type: "progress",
        jobId: 7,
        snapshot: {
          completedWorkUnits: 0,
          totalWorkUnits: 0,
          terminal: true,
        },
      },
      expect.objectContaining({ type: "success", jobId: 7 }),
    ]);
    expect(Object.keys(events[0] as object)).toEqual([
      "type",
      "jobId",
      "snapshot",
    ]);
  });

  it("emits an initial update, at most one per elapsed interval, and terminal", () => {
    const emitted: unknown[] = [];
    const clock = [0, 25, 99, 100, 150];
    const derive: typeof outlineScene = (scene, _tolerance, _frame, observer) => {
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
      return scene;
    };

    const response = handleOutlineWorkerMessage(
      request(),
      derive,
      (progress) => emitted.push(progress),
      () => clock.shift() ?? 150,
    );

    expect(emitted).toHaveLength(3);
    expect(emitted).toEqual([
      expect.objectContaining({
        snapshot: expect.objectContaining({ completedWorkUnits: 10 }),
      }),
      expect.objectContaining({
        snapshot: expect.objectContaining({ completedWorkUnits: 40 }),
      }),
      expect.objectContaining({
        snapshot: expect.objectContaining({
          completedWorkUnits: 100,
          terminal: true,
        }),
      }),
    ]);
    expect(response).toMatchObject({ type: "success", jobId: 7 });
  });

  it.each([null, {}, { type: "compute" }, { type: "compute", jobId: 1 }])(
    "rejects malformed input before geometry: %o",
    (candidate) => {
      const derive = vi.fn();
      expect(handleOutlineWorkerMessage(candidate, derive)).toBeNull();
      expect(derive).not.toHaveBeenCalled();
    },
  );

  it("turns thrown geometry errors into safe domain failures", () => {
    const response = handleOutlineWorkerMessage(request(), () => {
      throw new Error("geometry exploded");
    });
    expect(response).toMatchObject({
      type: "failure",
      jobId: 7,
      error: "geometry exploded",
    });
  });
});
