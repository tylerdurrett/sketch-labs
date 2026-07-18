// @vitest-environment jsdom
import type { ParamSchema } from "@harness/core";
import { describe, expect, it, vi } from "vitest";

import {
  decodeImageAsset,
  imageAssetIdSetKey,
  type ImageAssetBitmap,
  type ImageAssetResolverDependencies,
  requiredImageAssetIds,
  resolveSketchEnvironment,
} from "./imageAssetResolver";

const ID = "pine-cone-0123456789ab";
const SECOND_ID = "portrait-abcdef012345";
const BLOB = new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" });
const PIXELS = new Uint8ClampedArray([1, 2, 3, 4, 5, 6, 7, 8]);

function adapter(overrides: {
  readonly ok?: boolean;
  readonly status?: number;
  readonly width?: number;
  readonly height?: number;
  readonly pixels?: Uint8ClampedArray;
  readonly context?: "missing" | "throw";
  readonly drawError?: Error;
  readonly readError?: Error;
  readonly surfaceError?: Error;
  readonly events?: string[];
} = {}): {
  dependencies: ImageAssetResolverDependencies;
  bitmap: ImageAssetBitmap;
  close: ImageAssetBitmap["close"];
} {
  const events = overrides.events ?? [];
  const close = vi.fn(() => {
    events.push("close");
  });
  const bitmap: ImageAssetBitmap = {
    width: overrides.width ?? 2,
    height: overrides.height ?? 1,
    close,
  };

  return {
    bitmap,
    close,
    dependencies: {
      async fetch(url) {
        events.push(`fetch:${url}`);
        return {
          ok: overrides.ok ?? true,
          status: overrides.status ?? (overrides.ok === false ? 500 : 200),
          async blob() {
            events.push("blob");
            return BLOB;
          },
        };
      },
      async createImageBitmap(blob) {
        expect(blob).toBe(BLOB);
        events.push("bitmap");
        return bitmap;
      },
      createSurface(width, height) {
        events.push(`surface:${width}x${height}`);
        if (overrides.surfaceError) throw overrides.surfaceError;
        return {
          getContext(contextId) {
            events.push(`context:${contextId}`);
            if (overrides.context === "throw") throw new Error("adapter detail");
            if (overrides.context === "missing") return null;
            return {
              drawImage(image, x, y) {
                expect(image).toBe(bitmap);
                events.push(`draw:${x},${y}`);
                if (overrides.drawError) throw overrides.drawError;
              },
              getImageData(x, y, readWidth, readHeight) {
                events.push(
                  `read:${x},${y},${readWidth}x${readHeight}`,
                );
                if (overrides.readError) throw overrides.readError;
                return { data: overrides.pixels ?? PIXELS };
              },
            };
          },
        };
      },
    },
  };
}

describe("browser Image Asset decoding", () => {
  it("fails boundedly when jsdom has no real browser decoding capabilities", async () => {
    await expect(decodeImageAsset(ID)).rejects.toMatchObject({
      name: "ImageAssetResolutionError",
      code: "capability-unavailable",
      assetId: ID,
      message: "Browser image decoding is unavailable",
    });
  });

  it("runs the exact browser pipeline with decoded dimensions and owned bytes", async () => {
    const events: string[] = [];
    const { dependencies } = adapter({ events });

    const decoded = await decodeImageAsset(ID, dependencies);

    expect(events).toEqual([
      `fetch:/image-assets/${ID}.png`,
      "blob",
      "bitmap",
      "surface:2x1",
      "context:2d",
      "draw:0,0",
      "read:0,0,2x1",
      "close",
    ]);
    expect(decoded).toEqual({ width: 2, height: 1, data: PIXELS });
    expect(decoded.data).not.toBe(PIXELS);
  });

  it.each([
    ["invalid dimensions", { width: 0 }, "invalid-dimensions"],
    ["surface creation", { surfaceError: new Error("detail") }, "surface-failed"],
    ["missing context", { context: "missing" as const }, "context-unavailable"],
    ["throwing context", { context: "throw" as const }, "context-unavailable"],
    ["draw", { drawError: new Error("detail") }, "readback-failed"],
    ["readback", { readError: new Error("detail") }, "readback-failed"],
    [
      "wrong byte count",
      { pixels: new Uint8ClampedArray([1, 2, 3, 4]) },
      "readback-failed",
    ],
  ])("closes the bitmap after a %s failure", async (_case, over, code) => {
    const { dependencies, close } = adapter(over);

    await expect(decodeImageAsset(ID, dependencies)).rejects.toMatchObject({
      name: "ImageAssetResolutionError",
      code,
    });
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("does not fetch a noncanonical ID and leaves the failure bounded", async () => {
    const { dependencies, close } = adapter();
    const fetch = vi.spyOn(dependencies, "fetch");

    await expect(
      decodeImageAsset("../private.png", dependencies),
    ).rejects.toMatchObject({
      name: "ImageAssetResolutionError",
      code: "invalid-id",
      assetId: "../private.png",
      message: "Image Asset ID is invalid",
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
  });

  it("reports non-ok fetches without reading or decoding the response", async () => {
    const { dependencies, close } = adapter({ ok: false });
    const createBitmap = vi.spyOn(dependencies, "createImageBitmap");

    await expect(decodeImageAsset(ID, dependencies)).rejects.toMatchObject({
      name: "ImageAssetResolutionError",
      code: "fetch-failed",
      assetId: ID,
      message: "Image Asset fetch failed",
    });
    expect(createBitmap).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
  });

  it("classifies only an HTTP 404 as missing and preserves the exact ID", async () => {
    const missing = adapter({ ok: false, status: 404 });
    const failed = adapter({ ok: false, status: 410 });

    await expect(
      decodeImageAsset(ID, missing.dependencies),
    ).rejects.toMatchObject({
      name: "ImageAssetResolutionError",
      code: "missing",
      assetId: ID,
      message: "Image Asset is missing",
    });
    await expect(
      decodeImageAsset(ID, failed.dependencies),
    ).rejects.toMatchObject({
      name: "ImageAssetResolutionError",
      code: "fetch-failed",
      assetId: ID,
      message: "Image Asset fetch failed",
    });
  });
});

describe("schema Image Asset resolution", () => {
  const schema = {
    density: { kind: "number", default: 1, min: 0, max: 2, step: 1 },
    source: { kind: "image-asset", default: ID },
    repeated: { kind: "image-asset", default: ID },
    overlay: { kind: "image-asset", default: SECOND_ID },
  } satisfies ParamSchema;

  it("extracts effective IDs in declaration order and deduplicates exactly", () => {
    const params = {
      overlay: ID,
      source: SECOND_ID,
      repeated: SECOND_ID,
      unrelated: "not-an-asset",
    };
    const before = structuredClone(params);

    expect(requiredImageAssetIds(schema, params)).toEqual([SECOND_ID, ID]);
    expect(params).toEqual(before);
    expect(requiredImageAssetIds(schema, { source: 42 })).toEqual([
      ID,
      SECOND_ID,
    ]);
  });

  it("keys exact ID sets without ordering or boundary ambiguity", () => {
    expect(imageAssetIdSetKey([SECOND_ID, ID, SECOND_ID])).toBe(
      imageAssetIdSetKey([ID, SECOND_ID]),
    );
    expect(imageAssetIdSetKey(["a,b", "c"])).not.toBe(
      imageAssetIdSetKey(["a", "b,c"]),
    );
    expect(imageAssetIdSetKey(["A"])).not.toBe(imageAssetIdSetKey(["a"]));
  });

  it("creates independent environments with equal bytes and distinct ownership", async () => {
    const firstAdapter = adapter();
    const secondAdapter = adapter();
    const singleSchema = {
      source: { kind: "image-asset", default: ID },
    } satisfies ParamSchema;

    const first = await resolveSketchEnvironment(
      singleSchema,
      {},
      firstAdapter.dependencies,
    );
    const second = await resolveSketchEnvironment(
      singleSchema,
      {},
      secondAdapter.dependencies,
    );
    const firstRecord = first.imageAssets(ID)!;
    const secondRecord = second.imageAssets(ID)!;

    expect(firstRecord).toEqual(secondRecord);
    expect(firstRecord).not.toBe(secondRecord);
    expect(firstRecord.data).not.toBe(secondRecord.data);
    expect(first.imageAssets(ID)).toBe(firstRecord);
    expect(first.imageAssets("missing-abcdef012345")).toBeUndefined();
    expect(firstAdapter.close).toHaveBeenCalledTimes(1);
    expect(secondAdapter.close).toHaveBeenCalledTimes(1);
  });

  it("identifies the exact failing ID when resolving several assets", async () => {
    const { dependencies } = adapter({ ok: false, status: 404 });

    await expect(
      resolveSketchEnvironment(schema, {}, dependencies),
    ).rejects.toMatchObject({
      name: "ImageAssetResolutionError",
      code: "missing",
      assetId: ID,
      message: "Image Asset is missing",
    });
  });
});
