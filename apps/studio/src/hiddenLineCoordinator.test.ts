import { describe, expect, it, vi } from "vitest";

import type { ParamSchema, Scene } from "@harness/core";

import { HiddenLineCoordinator, type OutlineWorkerPort } from "./hiddenLineCoordinator";
import {
  createOutlineComputeIdentity,
  type OutlineComputeIdentity,
  type OutlineComputeRequest,
} from "./outlineComputeProtocol";

const source: Scene = {
  space: { width: 20, height: 20 },
  primitives: [
    {
      points: [
        [0, 0],
        [10, 0],
        [0, 10],
      ],
      closed: true,
      fill: { color: "red" },
    },
  ],
};
const schema: ParamSchema = {
  amount: { kind: "number", min: 0, max: 10, default: 1 },
};

function identity(amount = 1): OutlineComputeIdentity {
  return createOutlineComputeIdentity({
    sketchId: "test",
    schema,
    params: { amount },
    seed: 1,
    sampledT: 0,
    compositionFrame: source.space,
    tolerance: 0,
    includeFrame: false,
    sourceScene: source,
  });
}

class FakeWorker implements OutlineWorkerPort {
  request: OutlineComputeRequest | null = null;
  readonly terminate = vi.fn();
  private readonly listeners = new Map<string, Array<(event: any) => void>>();

  postMessage(message: OutlineComputeRequest): void {
    this.request = message;
  }

  addEventListener(type: string, listener: (event: any) => void): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  emit(type: "message" | "error" | "messageerror", value: unknown): void {
    const event = type === "message" ? { data: value } : value;
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

function successfulResponse(worker: FakeWorker, scene: Scene = source) {
  const request = worker.request!;
  return {
    type: "success" as const,
    jobId: request.jobId,
    identity: request.identity,
    scene,
  };
}

describe("HiddenLineCoordinator", () => {
  it("owns one slot, posts to a worker, and never computes on the main thread", async () => {
    const worker = new FakeWorker();
    const factory = vi.fn(() => worker);
    const coordinator = new HiddenLineCoordinator(factory);
    const result = coordinator.start(identity());

    expect(coordinator.busy).toBe(true);
    expect(factory).toHaveBeenCalledOnce();
    expect(worker.request).toMatchObject({ type: "compute", jobId: 1 });
    await expect(coordinator.start(identity(2))).rejects.toThrow(
      "already active",
    );

    worker.emit("message", successfulResponse(worker));
    await expect(result).resolves.toMatchObject({ status: "success", jobId: 1 });
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(coordinator.busy).toBe(false);
  });

  it("ignores well-formed stale ids and identities until the current result arrives", async () => {
    const worker = new FakeWorker();
    const coordinator = new HiddenLineCoordinator(() => worker);
    const result = coordinator.start(identity());
    const current = successfulResponse(worker);

    worker.emit("message", { ...current, jobId: current.jobId + 1 });
    worker.emit("message", { ...current, identity: identity(2) });
    expect(coordinator.busy).toBe(true);
    expect(worker.terminate).not.toHaveBeenCalled();

    worker.emit("message", current);
    await expect(result).resolves.toMatchObject({ status: "success" });
  });

  it("cancels by termination with a typed, silent outcome and monotonic ids", async () => {
    const workers = [new FakeWorker(), new FakeWorker()];
    const coordinator = new HiddenLineCoordinator(() => workers.shift()!);
    const firstWorker = workers[0]!;
    const first = coordinator.start(identity());
    expect(coordinator.cancel()).toBe(true);
    await expect(first).resolves.toEqual({ status: "cancelled", jobId: 1 });
    expect(firstWorker.terminate).toHaveBeenCalledOnce();
    expect(coordinator.cancel()).toBe(false);

    const secondWorker = workers[0]!;
    const second = coordinator.start(identity(2));
    expect(secondWorker.request?.jobId).toBe(2);
    secondWorker.emit("message", successfulResponse(secondWorker));
    await expect(second).resolves.toMatchObject({ status: "success", jobId: 2 });
  });

  it.each([
    ["malformed message", "message", null, "invalid response"],
    ["worker error", "error", new Event("error"), "worker failed"],
    ["message decode error", "messageerror", new Event("messageerror"), "could not be decoded"],
  ] as const)(
    "terminates on %s and creates a clean worker for the next job",
    async (_label, eventType, payload, expected) => {
      const firstWorker = new FakeWorker();
      const secondWorker = new FakeWorker();
      const workers = [firstWorker, secondWorker];
      const coordinator = new HiddenLineCoordinator(() => workers.shift()!);
      const first = coordinator.start(identity());
      firstWorker.emit(eventType, payload);
      await expect(first).resolves.toMatchObject({
        status: "failure",
        error: expect.stringContaining(expected),
      });
      expect(firstWorker.terminate).toHaveBeenCalledOnce();

      const second = coordinator.start(identity(2));
      secondWorker.emit("message", successfulResponse(secondWorker));
      await expect(second).resolves.toMatchObject({ status: "success", jobId: 2 });
    },
  );

  it("treats a current domain failure as failure and releases the slot", async () => {
    const worker = new FakeWorker();
    const coordinator = new HiddenLineCoordinator(() => worker);
    const result = coordinator.start(identity());
    worker.emit("message", {
      type: "failure",
      jobId: worker.request!.jobId,
      identity: worker.request!.identity,
      error: "geometry failed",
    });
    await expect(result).resolves.toEqual({
      status: "failure",
      jobId: 1,
      error: "geometry failed",
    });
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it("reports constructor and postMessage failures without a fallback", async () => {
    const constructorFailure = new HiddenLineCoordinator(() => {
      throw new Error("workers unavailable");
    });
    await expect(constructorFailure.start(identity())).resolves.toEqual({
      status: "failure",
      jobId: 1,
      error: "workers unavailable",
    });

    const worker = new FakeWorker();
    worker.postMessage = () => {
      throw new Error("clone failed");
    };
    const postFailure = new HiddenLineCoordinator(() => worker);
    await expect(postFailure.start(identity())).resolves.toEqual({
      status: "failure",
      jobId: 1,
      error: "clone failed",
    });
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it("dispose terminates active work and permanently closes the coordinator", async () => {
    const worker = new FakeWorker();
    const coordinator = new HiddenLineCoordinator(() => worker);
    const result = coordinator.start(identity());
    coordinator.dispose();
    await expect(result).resolves.toEqual({ status: "cancelled", jobId: 1 });
    expect(worker.terminate).toHaveBeenCalledOnce();
    await expect(coordinator.start(identity())).rejects.toThrow("disposed");
  });
});
