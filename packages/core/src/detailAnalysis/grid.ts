/**
 * Internal, bounded scalar lattices used while preparing image detail.
 *
 * Decoded pixels are reduced with exact source-pixel area overlap rather than
 * point sampling. Luminance is accumulated in linear light and premultiplied
 * by alpha, so RGB belonging to fully transparent pixels cannot leak into the
 * visible signal when an analysis cell straddles an alpha boundary.
 */

import type { DecodedPixels } from '../imageAssets'
import { srgbByteToLinear, validateDecodedRaster } from '../rasterSampling'

const ANALYSIS_GRID_MAX_DIMENSION = 256
const BYTE_MAX = 255
const RED_LUMINANCE = 0.2126
const GREEN_LUMINANCE = 0.7152
const BLUE_LUMINANCE = 0.0722

export interface ScalarGrid {
  readonly width: number
  readonly height: number
  readonly values: readonly number[]
}

export interface AnalysisGrid {
  /** Visible, unassociated linear Rec. 709 luminance. */
  readonly luminance: ScalarGrid
  /** Fractional alpha coverage, independently area averaged. */
  readonly alpha: ScalarGrid
}

export function createScalarGrid(
  width: number,
  height: number,
  values: ArrayLike<number>,
): ScalarGrid | null {
  if (
    !Number.isSafeInteger(width) ||
    width <= 0 ||
    !Number.isSafeInteger(height) ||
    height <= 0 ||
    !Number.isSafeInteger(width * height) ||
    typeof values !== 'object' ||
    values === null ||
    values.length !== width * height
  ) {
    return null
  }

  const copy = new Array<number>(values.length)
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index]
    if (value === undefined || !Number.isFinite(value)) return null
    copy[index] = value
  }

  return Object.freeze({
    width,
    height,
    values: Object.freeze(copy),
  })
}

function analysisDimensions(
  width: number,
  height: number,
  maxDimension: number,
): readonly [number, number] | null {
  if (!Number.isSafeInteger(maxDimension) || maxDimension <= 0) return null

  const scale = Math.min(1, maxDimension / Math.max(width, height))
  return [
    Math.max(1, Math.min(width, Math.round(width * scale))),
    Math.max(1, Math.min(height, Math.round(height * scale))),
  ]
}

function linearLuminance(data: ArrayLike<number>, offset: number): number {
  return (
    RED_LUMINANCE * srgbByteToLinear(data[offset]!) +
    GREEN_LUMINANCE * srgbByteToLinear(data[offset + 1]!) +
    BLUE_LUMINANCE * srgbByteToLinear(data[offset + 2]!)
  )
}

/**
 * Prepare the private image-relative analysis lattice.
 *
 * The optional cap exists only to make this internal primitive testable. Its
 * production caller omits it and therefore cannot turn resolution into an
 * authored control.
 */
export function prepareAnalysisGrid(
  pixels: Readonly<DecodedPixels>,
  maxDimension = ANALYSIS_GRID_MAX_DIMENSION,
): AnalysisGrid | null {
  const raster = validateDecodedRaster(pixels)
  if (raster === null) return null

  const dimensions = analysisDimensions(
    raster.width,
    raster.height,
    maxDimension,
  )
  if (dimensions === null) return null
  const [width, height] = dimensions

  const luminance = new Array<number>(width * height)
  const alpha = new Array<number>(width * height)
  const sourcePerCellX = raster.width / width
  const sourcePerCellY = raster.height / height
  const cellArea = sourcePerCellX * sourcePerCellY

  for (let targetY = 0; targetY < height; targetY += 1) {
    const sourceTop = targetY * sourcePerCellY
    const sourceBottom = (targetY + 1) * sourcePerCellY
    const firstSourceY = Math.floor(sourceTop)
    const lastSourceY = Math.min(
      raster.height - 1,
      Math.ceil(sourceBottom) - 1,
    )

    for (let targetX = 0; targetX < width; targetX += 1) {
      const sourceLeft = targetX * sourcePerCellX
      const sourceRight = (targetX + 1) * sourcePerCellX
      const firstSourceX = Math.floor(sourceLeft)
      const lastSourceX = Math.min(
        raster.width - 1,
        Math.ceil(sourceRight) - 1,
      )
      let alphaArea = 0
      let premultipliedLuminanceArea = 0

      for (let sourceY = firstSourceY; sourceY <= lastSourceY; sourceY += 1) {
        const overlapY =
          Math.min(sourceBottom, sourceY + 1) - Math.max(sourceTop, sourceY)
        if (overlapY <= 0) continue

        for (
          let sourceX = firstSourceX;
          sourceX <= lastSourceX;
          sourceX += 1
        ) {
          const overlapX =
            Math.min(sourceRight, sourceX + 1) -
            Math.max(sourceLeft, sourceX)
          if (overlapX <= 0) continue

          const area = overlapX * overlapY
          const offset = (sourceY * raster.width + sourceX) * 4
          const sourceAlpha = raster.data[offset + 3]! / BYTE_MAX
          const coveredArea = area * sourceAlpha
          alphaArea += coveredArea
          if (sourceAlpha > 0) {
            premultipliedLuminanceArea +=
              coveredArea * linearLuminance(raster.data, offset)
          }
        }
      }

      const index = targetY * width + targetX
      alpha[index] = Math.max(0, Math.min(1, alphaArea / cellArea))
      luminance[index] =
        alphaArea > 0 ? premultipliedLuminanceArea / alphaArea : 0
    }
  }

  const luminanceGrid = createScalarGrid(width, height, luminance)
  const alphaGrid = createScalarGrid(width, height, alpha)
  if (luminanceGrid === null || alphaGrid === null) return null
  return Object.freeze({ luminance: luminanceGrid, alpha: alphaGrid })
}
