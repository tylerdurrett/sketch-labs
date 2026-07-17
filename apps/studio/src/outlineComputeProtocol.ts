import type {
  CoordinateSpace,
  HiddenLineRole,
  HiddenLineProgress,
  OutlineTarget,
  ParamSchema,
  Params,
  PlotProfile,
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
  readonly hiddenLineRole?: HiddenLineRole;
}

export interface ImmutableScene {
  readonly space: Readonly<CoordinateSpace>;
  readonly primitives: readonly ImmutablePrimitive[];
  readonly background?: Readonly<{ color: string }>;
}

interface OutlineComputeIdentityBase {
  readonly sketchId: string;
  readonly params: readonly OutlineParamEntry[];
  readonly seed: Seed;
  readonly sampledT: number;
  readonly compositionFrame: Readonly<CoordinateSpace>;
  readonly tolerance: number;
  readonly includeFrame: boolean;
}

export interface LegacyOutlineComputeIdentity
  extends OutlineComputeIdentityBase {
  readonly sourceKind: "legacy-scene";
  readonly sourceScene: ImmutableScene;
}

export interface SpecializedOutlineComputeIdentity
  extends OutlineComputeIdentityBase {
  readonly sourceKind: "specialized-sketch";
  readonly outlineTarget: Readonly<OutlineTarget>;
}

/** Legacy requests carry a Scene; specialized requests carry only derivation inputs. */
export type OutlineComputeIdentity =
  | LegacyOutlineComputeIdentity
  | SpecializedOutlineComputeIdentity;

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

interface CreateIdentityInputBase {
  sketchId: string;
  schema: ParamSchema;
  params: Params;
  seed: Seed;
  sampledT: number;
  compositionFrame: CoordinateSpace;
  tolerance: number;
  includeFrame: boolean;
}

type CreateLegacyIdentityInput = CreateIdentityInputBase & {
  sourceScene: Scene;
  outlineTarget?: never;
};

type CreateSpecializedIdentityInput = CreateIdentityInputBase & {
  sourceScene?: never;
  outlineTarget: OutlineTarget;
};

type CreateIdentityInput =
  | CreateLegacyIdentityInput
  | CreateSpecializedIdentityInput;

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

function copyScene(scene: Scene | ImmutableScene): ImmutableScene {
  const primitives = scene.primitives.map((primitive) => {
    const copy: {
      points: ImmutablePoint[];
      closed?: boolean;
      fill?: Readonly<{ color: string }>;
      stroke?: Readonly<{ color: string; width: number }>;
      hiddenLineRole?: HiddenLineRole;
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
    if (
      hasOwn(primitive, "hiddenLineRole") &&
      primitive.hiddenLineRole !== undefined
    ) {
      copy.hiddenLineRole = primitive.hiddenLineRole;
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

function copyIdentity(identity: OutlineComputeIdentity): OutlineComputeIdentity {
  const common = {
    sketchId: identity.sketchId,
    params: Object.freeze(
      identity.params.map((entry) =>
        Object.freeze({ key: entry.key, value: entry.value }),
      ),
    ),
    seed: identity.seed,
    sampledT: identity.sampledT,
    compositionFrame: Object.freeze({
      width: identity.compositionFrame.width,
      height: identity.compositionFrame.height,
    }),
    tolerance: identity.tolerance,
    includeFrame: identity.includeFrame,
  };
  return identity.sourceKind === "legacy-scene"
    ? Object.freeze({
        ...common,
        sourceKind: "legacy-scene",
        sourceScene: copyScene(identity.sourceScene),
      })
    : Object.freeze({
        ...common,
        sourceKind: "specialized-sketch",
        outlineTarget: Object.freeze({ ...identity.outlineTarget }),
      });
}

export function createOutlineComputeIdentity(
  input: CreateLegacyIdentityInput,
): LegacyOutlineComputeIdentity;
export function createOutlineComputeIdentity(
  input: CreateSpecializedIdentityInput,
): SpecializedOutlineComputeIdentity;
export function createOutlineComputeIdentity(
  input: CreateIdentityInput,
): OutlineComputeIdentity;
export function createOutlineComputeIdentity(
  input: CreateIdentityInput,
): OutlineComputeIdentity {
  const params = Object.keys(input.schema)
    .sort()
    .map((key) =>
      Object.freeze({ key, value: copyParamValue(input.params[key], key) }),
    );
  const common = {
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
  };
  const identity: OutlineComputeIdentity =
    input.outlineTarget === undefined
      ? Object.freeze({
          ...common,
          sourceKind: "legacy-scene",
          sourceScene: copyScene(input.sourceScene),
        })
      : Object.freeze({
          ...common,
          sourceKind: "specialized-sketch",
          outlineTarget: Object.freeze({ ...input.outlineTarget }),
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

function isHiddenLineRole(value: unknown): value is HiddenLineRole {
  return value === "source" || value === "occluder" || value === "both";
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
    if (
      hasOwn(candidate, "hiddenLineRole") &&
      !isHiddenLineRole(candidate.hiddenLineRole)
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
    typeof value.includeFrame !== "boolean"
  ) {
    return false;
  }
  if (value.sourceKind === "legacy-scene") {
    if (hasOwn(value, "outlineTarget") || !isScene(value.sourceScene)) {
      return false;
    }
  } else if (value.sourceKind === "specialized-sketch") {
    if (
      hasOwn(value, "sourceScene") ||
      !isRecord(value.outlineTarget) ||
      !isFiniteNumber(value.outlineTarget.toolWidthMillimeters) ||
      value.outlineTarget.toolWidthMillimeters <= 0 ||
      !isFiniteNumber(value.outlineTarget.millimetersPerSceneUnit) ||
      value.outlineTarget.millimetersPerSceneUnit <= 0
    ) {
      return false;
    }
  } else {
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
    typeof completed === "number" &&
    Number.isSafeInteger(completed) &&
    typeof total === "number" &&
    Number.isSafeInteger(total) &&
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
      hasOwn(primitive, "hiddenLineRole") !==
        hasOwn(other, "hiddenLineRole") ||
      !Object.is(primitive.hiddenLineRole, other.hiddenLineRole) ||
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
    left.sourceKind === right.sourceKind &&
    (left.sourceKind === "legacy-scene"
      ? right.sourceKind === "legacy-scene" &&
        sceneEqual(left.sourceScene, right.sourceScene)
      : right.sourceKind === "specialized-sketch" &&
        Object.is(
          left.outlineTarget.toolWidthMillimeters,
          right.outlineTarget.toolWidthMillimeters,
        ) &&
        Object.is(
          left.outlineTarget.millimetersPerSceneUnit,
          right.outlineTarget.millimetersPerSceneUnit,
        ))
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
      if (primitive.hiddenLineRole !== undefined) {
        copy.hiddenLineRole = primitive.hiddenLineRole;
      }
      return copy;
    }),
  };
  if (scene.background !== undefined) {
    result.background = { color: scene.background.color };
  }
  return result;
}

/** A defensive, immutable copy of the physical output profile captured at click time. */
export interface ImmutablePlotProfile {
  readonly width: number;
  readonly height: number;
  readonly insets: Readonly<PlotProfile["insets"]>;
  readonly includeFrame: boolean;
  readonly toolWidthMillimeters: number;
}

/** A completed Outline Scene that may be reused by a later job with the same identity. */
export interface CompletedOutline {
  readonly identity: OutlineComputeIdentity;
  readonly scene: ImmutableScene;
}

/**
 * Every value needed to finish a hidden-line SVG export after the initiating
 * click. Mutable Studio state is deliberately absent from this boundary.
 */
export interface HiddenLineExportSnapshot {
  readonly identity: OutlineComputeIdentity;
  readonly profile: ImmutablePlotProfile;
  readonly metadata: string;
  readonly includePaperMargins: boolean;
  readonly filename: string;
  readonly reusableOutline?: CompletedOutline;
}

export interface CreateHiddenLineExportSnapshotInput {
  identity: OutlineComputeIdentity;
  profile: PlotProfile;
  metadata: string;
  includePaperMargins: boolean;
  filename: string;
  reusableOutline?: Readonly<{
    identity: OutlineComputeIdentity;
    scene: Scene | ImmutableScene;
  }>;
}

function copyProfile(profile: PlotProfile): ImmutablePlotProfile {
  return Object.freeze({
    width: profile.width,
    height: profile.height,
    insets: Object.freeze({
      top: profile.insets.top,
      right: profile.insets.right,
      bottom: profile.insets.bottom,
      left: profile.insets.left,
    }),
    includeFrame: profile.includeFrame,
    toolWidthMillimeters: profile.toolWidthMillimeters,
  });
}

function copyCompletedOutline(
  candidate: CreateHiddenLineExportSnapshotInput["reusableOutline"],
): CompletedOutline | undefined {
  if (candidate === undefined) return undefined;
  return Object.freeze({
    identity: copyIdentity(candidate.identity),
    scene: copyScene(candidate.scene),
  });
}

/**
 * Capture an export job without retaining references to live state. A supplied
 * completed Outline is copied only when every geometry identity field matches;
 * callers cannot accidentally reuse a merely similar Scene.
 */
export function createHiddenLineExportSnapshot(
  input: CreateHiddenLineExportSnapshotInput,
): HiddenLineExportSnapshot {
  if (!isOutlineComputeIdentity(input.identity)) {
    throw new TypeError("Hidden-line export identity is invalid");
  }
  const identity = copyIdentity(input.identity);
  const matchingCandidate =
    input.reusableOutline !== undefined &&
    isOutlineComputeIdentity(input.reusableOutline.identity) &&
    outlineComputeIdentitiesEqual(identity, input.reusableOutline.identity)
      ? copyCompletedOutline(input.reusableOutline)
      : undefined;
  const snapshot: HiddenLineExportSnapshot = Object.freeze({
    identity,
    profile: copyProfile(input.profile),
    metadata: input.metadata,
    includePaperMargins: input.includePaperMargins,
    filename: input.filename,
    ...(matchingCandidate === undefined
      ? {}
      : { reusableOutline: matchingCandidate }),
  });
  if (!isHiddenLineExportSnapshot(snapshot)) {
    throw new TypeError("Hidden-line export snapshot contains an invalid value");
  }
  return snapshot;
}

function isPlotProfile(value: unknown): value is ImmutablePlotProfile {
  if (!isRecord(value) || !isRecord(value.insets)) return false;
  const width = value.width;
  const height = value.height;
  const top = value.insets.top;
  const right = value.insets.right;
  const bottom = value.insets.bottom;
  const left = value.insets.left;
  return (
    isFiniteNumber(width) &&
    width > 0 &&
    isFiniteNumber(height) &&
    height > 0 &&
    isFiniteNumber(top) &&
    top >= 0 &&
    isFiniteNumber(right) &&
    right >= 0 &&
    isFiniteNumber(bottom) &&
    bottom >= 0 &&
    isFiniteNumber(left) &&
    left >= 0 &&
    left + right < width &&
    top + bottom < height &&
    typeof value.includeFrame === "boolean" &&
    isFiniteNumber(value.toolWidthMillimeters) &&
    value.toolWidthMillimeters > 0
  );
}

export function isCompletedOutline(value: unknown): value is CompletedOutline {
  return (
    isRecord(value) &&
    isOutlineComputeIdentity(value.identity) &&
    isScene(value.scene)
  );
}

export function isHiddenLineExportSnapshot(
  value: unknown,
): value is HiddenLineExportSnapshot {
  if (
    !isRecord(value) ||
    !isOutlineComputeIdentity(value.identity) ||
    !isPlotProfile(value.profile) ||
    typeof value.metadata !== "string" ||
    typeof value.includePaperMargins !== "boolean" ||
    typeof value.filename !== "string" ||
    value.filename.trim() === ""
  ) {
    return false;
  }
  if (!hasOwn(value, "reusableOutline")) return true;
  return (
    isCompletedOutline(value.reusableOutline) &&
    outlineComputeIdentitiesEqual(
      value.identity,
      value.reusableOutline.identity,
    )
  );
}

export type HiddenLineJobKind = "preview" | "export";
export type HiddenLineJobOwner = "outline-preview" | "hidden-line-export";

interface HiddenLineRoutingEnvelope {
  readonly jobId: number;
  readonly jobKind: HiddenLineJobKind;
  readonly owner: HiddenLineJobOwner;
}

interface HiddenLineJobEnvelope {
  readonly jobId: number;
  readonly identity: OutlineComputeIdentity;
}

interface HiddenLinePreviewEnvelope extends HiddenLineJobEnvelope {
  readonly jobKind: "preview";
  readonly owner: "outline-preview";
}

interface HiddenLineExportEnvelope extends HiddenLineJobEnvelope {
  readonly jobKind: "export";
  readonly owner: "hidden-line-export";
}

export interface HiddenLinePreviewRequest extends HiddenLinePreviewEnvelope {
  readonly type: "preview";
}

export interface HiddenLineExportRequest {
  readonly type: "export";
  readonly jobKind: "export";
  readonly owner: "hidden-line-export";
  readonly jobId: number;
  readonly snapshot: HiddenLineExportSnapshot;
}

export type HiddenLineWorkerRequest =
  | HiddenLinePreviewRequest
  | HiddenLineExportRequest;

export type HiddenLineDerivationProgress =
  | (HiddenLineRoutingEnvelope & {
      readonly jobKind: "preview";
      readonly owner: "outline-preview";
      readonly type: "derivation-progress";
      readonly snapshot: HiddenLineProgress;
    })
  | (HiddenLineRoutingEnvelope & {
      readonly jobKind: "export";
      readonly owner: "hidden-line-export";
      readonly type: "derivation-progress";
      readonly snapshot: HiddenLineProgress;
    });

export interface HiddenLineFinalizing extends HiddenLineRoutingEnvelope {
  readonly type: "finalizing";
  readonly jobKind: "export";
  readonly owner: "hidden-line-export";
}

export interface HiddenLinePreviewComplete extends HiddenLinePreviewEnvelope {
  readonly type: "complete";
  readonly scene: Scene;
}

export interface HiddenLineExportComplete extends HiddenLineExportEnvelope {
  readonly type: "complete";
  readonly svg: string;
  readonly filename: string;
  readonly completedOutline: CompletedOutline;
}

export type HiddenLineJobFailure =
  | (HiddenLinePreviewEnvelope & {
      readonly type: "failure";
      readonly error: string;
    })
  | (HiddenLineExportEnvelope & {
      readonly type: "failure";
      readonly error: string;
    });

export type HiddenLineWorkerMessage =
  | HiddenLineDerivationProgress
  | HiddenLineFinalizing
  | HiddenLinePreviewComplete
  | HiddenLineExportComplete
  | HiddenLineJobFailure;

function isJobId(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function hasMatchingJobKindAndOwner(
  value: Record<string, unknown>,
): value is Record<string, unknown> & {
  jobKind: HiddenLineJobKind;
  owner: HiddenLineJobOwner;
} {
  return (
    (value.jobKind === "preview" && value.owner === "outline-preview") ||
    (value.jobKind === "export" && value.owner === "hidden-line-export")
  );
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const keys = Object.keys(value);
  return (
    keys.length === expected.length &&
    expected.every((key) => hasOwn(value, key))
  );
}

function isCompactHiddenLineProgress(
  value: Record<string, unknown>,
): boolean {
  return (
    hasExactKeys(value, [
      "type",
      "jobKind",
      "owner",
      "jobId",
      "snapshot",
    ]) &&
    hasMatchingJobKindAndOwner(value) &&
    isRecord(value.snapshot) &&
    hasExactKeys(value.snapshot, [
      "completedWorkUnits",
      "totalWorkUnits",
      "terminal",
    ]) &&
    isOutlineComputeProgress({
      type: "progress",
      jobId: value.jobId,
      snapshot: value.snapshot,
    })
  );
}

function isCompactHiddenLineFinalizing(
  value: Record<string, unknown>,
): boolean {
  return (
    hasExactKeys(value, ["type", "jobKind", "owner", "jobId"]) &&
    value.jobKind === "export" &&
    value.owner === "hidden-line-export"
  );
}

export function isHiddenLineWorkerRequest(
  value: unknown,
): value is HiddenLineWorkerRequest {
  if (!isRecord(value) || !isJobId(value.jobId)) return false;
  if (value.type === "preview") {
    return (
      value.jobKind === "preview" &&
      value.owner === "outline-preview" &&
      isOutlineComputeIdentity(value.identity)
    );
  }
  return (
    value.type === "export" &&
    value.jobKind === "export" &&
    value.owner === "hidden-line-export" &&
    isHiddenLineExportSnapshot(value.snapshot)
  );
}

export function isHiddenLineWorkerMessage(
  value: unknown,
): value is HiddenLineWorkerMessage {
  if (!isRecord(value) || !isJobId(value.jobId)) {
    return false;
  }
  if (value.type === "derivation-progress") {
    return isCompactHiddenLineProgress(value);
  }
  if (value.type === "finalizing") {
    return isCompactHiddenLineFinalizing(value);
  }
  if (
    !isOutlineComputeIdentity(value.identity) ||
    !hasMatchingJobKindAndOwner(value)
  ) {
    return false;
  }
  if (value.type === "failure") return typeof value.error === "string";
  if (value.type !== "complete") return false;
  if (value.jobKind === "preview") return isScene(value.scene);
  return (
    typeof value.svg === "string" &&
    value.svg.trim() !== "" &&
    typeof value.filename === "string" &&
    value.filename.trim() !== "" &&
    isCompletedOutline(value.completedOutline) &&
    outlineComputeIdentitiesEqual(
      value.identity,
      value.completedOutline.identity,
    )
  );
}
