import type { Scene, ScribbleDiagnostics, ScribbleProgress } from "@harness/core";

import {
  isScribbleWorkerMessage,
  scribbleComputeIdentitiesEqual,
  type ScribbleComputeIdentity,
  type ScribbleComputeRequest,
} from "./scribbleComputeProtocol";
import {
  createRollingEtaEstimator,
  type RollingEtaEstimate,
  type RollingEtaEstimator,
} from "./rollingEta";
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

export type ScribbleComputeResult =
  | {
      readonly status: "success";
      readonly jobId: number;
      readonly identity: ScribbleComputeIdentity;
      readonly scene: Scene;
      readonly diagnostics: ScribbleDiagnostics;
      readonly computeTimeMs: number;
    }
  | CancelledResult
  | FailureResult;

export type ScribbleWorkerPort = WorkerPort<ScribbleComputeRequest>;
export type ScribbleWorkerFactory = WorkerFactory<ScribbleComputeRequest>;
export type ScribbleMonotonicClock = () => number;

export interface ScribbleProgressUpdate {
  readonly snapshot: ScribbleProgress;
  readonly eta: RollingEtaEstimate;
}

export type ScribbleProgressObserver = (
  update: ScribbleProgressUpdate,
) => void;

interface ActiveJob {
  readonly jobId: number;
  readonly identity: ScribbleComputeIdentity;
  readonly terminateWorker: () => void;
  readonly resolve: (result: ScribbleComputeResult) => void;
  readonly observeProgress: ScribbleProgressObserver | undefined;
  readonly eta: RollingEtaEstimator;
  lastProgress: ScribbleProgress | null;
}

const defaultClock: ScribbleMonotonicClock = () => performance.now();

/**
 * Owns the one-worker-per-job Scribble compute lifecycle.
 *
 * Scribble deliberately keeps a separate protocol and progress reducer from
 * Outline. Only the structural Worker boundary and rolling ETA primitives are
 * shared between the two coordinators.
 */
export class ScribbleCoordinator {
  private nextJobId = 1;
  private active: ActiveJob | null = null;
  private disposed = false;

  constructor(
    private readonly workerFactory: ScribbleWorkerFactory,
    private readonly clock: ScribbleMonotonicClock = defaultClock,
  ) {}

  get busy(): boolean {
    return this.active !== null;
  }

  start(
    identity: ScribbleComputeIdentity,
    observeProgress?: ScribbleProgressObserver,
  ): Promise<ScribbleComputeResult> {
    if (this.disposed) {
      return Promise.reject(new Error("Scribble coordinator is disposed"));
    }
    if (this.active !== null) {
      return Promise.reject(new Error("A Scribble job is already active"));
    }

    const jobId = this.nextJobId++;
    let worker: ScribbleWorkerPort;
    try {
      worker = this.workerFactory();
    } catch (error) {
      return Promise.resolve({
        status: "failure",
        jobId,
        error: workerErrorDetail(error, "Scribble worker failed"),
      });
    }

    return new Promise((resolve) => {
      const active: ActiveJob = {
        jobId,
        identity,
        terminateWorker: terminateWorkerOnce(worker),
        resolve,
        observeProgress,
        eta: createRollingEtaEstimator(),
        lastProgress: null,
      };
      this.active = active;

      try {
        worker.addEventListener("message", (event) => {
          if (this.active !== active) return;
          if (!isScribbleWorkerMessage(event.data)) {
            this.fail(active, "Scribble worker returned an invalid response");
            return;
          }
          if (event.data.jobId !== active.jobId) return;
          if (event.data.type === "progress") {
            this.reportProgress(active, event.data.snapshot);
            return;
          }
          if (
            !scribbleComputeIdentitiesEqual(event.data.identity, active.identity)
          ) {
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
            diagnostics: event.data.diagnostics,
            computeTimeMs: event.data.computeTimeMs,
          });
        });
        worker.addEventListener("error", (event) => {
          if (this.active === active) {
            this.fail(active, workerEventDetail(event, "Scribble worker failed"));
          }
        });
        worker.addEventListener("messageerror", () => {
          if (this.active === active) {
            this.fail(active, "Scribble worker response could not be decoded");
          }
        });
        worker.postMessage({ type: "compute", jobId, identity });
      } catch (error) {
        this.fail(
          active,
          workerErrorDetail(error, "Scribble worker could not start"),
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

  private reportProgress(
    active: ActiveJob,
    candidate: ScribbleProgress,
  ): void {
    const previous = active.lastProgress;
    if (
      previous?.terminal === true ||
      (previous !== null &&
        (candidate.totalWorkUnits !== previous.totalWorkUnits ||
          candidate.completedWorkUnits < previous.completedWorkUnits ||
          (candidate.convergence !== undefined &&
            previous.convergence !== undefined &&
            candidate.convergence < previous.convergence) ||
          (candidate.completedWorkUnits === previous.completedWorkUnits &&
            !candidate.terminal)))
    ) {
      return;
    }

    const snapshot = { ...candidate };
    active.lastProgress = snapshot;
    const timestampMs = this.clock();
    const eta: RollingEtaEstimate = snapshot.terminal
      ? {
          kind: "remaining",
          revision: active.eta.estimate.revision + 1,
          remainingMs: 0,
        }
      : active.eta.observe({
          timestampMs,
          // Scribble normally stops at its residual threshold, long before its
          // emergency work cap. Legacy/custom snapshots can still use cap work.
          completedWork:
            snapshot.convergence ?? snapshot.completedWorkUnits,
          totalWork:
            snapshot.convergence === undefined ? snapshot.totalWorkUnits : 1,
        });
    active.observeProgress?.({ snapshot, eta });
  }

  private fail(active: ActiveJob, error: string): void {
    this.finish(active, {
      status: "failure",
      jobId: active.jobId,
      error:
        error.trim() === ""
          ? "Scribble computation failed"
          : error.slice(0, 500),
    });
  }

  private finish(active: ActiveJob, result: ScribbleComputeResult): void {
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
