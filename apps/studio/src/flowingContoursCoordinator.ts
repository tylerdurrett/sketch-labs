import type { Scene } from "@harness/core";

import {
  flowingContoursComputeIdentitiesEqual,
  isFlowingContoursComputeResponse,
  type FlowingContoursComputeIdentity,
  type FlowingContoursComputeRequest,
} from "./flowingContoursComputeProtocol";
import {
  terminateWorkerOnce,
  workerErrorDetail,
  workerEventDetail,
  type WorkerFactory,
  type WorkerPort,
} from "./workerBoundary";

export type FlowingContoursComputeResult =
  | {
      readonly status: "success";
      readonly jobId: number;
      readonly identity: FlowingContoursComputeIdentity;
      readonly scene: Scene;
      readonly computeTimeMs: number;
    }
  | { readonly status: "cancelled"; readonly jobId: number }
  | {
      readonly status: "failure";
      readonly jobId: number;
      readonly error: string;
    };

export type FlowingContoursWorkerPort =
  WorkerPort<FlowingContoursComputeRequest>;
export type FlowingContoursWorkerFactory =
  WorkerFactory<FlowingContoursComputeRequest>;

interface ActiveJob {
  readonly jobId: number;
  readonly identity: FlowingContoursComputeIdentity;
  readonly terminateWorker: () => void;
  readonly resolve: (result: FlowingContoursComputeResult) => void;
}

/** Owns exactly one fresh module Worker for each Flowing Contours job. */
export class FlowingContoursCoordinator {
  private nextJobId = 1;
  private active: ActiveJob | null = null;
  private disposed = false;

  constructor(private readonly workerFactory: FlowingContoursWorkerFactory) {}

  get busy(): boolean {
    return this.active !== null;
  }

  start(
    identity: FlowingContoursComputeIdentity,
  ): Promise<FlowingContoursComputeResult> {
    if (this.disposed) {
      return Promise.reject(
        new Error("Flowing Contours coordinator is disposed"),
      );
    }
    if (this.active !== null) {
      return Promise.reject(
        new Error("A Flowing Contours job is already active"),
      );
    }

    const jobId = this.nextJobId++;
    let worker: FlowingContoursWorkerPort;
    try {
      worker = this.workerFactory();
    } catch (error) {
      return Promise.resolve({
        status: "failure",
        jobId,
        error: workerErrorDetail(error, "Flowing Contours worker failed"),
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
          if (!isFlowingContoursComputeResponse(event.data)) {
            this.fail(
              active,
              "Flowing Contours worker returned an invalid response",
            );
            return;
          }
          if (event.data.jobId !== active.jobId) {
            this.fail(
              active,
              "Flowing Contours worker returned the wrong job id",
            );
            return;
          }
          if (
            !flowingContoursComputeIdentitiesEqual(
              event.data.identity,
              active.identity,
            )
          ) {
            this.fail(
              active,
              "Flowing Contours worker returned the wrong identity",
            );
            return;
          }
          if (event.data.type === "failure") {
            this.fail(active, event.data.error);
            return;
          }
          this.finish(active, {
            status: "success",
            jobId,
            identity,
            scene: event.data.scene,
            computeTimeMs: event.data.computeTimeMs,
          });
        });
        worker.addEventListener("error", (event) => {
          if (this.active === active) {
            this.fail(
              active,
              workerEventDetail(event, "Flowing Contours worker failed"),
            );
          }
        });
        worker.addEventListener("messageerror", () => {
          if (this.active === active) {
            this.fail(
              active,
              "Flowing Contours worker response could not be decoded",
            );
          }
        });
        worker.postMessage({ type: "compute", jobId, identity });
      } catch (error) {
        this.fail(
          active,
          workerErrorDetail(
            error,
            "Flowing Contours worker could not start",
          ),
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
        error.trim() === ""
          ? "Flowing Contours computation failed"
          : error.slice(0, 500),
    });
  }

  private finish(
    active: ActiveJob,
    result: FlowingContoursComputeResult,
  ): void {
    if (this.active !== active) return;
    this.active = null;
    try {
      active.terminateWorker();
    } catch {
      // Termination is best-effort; the typed outcome still settles.
    }
    active.resolve(result);
  }
}
