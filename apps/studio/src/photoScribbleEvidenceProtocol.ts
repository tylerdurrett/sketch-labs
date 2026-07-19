import type { ScribbleExecutionLimits } from "../../../packages/core/src/scribbleStrategy/orchestrator";
import type { ScribbleExecutionObservation } from "../../../packages/core/src/scribbleStrategy/orchestrator";

export type PhotoScribbleEvidenceProfile =
  | { readonly kind: "production" }
  | {
      readonly kind: "injected";
      readonly candidateId: string;
      readonly limits: Readonly<ScribbleExecutionLimits>;
    };

export interface PhotoScribbleEvidenceWorkerConfig {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly telemetryChannel: string;
  readonly purpose: "measurement" | "equivalence-proof";
  readonly profile: PhotoScribbleEvidenceProfile;
}

export interface PhotoScribbleEvidenceTelemetry {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly sketchId: "photo-scribble";
  readonly imageAssetId: string;
  readonly profile: PhotoScribbleEvidenceProfile;
  readonly resolvedProductionLimits: Readonly<ScribbleExecutionLimits> | null;
  readonly effectiveLimits: Readonly<ScribbleExecutionLimits> | null;
  readonly productionResolverSelectedEffectiveTuple: boolean | null;
  readonly purpose: "measurement" | "equivalence-proof";
  /** Unavailable for the uninstrumented registered production generator. */
  readonly execution: Readonly<ScribbleExecutionObservation> | null;
  /** Raw accepted solver segments, before smoothing. */
  readonly rawAcceptedSegments: number | null;
  /** Smoothed Scene points emitted after mask-safe curve refinement. */
  readonly smoothedEmittedPoints: number;
  readonly smoothedEmittedPolylines: number;
  readonly serializedArtworkBytes: number;
  /** Canonical production target; null only for the one-pass measured production generator. */
  readonly targetHash: string | null;
  /** Worker duration is retained only for measured, single-solve runs. */
  readonly workerDurationMs: number | null;
  /** The evidence executor admits exactly one source/model preparation per run. */
  readonly preparationCount: 1;
  /** The evidence executor admits exactly one solver pass per run. */
  readonly solverPassCount: 1;
  /** Epoch proxy sampled immediately before the product response is posted. */
  readonly responseReadyEpochMs: number;
}

const hasOwn = (value: object, key: PropertyKey): boolean =>
  Object.prototype.hasOwnProperty.call(value, key);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parsePhotoScribbleEvidenceWorkerConfig(
  value: string,
): PhotoScribbleEvidenceWorkerConfig {
  const parsed: unknown = JSON.parse(value);
  if (
    !isRecord(parsed) ||
    parsed.schemaVersion !== 1 ||
    typeof parsed.runId !== "string" ||
    parsed.runId.length === 0 ||
    typeof parsed.telemetryChannel !== "string" ||
    parsed.telemetryChannel.length === 0 ||
    (parsed.purpose !== "measurement" &&
      parsed.purpose !== "equivalence-proof") ||
    !isRecord(parsed.profile) ||
    (parsed.profile.kind !== "production" &&
      parsed.profile.kind !== "injected")
  ) {
    throw new TypeError("Invalid Photo Scribble evidence Worker config");
  }
  if (
    parsed.profile.kind === "injected" &&
    (!hasOwn(parsed.profile, "limits") ||
      !hasOwn(parsed.profile, "candidateId"))
  ) {
    throw new TypeError("Injected Photo Scribble evidence profile is incomplete");
  }
  return parsed as unknown as PhotoScribbleEvidenceWorkerConfig;
}
