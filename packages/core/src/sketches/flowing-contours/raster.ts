/**
 * Bounded full-raster preparation for Flowing Contours.
 *
 * The complete normalized image extent is sampled independently of its later
 * Composition Frame contain fit. Straight RGBA8 is accumulated as
 * premultiplied linear luminance and unassociated only where sampled alpha is
 * positive, so RGB stored behind exact-zero alpha cannot enter contour
 * evidence. No contour, perimeter, or artistic filtering policy belongs here.
 */

import type { DecodedPixels, Rgba8Bytes } from '../../imageAssets'
import {
  bilinearSample,
  mapImageUvToLatticeSample,
  srgbByteToLinear,
  validateDecodedRaster,
  type LatticeSample,
  type ValidatedDecodedRaster,
} from '../../rasterSampling'
import {
  terminateFlowingContoursAtSafetyLimit,
  type FlowingContoursAccounting,
} from './accounting'
import {
  FLOWING_CONTOURS_LIMITS,
  isWithinFlowingContoursLimit,
  type FlowingContoursLimits,
} from './limits'

const CHANNELS_PER_PIXEL = 4
const BYTE_MAX = 255
const RED_LUMINANCE = 0.2126
const GREEN_LUMINANCE = 0.7152
const BLUE_LUMINANCE = 0.0722

const SRGB_BYTE_TO_LINEAR = Float64Array.from(
  { length: BYTE_MAX + 1 },
  (_, byte) => srgbByteToLinear(byte),
)

const EMPTY_VALUES = Object.freeze([]) as readonly number[]
const EMPTY_SUPPORT = Object.freeze([]) as readonly boolean[]

/**
 * Immutable visible-signal lattice passed to Flowing Contours field analysis.
 *
 * Original decoded dimensions survive preparation so later frame mapping can
 * call `createRasterContainFit` without deriving an aspect ratio from rounded
 * analysis dimensions.
 */
export interface PreparedFlowingContoursRaster {
  readonly sourceWidth: number
  readonly sourceHeight: number
  readonly width: number
  readonly height: number
  /** Visible, unassociated linear Rec. 709 luminance in `[0, 1]`. */
  readonly luminance: readonly number[]
  /** Sampled straight-alpha coverage in `[0, 1]`. */
  readonly alpha: readonly number[]
  /** Exact-zero permission, derived independently from sampled color. */
  readonly positiveSupport: readonly boolean[]
}

const EMPTY_PREPARED_RASTER: PreparedFlowingContoursRaster = Object.freeze({
  sourceWidth: 0,
  sourceHeight: 0,
  width: 0,
  height: 0,
  luminance: EMPTY_VALUES,
  alpha: EMPTY_VALUES,
  positiveSupport: EMPTY_SUPPORT,
})

function validateRasterFailClosed(
  pixels: Readonly<DecodedPixels>,
): ValidatedDecodedRaster | null {
  try {
    return validateDecodedRaster(pixels)
  } catch {
    // Hostile records and getters are malformed decoded input.
    return null
  }
}

function analysisDimensions(
  sourceWidth: number,
  sourceHeight: number,
): readonly [number, number] {
  const maximumDimension = FLOWING_CONTOURS_LIMITS['analysis-dimension']
  const scale = Math.min(
    1,
    maximumDimension / Math.max(sourceWidth, sourceHeight),
  )
  return [
    Math.max(1, Math.min(sourceWidth, Math.round(sourceWidth * scale))),
    Math.max(1, Math.min(sourceHeight, Math.round(sourceHeight * scale))),
  ]
}

function texelAlpha(data: Readonly<Rgba8Bytes>, index: number): number {
  return data[index * CHANNELS_PER_PIXEL + 3]! / BYTE_MAX
}

function texelLinearLuminance(
  data: Readonly<Rgba8Bytes>,
  index: number,
): number {
  const offset = index * CHANNELS_PER_PIXEL
  return (
    SRGB_BYTE_TO_LINEAR[data[offset]!]! * RED_LUMINANCE +
    SRGB_BYTE_TO_LINEAR[data[offset + 1]!]! * GREEN_LUMINANCE +
    SRGB_BYTE_TO_LINEAR[data[offset + 2]!]! * BLUE_LUMINANCE
  )
}

function clampUnit(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0
  if (value >= 1) return 1
  return value
}

function sampleAlpha(
  data: Readonly<Rgba8Bytes>,
  sample: Readonly<LatticeSample>,
): number {
  return clampUnit(
    bilinearSample(
      texelAlpha(data, sample.topLeft),
      texelAlpha(data, sample.topRight),
      texelAlpha(data, sample.bottomLeft),
      texelAlpha(data, sample.bottomRight),
      sample.horizontal,
      sample.vertical,
    ),
  )
}

function sampleVisibleLinearLuminance(
  data: Readonly<Rgba8Bytes>,
  sample: Readonly<LatticeSample>,
  sampledAlpha: number,
): number {
  if (sampledAlpha <= 0) return 0

  const premultipliedLuminance = bilinearSample(
    texelLinearLuminance(data, sample.topLeft) *
      texelAlpha(data, sample.topLeft),
    texelLinearLuminance(data, sample.topRight) *
      texelAlpha(data, sample.topRight),
    texelLinearLuminance(data, sample.bottomLeft) *
      texelAlpha(data, sample.bottomLeft),
    texelLinearLuminance(data, sample.bottomRight) *
      texelAlpha(data, sample.bottomRight),
    sample.horizontal,
    sample.vertical,
  )
  return clampUnit(premultipliedLuminance / sampledAlpha)
}

function invalidate(accounting: FlowingContoursAccounting): void {
  accounting.termination = 'invalid-input'
  accounting.limitedBy = null
  accounting.analysisWidth = 0
  accounting.analysisHeight = 0
  accounting.analysisSampleCount = 0
}

/**
 * Prepare one decoded raster using a fresh mutable FC03 accounting record.
 *
 * The optional policy is the bounded FC03 cap-forcing seam: it may lower but
 * never raise production caps. A forced cap returns the shared frozen empty
 * record and records the exact first analysis limit. Malformed input instead
 * records `invalid-input`. Successful preparation records exact lattice
 * dimensions and returns detached, frozen arrays.
 */
export function prepareFlowingContoursRaster(
  pixels: Readonly<DecodedPixels>,
  accounting: FlowingContoursAccounting,
  limits: Readonly<FlowingContoursLimits> = FLOWING_CONTOURS_LIMITS,
): PreparedFlowingContoursRaster {
  const raster = validateRasterFailClosed(pixels)
  if (raster === null) {
    invalidate(accounting)
    return EMPTY_PREPARED_RASTER
  }

  const [width, height] = analysisDimensions(raster.width, raster.height)
  const sampleCount = width * height
  if (
    !isWithinFlowingContoursLimit(
      'analysis-dimension',
      Math.max(width, height),
      limits,
    )
  ) {
    terminateFlowingContoursAtSafetyLimit(accounting, 'analysis-dimension')
    return EMPTY_PREPARED_RASTER
  }
  if (
    !isWithinFlowingContoursLimit('analysis-sample-count', sampleCount, limits)
  ) {
    terminateFlowingContoursAtSafetyLimit(accounting, 'analysis-sample-count')
    return EMPTY_PREPARED_RASTER
  }

  const luminance = new Array<number>(sampleCount)
  const alpha = new Array<number>(sampleCount)
  const positiveSupport = new Array<boolean>(sampleCount)

  for (let row = 0; row < height; row += 1) {
    const v = (row + 0.5) / height
    for (let column = 0; column < width; column += 1) {
      const sample = mapImageUvToLatticeSample(
        { u: (column + 0.5) / width, v },
        raster.width,
        raster.height,
      )
      // Validated dimensions and finite unit coordinates guarantee a sample.
      // Retain a fail-closed guard against a tightened generic contract.
      if (sample === null) {
        invalidate(accounting)
        return EMPTY_PREPARED_RASTER
      }

      const index = row * width + column
      const sampledAlpha = sampleAlpha(raster.data, sample)
      alpha[index] = sampledAlpha
      positiveSupport[index] = sampledAlpha > 0
      luminance[index] = sampleVisibleLinearLuminance(
        raster.data,
        sample,
        sampledAlpha,
      )
    }
  }

  accounting.analysisWidth = width
  accounting.analysisHeight = height
  accounting.analysisSampleCount = sampleCount

  return Object.freeze({
    sourceWidth: raster.width,
    sourceHeight: raster.height,
    width,
    height,
    luminance: Object.freeze(luminance),
    alpha: Object.freeze(alpha),
    positiveSupport: Object.freeze(positiveSupport),
  })
}
