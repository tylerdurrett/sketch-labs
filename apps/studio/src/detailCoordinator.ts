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
  terminateWorkerOnce,
  workerErrorDetail,
  workerEventDetail,
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
  readonly terminateWorker: () => void;
  readonly resolve: (result: DetailPreparationResult) => void;
}

/** Owns the independent one-worker-per-job Detail preparation lifecycle. */
export class DetailCoordinator {
  private nextJobId = 1;
  private active: ActiveJob | null = null;
  private disposed = false;

  constructor(private readonly workerFactory: DetailWorkerFactory) {}

  get busy(): boolean {
    return this.active !== null;
  }

  start(
    candidate: DetailPreparationIdentity,
  ): Promise<DetailPreparationResult> {
    if (this.disposed) {
      return Promise.reject(new Error("Detail coordinator is disposed"));
    }
    if (this.active !== null) {
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

    let worker: DetailWorkerPort;
    try {
      worker = this.workerFactory();
    } catch (error) {
      return Promise.resolve({
        status: "failure",
        jobId,
        error: workerErrorDetail(error, "Detail worker failed"),
      });
    }

    return new Promise((resolve) => {
      const active: ActiveJob = {
        jobId,
        identity,
        terminateWorker: terminateWorkerOnce(worker),
        resolve,
      };
      this.active = active;

      try {
        worker.addEventListener("message", (event) => {
          if (this.active !== active) return;
          if (!isDetailPreparationWorkerMessage(event.data)) {
            this.fail(active, "Detail worker returned an invalid response");
            return;
          }
          if (event.data.jobId !== active.jobId) return;
          if (
            !detailPreparationIdentitiesEqual(
              event.data.identity,
              active.identity,
            )
          ) {
            return;
          }
          if (event.data.type === "failure") {
            this.fail(active, event.data.error);
            return;
          }
          this.finish(active, {
            status: "success",
            jobId: active.jobId,
            identity: active.identity,
            prepared: event.data.prepared,
          });
        });
        worker.addEventListener("error", (event) => {
          if (this.active === active) {
            this.fail(active, workerEventDetail(event, "Detail worker failed"));
          }
        });
        worker.addEventListener("messageerror", () => {
          if (this.active === active) {
            this.fail(active, "Detail worker response could not be decoded");
          }
        });

        const request: DetailPreparationRequest = {
          type: "compute",
          jobId,
          identity,
        };
        if (!isDetailPreparationRequest(request)) {
          throw new TypeError("Detail preparation request is invalid");
        }
        worker.postMessage(request);
      } catch (error) {
        this.fail(
          active,
          workerErrorDetail(error, "Detail worker could not start"),
        );
      }
    });
  }

  cancel(): boolean {
    const active = this.active;
    if (active === null) return false;
    this.finish(active, { status: "cancelled", jobId: active.jobId });
    return true;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cancel();
  }

  private fail(active: ActiveJob, error: string): void {
    this.finish(active, {
      status: "failure",
      jobId: active.jobId,
      error:
        error.trim() === "" ? "Detail preparation failed" : error.slice(0, 500),
    });
  }

  private finish(active: ActiveJob, result: DetailPreparationResult): void {
    if (this.active !== active) return;
    this.active = null;
    try {
      active.terminateWorker();
    } catch {
      // Worker termination is best-effort; the typed outcome must still settle.
    }
    active.resolve(result);
  }
}
