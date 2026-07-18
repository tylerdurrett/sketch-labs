import { normalizeImageAssetSlug } from "./imageAssetIdentity";

const PNG_MIME_TYPE = "image/png";

/** Stable failure categories for browser-side Image Asset normalization. */
export type ImageAssetNormalizationErrorCode =
  | "invalid-max-long-edge"
  | "capability-unavailable"
  | "decode-failed"
  | "invalid-dimensions"
  | "surface-failed"
  | "context-unavailable"
  | "draw-failed"
  | "encode-failed";

const ERROR_MESSAGES: Record<ImageAssetNormalizationErrorCode, string> = {
  "invalid-max-long-edge":
    "Image Asset maximum long edge must be a positive safe integer",
  "capability-unavailable": "Browser image normalization is unavailable",
  "decode-failed": "The selected image could not be decoded",
  "invalid-dimensions": "The selected image has invalid dimensions",
  "surface-failed": "The image normalization surface could not be created",
  "context-unavailable": "The image normalization context is unavailable",
  "draw-failed": "The selected image could not be drawn",
  "encode-failed": "The normalized image could not be encoded as PNG",
};

/** A bounded normalization failure that does not expose browser error details. */
export class ImageAssetNormalizationError extends Error {
  readonly code: ImageAssetNormalizationErrorCode;

  constructor(code: ImageAssetNormalizationErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "ImageAssetNormalizationError";
    this.code = code;
  }
}

/** The only decoded-bitmap operations required by the normalization pipeline. */
export interface ImageAssetNormalizationBitmap {
  readonly width: number;
  readonly height: number;
  close(): void;
}

/** The alpha-preserving 2D drawing operation used by the pipeline. */
export interface ImageAssetNormalizationContext {
  drawImage(
    image: ImageAssetNormalizationBitmap,
    x: number,
    y: number,
    width: number,
    height: number,
  ): void;
}

/** Minimal canvas seam, kept independent of React and concrete DOM classes. */
export interface ImageAssetNormalizationSurface {
  getContext(
    contextId: "2d",
    options: { readonly alpha: true },
  ): ImageAssetNormalizationContext | null;
  encode(type: "image/png"): Promise<Blob>;
}

/** Injectable browser operations used by unit tests and production adapters. */
export interface ImageAssetNormalizationDependencies {
  createImageBitmap(source: Blob): Promise<ImageAssetNormalizationBitmap>;
  createSurface(
    width: number,
    height: number,
  ): ImageAssetNormalizationSurface;
}

/** Caller-controlled normalization settings. */
export interface ImageAssetNormalizationOptions {
  readonly maxLongEdge: number;
}

/** The immutable PNG candidate and its normalized pixel dimensions. */
export interface NormalizedImageAsset {
  readonly png: Blob;
  readonly width: number;
  readonly height: number;
}

function normalizationError(
  code: ImageAssetNormalizationErrorCode,
): ImageAssetNormalizationError {
  return new ImageAssetNormalizationError(code);
}

function browserDependencies(): ImageAssetNormalizationDependencies {
  const browser = globalThis as typeof globalThis & {
    document?: Document;
  };

  if (
    typeof browser.createImageBitmap !== "function" ||
    typeof browser.document?.createElement !== "function"
  ) {
    throw normalizationError("capability-unavailable");
  }

  return {
    createImageBitmap: (source) => browser.createImageBitmap(source),
    createSurface(width, height) {
      const canvas = browser.document!.createElement("canvas");
      canvas.width = width;
      canvas.height = height;

      return {
        getContext(_contextId, options) {
          const context = canvas.getContext(
            "2d",
            options,
          ) as CanvasRenderingContext2D | null;
          if (context === null) return null;
          return {
            drawImage(image, x, y, drawWidth, drawHeight) {
              context.drawImage(
                image as CanvasImageSource,
                x,
                y,
                drawWidth,
                drawHeight,
              );
            },
          };
        },
        encode(type) {
          return new Promise((resolve, reject) => {
            try {
              canvas.toBlob((blob) => {
                if (blob === null) {
                  reject(normalizationError("encode-failed"));
                } else {
                  resolve(blob);
                }
              }, type);
            } catch {
              reject(normalizationError("encode-failed"));
            }
          });
        },
      };
    },
  };
}

function hasValidDimensions(bitmap: ImageAssetNormalizationBitmap): boolean {
  return (
    Number.isSafeInteger(bitmap.width) &&
    bitmap.width > 0 &&
    Number.isSafeInteger(bitmap.height) &&
    bitmap.height > 0
  );
}

function containedDimensions(
  width: number,
  height: number,
  maxLongEdge: number,
): { readonly width: number; readonly height: number } {
  const longEdge = Math.max(width, height);
  if (longEdge <= maxLongEdge) return { width, height };

  const scale = maxLongEdge / longEdge;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/**
 * Suggest a canonical editable slug from a local filename.
 *
 * Only the final extension is removed, so meaningful earlier dots remain as
 * slug separators. Extension and source MIME are deliberately not allowlisted:
 * browser decoding is the authority on whether a selected file is supported.
 */
export function proposeImageAssetSlug(filename: string): string {
  const finalDot = filename.lastIndexOf(".");
  const withoutFinalExtension =
    finalDot === -1 ? filename : filename.slice(0, finalDot);
  return normalizeImageAssetSlug(withoutFinalExtension);
}

/**
 * Decode, contain-scale without upscaling, alpha-draw, and PNG-encode a file.
 *
 * The decoded bitmap is closed after every outcome following a successful
 * decode. Original bytes are never returned, and source MIME is not inspected.
 */
export async function normalizeImageAsset(
  file: Blob,
  options: ImageAssetNormalizationOptions,
  dependencies?: ImageAssetNormalizationDependencies,
): Promise<NormalizedImageAsset> {
  if (
    !Number.isSafeInteger(options.maxLongEdge) ||
    options.maxLongEdge <= 0
  ) {
    throw normalizationError("invalid-max-long-edge");
  }

  const deps = dependencies ?? browserDependencies();
  let bitmap: ImageAssetNormalizationBitmap;
  try {
    bitmap = await deps.createImageBitmap(file);
  } catch {
    throw normalizationError("decode-failed");
  }

  try {
    if (!hasValidDimensions(bitmap)) {
      throw normalizationError("invalid-dimensions");
    }

    const dimensions = containedDimensions(
      bitmap.width,
      bitmap.height,
      options.maxLongEdge,
    );

    let surface: ImageAssetNormalizationSurface;
    try {
      surface = deps.createSurface(dimensions.width, dimensions.height);
    } catch {
      throw normalizationError("surface-failed");
    }

    let context: ImageAssetNormalizationContext | null;
    try {
      context = surface.getContext("2d", { alpha: true });
    } catch {
      throw normalizationError("context-unavailable");
    }
    if (context === null) throw normalizationError("context-unavailable");

    try {
      context.drawImage(bitmap, 0, 0, dimensions.width, dimensions.height);
    } catch {
      throw normalizationError("draw-failed");
    }

    let png: Blob;
    try {
      png = await surface.encode(PNG_MIME_TYPE);
    } catch {
      throw normalizationError("encode-failed");
    }
    if (png.type !== PNG_MIME_TYPE) {
      throw normalizationError("encode-failed");
    }

    return { png, ...dimensions };
  } finally {
    try {
      bitmap.close();
    } catch {
      // Cleanup errors must not replace a successful result or stable failure.
    }
  }
}
