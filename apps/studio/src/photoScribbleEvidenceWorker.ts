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
interface PendingTelemetry {
  readonly base: Omit<
    PhotoScribbleEvidenceTelemetry,
    "responseReadyEpochMs" | "serializedArtworkBytes" | "targetHash"
  >;
  readonly artwork: ReturnType<ScribbleArtworkExecutor>;
  readonly targetHash: (() => Promise<string>) | null;
}

let pendingTelemetry: PendingTelemetry | undefined;

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
  pendingTelemetry = {
    base: {
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
      workerDurationMs:
        config.purpose === "measurement" ? performance.now() - startedAt : null,
      preparationCount: evidence.preparationCount,
      solverPassCount: evidence.solverPassCount,
    },
    artwork,
    targetHash: evidence.targetHash,
  };
  return artwork;
};

self.addEventListener("message", (event: MessageEvent<unknown>) => {
  void handleScribbleWorkerMessage(
    event.data,
    executeEvidenceArtwork,
    (progress) => self.postMessage(progress),
  ).then(async (response) => {
    if (response === null) return;
    const pending = pendingTelemetry;
    pendingTelemetry = undefined;
    const responseReadyEpochMs = Date.now();
    self.postMessage(response);
    if (pending !== undefined) {
      const serializedArtwork = JSON.stringify(pending.artwork);
      telemetryChannel.postMessage({
        ...pending.base,
        serializedArtworkBytes: new TextEncoder().encode(serializedArtwork)
          .byteLength,
        targetHash:
          pending.targetHash === null ? null : await pending.targetHash(),
        responseReadyEpochMs,
      } satisfies PhotoScribbleEvidenceTelemetry);
    }
  });
});

export {};
