import {
  clipSceneToBounds,
  computePlotMapping,
  registry,
  renderPlotterSVG,
  type PageFrame,
  type Params,
  type PlotProfile,
  type Scene,
} from "@harness/core";

import {
  isHiddenLineWorkerMessage,
  isHiddenLineWorkerRequest,
  isOutlineComputeRequest,
  mutableScene,
  outlineGeometryIdentitiesEqual,
  type HiddenLineDerivationProgress,
  type HiddenLineFinalizing,
  type HiddenLineWorkerMessage,
  type OutlineComputeFailure,
  type OutlineComputeProgress,
  type OutlineComputeResponse,
  type OutlineComputeIdentity,
} from "./outlineComputeProtocol";
import {
  finalizeOutlineScene,
  outlineScene,
  type OutlineFinalizationStrokePolicy,
} from "./outlineScene";
import {
  createWorkerProgressEmitter,
  type MonotonicClock,
} from "./workerProgress";

type ProgressSink = (progress: OutlineComputeProgress) => void;

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
  return createWorkerProgressEmitter(
    (snapshot: OutlineComputeProgress["snapshot"]) =>
      emit({ type: "progress", jobId, snapshot }),
    now,
  );
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
    toolWidthMillimeters: profile.toolWidthMillimeters,
  };
}

function finalizationStrokePolicy(
  identity: OutlineComputeIdentity,
  profile: Readonly<PlotProfile>,
  pageFrame: Readonly<PageFrame> | null,
): OutlineFinalizationStrokePolicy {
  if (identity.sourceKind !== "legacy-scene") {
    return { kind: "physical-tool", target: identity.outlineTarget };
  }

  const pageSpace =
    pageFrame === null
      ? identity.compositionFrame
      : { width: pageFrame.width, height: pageFrame.height };
  return {
    kind: "legacy-scene",
    target: {
      toolWidthMillimeters: profile.toolWidthMillimeters,
      millimetersPerSceneUnit: computePlotMapping(
        pageSpace,
        mutableProfile(profile),
      ).scale,
    },
  };
}

/** Resolve legacy, parameter-derived, or completed-Scene Outline input. */
function sourceSceneForIdentity(identity: OutlineComputeIdentity): Scene {
  if (identity.sourceKind === "legacy-scene") {
    return mutableScene(identity.sourceScene);
  }
  const sketch = registry.get(identity.sketchId);
  const target = {
    toolWidthMillimeters: identity.outlineTarget.toolWidthMillimeters,
    millimetersPerSceneUnit:
      identity.outlineTarget.millimetersPerSceneUnit,
  };
  if (identity.sourceKind === "completed-scene-sketch") {
    if (sketch.deriveOutlineSource === undefined) {
      throw new Error(
        `Sketch ${identity.sketchId} has no completed-Scene Outline source`,
      );
    }
    return sketch.deriveOutlineSource(
      mutableScene(identity.sourceScene),
      target,
    );
  }
  if (sketch.generateOutlineSource === undefined) {
    throw new Error(
      `Sketch ${identity.sketchId} has no specialized Outline source`,
    );
  }

  const params: Params = {};
  for (const entry of identity.params) params[entry.key] = entry.value;
  return sketch.generateOutlineSource(
    params,
    identity.seed,
    identity.sampledT,
    {
      width: identity.compositionFrame.width,
      height: identity.compositionFrame.height,
    },
    target,
  );
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
          sourceSceneForIdentity(identity),
          identity.tolerance,
          report,
        ),
      };
      if (!isHiddenLineWorkerMessage(complete)) {
        throw new TypeError("Outline worker produced an invalid preview");
      }
      return complete;
    }

    const reusable = value.snapshot.reusableOutline;
    const completedScene: Scene =
      reusable !== undefined &&
      outlineGeometryIdentitiesEqual(identity, reusable.identity)
        ? mutableScene(reusable.scene)
        : derive(
            sourceSceneForIdentity(identity),
            identity.tolerance,
            report,
          );

    emit?.({
      type: "finalizing",
      jobKind: "export",
      owner: "hidden-line-export",
      jobId: value.jobId,
    });
    const clip = dependencies.clip ?? clipSceneToBounds;
    const render = dependencies.render ?? renderPlotterSVG;
    const finalizedScene = finalizeOutlineScene(
      completedScene,
      value.snapshot.pageFrame,
      value.snapshot.profile.includeFrame,
      finalizationStrokePolicy(
        identity,
        value.snapshot.profile,
        value.snapshot.pageFrame,
      ),
    );
    const svg = render(
      clip(finalizedScene),
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
        sourceSceneForIdentity(value.identity),
        value.identity.tolerance,
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
