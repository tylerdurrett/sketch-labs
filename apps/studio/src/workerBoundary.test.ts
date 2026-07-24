import { describe, expect, it, vi } from "vitest";

import {
  createWorkerBoundary,
  terminateWorkerOnce,
  workerErrorDetail,
  workerEventDetail,
  type WorkerBoundaryControls,
  type WorkerPort,
} from "./workerBoundary";

type WorkerEventType = "message" | "error" | "messageerror";
type WorkerListener =
  | ((event: MessageEvent<unknown>) => void)
  | ((event: Event) => void);

class TestWorker<Request> implements WorkerPort<Request> {
  readonly posted: Request[] = [];
  readonly listeners = new Map<WorkerEventType, WorkerListener>();
  readonly installedListeners = new Map<WorkerEventType, WorkerListener>();
  readonly removedListeners: WorkerEventType[] = [];
  terminationCount = 0;
  listenerFailure: WorkerEventType | null = null;
  postFailure: Error | null = null;
  terminationFailure: Error | null = null;

  postMessage(message: Request): void {
    if (this.postFailure !== null) throw this.postFailure;
    this.posted.push(message);
  }

  terminate(): void {
    this.terminationCount++;
    if (this.terminationFailure !== null) throw this.terminationFailure;
  }

  addEventListener(
    type: "message",
    listener: (event: MessageEvent<unknown>) => void,
  ): void;
  addEventListener(
    type: "error" | "messageerror",
    listener: (event: Event) => void,
  ): void;
  addEventListener(type: WorkerEventType, listener: WorkerListener): void {
    if (this.listenerFailure === type) {
      throw new Error(`${type} listener failed`);
    }
    this.listeners.set(type, listener);
    this.installedListeners.set(type, listener);
  }

  removeEventListener(type: string, listener: EventListener): void {
    const eventType = type as WorkerEventType;
    if (this.listeners.get(eventType) === listener) {
      this.listeners.delete(eventType);
    }
    this.removedListeners.push(eventType);
  }

  emitMessage(message: unknown): void {
    const listener = this.listeners.get("message") as
      | ((event: MessageEvent<unknown>) => void)
      | undefined;
    listener?.({ data: message } as MessageEvent<unknown>);
  }

  emit(type: "error" | "messageerror", message?: string): void {
    const listener = this.listeners.get(type) as
      | ((event: Event) => void)
      | undefined;
    const event = new Event(type) as Event & { message?: string };
    if (message !== undefined) event.message = message;
    listener?.(event);
  }
}

function createCompletingBoundary(
  worker: TestWorker<string>,
  onMessage: (
    message: unknown,
    controls: WorkerBoundaryControls<string>,
  ) => void = (message, controls) => {
    controls.complete(String(message));
  },
) {
  return createWorkerBoundary({
    createWorker: () => worker,
    request: "start",
    onMessage,
  });
}

describe("worker boundary helpers", () => {
  it("returns bounded Error and event details with safe fallbacks", () => {
    const longDetail = "x".repeat(600);

    expect(workerErrorDetail(new Error(longDetail), "fallback")).toBe(
      longDetail.slice(0, 500),
    );
    expect(workerErrorDetail(new Error("  "), "fallback")).toBe("fallback");
    expect(workerErrorDetail("not an Error", "fallback")).toBe("fallback");
    expect(
      workerEventDetail(
        { message: longDetail } as unknown as Event,
        "fallback",
      ),
    ).toBe(longDetail.slice(0, 500));
    expect(workerEventDetail(new Event("error"), "fallback")).toBe("fallback");
  });

  it("terminates a worker exactly once", () => {
    const worker = { terminate: vi.fn() };
    const terminate = terminateWorkerOnce(worker);

    terminate();
    terminate();
    terminate();

    expect(worker.terminate).toHaveBeenCalledOnce();
  });
});

describe("createWorkerBoundary", () => {
  it("normalizes worker construction failures without attempting transport work", async () => {
    const boundary = createWorkerBoundary<string, never>({
      createWorker: () => {
        throw new Error("constructor exploded");
      },
      request: "start",
      onMessage: () => {
        throw new Error("unreachable");
      },
    });

    await expect(boundary.outcome).resolves.toEqual({
      status: "failure",
      failure: {
        kind: "construction",
        detail: "constructor exploded",
      },
    });
    expect(boundary.active).toBe(false);
    expect(boundary.cancel()).toBe(false);
  });

  it("owns partial listener setup and normalizes registration failures", async () => {
    const worker = new TestWorker<string>();
    worker.listenerFailure = "error";
    const boundary = createCompletingBoundary(worker);

    await expect(boundary.outcome).resolves.toEqual({
      status: "failure",
      failure: {
        kind: "listener",
        detail: "error listener failed",
      },
    });
    expect(worker.posted).toEqual([]);
    expect(worker.terminationCount).toBe(1);
    expect(worker.removedListeners).toEqual(["message", "error"]);
    expect(worker.listeners.size).toBe(0);
  });

  it("normalizes request-posting failures after taking listener ownership", async () => {
    const worker = new TestWorker<string>();
    worker.postFailure = new Error("clone rejected");
    const boundary = createCompletingBoundary(worker);

    await expect(boundary.outcome).resolves.toEqual({
      status: "failure",
      failure: {
        kind: "post-message",
        detail: "clone rejected",
      },
    });
    expect(worker.terminationCount).toBe(1);
    expect(worker.removedListeners).toEqual([
      "message",
      "error",
      "messageerror",
    ]);
  });

  it("normalizes worker errors and undecodable messages", async () => {
    const failedWorker = new TestWorker<string>();
    const failed = createCompletingBoundary(failedWorker);
    failedWorker.emit("error", "worker crashed");

    await expect(failed.outcome).resolves.toEqual({
      status: "failure",
      failure: {
        kind: "worker-error",
        detail: "worker crashed",
      },
    });

    const undecodableWorker = new TestWorker<string>();
    const undecodable = createCompletingBoundary(undecodableWorker);
    undecodableWorker.emit("messageerror");

    await expect(undecodable.outcome).resolves.toEqual({
      status: "failure",
      failure: {
        kind: "message-error",
        detail: "Worker response could not be decoded",
      },
    });
  });

  it("hands unknown messages to the domain validator for explicit rejection", async () => {
    const worker = new TestWorker<string>();
    const received: unknown[] = [];
    const boundary = createCompletingBoundary(worker, (message, controls) => {
      received.push(message);
      if (typeof message !== "string") {
        controls.rejectMessage("Outline worker returned an invalid response");
        return;
      }
      controls.complete(message);
    });
    const invalid = { type: "not-an-outline-message" };

    worker.emitMessage(invalid);

    expect(received).toEqual([invalid]);
    await expect(boundary.outcome).resolves.toEqual({
      status: "failure",
      failure: {
        kind: "invalid-message",
        detail: "Outline worker returned an invalid response",
      },
    });
  });

  it("cancels and disposes active sessions idempotently", async () => {
    const cancelledWorker = new TestWorker<string>();
    const cancelled = createCompletingBoundary(cancelledWorker);

    expect(cancelledWorker.posted).toEqual(["start"]);
    expect(cancelled.cancel()).toBe(true);
    expect(cancelled.cancel()).toBe(false);
    cancelled.dispose();
    await expect(cancelled.outcome).resolves.toEqual({
      status: "cancelled",
    });
    expect(cancelledWorker.terminationCount).toBe(1);

    const disposedWorker = new TestWorker<string>();
    const disposed = createCompletingBoundary(disposedWorker);

    disposed.dispose();
    disposed.dispose();
    expect(disposed.cancel()).toBe(false);
    await expect(disposed.outcome).resolves.toEqual({
      status: "cancelled",
    });
    expect(disposedWorker.terminationCount).toBe(1);
  });

  it("rejects late callbacks after the first terminal settlement", async () => {
    const worker = new TestWorker<string>();
    let handlerCalls = 0;
    let retainedControls: WorkerBoundaryControls<string> | undefined;
    const boundary = createCompletingBoundary(worker, (message, controls) => {
      handlerCalls++;
      retainedControls = controls;
      controls.complete(String(message));
    });
    const staleMessage = worker.installedListeners.get("message") as (
      event: MessageEvent<unknown>,
    ) => void;
    const staleError = worker.installedListeners.get("error") as (
      event: Event,
    ) => void;

    worker.emitMessage("first");
    staleMessage({ data: "late" } as MessageEvent<unknown>);
    staleError(new Event("error"));

    expect(retainedControls?.complete("also late")).toBe(false);
    expect(retainedControls?.rejectMessage("too late")).toBe(false);
    expect(retainedControls?.observe(() => undefined)).toBe(false);
    await expect(boundary.outcome).resolves.toEqual({
      status: "completed",
      value: "first",
    });
    expect(handlerCalls).toBe(1);
    expect(worker.terminationCount).toBe(1);
  });

  it("isolates throwing observers from transport completion", async () => {
    const worker = new TestWorker<string>();
    const boundary = createCompletingBoundary(worker, (message, controls) => {
      expect(
        controls.observe(() => {
          throw new Error("progress observer exploded");
        }),
      ).toBe(true);
      controls.complete(String(message));
    });

    worker.emitMessage("done");

    await expect(boundary.outcome).resolves.toEqual({
      status: "completed",
      value: "done",
    });
    expect(worker.terminationCount).toBe(1);
  });

  it("normalizes message-handler failures", async () => {
    const worker = new TestWorker<string>();
    const boundary = createCompletingBoundary(worker, () => {
      throw new Error("protocol handler exploded");
    });

    worker.emitMessage("response");

    await expect(boundary.outcome).resolves.toEqual({
      status: "failure",
      failure: {
        kind: "message-handler",
        detail: "protocol handler exploded",
      },
    });
    expect(worker.terminationCount).toBe(1);
  });

  it("settles exactly once even when termination throws", async () => {
    const worker = new TestWorker<string>();
    worker.terminationFailure = new Error("termination exploded");
    let controls: WorkerBoundaryControls<string> | undefined;
    const boundary = createCompletingBoundary(
      worker,
      (message, currentControls) => {
        controls = currentControls;
        expect(currentControls.complete(String(message))).toBe(true);
        expect(currentControls.complete("duplicate")).toBe(false);
        expect(currentControls.rejectMessage("duplicate failure")).toBe(false);
      },
    );
    let settlementCount = 0;
    void boundary.outcome.then(() => {
      settlementCount++;
    });

    worker.emitMessage("completed");
    expect(boundary.cancel()).toBe(false);
    expect(controls).toBeDefined();

    await expect(boundary.outcome).resolves.toEqual({
      status: "completed",
      value: "completed",
    });
    await Promise.resolve();
    expect(settlementCount).toBe(1);
    expect(worker.terminationCount).toBe(1);
  });
});
