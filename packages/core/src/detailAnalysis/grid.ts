/**
 * Internal, bounded scalar lattices used while preparing image detail.
 *
 * Decoded pixels are reduced with exact source-pixel area overlap rather than
 * point sampling. Luminance is accumulated in linear light and premultiplied
 * by alpha, so RGB belonging to fully transparent pixels cannot leak into the
 * visible signal when an analysis cell straddles an alpha boundary.
 */

import type { DecodedPixels } from '../imageAssets'
import {
  srgbByteToLinear,
  validateDecodedRaster,
  type ValidatedDecodedRaster,
} from '../rasterSampling'

const ANALYSIS_GRID_MAX_DIMENSION = 256
const ANTIALIAS_SIGMA_PER_SCALE = 0.6
const ANTIALIAS_TRUNCATION_SIGMAS = 3
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

function antialiasKernel(sourcePerCell: number): readonly number[] | null {
  if (!Number.isFinite(sourcePerCell) || sourcePerCell <= 0) return null
  if (sourcePerCell <= 1) return Object.freeze([1])

  // The source pixels already have finite area. This adds only the variance
  // needed as decimation grows, while approaching identity near unit scale.
  const sigma =
    ANTIALIAS_SIGMA_PER_SCALE *
    Math.sqrt(sourcePerCell * sourcePerCell - 1)
  const radius = Math.ceil(sigma * ANTIALIAS_TRUNCATION_SIGMAS)
  if (!Number.isSafeInteger(radius)) return null

  const weights = new Array<number>(radius * 2 + 1)
  let total = 0
  for (let offset = -radius; offset <= radius; offset += 1) {
    const weight = Math.exp(-(offset * offset) / (2 * sigma * sigma))
    weights[offset + radius] = weight
    total += weight
  }
  if (!Number.isFinite(total) || total <= 0) return null
  for (let index = 0; index < weights.length; index += 1) {
    weights[index] = weights[index]! / total
  }
  return Object.freeze(weights)
}

interface FilteredRow {
  readonly alpha: Float64Array
  readonly premultipliedLuminance: Float64Array
}

function createFilteredRowReader(
  raster: Readonly<ValidatedDecodedRaster>,
  horizontalKernel: readonly number[],
  verticalKernel: readonly number[],
): (sourceY: number) => FilteredRow {
  const horizontalRadius = (horizontalKernel.length - 1) / 2
  const verticalRadius = (verticalKernel.length - 1) / 2
  const horizontalRows = new Map<number, FilteredRow>()
  let boundaryAlpha = 0
  let boundaryPremultipliedLuminance = 0
  const pixelCount = raster.width * raster.height
  for (let offset = 0; offset < raster.data.length; offset += 4) {
    const alpha = raster.data[offset + 3]! / BYTE_MAX
    boundaryAlpha += alpha
    if (alpha > 0) {
      boundaryPremultipliedLuminance +=
        alpha * linearLuminance(raster.data, offset)
    }
  }
  boundaryAlpha /= pixelCount
  boundaryPremultipliedLuminance /= pixelCount

  // Extend the finite raster with its DC component during antialiasing. A
  // reflected arbitrary texture phase can otherwise turn an above-Nyquist
  // pattern into a false low-frequency edge at the first or last analysis
  // cell. Both channels use their own premultiplied means, so the extension
  // cannot reveal RGB from zero-alpha pixels.
  const horizontalRow = (sourceY: number): FilteredRow => {
    const cached = horizontalRows.get(sourceY)
    if (cached !== undefined) return cached

    const sourceAlpha = new Float64Array(raster.width)
    const sourcePremultipliedLuminance = new Float64Array(raster.width)
    for (let sourceX = 0; sourceX < raster.width; sourceX += 1) {
      const offset = (sourceY * raster.width + sourceX) * 4
      const alpha = raster.data[offset + 3]! / BYTE_MAX
      sourceAlpha[sourceX] = alpha
      if (alpha > 0) {
        sourcePremultipliedLuminance[sourceX] =
          alpha * linearLuminance(raster.data, offset)
      }
    }

    let row: FilteredRow
    if (horizontalRadius === 0) {
      row = {
        alpha: sourceAlpha,
        premultipliedLuminance: sourcePremultipliedLuminance,
      }
    } else {
      const alpha = new Float64Array(raster.width)
      const premultipliedLuminance = new Float64Array(raster.width)
      for (let sourceX = 0; sourceX < raster.width; sourceX += 1) {
        let alphaSum = 0
        let luminanceSum = 0
        for (
          let kernelIndex = 0;
          kernelIndex < horizontalKernel.length;
          kernelIndex += 1
        ) {
          const filteredX = sourceX + kernelIndex - horizontalRadius
          const weight = horizontalKernel[kernelIndex]!
          if (filteredX < 0 || filteredX >= raster.width) {
            alphaSum += boundaryAlpha * weight
            luminanceSum += boundaryPremultipliedLuminance * weight
          } else {
            alphaSum += sourceAlpha[filteredX]! * weight
            luminanceSum +=
              sourcePremultipliedLuminance[filteredX]! * weight
          }
        }
        alpha[sourceX] = alphaSum
        premultipliedLuminance[sourceX] = luminanceSum
      }
      row = { alpha, premultipliedLuminance }
    }

    horizontalRows.set(sourceY, row)
    return row
  }

  return (sourceY: number): FilteredRow => {
    let row: FilteredRow
    if (verticalRadius === 0) {
      row = horizontalRow(sourceY)
    } else {
      const alpha = new Float64Array(raster.width)
      const premultipliedLuminance = new Float64Array(raster.width)
      for (
        let kernelIndex = 0;
        kernelIndex < verticalKernel.length;
        kernelIndex += 1
      ) {
        const weight = verticalKernel[kernelIndex]!
        const filteredY = sourceY + kernelIndex - verticalRadius
        if (filteredY < 0 || filteredY >= raster.height) {
          for (let sourceX = 0; sourceX < raster.width; sourceX += 1) {
            alpha[sourceX] = alpha[sourceX]! + boundaryAlpha * weight
            premultipliedLuminance[sourceX] =
              premultipliedLuminance[sourceX]! +
              boundaryPremultipliedLuminance * weight
          }
        } else {
          const horizontal = horizontalRow(filteredY)
          for (let sourceX = 0; sourceX < raster.width; sourceX += 1) {
            alpha[sourceX] =
              alpha[sourceX]! + horizontal.alpha[sourceX]! * weight
            premultipliedLuminance[sourceX] =
              premultipliedLuminance[sourceX]! +
              horizontal.premultipliedLuminance[sourceX]! * weight
          }
        }
      }
      row = { alpha, premultipliedLuminance }
    }

    // Source rows are requested monotonically by area reduction. Retain only
    // the filtered neighborhood a repeated/current or later row can need.
    const oldestNeeded = sourceY - verticalRadius
    for (const cachedY of horizontalRows.keys()) {
      if (cachedY < oldestNeeded) horizontalRows.delete(cachedY)
    }
    return row
  }
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
  const horizontalKernel = antialiasKernel(sourcePerCellX)
  const verticalKernel = antialiasKernel(sourcePerCellY)
  if (horizontalKernel === null || verticalKernel === null) return null
  const filteredRow = createFilteredRowReader(
    raster,
    horizontalKernel,
    verticalKernel,
  )

  for (let targetY = 0; targetY < height; targetY += 1) {
    const sourceTop = targetY * sourcePerCellY
    const sourceBottom = (targetY + 1) * sourcePerCellY
    const firstSourceY = Math.floor(sourceTop)
    const lastSourceY = Math.min(
      raster.height - 1,
      Math.ceil(sourceBottom) - 1,
    )
    const sourceRows: Array<
      Readonly<{ overlapY: number; filtered: FilteredRow }>
    > = []
    for (let sourceY = firstSourceY; sourceY <= lastSourceY; sourceY += 1) {
      const overlapY =
        Math.min(sourceBottom, sourceY + 1) - Math.max(sourceTop, sourceY)
      if (overlapY > 0) {
        sourceRows.push({ overlapY, filtered: filteredRow(sourceY) })
      }
    }

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

      for (const { overlapY, filtered } of sourceRows) {
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
          const sourceAlpha = filtered.alpha[sourceX]!
          const coveredArea = area * sourceAlpha
          alphaArea += coveredArea
          if (sourceAlpha > 0) {
            premultipliedLuminanceArea +=
              area * filtered.premultipliedLuminance[sourceX]!
          }
        }
      }

      const index = targetY * width + targetX
      alpha[index] = Math.max(0, Math.min(1, alphaArea / cellArea))
      luminance[index] =
        alphaArea > 0
          ? Math.max(
              0,
              Math.min(1, premultipliedLuminanceArea / alphaArea),
            )
          : 0
    }
  }

  const luminanceGrid = createScalarGrid(width, height, luminance)
  const alphaGrid = createScalarGrid(width, height, alpha)
  if (luminanceGrid === null || alphaGrid === null) return null
  return Object.freeze({ luminance: luminanceGrid, alpha: alphaGrid })
}
