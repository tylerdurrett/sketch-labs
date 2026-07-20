import {
  sampleDetailField,
  type CoordinateSpace,
  type DetailField,
  type PageFrame,
} from "@harness/core";

/** Pixel buffer for a Detail reference at one canvas backing-store resolution. */
export interface DetailReferenceRaster {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8ClampedArray;
}

/**
 * Sample a headless Detail Field into opaque grayscale canvas pixels.
 *
 * Pixel centers are mapped over the represented Page Frame, or over the full
 * Composition when no Page Frame is active. Detail is shown directly: smooth
 * (`0`) is black, strongest detail (`1`) is white, and intermediate values are
 * rounded to their nearest byte. Pixels outside the frozen Composition are
 * black and never reach the field, so Page padding cannot invent detail.
 */
export function rasterizeDetailReference(
  field: DetailField,
  compositionFrame: CoordinateSpace,
  width: number,
  height: number,
  pageFrame: PageFrame | null = null,
): DetailReferenceRaster {
  const pixelWidth = Number.isFinite(width) && width > 0 ? Math.trunc(width) : 0;
  const pixelHeight =
    Number.isFinite(height) && height > 0 ? Math.trunc(height) : 0;
  const data = new Uint8ClampedArray(pixelWidth * pixelHeight * 4);
  const representedFrame = pageFrame ?? {
    x: 0,
    y: 0,
    width: compositionFrame.width,
    height: compositionFrame.height,
  };

  for (let y = 0; y < pixelHeight; y += 1) {
    const frameY =
      representedFrame.y +
      ((y + 0.5) / pixelHeight) * representedFrame.height;
    for (let x = 0; x < pixelWidth; x += 1) {
      const frameX =
        representedFrame.x +
        ((x + 0.5) / pixelWidth) * representedFrame.width;
      const outsideComposition =
        frameX < 0 ||
        frameX > compositionFrame.width ||
        frameY < 0 ||
        frameY > compositionFrame.height;
      const detail = outsideComposition
        ? 0
        : sampleDetailField(field, [frameX, frameY]);
      const gray = Math.round(detail * 255);
      const offset = (y * pixelWidth + x) * 4;
      data[offset] = gray;
      data[offset + 1] = gray;
      data[offset + 2] = gray;
      data[offset + 3] = 255;
    }
  }

  return { width: pixelWidth, height: pixelHeight, data };
}
