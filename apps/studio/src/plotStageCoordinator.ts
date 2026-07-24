import type { Scene } from "@harness/core";

import {
  createPlotStageWorker,
  type PlotStageWorkerFactory,
  type PlotStageWorkerPort,
} from "./createPlotStageWorker";
import {
  PLOT_STAGE_PREPARATION_ERROR_MAX_LENGTH,
  copyPlotStagePreparationIdentity,
  copyPlotStageRegistrationIdentity,
  isPlotStagePreparationRequest,
  isPlotStageWorkerMessage,
  plotStagePreparationIdentitiesEqual,
  plotStageRegistrationIdentitiesEqual,
  type PlotStagePreparationIdentity,
  type PlotStagePreparationRequest,
  type PlotStageRegistrationIdentity,
} from "./plotStagePreparationProtocol";
import {
  createWorkerBoundary,
  workerErrorDetail,
  type WorkerBoundaryControls,
  type WorkerBoundaryFailure,
  type WorkerBoundaryOutcome,
  type WorkerBoundarySession,
} from "./workerBoundary";

export interface PlotStagePreparationInput {
  readonly identity: PlotStagePreparationIdentity;
  readonly registrationIdentity: PlotStageRegistrationIdentity;
  readonly seed: PlotStagePreparationRequest["seed"];
  readonly sampledT: number;
}

interface CancelledResult {
  readonly status: "cancelled";
  readonly jobId: number;
}

interface FailureResult {
  readonly status: "failure";
  readonly jobId: number;
  readonly error: string;
}

export type PlotStagePreparationResult =
  | {
      readonly status: "success";
      readonly jobId: number;
      readonly identity: PlotStagePreparationIdentity;
      readonly registrationIdentity: PlotStageRegistrationIdentity;
      /** Ordinary unfinalized Stage geometry. */
      readonly scene: Scene;
    }
  | CancelledResult
  | FailureResult;

/**
 * The only progress ownership exposed by supporting Stage preparation.
 * Work is deliberately indeterminate, so no percentage or ETA is present.
 */
export interface PlotStagePreparingOwnership {
  readonly jobId: number;
  readonly stageId: string;
  readonly identity: PlotStagePreparationIdentity;
  readonly registrationIdentity: PlotStageRegistrationIdentity;
}

interface ActiveJob {
  readonly ownership: PlotStagePreparingOwnership;
  boundary: WorkerBoundarySession<PlotStagePreparationResult> | null;
  cancelPending: boolean;
}

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

const PLOT_STAGE_BOUNDARY_FALLBACKS: Readonly<
  Record<WorkerBoundaryFailure["kind"], string>
> = {
  construction: "Plot Stage worker failed",
  listener: "Plot Stage worker could not start",
  "post-message": "Plot Stage worker could not start",
  "worker-error": "Plot Stage worker failed",
  "message-error": "Plot Stage worker response could not be decoded",
  "invalid-message": "Plot Stage worker returned an invalid response",
  "message-handler": "Plot Stage worker failed",
};

function boundedFailure(error: string): string {
  const detail = error.trim();
  return detail === ""
    ? "Plot Stage preparation failed"
    : detail.slice(0, PLOT_STAGE_PREPARATION_ERROR_MAX_LENGTH);
}

function failureResult(jobId: number, error: string): FailureResult {
  return {
    status: "failure",
    jobId,
    error: boundedFailure(error),
  };
}

function boundaryFailureDetail(failure: WorkerBoundaryFailure): string {
  return failure.detail === STRUCTURAL_BOUNDARY_FALLBACKS[failure.kind]
    ? PLOT_STAGE_BOUNDARY_FALLBACKS[failure.kind]
    : failure.detail;
}

function createRequest(
  jobId: number,
  input: PlotStagePreparationInput,
): PlotStagePreparationRequest {
  const request: PlotStagePreparationRequest = Object.freeze({
    type: "compute",
    jobId,
    identity: copyPlotStagePreparationIdentity(input.identity),
    registrationIdentity: copyPlotStageRegistrationIdentity(
      input.registrationIdentity,
    ),
    seed: input.seed,
    sampledT: input.sampledT,
  });
  if (!isPlotStagePreparationRequest(request)) {
    throw new TypeError("Plot Stage preparation request is invalid");
  }
  return request;
}

/**
 * Owns one typed, one-worker-per-job supporting Plot Stage preparation.
 *
 * Stage instance identity is authoritative. Reusable generator identity never
 * participates in job ownership or response settlement.
 */
export class PlotStageCoordinator {
  private nextJobId = 1;
  private active: ActiveJob | null = null;
  private disposed = false;

  constructor(
    private readonly workerFactory: PlotStageWorkerFactory =
      createPlotStageWorker,
  ) {}

  get busy(): boolean {
    return this.currentActive() !== null;
  }

  get preparing(): PlotStagePreparingOwnership | null {
    return this.currentActive()?.ownership ?? null;
  }

  start(
    input: PlotStagePreparationInput,
  ): Promise<PlotStagePreparationResult> {
    if (this.disposed) {
      return Promise.reject(new Error("Plot Stage coordinator is disposed"));
    }
    if (this.currentActive() !== null) {
      return Promise.reject(
        new Error("A Plot Stage preparation job is already active"),
      );
    }

    const jobId = this.nextJobId++;
    let request: PlotStagePreparationRequest;
    try {
      request = createRequest(jobId, input);
    } catch (error) {
      return Promise.resolve(
        failureResult(
          jobId,
          workerErrorDetail(
            error,
            "Plot Stage preparation request is invalid",
          ),
        ),
      );
    }

    const ownership: PlotStagePreparingOwnership = Object.freeze({
      jobId,
      stageId: request.identity.stageId,
      identity: request.identity,
      registrationIdentity: request.registrationIdentity,
    });
    const active: ActiveJob = {
      ownership,
      boundary: null,
      cancelPending: false,
    };
    this.active = active;

    const boundary = createWorkerBoundary<
      PlotStagePreparationRequest,
      PlotStagePreparationResult
    >({
      createWorker: this.workerFactory,
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
    controls: WorkerBoundaryControls<PlotStagePreparationResult>,
  ): void {
    if (this.active !== active) return;
    if (!isPlotStageWorkerMessage(message)) {
      controls.rejectMessage("Plot Stage worker returned an invalid response");
      this.release(active);
      return;
    }
    if (
      message.jobId !== active.ownership.jobId ||
      message.identity.stageId !== active.ownership.stageId ||
      !plotStagePreparationIdentitiesEqual(
        message.identity,
        active.ownership.identity,
      ) ||
      !plotStageRegistrationIdentitiesEqual(
        message.registrationIdentity,
        active.ownership.registrationIdentity,
      )
    ) {
      return;
    }

    if (message.type === "failure") {
      this.complete(
        active,
        controls,
        failureResult(active.ownership.jobId, message.error),
      );
      return;
    }
    this.complete(active, controls, {
      status: "success",
      jobId: active.ownership.jobId,
      identity: active.ownership.identity,
      registrationIdentity: active.ownership.registrationIdentity,
      scene: message.scene,
    });
  }

  private complete(
    active: ActiveJob,
    controls: WorkerBoundaryControls<PlotStagePreparationResult>,
    result: PlotStagePreparationResult,
  ): void {
    if (controls.complete(result)) this.release(active);
  }

  private resultForOutcome(
    jobId: number,
    outcome: WorkerBoundaryOutcome<PlotStagePreparationResult>,
  ): PlotStagePreparationResult {
    if (outcome.status === "completed") return outcome.value;
    if (outcome.status === "cancelled") {
      return { status: "cancelled", jobId };
    }
    return failureResult(jobId, boundaryFailureDetail(outcome.failure));
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

export type { PlotStageWorkerFactory, PlotStageWorkerPort };
