import type { PreparedImageDetailAnalysis } from "@harness/core";

import {
  copyDetailPreparationIdentity,
  detailPreparationIdentitiesEqual,
  isDetailPreparationRequest,
  isDetailPreparationWorkerMessage,
  type DetailPreparationIdentity,
  type DetailPreparationRequest,
} from "./detailPreparationProtocol";
import {
  createWorkerBoundary,
  workerErrorDetail,
  type WorkerBoundaryControls,
  type WorkerBoundaryFailure,
  type WorkerBoundaryOutcome,
  type WorkerBoundarySession,
  type WorkerFactory,
  type WorkerPort,
} from "./workerBoundary";

interface CancelledResult {
  readonly status: "cancelled";
  readonly jobId: number;
}

interface FailureResult {
  readonly status: "failure";
  readonly jobId: number;
  readonly error: string;
}

export type DetailPreparationResult =
  | {
      readonly status: "success";
      readonly jobId: number;
      readonly identity: DetailPreparationIdentity;
      readonly prepared: PreparedImageDetailAnalysis;
    }
  | CancelledResult
  | FailureResult;

export type DetailWorkerPort = WorkerPort<DetailPreparationRequest>;
export type DetailWorkerFactory = WorkerFactory<DetailPreparationRequest>;

interface ActiveJob {
  readonly jobId: number;
  readonly identity: DetailPreparationIdentity;
  boundary: WorkerBoundarySession<DetailPreparationResult> | null;
  cancelPending: boolean;
}

interface RemovableDetailWorker {
  removeEventListener(type: string, listener: EventListener): void;
}

function withSettlementRelease(
  worker: DetailWorkerPort,
  release: () => void,
): DetailWorkerPort & RemovableDetailWorker {
  const addEventListener = ((
    type: "message" | "error" | "messageerror",
    listener:
      | ((event: MessageEvent<unknown>) => void)
      | ((event: Event) => void),
  ) => {
    if (type === "message") {
      worker.addEventListener(
        type,
        listener as (event: MessageEvent<unknown>) => void,
      );
    } else {
      worker.addEventListener(type, listener as (event: Event) => void);
    }
  }) as DetailWorkerPort["addEventListener"];
  const removable = worker as DetailWorkerPort &
    Partial<RemovableDetailWorker>;

  return {
    postMessage: (message) => worker.postMessage(message),
    terminate: () => {
      release();
      worker.terminate();
    },
    addEventListener,
    removeEventListener: (type, listener) => {
      // A synchronous settlement can clean up before the boundary session is
      // returned. Release first so cleanup reentrancy sees the job as terminal.
      release();
      removable.removeEventListener?.(type, listener);
    },
  };
}

const DETAIL_BOUNDARY_FALLBACKS: Readonly<
  Record<WorkerBoundaryFailure["kind"], string>
> = {
  construction: "Detail worker failed",
  listener: "Detail worker could not start",
  "post-message": "Detail worker could not start",
  "worker-error": "Detail worker failed",
  "message-error": "Detail worker response could not be decoded",
  "invalid-message": "Detail worker returned an invalid response",
  "message-handler": "Detail worker failed",
};

const STRUCTURAL_BOUNDARY_FALLBACKS: Readonly<
  Record<WorkerBoundaryFailure["kind"], string>
> = {
  construction: "Worker construction failed",
  listener: "Worker listener registration failed",
  "post-message": "Worker request could not be posted",
  "worker-error": "Worker failed",
  "message-error": "Worker response could not be decoded",
  "invalid-message": "Worker returned an invalid response",
  "message-handler": "Worker message handler failed",
};

function detailBoundaryError(failure: WorkerBoundaryFailure): string {
  return failure.detail === STRUCTURAL_BOUNDARY_FALLBACKS[failure.kind]
    ? DETAIL_BOUNDARY_FALLBACKS[failure.kind]
    : failure.detail;
}

function failureResult(jobId: number, error: string): FailureResult {
  return {
    status: "failure",
    jobId,
    error:
      error.trim() === "" ? "Detail preparation failed" : error.slice(0, 500),
  };
}

/** Owns the independent one-worker-per-job Detail preparation lifecycle. */
export class DetailCoordinator {
  private nextJobId = 1;
  private active: ActiveJob | null = null;
  private disposed = false;

  constructor(private readonly workerFactory: DetailWorkerFactory) {}

  get busy(): boolean {
    return this.currentActive() !== null;
  }

  start(
    candidate: DetailPreparationIdentity,
  ): Promise<DetailPreparationResult> {
    if (this.disposed) {
      return Promise.reject(new Error("Detail coordinator is disposed"));
    }
    if (this.currentActive() !== null) {
      return Promise.reject(
        new Error("A Detail preparation job is already active"),
      );
    }

    const jobId = this.nextJobId++;
    let identity: DetailPreparationIdentity;
    try {
      identity = copyDetailPreparationIdentity(candidate);
    } catch (error) {
      return Promise.resolve({
        status: "failure",
        jobId,
        error: workerErrorDetail(
          error,
          "Detail preparation request is invalid",
        ),
      });
    }

    const request: DetailPreparationRequest = {
      type: "compute",
      jobId,
      identity,
    };
    if (!isDetailPreparationRequest(request)) {
      return Promise.resolve(
        failureResult(jobId, "Detail preparation request is invalid"),
      );
    }

    const active: ActiveJob = {
      jobId,
      identity,
      boundary: null,
      cancelPending: false,
    };
    this.active = active;

    const boundary = createWorkerBoundary<
      DetailPreparationRequest,
      DetailPreparationResult
    >({
      createWorker: () =>
        withSettlementRelease(this.workerFactory(), () =>
          this.release(active),
        ),
      request,
      onMessage: (message, controls) => {
        this.handleMessage(active, message, controls);
      },
    });
    active.boundary = boundary;
    if (active.cancelPending) boundary.cancel();
    if (!boundary.active) this.release(active);

    return boundary.outcome.then((outcome) => {
      this.release(active);
      if (active.cancelPending) {
        return { status: "cancelled", jobId };
      }
      return this.resultForOutcome(jobId, outcome);
    });
  }

  cancel(): boolean {
    const active = this.currentActive();
    if (active === null) return false;
    if (active.boundary === null) {
      active.cancelPending = true;
      this.release(active);
      return true;
    }
    const cancelled = active.boundary.cancel();
    if (cancelled) this.release(active);
    return cancelled;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cancel();
  }

  private handleMessage(
    active: ActiveJob,
    message: unknown,
    controls: WorkerBoundaryControls<DetailPreparationResult>,
  ): void {
    if (this.active !== active) return;
    if (!isDetailPreparationWorkerMessage(message)) {
      this.completeBoundary(active, () =>
        controls.rejectMessage(
          "Detail worker returned an invalid response",
        ),
      );
      return;
    }
    if (message.jobId !== active.jobId) return;
    if (
      !detailPreparationIdentitiesEqual(message.identity, active.identity)
    ) {
      return;
    }
    if (message.type === "failure") {
      this.completeBoundary(active, () =>
        controls.complete(failureResult(active.jobId, message.error)),
      );
      return;
    }
    this.completeBoundary(active, () =>
      controls.complete({
        status: "success",
        jobId: active.jobId,
        identity: active.identity,
        prepared: message.prepared,
      }),
    );
  }

  private completeBoundary(
    active: ActiveJob,
    complete: () => boolean,
  ): void {
    if (this.active !== active) return;
    this.release(active);
    complete();
  }

  private resultForOutcome(
    jobId: number,
    outcome: WorkerBoundaryOutcome<DetailPreparationResult>,
  ): DetailPreparationResult {
    if (outcome.status === "completed") return outcome.value;
    if (outcome.status === "cancelled") {
      return { status: "cancelled", jobId };
    }
    return failureResult(jobId, detailBoundaryError(outcome.failure));
  }

  private currentActive(): ActiveJob | null {
    const active = this.active;
    if (
      active !== null &&
      active.boundary !== null &&
      active.boundary.active === false
    ) {
      this.release(active);
      return null;
    }
    return active;
  }

  private release(active: ActiveJob): void {
    if (this.active === active) this.active = null;
  }
}
