import {
  activeParams,
  type CoordinateSpace,
  type HiddenLineRole,
  type ParamSchema,
  type Params,
  type Scene,
  type ShadingDiagnostics,
  type ShadingProgress,
  type Seed,
  type Sketch,
} from "@harness/core";

import {
  plotStageSchemaView,
  primaryPlotStage,
} from "./plotSequenceProjection";

/** A schema-backed authored value that can cross the Worker boundary. */
export type ShadingParamValue = string | number;

export interface ShadingParamEntry {
  readonly key: string;
  readonly value: ShadingParamValue;
}

/** Every input that can change one complete Shading artwork preparation. */
export interface ShadingComputeIdentity {
  readonly sketchId: string;
  readonly params: readonly ShadingParamEntry[];
  readonly seed: Seed;
  readonly compositionFrame: Readonly<CoordinateSpace>;
}

export interface ShadingComputeRequest {
  readonly type: "compute";
  readonly jobId: number;
  readonly identity: ShadingComputeIdentity;
}

/** Compact, identity-free progress emitted while a Shading job is running. */
export interface ShadingComputeProgress {
  readonly type: "progress";
  readonly jobId: number;
  readonly snapshot: ShadingProgress;
}

export interface ShadingComputeSuccess {
  readonly type: "success";
  readonly jobId: number;
  readonly identity: ShadingComputeIdentity;
  readonly scene: Scene;
  readonly diagnostics: ShadingDiagnostics;
  readonly computeTimeMs: number;
}

export interface ShadingComputeFailure {
  readonly type: "failure";
  readonly jobId: number;
  readonly identity: ShadingComputeIdentity;
  readonly error: string;
}

export type ShadingComputeResponse =
  | ShadingComputeSuccess
  | ShadingComputeFailure;

export type ShadingWorkerMessage =
  | ShadingComputeProgress
  | ShadingComputeResponse;

export interface CreateShadingComputeIdentityInput {
  readonly sketchId: string;
  readonly schema: ParamSchema;
  readonly params: Params;
  readonly seed: Seed;
  readonly compositionFrame: CoordinateSpace;
}

export type ShadingSchemaSketch = Pick<
  Sketch,
  "schema" | "plotSequence"
>;

/**
 * Resolve the owning-Sketch schema view that affects Primary Shading.
 *
 * Sequence Sketches use the unique Primary Stage's shared-plus-owned bindings
 * in exact authored order. Ordinary Sketches retain their complete schema.
 */
export function shadingIdentitySchema(
  sketch: ShadingSchemaSketch,
): Readonly<ParamSchema> {
  if (sketch.plotSequence === undefined) {
    return plotStageSchemaView(sketch.schema, undefined);
  }
  const primary = primaryPlotStage(sketch.plotSequence);
  return plotStageSchemaView(
    sketch.schema,
    sketch.plotSequence,
    primary.id,
  );
}

/** Project active Primary Shading params without sibling-Stage values. */
export function shadingIdentityParams(
  sketch: ShadingSchemaSketch,
  params: Params,
): Readonly<Params> {
  return activeParams(shadingIdentitySchema(sketch), params);
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
  if (
    keys.length < required.length ||
    keys.length > required.length + optional.length
  ) {
    return false;
  }
  return (
    required.every((key) => hasOwn(value, key)) &&
    keys.every((key) => required.includes(key) || optional.includes(key))
  );
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isNonNegativeFiniteNumber(value: unknown): value is number {
  return isFiniteNumber(value) && value >= 0;
}

function isPositiveJobId(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function copyParamValue(
  value: unknown,
  key: string,
  spec: ParamSchema[string],
): ShadingParamValue {
  if (spec.kind === "number" && isFiniteNumber(value)) return value;
  // Every non-numeric schema value crosses this protocol as an already-
  // validated string. This keeps Color and Image Asset behavior exact while
  // allowing future schema-backed Choice strings without teaching the worker
  // protocol about Choice semantics or applicability.
  if (spec.kind !== "number" && typeof value === "string") return value;
  throw new TypeError(
    `Shading parameter ${key} does not match its ${spec.kind} schema`,
  );
}

/**
 * Snapshot active authored inputs in the Parameter Schema's declaration order.
 * Core owns applicability, Choice validation, and absent-value defaults;
 * incidental insertion order, inactive values, and Params-only extras do not
 * participate in cache identity.
 */
export function createShadingComputeIdentity(
  input: CreateShadingComputeIdentityInput,
): ShadingComputeIdentity {
  const projectedParams = activeParams(input.schema, input.params);
  const params = Object.keys(projectedParams).map((key) =>
    Object.freeze({
      key,
      value: copyParamValue(projectedParams[key], key, input.schema[key]!),
    }),
  );
  const identity = Object.freeze({
    sketchId: input.sketchId,
    params: Object.freeze(params),
    seed: input.seed,
    compositionFrame: Object.freeze({
      width: input.compositionFrame.width,
      height: input.compositionFrame.height,
    }),
  });
  if (!isShadingComputeIdentity(identity)) {
    throw new TypeError("Shading compute identity contains an invalid value");
  }
  return identity;
}

/** Make an isolated, deeply immutable copy suitable for cache ownership. */
export function copyShadingComputeIdentity(
  identity: ShadingComputeIdentity,
): ShadingComputeIdentity {
  if (!isShadingComputeIdentity(identity)) {
    throw new TypeError("Cannot copy an invalid Shading compute identity");
  }
  return Object.freeze({
    sketchId: identity.sketchId,
    params: Object.freeze(
      identity.params.map((entry) =>
        Object.freeze({ key: entry.key, value: entry.value }),
      ),
    ),
    seed: identity.seed,
    compositionFrame: Object.freeze({
      width: identity.compositionFrame.width,
      height: identity.compositionFrame.height,
    }),
  });
}

/** Compare every Shading-affecting input exactly and in canonical schema order. */
export function shadingComputeIdentitiesEqual(
  left: ShadingComputeIdentity,
  right: ShadingComputeIdentity,
): boolean {
  if (
    left.sketchId !== right.sketchId ||
    !Object.is(left.seed, right.seed) ||
    !Object.is(left.compositionFrame.width, right.compositionFrame.width) ||
    !Object.is(left.compositionFrame.height, right.compositionFrame.height) ||
    left.params.length !== right.params.length
  ) {
    return false;
  }
  return left.params.every(
    (entry, index) =>
      entry.key === right.params[index]!.key &&
      Object.is(entry.value, right.params[index]!.value),
  );
}

export function isShadingComputeIdentity(
  value: unknown,
): value is ShadingComputeIdentity {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["sketchId", "params", "seed", "compositionFrame"]) ||
    typeof value.sketchId !== "string" ||
    value.sketchId.length === 0 ||
    !Array.isArray(value.params) ||
    (typeof value.seed !== "string" && !isFiniteNumber(value.seed)) ||
    !isRecord(value.compositionFrame) ||
    !hasExactKeys(value.compositionFrame, ["width", "height"]) ||
    !isFiniteNumber(value.compositionFrame.width) ||
    value.compositionFrame.width <= 0 ||
    !isFiniteNumber(value.compositionFrame.height) ||
    value.compositionFrame.height <= 0
  ) {
    return false;
  }

  const seen = new Set<string>();
  for (const entry of value.params) {
    if (
      !isRecord(entry) ||
      !hasExactKeys(entry, ["key", "value"]) ||
      typeof entry.key !== "string" ||
      entry.key.length === 0 ||
      seen.has(entry.key) ||
      (typeof entry.value !== "string" && !isFiniteNumber(entry.value))
    ) {
      return false;
    }
    seen.add(entry.key);
  }
  return true;
}

export function isShadingComputeRequest(
  value: unknown,
): value is ShadingComputeRequest {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["type", "jobId", "identity"]) &&
    value.type === "compute" &&
    isPositiveJobId(value.jobId) &&
    isShadingComputeIdentity(value.identity)
  );
}

function isShadingProgressSnapshot(value: unknown): value is ShadingProgress {
  if (
    !isRecord(value) ||
    !hasExactKeys(
      value,
      ["completedWorkUnits", "totalWorkUnits", "terminal"],
      ["convergence"],
    ) ||
    !Number.isSafeInteger(value.completedWorkUnits) ||
    (value.completedWorkUnits as number) < 0 ||
    !Number.isSafeInteger(value.totalWorkUnits) ||
    (value.totalWorkUnits as number) < 0 ||
    (value.completedWorkUnits as number) > (value.totalWorkUnits as number) ||
    typeof value.terminal !== "boolean" ||
    (hasOwn(value, "convergence") &&
      (!isFiniteNumber(value.convergence) ||
        value.convergence < 0 ||
        value.convergence > 1))
  ) {
    return false;
  }
  return true;
}

export function isShadingComputeProgress(
  value: unknown,
): value is ShadingComputeProgress {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["type", "jobId", "snapshot"]) &&
    value.type === "progress" &&
    isPositiveJobId(value.jobId) &&
    isShadingProgressSnapshot(value.snapshot)
  );
}

function isHiddenLineRole(value: unknown): value is HiddenLineRole {
  return value === "source" || value === "occluder" || value === "both";
}

function isStrokeLineCap(
  value: unknown,
): value is "butt" | "round" | "square" {
  return value === "butt" || value === "round" || value === "square";
}

function isScene(value: unknown): value is Scene {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["space", "primitives"], ["background"]) ||
    !isRecord(value.space) ||
    !hasExactKeys(value.space, ["width", "height"]) ||
    !isFiniteNumber(value.space.width) ||
    value.space.width <= 0 ||
    !isFiniteNumber(value.space.height) ||
    value.space.height <= 0 ||
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

  return value.primitives.every((candidate) => {
    if (
      !isRecord(candidate) ||
      !hasExactKeys(
        candidate,
        ["points"],
        ["closed", "fill", "stroke", "hiddenLineRole"],
      ) ||
      !Array.isArray(candidate.points) ||
      !candidate.points.every(
        (point) =>
          Array.isArray(point) &&
          point.length === 2 &&
          isFiniteNumber(point[0]) &&
          isFiniteNumber(point[1]),
      )
    ) {
      return false;
    }
    if (hasOwn(candidate, "closed") && typeof candidate.closed !== "boolean") {
      return false;
    }
    if (
      hasOwn(candidate, "fill") &&
      (!isRecord(candidate.fill) ||
        !hasExactKeys(candidate.fill, ["color"]) ||
        typeof candidate.fill.color !== "string")
    ) {
      return false;
    }
    if (
      hasOwn(candidate, "stroke") &&
      (!isRecord(candidate.stroke) ||
        !hasExactKeys(candidate.stroke, ["color", "width"], ["lineCap"]) ||
        typeof candidate.stroke.color !== "string" ||
        !isNonNegativeFiniteNumber(candidate.stroke.width) ||
        (hasOwn(candidate.stroke, "lineCap") &&
          !isStrokeLineCap(candidate.stroke.lineCap)))
    ) {
      return false;
    }
    return (
      !hasOwn(candidate, "hiddenLineRole") ||
      isHiddenLineRole(candidate.hiddenLineRole)
    );
  });
}

function isShadingFidelity(
  value: unknown,
): value is ShadingDiagnostics["fidelity"] {
  if (!isRecord(value)) return false;

  switch (value.kind) {
    case "scribble":
      return (
        hasExactKeys(value, ["kind", "residualError"]) &&
        isFiniteNumber(value.residualError) &&
        value.residualError >= 0 &&
        value.residualError <= 1
      );
    case "stippling":
      return (
        hasExactKeys(value, ["kind", "distributionError"]) &&
        isFiniteNumber(value.distributionError) &&
        value.distributionError >= 0 &&
        value.distributionError <= 2
      );
    default:
      return false;
  }
}

function isShadingDiagnostics(value: unknown): value is ShadingDiagnostics {
  return (
    isRecord(value) &&
    hasExactKeys(value, [
      "termination",
      "pathLength",
      "polylineCount",
      "penLiftCount",
      "fidelity",
    ]) &&
    (value.termination === "completed" ||
      value.termination === "stopped-early" ||
      value.termination === "budget-exhausted") &&
    isNonNegativeFiniteNumber(value.pathLength) &&
    Number.isSafeInteger(value.polylineCount) &&
    (value.polylineCount as number) >= 0 &&
    Number.isSafeInteger(value.penLiftCount) &&
    value.penLiftCount === Math.max(0, (value.polylineCount as number) - 1) &&
    isShadingFidelity(value.fidelity)
  );
}

export function isShadingComputeSuccess(
  value: unknown,
): value is ShadingComputeSuccess {
  return (
    isRecord(value) &&
    hasExactKeys(value, [
      "type",
      "jobId",
      "identity",
      "scene",
      "diagnostics",
      "computeTimeMs",
    ]) &&
    value.type === "success" &&
    isPositiveJobId(value.jobId) &&
    isShadingComputeIdentity(value.identity) &&
    isScene(value.scene) &&
    isShadingDiagnostics(value.diagnostics) &&
    isNonNegativeFiniteNumber(value.computeTimeMs)
  );
}

export function isShadingComputeFailure(
  value: unknown,
): value is ShadingComputeFailure {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["type", "jobId", "identity", "error"]) &&
    value.type === "failure" &&
    isPositiveJobId(value.jobId) &&
    isShadingComputeIdentity(value.identity) &&
    typeof value.error === "string"
  );
}

export function isShadingComputeResponse(
  value: unknown,
): value is ShadingComputeResponse {
  return isShadingComputeSuccess(value) || isShadingComputeFailure(value);
}

export function isShadingWorkerMessage(
  value: unknown,
): value is ShadingWorkerMessage {
  return isShadingComputeProgress(value) || isShadingComputeResponse(value);
}
