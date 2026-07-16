import {
  sampleEffectiveTone,
  type CoordinateSpace,
  type ToneSource,
} from "@harness/core";

/** Pixel buffer for a Tone reference at one canvas backing-store resolution. */
export interface ToneReferenceRaster {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8ClampedArray;
}

/**
 * Sample a headless Tone source into opaque grayscale canvas pixels.
 *
 * Pixel centers, rather than pixel edges, are mapped over the Composition Frame:
 * backing pixel `(x, y)` samples `((x + 0.5) / width * frame.width,
 * (y + 0.5) / height * frame.height)`. Effective tone is ink darkness, so zero
 * maps to paper white and one maps to black. The returned bytes are Studio-only;
 * neither the backing resolution nor DOM raster types enter the core contracts.
 */
export function rasterizeToneReference(
  source: ToneSource,
  compositionFrame: CoordinateSpace,
  width: number,
  height: number,
): ToneReferenceRaster {
  const pixelWidth = Number.isFinite(width) && width > 0 ? Math.trunc(width) : 0;
  const pixelHeight =
    Number.isFinite(height) && height > 0 ? Math.trunc(height) : 0;
  const data = new Uint8ClampedArray(pixelWidth * pixelHeight * 4);

  for (let y = 0; y < pixelHeight; y += 1) {
    const frameY = ((y + 0.5) / pixelHeight) * compositionFrame.height;
    for (let x = 0; x < pixelWidth; x += 1) {
      const frameX = ((x + 0.5) / pixelWidth) * compositionFrame.width;
      const tone = sampleEffectiveTone(source, [frameX, frameY]);
      const gray = Math.round((1 - tone) * 255);
      const offset = (y * pixelWidth + x) * 4;
      data[offset] = gray;
      data[offset + 1] = gray;
      data[offset + 2] = gray;
      data[offset + 3] = 255;
    }
  }

  return { width: pixelWidth, height: pixelHeight, data };
}
