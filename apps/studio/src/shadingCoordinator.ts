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
  createWorkerBoundary,
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
  readonly observeProgress: ShadingProgressObserver | undefined;
  readonly capEta: RollingEtaEstimator;
  readonly convergenceEta: RollingEtaEstimator;
  boundary: WorkerBoundarySession<ShadingComputeResult> | null;
  cancelDuringMessage: (() => boolean) | null;
  etaRevision: number;
  lastProgress: ShadingProgress | null;
}

const defaultClock: ShadingMonotonicClock = () => performance.now();

const SHADING_BOUNDARY_FALLBACKS: Readonly<
  Record<WorkerBoundaryFailure["kind"], string>
> = {
  construction: "Shading worker failed",
  listener: "Shading worker could not start",
  "post-message": "Shading worker could not start",
  "worker-error": "Shading worker failed",
  "message-error": "Shading worker response could not be decoded",
  "invalid-message": "Shading worker returned an invalid response",
  "message-handler": "Shading worker failed",
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

function shadingFailureDetail(failure: WorkerBoundaryFailure): string {
  return failure.detail === STRUCTURAL_BOUNDARY_FALLBACKS[failure.kind]
    ? SHADING_BOUNDARY_FALLBACKS[failure.kind]
    : failure.detail;
}

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
    const active = this.active;
    return (
      active !== null &&
      (active.boundary === null || active.boundary.active)
    );
  }

  start(
    identity: ShadingComputeIdentity,
    observeProgress?: ShadingProgressObserver,
  ): Promise<ShadingComputeResult> {
    if (this.disposed) {
      return Promise.reject(new Error("Shading coordinator is disposed"));
    }
    if (this.busy) {
      return Promise.reject(new Error("A Shading job is already active"));
    }

    const jobId = this.nextJobId++;
    const active: ActiveJob = {
      jobId,
      identity,
      observeProgress,
      capEta: createRollingEtaEstimator(),
      convergenceEta: createRollingEtaEstimator(),
      boundary: null,
      cancelDuringMessage: null,
      etaRevision: 0,
      lastProgress: null,
    };
    this.active = active;

    const boundary = createWorkerBoundary<
      ShadingComputeRequest,
      ShadingComputeResult
    >({
      createWorker: this.workerFactory,
      request: { type: "compute", jobId, identity },
      onMessage: (message, controls) => {
        if (this.active !== active) return;
        active.cancelDuringMessage = () =>
          controls.complete({ status: "cancelled", jobId });
        try {
          this.handleMessage(active, message, controls);
        } finally {
          active.cancelDuringMessage = null;
        }
      },
    });
    active.boundary = boundary;

    if (!boundary.active && this.active === active) {
      this.active = null;
    }
    return boundary.outcome.then((outcome) => {
      if (this.active === active) this.active = null;
      return this.resultForOutcome(jobId, outcome);
    });
  }

  cancel(): boolean {
    const active = this.active;
    if (active === null) return false;
    const cancelled =
      active.cancelDuringMessage?.() ?? active.boundary?.cancel() ?? false;
    if (cancelled && this.active === active) this.active = null;
    return cancelled;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cancel();
  }

  private reportProgress(
    active: ActiveJob,
    candidate: ShadingProgress,
    controls: WorkerBoundaryControls<ShadingComputeResult>,
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
    controls.observe(() => {
      active.observeProgress?.({ snapshot, eta });
    });
  }

  private failureResult(active: ActiveJob, error: string): FailureResult {
    return {
      status: "failure",
      jobId: active.jobId,
      error:
        error.trim() === ""
          ? "Shading computation failed"
          : error.slice(0, 500),
    };
  }

  private handleMessage(
    active: ActiveJob,
    message: unknown,
    controls: WorkerBoundaryControls<ShadingComputeResult>,
  ): void {
    if (!isShadingWorkerMessage(message)) {
      controls.rejectMessage("Shading worker returned an invalid response");
      return;
    }
    if (message.jobId !== active.jobId) return;
    if (message.type === "progress") {
      this.reportProgress(active, message.snapshot, controls);
      return;
    }
    if (!shadingComputeIdentitiesEqual(message.identity, active.identity)) {
      return;
    }
    if (message.type === "failure") {
      controls.complete(this.failureResult(active, message.error));
      return;
    }
    controls.complete({
      status: "success",
      jobId: active.jobId,
      identity: active.identity,
      scene: message.scene,
      diagnostics: message.diagnostics,
      computeTimeMs: message.computeTimeMs,
    });
  }

  private resultForOutcome(
    jobId: number,
    outcome: WorkerBoundaryOutcome<ShadingComputeResult>,
  ): ShadingComputeResult {
    if (outcome.status === "completed") return outcome.value;
    if (outcome.status === "cancelled") {
      return { status: "cancelled", jobId };
    }
    return {
      status: "failure",
      jobId,
      error: shadingFailureDetail(outcome.failure),
    };
  }
}
