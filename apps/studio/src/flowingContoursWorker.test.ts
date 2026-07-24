import { afterEach, describe, expect, it, vi } from "vitest";

import {
  defaultParams,
  flowingContours,
  type Scene,
} from "@harness/core";

import { createFlowingContoursComputeIdentity } from "./flowingContoursComputeProtocol";

const { handleFlowingContoursWorkerMessage } = vi.hoisted(() => ({
  handleFlowingContoursWorkerMessage: vi.fn(),
}));

vi.mock("./flowingContoursWorkerRuntime", () => ({
  handleFlowingContoursWorkerMessage,
}));

describe("Flowing Contours worker entry", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("posts only runtime responses and never attaches pixel transfer storage", async () => {
    let listener: ((event: MessageEvent<unknown>) => void) | undefined;
    const workerScope = {
      addEventListener: vi.fn(
        (type: string, callback: typeof listener) => {
          if (type === "message") listener = callback;
        },
      ),
      postMessage: vi.fn(),
    };
    vi.stubGlobal("self", workerScope);
    await import("./flowingContoursWorker");

    handleFlowingContoursWorkerMessage.mockResolvedValueOnce(null);
    listener?.({ data: null } as MessageEvent<unknown>);
    await Promise.resolve();
    expect(workerScope.postMessage).not.toHaveBeenCalled();

    const frame = { width: 20, height: 10 };
    const scene: Scene = { space: frame, primitives: [] };
    const identity = createFlowingContoursComputeIdentity({
      sketchId: flowingContours.id,
      schema: flowingContours.schema,
      params: defaultParams(flowingContours.schema),
      seed: 1,
      compositionFrame: frame,
    });
    const request = { type: "compute", jobId: 3, identity } as const;
    const response = {
      type: "success",
      jobId: 3,
      identity,
      scene,
      computeTimeMs: 5,
    } as const;
    handleFlowingContoursWorkerMessage.mockResolvedValueOnce(response);
    listener?.({ data: request } as MessageEvent<unknown>);

    await vi.waitFor(() => {
      expect(workerScope.postMessage).toHaveBeenCalledWith(response);
    });
    expect(handleFlowingContoursWorkerMessage).toHaveBeenLastCalledWith(
      request,
    );
    expect(workerScope.postMessage.mock.lastCall).toHaveLength(1);
  });
});
