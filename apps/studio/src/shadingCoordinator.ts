import type { Scene, ShadingDiagnostics, ShadingProgress } from "@harness/core";

import {
  isShadingWorkerMessage,
  shadingComputeIdentitiesEqual,
  type ShadingComputeIdentity,
  type ShadingComputeRequest,
} from "./shadingComputeProtocol";
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

export type ShadingComputeResult =
  | {
      readonly status: "success";
      readonly jobId: number;
      readonly identity: ShadingComputeIdentity;
      readonly scene: Scene;
      readonly diagnostics: ShadingDiagnostics;
      readonly computeTimeMs: number;
    }
  | CancelledResult
  | FailureResult;

export type ShadingWorkerPort = WorkerPort<ShadingComputeRequest>;
export type ShadingWorkerFactory = WorkerFactory<ShadingComputeRequest>;
export type ShadingMonotonicClock = () => number;

export interface ShadingProgressUpdate {
  readonly snapshot: ShadingProgress;
  readonly eta: RollingEtaEstimate;
}

export type ShadingProgressObserver = (
  update: ShadingProgressUpdate,
) => void;

interface ActiveJob {
  readonly jobId: number;
  readonly identity: ShadingComputeIdentity;
  readonly terminateWorker: () => void;
  readonly resolve: (result: ShadingComputeResult) => void;
  readonly observeProgress: ShadingProgressObserver | undefined;
  readonly capEta: RollingEtaEstimator;
  readonly convergenceEta: RollingEtaEstimator;
  etaRevision: number;
  lastProgress: ShadingProgress | null;
}

const defaultClock: ShadingMonotonicClock = () => performance.now();

function earliestEstimate(
  revision: number,
  estimates: readonly RollingEtaEstimate[],
): RollingEtaEstimate {
  let remainingMs = Number.POSITIVE_INFINITY;
  for (const estimate of estimates) {
    if (estimate.kind === "remaining") {
      remainingMs = Math.min(remainingMs, estimate.remainingMs);
    }
  }
  return Number.isFinite(remainingMs)
    ? { kind: "remaining", revision, remainingMs }
    : { kind: "estimating", revision };
}

/**
 * Owns the one-worker-per-job Shading compute lifecycle.
 *
 * Shading deliberately keeps a separate protocol and progress reducer from
 * Outline. Only the structural Worker boundary and rolling ETA primitives are
 * shared between the two coordinators.
 */
export class ShadingCoordinator {
  private nextJobId = 1;
  private active: ActiveJob | null = null;
  private disposed = false;

  constructor(
    private readonly workerFactory: ShadingWorkerFactory,
    private readonly clock: ShadingMonotonicClock = defaultClock,
  ) {}

  get busy(): boolean {
    return this.active !== null;
  }

  start(
    identity: ShadingComputeIdentity,
    observeProgress?: ShadingProgressObserver,
  ): Promise<ShadingComputeResult> {
    if (this.disposed) {
      return Promise.reject(new Error("Shading coordinator is disposed"));
    }
    if (this.active !== null) {
      return Promise.reject(new Error("A Shading job is already active"));
    }

    const jobId = this.nextJobId++;
    let worker: ShadingWorkerPort;
    try {
      worker = this.workerFactory();
    } catch (error) {
      return Promise.resolve({
        status: "failure",
        jobId,
        error: workerErrorDetail(error, "Shading worker failed"),
      });
    }

    return new Promise((resolve) => {
      const active: ActiveJob = {
        jobId,
        identity,
        terminateWorker: terminateWorkerOnce(worker),
        resolve,
        observeProgress,
        capEta: createRollingEtaEstimator(),
        convergenceEta: createRollingEtaEstimator(),
        etaRevision: 0,
        lastProgress: null,
      };
      this.active = active;

      try {
        worker.addEventListener("message", (event) => {
          if (this.active !== active) return;
          if (!isShadingWorkerMessage(event.data)) {
            this.fail(active, "Shading worker returned an invalid response");
            return;
          }
          if (event.data.jobId !== active.jobId) return;
          if (event.data.type === "progress") {
            this.reportProgress(active, event.data.snapshot);
            return;
          }
          if (
            !shadingComputeIdentitiesEqual(event.data.identity, active.identity)
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
            this.fail(active, workerEventDetail(event, "Shading worker failed"));
          }
        });
        worker.addEventListener("messageerror", () => {
          if (this.active === active) {
            this.fail(active, "Shading worker response could not be decoded");
          }
        });
        worker.postMessage({ type: "compute", jobId, identity });
      } catch (error) {
        this.fail(
          active,
          workerErrorDetail(error, "Shading worker could not start"),
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
    candidate: ShadingProgress,
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

    const snapshot = Object.freeze({ ...candidate });
    active.lastProgress = snapshot;
    const timestampMs = this.clock();
    const revision = ++active.etaRevision;
    const eta: RollingEtaEstimate = snapshot.terminal
      ? {
          kind: "remaining",
          revision,
          remainingMs: 0,
        }
      : earliestEstimate(revision, [
          active.capEta.observe({
            timestampMs,
            completedWork: snapshot.completedWorkUnits,
            totalWork: snapshot.totalWorkUnits,
          }),
          ...(snapshot.convergence === undefined
            ? []
            : [
                active.convergenceEta.observe({
                  timestampMs,
                  completedWork: snapshot.convergence,
                  totalWork: 1,
                }),
              ]),
        ]);
    try {
      active.observeProgress?.({ snapshot, eta });
    } catch {
      // Progress is observational: callback failures cannot own worker state.
    }
  }

  private fail(active: ActiveJob, error: string): void {
    this.finish(active, {
      status: "failure",
      jobId: active.jobId,
      error:
        error.trim() === ""
          ? "Shading computation failed"
          : error.slice(0, 500),
    });
  }

  private finish(active: ActiveJob, result: ShadingComputeResult): void {
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
