// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";

import {
  type ImageAssetNormalizationBitmap,
  type ImageAssetNormalizationDependencies,
  ImageAssetNormalizationError,
  normalizeImageAsset,
  proposeImageAssetSlug,
} from "./imageAssetNormalization";
import { STUDIO_IMAGE_ASSET_LONG_EDGE_CAP } from "./studioConfig";

const PNG = new Blob([new Uint8Array([137, 80, 78, 71])], {
  type: "image/png",
});

function adapter(overrides: {
  readonly width?: number;
  readonly height?: number;
  readonly decodeError?: Error;
  readonly surfaceError?: Error;
  readonly context?: "missing" | "throw";
  readonly drawError?: Error;
  readonly encodeError?: Error;
  readonly encoded?: Blob;
  readonly events?: string[];
} = {}): {
  readonly dependencies: ImageAssetNormalizationDependencies;
  readonly bitmap: ImageAssetNormalizationBitmap;
  readonly close: ImageAssetNormalizationBitmap["close"];
} {
  const events = overrides.events ?? [];
  const close = vi.fn(() => {
    events.push("close");
  });
  const bitmap: ImageAssetNormalizationBitmap = {
    width: overrides.width ?? 4096,
    height: overrides.height ?? 2048,
    close,
  };

  return {
    bitmap,
    close,
    dependencies: {
      async createImageBitmap(source) {
        events.push(`decode:${source.type || "(empty)"}`);
        if (overrides.decodeError) throw overrides.decodeError;
        return bitmap;
      },
      createSurface(width, height) {
        events.push(`surface:${width}x${height}`);
        if (overrides.surfaceError) throw overrides.surfaceError;
        return {
          getContext(contextId, options) {
            events.push(`context:${contextId}:alpha=${String(options.alpha)}`);
            if (overrides.context === "throw") throw new Error("detail");
            if (overrides.context === "missing") return null;
            return {
              drawImage(image, x, y, drawWidth, drawHeight) {
                expect(image).toBe(bitmap);
                events.push(
                  `draw:${x},${y},${drawWidth}x${drawHeight}`,
                );
                if (overrides.drawError) throw overrides.drawError;
              },
            };
          },
          async encode(type) {
            events.push(`encode:${type}`);
            if (overrides.encodeError) throw overrides.encodeError;
            return overrides.encoded ?? PNG;
          },
        };
      },
    },
  };
}

describe("Image Asset filename proposals", () => {
  it.each([
    ["Pine Cone.HEIC", "pine-cone"],
    ["study.reference.final.webp", "study-reference-final"],
    ["extensionless portrait", "extensionless-portrait"],
    [".png", "image"],
    ["🌲.jpeg", "image"],
  ])("strips only the final extension from %s", (filename, expected) => {
    expect(proposeImageAssetSlug(filename)).toBe(expected);
  });
});

describe("browser Image Asset normalization", () => {
  it("uses the Studio default cap in the browser pipeline", async () => {
    const events: string[] = [];
    const { dependencies, close } = adapter({ events });
    const source = new Blob(["source"], { type: "image/jpeg" });

    const result = await normalizeImageAsset(
      source,
      { maxLongEdge: STUDIO_IMAGE_ASSET_LONG_EDGE_CAP },
      dependencies,
    );

    expect(result).toEqual({ png: PNG, width: 2048, height: 1024 });
    expect(events).toEqual([
      "decode:image/jpeg",
      "surface:2048x1024",
      "context:2d:alpha=true",
      "draw:0,0,2048x1024",
      "encode:image/png",
      "close",
    ]);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["wide", 4000, 1000, 1000, 1000, 250],
    ["tall", 1000, 4000, 1000, 250, 1000],
    ["odd aspect", 3000, 2000, 1001, 1001, 667],
    ["already small", 320, 200, 1000, 320, 200],
  ])(
    "contain-scales a %s image without upscaling",
    async (_case, width, height, cap, expectedWidth, expectedHeight) => {
      const { dependencies } = adapter({ width, height });

      const result = await normalizeImageAsset(
        new Blob(),
        { maxLongEdge: cap },
        dependencies,
      );

      expect(result.width).toBe(expectedWidth);
      expect(result.height).toBe(expectedHeight);
      expect(result.width / result.height).toBeCloseTo(width / height, 2);
    },
  );

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53])(
    "rejects invalid cap %s before attempting a decode",
    async (maxLongEdge) => {
      const { dependencies } = adapter();
      const decode = vi.spyOn(dependencies, "createImageBitmap");

      await expect(
        normalizeImageAsset(new Blob(), { maxLongEdge }, dependencies),
      ).rejects.toEqual(
        new ImageAssetNormalizationError("invalid-max-long-edge"),
      );
      expect(decode).not.toHaveBeenCalled();
    },
  );

  it("reports unavailable browser capabilities without decoding", async () => {
    await expect(
      normalizeImageAsset(new Blob(), { maxLongEdge: 2048 }),
    ).rejects.toEqual(
      new ImageAssetNormalizationError("capability-unavailable"),
    );
  });

  it("bounds browser decode failures and has no bitmap to clean up", async () => {
    const { dependencies, close } = adapter({
      decodeError: new Error("browser detail"),
    });

    await expect(
      normalizeImageAsset(new Blob(), { maxLongEdge: 2048 }, dependencies),
    ).rejects.toEqual(new ImageAssetNormalizationError("decode-failed"));
    expect(close).not.toHaveBeenCalled();
  });

  it.each([
    ["invalid dimensions", { width: 0 }, "invalid-dimensions"],
    [
      "surface creation",
      { surfaceError: new Error("detail") },
      "surface-failed",
    ],
    ["missing context", { context: "missing" as const }, "context-unavailable"],
    ["throwing context", { context: "throw" as const }, "context-unavailable"],
    ["drawing", { drawError: new Error("detail") }, "draw-failed"],
    ["PNG encoding", { encodeError: new Error("detail") }, "encode-failed"],
    [
      "non-PNG output",
      { encoded: new Blob(["wrong"], { type: "image/jpeg" }) },
      "encode-failed",
    ],
  ])("closes the bitmap after a %s failure", async (_case, over, code) => {
    const { dependencies, close } = adapter(over);

    await expect(
      normalizeImageAsset(new Blob(), { maxLongEdge: 2048 }, dependencies),
    ).rejects.toMatchObject({
      name: "ImageAssetNormalizationError",
      code,
    });
    expect(close).toHaveBeenCalledTimes(1);
  });

  it.each(["", "image/heic"])(
    "lets the browser decode a source with MIME %j and still encodes PNG",
    async (type) => {
      const events: string[] = [];
      const { dependencies } = adapter({
        width: 100,
        height: 50,
        events,
      });

      const result = await normalizeImageAsset(
        new Blob(["arbitrary source"], { type }),
        { maxLongEdge: 2048 },
        dependencies,
      );

      expect(result.png.type).toBe("image/png");
      expect(events[0]).toBe(`decode:${type || "(empty)"}`);
      expect(events).toContain("context:2d:alpha=true");
      expect(events).toContain("encode:image/png");
    },
  );

  it("ignores bitmap cleanup errors after successful PNG encoding", async () => {
    const { dependencies, bitmap } = adapter({ width: 10, height: 5 });
    bitmap.close = () => {
      throw new Error("cleanup detail");
    };

    await expect(
      normalizeImageAsset(new Blob(), { maxLongEdge: 10 }, dependencies),
    ).resolves.toEqual({ png: PNG, width: 10, height: 5 });
  });
});
