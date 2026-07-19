import type {
  DecodedPixels,
  ParamSchema,
  Params,
  SketchEnvironment,
} from "@harness/core";

import { imageAssetUrl } from "./imageAssetIdentity";

/** Stable failure categories callers can use without inspecting browser errors. */
export type ImageAssetResolutionErrorCode =
  | "invalid-id"
  | "missing"
  | "capability-unavailable"
  | "fetch-failed"
  | "response-failed"
  | "decode-failed"
  | "invalid-dimensions"
  | "surface-failed"
  | "context-unavailable"
  | "readback-failed"
  | "resolution-failed";

const ERROR_MESSAGES: Record<ImageAssetResolutionErrorCode, string> = {
  "invalid-id": "Image Asset ID is invalid",
  missing: "Image Asset is missing",
  "capability-unavailable": "Browser image decoding is unavailable",
  "fetch-failed": "Image Asset fetch failed",
  "response-failed": "Image Asset response could not be read",
  "decode-failed": "Image Asset could not be decoded",
  "invalid-dimensions": "Decoded Image Asset dimensions are invalid",
  "surface-failed": "Image Asset decode surface could not be created",
  "context-unavailable": "Image Asset decode context is unavailable",
  "readback-failed": "Decoded Image Asset pixels could not be read",
  "resolution-failed": "Image Asset resolution failed",
};

/** A bounded, browser-detail-free Image Asset resolution failure. */
export class ImageAssetResolutionError extends Error {
  readonly code: ImageAssetResolutionErrorCode;
  /** Exact authored ID whose resolution failed; never a repaired substitute. */
  readonly assetId: string | undefined;

  constructor(code: ImageAssetResolutionErrorCode, assetId?: string) {
    super(ERROR_MESSAGES[code]);
    this.name = "ImageAssetResolutionError";
    this.code = code;
    this.assetId = assetId;
  }
}

/** Minimal browser response seam used by the resolver's unit adapters. */
export interface ImageAssetFetchResponse {
  readonly ok: boolean;
  readonly status: number;
  blob(): Promise<Blob>;
}

/** Minimal decoded bitmap seam shared by Window and DedicatedWorker runtimes. */
export interface ImageAssetBitmap {
  readonly width: number;
  readonly height: number;
  close(): void;
}

/** Minimal 2D readback context seam used by the resolver's unit adapters. */
export interface ImageAssetReadbackContext {
  drawImage(image: ImageAssetBitmap, x: number, y: number): void;
  getImageData(
    x: number,
    y: number,
    width: number,
    height: number,
  ): { readonly data: Uint8ClampedArray };
}

/** Minimal OffscreenCanvas seam used by the resolver's unit adapters. */
export interface ImageAssetSurface {
  getContext(contextId: "2d"): ImageAssetReadbackContext | null;
}

/** Injectable browser operations; production defaults use global browser APIs. */
export interface ImageAssetResolverDependencies {
  fetch(url: string, signal?: AbortSignal): Promise<ImageAssetFetchResponse>;
  createImageBitmap(blob: Blob): Promise<ImageAssetBitmap>;
  createSurface(width: number, height: number): ImageAssetSurface;
}

function resolutionError(
  code: ImageAssetResolutionErrorCode,
  assetId?: string,
): ImageAssetResolutionError {
  return new ImageAssetResolutionError(code, assetId);
}

function browserDependencies(): ImageAssetResolverDependencies {
  const browser = globalThis as typeof globalThis & {
    OffscreenCanvas?: typeof OffscreenCanvas;
  };

  if (
    typeof browser.fetch !== "function" ||
    typeof browser.createImageBitmap !== "function" ||
    typeof browser.OffscreenCanvas !== "function"
  ) {
    throw resolutionError("capability-unavailable");
  }

  return {
    fetch: (url, signal) =>
      signal === undefined ? browser.fetch(url) : browser.fetch(url, { signal }),
    createImageBitmap: (blob) => browser.createImageBitmap(blob),
    createSurface(width, height) {
      const surface = new browser.OffscreenCanvas!(width, height);
      return {
        getContext() {
          const context = surface.getContext("2d");
          if (context === null) return null;
          return {
            drawImage(image, x, y) {
              context.drawImage(image as ImageBitmap, x, y);
            },
            getImageData: (x, y, readWidth, readHeight) =>
              context.getImageData(x, y, readWidth, readHeight),
          };
        },
      };
    },
  };
}

function hasValidDimensions(bitmap: ImageAssetBitmap): boolean {
  const { width, height } = bitmap;
  return (
    Number.isSafeInteger(width) &&
    width > 0 &&
    Number.isSafeInteger(height) &&
    height > 0 &&
    width <= Math.floor(Number.MAX_SAFE_INTEGER / height / 4)
  );
}

/**
 * Return schema-declared Image Asset IDs in schema order.
 *
 * Values follow the core parameter contract: a string param is preserved
 * exactly; an absent or non-string value uses the schema default. Duplicate IDs
 * are retained only at their first schema position. No URL validation or param
 * mutation occurs here.
 */
export function requiredImageAssetIds(
  schema: ParamSchema,
  params: Params,
): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();

  for (const [key, spec] of Object.entries(schema)) {
    if (spec.kind !== "image-asset") continue;
    const value = typeof params[key] === "string" ? params[key] : spec.default;
    if (!seen.has(value)) {
      seen.add(value);
      ids.push(value);
    }
  }

  return ids;
}

/**
 * Encode an Image Asset ID set as an exact, opaque, order-independent key.
 * JSON string encoding makes boundaries unambiguous even for arbitrary strings.
 */
export function imageAssetIdSetKey(ids: Iterable<string>): string {
  return JSON.stringify([...new Set(ids)].sort());
}

/**
 * Fetch and decode one canonical Studio Image Asset into caller-owned RGBA8.
 *
 * Production follows the browser pipeline directly: fetch the logical URL,
 * read its Blob, create an ImageBitmap, draw it into an OffscreenCanvas, and
 * copy getImageData bytes into a new Uint8ClampedArray. The ImageBitmap is
 * closed after every successful decode and every failure after bitmap creation.
 */
export async function decodeImageAsset(
  id: string,
  dependencies?: ImageAssetResolverDependencies,
  signal?: AbortSignal,
): Promise<DecodedPixels> {
  const url = imageAssetUrl(id);
  if (url === null) throw resolutionError("invalid-id", id);

  let deps: ImageAssetResolverDependencies;
  try {
    deps = dependencies ?? browserDependencies();
  } catch {
    throw resolutionError("capability-unavailable", id);
  }
  let response: ImageAssetFetchResponse;
  try {
    response = await deps.fetch(url, signal);
  } catch {
    throw resolutionError("fetch-failed", id);
  }
  if (!response.ok) {
    throw resolutionError(
      response.status === 404 ? "missing" : "fetch-failed",
      id,
    );
  }

  let blob: Blob;
  try {
    blob = await response.blob();
  } catch {
    throw resolutionError("response-failed", id);
  }

  let bitmap: ImageAssetBitmap;
  try {
    bitmap = await deps.createImageBitmap(blob);
  } catch {
    throw resolutionError("decode-failed", id);
  }

  try {
    if (!hasValidDimensions(bitmap)) {
      throw resolutionError("invalid-dimensions", id);
    }

    const { width, height } = bitmap;
    let surface: ImageAssetSurface;
    try {
      surface = deps.createSurface(width, height);
    } catch {
      throw resolutionError("surface-failed", id);
    }

    let context: ImageAssetReadbackContext | null;
    try {
      context = surface.getContext("2d");
    } catch {
      throw resolutionError("context-unavailable", id);
    }
    if (context === null) throw resolutionError("context-unavailable", id);

    try {
      context.drawImage(bitmap, 0, 0);
      const imageData = context.getImageData(0, 0, width, height);
      const data = new Uint8ClampedArray(imageData.data);
      if (data.length !== width * height * 4) {
        throw resolutionError("readback-failed", id);
      }
      return { width, height, data };
    } catch (error: unknown) {
      if (error instanceof ImageAssetResolutionError) throw error;
      throw resolutionError("readback-failed", id);
    }
  } finally {
    // Closing is cleanup only: a browser-specific close error must not replace
    // the stable result or bounded failure from the decoding pipeline.
    try {
      bitmap.close();
    } catch {
      // Deliberately ignored.
    }
  }
}

/**
 * Resolve every Image Asset declared by a schema into one synchronous core
 * environment. Each call owns fresh records and byte arrays; there is no
 * cross-environment cache and no decoded payload crosses a worker boundary.
 */
export async function resolveSketchEnvironment(
  schema: ParamSchema,
  params: Params,
  dependencies?: ImageAssetResolverDependencies,
  signal?: AbortSignal,
): Promise<SketchEnvironment> {
  const records = new Map<string, Readonly<DecodedPixels>>();
  for (const id of requiredImageAssetIds(schema, params)) {
    records.set(id, await decodeImageAsset(id, dependencies, signal));
  }

  return {
    imageAssets: (id) => records.get(id),
  };
}
