/**
 * Bounded full-raster preparation for Pencil Contour.
 *
 * The source is sampled over its complete normalized extent, independent of
 * Composition Frame letterboxing. Original decoded dimensions are retained so
 * later vector mapping can reproduce `createRasterContainFit` exactly. Linear
 * luminance is accumulated with straight-alpha weights and then unassociated;
 * consequently RGB stored behind exact-zero alpha never enters the signal.
 */

import type { DecodedPixels, Rgba8Bytes } from '../../imageAssets'
import {
  bilinearSample,
  createRasterContainFit,
  mapImageUvToLatticeSample,
  srgbByteToLinear,
  validateDecodedRaster,
  type LatticeSample,
} from '../../rasterSampling'
import type { CoordinateSpace } from '../../scene'
import {
  createPencilContourToneTransform,
  type PencilContourControls,
} from './controls'
import type { AnalyzedRaster } from './types'

const CHANNELS_PER_PIXEL = 4
const BYTE_MAX = 255
const RED_LUMINANCE = 0.2126
const GREEN_LUMINANCE = 0.7152
const BLUE_LUMINANCE = 0.0722

/** Maximum width or height of Pencil Contour's private analysis lattice. */
const PENCIL_CONTOUR_ANALYSIS_MAX_DIMENSION = 256

const SRGB_BYTE_TO_LINEAR = Float64Array.from(
  { length: BYTE_MAX + 1 },
  (_, byte) => srgbByteToLinear(byte),
)

const EMPTY_VALUES = Object.freeze([]) as readonly number[]
const EMPTY_SUPPORT = Object.freeze([]) as readonly boolean[]
const EMPTY_ANALYSIS: AnalyzedRaster = Object.freeze({
  sourceWidth: 0,
  sourceHeight: 0,
  width: 0,
  height: 0,
  luminance: EMPTY_VALUES,
  alpha: EMPTY_VALUES,
  positiveSupport: EMPTY_SUPPORT,
})

function analysisDimensions(
  sourceWidth: number,
  sourceHeight: number,
): readonly [number, number] {
  const scale = Math.min(
    1,
    PENCIL_CONTOUR_ANALYSIS_MAX_DIMENSION / Math.max(sourceWidth, sourceHeight),
  )
  return [
    Math.max(1, Math.min(sourceWidth, Math.round(sourceWidth * scale))),
    Math.max(1, Math.min(sourceHeight, Math.round(sourceHeight * scale))),
  ]
}

function clampUnit(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0
  if (value >= 1) return 1
  return value
}

function texelAlpha(data: Readonly<Rgba8Bytes>, index: number): number {
  return clampUnit(data[index * CHANNELS_PER_PIXEL + 3]! / BYTE_MAX)
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

  const premultiplied = bilinearSample(
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
  return clampUnit(premultiplied / sampledAlpha)
}

/**
 * Analyze decoded straight-RGBA8 pixels into a bounded row-major lattice.
 *
 * Invalid decoded data or Composition Frames fail closed to one shared frozen
 * empty record. Valid inputs are borrowed only for this call and never mutated;
 * the returned arrays are independent, frozen snapshots.
 */
export function analyzePencilContourRaster(
  pixels: Readonly<DecodedPixels>,
  frame: Readonly<CoordinateSpace>,
  controls: Readonly<PencilContourControls>,
): AnalyzedRaster {
  const raster = validateDecodedRaster(pixels)
  if (raster === null || createRasterContainFit(raster, frame) === null) {
    return EMPTY_ANALYSIS
  }

  const [width, height] = analysisDimensions(raster.width, raster.height)
  const length = width * height
  const luminance = new Array<number>(length)
  const alpha = new Array<number>(length)
  const positiveSupport = new Array<boolean>(length)
  const applyTone = createPencilContourToneTransform(controls)

  for (let row = 0; row < height; row += 1) {
    const v = (row + 0.5) / height
    for (let column = 0; column < width; column += 1) {
      const sample = mapImageUvToLatticeSample(
        { u: (column + 0.5) / width, v },
        raster.width,
        raster.height,
      )
      // Valid dimensions and finite unit coordinates make this unreachable,
      // but fail closed if the shared mapper's contract is ever tightened.
      if (sample === null) return EMPTY_ANALYSIS

      const index = row * width + column
      const sampledAlpha = sampleAlpha(raster.data, sample)
      alpha[index] = sampledAlpha
      positiveSupport[index] = sampledAlpha > 0
      luminance[index] =
        sampledAlpha > 0
          ? applyTone(
              sampleVisibleLinearLuminance(raster.data, sample, sampledAlpha),
            )
          : 0
    }
  }

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
