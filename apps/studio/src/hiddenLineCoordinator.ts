import type { HiddenLineProgress, Scene } from "@harness/core";

import { createOutlineWorker } from "./createOutlineWorker";
import {
  isOutlineComputeProgress,
  isOutlineComputeResponse,
  outlineComputeIdentitiesEqual,
  type OutlineComputeIdentity,
  type OutlineComputeRequest,
} from "./outlineComputeProtocol";
import {
  createRollingEtaEstimator,
  type RollingEtaEstimate,
  type RollingEtaEstimator,
} from "./rollingEta";

export type HiddenLineComputeResult =
  | {
      status: "success";
      jobId: number;
      identity: OutlineComputeIdentity;
      scene: Scene;
    }
  | { status: "cancelled"; jobId: number }
  | { status: "failure"; jobId: number; error: string };

export interface OutlineWorkerPort {
  postMessage(message: OutlineComputeRequest): void;
  terminate(): void;
  addEventListener(
    type: "message",
    listener: (event: MessageEvent<unknown>) => void,
  ): void;
  addEventListener(
    type: "error" | "messageerror",
    listener: (event: Event) => void,
  ): void;
}

export type OutlineWorkerFactory = () => OutlineWorkerPort;
export type MonotonicClock = () => number;

export interface HiddenLineProgressUpdate {
  readonly snapshot: HiddenLineProgress;
  readonly eta: RollingEtaEstimate;
}

export type HiddenLineProgressObserver = (
  update: HiddenLineProgressUpdate,
) => void;

interface ActiveJob {
  jobId: number;
  identity: OutlineComputeIdentity;
  worker: OutlineWorkerPort;
  resolve: (result: HiddenLineComputeResult) => void;
  observeProgress: HiddenLineProgressObserver | undefined;
  eta: RollingEtaEstimator;
  lastProgress: HiddenLineProgress | null;
}

const defaultClock: MonotonicClock = () => performance.now();

function eventDetail(event: Event): string {
  const message = (event as Event & { message?: unknown }).message;
  if (typeof message === "string" && message.trim() !== "") {
    return message.slice(0, 500);
  }
  return "Outline worker failed";
}

function errorDetail(error: unknown): string {
  return error instanceof Error && error.message.trim() !== ""
    ? error.message.slice(0, 500)
    : "Outline worker failed";
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
    return this.active !== null;
  }

  start(
    identity: OutlineComputeIdentity,
    observeProgress?: HiddenLineProgressObserver,
  ): Promise<HiddenLineComputeResult> {
    if (this.disposed) {
      return Promise.reject(new Error("Hidden-line coordinator is disposed"));
    }
    if (this.active !== null) {
      return Promise.reject(new Error("A hidden-line job is already active"));
    }

    const jobId = this.nextJobId++;
    let worker: OutlineWorkerPort;
    try {
      worker = this.workerFactory();
    } catch (error) {
      return Promise.resolve({
        status: "failure",
        jobId,
        error: errorDetail(error),
      });
    }

    return new Promise((resolve) => {
      const active: ActiveJob = {
        jobId,
        identity,
        worker,
        resolve,
        observeProgress,
        eta: createRollingEtaEstimator(),
        lastProgress: null,
      };
      this.active = active;

      worker.addEventListener("message", (event) => {
        if (this.active !== active) return;
        if (isOutlineComputeProgress(event.data)) {
          if (event.data.jobId === jobId) {
            this.reportProgress(active, event.data.snapshot);
          }
          return;
        }
        if (!isOutlineComputeResponse(event.data)) {
          this.fail(active, "Outline worker returned an invalid response");
          return;
        }
        if (
          event.data.jobId !== jobId ||
          !outlineComputeIdentitiesEqual(event.data.identity, identity)
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
        });
      });
      worker.addEventListener("error", (event) => {
        if (this.active === active) this.fail(active, eventDetail(event));
      });
      worker.addEventListener("messageerror", () => {
        if (this.active === active) {
          this.fail(active, "Outline worker response could not be decoded");
        }
      });

      try {
        worker.postMessage({ type: "compute", jobId, identity });
      } catch (error) {
        this.fail(
          active,
          error instanceof Error
            ? error.message
            : "Outline worker could not start",
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
          ? "Outline computation failed"
          : error.slice(0, 500),
    });
  }

  private reportProgress(
    active: ActiveJob,
    candidate: HiddenLineProgress,
  ): void {
    const previous = active.lastProgress;
    if (
      previous !== null &&
      (candidate.totalWorkUnits !== previous.totalWorkUnits ||
        candidate.completedWorkUnits <= previous.completedWorkUnits)
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
    active.observeProgress?.({ snapshot, eta });
  }

  private finish(active: ActiveJob, result: HiddenLineComputeResult): void {
    if (this.active !== active) return;
    this.active = null;
    active.worker.terminate();
    active.resolve(result);
  }
}
