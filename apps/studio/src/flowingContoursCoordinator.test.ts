import { describe, expect, it, vi } from "vitest";

import { defaultParams, flowingContours, type Scene } from "@harness/core";

import {
  FlowingContoursCoordinator,
  type FlowingContoursWorkerPort,
} from "./flowingContoursCoordinator";
import {
  createFlowingContoursComputeIdentity,
  type FlowingContoursComputeRequest,
} from "./flowingContoursComputeProtocol";

const scene: Scene = {
  space: { width: 20, height: 20 },
  primitives: [],
};
const identity = createFlowingContoursComputeIdentity({
  sketchId: flowingContours.id,
  schema: flowingContours.schema,
  params: defaultParams(flowingContours.schema),
  seed: 1,
  compositionFrame: scene.space,
});

class FakeWorker implements FlowingContoursWorkerPort {
  request: FlowingContoursComputeRequest | null = null;
  readonly terminate = vi.fn();
  private readonly listeners = new Map<
    string,
    Array<(event: any) => void>
  >();

  postMessage(message: FlowingContoursComputeRequest): void {
    this.request = message;
  }
  addEventListener(type: string, listener: (event: any) => void): void {
    const existing = this.listeners.get(type) ?? [];
    existing.push(listener);
    this.listeners.set(type, existing);
  }
  emit(type: string, value: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(type === "message" ? { data: value } : value);
    }
  }
}

describe("FlowingContoursCoordinator", () => {
  it("creates and terminates exactly one worker for one successful job", async () => {
    const worker = new FakeWorker();
    const factory = vi.fn(() => worker);
    const coordinator = new FlowingContoursCoordinator(factory);
    const result = coordinator.start(identity);

    expect(factory).toHaveBeenCalledOnce();
    await expect(coordinator.start(identity)).rejects.toThrow(/already active/);
    worker.emit("message", {
      type: "success",
      jobId: 1,
      identity,
      scene,
      computeTimeMs: 25,
    });
    await expect(result).resolves.toMatchObject({
      status: "success",
      scene,
      computeTimeMs: 25,
    });
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it("cancels once and ignores queued stale completion", async () => {
    const worker = new FakeWorker();
    const coordinator = new FlowingContoursCoordinator(() => worker);
    const result = coordinator.start(identity);
    expect(coordinator.cancel()).toBe(true);
    expect(coordinator.cancel()).toBe(false);
    worker.emit("message", {
      type: "success",
      jobId: 1,
      identity,
      scene,
      computeTimeMs: 25,
    });
    await expect(result).resolves.toEqual({ status: "cancelled", jobId: 1 });
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it("fails closed on invalid structured-clone output", async () => {
    const worker = new FakeWorker();
    const coordinator = new FlowingContoursCoordinator(() => worker);
    const result = coordinator.start(identity);
    worker.emit("message", { type: "success", jobId: 1 });
    await expect(result).resolves.toMatchObject({
      status: "failure",
      error: expect.stringMatching(/invalid response/),
    });
  });

  it("fails and terminates on a valid response for the wrong job", async () => {
    const worker = new FakeWorker();
    const coordinator = new FlowingContoursCoordinator(() => worker);
    const result = coordinator.start(identity);
    worker.emit("message", {
      type: "success",
      jobId: 2,
      identity,
      scene,
      computeTimeMs: 25,
    });

    await expect(result).resolves.toMatchObject({
      status: "failure",
      error: expect.stringMatching(/wrong job id/),
    });
    expect(coordinator.busy).toBe(false);
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it("fails and terminates on a valid response for the wrong identity", async () => {
    const worker = new FakeWorker();
    const coordinator = new FlowingContoursCoordinator(() => worker);
    const result = coordinator.start(identity);
    const wrongIdentity = createFlowingContoursComputeIdentity({
      sketchId: flowingContours.id,
      schema: flowingContours.schema,
      params: {
        ...defaultParams(flowingContours.schema),
        curveDetail: 8,
      },
      seed: 1,
      compositionFrame: scene.space,
    });
    worker.emit("message", {
      type: "success",
      jobId: 1,
      identity: wrongIdentity,
      scene,
      computeTimeMs: 25,
    });

    await expect(result).resolves.toMatchObject({
      status: "failure",
      error: expect.stringMatching(/wrong identity/),
    });
    expect(coordinator.busy).toBe(false);
    expect(worker.terminate).toHaveBeenCalledOnce();
  });
});
