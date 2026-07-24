import { describe, expect, it, vi } from "vitest";

import {
  IMAGE_DETAIL_ANALYSIS_DEFINITION_ID,
  type PreparedImageDetailAnalysis,
} from "@harness/core";

import {
  DetailCoordinator,
  type DetailPreparationResult,
  type DetailWorkerPort,
} from "./detailCoordinator";
import {
  createDetailPreparationIdentity,
  type DetailPreparationRequest,
} from "./detailPreparationProtocol";

const identity = createDetailPreparationIdentity({
  imageAssetId: "pinecone-4330aa0314f7",
  analysisDefinitionId: IMAGE_DETAIL_ANALYSIS_DEFINITION_ID,
});
const otherIdentity = createDetailPreparationIdentity({
  imageAssetId: "doggo-2c7b56f9257e",
  analysisDefinitionId: IMAGE_DETAIL_ANALYSIS_DEFINITION_ID,
});

function prepared(): PreparedImageDetailAnalysis {
  return {
    definitionId: IMAGE_DETAIL_ANALYSIS_DEFINITION_ID,
    sourceWidth: 1,
    sourceHeight: 1,
    gridWidth: 1,
    gridHeight: 1,
    data: new Float64Array([0.5]),
  };
}

class FakeWorker implements DetailWorkerPort {
  request: DetailPreparationRequest | null = null;
  readonly terminate = vi.fn(() => {
    this.onTerminate?.();
    if (this.terminateError !== undefined) throw this.terminateError;
  });
  postError: unknown;
  listenError: unknown;
  terminateError: unknown;
  onPost: (() => void) | undefined;
  onTerminate: (() => void) | undefined;
  private readonly listeners = new Map<string, Array<(event: any) => void>>();

  postMessage(message: DetailPreparationRequest): void {
    this.request = message;
    if (this.postError !== undefined) throw this.postError;
    this.onPost?.();
  }

  addEventListener(type: string, listener: (event: any) => void): void {
    if (this.listenError !== undefined) throw this.listenError;
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: (event: any) => void): void {
    const listeners = this.listeners.get(type);
    if (listeners === undefined) return;
    this.listeners.set(
      type,
      listeners.filter((candidate) => candidate !== listener),
    );
  }

  emit(type: "message" | "error" | "messageerror", value: unknown): void {
    const event =
      type === "message"
        ? { data: value }
        : value instanceof Event
          ? value
          : Object.assign(new Event(type), value);
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

function success(worker: FakeWorker) {
  return {
    type: "success" as const,
    jobId: worker.request!.jobId,
    identity: worker.request!.identity,
    prepared: prepared(),
  };
}

function failure(worker: FakeWorker, error = "analysis failed") {
  return {
    type: "failure" as const,
    jobId: worker.request!.jobId,
    identity: worker.request!.identity,
    error,
  };
}

describe("DetailCoordinator", () => {
  it("owns one identity-only worker job and returns validated prepared data", async () => {
    const worker = new FakeWorker();
    const factory = vi.fn(() => worker);
    const coordinator = new DetailCoordinator(factory);
    const result = coordinator.start(identity);

    expect(coordinator.busy).toBe(true);
    expect(worker.request).toEqual({ type: "compute", jobId: 1, identity });
    expect(worker.request!.identity).not.toBe(identity);
    expect(JSON.stringify(worker.request)).not.toMatch(
      /pixels|bitmap|blob|data/i,
    );
    await expect(coordinator.start(otherIdentity)).rejects.toThrow(
      "already active",
    );

    worker.emit("message", success(worker));
    await expect(result).resolves.toEqual({
      status: "success",
      jobId: 1,
      identity,
      prepared: prepared(),
    });
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(factory).toHaveBeenCalledOnce();
  });

  it("preserves the validated transferable result and copied latest identity", async () => {
    const worker = new FakeWorker();
    const coordinator = new DetailCoordinator(() => worker);
    const candidate = { ...identity };
    const result = coordinator.start(candidate);
    const response = success(worker);

    candidate.imageAssetId = otherIdentity.imageAssetId;
    worker.emit("message", response);

    const outcome = await result;
    expect(outcome).toMatchObject({
      status: "success",
      identity,
    });
    if (outcome.status !== "success") throw new Error("expected success");
    expect(outcome.identity).not.toBe(candidate);
    expect(outcome.prepared).toBe(response.prepared);
  });

  it("ignores foreign job and identity responses, then accepts the current one", async () => {
    const worker = new FakeWorker();
    const coordinator = new DetailCoordinator(() => worker);
    const result = coordinator.start(identity);
    const current = success(worker);

    worker.emit("message", { ...current, jobId: current.jobId + 1 });
    worker.emit("message", { ...current, identity: otherIdentity });
    worker.emit("message", { ...failure(worker), identity: otherIdentity });
    expect(coordinator.busy).toBe(true);
    expect(worker.terminate).not.toHaveBeenCalled();

    worker.emit("message", current);
    await expect(result).resolves.toMatchObject({ status: "success" });
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it.each([
    ["invalid response", "message", { nope: true }, "invalid response"],
    [
      "unsupported progress response",
      "message",
      {
        type: "progress",
        jobId: 1,
        completedWorkUnits: 1,
        totalWorkUnits: 2,
      },
      "invalid response",
    ],
    ["malformed prepared success", "message", null, "invalid response"],
    [
      "worker error",
      "error",
      { message: "worker exploded" },
      "worker exploded",
    ],
    ["message decode error", "messageerror", {}, "could not be decoded"],
  ])(
    "settles and terminates once after a %s",
    async (_name, type, candidate, error) => {
      const worker = new FakeWorker();
      const coordinator = new DetailCoordinator(() => worker);
      const result = coordinator.start(identity);
      const value =
        candidate === null
          ? {
              ...success(worker),
              prepared: { ...prepared(), data: new Float64Array([2]) },
            }
          : candidate;

      worker.emit(type as "message" | "error" | "messageerror", value);
      worker.emit(type as "message" | "error" | "messageerror", value);
      await expect(result).resolves.toMatchObject({
        status: "failure",
        jobId: 1,
        error: expect.stringContaining(error),
      });
      expect(worker.terminate).toHaveBeenCalledOnce();
    },
  );

  it("returns bounded worker failures", async () => {
    const worker = new FakeWorker();
    const coordinator = new DetailCoordinator(() => worker);
    const result = coordinator.start(identity);
    worker.emit("message", failure(worker, "x".repeat(500)));
    await expect(result).resolves.toEqual({
      status: "failure",
      jobId: 1,
      error: "x".repeat(500),
    });
  });

  it.each([
    {
      name: "success",
      emit: (worker: FakeWorker) =>
        worker.emit("message", success(worker)),
      expected: { status: "success", jobId: 1 },
    },
    {
      name: "protocol failure",
      emit: (worker: FakeWorker) =>
        worker.emit("message", failure(worker, "analysis failed")),
      expected: {
        status: "failure",
        jobId: 1,
        error: "analysis failed",
      },
    },
    {
      name: "worker failure",
      emit: (worker: FakeWorker) =>
        worker.emit("error", { message: "worker exploded" }),
      expected: {
        status: "failure",
        jobId: 1,
        error: "worker exploded",
      },
    },
  ])(
    "settles a synchronous $name during boundary creation",
    async ({ emit, expected }) => {
      const worker = new FakeWorker();
      worker.onPost = () => emit(worker);
      const coordinator = new DetailCoordinator(() => worker);

      const result = coordinator.start(identity);

      expect(coordinator.busy).toBe(false);
      await expect(result).resolves.toMatchObject(expected);
      expect(worker.terminate).toHaveBeenCalledOnce();
    },
  );

  it("honors cancellation and replacement requested by a reentrant worker factory", async () => {
    const firstWorker = new FakeWorker();
    const secondWorker = new FakeWorker();
    let factoryCall = 0;
    let replacement: Promise<DetailPreparationResult> | undefined;
    let coordinator!: DetailCoordinator;
    const cancel = vi.fn(() => coordinator.cancel());
    coordinator = new DetailCoordinator(() => {
      factoryCall++;
      if (factoryCall === 1) {
        expect(cancel()).toBe(true);
        replacement = coordinator.start(otherIdentity);
        return firstWorker;
      }
      return secondWorker;
    });

    const first = coordinator.start(identity);

    await expect(first).resolves.toEqual({ status: "cancelled", jobId: 1 });
    expect(firstWorker.terminate).toHaveBeenCalledOnce();
    expect(coordinator.busy).toBe(true);
    firstWorker.emit("message", success(firstWorker));
    secondWorker.emit("message", success(secondWorker));
    if (replacement === undefined) {
      throw new Error("expected reentrant replacement");
    }
    await expect(replacement).resolves.toMatchObject({
      status: "success",
      jobId: 2,
      identity: otherIdentity,
    });
    expect(secondWorker.terminate).toHaveBeenCalledOnce();
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("keeps a synchronous transport failure terminal during cleanup reentrancy", async () => {
    const firstWorker = new FakeWorker();
    const secondWorker = new FakeWorker();
    firstWorker.postError = new Error("clone failed");
    const workers = [firstWorker, secondWorker];
    let replacement: Promise<DetailPreparationResult> | undefined;
    const coordinator = new DetailCoordinator(() => workers.shift()!);
    firstWorker.onTerminate = () => {
      replacement = coordinator.start(otherIdentity);
    };

    const first = coordinator.start(identity);

    await expect(first).resolves.toEqual({
      status: "failure",
      jobId: 1,
      error: "clone failed",
    });
    expect(coordinator.busy).toBe(true);
    secondWorker.emit("message", success(secondWorker));
    if (replacement === undefined) {
      throw new Error("expected cleanup replacement");
    }
    await expect(replacement).resolves.toMatchObject({
      status: "success",
      jobId: 2,
    });
    expect(firstWorker.terminate).toHaveBeenCalledOnce();
    expect(secondWorker.terminate).toHaveBeenCalledOnce();
  });

  it("does not let disposal during terminal cleanup replace synchronous success", async () => {
    const worker = new FakeWorker();
    const coordinator = new DetailCoordinator(() => worker);
    worker.onPost = () => worker.emit("message", success(worker));
    worker.onTerminate = () => coordinator.dispose();

    const result = coordinator.start(identity);

    await expect(result).resolves.toMatchObject({
      status: "success",
      jobId: 1,
    });
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(coordinator.busy).toBe(false);
    await expect(coordinator.start(otherIdentity)).rejects.toThrow("disposed");
  });

  it("cancels, disposes, and ignores stale callbacks while terminating once", async () => {
    const firstWorker = new FakeWorker();
    const secondWorker = new FakeWorker();
    const workers = [firstWorker, secondWorker];
    const coordinator = new DetailCoordinator(() => workers.shift()!);

    const first = coordinator.start(identity);
    expect(coordinator.cancel()).toBe(true);
    expect(coordinator.cancel()).toBe(false);
    await expect(first).resolves.toEqual({ status: "cancelled", jobId: 1 });
    expect(firstWorker.terminate).toHaveBeenCalledOnce();

    const second = coordinator.start(otherIdentity);
    firstWorker.emit("message", success(firstWorker));
    expect(coordinator.busy).toBe(true);
    coordinator.dispose();
    coordinator.dispose();
    await expect(second).resolves.toEqual({ status: "cancelled", jobId: 2 });
    expect(secondWorker.terminate).toHaveBeenCalledOnce();
    await expect(coordinator.start(identity)).rejects.toThrow("disposed");
  });

  it("converts construction, listener, post, and termination errors to settled results", async () => {
    await expect(
      new DetailCoordinator(() => {
        throw new Error("construction failed");
      }).start(identity),
    ).resolves.toMatchObject({
      status: "failure",
      error: "construction failed",
    });

    for (const [property, detail] of [
      ["listenError", "listener failed"],
      ["postError", "clone failed"],
    ] as const) {
      const worker = new FakeWorker();
      worker[property] = new Error(detail);
      await expect(
        new DetailCoordinator(() => worker).start(identity),
      ).resolves.toMatchObject({
        status: "failure",
        error: detail,
      });
      expect(worker.terminate).toHaveBeenCalledOnce();
    }

    const worker = new FakeWorker();
    worker.terminateError = new Error("termination failed");
    const result = new DetailCoordinator(() => worker).start(identity);
    worker.emit("message", success(worker));
    await expect(result).resolves.toMatchObject({ status: "success" });
    expect(worker.terminate).toHaveBeenCalledOnce();
  });
});
