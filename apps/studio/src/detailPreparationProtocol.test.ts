import {
  IMAGE_DETAIL_ANALYSIS_DEFINITION_ID,
  type PreparedImageDetailAnalysis,
} from "@harness/core";
import { describe, expect, it } from "vitest";

import {
  DETAIL_PREPARATION_ERROR_MAX_LENGTH,
  copyDetailPreparationIdentity,
  createDetailPreparationIdentity,
  detailPreparationIdentitiesEqual,
  isDetailPreparationFailure,
  isDetailPreparationIdentity,
  isDetailPreparationRequest,
  isDetailPreparationResponse,
  isDetailPreparationSuccess,
  isDetailPreparationWorkerMessage,
  type DetailPreparationIdentity,
  type DetailPreparationRequest,
  type DetailPreparationSuccess,
} from "./detailPreparationProtocol";

const ASSET_ID = "pinecone-4330aa0314f7";
const OTHER_ASSET_ID = "other-image-0123456789ab";

function identity(imageAssetId = ASSET_ID): DetailPreparationIdentity {
  return createDetailPreparationIdentity({
    imageAssetId,
    analysisDefinitionId: IMAGE_DETAIL_ANALYSIS_DEFINITION_ID,
  });
}

function prepared(
  overrides: Partial<PreparedImageDetailAnalysis> = {},
): PreparedImageDetailAnalysis {
  return {
    definitionId: IMAGE_DETAIL_ANALYSIS_DEFINITION_ID,
    sourceWidth: 2,
    sourceHeight: 1,
    gridWidth: 2,
    gridHeight: 1,
    data: new Float64Array([0, 1]),
    ...overrides,
  };
}

function success(
  overrides: Partial<DetailPreparationSuccess> = {},
): DetailPreparationSuccess {
  return {
    type: "success",
    jobId: 1,
    identity: identity(),
    prepared: prepared(),
    ...overrides,
  };
}

describe("Detail preparation identity", () => {
  it("creates a canonical frozen identity and copies it independently", () => {
    const original = identity();
    const copy = copyDetailPreparationIdentity(original);

    expect(original).toEqual({
      imageAssetId: ASSET_ID,
      analysisDefinitionId: IMAGE_DETAIL_ANALYSIS_DEFINITION_ID,
    });
    expect(copy).toEqual(original);
    expect(copy).not.toBe(original);
    expect(Object.isFrozen(original)).toBe(true);
    expect(Object.isFrozen(copy)).toBe(true);
  });

  it("compares both exact identity fields", () => {
    expect(detailPreparationIdentitiesEqual(identity(), identity())).toBe(true);
    expect(
      detailPreparationIdentitiesEqual(identity(), identity(OTHER_ASSET_ID)),
    ).toBe(false);
    expect(
      detailPreparationIdentitiesEqual(identity(), {
        ...identity(),
        analysisDefinitionId: "other-definition",
      } as unknown as DetailPreparationIdentity),
    ).toBe(false);
  });

  it.each([
    [
      "missing asset",
      { analysisDefinitionId: IMAGE_DETAIL_ANALYSIS_DEFINITION_ID },
    ],
    ["extra key", { ...identity(), extra: true }],
    ["empty asset", { ...identity(), imageAssetId: "" }],
    ["noncanonical asset", { ...identity(), imageAssetId: "Pine Cone.png" }],
    ["wrong definition", { ...identity(), analysisDefinitionId: "v2" }],
  ])("rejects %s", (_case, candidate) => {
    expect(isDetailPreparationIdentity(candidate)).toBe(false);
    expect(() =>
      createDetailPreparationIdentity(
        candidate as unknown as Parameters<
          typeof createDetailPreparationIdentity
        >[0],
      ),
    ).toThrow(/invalid value/);
    expect(() =>
      copyDetailPreparationIdentity(
        candidate as unknown as DetailPreparationIdentity,
      ),
    ).toThrow(/invalid Detail preparation identity/);
  });
});

describe("Detail preparation request", () => {
  it("accepts only an identity payload and survives serialization exactly", () => {
    const request: DetailPreparationRequest = {
      type: "compute",
      jobId: 7,
      identity: identity(),
    };
    const serialized = JSON.parse(JSON.stringify(request)) as unknown;

    expect(isDetailPreparationRequest(serialized)).toBe(true);
    expect(serialized).toEqual({
      type: "compute",
      jobId: 7,
      identity: {
        imageAssetId: ASSET_ID,
        analysisDefinitionId: IMAGE_DETAIL_ANALYSIS_DEFINITION_ID,
      },
    });
    expect(JSON.stringify(serialized)).not.toMatch(
      /params|pixels|raster|frame|sensitivity|tone|seed|progress|time/i,
    );
  });

  it.each([
    ["missing identity", { type: "compute", jobId: 1 }],
    [
      "extra payload",
      { type: "compute", jobId: 1, identity: identity(), pixels: [] },
    ],
    ["wrong type", { type: "progress", jobId: 1, identity: identity() }],
    ["zero job", { type: "compute", jobId: 0, identity: identity() }],
    ["fractional job", { type: "compute", jobId: 1.5, identity: identity() }],
    [
      "unsafe job",
      {
        type: "compute",
        jobId: Number.MAX_SAFE_INTEGER + 1,
        identity: identity(),
      },
    ],
    [
      "wrong identity",
      {
        type: "compute",
        jobId: 1,
        identity: { ...identity(), imageAssetId: "wrong" },
      },
    ],
  ])("rejects %s", (_case, candidate) => {
    expect(isDetailPreparationRequest(candidate)).toBe(false);
  });
});

describe("Detail preparation success", () => {
  it("accepts the exact identity and core-validated prepared analysis", () => {
    const message = success();

    expect(isDetailPreparationSuccess(message)).toBe(true);
    expect(isDetailPreparationResponse(message)).toBe(true);
    expect(isDetailPreparationWorkerMessage(message)).toBe(true);
  });

  it.each([
    ["missing prepared", { type: "success", jobId: 1, identity: identity() }],
    ["extra top-level key", { ...success(), computeTimeMs: 10 }],
    ["wrong type", { ...success(), type: "progress" }],
    ["wrong job", { ...success(), jobId: -1 }],
    [
      "wrong identity",
      { ...success(), identity: { ...identity(), analysisDefinitionId: "v2" } },
    ],
    [
      "wrong prepared definition",
      success({
        prepared: prepared({
          definitionId: "other-definition",
        } as unknown as Partial<PreparedImageDetailAnalysis>),
      }),
    ],
    [
      "missing prepared key",
      (() => {
        const { gridHeight: _, ...rest } = prepared();
        return success({ prepared: rest as PreparedImageDetailAnalysis });
      })(),
    ],
    [
      "extra prepared key",
      success({
        prepared: {
          ...prepared(),
          raster: true,
        } as unknown as PreparedImageDetailAnalysis,
      }),
    ],
  ])("rejects %s", (_case, candidate) => {
    expect(isDetailPreparationSuccess(candidate)).toBe(false);
  });

  it.each([
    ["wrong positive grid/source relationship", { gridWidth: 1 }],
    [
      "unsafe source product",
      { sourceWidth: Number.MAX_SAFE_INTEGER, sourceHeight: 2 },
    ],
    [
      "unsafe grid product",
      { gridWidth: Number.MAX_SAFE_INTEGER, gridHeight: 2 },
    ],
    ["short scalar storage", { data: new Float64Array([0]) }],
    ["negative scalar", { data: new Float64Array([-0.01, 1]) }],
    ["scalar above one", { data: new Float64Array([0, 1.01]) }],
    ["non-finite scalar", { data: new Float64Array([0, Number.NaN]) }],
  ])(
    "converts core rejection of %s to protocol-invalid",
    (_case, overrides) => {
      expect(
        isDetailPreparationSuccess(success({ prepared: prepared(overrides) })),
      ).toBe(false);
    },
  );

  it("rejects detached, shared, wrong, offset, and subclassed storage", () => {
    const detached = new Float64Array([0, 1]);
    structuredClone(detached.buffer, { transfer: [detached.buffer] });

    class DerivedFloat64Array extends Float64Array {}

    const candidates = [
      detached,
      new Float64Array(new SharedArrayBuffer(16)),
      new Float32Array([0, 1]),
      new Float64Array(new ArrayBuffer(24), 8, 2),
      new DerivedFloat64Array([0, 1]),
    ];
    for (const data of candidates) {
      expect(
        isDetailPreparationSuccess(
          success({
            prepared: prepared({
              data: data as unknown as Float64Array,
            }),
          }),
        ),
      ).toBe(false);
    }
  });
});

describe("Detail preparation failure", () => {
  it("accepts one nonempty bounded failure and no progress variant", () => {
    const failure = {
      type: "failure",
      jobId: 3,
      identity: identity(),
      error: "Analysis failed",
    };

    expect(DETAIL_PREPARATION_ERROR_MAX_LENGTH).toBe(500);
    expect(isDetailPreparationFailure(failure)).toBe(true);
    expect(isDetailPreparationResponse(failure)).toBe(true);
    expect(isDetailPreparationWorkerMessage(failure)).toBe(true);
    expect(
      isDetailPreparationWorkerMessage({
        type: "progress",
        jobId: 3,
        snapshot: { completedWorkUnits: 1 },
      }),
    ).toBe(false);
  });

  it.each([
    ["missing error", { type: "failure", jobId: 1, identity: identity() }],
    [
      "extra key",
      {
        type: "failure",
        jobId: 1,
        identity: identity(),
        error: "failed",
        detail: true,
      },
    ],
    [
      "empty error",
      { type: "failure", jobId: 1, identity: identity(), error: "" },
    ],
    [
      "blank error",
      { type: "failure", jobId: 1, identity: identity(), error: " \n " },
    ],
    [
      "overlong error",
      {
        type: "failure",
        jobId: 1,
        identity: identity(),
        error: "x".repeat(DETAIL_PREPARATION_ERROR_MAX_LENGTH + 1),
      },
    ],
    [
      "wrong job",
      {
        type: "failure",
        jobId: Number.POSITIVE_INFINITY,
        identity: identity(),
        error: "failed",
      },
    ],
    [
      "wrong identity",
      {
        type: "failure",
        jobId: 1,
        identity: { ...identity(), imageAssetId: "wrong" },
        error: "failed",
      },
    ],
  ])("rejects %s", (_case, candidate) => {
    expect(isDetailPreparationFailure(candidate)).toBe(false);
    expect(isDetailPreparationResponse(candidate)).toBe(false);
  });

  it("accepts the exact failure length ceiling", () => {
    expect(
      isDetailPreparationFailure({
        type: "failure",
        jobId: 1,
        identity: identity(),
        error: "x".repeat(DETAIL_PREPARATION_ERROR_MAX_LENGTH),
      }),
    ).toBe(true);
  });
});
