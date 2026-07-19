import { describe, expect, it } from "vitest";

import type { ParamSchema } from "@harness/core";

import { imageAssetIdSetKey } from "./imageAssetResolver";
import { exactEnvironmentReady } from "./exactEnvironmentReadiness";

const schema = {
  first: { kind: "image-asset", default: "asset-a" },
  amount: { kind: "number", min: 0, max: 1, default: 0.5 },
  second: { kind: "image-asset", default: "asset-b" },
} satisfies ParamSchema;

describe("exactEnvironmentReady", () => {
  it("requires resolved readiness for the exact current authored ID set", () => {
    const resolutionKey = imageAssetIdSetKey(["asset-a", "asset-b"]);
    const resolved = {
      status: "resolved" as const,
      ready: true,
      resolutionKey,
    };

    expect(
      exactEnvironmentReady(
        schema,
        { first: "asset-a", amount: 1, second: "asset-b" },
        resolved,
      ),
    ).toBe(true);
    expect(
      exactEnvironmentReady(
        schema,
        { first: "asset-c", amount: 1, second: "asset-b" },
        resolved,
      ),
    ).toBe(false);
    expect(
      exactEnvironmentReady(schema, {}, { ...resolved, ready: false }),
    ).toBe(false);
    expect(
      exactEnvironmentReady(schema, {}, { ...resolved, status: "loading" }),
    ).toBe(false);
  });

  it("keeps asset-free authored state synchronously ready", () => {
    expect(
      exactEnvironmentReady(
        { amount: schema.amount },
        { amount: 0.75 },
        {
          status: "resolved",
          ready: true,
          resolutionKey: imageAssetIdSetKey([]),
        },
      ),
    ).toBe(true);
  });
});
