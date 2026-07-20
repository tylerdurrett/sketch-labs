import type {
  CoordinateSpace,
  HiddenLineRole,
  ParamSchema,
  Params,
  Scene,
  ScribbleDiagnostics,
  ScribbleProgress,
  Seed,
} from "@harness/core";

/** A schema-backed authored value that can cross the Worker boundary. */
export type ScribbleParamValue = string | number;

export interface ScribbleParamEntry {
  readonly key: string;
  readonly value: ScribbleParamValue;
}

/** Every input that can change one complete Scribble artwork preparation. */
export interface ScribbleComputeIdentity {
  readonly sketchId: string;
  readonly params: readonly ScribbleParamEntry[];
  readonly seed: Seed;
  readonly compositionFrame: Readonly<CoordinateSpace>;
}

export interface ScribbleComputeRequest {
  readonly type: "compute";
  readonly jobId: number;
  readonly identity: ScribbleComputeIdentity;
}

/** Compact, identity-free progress emitted while a Scribble job is running. */
export interface ScribbleComputeProgress {
  readonly type: "progress";
  readonly jobId: number;
  readonly snapshot: ScribbleProgress;
}

export interface ScribbleComputeSuccess {
  readonly type: "success";
  readonly jobId: number;
  readonly identity: ScribbleComputeIdentity;
  readonly scene: Scene;
  readonly diagnostics: ScribbleDiagnostics;
  readonly computeTimeMs: number;
}

export interface ScribbleComputeFailure {
  readonly type: "failure";
  readonly jobId: number;
  readonly identity: ScribbleComputeIdentity;
  readonly error: string;
}

export type ScribbleComputeResponse =
  | ScribbleComputeSuccess
  | ScribbleComputeFailure;

export type ScribbleWorkerMessage =
  | ScribbleComputeProgress
  | ScribbleComputeResponse;

export interface CreateScribbleComputeIdentityInput {
  readonly sketchId: string;
  readonly schema: ParamSchema;
  readonly params: Params;
  readonly seed: Seed;
  readonly compositionFrame: CoordinateSpace;
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
): ScribbleParamValue {
  if (spec.kind === "number" && isFiniteNumber(value)) return value;
  if (spec.kind === "color" && typeof value === "string") return value;
  if (spec.kind === "image-asset" && typeof value === "string") return value;
  throw new TypeError(
    `Scribble parameter ${key} does not match its ${spec.kind} schema`,
  );
}

/**
 * Snapshot authored inputs in the Parameter Schema's canonical declaration order.
 * Incidental insertion order and extra keys in the inhabited params object do not
 * participate in cache identity.
 */
export function createScribbleComputeIdentity(
  input: CreateScribbleComputeIdentityInput,
): ScribbleComputeIdentity {
  const params = Object.keys(input.schema).map((key) =>
    Object.freeze({
      key,
      value: copyParamValue(input.params[key], key, input.schema[key]!),
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
  if (!isScribbleComputeIdentity(identity)) {
    throw new TypeError("Scribble compute identity contains an invalid value");
  }
  return identity;
}

/** Make an isolated, deeply immutable copy suitable for cache ownership. */
export function copyScribbleComputeIdentity(
  identity: ScribbleComputeIdentity,
): ScribbleComputeIdentity {
  if (!isScribbleComputeIdentity(identity)) {
    throw new TypeError("Cannot copy an invalid Scribble compute identity");
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

/** Compare every Scribble-affecting input exactly and in canonical schema order. */
export function scribbleComputeIdentitiesEqual(
  left: ScribbleComputeIdentity,
  right: ScribbleComputeIdentity,
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

export function isScribbleComputeIdentity(
  value: unknown,
): value is ScribbleComputeIdentity {
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

export function isScribbleComputeRequest(
  value: unknown,
): value is ScribbleComputeRequest {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["type", "jobId", "identity"]) &&
    value.type === "compute" &&
    isPositiveJobId(value.jobId) &&
    isScribbleComputeIdentity(value.identity)
  );
}

function isScribbleProgressSnapshot(value: unknown): value is ScribbleProgress {
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

export function isScribbleComputeProgress(
  value: unknown,
): value is ScribbleComputeProgress {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["type", "jobId", "snapshot"]) &&
    value.type === "progress" &&
    isPositiveJobId(value.jobId) &&
    isScribbleProgressSnapshot(value.snapshot)
  );
}

function isHiddenLineRole(value: unknown): value is HiddenLineRole {
  return value === "source" || value === "occluder" || value === "both";
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
        !hasExactKeys(candidate.stroke, ["color", "width"]) ||
        typeof candidate.stroke.color !== "string" ||
        !isNonNegativeFiniteNumber(candidate.stroke.width))
    ) {
      return false;
    }
    return (
      !hasOwn(candidate, "hiddenLineRole") ||
      isHiddenLineRole(candidate.hiddenLineRole)
    );
  });
}

function isScribbleDiagnostics(value: unknown): value is ScribbleDiagnostics {
  return (
    isRecord(value) &&
    hasExactKeys(value, [
      "termination",
      "residualError",
      "pathLength",
      "polylineCount",
      "penLiftCount",
    ]) &&
    (value.termination === "completed" ||
      value.termination === "stopped-early" ||
      value.termination === "budget-exhausted") &&
    isFiniteNumber(value.residualError) &&
    value.residualError >= 0 &&
    value.residualError <= 1 &&
    isNonNegativeFiniteNumber(value.pathLength) &&
    Number.isSafeInteger(value.polylineCount) &&
    (value.polylineCount as number) >= 0 &&
    Number.isSafeInteger(value.penLiftCount) &&
    value.penLiftCount === Math.max(0, (value.polylineCount as number) - 1)
  );
}

export function isScribbleComputeSuccess(
  value: unknown,
): value is ScribbleComputeSuccess {
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
    isScribbleComputeIdentity(value.identity) &&
    isScene(value.scene) &&
    isScribbleDiagnostics(value.diagnostics) &&
    isNonNegativeFiniteNumber(value.computeTimeMs)
  );
}

export function isScribbleComputeFailure(
  value: unknown,
): value is ScribbleComputeFailure {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["type", "jobId", "identity", "error"]) &&
    value.type === "failure" &&
    isPositiveJobId(value.jobId) &&
    isScribbleComputeIdentity(value.identity) &&
    typeof value.error === "string"
  );
}

export function isScribbleComputeResponse(
  value: unknown,
): value is ScribbleComputeResponse {
  return isScribbleComputeSuccess(value) || isScribbleComputeFailure(value);
}

export function isScribbleWorkerMessage(
  value: unknown,
): value is ScribbleWorkerMessage {
  return isScribbleComputeProgress(value) || isScribbleComputeResponse(value);
}
