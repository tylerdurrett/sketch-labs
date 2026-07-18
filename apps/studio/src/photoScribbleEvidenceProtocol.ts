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
  /** Worker duration is retained only for measured, single-solve runs. */
  readonly workerDurationMs: number | null;
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

export interface MaintainerRightsAttestation {
  readonly kind: "dated-maintainer-attestation-of-ownership-and-redistribution-rights";
  readonly evidenceId: string;
  readonly attestedAt: string;
  readonly ownsEverySelectedFixture: true;
  readonly grantsRedistributionRights: true;
}

export interface ReplacementFixtureRightsRecord {
  readonly kind: "replacement-fixture-with-recorded-owned-or-compatible-license-provenance";
  readonly evidenceId: string;
  readonly fixtureIds: readonly string[];
  readonly provenanceRecord: string;
  readonly rightsBasis: "owned" | "compatible-license";
  readonly license: string | null;
}

export type PhotoScribbleRightsEvidence =
  | MaintainerRightsAttestation
  | ReplacementFixtureRightsRecord;

export interface NormalizedPhotoScribbleRightsEvidence {
  readonly type: PhotoScribbleRightsEvidence["kind"];
  readonly identifier: string;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]) {
  const actual = Object.keys(value).sort();
  return (
    actual.length === keys.length &&
    [...keys].sort().every((key, index) => actual[index] === key)
  );
}

/** Accept only the two evidence forms frozen in protocol.json. */
export function normalizePhotoScribbleRightsEvidence(
  value: unknown,
  fixtureId: string,
): NormalizedPhotoScribbleRightsEvidence {
  if (!isRecord(value) || typeof value.evidenceId !== "string") {
    throw new TypeError("Photo Scribble rights evidence is not auditable");
  }
  const identifier = value.evidenceId.trim();
  if (identifier.length < 8) {
    throw new TypeError("Photo Scribble rights evidence ID is invalid");
  }
  if (
    value.kind ===
    "dated-maintainer-attestation-of-ownership-and-redistribution-rights"
  ) {
    if (
      !exactKeys(value, [
        "kind",
        "evidenceId",
        "attestedAt",
        "ownsEverySelectedFixture",
        "grantsRedistributionRights",
      ]) ||
      typeof value.attestedAt !== "string" ||
      !/^\d{4}-\d{2}-\d{2}$/.test(value.attestedAt) ||
      !Number.isFinite(Date.parse(`${value.attestedAt}T00:00:00Z`)) ||
      value.ownsEverySelectedFixture !== true ||
      value.grantsRedistributionRights !== true
    ) {
      throw new TypeError("Maintainer rights attestation is incomplete");
    }
    return Object.freeze({ type: value.kind, identifier });
  }
  if (
    value.kind ===
    "replacement-fixture-with-recorded-owned-or-compatible-license-provenance"
  ) {
    if (
      !exactKeys(value, [
        "kind",
        "evidenceId",
        "fixtureIds",
        "provenanceRecord",
        "rightsBasis",
        "license",
      ]) ||
      !Array.isArray(value.fixtureIds) ||
      !value.fixtureIds.every(
        (candidate) => typeof candidate === "string" && candidate.length > 0,
      ) ||
      !value.fixtureIds.includes(fixtureId) ||
      typeof value.provenanceRecord !== "string" ||
      value.provenanceRecord.trim().length < 8 ||
      (value.rightsBasis !== "owned" &&
        value.rightsBasis !== "compatible-license") ||
      (value.rightsBasis === "owned"
        ? value.license !== null
        : typeof value.license !== "string" || value.license.trim().length < 2)
    ) {
      throw new TypeError("Replacement fixture rights record is incomplete");
    }
    return Object.freeze({ type: value.kind, identifier });
  }
  throw new TypeError("Photo Scribble rights evidence kind is not qualified");
}
