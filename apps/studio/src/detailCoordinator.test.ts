import { describe, expect, it, vi } from "vitest";

import {
  IMAGE_DETAIL_ANALYSIS_DEFINITION_ID,
  type PreparedImageDetailAnalysis,
} from "@harness/core";

import { DetailCoordinator, type DetailWorkerPort } from "./detailCoordinator";
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
    if (this.terminateError !== undefined) throw this.terminateError;
  });
  postError: unknown;
  listenError: unknown;
  terminateError: unknown;
  private readonly listeners = new Map<string, Array<(event: any) => void>>();

  postMessage(message: DetailPreparationRequest): void {
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
