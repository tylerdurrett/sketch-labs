import type {
  CoordinateSpace,
  HiddenLineProgress,
  ParamSchema,
  Params,
  Primitive,
  Scene,
  Seed,
} from "@harness/core";

export type OutlineParamValue = string | number | boolean | null;

export interface OutlineParamEntry {
  readonly key: string;
  readonly value: OutlineParamValue;
}

export type ImmutablePoint = Readonly<[number, number]>;

export interface ImmutablePrimitive {
  readonly points: readonly ImmutablePoint[];
  readonly closed?: boolean;
  readonly fill?: Readonly<{ color: string }>;
  readonly stroke?: Readonly<{ color: string; width: number }>;
}

export interface ImmutableScene {
  readonly space: Readonly<CoordinateSpace>;
  readonly primitives: readonly ImmutablePrimitive[];
  readonly background?: Readonly<{ color: string }>;
}

export interface OutlineComputeIdentity {
  readonly sketchId: string;
  readonly params: readonly OutlineParamEntry[];
  readonly seed: Seed;
  readonly sampledT: number;
  readonly compositionFrame: Readonly<CoordinateSpace>;
  readonly tolerance: number;
  readonly includeFrame: boolean;
  readonly sourceScene: ImmutableScene;
}

export interface OutlineComputeRequest {
  readonly type: "compute";
  readonly jobId: number;
  readonly identity: OutlineComputeIdentity;
}

export interface OutlineComputeSuccess {
  readonly type: "success";
  readonly jobId: number;
  readonly identity: OutlineComputeIdentity;
  readonly scene: Scene;
}

export interface OutlineComputeFailure {
  readonly type: "failure";
  readonly jobId: number;
  readonly identity: OutlineComputeIdentity;
  readonly error: string;
}

/** Compact, identity-free progress emitted while an Outline job is running. */
export interface OutlineComputeProgress {
  readonly type: "progress";
  readonly jobId: number;
  readonly snapshot: HiddenLineProgress;
}

export type OutlineComputeResponse =
  | OutlineComputeSuccess
  | OutlineComputeFailure;

export type OutlineWorkerMessage =
  | OutlineComputeProgress
  | OutlineComputeResponse;

interface CreateIdentityInput {
  sketchId: string;
  schema: ParamSchema;
  params: Params;
  seed: Seed;
  sampledT: number;
  compositionFrame: CoordinateSpace;
  tolerance: number;
  includeFrame: boolean;
  sourceScene: Scene;
}

const hasOwn = (value: object, key: PropertyKey): boolean =>
  Object.prototype.hasOwnProperty.call(value, key);

function copyParamValue(value: unknown, key: string): OutlineParamValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  throw new TypeError(`Outline parameter ${key} is not serializable`);
}

function copyScene(scene: Scene): ImmutableScene {
  const primitives = scene.primitives.map((primitive) => {
    const copy: {
      points: ImmutablePoint[];
      closed?: boolean;
      fill?: Readonly<{ color: string }>;
      stroke?: Readonly<{ color: string; width: number }>;
    } = {
      points: primitive.points.map(
        ([x, y]) => Object.freeze([x, y]) as ImmutablePoint,
      ),
    };
    if (typeof primitive.closed === "boolean") copy.closed = primitive.closed;
    if (hasOwn(primitive, "fill") && primitive.fill !== undefined) {
      copy.fill = Object.freeze({ color: primitive.fill.color });
    }
    if (hasOwn(primitive, "stroke") && primitive.stroke !== undefined) {
      copy.stroke = Object.freeze({
        color: primitive.stroke.color,
        width: primitive.stroke.width,
      });
    }
    Object.freeze(copy.points);
    return Object.freeze(copy);
  });
  const copy: {
    space: Readonly<CoordinateSpace>;
    primitives: readonly ImmutablePrimitive[];
    background?: Readonly<{ color: string }>;
  } = {
    space: Object.freeze({
      width: scene.space.width,
      height: scene.space.height,
    }),
    primitives: Object.freeze(primitives),
  };
  if (hasOwn(scene, "background") && scene.background !== undefined) {
    copy.background = Object.freeze({ color: scene.background.color });
  }
  return Object.freeze(copy);
}

export function createOutlineComputeIdentity(
  input: CreateIdentityInput,
): OutlineComputeIdentity {
  const params = Object.keys(input.schema)
    .sort()
    .map((key) =>
      Object.freeze({ key, value: copyParamValue(input.params[key], key) }),
    );
  const identity: OutlineComputeIdentity = Object.freeze({
    sketchId: input.sketchId,
    params: Object.freeze(params),
    seed: input.seed,
    sampledT: input.sampledT,
    compositionFrame: Object.freeze({
      width: input.compositionFrame.width,
      height: input.compositionFrame.height,
    }),
    tolerance: input.tolerance,
    includeFrame: input.includeFrame,
    sourceScene: copyScene(input.sourceScene),
  });
  if (!isOutlineComputeIdentity(identity)) {
    throw new TypeError("Outline compute identity contains an invalid value");
  }
  return identity;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isScene(value: unknown): value is Scene {
  if (!isRecord(value) || !isRecord(value.space)) return false;
  if (
    !isFiniteNumber(value.space.width) ||
    !isFiniteNumber(value.space.height) ||
    !Array.isArray(value.primitives)
  ) {
    return false;
  }
  if (hasOwn(value, "background")) {
    if (!isRecord(value.background) || typeof value.background.color !== "string") {
      return false;
    }
  }
  return value.primitives.every((candidate) => {
    if (!isRecord(candidate) || !Array.isArray(candidate.points)) return false;
    if (
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
      (!isRecord(candidate.fill) || typeof candidate.fill.color !== "string")
    ) {
      return false;
    }
    return (
      !hasOwn(candidate, "stroke") ||
      (isRecord(candidate.stroke) &&
        typeof candidate.stroke.color === "string" &&
        isFiniteNumber(candidate.stroke.width))
    );
  });
}

export function isOutlineComputeIdentity(
  value: unknown,
): value is OutlineComputeIdentity {
  if (!isRecord(value) || !Array.isArray(value.params)) return false;
  if (
    typeof value.sketchId !== "string" ||
    (typeof value.seed !== "string" && !isFiniteNumber(value.seed)) ||
    !isFiniteNumber(value.sampledT) ||
    !isRecord(value.compositionFrame) ||
    !isFiniteNumber(value.compositionFrame.width) ||
    !isFiniteNumber(value.compositionFrame.height) ||
    !isFiniteNumber(value.tolerance) ||
    typeof value.includeFrame !== "boolean" ||
    !isScene(value.sourceScene)
  ) {
    return false;
  }
  let previous: string | null = null;
  for (const entry of value.params) {
    if (
      !isRecord(entry) ||
      typeof entry.key !== "string" ||
      (previous !== null && entry.key <= previous)
    ) {
      return false;
    }
    const param = entry.value;
    if (
      param !== null &&
      typeof param !== "string" &&
      typeof param !== "boolean" &&
      !isFiniteNumber(param)
    ) {
      return false;
    }
    previous = entry.key;
  }
  return true;
}

export function isOutlineComputeRequest(
  value: unknown,
): value is OutlineComputeRequest {
  return (
    isRecord(value) &&
    value.type === "compute" &&
    Number.isSafeInteger(value.jobId) &&
    (value.jobId as number) > 0 &&
    isOutlineComputeIdentity(value.identity)
  );
}

export function isOutlineComputeResponse(
  value: unknown,
): value is OutlineComputeResponse {
  if (
    !isRecord(value) ||
    !Number.isSafeInteger(value.jobId) ||
    (value.jobId as number) <= 0 ||
    !isOutlineComputeIdentity(value.identity)
  ) {
    return false;
  }
  if (value.type === "success") return isScene(value.scene);
  return value.type === "failure" && typeof value.error === "string";
}

export function isOutlineComputeProgress(
  value: unknown,
): value is OutlineComputeProgress {
  if (
    !isRecord(value) ||
    value.type !== "progress" ||
    !Number.isSafeInteger(value.jobId) ||
    (value.jobId as number) <= 0 ||
    !isRecord(value.snapshot)
  ) {
    return false;
  }
  const completed = value.snapshot.completedWorkUnits;
  const total = value.snapshot.totalWorkUnits;
  const terminal = value.snapshot.terminal;
  return (
    isFiniteNumber(completed) &&
    isFiniteNumber(total) &&
    completed >= 0 &&
    total >= 0 &&
    completed <= total &&
    typeof terminal === "boolean" &&
    (!terminal || completed === total)
  );
}

function optionalStyleEqual(
  left: Record<string, unknown>,
  right: Record<string, unknown>,
  key: "fill" | "stroke",
): boolean {
  if (hasOwn(left, key) !== hasOwn(right, key)) return false;
  if (!hasOwn(left, key)) return true;
  const leftStyle = left[key];
  const rightStyle = right[key];
  if (!isRecord(leftStyle) || !isRecord(rightStyle)) return false;
  if (!Object.is(leftStyle.color, rightStyle.color)) return false;
  return key === "fill" || Object.is(leftStyle.width, rightStyle.width);
}

function sceneEqual(left: ImmutableScene, right: ImmutableScene): boolean {
  if (
    !Object.is(left.space.width, right.space.width) ||
    !Object.is(left.space.height, right.space.height) ||
    hasOwn(left, "background") !== hasOwn(right, "background") ||
    left.primitives.length !== right.primitives.length
  ) {
    return false;
  }
  if (
    hasOwn(left, "background") &&
    !Object.is(left.background?.color, right.background?.color)
  ) {
    return false;
  }
  return left.primitives.every((primitive, index) => {
    const other = right.primitives[index];
    if (
      other === undefined ||
      hasOwn(primitive, "closed") !== hasOwn(other, "closed") ||
      !Object.is(primitive.closed, other.closed) ||
      primitive.points.length !== other.points.length ||
      !optionalStyleEqual(
        primitive as unknown as Record<string, unknown>,
        other as unknown as Record<string, unknown>,
        "fill",
      ) ||
      !optionalStyleEqual(
        primitive as unknown as Record<string, unknown>,
        other as unknown as Record<string, unknown>,
        "stroke",
      )
    ) {
      return false;
    }
    return primitive.points.every((point, pointIndex) => {
      const otherPoint = other.points[pointIndex];
      return (
        otherPoint !== undefined &&
        Object.is(point[0], otherPoint[0]) &&
        Object.is(point[1], otherPoint[1])
      );
    });
  });
}

export function outlineComputeIdentitiesEqual(
  left: OutlineComputeIdentity,
  right: OutlineComputeIdentity,
): boolean {
  return (
    Object.is(left.sketchId, right.sketchId) &&
    Object.is(left.seed, right.seed) &&
    Object.is(left.sampledT, right.sampledT) &&
    Object.is(left.compositionFrame.width, right.compositionFrame.width) &&
    Object.is(left.compositionFrame.height, right.compositionFrame.height) &&
    Object.is(left.tolerance, right.tolerance) &&
    Object.is(left.includeFrame, right.includeFrame) &&
    left.params.length === right.params.length &&
    left.params.every((entry, index) => {
      const other = right.params[index];
      return (
        other !== undefined &&
        Object.is(entry.key, other.key) &&
        Object.is(entry.value, other.value)
      );
    }) &&
    sceneEqual(left.sourceScene, right.sourceScene)
  );
}

export function mutableScene(scene: ImmutableScene): Scene {
  const result: Scene = {
    space: { width: scene.space.width, height: scene.space.height },
    primitives: scene.primitives.map((primitive): Primitive => {
      const copy: Primitive = {
        points: primitive.points.map(([x, y]) => [x, y]),
      };
      if (typeof primitive.closed === "boolean") copy.closed = primitive.closed;
      if (primitive.fill !== undefined) {
        copy.fill = { color: primitive.fill.color };
      }
      if (primitive.stroke !== undefined) {
        copy.stroke = {
          color: primitive.stroke.color,
          width: primitive.stroke.width,
        };
      }
      return copy;
    }),
  };
  if (scene.background !== undefined) {
    result.background = { color: scene.background.color };
  }
  return result;
}
