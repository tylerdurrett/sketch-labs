import { describe, expect, it, vi } from "vitest";

import {
  IMAGE_DETAIL_ANALYSIS_DEFINITION_ID,
  type DecodedPixels,
  type PreparedImageDetailAnalysis,
} from "@harness/core";

import {
  createDetailPreparationIdentity,
  type DetailPreparationRequest,
} from "./detailPreparationProtocol";
import { handleDetailWorkerMessage } from "./detailWorkerRuntime";

const identity = createDetailPreparationIdentity({
  imageAssetId: "pinecone-4330aa0314f7",
  analysisDefinitionId: IMAGE_DETAIL_ANALYSIS_DEFINITION_ID,
});

function request(): DetailPreparationRequest {
  return { type: "compute", jobId: 7, identity };
}

function prepared(value = 0.25): PreparedImageDetailAnalysis {
  return {
    definitionId: IMAGE_DETAIL_ANALYSIS_DEFINITION_ID,
    sourceWidth: 1,
    sourceHeight: 1,
    gridWidth: 1,
    gridHeight: 1,
    data: new Float64Array([value]),
  };
}

describe("Detail worker runtime", () => {
  it("decodes the stable asset independently and analyzes worker-owned pixels", async () => {
    const pixels: DecodedPixels = {
      width: 1,
      height: 1,
      data: new Uint8ClampedArray([1, 2, 3, 255]),
    };
    const decode = vi.fn(async () => pixels);
    const analyze = vi.fn(() => prepared());

    await expect(
      handleDetailWorkerMessage(request(), decode, analyze),
    ).resolves.toEqual({
      type: "success",
      jobId: 7,
      identity,
      prepared: prepared(),
    });
    expect(decode).toHaveBeenCalledWith(identity.imageAssetId);
    expect(analyze).toHaveBeenCalledWith(pixels);
  });

  it.each([null, {}, { type: "compute" }, { type: "preview" }])(
    "rejects malformed input before decoding: %o",
    async (candidate) => {
      const decode = vi.fn();
      const analyze = vi.fn();
      await expect(
        handleDetailWorkerMessage(candidate, decode, analyze),
      ).resolves.toBeNull();
      expect(decode).not.toHaveBeenCalled();
      expect(analyze).not.toHaveBeenCalled();
    },
  );

  it.each([
    [
      "decode",
      vi.fn(async () => {
        throw new Error("d".repeat(600));
      }),
      vi.fn(),
    ],
    [
      "analyze",
      vi.fn(async () => ({
        width: 1,
        height: 1,
        data: new Uint8ClampedArray(4),
      })),
      vi.fn(() => {
        throw new Error("analysis failed");
      }),
    ],
  ])("returns a bounded %s failure", async (_kind, decode, analyze) => {
    const response = await handleDetailWorkerMessage(
      request(),
      decode,
      analyze,
    );
    expect(response).toMatchObject({
      type: "failure",
      jobId: 7,
      identity,
      error: expect.any(String),
    });
    expect(
      response?.type === "failure" && response.error.length,
    ).toBeLessThanOrEqual(500);
  });

  it("turns a malformed prepared success into a validated failure", async () => {
    const response = await handleDetailWorkerMessage(
      request(),
      async () => ({
        width: 1,
        height: 1,
        data: new Uint8ClampedArray(4),
      }),
      () => ({ ...prepared(), data: new Float64Array([2]) }),
    );

    expect(response).toEqual({
      type: "failure",
      jobId: 7,
      identity,
      error: "Detail worker produced an invalid result",
    });
  });
});
