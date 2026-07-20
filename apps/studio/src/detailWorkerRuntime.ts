import {
  IMAGE_DETAIL_ANALYSIS_DEFINITION_ID,
  prepareImageDetailAnalysis,
  type DecodedPixels,
  type PreparedImageDetailAnalysis,
} from "@harness/core";

import {
  DETAIL_PREPARATION_ERROR_MAX_LENGTH,
  isDetailPreparationRequest,
  isDetailPreparationResponse,
  type DetailPreparationResponse,
} from "./detailPreparationProtocol";
import { decodeImageAsset } from "./imageAssetResolver";

export type DetailImageDecoder = (
  imageAssetId: string,
) => Promise<DecodedPixels>;
export type DetailImageAnalyzer = (
  pixels: Readonly<DecodedPixels>,
) => PreparedImageDetailAnalysis;

function safeError(error: unknown): string {
  if (error instanceof Error) {
    try {
      const message = error.message.trim();
      if (message !== "") {
        return message.slice(0, DETAIL_PREPARATION_ERROR_MAX_LENGTH);
      }
    } catch {
      // Fall through to the stable domain failure below.
    }
  }
  return "Detail preparation failed";
}

/** Resolve, decode, and prepare one validated Detail request in a worker. */
export async function handleDetailWorkerMessage(
  value: unknown,
  decode: DetailImageDecoder = decodeImageAsset,
  analyze: DetailImageAnalyzer = prepareImageDetailAnalysis,
): Promise<DetailPreparationResponse | null> {
  if (!isDetailPreparationRequest(value)) return null;

  try {
    if (
      value.identity.analysisDefinitionId !==
      IMAGE_DETAIL_ANALYSIS_DEFINITION_ID
    ) {
      throw new TypeError("Unsupported Detail analysis definition");
    }

    const pixels = await decode(value.identity.imageAssetId);
    const prepared = analyze(pixels);
    const response: DetailPreparationResponse = {
      type: "success",
      jobId: value.jobId,
      identity: value.identity,
      prepared,
    };
    if (!isDetailPreparationResponse(response)) {
      throw new TypeError("Detail worker produced an invalid result");
    }
    return response;
  } catch (error) {
    const failure: DetailPreparationResponse = {
      type: "failure",
      jobId: value.jobId,
      identity: value.identity,
      error: safeError(error),
    };
    if (!isDetailPreparationResponse(failure)) {
      throw new TypeError("Detail worker produced an invalid failure");
    }
    return failure;
  }
}
