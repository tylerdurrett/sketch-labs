import type { Params, ScribbleArtwork } from "@harness/core";

import {
  generatePhotoScribbleBenchmarkArtworkFromResolution,
  reconcileLegacyPhotoScribbleParams,
  resolvePhotoScribbleBenchmark,
  type PhotoScribbleBenchmarkResolution,
} from "../../../packages/core/benchmarks/photo-scribble/benchmark-artwork";
import type { ScribbleExecutionLimits } from "../../../packages/core/src/scribbleStrategy/orchestrator";
import type { ScribbleExecutionObservation } from "../../../packages/core/src/scribbleStrategy/orchestrator";
import type { ScribbleArtworkExecutor } from "./scribbleWorkerRuntime";
import { canonicalBrowserScribbleTargetHash } from "./photoScribbleEvidenceHash";
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
  readonly resolvedProductionLimits: Readonly<ScribbleExecutionLimits> | null;
  readonly effectiveLimits: Readonly<ScribbleExecutionLimits> | null;
  readonly productionResolverSelectedEffectiveTuple: boolean | null;
  readonly execution: Readonly<ScribbleExecutionObservation> | null;
  readonly preparationCount: number;
  readonly solverPassCount: number;
  /** Deferred until after the product success response is posted. */
  readonly targetHash: (() => Promise<string>) | null;
}

export interface PhotoScribbleEvidenceExecutionDependencies {
  readonly resolve: (
    params: Params,
    frame: Parameters<typeof resolvePhotoScribbleBenchmark>[1],
    environment: Parameters<typeof resolvePhotoScribbleBenchmark>[2],
  ) => PhotoScribbleBenchmarkResolution;
  readonly generateInjected: typeof generatePhotoScribbleBenchmarkArtworkFromResolution;
}

const defaultDependencies: PhotoScribbleEvidenceExecutionDependencies = {
  resolve: resolvePhotoScribbleBenchmark,
  generateInjected: generatePhotoScribbleBenchmarkArtworkFromResolution,
};

/** Execute exactly one solver pass for either production or an injected tuple. */
export function executePhotoScribbleEvidenceArtwork(
  config: PhotoScribbleEvidenceWorkerConfig,
  generate: Parameters<ScribbleArtworkExecutor>[0],
  identity: Parameters<ScribbleArtworkExecutor>[1],
  environment: Parameters<ScribbleArtworkExecutor>[2],
  observer: Parameters<ScribbleArtworkExecutor>[3],
  dependencies: PhotoScribbleEvidenceExecutionDependencies = defaultDependencies,
): PhotoScribbleEvidenceExecution {
  if (identity.sketchId !== "photo-scribble") {
    throw new TypeError("Photo Scribble evidence Worker received another Sketch");
  }
  const params = reconcileLegacyPhotoScribbleParams(
    paramsFromEntries(identity.params),
  );
  const imageAssetId = params.imageAsset;
  if (typeof imageAssetId !== "string") {
    throw new TypeError("Photo Scribble evidence identity lacks an Image Asset");
  }
  let preparationCount = 0;
  let solverPassCount = 0;
  const resolve = (): PhotoScribbleBenchmarkResolution => {
    preparationCount++;
    return dependencies.resolve(
      params,
      identity.compositionFrame,
      environment,
    );
  };
  const generateProduction = (): ScribbleArtwork => {
    // The registered generator owns both preparation and its solver pass.
    preparationCount++;
    solverPassCount++;
    return generate(
      params,
      identity.seed,
      identity.compositionFrame,
      observer,
      environment,
    );
  };
  if (config.profile.kind === "production") {
    // A measured production job performs only the registered generator's one
    // source/model/solver preparation. Tuple discovery is deliberately moved
    // to the separate unmeasured proof operation below.
    const artwork = generateProduction();
    const resolution =
      config.purpose === "equivalence-proof"
        ? resolve()
        : null;
    return {
      artwork,
      imageAssetId,
      profile: config.profile,
      resolvedProductionLimits: resolution?.productionLimits ?? null,
      effectiveLimits: resolution?.productionLimits ?? null,
      productionResolverSelectedEffectiveTuple:
        resolution === null ? null : true,
      execution: null,
      preparationCount,
      solverPassCount,
      targetHash:
        resolution === null
          ? null
          : () => canonicalBrowserScribbleTargetHash(resolution.model),
    };
  }

  const resolution = resolve();
  let execution: ScribbleExecutionObservation | undefined;
  solverPassCount++;
  const artwork = dependencies.generateInjected(
    resolution,
    identity.seed,
    identity.compositionFrame,
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
    preparationCount,
    solverPassCount,
    targetHash: () => canonicalBrowserScribbleTargetHash(resolution.model),
  };
}
