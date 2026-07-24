import {
  registry,
  validateChoiceParamValue,
  validatePlotSequence,
  type ParamSchema,
  type Params,
  type PlotParameterBinding,
  type PlotStageDeclaration,
  type Scene,
  type SketchEnvironment,
  type SketchRegistry,
} from "@harness/core";

import { isImageAssetId } from "./imageAssetIdentity";
import { resolveSketchEnvironment } from "./imageAssetResolver";
import {
  PLOT_STAGE_PREPARATION_ERROR_MAX_LENGTH,
  isPlotStagePreparationRequest,
  isPlotStagePreparationResponse,
  type PlotStageParamEntry,
  type PlotStagePreparationFailure,
  type PlotStagePreparationIdentity,
  type PlotStagePreparationResponse,
  type PlotStagePreparationSuccess,
  type PlotStageRegistrationIdentity,
} from "./plotStagePreparationProtocol";

export type PlotStageEnvironmentResolver = (
  schema: ParamSchema,
  params: Params,
) => Promise<SketchEnvironment>;

export interface PlotStageWorkerRuntimeDependencies {
  readonly sketchRegistry?: SketchRegistry;
  readonly resolveEnvironment?: PlotStageEnvironmentResolver;
}

interface ResolvedPlotStageRequest {
  readonly stage: PlotStageDeclaration & {
    readonly source: Extract<PlotStageDeclaration["source"], { kind: "generator" }>;
  };
  readonly canonicalParams: Readonly<Params>;
  readonly owningParams: Params;
  readonly relevantSchema: ParamSchema;
}

const hasOwn = (value: object, key: PropertyKey): boolean =>
  Object.prototype.hasOwnProperty.call(value, key);

function safeError(error: unknown): string {
  if (error instanceof Error) {
    try {
      const message = error.message.trim();
      if (message !== "") {
        return message.slice(0, PLOT_STAGE_PREPARATION_ERROR_MAX_LENGTH);
      }
    } catch {
      // Fall through to the stable domain failure below.
    }
  }
  return "Plot Stage preparation failed";
}

function stageMismatch(sketchId: string, stageId: string): TypeError {
  return new TypeError(
    `Plot Stage request does not match ${sketchId}/${stageId} declaration`,
  );
}

function findStage(
  stages: readonly PlotStageDeclaration[],
  stageId: string,
): PlotStageDeclaration {
  const stage = stages.find((candidate) => candidate.id === stageId);
  if (stage === undefined) {
    throw new Error(`Sketch has no Plot Stage \`${stageId}\``);
  }
  return stage;
}

function entriesMatchBindings(
  entries: readonly PlotStageParamEntry[],
  bindings: readonly PlotParameterBinding[],
): boolean {
  return (
    entries.length === bindings.length &&
    entries.every((entry, index) => entry.key === bindings[index]!.key)
  );
}

function frameMatches(
  registration: PlotStageRegistrationIdentity,
  preparation: PlotStagePreparationIdentity,
): boolean {
  return (
    Object.is(
      registration.compositionFrame.width,
      preparation.compositionFrame.width,
    ) &&
    Object.is(
      registration.compositionFrame.height,
      preparation.compositionFrame.height,
    )
  );
}

function validateEntryValue(
  entry: PlotStageParamEntry,
  binding: PlotParameterBinding,
  schema: ParamSchema,
  sketchId: string,
  stageId: string,
): void {
  const spec = schema[binding.schemaKey];
  if (spec === undefined) throw stageMismatch(sketchId, stageId);

  if (spec.kind === "number") {
    if (typeof entry.value !== "number" || !Number.isFinite(entry.value)) {
      throw stageMismatch(sketchId, stageId);
    }
    return;
  }

  if (typeof entry.value !== "string") {
    throw stageMismatch(sketchId, stageId);
  }
  if (spec.kind === "choice") {
    try {
      validateChoiceParamValue(spec, entry.value, binding.schemaKey);
    } catch {
      throw stageMismatch(sketchId, stageId);
    }
  }
  if (spec.kind === "image-asset" && !isImageAssetId(entry.value)) {
    throw new TypeError(
      `Plot Stage Image Asset \`${binding.schemaKey}\` is invalid`,
    );
  }
}

function validateDependencies(
  identity: PlotStagePreparationIdentity,
  stage: PlotStageDeclaration,
  seed: string | number,
  sampledT: number,
): boolean {
  return (
    hasOwn(identity, "seed") === stage.dependencies.usesSeed &&
    (!stage.dependencies.usesSeed || Object.is(identity.seed, seed)) &&
    hasOwn(identity, "sampledT") === stage.dependencies.usesTime &&
    (!stage.dependencies.usesTime ||
      Object.is(identity.sampledT, sampledT))
  );
}

function resolvePlotStageRequest(
  identity: PlotStagePreparationIdentity,
  registrationIdentity: PlotStageRegistrationIdentity,
  seed: string | number,
  sampledT: number,
  sketchRegistry: SketchRegistry,
): ResolvedPlotStageRequest {
  const sketch = sketchRegistry.get(identity.sketchId);
  const declaration = sketch.plotSequence;
  if (declaration === undefined) {
    throw new Error(`Sketch ${sketch.id} has no Plot Sequence`);
  }
  validatePlotSequence(declaration, sketch.schema);

  const stage = findStage(declaration.stages, identity.stageId);
  if (stage.source.kind === "primary") {
    throw new Error(
      `Plot Stage \`${identity.stageId}\` is Primary and cannot use the supporting Stage worker`,
    );
  }

  const sharedBindings = declaration.sharedParameters;
  const bindings = [...sharedBindings, ...stage.parameters];
  if (
    !entriesMatchBindings(registrationIdentity.params, sharedBindings) ||
    !entriesMatchBindings(identity.params, bindings) ||
    !frameMatches(registrationIdentity, identity) ||
    !registrationIdentity.params.every((entry, index) =>
      Object.is(entry.value, identity.params[index]!.value),
    ) ||
    !validateDependencies(identity, stage, seed, sampledT)
  ) {
    throw stageMismatch(sketch.id, stage.id);
  }

  const canonicalParams = Object.create(null) as Params;
  const owningParams = Object.create(null) as Params;
  const relevantSchema: ParamSchema = {};

  for (const [index, binding] of bindings.entries()) {
    const entry = identity.params[index]!;
    validateEntryValue(
      entry,
      binding,
      sketch.schema,
      sketch.id,
      stage.id,
    );
    canonicalParams[entry.key] = entry.value;
    owningParams[binding.schemaKey] = entry.value;
    Object.defineProperty(relevantSchema, binding.schemaKey, {
      value: sketch.schema[binding.schemaKey],
      enumerable: true,
      configurable: false,
      writable: false,
    });
  }

  return {
    stage: stage as ResolvedPlotStageRequest["stage"],
    canonicalParams: Object.freeze(canonicalParams),
    owningParams,
    relevantSchema: Object.freeze(relevantSchema),
  };
}

/**
 * Resolve and execute one untrusted supporting-Stage request.
 *
 * Owning-Sketch aliases and decoded assets are reconstructed inside the worker.
 * The generator receives only the validated canonical Stage-local record plus
 * the request's unchanged Seed/time and Composition Frame.
 */
export async function handlePlotStageWorkerMessage(
  value: unknown,
  dependencies: PlotStageWorkerRuntimeDependencies = {},
): Promise<PlotStagePreparationResponse | null> {
  if (!isPlotStagePreparationRequest(value)) return null;

  try {
    const resolved = resolvePlotStageRequest(
      value.identity,
      value.registrationIdentity,
      value.seed,
      value.sampledT,
      dependencies.sketchRegistry ?? registry,
    );
    const environment = await (
      dependencies.resolveEnvironment ??
      ((schema, params) => resolveSketchEnvironment(schema, params))
    )(resolved.relevantSchema, resolved.owningParams);
    const scene: Scene = resolved.stage.source.generate(
      Object.freeze({
        params: resolved.canonicalParams,
        seed: value.seed,
        t: value.sampledT,
        frame: Object.freeze({
          width: value.identity.compositionFrame.width,
          height: value.identity.compositionFrame.height,
        }),
        environment,
      }),
    );
    const success: PlotStagePreparationSuccess = {
      type: "success",
      jobId: value.jobId,
      identity: value.identity,
      registrationIdentity: value.registrationIdentity,
      scene,
    };
    if (!isPlotStagePreparationResponse(success)) {
      throw new TypeError("Plot Stage worker produced an invalid Scene");
    }
    return success;
  } catch (error) {
    const failure: PlotStagePreparationFailure = {
      type: "failure",
      jobId: value.jobId,
      identity: value.identity,
      registrationIdentity: value.registrationIdentity,
      error: safeError(error),
    };
    if (!isPlotStagePreparationResponse(failure)) {
      throw new TypeError("Plot Stage worker produced an invalid failure");
    }
    return failure;
  }
}
