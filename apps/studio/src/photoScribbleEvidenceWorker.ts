/// <reference lib="webworker" />

import type {
  Params,
  ScribbleArtwork,
  ScribbleObserver,
} from "@harness/core";

import {
  generatePhotoScribbleBenchmarkArtwork,
  resolvePhotoScribbleBenchmark,
} from "../../../packages/core/benchmarks/photo-scribble/benchmark-artwork";
import type {
  ScribbleExecutionLimits,
  ScribbleExecutionObservation,
} from "../../../packages/core/src/scribbleStrategy/orchestrator";
import type { ScribbleArtworkExecutor } from "./scribbleWorkerRuntime";
import { handleScribbleWorkerMessage } from "./scribbleWorkerRuntime";
import {
  parsePhotoScribbleEvidenceWorkerConfig,
  type PhotoScribbleEvidenceTelemetry,
} from "./photoScribbleEvidenceProtocol";

declare const self: DedicatedWorkerGlobalScope;

const config = parsePhotoScribbleEvidenceWorkerConfig(self.name);
const telemetryChannel = new BroadcastChannel(config.telemetryChannel);
let pendingTelemetry:
  | Omit<PhotoScribbleEvidenceTelemetry, "responseReadyEpochMs">
  | undefined;

function paramsFromEntries(
  entries: readonly { readonly key: string; readonly value: string | number }[],
): Params {
  return Object.fromEntries(entries.map(({ key, value }) => [key, value]));
}

function pointsIn(artwork: ScribbleArtwork): number {
  return artwork.scene.primitives.reduce(
    (total, primitive) => total + primitive.points.length,
    0,
  );
}

function sameTuple(
  left: Readonly<ScribbleExecutionLimits>,
  right: Readonly<ScribbleExecutionLimits>,
): boolean {
  return (
    left.maxAcceptedSegments === right.maxAcceptedSegments &&
    left.maxPolylines === right.maxPolylines &&
    left.maxStagnations === right.maxStagnations &&
    left.maxRestarts === right.maxRestarts
  );
}

const executeEvidenceArtwork: ScribbleArtworkExecutor = (
  generate,
  identity,
  environment,
  observer,
) => {
  if (identity.sketchId !== "photo-scribble") {
    throw new TypeError("Photo Scribble evidence Worker received another Sketch");
  }
  const params = paramsFromEntries(identity.params);
  const imageAssetId = params.imageAsset;
  if (typeof imageAssetId !== "string") {
    throw new TypeError("Photo Scribble evidence identity lacks an Image Asset");
  }
  const frame = identity.compositionFrame;
  const resolution = resolvePhotoScribbleBenchmark(params, frame, environment);
  const effectiveLimits =
    config.profile.kind === "production"
      ? resolution.productionLimits
      : config.profile.limits;
  let execution: ScribbleExecutionObservation | undefined;
  const observeExecution = (value: ScribbleExecutionObservation): void => {
    execution = value;
  };
  const startedAt = performance.now();
  let artwork: ScribbleArtwork;
  let productionOracle: PhotoScribbleEvidenceTelemetry["productionOracle"];

  if (config.profile.kind === "production") {
    // This is the registered production generator result returned to the real
    // coordinator. The second execution is a complete benchmark-only oracle
    // that exposes the otherwise internal tuple and raw counters.
    artwork = generate(
      params,
      identity.seed,
      frame,
      observer as ScribbleObserver | undefined,
      environment,
    );
    const oracle = generatePhotoScribbleBenchmarkArtwork(
      params,
      identity.seed,
      frame,
      environment,
      resolution.productionLimits,
      undefined,
      { executionObserver: observeExecution },
    );
    productionOracle = {
      executed: true,
      exactArtworkValueEquality:
        JSON.stringify(artwork) === JSON.stringify(oracle),
    };
  } else {
    artwork = generatePhotoScribbleBenchmarkArtwork(
      params,
      identity.seed,
      frame,
      environment,
      effectiveLimits,
      observer,
      { executionObserver: observeExecution },
    );
    productionOracle = { executed: false };
  }

  if (execution === undefined) {
    throw new Error("Photo Scribble benchmark execution emitted no telemetry");
  }
  const serializedArtwork = JSON.stringify(artwork);
  pendingTelemetry = {
    schemaVersion: 1,
    runId: config.runId,
    sketchId: "photo-scribble",
    imageAssetId,
    profile: config.profile,
    resolvedProductionLimits: resolution.productionLimits,
    effectiveLimits,
    productionResolverSelectedEffectiveTuple: sameTuple(
      resolution.productionLimits,
      effectiveLimits,
    ),
    execution,
    productionOracle,
    rawAcceptedSegments: execution.counters.acceptedSegments,
    smoothedEmittedPoints: pointsIn(artwork),
    smoothedEmittedPolylines: artwork.scene.primitives.length,
    serializedArtworkBytes: new TextEncoder().encode(serializedArtwork)
      .byteLength,
    workerDurationMs: performance.now() - startedAt,
  };
  return artwork;
};

self.addEventListener("message", (event: MessageEvent<unknown>) => {
  void handleScribbleWorkerMessage(
    event.data,
    executeEvidenceArtwork,
    (progress) => self.postMessage(progress),
  ).then((response) => {
    if (response === null) return;
    if (pendingTelemetry !== undefined) {
      telemetryChannel.postMessage({
        ...pendingTelemetry,
        responseReadyEpochMs: Date.now(),
      } satisfies PhotoScribbleEvidenceTelemetry);
      pendingTelemetry = undefined;
    }
    self.postMessage(response);
  });
});

export {};
