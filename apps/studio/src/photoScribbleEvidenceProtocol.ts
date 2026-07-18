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
  readonly profile: PhotoScribbleEvidenceProfile;
}

export interface PhotoScribbleEvidenceTelemetry {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly sketchId: "photo-scribble";
  readonly imageAssetId: string;
  readonly profile: PhotoScribbleEvidenceProfile;
  readonly resolvedProductionLimits: Readonly<ScribbleExecutionLimits>;
  readonly effectiveLimits: Readonly<ScribbleExecutionLimits>;
  readonly productionResolverSelectedEffectiveTuple: boolean;
  readonly execution: Readonly<ScribbleExecutionObservation>;
  readonly productionOracle:
    | {
        readonly executed: true;
        readonly exactArtworkValueEquality: boolean;
      }
    | { readonly executed: false };
  /** Raw accepted solver segments, before smoothing. */
  readonly rawAcceptedSegments: number;
  /** Smoothed Scene points emitted after mask-safe curve refinement. */
  readonly smoothedEmittedPoints: number;
  readonly smoothedEmittedPolylines: number;
  readonly serializedArtworkBytes: number;
  /** Worker wall-clock generation duration; not a heap measurement. */
  readonly workerDurationMs: number;
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
