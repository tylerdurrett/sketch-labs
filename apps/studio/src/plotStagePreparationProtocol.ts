import {
  validateChoiceParamValue,
  validatePlotSequence,
  type CoordinateSpace,
  type ParamSchema,
  type Params,
  type PlotParameterBinding,
  type PlotSequenceDeclaration,
  type PlotStageDeclaration,
  type Scene,
  type Seed,
} from "@harness/core";

/** Largest failure detail accepted across the supporting-Stage boundary. */
export const PLOT_STAGE_PREPARATION_ERROR_MAX_LENGTH = 500;

/** A schema-backed canonical Stage value that can cross a Worker boundary. */
export type PlotStageParamValue = string | number;

export interface PlotStageParamEntry {
  readonly key: string;
  readonly value: PlotStageParamValue;
}

/** Shared source and coordinate identity used to register prepared Stages. */
export interface PlotStageRegistrationIdentity {
  readonly params: readonly PlotStageParamEntry[];
  readonly compositionFrame: Readonly<CoordinateSpace>;
}

/** Inputs that make one uniquely addressed supporting Stage current. */
export interface PlotStagePreparationIdentity {
  readonly sketchId: string;
  readonly stageId: string;
  /** Shared entries followed by Stage-owned entries in declaration order. */
  readonly params: readonly PlotStageParamEntry[];
  readonly compositionFrame: Readonly<CoordinateSpace>;
  readonly seed?: Seed;
  readonly sampledT?: number;
}

export interface PlotStagePreparationRequest {
  readonly type: "compute";
  readonly jobId: number;
  readonly identity: PlotStagePreparationIdentity;
  readonly registrationIdentity: PlotStageRegistrationIdentity;
  /**
   * Complete invocation values. Dependency metadata controls retained identity,
   * never the values handed unchanged to the generator.
   */
  readonly seed: Seed;
  readonly sampledT: number;
}

export interface PlotStagePreparationSuccess {
  readonly type: "success";
  readonly jobId: number;
  readonly identity: PlotStagePreparationIdentity;
  readonly registrationIdentity: PlotStageRegistrationIdentity;
  /** Ordinary unfinalized Scene geometry; Stage output styling is downstream. */
  readonly scene: Scene;
}

export interface PlotStagePreparationFailure {
  readonly type: "failure";
  readonly jobId: number;
  readonly identity: PlotStagePreparationIdentity;
  readonly registrationIdentity: PlotStageRegistrationIdentity;
  readonly error: string;
}

export type PlotStagePreparationResponse =
  | PlotStagePreparationSuccess
  | PlotStagePreparationFailure;

/**
 * Supporting Stage preparation is indeterminate. There is deliberately no
 * percentage/progress variant in this protocol.
 */
export type PlotStageWorkerMessage = PlotStagePreparationResponse;

export interface CreatePlotStageRegistrationIdentityInput {
  readonly schema: ParamSchema;
  readonly declaration: PlotSequenceDeclaration;
  readonly params: Readonly<Params>;
  readonly compositionFrame: Readonly<CoordinateSpace>;
}

export interface CreatePlotStagePreparationIdentityInput
  extends CreatePlotStageRegistrationIdentityInput {
  readonly sketchId: string;
  readonly stageId: string;
  readonly seed: Seed;
  readonly sampledT: number;
}

const hasOwn = (value: object, key: PropertyKey): boolean =>
  Object.prototype.hasOwnProperty.call(value, key);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const keys = Object.keys(value);
  return (
    keys.length >= required.length &&
    keys.length <= required.length + optional.length &&
    required.every((key) => hasOwn(value, key)) &&
    keys.every((key) => required.includes(key) || optional.includes(key))
  );
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isSeed(value: unknown): value is Seed {
  return typeof value === "string" || isFiniteNumber(value);
}

function isPositiveJobId(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function isCompositionFrame(value: unknown): value is CoordinateSpace {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["width", "height"]) &&
    isFiniteNumber(value.width) &&
    value.width > 0 &&
    isFiniteNumber(value.height) &&
    value.height > 0
  );
}

function copyFrame(
  frame: Readonly<CoordinateSpace>,
): Readonly<CoordinateSpace> {
  const copy = Object.freeze({ width: frame.width, height: frame.height });
  if (!isCompositionFrame(copy)) {
    throw new TypeError("Plot Stage Composition Frame is invalid");
  }
  return copy;
}

function stageById(
  declaration: PlotSequenceDeclaration,
  stageId: string,
): PlotStageDeclaration {
  const stage = declaration.stages.find((candidate) => candidate.id === stageId);
  if (stage === undefined) {
    throw new Error(`Plot Stage preparation: missing Stage \`${stageId}\``);
  }
  return stage;
}

function valueForBinding(
  schema: ParamSchema,
  params: Readonly<Params>,
  binding: PlotParameterBinding,
): PlotStageParamValue {
  const spec = schema[binding.schemaKey];
  if (spec === undefined) {
    throw new Error(
      `Plot Stage preparation: unknown schema key \`${binding.schemaKey}\``,
    );
  }
  const value = hasOwn(params, binding.schemaKey)
    ? params[binding.schemaKey]
    : spec.default;

  if (spec.kind === "number") {
    if (!isFiniteNumber(value)) {
      throw new TypeError(
        `Plot Stage parameter ${binding.schemaKey} must be finite`,
      );
    }
    return value;
  }
  if (spec.kind === "choice") {
    return validateChoiceParamValue(spec, value, binding.schemaKey);
  }
  if (typeof value !== "string") {
    throw new TypeError(
      `Plot Stage parameter ${binding.schemaKey} must be a string`,
    );
  }
  return value;
}

function entriesForBindings(
  schema: ParamSchema,
  params: Readonly<Params>,
  bindings: readonly PlotParameterBinding[],
): readonly PlotStageParamEntry[] {
  return Object.freeze(
    bindings.map((binding) =>
      Object.freeze({
        key: binding.key,
        value: valueForBinding(schema, params, binding),
      }),
    ),
  );
}

/** Create the shared-only registration key in authored binding order. */
export function createPlotStageRegistrationIdentity(
  input: CreatePlotStageRegistrationIdentityInput,
): PlotStageRegistrationIdentity {
  validatePlotSequence(input.declaration, input.schema);
  const identity = Object.freeze({
    params: entriesForBindings(
      input.schema,
      input.params,
      input.declaration.sharedParameters,
    ),
    compositionFrame: copyFrame(input.compositionFrame),
  });
  if (!isPlotStageRegistrationIdentity(identity)) {
    throw new TypeError("Plot Stage registration identity is invalid");
  }
  return identity;
}

/**
 * Create one retained supporting-Stage key. Seed/time appear only when the
 * addressed Stage declares that dependency.
 */
export function createPlotStagePreparationIdentity(
  input: CreatePlotStagePreparationIdentityInput,
): PlotStagePreparationIdentity {
  validatePlotSequence(input.declaration, input.schema);
  if (input.sketchId.trim().length === 0 || input.stageId.trim().length === 0) {
    throw new TypeError("Plot Stage identity requires Sketch and Stage ids");
  }
  if (!isSeed(input.seed) || !isFiniteNumber(input.sampledT)) {
    throw new TypeError("Plot Stage invocation Seed/time is invalid");
  }

  const stage = stageById(input.declaration, input.stageId);
  const identity = Object.freeze({
    sketchId: input.sketchId,
    stageId: input.stageId,
    params: entriesForBindings(input.schema, input.params, [
      ...input.declaration.sharedParameters,
      ...stage.parameters,
    ]),
    compositionFrame: copyFrame(input.compositionFrame),
    ...(stage.dependencies.usesSeed ? { seed: input.seed } : {}),
    ...(stage.dependencies.usesTime ? { sampledT: input.sampledT } : {}),
  });
  if (!isPlotStagePreparationIdentity(identity)) {
    throw new TypeError("Plot Stage preparation identity is invalid");
  }
  return identity;
}

function isPlotStageParamEntries(
  value: unknown,
): value is readonly PlotStageParamEntry[] {
  if (!Array.isArray(value)) return false;

  const seen = new Set<string>();
  for (const entry of value) {
    if (
      !isRecord(entry) ||
      !hasExactKeys(entry, ["key", "value"]) ||
      typeof entry.key !== "string" ||
      entry.key.trim().length === 0 ||
      seen.has(entry.key) ||
      (typeof entry.value !== "string" && !isFiniteNumber(entry.value))
    ) {
      return false;
    }
    seen.add(entry.key);
  }
  return true;
}

export function isPlotStageRegistrationIdentity(
  value: unknown,
): value is PlotStageRegistrationIdentity {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["params", "compositionFrame"]) &&
    isPlotStageParamEntries(value.params) &&
    isCompositionFrame(value.compositionFrame)
  );
}

export function isPlotStagePreparationIdentity(
  value: unknown,
): value is PlotStagePreparationIdentity {
  return (
    isRecord(value) &&
    hasExactKeys(
      value,
      ["sketchId", "stageId", "params", "compositionFrame"],
      ["seed", "sampledT"],
    ) &&
    typeof value.sketchId === "string" &&
    value.sketchId.trim().length > 0 &&
    typeof value.stageId === "string" &&
    value.stageId.trim().length > 0 &&
    isPlotStageParamEntries(value.params) &&
    isCompositionFrame(value.compositionFrame) &&
    (!hasOwn(value, "seed") || isSeed(value.seed)) &&
    (!hasOwn(value, "sampledT") || isFiniteNumber(value.sampledT))
  );
}

function paramEntriesEqual(
  left: readonly PlotStageParamEntry[],
  right: readonly PlotStageParamEntry[],
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (entry, index) =>
        entry.key === right[index]!.key &&
        Object.is(entry.value, right[index]!.value),
    )
  );
}

export function plotStageRegistrationIdentitiesEqual(
  left: PlotStageRegistrationIdentity,
  right: PlotStageRegistrationIdentity,
): boolean {
  return (
    Object.is(
      left.compositionFrame.width,
      right.compositionFrame.width,
    ) &&
    Object.is(
      left.compositionFrame.height,
      right.compositionFrame.height,
    ) &&
    paramEntriesEqual(left.params, right.params)
  );
}

export function plotStagePreparationIdentitiesEqual(
  left: PlotStagePreparationIdentity,
  right: PlotStagePreparationIdentity,
): boolean {
  return (
    left.sketchId === right.sketchId &&
    left.stageId === right.stageId &&
    Object.is(
      left.compositionFrame.width,
      right.compositionFrame.width,
    ) &&
    Object.is(
      left.compositionFrame.height,
      right.compositionFrame.height,
    ) &&
    hasOwn(left, "seed") === hasOwn(right, "seed") &&
    Object.is(left.seed, right.seed) &&
    hasOwn(left, "sampledT") === hasOwn(right, "sampledT") &&
    Object.is(left.sampledT, right.sampledT) &&
    paramEntriesEqual(left.params, right.params)
  );
}

export function copyPlotStageRegistrationIdentity(
  identity: PlotStageRegistrationIdentity,
): PlotStageRegistrationIdentity {
  if (!isPlotStageRegistrationIdentity(identity)) {
    throw new TypeError("Cannot copy invalid Plot Stage registration identity");
  }
  return Object.freeze({
    params: Object.freeze(
      identity.params.map((entry) =>
        Object.freeze({ key: entry.key, value: entry.value }),
      ),
    ),
    compositionFrame: copyFrame(identity.compositionFrame),
  });
}

export function copyPlotStagePreparationIdentity(
  identity: PlotStagePreparationIdentity,
): PlotStagePreparationIdentity {
  if (!isPlotStagePreparationIdentity(identity)) {
    throw new TypeError("Cannot copy invalid Plot Stage preparation identity");
  }
  return Object.freeze({
    sketchId: identity.sketchId,
    stageId: identity.stageId,
    params: Object.freeze(
      identity.params.map((entry) =>
        Object.freeze({ key: entry.key, value: entry.value }),
      ),
    ),
    compositionFrame: copyFrame(identity.compositionFrame),
    ...(hasOwn(identity, "seed") ? { seed: identity.seed } : {}),
    ...(hasOwn(identity, "sampledT")
      ? { sampledT: identity.sampledT }
      : {}),
  });
}

function registrationMatchesPreparation(
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
    ) &&
    registration.params.length <= preparation.params.length &&
    registration.params.every(
      (entry, index) =>
        entry.key === preparation.params[index]!.key &&
        Object.is(entry.value, preparation.params[index]!.value),
    )
  );
}

export function isPlotStagePreparationRequest(
  value: unknown,
): value is PlotStagePreparationRequest {
  return (
    isRecord(value) &&
    hasExactKeys(value, [
      "type",
      "jobId",
      "identity",
      "registrationIdentity",
      "seed",
      "sampledT",
    ]) &&
    value.type === "compute" &&
    isPositiveJobId(value.jobId) &&
    isPlotStagePreparationIdentity(value.identity) &&
    isPlotStageRegistrationIdentity(value.registrationIdentity) &&
    registrationMatchesPreparation(
      value.registrationIdentity,
      value.identity,
    ) &&
    isSeed(value.seed) &&
    isFiniteNumber(value.sampledT)
  );
}

function isHiddenLineRole(value: unknown): boolean {
  return value === "source" || value === "occluder" || value === "both";
}

function isScene(value: unknown): value is Scene {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["space", "primitives"], ["background"]) ||
    !isCompositionFrame(value.space) ||
    !Array.isArray(value.primitives)
  ) {
    return false;
  }
  if (
    hasOwn(value, "background") &&
    (!isRecord(value.background) ||
      !hasExactKeys(value.background, ["color"]) ||
      typeof value.background.color !== "string")
  ) {
    return false;
  }

  return value.primitives.every((primitive) => {
    if (
      !isRecord(primitive) ||
      !hasExactKeys(
        primitive,
        ["points"],
        ["closed", "fill", "stroke", "hiddenLineRole"],
      ) ||
      !Array.isArray(primitive.points) ||
      !primitive.points.every(
        (point) =>
          Array.isArray(point) &&
          point.length === 2 &&
          isFiniteNumber(point[0]) &&
          isFiniteNumber(point[1]),
      ) ||
      (hasOwn(primitive, "closed") &&
        typeof primitive.closed !== "boolean") ||
      (hasOwn(primitive, "fill") &&
        (!isRecord(primitive.fill) ||
          !hasExactKeys(primitive.fill, ["color"]) ||
          typeof primitive.fill.color !== "string")) ||
      (hasOwn(primitive, "stroke") &&
        (!isRecord(primitive.stroke) ||
          !hasExactKeys(primitive.stroke, ["color", "width"], ["lineCap"]) ||
          typeof primitive.stroke.color !== "string" ||
          !isFiniteNumber(primitive.stroke.width) ||
          primitive.stroke.width < 0 ||
          (hasOwn(primitive.stroke, "lineCap") &&
            primitive.stroke.lineCap !== "butt" &&
            primitive.stroke.lineCap !== "round" &&
            primitive.stroke.lineCap !== "square"))) ||
      (hasOwn(primitive, "hiddenLineRole") &&
        !isHiddenLineRole(primitive.hiddenLineRole))
    ) {
      return false;
    }
    return true;
  });
}

export function isPlotStagePreparationSuccess(
  value: unknown,
): value is PlotStagePreparationSuccess {
  return (
    isRecord(value) &&
    hasExactKeys(value, [
      "type",
      "jobId",
      "identity",
      "registrationIdentity",
      "scene",
    ]) &&
    value.type === "success" &&
    isPositiveJobId(value.jobId) &&
    isPlotStagePreparationIdentity(value.identity) &&
    isPlotStageRegistrationIdentity(value.registrationIdentity) &&
    registrationMatchesPreparation(
      value.registrationIdentity,
      value.identity,
    ) &&
    isScene(value.scene) &&
    Object.is(
      value.scene.space.width,
      value.identity.compositionFrame.width,
    ) &&
    Object.is(
      value.scene.space.height,
      value.identity.compositionFrame.height,
    )
  );
}

export function isPlotStagePreparationFailure(
  value: unknown,
): value is PlotStagePreparationFailure {
  return (
    isRecord(value) &&
    hasExactKeys(value, [
      "type",
      "jobId",
      "identity",
      "registrationIdentity",
      "error",
    ]) &&
    value.type === "failure" &&
    isPositiveJobId(value.jobId) &&
    isPlotStagePreparationIdentity(value.identity) &&
    isPlotStageRegistrationIdentity(value.registrationIdentity) &&
    registrationMatchesPreparation(
      value.registrationIdentity,
      value.identity,
    ) &&
    typeof value.error === "string" &&
    value.error.trim().length > 0 &&
    value.error.length <= PLOT_STAGE_PREPARATION_ERROR_MAX_LENGTH
  );
}

export function isPlotStagePreparationResponse(
  value: unknown,
): value is PlotStagePreparationResponse {
  return (
    isPlotStagePreparationSuccess(value) ||
    isPlotStagePreparationFailure(value)
  );
}

export function isPlotStageWorkerMessage(
  value: unknown,
): value is PlotStageWorkerMessage {
  return isPlotStagePreparationResponse(value);
}
