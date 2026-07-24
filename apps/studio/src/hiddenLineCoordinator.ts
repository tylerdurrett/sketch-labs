import type { HiddenLineProgress, Scene } from "@harness/core";

import { createOutlineWorker } from "./createOutlineWorker";
import {
  isHiddenLineWorkerMessage,
  isOutlineComputeProgress,
  isOutlineComputeResponse,
  outlineComputeIdentitiesEqual,
  type CompletedOutline,
  type HiddenLineExportSnapshot,
  type HiddenLineJobKind,
  type HiddenLineJobOwner,
  type HiddenLineWorkerRequest,
  type OutlineComputeIdentity,
  type OutlineComputeRequest,
} from "./outlineComputeProtocol";
import {
  createRollingEtaEstimator,
  type RollingEtaEstimate,
  type RollingEtaEstimator,
} from "./rollingEta";
import {
  createWorkerBoundary,
  type WorkerBoundaryControls,
  type WorkerBoundaryFailure,
  type WorkerBoundarySession,
  type WorkerFactory,
  type WorkerPort,
} from "./workerBoundary";

interface CancelledResult {
  status: "cancelled";
  jobId: number;
}

interface FailureResult {
  status: "failure";
  jobId: number;
  error: string;
}

export type HiddenLineComputeResult =
  | {
      status: "success";
      jobId: number;
      identity: OutlineComputeIdentity;
      scene: Scene;
    }
  | CancelledResult
  | FailureResult;

export type HiddenLineExportResult =
  | {
      status: "success";
      jobId: number;
      identity: OutlineComputeIdentity;
      svg: string;
      filename: string;
      completedOutline: CompletedOutline;
    }
  | CancelledResult
  | FailureResult;

type HiddenLineJobResult = HiddenLineComputeResult | HiddenLineExportResult;

export type OutlineWorkerPort = WorkerPort<
  HiddenLineWorkerRequest | OutlineComputeRequest
>;
export type OutlineWorkerFactory = WorkerFactory<
  HiddenLineWorkerRequest | OutlineComputeRequest
>;
export type MonotonicClock = () => number;

export interface HiddenLineProgressUpdate {
  readonly snapshot: HiddenLineProgress;
  readonly eta: RollingEtaEstimate;
}

export type HiddenLineProgressObserver = (
  update: HiddenLineProgressUpdate,
) => void;

export type HiddenLineExportProgressUpdate =
  | ({ readonly phase: "derivation" } & HiddenLineProgressUpdate)
  | { readonly phase: "finalizing" };

export type HiddenLineExportProgressObserver = (
  update: HiddenLineExportProgressUpdate,
) => void;

interface ActiveJob {
  readonly jobId: number;
  readonly jobKind: HiddenLineJobKind;
  readonly owner: HiddenLineJobOwner;
  readonly identity: OutlineComputeIdentity;
  readonly observeProgress:
    | HiddenLineProgressObserver
    | HiddenLineExportProgressObserver
    | undefined;
  readonly eta: RollingEtaEstimator;
  boundary: WorkerBoundarySession<HiddenLineJobResult> | null;
  cancelPending: boolean;
  lastProgress: HiddenLineProgress | null;
  finalizing: boolean;
}

const defaultClock: MonotonicClock = () => performance.now();

function ownerFor(jobKind: HiddenLineJobKind): HiddenLineJobOwner {
  return jobKind === "preview" ? "outline-preview" : "hidden-line-export";
}

const SHARED_FAILURE_FALLBACKS: Readonly<
  Partial<Record<WorkerBoundaryFailure["kind"], string>>
> = {
  construction: "Worker construction failed",
  listener: "Worker listener registration failed",
  "post-message": "Worker request could not be posted",
  "worker-error": "Worker failed",
  "message-error": "Worker response could not be decoded",
};

const OUTLINE_FAILURE_FALLBACKS: Readonly<
  Partial<Record<WorkerBoundaryFailure["kind"], string>>
> = {
  construction: "Outline worker failed",
  listener: "Outline worker could not start",
  "post-message": "Outline worker could not start",
  "worker-error": "Outline worker failed",
  "message-error": "Outline worker response could not be decoded",
};

function outlineBoundaryError(failure: WorkerBoundaryFailure): string {
  return failure.detail === SHARED_FAILURE_FALLBACKS[failure.kind]
    ? (OUTLINE_FAILURE_FALLBACKS[failure.kind] ?? failure.detail)
    : failure.detail;
}

function failureResult(jobId: number, error: string): FailureResult {
  return {
    status: "failure",
    jobId,
    error:
      error.trim() === "" ? "Outline computation failed" : error.slice(0, 500),
  };
}

export class HiddenLineCoordinator {
  private nextJobId = 1;
  private active: ActiveJob | null = null;
  private disposed = false;

  constructor(
    private readonly workerFactory: OutlineWorkerFactory = createOutlineWorker,
    private readonly clock: MonotonicClock = defaultClock,
  ) {}

  get busy(): boolean {
    return this.currentActive() !== null;
  }

  /** Compatibility entry point for the existing Outline preview session. */
  start(
    identity: OutlineComputeIdentity,
    observeProgress?: HiddenLineProgressObserver,
  ): Promise<HiddenLineComputeResult> {
    return this.startOutline(identity, observeProgress);
  }

  startOutline(
    identity: OutlineComputeIdentity,
    observeProgress?: HiddenLineProgressObserver,
  ): Promise<HiddenLineComputeResult> {
    const request = (jobId: number): OutlineComputeRequest => ({
      type: "compute",
      jobId,
      identity,
    });
    return this.startJob(
      "preview",
      identity,
      request,
      observeProgress,
    ) as Promise<HiddenLineComputeResult>;
  }

  startExport(
    snapshot: HiddenLineExportSnapshot,
    observeProgress?: HiddenLineExportProgressObserver,
  ): Promise<HiddenLineExportResult> {
    const request = (jobId: number): HiddenLineWorkerRequest => ({
      type: "export",
      jobKind: "export",
      owner: "hidden-line-export",
      jobId,
      snapshot,
    });
    return this.startJob(
      "export",
      snapshot.identity,
      request,
      observeProgress,
    ) as Promise<HiddenLineExportResult>;
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

  private startJob(
    jobKind: HiddenLineJobKind,
    identity: OutlineComputeIdentity,
    createRequest: (
      jobId: number,
    ) => HiddenLineWorkerRequest | OutlineComputeRequest,
    observeProgress:
      | HiddenLineProgressObserver
      | HiddenLineExportProgressObserver
      | undefined,
  ): Promise<HiddenLineJobResult> {
    if (this.disposed) {
      return Promise.reject(new Error("Hidden-line coordinator is disposed"));
    }
    if (this.currentActive() !== null) {
      return Promise.reject(new Error("A hidden-line job is already active"));
    }

    const jobId = this.nextJobId++;
    const active: ActiveJob = {
      jobId,
      jobKind,
      owner: ownerFor(jobKind),
      identity,
      observeProgress,
      eta: createRollingEtaEstimator(),
      boundary: null,
      cancelPending: false,
      lastProgress: null,
      finalizing: false,
    };
    this.active = active;

    const boundary = createWorkerBoundary<
      HiddenLineWorkerRequest | OutlineComputeRequest,
      HiddenLineJobResult
    >({
      createWorker: this.workerFactory,
      request: createRequest(jobId),
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
      if (outcome.status === "completed") return outcome.value;
      if (outcome.status === "cancelled") {
        return { status: "cancelled", jobId };
      }
      return failureResult(jobId, outlineBoundaryError(outcome.failure));
    });
  }

  private handleMessage(
    active: ActiveJob,
    message: unknown,
    controls: WorkerBoundaryControls<HiddenLineJobResult>,
  ): void {
    if (this.active !== active) return;
    if (active.jobKind === "preview") {
      if (isOutlineComputeProgress(message)) {
        if (message.jobId === active.jobId) {
          this.reportProgress(active, message.snapshot, controls);
        }
        return;
      }
      if (isOutlineComputeResponse(message)) {
        if (
          message.jobId !== active.jobId ||
          !outlineComputeIdentitiesEqual(message.identity, active.identity)
        ) {
          return;
        }
        if (message.type === "failure") {
          this.complete(
            active,
            controls,
            failureResult(active.jobId, message.error),
          );
        } else {
          this.complete(active, controls, {
            status: "success",
            jobId: active.jobId,
            identity: active.identity,
            scene: message.scene,
          });
        }
        return;
      }
    }
    if (!isHiddenLineWorkerMessage(message)) {
      controls.rejectMessage("Outline worker returned an invalid response");
      this.release(active);
      return;
    }
    if (
      message.jobId !== active.jobId ||
      message.jobKind !== active.jobKind ||
      message.owner !== active.owner
    ) {
      return;
    }
    if (message.type === "derivation-progress") {
      this.reportProgress(active, message.snapshot, controls);
      return;
    }
    if (message.type === "finalizing") {
      this.reportFinalizing(active, controls);
      return;
    }
    if (!outlineComputeIdentitiesEqual(message.identity, active.identity)) {
      return;
    }
    if (message.type === "failure") {
      this.complete(
        active,
        controls,
        failureResult(active.jobId, message.error),
      );
      return;
    }
    if (message.jobKind === "preview") {
      this.complete(active, controls, {
        status: "success",
        jobId: active.jobId,
        identity: active.identity,
        scene: message.scene,
      });
      return;
    }
    this.complete(active, controls, {
      status: "success",
      jobId: active.jobId,
      identity: active.identity,
      svg: message.svg,
      filename: message.filename,
      completedOutline: message.completedOutline,
    });
  }

  private reportProgress(
    active: ActiveJob,
    candidate: HiddenLineProgress,
    controls: WorkerBoundaryControls<HiddenLineJobResult>,
  ): void {
    const previous = active.lastProgress;
    if (
      active.finalizing ||
      (previous !== null &&
        (candidate.totalWorkUnits !== previous.totalWorkUnits ||
          candidate.completedWorkUnits <= previous.completedWorkUnits))
    ) {
      return;
    }

    const snapshot = { ...candidate };
    active.lastProgress = snapshot;
    const eta = active.eta.observe({
      timestampMs: this.clock(),
      completedWork: snapshot.completedWorkUnits,
      totalWork: snapshot.totalWorkUnits,
    });
    if (active.jobKind === "preview") {
      const observer = active.observeProgress as
        | HiddenLineProgressObserver
        | undefined;
      controls.observe(() => observer?.({ snapshot, eta }));
    } else {
      const observer = active.observeProgress as
        | HiddenLineExportProgressObserver
        | undefined;
      controls.observe(() =>
        observer?.({
          phase: "derivation",
          snapshot,
          eta,
        }),
      );
    }
  }

  private reportFinalizing(
    active: ActiveJob,
    controls: WorkerBoundaryControls<HiddenLineJobResult>,
  ): void {
    if (active.jobKind !== "export" || active.finalizing) return;
    active.finalizing = true;
    const observer = active.observeProgress as
      | HiddenLineExportProgressObserver
      | undefined;
    controls.observe(() => observer?.({ phase: "finalizing" }));
  }

  private complete(
    active: ActiveJob,
    controls: WorkerBoundaryControls<HiddenLineJobResult>,
    result: HiddenLineJobResult,
  ): void {
    if (controls.complete(result)) this.release(active);
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
