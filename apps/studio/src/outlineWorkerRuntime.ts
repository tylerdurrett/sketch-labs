import {
  clipSceneToBounds,
  renderPlotterSVG,
  type PlotProfile,
  type Scene,
} from "@harness/core";

import {
  isHiddenLineWorkerMessage,
  isHiddenLineWorkerRequest,
  isOutlineComputeRequest,
  mutableScene,
  type HiddenLineDerivationProgress,
  type HiddenLineFinalizing,
  type HiddenLineWorkerMessage,
  type OutlineComputeFailure,
  type OutlineComputeProgress,
  type OutlineComputeResponse,
} from "./outlineComputeProtocol";
import { outlineScene } from "./outlineScene";

/**
 * Caps ordinary progress traffic at ten messages per second. The first useful
 * snapshot and terminal snapshot bypass the interval, so a job emits at most
 * one initial message, one message per elapsed interval, and one terminal.
 */
const PROGRESS_INTERVAL_MS = 100;

type ProgressSink = (progress: OutlineComputeProgress) => void;
type MonotonicClock = () => number;

type HiddenLineEvent = HiddenLineDerivationProgress | HiddenLineFinalizing;
type HiddenLineEventSink = (event: HiddenLineEvent) => void;

export interface HiddenLineWorkerRuntimeDependencies {
  readonly derive?: typeof outlineScene;
  readonly clip?: typeof clipSceneToBounds;
  readonly render?: typeof renderPlotterSVG;
}

function systemMonotonicClock(): number {
  return performance.now();
}

function createProgressReporter(
  jobId: number,
  emit: ProgressSink,
  now: MonotonicClock,
) {
  let hasEmitted = false;
  let lastEmittedAt = 0;

  return (snapshot: OutlineComputeProgress["snapshot"]): void => {
    if (snapshot.terminal) {
      emit({ type: "progress", jobId, snapshot });
      return;
    }

    const observedAt = now();
    if (hasEmitted && observedAt - lastEmittedAt < PROGRESS_INTERVAL_MS) {
      return;
    }
    hasEmitted = true;
    lastEmittedAt = observedAt;
    emit({ type: "progress", jobId, snapshot });
  };
}

function safeError(error: unknown): string {
  if (error instanceof Error && error.message.trim() !== "") {
    return error.message.slice(0, 500);
  }
  return "Outline computation failed";
}

function mutableProfile(profile: Readonly<PlotProfile>): PlotProfile {
  return {
    width: profile.width,
    height: profile.height,
    insets: {
      top: profile.insets.top,
      right: profile.insets.right,
      bottom: profile.insets.bottom,
      left: profile.insets.left,
    },
    includeFrame: profile.includeFrame,
  };
}

/**
 * Execute the typed preview/export protocol. Export owns only pure derivation
 * and serialization; Blob construction and downloading remain on the main
 * thread after a validated complete payload is received.
 */
export function handleHiddenLineWorkerMessage(
  value: unknown,
  dependencies: HiddenLineWorkerRuntimeDependencies = {},
  emit?: HiddenLineEventSink,
  now: MonotonicClock = systemMonotonicClock,
): HiddenLineWorkerMessage | null {
  if (!isHiddenLineWorkerRequest(value)) return null;

  const identity =
    value.type === "preview" ? value.identity : value.snapshot.identity;
  const derive = dependencies.derive ?? outlineScene;

  try {
    const report =
      emit === undefined
        ? undefined
        : createProgressReporter(
            value.jobId,
            (progress) => {
              emit({
                jobKind: value.jobKind,
                owner: value.owner,
                jobId: value.jobId,
                identity,
                type: "derivation-progress",
                snapshot: progress.snapshot,
              } as HiddenLineDerivationProgress);
            },
            now,
          );

    if (value.type === "preview") {
      const complete: HiddenLineWorkerMessage = {
        type: "complete",
        jobKind: "preview",
        owner: "outline-preview",
        jobId: value.jobId,
        identity,
        scene: derive(
          mutableScene(identity.sourceScene),
          identity.tolerance,
          identity.includeFrame,
          report,
        ),
      };
      if (!isHiddenLineWorkerMessage(complete)) {
        throw new TypeError("Outline worker produced an invalid preview");
      }
      return complete;
    }

    const completedScene: Scene =
      value.snapshot.reusableOutline === undefined
        ? derive(
            mutableScene(identity.sourceScene),
            identity.tolerance,
            identity.includeFrame,
            report,
          )
        : mutableScene(value.snapshot.reusableOutline.scene);

    emit?.({
      type: "finalizing",
      jobKind: "export",
      owner: "hidden-line-export",
      jobId: value.jobId,
      identity,
    });
    const clip = dependencies.clip ?? clipSceneToBounds;
    const render = dependencies.render ?? renderPlotterSVG;
    const svg = render(
      clip(completedScene),
      mutableProfile(value.snapshot.profile),
      value.snapshot.metadata,
      { includePaperMargins: value.snapshot.includePaperMargins },
    );
    const complete: HiddenLineWorkerMessage = {
      type: "complete",
      jobKind: "export",
      owner: "hidden-line-export",
      jobId: value.jobId,
      identity,
      svg,
      filename: value.snapshot.filename,
      completedOutline: { identity, scene: completedScene },
    };
    if (!isHiddenLineWorkerMessage(complete)) {
      throw new TypeError("Outline worker produced an invalid export");
    }
    return complete;
  } catch (error) {
    return value.type === "preview"
      ? {
          type: "failure",
          jobKind: "preview",
          owner: "outline-preview",
          jobId: value.jobId,
          identity,
          error: safeError(error),
        }
      : {
          type: "failure",
          jobKind: "export",
          owner: "hidden-line-export",
          jobId: value.jobId,
          identity,
          error: safeError(error),
        };
  }
}

export function handleOutlineWorkerMessage(
  value: unknown,
  derive: typeof outlineScene = outlineScene,
  emitProgress?: ProgressSink,
  now: MonotonicClock = systemMonotonicClock,
): OutlineComputeResponse | null {
  if (!isOutlineComputeRequest(value)) return null;
  try {
    return {
      type: "success",
      jobId: value.jobId,
      identity: value.identity,
      scene: derive(
        mutableScene(value.identity.sourceScene),
        value.identity.tolerance,
        value.identity.includeFrame,
        emitProgress === undefined
          ? undefined
          : createProgressReporter(value.jobId, emitProgress, now),
      ),
    };
  } catch (error) {
    const failure: OutlineComputeFailure = {
      type: "failure",
      jobId: value.jobId,
      identity: value.identity,
      error: safeError(error),
    };
    return failure;
  }
}
