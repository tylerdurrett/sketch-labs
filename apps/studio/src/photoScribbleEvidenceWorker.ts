/// <reference lib="webworker" />

import type { ScribbleArtworkExecutor } from "./scribbleWorkerRuntime";
import { handleScribbleWorkerMessage } from "./scribbleWorkerRuntime";
import { executePhotoScribbleEvidenceArtwork } from "./photoScribbleEvidenceExecution";
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

function pointsIn(artwork: { readonly scene: { readonly primitives: readonly { readonly points: readonly unknown[] }[] } }): number {
  return artwork.scene.primitives.reduce(
    (total, primitive) => total + primitive.points.length,
    0,
  );
}

const executeEvidenceArtwork: ScribbleArtworkExecutor = (
  generate,
  identity,
  environment,
  observer,
) => {
  const startedAt = performance.now();
  const evidence = executePhotoScribbleEvidenceArtwork(
    config,
    generate,
    identity,
    environment,
    observer,
  );
  const { artwork, execution } = evidence;
  const serializedArtwork = JSON.stringify(artwork);
  pendingTelemetry = {
    schemaVersion: 1,
    runId: config.runId,
    sketchId: "photo-scribble",
    imageAssetId: evidence.imageAssetId,
    profile: evidence.profile,
    purpose: config.purpose,
    resolvedProductionLimits: evidence.resolvedProductionLimits,
    effectiveLimits: evidence.effectiveLimits,
    productionResolverSelectedEffectiveTuple:
      evidence.productionResolverSelectedEffectiveTuple,
    execution,
    rawAcceptedSegments: execution?.counters.acceptedSegments ?? null,
    smoothedEmittedPoints: pointsIn(artwork),
    smoothedEmittedPolylines: artwork.scene.primitives.length,
    serializedArtworkBytes: new TextEncoder().encode(serializedArtwork)
      .byteLength,
    workerDurationMs:
      config.purpose === "measurement" ? performance.now() - startedAt : null,
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
