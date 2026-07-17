import {
  registry,
  type Params,
  type ScribbleArtwork,
  type ScribbleObserver,
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

type ProgressSink = (progress: ScribbleComputeProgress) => void;
type ScribbleArtworkGenerator = NonNullable<
  StatelessSketch["generateScribbleArtwork"]
>;

export type ScribbleArtworkExecutor = (
  generate: ScribbleArtworkGenerator,
  identity: ScribbleComputeIdentity,
  observer?: ScribbleObserver,
) => ScribbleArtwork;

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

function resolveScribbleGenerator(
  identity: ScribbleComputeIdentity,
): ScribbleArtworkGenerator {
  const sketch = registry.get(identity.sketchId);
  if (sketch.generateScribbleArtwork === undefined) {
    throw new Error(
      `Sketch ${identity.sketchId} has no Scribble artwork generator`,
    );
  }

  let canonicalIdentity: ScribbleComputeIdentity;
  try {
    canonicalIdentity = createScribbleComputeIdentity({
      sketchId: sketch.id,
      schema: sketch.schema,
      params: paramsFromIdentity(identity),
      seed: identity.seed,
      compositionFrame: identity.compositionFrame,
    });
  } catch {
    throw schemaMismatch(sketch.id);
  }
  if (!scribbleComputeIdentitiesEqual(identity, canonicalIdentity)) {
    throw schemaMismatch(sketch.id);
  }
  return sketch.generateScribbleArtwork;
}

/** Execute the already-resolved Sketch-owned Scribble preparation hook. */
export const executeScribbleArtwork: ScribbleArtworkExecutor = (
  generate,
  identity,
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
export function handleScribbleWorkerMessage(
  value: unknown,
  execute: ScribbleArtworkExecutor = executeScribbleArtwork,
  emitProgress?: ProgressSink,
  now: MonotonicClock = systemMonotonicClock,
): ScribbleComputeResponse | null {
  if (!isScribbleComputeRequest(value)) return null;

  try {
    const generate = resolveScribbleGenerator(value.identity);
    const startedAt = now();
    const artwork = execute(
      generate,
      value.identity,
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
