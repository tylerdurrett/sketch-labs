import {
  sampleEffectiveTone,
  type CoordinateSpace,
  type PageFrame,
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
 * Pixel centers, rather than pixel edges, are mapped over the represented Page
 * Frame. An unframed reference represents the full Composition at origin zero;
 * a committed frame maps over its exact `x..x + width` / `y..y + height`
 * extent. Samples beyond the frozen Composition are paper white and never reach
 * the Tone source, so padding cannot invent analytic content outside the source
 * domain. Effective tone is ink darkness, so zero maps to paper white and one
 * maps to black. The returned bytes are Studio-only; neither the backing
 * resolution nor DOM raster types enter the core contracts.
 */
export function rasterizeToneReference(
  source: ToneSource,
  compositionFrame: CoordinateSpace,
  width: number,
  height: number,
  pageFrame: PageFrame | null = null,
): ToneReferenceRaster {
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
      const tone = outsideComposition
        ? 0
        : sampleEffectiveTone(source, [frameX, frameY]);
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
