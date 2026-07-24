import { describe, expect, it, vi } from "vitest";

import type { Scene } from "@harness/core";

import {
  PLOT_STAGE_PREPARATION_ERROR_MAX_LENGTH,
  type PlotStagePreparationFailure,
  type PlotStagePreparationIdentity,
  type PlotStagePreparationRequest,
  type PlotStagePreparationSuccess,
  type PlotStageRegistrationIdentity,
} from "./plotStagePreparationProtocol";
import {
  PlotStageCoordinator,
  type PlotStagePreparationInput,
  type PlotStageWorkerPort,
} from "./plotStageCoordinator";

type WorkerEventType = "message" | "error" | "messageerror";
type WorkerListener = (event: any) => void;

class FakeWorker implements PlotStageWorkerPort {
  readonly posted: PlotStagePreparationRequest[] = [];
  readonly terminate = vi.fn();
  private readonly listeners = new Map<
    WorkerEventType,
    WorkerListener[]
  >();

  addEventListener(type: WorkerEventType, listener: WorkerListener): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: WorkerEventType, listener: WorkerListener): void {
    const listeners = this.listeners.get(type);
    if (listeners === undefined) return;
    this.listeners.set(
      type,
      listeners.filter((candidate) => candidate !== listener),
    );
  }

  postMessage(message: PlotStagePreparationRequest): void {
    this.posted.push(message);
  }

  emit(type: WorkerEventType, value: unknown): void {
    const event = type === "message" ? { data: value } : value;
    for (const listener of [...(this.listeners.get(type) ?? [])]) {
      listener(event);
    }
  }
}

const frame = { width: 320, height: 180 };

function identity(
  stageId = "watercolor-forms",
  imageAsset = "image-a",
  amount = 1,
): PlotStagePreparationIdentity {
  return {
    sketchId: "photo-scribble",
    stageId,
    params: [
      { key: "imageAsset", value: imageAsset },
      { key: "amount", value: amount },
    ],
    compositionFrame: frame,
  };
}

function registrationIdentity(
  imageAsset = "image-a",
): PlotStageRegistrationIdentity {
  return {
    params: [{ key: "imageAsset", value: imageAsset }],
    compositionFrame: frame,
  };
}

function input(
  stageId = "watercolor-forms",
  imageAsset = "image-a",
  amount = 1,
): PlotStagePreparationInput {
  return {
    identity: identity(stageId, imageAsset, amount),
    registrationIdentity: registrationIdentity(imageAsset),
    seed: "ink-seed",
    sampledT: 0.25,
  };
}

function scene(color = "blue"): Scene {
  return {
    space: frame,
    primitives: [
      {
        points: [
          [0, 0],
          [1, 1],
        ],
        stroke: { color, width: 1 },
      },
    ],
  };
}

function success(
  request: PlotStagePreparationRequest,
  completedScene = scene(),
): PlotStagePreparationSuccess {
  return {
    type: "success",
    jobId: request.jobId,
    identity: request.identity,
    registrationIdentity: request.registrationIdentity,
    scene: completedScene,
  };
}

function failure(
  request: PlotStagePreparationRequest,
  error = "Image Asset could not be decoded",
): PlotStagePreparationFailure {
  return {
    type: "failure",
    jobId: request.jobId,
    identity: request.identity,
    registrationIdentity: request.registrationIdentity,
    error,
  };
}

describe("PlotStageCoordinator", () => {
  it("owns one generated job id and exposes copied indeterminate Stage ownership", async () => {
    const worker = new FakeWorker();
    const coordinator = new PlotStageCoordinator(() => worker);
    const candidate = input();

    const result = coordinator.start(candidate);
    const request = worker.posted[0]!;

    expect(request).toEqual({
      type: "compute",
      jobId: 1,
      ...candidate,
    });
    expect(request.identity).not.toBe(candidate.identity);
    expect(request.registrationIdentity).not.toBe(
      candidate.registrationIdentity,
    );
    expect(Object.isFrozen(request.identity)).toBe(true);
    expect(Object.isFrozen(request.registrationIdentity)).toBe(true);
    expect(coordinator.busy).toBe(true);
    expect(coordinator.preparing).toEqual({
      jobId: 1,
      stageId: "watercolor-forms",
      identity: request.identity,
      registrationIdentity: request.registrationIdentity,
    });
    expect(Object.keys(coordinator.preparing!)).toEqual([
      "jobId",
      "stageId",
      "identity",
      "registrationIdentity",
    ]);

    (candidate.identity.params[1] as { value: number }).value = 99;
    (candidate.registrationIdentity.params[0] as { value: string }).value =
      "image-b";
    expect(request.identity.params[1]!.value).toBe(1);
    expect(request.registrationIdentity.params[0]!.value).toBe("image-a");

    const completedScene = scene("cyan");
    worker.emit("message", success(request, completedScene));

    await expect(result).resolves.toEqual({
      status: "success",
      jobId: 1,
      identity: request.identity,
      registrationIdentity: request.registrationIdentity,
      scene: completedScene,
    });
    expect(coordinator.busy).toBe(false);
    expect(coordinator.preparing).toBeNull();
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it("rejects overlapping starts without consuming a job id", async () => {
    const firstWorker = new FakeWorker();
    const secondWorker = new FakeWorker();
    const workers = [firstWorker, secondWorker];
    const coordinator = new PlotStageCoordinator(() => workers.shift()!);

    const first = coordinator.start(input());
    await expect(coordinator.start(input("wash-b"))).rejects.toThrow(
      "already active",
    );

    coordinator.cancel();
    await expect(first).resolves.toEqual({ status: "cancelled", jobId: 1 });
    expect(firstWorker.terminate).toHaveBeenCalledOnce();

    const second = coordinator.start(input("wash-b"));
    expect(secondWorker.posted[0]!.jobId).toBe(2);
    secondWorker.emit("message", success(secondWorker.posted[0]!));
    await expect(second).resolves.toMatchObject({
      status: "success",
      jobId: 2,
    });
  });

  it("ignores wrong job, Stage, preparation, and registration identities", async () => {
    const worker = new FakeWorker();
    const coordinator = new PlotStageCoordinator(() => worker);
    const result = coordinator.start(input());
    const request = worker.posted[0]!;

    worker.emit("message", { ...success(request), jobId: 99 });
    worker.emit("message", {
      ...success(request),
      identity: identity("second-wash"),
    });
    worker.emit("message", {
      ...success(request),
      identity: identity(request.identity.stageId, "image-a", 2),
    });
    worker.emit("message", {
      ...success(request),
      identity: identity(request.identity.stageId, "image-b"),
      registrationIdentity: registrationIdentity("image-b"),
    });

    expect(coordinator.busy).toBe(true);
    expect(worker.terminate).not.toHaveBeenCalled();

    worker.emit("message", success(request));
    await expect(result).resolves.toMatchObject({
      status: "success",
      jobId: 1,
    });
  });

  it("keeps duplicate-generator Stage instances from cross-settling", async () => {
    const firstWorker = new FakeWorker();
    const secondWorker = new FakeWorker();
    const workers = [firstWorker, secondWorker];
    const coordinator = new PlotStageCoordinator(() => workers.shift()!);

    const first = coordinator.start(input("wash-a"));
    const firstRequest = firstWorker.posted[0]!;
    firstWorker.emit("message", success(firstRequest));
    await expect(first).resolves.toMatchObject({
      status: "success",
      identity: { stageId: "wash-a" },
    });

    const second = coordinator.start(input("wash-b"));
    const secondRequest = secondWorker.posted[0]!;
    // Both Stage instances can use the same generator behind the worker, but
    // the old Stage identity cannot own the new job even with its current id.
    secondWorker.emit("message", {
      ...success(firstRequest),
      jobId: secondRequest.jobId,
    });
    firstWorker.emit("message", success(firstRequest));

    expect(coordinator.preparing?.stageId).toBe("wash-b");
    secondWorker.emit("message", success(secondRequest));
    await expect(second).resolves.toMatchObject({
      status: "success",
      jobId: 2,
      identity: { stageId: "wash-b" },
    });
  });

  it("returns a bounded typed worker failure and supports a fresh retry", async () => {
    const firstWorker = new FakeWorker();
    const secondWorker = new FakeWorker();
    const workers = [firstWorker, secondWorker];
    const coordinator = new PlotStageCoordinator(() => workers.shift()!);

    const first = coordinator.start(input());
    const workerError = "x".repeat(PLOT_STAGE_PREPARATION_ERROR_MAX_LENGTH);
    firstWorker.emit(
      "message",
      failure(firstWorker.posted[0]!, workerError),
    );

    await expect(first).resolves.toEqual({
      status: "failure",
      jobId: 1,
      error: workerError,
    });
    expect(firstWorker.terminate).toHaveBeenCalledOnce();
    expect(coordinator.preparing).toBeNull();

    const retry = coordinator.start(input());
    secondWorker.emit("message", success(secondWorker.posted[0]!));
    await expect(retry).resolves.toMatchObject({
      status: "success",
      jobId: 2,
    });
  });

  it("rejects an invalid inbound message as a bounded typed failure", async () => {
    const worker = new FakeWorker();
    const coordinator = new PlotStageCoordinator(() => worker);
    const result = coordinator.start(input());

    worker.emit("message", {
      type: "progress",
      jobId: 1,
      percent: 50,
    });
    worker.emit("message", success(worker.posted[0]!));

    await expect(result).resolves.toEqual({
      status: "failure",
      jobId: 1,
      error: "Plot Stage worker returned an invalid response",
    });
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it("cancels exactly once and ignores late or duplicate settlement", async () => {
    const worker = new FakeWorker();
    const coordinator = new PlotStageCoordinator(() => worker);
    const result = coordinator.start(input());
    const request = worker.posted[0]!;

    expect(coordinator.cancel()).toBe(true);
    expect(coordinator.cancel()).toBe(false);
    worker.emit("message", success(request));
    worker.emit("error", Object.assign(new Event("error"), { message: "late" }));

    await expect(result).resolves.toEqual({ status: "cancelled", jobId: 1 });
    expect(coordinator.busy).toBe(false);
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it("rejects late callbacks from a non-removable old worker during retry", async () => {
    const firstWorker = new FakeWorker();
    firstWorker.removeEventListener = vi.fn();
    const secondWorker = new FakeWorker();
    const workers = [firstWorker, secondWorker];
    const coordinator = new PlotStageCoordinator(() => workers.shift()!);

    const first = coordinator.start(input("wash-a"));
    const firstRequest = firstWorker.posted[0]!;
    coordinator.cancel();
    await expect(first).resolves.toEqual({ status: "cancelled", jobId: 1 });

    const retry = coordinator.start(input("wash-b"));
    const retryRequest = secondWorker.posted[0]!;
    firstWorker.emit("message", {
      ...success(firstRequest),
      jobId: retryRequest.jobId,
      identity: retryRequest.identity,
      registrationIdentity: retryRequest.registrationIdentity,
    });

    expect(coordinator.preparing?.stageId).toBe("wash-b");
    expect(secondWorker.terminate).not.toHaveBeenCalled();
    secondWorker.emit("message", success(retryRequest));
    await expect(retry).resolves.toMatchObject({
      status: "success",
      jobId: 2,
      identity: { stageId: "wash-b" },
    });
  });

  it("disposes idempotently, cancels the owner, and rejects future work", async () => {
    const worker = new FakeWorker();
    const coordinator = new PlotStageCoordinator(() => worker);
    const result = coordinator.start(input());

    coordinator.dispose();
    coordinator.dispose();

    await expect(result).resolves.toEqual({ status: "cancelled", jobId: 1 });
    expect(worker.terminate).toHaveBeenCalledOnce();
    await expect(coordinator.start(input())).rejects.toThrow("disposed");
  });

  it("normalizes constructor, listener, and post failures", async () => {
    const constructor = new PlotStageCoordinator(() => {
      throw new Error("");
    });
    await expect(constructor.start(input())).resolves.toEqual({
      status: "failure",
      jobId: 1,
      error: "Plot Stage worker failed",
    });

    const listenerWorker = new FakeWorker();
    listenerWorker.addEventListener = vi.fn(() => {
      throw new Error("");
    });
    const listener = new PlotStageCoordinator(() => listenerWorker);
    await expect(listener.start(input())).resolves.toEqual({
      status: "failure",
      jobId: 1,
      error: "Plot Stage worker could not start",
    });
    expect(listenerWorker.terminate).toHaveBeenCalledOnce();

    const postWorker = new FakeWorker();
    postWorker.postMessage = vi.fn(() => {
      throw new Error("");
    });
    const post = new PlotStageCoordinator(() => postWorker);
    await expect(post.start(input())).resolves.toEqual({
      status: "failure",
      jobId: 1,
      error: "Plot Stage worker could not start",
    });
    expect(postWorker.terminate).toHaveBeenCalledOnce();
  });

  it("normalizes worker and decoding events while preserving bounded detail", async () => {
    const errorWorker = new FakeWorker();
    const decodeWorker = new FakeWorker();
    const detailedWorker = new FakeWorker();
    const workers = [errorWorker, decodeWorker, detailedWorker];
    const coordinator = new PlotStageCoordinator(() => workers.shift()!);

    const workerFailure = coordinator.start(input());
    errorWorker.emit("error", new Event("error"));
    await expect(workerFailure).resolves.toEqual({
      status: "failure",
      jobId: 1,
      error: "Plot Stage worker failed",
    });

    const decodeFailure = coordinator.start(input());
    decodeWorker.emit("messageerror", new Event("messageerror"));
    await expect(decodeFailure).resolves.toEqual({
      status: "failure",
      jobId: 2,
      error: "Plot Stage worker response could not be decoded",
    });

    const detailedFailure = coordinator.start(input());
    detailedWorker.emit(
      "error",
      Object.assign(new Event("error"), {
        message: `specific ${"x".repeat(600)}`,
      }),
    );
    const detail = await detailedFailure;
    expect(detail).toMatchObject({
      status: "failure",
      jobId: 3,
    });
    expect(
      detail.status === "failure" ? detail.error.length : 0,
    ).toBe(PLOT_STAGE_PREPARATION_ERROR_MAX_LENGTH);
  });

  it("settles despite throwing termination and never terminates twice", async () => {
    const worker = new FakeWorker();
    worker.terminate.mockImplementation(() => {
      throw new Error("termination failed");
    });
    const coordinator = new PlotStageCoordinator(() => worker);
    const result = coordinator.start(input());

    worker.emit("message", success(worker.posted[0]!));
    worker.emit("message", success(worker.posted[0]!));

    await expect(result).resolves.toMatchObject({ status: "success" });
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it("accepts synchronous success emitted while listener registration is in progress", async () => {
    const worker = new FakeWorker();
    const expected = input();
    const request: PlotStagePreparationRequest = {
      type: "compute",
      jobId: 1,
      ...expected,
    };
    const add = worker.addEventListener.bind(worker);
    worker.addEventListener = vi.fn((type, listener) => {
      add(type, listener);
      if (type === "message") listener({ data: success(request) });
    });
    const coordinator = new PlotStageCoordinator(() => worker);

    const result = coordinator.start(expected);

    await expect(result).resolves.toMatchObject({
      status: "success",
      jobId: 1,
    });
    expect(worker.posted).toEqual([]);
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(coordinator.preparing).toBeNull();
  });

  it("accepts synchronous success emitted by an in-process post boundary", async () => {
    const worker = new FakeWorker();
    worker.postMessage = vi.fn((request) => {
      worker.posted.push(request);
      worker.emit("message", success(request));
    });
    const coordinator = new PlotStageCoordinator(() => worker);

    await expect(coordinator.start(input())).resolves.toMatchObject({
      status: "success",
      jobId: 1,
    });
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(coordinator.busy).toBe(false);
  });

  it("honors reentrant cancellation during worker construction", async () => {
    const worker = new FakeWorker();
    let coordinator!: PlotStageCoordinator;
    const cancel = vi.fn(() => coordinator.cancel());
    coordinator = new PlotStageCoordinator(() => {
      cancel();
      return worker;
    });

    const result = coordinator.start(input());

    expect(cancel).toHaveReturnedWith(true);
    await expect(result).resolves.toEqual({ status: "cancelled", jobId: 1 });
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(coordinator.busy).toBe(false);
  });

  it("honors reentrant disposal during listener construction", async () => {
    const worker = new FakeWorker();
    let coordinator!: PlotStageCoordinator;
    const add = worker.addEventListener.bind(worker);
    worker.addEventListener = vi.fn((type, listener) => {
      add(type, listener);
      if (type === "message") coordinator.dispose();
    });
    coordinator = new PlotStageCoordinator(() => worker);

    const result = coordinator.start(input());

    await expect(result).resolves.toEqual({ status: "cancelled", jobId: 1 });
    expect(worker.terminate).toHaveBeenCalledOnce();
    await expect(coordinator.start(input())).rejects.toThrow("disposed");
  });

  it("does not let reentrant cancellation overwrite synchronous settlement", async () => {
    const worker = new FakeWorker();
    let coordinator!: PlotStageCoordinator;
    const cancel = vi.fn(() => coordinator.cancel());
    worker.postMessage = vi.fn((request) => {
      worker.posted.push(request);
      worker.emit("message", success(request));
      cancel();
    });
    coordinator = new PlotStageCoordinator(() => worker);

    const result = coordinator.start(input());

    expect(cancel).toHaveReturnedWith(false);
    await expect(result).resolves.toMatchObject({
      status: "success",
      jobId: 1,
    });
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it("returns invalid requests as retry-compatible failures without constructing a worker", async () => {
    const factory = vi.fn(() => new FakeWorker());
    const coordinator = new PlotStageCoordinator(factory);
    const invalid = {
      ...input(),
      registrationIdentity: registrationIdentity("image-b"),
    };

    await expect(coordinator.start(invalid)).resolves.toEqual({
      status: "failure",
      jobId: 1,
      error: "Plot Stage preparation request is invalid",
    });
    expect(factory).not.toHaveBeenCalled();
    expect(coordinator.busy).toBe(false);

    const worker = new FakeWorker();
    factory.mockReturnValue(worker);
    const retry = coordinator.start(input());
    expect(worker.posted[0]!.jobId).toBe(2);
    worker.emit("message", success(worker.posted[0]!));
    await expect(retry).resolves.toMatchObject({
      status: "success",
      jobId: 2,
    });
  });
});
