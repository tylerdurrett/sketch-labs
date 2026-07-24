import {
  activeParams,
  type CoordinateSpace,
  type HiddenLineRole,
  type ParamSchema,
  type Params,
  type Scene,
  type Seed,
} from "@harness/core";

export const FLOWING_CONTOURS_SKETCH_ID = "flowing-contours";
export const FLOWING_CONTOURS_COMPUTE_ERROR_MAX_LENGTH = 500;

export type FlowingContoursParamValue = string | number;

export interface FlowingContoursParamEntry {
  readonly key: string;
  readonly value: FlowingContoursParamValue;
}

/** Every authored input that can change Flowing Contours' static Scene. */
export interface FlowingContoursComputeIdentity {
  readonly sketchId: typeof FLOWING_CONTOURS_SKETCH_ID;
  readonly params: readonly FlowingContoursParamEntry[];
  readonly seed: Seed;
  readonly compositionFrame: Readonly<CoordinateSpace>;
}

export interface FlowingContoursComputeRequest {
  readonly type: "compute";
  readonly jobId: number;
  readonly identity: FlowingContoursComputeIdentity;
}

export interface FlowingContoursComputeSuccess {
  readonly type: "success";
  readonly jobId: number;
  readonly identity: FlowingContoursComputeIdentity;
  readonly scene: Scene;
  readonly computeTimeMs: number;
}

export interface FlowingContoursComputeFailure {
  readonly type: "failure";
  readonly jobId: number;
  readonly identity: FlowingContoursComputeIdentity;
  readonly error: string;
}

export type FlowingContoursComputeResponse =
  | FlowingContoursComputeSuccess
  | FlowingContoursComputeFailure;

export interface CreateFlowingContoursComputeIdentityInput {
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
): FlowingContoursParamValue {
  if (spec.kind === "number" && isFiniteNumber(value)) return value;
  if (spec.kind !== "number" && typeof value === "string") return value;
  throw new TypeError(
    `Flowing Contours parameter ${key} does not match its ${spec.kind} schema`,
  );
}

/**
 * Project active values in schema declaration order. The Image Asset remains
 * an ordinary stable ID; decoded pixels never cross this protocol.
 */
export function createFlowingContoursComputeIdentity(
  input: CreateFlowingContoursComputeIdentityInput,
): FlowingContoursComputeIdentity {
  if (input.sketchId !== FLOWING_CONTOURS_SKETCH_ID) {
    throw new TypeError("Flowing Contours worker requires its registered id");
  }
  const projected = activeParams(input.schema, input.params);
  const identity = Object.freeze({
    sketchId: FLOWING_CONTOURS_SKETCH_ID,
    params: Object.freeze(
      Object.keys(projected).map((key) =>
        Object.freeze({
          key,
          value: copyParamValue(projected[key], key, input.schema[key]!),
        }),
      ),
    ),
    seed: input.seed,
    compositionFrame: Object.freeze({
      width: input.compositionFrame.width,
      height: input.compositionFrame.height,
    }),
  });
  if (!isFlowingContoursComputeIdentity(identity)) {
    throw new TypeError(
      "Flowing Contours compute identity contains an invalid value",
    );
  }
  return identity;
}

export function copyFlowingContoursComputeIdentity(
  identity: FlowingContoursComputeIdentity,
): FlowingContoursComputeIdentity {
  if (!isFlowingContoursComputeIdentity(identity)) {
    throw new TypeError("Cannot copy an invalid Flowing Contours identity");
  }
  return Object.freeze({
    sketchId: FLOWING_CONTOURS_SKETCH_ID,
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

export function flowingContoursComputeIdentitiesEqual(
  left: FlowingContoursComputeIdentity,
  right: FlowingContoursComputeIdentity,
): boolean {
  return (
    left.sketchId === right.sketchId &&
    Object.is(left.seed, right.seed) &&
    Object.is(left.compositionFrame.width, right.compositionFrame.width) &&
    Object.is(left.compositionFrame.height, right.compositionFrame.height) &&
    left.params.length === right.params.length &&
    left.params.every(
      (entry, index) =>
        entry.key === right.params[index]!.key &&
        Object.is(entry.value, right.params[index]!.value),
    )
  );
}

export function isFlowingContoursComputeIdentity(
  value: unknown,
): value is FlowingContoursComputeIdentity {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["sketchId", "params", "seed", "compositionFrame"]) ||
    value.sketchId !== FLOWING_CONTOURS_SKETCH_ID ||
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

export function isFlowingContoursComputeRequest(
  value: unknown,
): value is FlowingContoursComputeRequest {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["type", "jobId", "identity"]) &&
    value.type === "compute" &&
    isPositiveJobId(value.jobId) &&
    isFlowingContoursComputeIdentity(value.identity)
  );
}

function isHiddenLineRole(value: unknown): value is HiddenLineRole {
  return value === "source" || value === "occluder" || value === "both";
}

function isLineCap(value: unknown): value is "butt" | "round" | "square" {
  return value === "butt" || value === "round" || value === "square";
}

/** Strict structured-clone validation for worker-owned generic Scene output. */
export function isFlowingContoursScene(value: unknown): value is Scene {
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
      )
    ) {
      return false;
    }
    if (hasOwn(primitive, "closed") && typeof primitive.closed !== "boolean") {
      return false;
    }
    if (
      hasOwn(primitive, "fill") &&
      (!isRecord(primitive.fill) ||
        !hasExactKeys(primitive.fill, ["color"]) ||
        typeof primitive.fill.color !== "string")
    ) {
      return false;
    }
    if (
      hasOwn(primitive, "stroke") &&
      (!isRecord(primitive.stroke) ||
        !hasExactKeys(primitive.stroke, ["color", "width"], ["lineCap"]) ||
        typeof primitive.stroke.color !== "string" ||
        !isNonNegativeFiniteNumber(primitive.stroke.width) ||
        (hasOwn(primitive.stroke, "lineCap") &&
          !isLineCap(primitive.stroke.lineCap)))
    ) {
      return false;
    }
    return (
      !hasOwn(primitive, "hiddenLineRole") ||
      isHiddenLineRole(primitive.hiddenLineRole)
    );
  });
}

export function isFlowingContoursComputeSuccess(
  value: unknown,
): value is FlowingContoursComputeSuccess {
  return (
    isRecord(value) &&
    hasExactKeys(value, [
      "type",
      "jobId",
      "identity",
      "scene",
      "computeTimeMs",
    ]) &&
    value.type === "success" &&
    isPositiveJobId(value.jobId) &&
    isFlowingContoursComputeIdentity(value.identity) &&
    isFlowingContoursScene(value.scene) &&
    isNonNegativeFiniteNumber(value.computeTimeMs) &&
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

export function isFlowingContoursComputeFailure(
  value: unknown,
): value is FlowingContoursComputeFailure {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["type", "jobId", "identity", "error"]) &&
    value.type === "failure" &&
    isPositiveJobId(value.jobId) &&
    isFlowingContoursComputeIdentity(value.identity) &&
    typeof value.error === "string" &&
    value.error.trim().length > 0 &&
    value.error.length <= FLOWING_CONTOURS_COMPUTE_ERROR_MAX_LENGTH
  );
}

export function isFlowingContoursComputeResponse(
  value: unknown,
): value is FlowingContoursComputeResponse {
  return (
    isFlowingContoursComputeSuccess(value) ||
    isFlowingContoursComputeFailure(value)
  );
}
