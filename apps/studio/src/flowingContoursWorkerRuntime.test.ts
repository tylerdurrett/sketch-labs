import { describe, expect, it, vi } from "vitest";

import {
  defaultParams,
  flowingContours,
  type Scene,
  type SketchEnvironment,
} from "@harness/core";

import {
  createFlowingContoursComputeIdentity,
  type FlowingContoursComputeRequest,
} from "./flowingContoursComputeProtocol";
import {
  handleFlowingContoursWorkerMessage,
  type FlowingContoursSceneExecutor,
} from "./flowingContoursWorkerRuntime";

const frame = { width: 120, height: 90 };
const scene: Scene = { space: frame, primitives: [] };

function request(): FlowingContoursComputeRequest {
  return {
    type: "compute",
    jobId: 7,
    identity: createFlowingContoursComputeIdentity({
      sketchId: flowingContours.id,
      schema: flowingContours.schema,
      params: defaultParams(flowingContours.schema),
      seed: "seed",
      compositionFrame: frame,
    }),
  };
}

const environment: SketchEnvironment = {
  imageAssets: () => undefined,
};

describe("Flowing Contours worker runtime", () => {
  it("canonicalizes before resolving and executes registered generate", async () => {
    const input = request();
    const execute = vi.fn(
      (..._args: Parameters<FlowingContoursSceneExecutor>) => scene,
    );
    const resolve = vi.fn(async () => environment);
    const times = [10, 42];

    await expect(
      handleFlowingContoursWorkerMessage(
        input,
        execute,
        () => times.shift() ?? 42,
        resolve,
      ),
    ).resolves.toEqual({
      type: "success",
      jobId: 7,
      identity: input.identity,
      scene,
      computeTimeMs: 32,
    });
    expect(resolve).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledWith(
      flowingContours.generate,
      input.identity,
      expect.objectContaining({
        imageAsset: expect.any(String),
      }),
      environment,
    );
  });

  it("rejects reordered schema identity before asset resolution", async () => {
    const input = structuredClone(request()) as unknown as {
      type: "compute";
      jobId: number;
      identity: {
        params: Array<{ key: string; value: string | number }>;
      };
    };
    input.identity.params.reverse();
    const resolve = vi.fn(async () => environment);

    const result = await handleFlowingContoursWorkerMessage(
      input,
      undefined,
      undefined,
      resolve,
    );
    expect(result).toMatchObject({
      type: "failure",
      error: expect.stringMatching(/do not match/),
    });
    expect(resolve).not.toHaveBeenCalled();
  });

  it("bounds resolver failures and ignores malformed messages", async () => {
    await expect(
      handleFlowingContoursWorkerMessage(request(), undefined, undefined, () =>
        Promise.reject(new Error("x".repeat(800))),
      ),
    ).resolves.toMatchObject({
      type: "failure",
      error: "x".repeat(500),
    });
    await expect(
      handleFlowingContoursWorkerMessage({ type: "compute" }),
    ).resolves.toBeNull();
  });
});
