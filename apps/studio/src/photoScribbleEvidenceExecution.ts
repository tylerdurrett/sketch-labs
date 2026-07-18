import type { Params, ScribbleArtwork } from "@harness/core";

import {
  generatePhotoScribbleBenchmarkArtwork,
  resolvePhotoScribbleBenchmark,
} from "../../../packages/core/benchmarks/photo-scribble/benchmark-artwork";
import type { ScribbleExecutionLimits } from "../../../packages/core/src/scribbleStrategy/orchestrator";
import type { ScribbleExecutionObservation } from "../../../packages/core/src/scribbleStrategy/orchestrator";
import type { ScribbleArtworkExecutor } from "./scribbleWorkerRuntime";
import type {
  PhotoScribbleEvidenceProfile,
  PhotoScribbleEvidenceWorkerConfig,
} from "./photoScribbleEvidenceProtocol";

function paramsFromEntries(
  entries: readonly { readonly key: string; readonly value: string | number }[],
): Params {
  return Object.fromEntries(entries.map(({ key, value }) => [key, value]));
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

export interface PhotoScribbleEvidenceExecution {
  readonly artwork: ScribbleArtwork;
  readonly imageAssetId: string;
  readonly profile: PhotoScribbleEvidenceProfile;
  readonly resolvedProductionLimits: Readonly<ScribbleExecutionLimits>;
  readonly effectiveLimits: Readonly<ScribbleExecutionLimits>;
  readonly productionResolverSelectedEffectiveTuple: boolean;
  readonly execution: Readonly<ScribbleExecutionObservation> | null;
}

/** Execute exactly one solver pass for either production or an injected tuple. */
export function executePhotoScribbleEvidenceArtwork(
  config: PhotoScribbleEvidenceWorkerConfig,
  generate: Parameters<ScribbleArtworkExecutor>[0],
  identity: Parameters<ScribbleArtworkExecutor>[1],
  environment: Parameters<ScribbleArtworkExecutor>[2],
  observer: Parameters<ScribbleArtworkExecutor>[3],
  generateInjected: typeof generatePhotoScribbleBenchmarkArtwork =
    generatePhotoScribbleBenchmarkArtwork,
): PhotoScribbleEvidenceExecution {
  if (identity.sketchId !== "photo-scribble") {
    throw new TypeError("Photo Scribble evidence Worker received another Sketch");
  }
  const params = paramsFromEntries(identity.params);
  const imageAssetId = params.imageAsset;
  if (typeof imageAssetId !== "string") {
    throw new TypeError("Photo Scribble evidence identity lacks an Image Asset");
  }
  const resolution = resolvePhotoScribbleBenchmark(
    params,
    identity.compositionFrame,
    environment,
  );
  if (config.profile.kind === "production") {
    return {
      artwork: generate(
        params,
        identity.seed,
        identity.compositionFrame,
        observer,
        environment,
      ),
      imageAssetId,
      profile: config.profile,
      resolvedProductionLimits: resolution.productionLimits,
      effectiveLimits: resolution.productionLimits,
      productionResolverSelectedEffectiveTuple: true,
      execution: null,
    };
  }

  let execution: ScribbleExecutionObservation | undefined;
  const artwork = generateInjected(
    params,
    identity.seed,
    identity.compositionFrame,
    environment,
    config.profile.limits,
    observer,
    { executionObserver: (value) => (execution = value) },
  );
  if (execution === undefined) {
    throw new Error("Photo Scribble benchmark execution emitted no telemetry");
  }
  return {
    artwork,
    imageAssetId,
    profile: config.profile,
    resolvedProductionLimits: resolution.productionLimits,
    effectiveLimits: config.profile.limits,
    productionResolverSelectedEffectiveTuple: sameTuple(
      resolution.productionLimits,
      config.profile.limits,
    ),
    execution,
  };
}
