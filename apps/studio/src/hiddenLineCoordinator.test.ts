import { describe, expect, it, vi } from "vitest";

import type { ParamSchema, Scene } from "@harness/core";

import {
  HiddenLineCoordinator,
  type OutlineWorkerPort,
} from "./hiddenLineCoordinator";
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
    await expect(result).resolves.toMatchObject({
      status: "success",
      jobId: 1,
    });
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
    worker.emit("message", {
      type: "failure",
      jobId: current.jobId,
      identity: identity(2),
      error: "stale failure",
    });
    expect(coordinator.busy).toBe(true);
    expect(worker.terminate).not.toHaveBeenCalled();

    worker.emit("message", current);
    await expect(result).resolves.toMatchObject({ status: "success" });
  });

  it("reports current progress with estimating then rolling ETA without releasing the slot", async () => {
    const worker = new FakeWorker();
    let now = 0;
    const updates = vi.fn();
    const coordinator = new HiddenLineCoordinator(
      () => worker,
      () => now,
    );
    const result = coordinator.start(identity(), updates);

    worker.emit("message", progressResponse(worker, 10));
    expect(updates).toHaveBeenLastCalledWith({
      snapshot: {
        completedWorkUnits: 10,
        totalWorkUnits: 100,
        terminal: false,
      },
      eta: { kind: "estimating", revision: 1 },
    });

    now = 1_000;
    worker.emit("message", progressResponse(worker, 30));
    expect(updates).toHaveBeenLastCalledWith({
      snapshot: {
        completedWorkUnits: 30,
        totalWorkUnits: 100,
        terminal: false,
      },
      eta: { kind: "remaining", revision: 2, remainingMs: 3_500 },
    });
    expect(Object.keys(updates.mock.calls[1]![0])).toEqual(["snapshot", "eta"]);

    now = 1_100;
    worker.emit("message", progressResponse(worker, 100, 100, true));
    expect(updates).toHaveBeenLastCalledWith({
      snapshot: {
        completedWorkUnits: 100,
        totalWorkUnits: 100,
        terminal: true,
      },
      eta: { kind: "remaining", revision: 3, remainingMs: 0 },
    });
    expect(coordinator.busy).toBe(true);
    expect(worker.terminate).not.toHaveBeenCalled();

    worker.emit("message", successfulResponse(worker));
    await expect(result).resolves.toMatchObject({ status: "success" });
  });

  it("ignores foreign, duplicate, regressive, and unstable-total progress", async () => {
    const worker = new FakeWorker();
    const clock = vi.fn(() => 1_000);
    const updates = vi.fn();
    const coordinator = new HiddenLineCoordinator(() => worker, clock);
    const result = coordinator.start(identity(), updates);
    const current = progressResponse(worker, 10);

    worker.emit("message", { ...current, jobId: current.jobId + 1 });
    worker.emit("message", current);
    worker.emit("message", current);
    worker.emit("message", progressResponse(worker, 9));
    worker.emit("message", progressResponse(worker, 20, 101));
    worker.emit("message", progressResponse(worker, 20));

    expect(updates).toHaveBeenCalledTimes(2);
    expect(clock).toHaveBeenCalledTimes(2);
    expect(
      updates.mock.calls.map(([update]) => update.snapshot.completedWorkUnits),
    ).toEqual([10, 20]);
    expect(coordinator.busy).toBe(true);

    worker.emit("message", successfulResponse(worker));
    await expect(result).resolves.toMatchObject({ status: "success" });
  });

  it("uses a fresh rolling estimator for every recreated job", async () => {
    const firstWorker = new FakeWorker();
    const secondWorker = new FakeWorker();
    const workers = [firstWorker, secondWorker];
    let now = 0;
    const coordinator = new HiddenLineCoordinator(
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
    firstWorker.emit("message", successfulResponse(firstWorker));
    await first;

    now = 2_000;
    const secondUpdates = vi.fn();
    const second = coordinator.start(identity(2), secondUpdates);
    secondWorker.emit("message", progressResponse(secondWorker, 10));
    expect(secondUpdates).toHaveBeenLastCalledWith(
      expect.objectContaining({ eta: { kind: "estimating", revision: 1 } }),
    );
    secondWorker.emit("message", successfulResponse(secondWorker));
    await second;
  });

  it("does not deliver progress after cancellation or let it affect a recreated job", async () => {
    const firstWorker = new FakeWorker();
    const secondWorker = new FakeWorker();
    const workers = [firstWorker, secondWorker];
    const coordinator = new HiddenLineCoordinator(() => workers.shift()!);
    const firstUpdates = vi.fn();
    const first = coordinator.start(identity(), firstUpdates);
    coordinator.cancel();
    await first;

    const secondUpdates = vi.fn();
    const second = coordinator.start(identity(2), secondUpdates);
    firstWorker.emit("message", progressResponse(firstWorker, 10));
    expect(firstUpdates).not.toHaveBeenCalled();
    expect(secondUpdates).not.toHaveBeenCalled();
    expect(coordinator.busy).toBe(true);

    secondWorker.emit("message", successfulResponse(secondWorker));
    await second;
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
    await expect(second).resolves.toMatchObject({
      status: "success",
      jobId: 2,
    });
  });

  it.each([
    ["malformed message", "message", null, "invalid response"],
    ["worker error", "error", new Event("error"), "worker failed"],
    [
      "message decode error",
      "messageerror",
      new Event("messageerror"),
      "could not be decoded",
    ],
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
      await expect(second).resolves.toMatchObject({
        status: "success",
        jobId: 2,
      });
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
    const updates = vi.fn();
    const result = coordinator.start(identity(), updates);
    coordinator.dispose();
    worker.emit("message", progressResponse(worker, 10));
    await expect(result).resolves.toEqual({ status: "cancelled", jobId: 1 });
    expect(updates).not.toHaveBeenCalled();
    expect(worker.terminate).toHaveBeenCalledOnce();
    await expect(coordinator.start(identity())).rejects.toThrow("disposed");
  });
});
