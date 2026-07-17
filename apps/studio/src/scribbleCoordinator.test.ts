import { describe, expect, it, vi } from "vitest";

import type { ParamSchema, Scene, ScribbleDiagnostics } from "@harness/core";

import {
  ScribbleCoordinator,
  type ScribbleWorkerPort,
} from "./scribbleCoordinator";
import {
  createScribbleComputeIdentity,
  type ScribbleComputeIdentity,
  type ScribbleComputeRequest,
} from "./scribbleComputeProtocol";

const schema: ParamSchema = {
  amount: { kind: "number", min: 0, max: 10, default: 1 },
};

const scene: Scene = {
  space: { width: 20, height: 20 },
  primitives: [
    {
      points: [
        [0, 0],
        [10, 10],
      ],
      stroke: { color: "black", width: 1 },
    },
  ],
};

const diagnostics: ScribbleDiagnostics = {
  termination: "completed",
  residualError: 0.05,
  pathLength: 20,
  polylineCount: 1,
  penLiftCount: 0,
};

function identity(amount = 1): ScribbleComputeIdentity {
  return createScribbleComputeIdentity({
    sketchId: "test-scribble",
    schema,
    params: { amount },
    seed: 123,
    compositionFrame: scene.space,
  });
}

class FakeWorker implements ScribbleWorkerPort {
  request: ScribbleComputeRequest | null = null;
  readonly terminate = vi.fn(() => {
    if (this.terminateError !== undefined) throw this.terminateError;
  });
  postError: unknown;
  listenError: unknown;
  terminateError: unknown;
  private readonly listeners = new Map<
    string,
    Array<(event: any) => void>
  >();

  postMessage(message: ScribbleComputeRequest): void {
    this.request = message;
    if (this.postError !== undefined) throw this.postError;
  }

  addEventListener(type: string, listener: (event: any) => void): void {
    if (this.listenError !== undefined) throw this.listenError;
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  emit(type: "message" | "error" | "messageerror", value: unknown): void {
    const event = type === "message" ? { data: value } : value;
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

function successResponse(worker: FakeWorker) {
  const request = worker.request!;
  return {
    type: "success" as const,
    jobId: request.jobId,
    identity: request.identity,
    scene,
    diagnostics,
    computeTimeMs: 250,
  };
}

function failureResponse(worker: FakeWorker, error = "solver failed") {
  const request = worker.request!;
  return {
    type: "failure" as const,
    jobId: request.jobId,
    identity: request.identity,
    error,
  };
}

function progressResponse(
  worker: FakeWorker,
  completedWorkUnits: number,
  totalWorkUnits = 100,
  terminal = false,
) {
  return {
    type: "progress" as const,
    jobId: worker.request!.jobId,
    snapshot: { completedWorkUnits, totalWorkUnits, terminal },
  };
}

describe("ScribbleCoordinator", () => {
  it("creates one worker per job and returns the complete typed success", async () => {
    const worker = new FakeWorker();
    const factory = vi.fn(() => worker);
    const coordinator = new ScribbleCoordinator(factory);
    const result = coordinator.start(identity());

    expect(coordinator.busy).toBe(true);
    expect(factory).toHaveBeenCalledOnce();
    expect(worker.request).toEqual({
      type: "compute",
      jobId: 1,
      identity: identity(),
    });
    await expect(coordinator.start(identity(2))).rejects.toThrow(
      "already active",
    );

    worker.emit("message", successResponse(worker));
    await expect(result).resolves.toEqual({
      status: "success",
      jobId: 1,
      identity: identity(),
      scene,
      diagnostics,
      computeTimeMs: 250,
    });
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(coordinator.busy).toBe(false);
  });

  it("applies Scribble's monotonic filter and accepts only a newly terminal equal count", async () => {
    const worker = new FakeWorker();
    let now = 0;
    const updates = vi.fn();
    const clock = vi.fn(() => now);
    const coordinator = new ScribbleCoordinator(() => worker, clock);
    const result = coordinator.start(identity(), updates);
    const first = progressResponse(worker, 10);

    worker.emit("message", { ...first, jobId: first.jobId + 1 });
    worker.emit("message", first);
    worker.emit("message", first);
    worker.emit("message", progressResponse(worker, 9));
    worker.emit("message", progressResponse(worker, 20, 101));
    now = 1_000;
    worker.emit("message", progressResponse(worker, 20));

    // A regressive terminal is stale. An equal count is accepted only when it
    // newly communicates truthful early termination.
    worker.emit("message", progressResponse(worker, 19, 100, true));
    now = 1_100;
    worker.emit("message", progressResponse(worker, 20, 100, true));
    worker.emit("message", progressResponse(worker, 21));
    worker.emit("message", progressResponse(worker, 21, 100, true));

    expect(updates).toHaveBeenCalledTimes(3);
    expect(clock).toHaveBeenCalledTimes(3);
    expect(updates.mock.calls).toEqual([
      [
        {
          snapshot: {
            completedWorkUnits: 10,
            totalWorkUnits: 100,
            terminal: false,
          },
          eta: { kind: "estimating", revision: 1 },
        },
      ],
      [
        {
          snapshot: {
            completedWorkUnits: 20,
            totalWorkUnits: 100,
            terminal: false,
          },
          eta: { kind: "remaining", revision: 2, remainingMs: 8_000 },
        },
      ],
      [
        {
          snapshot: {
            completedWorkUnits: 20,
            totalWorkUnits: 100,
            terminal: true,
          },
          eta: { kind: "remaining", revision: 3, remainingMs: 0 },
        },
      ],
    ]);
    expect(coordinator.busy).toBe(true);

    worker.emit("message", successResponse(worker));
    await expect(result).resolves.toMatchObject({ status: "success" });
  });

  it("forces zero ETA for a first, early terminal progress snapshot", async () => {
    const worker = new FakeWorker();
    const updates = vi.fn();
    const coordinator = new ScribbleCoordinator(() => worker, () => 50);
    const result = coordinator.start(identity(), updates);

    worker.emit("message", progressResponse(worker, 3, 40, true));
    expect(updates).toHaveBeenCalledWith({
      snapshot: {
        completedWorkUnits: 3,
        totalWorkUnits: 40,
        terminal: true,
      },
      eta: { kind: "remaining", revision: 1, remainingMs: 0 },
    });

    worker.emit("message", successResponse(worker));
    await result;
  });

  it("cancels, recreates with a fresh ETA, and ignores the old worker", async () => {
    const firstWorker = new FakeWorker();
    const secondWorker = new FakeWorker();
    const workers = [firstWorker, secondWorker];
    let now = 0;
    const coordinator = new ScribbleCoordinator(
      () => workers.shift()!,
      () => now,
    );
    const firstUpdates = vi.fn();
    const first = coordinator.start(identity(), firstUpdates);

    firstWorker.emit("message", progressResponse(firstWorker, 10));
    now = 1_000;
    firstWorker.emit("message", progressResponse(firstWorker, 30));
    expect(firstUpdates).toHaveBeenLastCalledWith(
      expect.objectContaining({
        eta: expect.objectContaining({ kind: "remaining" }),
      }),
    );
    expect(coordinator.cancel()).toBe(true);
    await expect(first).resolves.toEqual({ status: "cancelled", jobId: 1 });
    expect(firstWorker.terminate).toHaveBeenCalledOnce();

    now = 2_000;
    const secondUpdates = vi.fn();
    const second = coordinator.start(identity(2), secondUpdates);
    expect(secondWorker.request?.jobId).toBe(2);
    firstWorker.emit("message", progressResponse(firstWorker, 40));
    firstWorker.emit("message", successResponse(firstWorker));
    expect(firstUpdates).toHaveBeenCalledTimes(2);
    expect(secondUpdates).not.toHaveBeenCalled();

    secondWorker.emit("message", progressResponse(secondWorker, 10));
    expect(secondUpdates).toHaveBeenLastCalledWith(
      expect.objectContaining({ eta: { kind: "estimating", revision: 1 } }),
    );
    secondWorker.emit("message", successResponse(secondWorker));
    await expect(second).resolves.toMatchObject({
      status: "success",
      jobId: 2,
    });
    expect(secondWorker.terminate).toHaveBeenCalledOnce();
  });

  it("ignores well-formed foreign ids and identities until the current response", async () => {
    const worker = new FakeWorker();
    const coordinator = new ScribbleCoordinator(() => worker);
    const result = coordinator.start(identity());
    const current = successResponse(worker);

    worker.emit("message", { ...current, jobId: current.jobId + 1 });
    worker.emit("message", { ...current, identity: identity(2) });
    worker.emit("message", {
      ...failureResponse(worker, "stale failure"),
      identity: identity(2),
    });
    expect(coordinator.busy).toBe(true);
    expect(worker.terminate).not.toHaveBeenCalled();

    worker.emit("message", current);
    await expect(result).resolves.toMatchObject({ status: "success" });
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it("returns bounded failures from valid worker failure responses", async () => {
    const worker = new FakeWorker();
    const coordinator = new ScribbleCoordinator(() => worker);
    const result = coordinator.start(identity());

    worker.emit("message", failureResponse(worker, "x".repeat(600)));
    const outcome = await result;
    expect(outcome).toEqual({
      status: "failure",
      jobId: 1,
      error: "x".repeat(500),
    });
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it.each([
    {
      name: "malformed message",
      emit: (worker: FakeWorker) => worker.emit("message", { nope: true }),
      error: "invalid response",
    },
    {
      name: "worker error",
      emit: (worker: FakeWorker) =>
        worker.emit("error", { message: "worker exploded" }),
      error: "worker exploded",
    },
    {
      name: "decode error",
      emit: (worker: FakeWorker) => worker.emit("messageerror", {}),
      error: "could not be decoded",
    },
  ])("settles and terminates once after a $name", async ({ emit, error }) => {
    const worker = new FakeWorker();
    const coordinator = new ScribbleCoordinator(() => worker);
    const result = coordinator.start(identity());

    emit(worker);
    emit(worker);
    await expect(result).resolves.toMatchObject({
      status: "failure",
      jobId: 1,
      error: expect.stringContaining(error),
    });
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(coordinator.busy).toBe(false);
  });

  it("converts worker construction, listener, and post failures to typed results", async () => {
    const constructorCoordinator = new ScribbleCoordinator(() => {
      throw new Error("construction failed");
    });
    await expect(constructorCoordinator.start(identity())).resolves.toEqual({
      status: "failure",
      jobId: 1,
      error: "construction failed",
    });
    expect(constructorCoordinator.busy).toBe(false);

    const listenerWorker = new FakeWorker();
    listenerWorker.listenError = new Error("listener failed");
    const listenerCoordinator = new ScribbleCoordinator(() => listenerWorker);
    await expect(listenerCoordinator.start(identity())).resolves.toEqual({
      status: "failure",
      jobId: 1,
      error: "listener failed",
    });
    expect(listenerWorker.terminate).toHaveBeenCalledOnce();

    const postWorker = new FakeWorker();
    postWorker.postError = new Error("clone failed");
    const postCoordinator = new ScribbleCoordinator(() => postWorker);
    await expect(postCoordinator.start(identity())).resolves.toEqual({
      status: "failure",
      jobId: 1,
      error: "clone failed",
    });
    expect(postWorker.terminate).toHaveBeenCalledOnce();
  });

  it("permanently closes on disposal and terminates an active worker once", async () => {
    const worker = new FakeWorker();
    const factory = vi.fn(() => worker);
    const coordinator = new ScribbleCoordinator(factory);
    const result = coordinator.start(identity());

    coordinator.dispose();
    coordinator.dispose();
    await expect(result).resolves.toEqual({ status: "cancelled", jobId: 1 });
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(coordinator.busy).toBe(false);
    await expect(coordinator.start(identity(2))).rejects.toThrow("disposed");
    expect(factory).toHaveBeenCalledOnce();
  });

  it("still settles when worker termination itself throws", async () => {
    const worker = new FakeWorker();
    worker.terminateError = new Error("termination failed");
    const coordinator = new ScribbleCoordinator(() => worker);
    const result = coordinator.start(identity());

    worker.emit("message", successResponse(worker));
    await expect(result).resolves.toMatchObject({ status: "success" });
    coordinator.dispose();
    expect(worker.terminate).toHaveBeenCalledOnce();
  });
});
