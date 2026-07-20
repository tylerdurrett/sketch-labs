import {
  IMAGE_DETAIL_ANALYSIS_DEFINITION_ID,
  assertPreparedImageDetailAnalysis,
  type PreparedImageDetailAnalysis,
} from "@harness/core";

import { isImageAssetId } from "./imageAssetIdentity";

/** Largest failure detail accepted across the Detail preparation boundary. */
export const DETAIL_PREPARATION_ERROR_MAX_LENGTH = 500;

/** Exact source and analyzer identities for one reusable base analysis. */
export interface DetailPreparationIdentity {
  readonly imageAssetId: string;
  readonly analysisDefinitionId: typeof IMAGE_DETAIL_ANALYSIS_DEFINITION_ID;
}

export interface CreateDetailPreparationIdentityInput {
  readonly imageAssetId: string;
  readonly analysisDefinitionId: typeof IMAGE_DETAIL_ANALYSIS_DEFINITION_ID;
}

/** Identity-only request: asset resolution and decoding remain worker concerns. */
export interface DetailPreparationRequest {
  readonly type: "compute";
  readonly jobId: number;
  readonly identity: DetailPreparationIdentity;
}

export interface DetailPreparationSuccess {
  readonly type: "success";
  readonly jobId: number;
  readonly identity: DetailPreparationIdentity;
  readonly prepared: PreparedImageDetailAnalysis;
}

export interface DetailPreparationFailure {
  readonly type: "failure";
  readonly jobId: number;
  readonly identity: DetailPreparationIdentity;
  readonly error: string;
}

export type DetailPreparationResponse =
  | DetailPreparationSuccess
  | DetailPreparationFailure;

/** Detail preparation deliberately has no progress-message variant. */
export type DetailPreparationWorkerMessage = DetailPreparationResponse;

const IDENTITY_KEYS = ["imageAssetId", "analysisDefinitionId"] as const;
const PREPARED_KEYS = [
  "definitionId",
  "sourceWidth",
  "sourceHeight",
  "gridWidth",
  "gridHeight",
  "data",
] as const;

const hasOwn = (value: object, key: PropertyKey): boolean =>
  Object.prototype.hasOwnProperty.call(value, key);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const actual = Object.keys(value);
  return (
    actual.length === keys.length &&
    keys.every((key) => hasOwn(value, key)) &&
    actual.every((key) => keys.includes(key))
  );
}

function isPositiveJobId(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function frozenIdentity(
  input: CreateDetailPreparationIdentityInput,
): DetailPreparationIdentity {
  return Object.freeze({
    imageAssetId: input.imageAssetId,
    analysisDefinitionId: input.analysisDefinitionId,
  });
}

/** Create the canonical immutable identity for one base analysis. */
export function createDetailPreparationIdentity(
  input: CreateDetailPreparationIdentityInput,
): DetailPreparationIdentity {
  if (!isDetailPreparationIdentity(input)) {
    throw new TypeError(
      "Detail preparation identity contains an invalid value",
    );
  }
  return frozenIdentity(input);
}

/** Validate and take an independent immutable identity copy. */
export function copyDetailPreparationIdentity(
  identity: DetailPreparationIdentity,
): DetailPreparationIdentity {
  if (!isDetailPreparationIdentity(identity)) {
    throw new TypeError("Cannot copy an invalid Detail preparation identity");
  }
  return frozenIdentity(identity);
}

/** Compare the complete reusable-analysis key exactly. */
export function detailPreparationIdentitiesEqual(
  left: DetailPreparationIdentity,
  right: DetailPreparationIdentity,
): boolean {
  return (
    left.imageAssetId === right.imageAssetId &&
    left.analysisDefinitionId === right.analysisDefinitionId
  );
}

export function isDetailPreparationIdentity(
  value: unknown,
): value is DetailPreparationIdentity {
  return (
    isRecord(value) &&
    hasExactKeys(value, IDENTITY_KEYS) &&
    isImageAssetId(value.imageAssetId) &&
    value.analysisDefinitionId === IMAGE_DETAIL_ANALYSIS_DEFINITION_ID
  );
}

export function isDetailPreparationRequest(
  value: unknown,
): value is DetailPreparationRequest {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["type", "jobId", "identity"]) &&
    value.type === "compute" &&
    isPositiveJobId(value.jobId) &&
    isDetailPreparationIdentity(value.identity)
  );
}

function isPreparedImageDetailAnalysis(
  value: unknown,
): value is PreparedImageDetailAnalysis {
  if (!isRecord(value) || !hasExactKeys(value, PREPARED_KEYS)) return false;

  try {
    // Core owns the complete grid, scalar, and transferable-storage contract.
    assertPreparedImageDetailAnalysis(value);
    return true;
  } catch {
    return false;
  }
}

export function isDetailPreparationSuccess(
  value: unknown,
): value is DetailPreparationSuccess {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["type", "jobId", "identity", "prepared"]) &&
    value.type === "success" &&
    isPositiveJobId(value.jobId) &&
    isDetailPreparationIdentity(value.identity) &&
    isPreparedImageDetailAnalysis(value.prepared) &&
    value.prepared.definitionId === value.identity.analysisDefinitionId
  );
}

export function isDetailPreparationFailure(
  value: unknown,
): value is DetailPreparationFailure {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["type", "jobId", "identity", "error"]) &&
    value.type === "failure" &&
    isPositiveJobId(value.jobId) &&
    isDetailPreparationIdentity(value.identity) &&
    typeof value.error === "string" &&
    value.error.trim().length > 0 &&
    value.error.length <= DETAIL_PREPARATION_ERROR_MAX_LENGTH
  );
}

export function isDetailPreparationResponse(
  value: unknown,
): value is DetailPreparationResponse {
  return isDetailPreparationSuccess(value) || isDetailPreparationFailure(value);
}

export function isDetailPreparationWorkerMessage(
  value: unknown,
): value is DetailPreparationWorkerMessage {
  return isDetailPreparationResponse(value);
}
