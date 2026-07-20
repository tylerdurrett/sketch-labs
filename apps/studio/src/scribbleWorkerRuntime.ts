import {
  IMAGE_DETAIL_ANALYSIS_DEFINITION_ID,
  photoScribble,
  prepareImageDetailAnalysis,
  registry,
  type ParamSchema,
  type Params,
  type ScribbleArtwork,
  type ScribbleObserver,
  type SketchEnvironment,
  type StatelessSketch,
} from "@harness/core";

import {
  createScribbleComputeIdentity,
  isScribbleComputeProgress,
  isScribbleComputeRequest,
  isScribbleComputeResponse,
  scribbleComputeIdentitiesEqual,
  type ScribbleComputeIdentity,
  type ScribbleComputeProgress,
  type ScribbleComputeResponse,
} from "./scribbleComputeProtocol";
import {
  createWorkerProgressEmitter,
  type MonotonicClock,
} from "./workerProgress";
import { resolveSketchEnvironment } from "./imageAssetResolver";

type ProgressSink = (progress: ScribbleComputeProgress) => void;
type ScribbleArtworkGenerator = NonNullable<
  StatelessSketch["generateScribbleArtwork"]
>;

export type ScribbleArtworkExecutor = (
  generate: ScribbleArtworkGenerator,
  identity: ScribbleComputeIdentity,
  environment: SketchEnvironment,
  observer?: ScribbleObserver,
) => ScribbleArtwork;

export type ScribbleEnvironmentResolver = (
  schema: ParamSchema,
  params: Params,
) => Promise<SketchEnvironment>;

function systemMonotonicClock(): number {
  return performance.now();
}

function paramsFromIdentity(identity: ScribbleComputeIdentity): Params {
  const params = Object.create(null) as Params;
  for (const entry of identity.params) params[entry.key] = entry.value;
  return params;
}

function schemaMismatch(sketchId: string): TypeError {
  return new TypeError(
    `Scribble request parameters do not match ${sketchId} schema`,
  );
}

function prepareDetailEnvironment(
  identity: ScribbleComputeIdentity,
  params: Params,
  environment: SketchEnvironment,
): SketchEnvironment {
  if (
    identity.sketchId !== photoScribble.id ||
    typeof params.detailInfluence !== "number" ||
    params.detailInfluence <= 0
  ) {
    return environment;
  }

  const imageAssetId = params.imageAsset;
  if (typeof imageAssetId !== "string") {
    throw schemaMismatch(identity.sketchId);
  }
  const pixels = environment.imageAssets(imageAssetId);
  if (pixels === undefined) {
    throw new Error("Photo Scribble Image Asset is unavailable");
  }
  const prepared = prepareImageDetailAnalysis(pixels);
  return {
    imageAssets: environment.imageAssets,
    getPreparedImageDetailAnalysis(assetId, analysisDefinitionId) {
      return assetId === imageAssetId &&
        analysisDefinitionId === IMAGE_DETAIL_ANALYSIS_DEFINITION_ID
        ? prepared
        : undefined;
    },
  };
}

interface ResolvedScribbleRequest {
  readonly generate: ScribbleArtworkGenerator;
  readonly schema: ParamSchema;
  readonly params: Params;
}

function resolveScribbleRequest(
  identity: ScribbleComputeIdentity,
): ResolvedScribbleRequest {
  const sketch = registry.get(identity.sketchId);
  if (sketch.generateScribbleArtwork === undefined) {
    throw new Error(
      `Sketch ${identity.sketchId} has no Scribble artwork generator`,
    );
  }

  const params = paramsFromIdentity(identity);
  let canonicalIdentity: ScribbleComputeIdentity;
  try {
    canonicalIdentity = createScribbleComputeIdentity({
      sketchId: sketch.id,
      schema: sketch.schema,
      params,
      seed: identity.seed,
      compositionFrame: identity.compositionFrame,
    });
  } catch {
    throw schemaMismatch(sketch.id);
  }
  if (!scribbleComputeIdentitiesEqual(identity, canonicalIdentity)) {
    throw schemaMismatch(sketch.id);
  }
  return {
    generate: sketch.generateScribbleArtwork,
    schema: sketch.schema,
    params,
  };
}

/** Execute the already-resolved Sketch-owned Scribble preparation hook. */
export const executeScribbleArtwork: ScribbleArtworkExecutor = (
  generate,
  identity,
  environment,
  observer,
) =>
  generate(
    paramsFromIdentity(identity),
    identity.seed,
    {
      width: identity.compositionFrame.width,
      height: identity.compositionFrame.height,
    },
    observer,
    environment,
  );

function safeError(error: unknown): string {
  if (error instanceof Error) {
    try {
      const message = error.message.trim();
      if (message !== "") return message.slice(0, 500);
    } catch {
      // Fall through to the stable domain failure below.
    }
  }
  return "Scribble computation failed";
}

function finiteElapsed(startedAt: number, completedAt: number): number {
  const elapsed = completedAt - startedAt;
  return Number.isFinite(elapsed) && elapsed >= 0 ? elapsed : 0;
}

function progressReporter(
  jobId: number,
  emit: ProgressSink,
  now: MonotonicClock,
): ScribbleObserver {
  return createWorkerProgressEmitter((snapshot) => {
    const progress: ScribbleComputeProgress = {
      type: "progress",
      jobId,
      snapshot,
    };
    if (!isScribbleComputeProgress(progress)) {
      throw new TypeError("Scribble worker produced invalid progress");
    }
    emit(progress);
  }, now);
}

/** Execute one validated Scribble request without sharing Outline messages. */
export async function handleScribbleWorkerMessage(
  value: unknown,
  execute: ScribbleArtworkExecutor = executeScribbleArtwork,
  emitProgress?: ProgressSink,
  now: MonotonicClock = systemMonotonicClock,
  resolveEnvironment: ScribbleEnvironmentResolver = (schema, params) =>
    resolveSketchEnvironment(schema, params),
): Promise<ScribbleComputeResponse | null> {
  if (!isScribbleComputeRequest(value)) return null;

  try {
    // Canonicalize against the registry before an opaque Image Asset ID can
    // trigger any fetch or decode. The resolver creates fresh worker-owned
    // records for this job; decoded pixels never join protocol identity.
    const { generate, schema, params } = resolveScribbleRequest(value.identity);
    const resolvedEnvironment = await resolveEnvironment(schema, params);
    const environment = prepareDetailEnvironment(
      value.identity,
      params,
      resolvedEnvironment,
    );
    const startedAt = now();
    const artwork = execute(
      generate,
      value.identity,
      environment,
      emitProgress === undefined
        ? undefined
        : progressReporter(value.jobId, emitProgress, now),
    );
    const response: ScribbleComputeResponse = {
      type: "success",
      jobId: value.jobId,
      identity: value.identity,
      scene: artwork.scene,
      diagnostics: artwork.diagnostics,
      computeTimeMs: finiteElapsed(startedAt, now()),
    };
    if (!isScribbleComputeResponse(response)) {
      throw new TypeError("Scribble worker produced an invalid result");
    }
    return response;
  } catch (error) {
    const failure: ScribbleComputeResponse = {
      type: "failure",
      jobId: value.jobId,
      identity: value.identity,
      error: safeError(error),
    };
    if (!isScribbleComputeResponse(failure)) {
      throw new TypeError("Scribble worker produced an invalid failure");
    }
    return failure;
  }
}
