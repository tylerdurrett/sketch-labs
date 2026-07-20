/**
 * Internal, bounded scalar lattices used while preparing image detail.
 *
 * Decoded pixels are antialiased and reduced with combined Gaussian and exact
 * source-area weights rather than point sampling. Luminance is accumulated in
 * linear light and premultiplied by alpha, so RGB belonging to fully
 * transparent pixels cannot leak into the visible signal.
 */

import type { DecodedPixels } from '../imageAssets'
import {
  srgbByteToLinear,
  validateDecodedRaster,
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

interface AxisWeight {
  readonly source: number
  readonly weight: number
}

type AxisWeights = readonly (readonly AxisWeight[])[]

function antialiasTargetMargin(
  sourceLength: number,
  targetLength: number,
): number | null {
  const sourcePerCell = sourceLength / targetLength
  const kernel = antialiasKernel(sourcePerCell)
  if (kernel === null) return null
  return Math.ceil((kernel.length - 1) / 2 / sourcePerCell)
}

/** Combine source-space Gaussian filtering and exact area overlap per cell. */
function buildAxisWeights(
  sourceLength: number,
  targetLength: number,
): AxisWeights | null {
  const sourcePerCell = sourceLength / targetLength
  const kernel = antialiasKernel(sourcePerCell)
  if (kernel === null) return null
  const radius = (kernel.length - 1) / 2
  const result: AxisWeight[][] = []

  for (let target = 0; target < targetLength; target += 1) {
    if (sourcePerCell === 1) {
      result.push([Object.freeze({ source: target, weight: 1 })])
      continue
    }

    const left = target * sourcePerCell
    const right = (target + 1) * sourcePerCell
    const firstAreaSource = Math.floor(left)
    const lastAreaSource = Math.min(sourceLength - 1, Math.ceil(right) - 1)
    const combined = new Map<number, number>()
    let boundaryDcWeight = 0

    for (
      let areaSource = firstAreaSource;
      areaSource <= lastAreaSource;
      areaSource += 1
    ) {
      const overlap =
        Math.min(right, areaSource + 1) - Math.max(left, areaSource)
      if (overlap <= 0) continue
      const areaWeight = overlap / sourcePerCell

      for (let kernelIndex = 0; kernelIndex < kernel.length; kernelIndex += 1) {
        const source = areaSource + kernelIndex - radius
        const weight = areaWeight * kernel[kernelIndex]!
        if (source < 0 || source >= sourceLength) {
          boundaryDcWeight += weight
        } else {
          combined.set(source, (combined.get(source) ?? 0) + weight)
        }
      }
    }
    if (boundaryDcWeight > 0) {
      const contribution = boundaryDcWeight / sourceLength
      for (let source = 0; source < sourceLength; source += 1) {
        combined.set(source, (combined.get(source) ?? 0) + contribution)
      }
    }

    // Out-of-bounds filter mass uses this axis signal's own DC component. A
    // narrow destination-space repair below removes that finite-padding edge
    // before energy analysis while keeping oscillatory boundary phase quiet.
    const total = [...combined.values()].reduce((sum, value) => sum + value, 0)
    if (!Number.isFinite(total) || total === 0) return null
    result.push(
      [...combined.entries()]
        .filter(([, weight]) => weight !== 0)
        .sort(([leftSource], [rightSource]) => leftSource - rightSource)
        .map(([source, weight]) =>
          Object.freeze({ source, weight: weight / total }),
        ),
    )
  }

  return Object.freeze(result.map((weights) => Object.freeze(weights)))
}

function repairFinitePaddingMargin(
  values: number[],
  width: number,
  height: number,
  horizontalMargin: number,
  verticalMargin: number,
): void {
  const repairLine = (
    length: number,
    margin: number,
    indexAt: (position: number) => number,
  ): void => {
    if (margin <= 0) return
    if (length <= margin * 2) {
      const constant = values[indexAt(Math.floor(length / 2))]!
      for (let position = 0; position < length; position += 1) {
        values[indexAt(position)] = constant
      }
      return
    }
    const repairedMargin = Math.min(margin, Math.floor((length - 1) / 2))
    const firstSafe = repairedMargin
    const lastSafe = length - repairedMargin - 1
    if (firstSafe === lastSafe) {
      const constant = values[indexAt(firstSafe)]!
      for (let position = 0; position < length; position += 1) {
        values[indexAt(position)] = constant
      }
      return
    }

    const firstValue = values[indexAt(firstSafe)]!
    const firstSlope = values[indexAt(firstSafe + 1)]! - firstValue
    for (let position = 0; position < firstSafe; position += 1) {
      values[indexAt(position)] =
        firstValue + (position - firstSafe) * firstSlope
    }
    const lastValue = values[indexAt(lastSafe)]!
    const lastSlope = lastValue - values[indexAt(lastSafe - 1)]!
    for (let position = lastSafe + 1; position < length; position += 1) {
      values[indexAt(position)] =
        lastValue + (position - lastSafe) * lastSlope
    }
  }

  for (let y = 0; y < height; y += 1) {
    repairLine(width, horizontalMargin, (x) => y * width + x)
  }
  for (let x = 0; x < width; x += 1) {
    repairLine(height, verticalMargin, (y) => y * width + x)
  }
}

/** Internal complexity evidence for the destination-oriented resampler. */
export function analysisResampleOperationCount(
  sourceWidth: number,
  sourceHeight: number,
  maxDimension = ANALYSIS_GRID_MAX_DIMENSION,
): number | null {
  if (
    !Number.isSafeInteger(sourceWidth) ||
    sourceWidth <= 0 ||
    !Number.isSafeInteger(sourceHeight) ||
    sourceHeight <= 0 ||
    !Number.isSafeInteger(sourceWidth * sourceHeight)
  ) {
    return null
  }
  const dimensions = analysisDimensions(
    sourceWidth,
    sourceHeight,
    maxDimension,
  )
  if (dimensions === null) return null
  const [targetWidth, targetHeight] = dimensions
  const horizontal = buildAxisWeights(sourceWidth, targetWidth)
  const vertical = buildAxisWeights(sourceHeight, targetHeight)
  if (horizontal === null || vertical === null) return null
  const horizontalWeightCount = horizontal.reduce(
    (sum, weights) => sum + weights.length,
    0,
  )
  const verticalWeightCount = vertical.reduce(
    (sum, weights) => sum + weights.length,
    0,
  )
  const operationCount =
    sourceWidth * sourceHeight +
    sourceHeight * horizontalWeightCount +
    targetWidth * verticalWeightCount +
    targetWidth * targetHeight * 4
  return Number.isSafeInteger(operationCount) ? operationCount : null
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
  const premultipliedLuminance = new Array<number>(width * height)
  const horizontalWeights = buildAxisWeights(raster.width, width)
  const verticalWeights = buildAxisWeights(raster.height, height)
  const horizontalMargin = antialiasTargetMargin(raster.width, width)
  const verticalMargin = antialiasTargetMargin(raster.height, height)
  if (
    horizontalWeights === null ||
    verticalWeights === null ||
    horizontalMargin === null ||
    verticalMargin === null
  ) {
    return null
  }
  const rowCache = new Map<number, FilteredRow>()

  const horizontallyReducedRow = (sourceY: number): FilteredRow => {
    const cached = rowCache.get(sourceY)
    if (cached !== undefined) return cached

    const sourceAlpha = new Float64Array(raster.width)
    const sourcePremultipliedLuminance = new Float64Array(raster.width)
    for (let sourceX = 0; sourceX < raster.width; sourceX += 1) {
      const offset = (sourceY * raster.width + sourceX) * 4
      const valueAlpha = raster.data[offset + 3]! / BYTE_MAX
      sourceAlpha[sourceX] = valueAlpha
      if (valueAlpha > 0) {
        sourcePremultipliedLuminance[sourceX] =
          valueAlpha * linearLuminance(raster.data, offset)
      }
    }

    const reducedAlpha = new Float64Array(width)
    const reducedPremultipliedLuminance = new Float64Array(width)
    for (let targetX = 0; targetX < width; targetX += 1) {
      for (const coefficient of horizontalWeights[targetX]!) {
        reducedAlpha[targetX] =
          reducedAlpha[targetX]! +
          sourceAlpha[coefficient.source]! * coefficient.weight
        reducedPremultipliedLuminance[targetX] =
          reducedPremultipliedLuminance[targetX]! +
          sourcePremultipliedLuminance[coefficient.source]! *
            coefficient.weight
      }
    }

    const row = {
      alpha: reducedAlpha,
      premultipliedLuminance: reducedPremultipliedLuminance,
    }
    rowCache.set(sourceY, row)
    return row
  }

  for (let targetY = 0; targetY < height; targetY += 1) {
    const reducedAlpha = new Float64Array(width)
    const reducedPremultipliedLuminance = new Float64Array(width)
    for (const coefficient of verticalWeights[targetY]!) {
      const row = horizontallyReducedRow(coefficient.source)
      for (let targetX = 0; targetX < width; targetX += 1) {
        reducedAlpha[targetX] =
          reducedAlpha[targetX]! +
          row.alpha[targetX]! * coefficient.weight
        reducedPremultipliedLuminance[targetX] =
          reducedPremultipliedLuminance[targetX]! +
          row.premultipliedLuminance[targetX]! * coefficient.weight
      }
    }

    const nextFirstSource = verticalWeights[targetY + 1]?.[0]?.source
    if (nextFirstSource !== undefined) {
      for (const cachedSource of rowCache.keys()) {
        if (cachedSource < nextFirstSource) rowCache.delete(cachedSource)
      }
    }

    for (let targetX = 0; targetX < width; targetX += 1) {
      const index = targetY * width + targetX
      alpha[index] = reducedAlpha[targetX]!
      premultipliedLuminance[index] =
        reducedPremultipliedLuminance[targetX]!
    }
  }

  repairFinitePaddingMargin(
    alpha,
    width,
    height,
    horizontalMargin,
    verticalMargin,
  )
  repairFinitePaddingMargin(
    premultipliedLuminance,
    width,
    height,
    horizontalMargin,
    verticalMargin,
  )
  for (let index = 0; index < alpha.length; index += 1) {
    const valueAlpha = Math.max(0, Math.min(1, alpha[index]!))
    const valuePremultipliedLuminance = Math.max(
      0,
      Math.min(valueAlpha, premultipliedLuminance[index]!),
    )
    alpha[index] = valueAlpha
    luminance[index] =
      valueAlpha > 0 ? valuePremultipliedLuminance / valueAlpha : 0
  }

  const luminanceGrid = createScalarGrid(width, height, luminance)
  const alphaGrid = createScalarGrid(width, height, alpha)
  if (luminanceGrid === null || alphaGrid === null) return null
  return Object.freeze({ luminance: luminanceGrid, alpha: alphaGrid })
}
