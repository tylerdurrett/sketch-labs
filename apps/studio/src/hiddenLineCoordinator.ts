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

export interface OutlineWorkerPort {
  postMessage(message: HiddenLineWorkerRequest | OutlineComputeRequest): void;
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
  readonly worker: OutlineWorkerPort;
  readonly resolve: (result: HiddenLineJobResult) => void;
  readonly observeProgress:
    | HiddenLineProgressObserver
    | HiddenLineExportProgressObserver
    | undefined;
  readonly eta: RollingEtaEstimator;
  lastProgress: HiddenLineProgress | null;
  finalizing: boolean;
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

function ownerFor(jobKind: HiddenLineJobKind): HiddenLineJobOwner {
  return jobKind === "preview" ? "outline-preview" : "hidden-line-export";
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
        jobKind,
        owner: ownerFor(jobKind),
        identity,
        worker,
        resolve,
        observeProgress,
        eta: createRollingEtaEstimator(),
        lastProgress: null,
        finalizing: false,
      };
      this.active = active;

      worker.addEventListener("message", (event) => {
        if (this.active !== active) return;
        if (active.jobKind === "preview") {
          if (isOutlineComputeProgress(event.data)) {
            if (event.data.jobId === active.jobId) {
              this.reportProgress(active, event.data.snapshot);
            }
            return;
          }
          if (isOutlineComputeResponse(event.data)) {
            if (
              event.data.jobId !== active.jobId ||
              !outlineComputeIdentitiesEqual(
                event.data.identity,
                active.identity,
              )
            ) {
              return;
            }
            if (event.data.type === "failure") {
              this.fail(active, event.data.error);
            } else {
              this.finish(active, {
                status: "success",
                jobId,
                identity,
                scene: event.data.scene,
              });
            }
            return;
          }
        }
        if (!isHiddenLineWorkerMessage(event.data)) {
          this.fail(active, "Outline worker returned an invalid response");
          return;
        }
        if (
          event.data.jobId !== active.jobId ||
          event.data.jobKind !== active.jobKind ||
          event.data.owner !== active.owner
        ) {
          return;
        }
        if (event.data.type === "derivation-progress") {
          this.reportProgress(active, event.data.snapshot);
          return;
        }
        if (event.data.type === "finalizing") {
          this.reportFinalizing(active);
          return;
        }
        if (
          !outlineComputeIdentitiesEqual(event.data.identity, active.identity)
        ) {
          return;
        }
        if (event.data.type === "failure") {
          this.fail(active, event.data.error);
          return;
        }
        if (event.data.jobKind === "preview") {
          this.finish(active, {
            status: "success",
            jobId,
            identity,
            scene: event.data.scene,
          });
          return;
        }
        this.finish(active, {
          status: "success",
          jobId,
          identity,
          svg: event.data.svg,
          filename: event.data.filename,
          completedOutline: event.data.completedOutline,
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
        worker.postMessage(createRequest(jobId));
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

  private reportProgress(active: ActiveJob, candidate: HiddenLineProgress): void {
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
      (active.observeProgress as HiddenLineProgressObserver | undefined)?.({
        snapshot,
        eta,
      });
    } else {
      (
        active.observeProgress as HiddenLineExportProgressObserver | undefined
      )?.({
        phase: "derivation",
        snapshot,
        eta,
      });
    }
  }

  private reportFinalizing(active: ActiveJob): void {
    if (active.jobKind !== "export" || active.finalizing) return;
    active.finalizing = true;
    (active.observeProgress as HiddenLineExportProgressObserver | undefined)?.({
      phase: "finalizing",
    });
  }

  private finish(active: ActiveJob, result: HiddenLineJobResult): void {
    if (this.active !== active) return;
    this.active = null;
    active.worker.terminate();
    active.resolve(result);
  }
}
