import {
  IMAGE_DETAIL_ANALYSIS_DEFINITION_ID,
  photoScribble,
  prepareImageDetailAnalysis,
  registry,
  type ParamSchema,
  type Params,
  type ShadingArtwork,
  type ShadingObserver,
  type SketchEnvironment,
  type StatelessSketch,
} from "@harness/core";

import {
  createShadingComputeIdentity,
  isShadingComputeProgress,
  isShadingComputeRequest,
  isShadingComputeResponse,
  shadingIdentityProjection,
  shadingComputeIdentitiesEqual,
  type ShadingComputeIdentity,
  type ShadingComputeProgress,
  type ShadingComputeResponse,
} from "./shadingComputeProtocol";
import {
  createWorkerProgressEmitter,
  type MonotonicClock,
} from "./workerProgress";
import { resolveSketchEnvironment } from "./imageAssetResolver";

type ProgressSink = (progress: ShadingComputeProgress) => void;
type ShadingArtworkGenerator = NonNullable<
  StatelessSketch["generateShadingArtwork"]
>;

export type ShadingArtworkExecutor = (
  generate: ShadingArtworkGenerator,
  identity: ShadingComputeIdentity,
  environment: SketchEnvironment,
  observer?: ShadingObserver,
) => ShadingArtwork;

export type ShadingEnvironmentResolver = (
  schema: ParamSchema,
  params: Params,
) => Promise<SketchEnvironment>;

function systemMonotonicClock(): number {
  return performance.now();
}

function paramsFromIdentity(identity: ShadingComputeIdentity): Params {
  const params = Object.create(null) as Params;
  for (const entry of identity.params) params[entry.key] = entry.value;
  return params;
}

function schemaMismatch(sketchId: string): TypeError {
  return new TypeError(
    `Shading request parameters do not match ${sketchId} schema`,
  );
}

function prepareDetailEnvironment(
  identity: ShadingComputeIdentity,
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

interface ResolvedShadingRequest {
  readonly generate: ShadingArtworkGenerator;
  readonly schema: ParamSchema;
  readonly params: Params;
}

function resolveShadingRequest(
  identity: ShadingComputeIdentity,
): ResolvedShadingRequest {
  const sketch = registry.get(identity.sketchId);
  if (sketch.generateShadingArtwork === undefined) {
    throw new Error(
      `Sketch ${identity.sketchId} has no Shading artwork generator`,
    );
  }

  const params = paramsFromIdentity(identity);
  let schema: Readonly<ParamSchema>;
  let canonicalIdentity: ShadingComputeIdentity;
  try {
    const projection = shadingIdentityProjection(sketch);
    schema = projection.schema;
    canonicalIdentity = createShadingComputeIdentity({
      sketchId: sketch.id,
      schema,
      schemaKeys: projection.schemaKeys,
      params,
      seed: identity.seed,
      compositionFrame: identity.compositionFrame,
    });
  } catch {
    throw schemaMismatch(sketch.id);
  }
  if (!shadingComputeIdentitiesEqual(identity, canonicalIdentity)) {
    throw schemaMismatch(sketch.id);
  }
  return {
    generate: sketch.generateShadingArtwork,
    schema,
    params,
  };
}

/** Execute the already-resolved Sketch-owned Shading preparation hook. */
export const executeShadingArtwork: ShadingArtworkExecutor = (
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
  return "Shading computation failed";
}

function finiteElapsed(startedAt: number, completedAt: number): number {
  const elapsed = completedAt - startedAt;
  return Number.isFinite(elapsed) && elapsed >= 0 ? elapsed : 0;
}

function progressReporter(
  jobId: number,
  emit: ProgressSink,
  now: MonotonicClock,
): ShadingObserver {
  return createWorkerProgressEmitter((snapshot) => {
    const progress: ShadingComputeProgress = {
      type: "progress",
      jobId,
      snapshot,
    };
    if (!isShadingComputeProgress(progress)) {
      throw new TypeError("Shading worker produced invalid progress");
    }
    emit(progress);
  }, now);
}

/** Execute one validated Shading request without sharing Outline messages. */
export async function handleShadingWorkerMessage(
  value: unknown,
  execute: ShadingArtworkExecutor = executeShadingArtwork,
  emitProgress?: ProgressSink,
  now: MonotonicClock = systemMonotonicClock,
  resolveEnvironment: ShadingEnvironmentResolver = (schema, params) =>
    resolveSketchEnvironment(schema, params),
): Promise<ShadingComputeResponse | null> {
  if (!isShadingComputeRequest(value)) return null;

  try {
    // Canonicalize against the registry before an opaque Image Asset ID can
    // trigger any fetch or decode. The resolver creates fresh worker-owned
    // records for this job; decoded pixels never join protocol identity.
    const { generate, schema, params } = resolveShadingRequest(value.identity);
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
    const response: ShadingComputeResponse = {
      type: "success",
      jobId: value.jobId,
      identity: value.identity,
      scene: artwork.scene,
      diagnostics: artwork.diagnostics,
      computeTimeMs: finiteElapsed(startedAt, now()),
    };
    if (!isShadingComputeResponse(response)) {
      throw new TypeError("Shading worker produced an invalid result");
    }
    return response;
  } catch (error) {
    const failure: ShadingComputeResponse = {
      type: "failure",
      jobId: value.jobId,
      identity: value.identity,
      error: safeError(error),
    };
    if (!isShadingComputeResponse(failure)) {
      throw new TypeError("Shading worker produced an invalid failure");
    }
    return failure;
  }
}
