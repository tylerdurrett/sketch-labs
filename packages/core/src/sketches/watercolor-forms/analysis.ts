/**
 * Bounded visible-raster preparation for Watercolor Forms.
 *
 * Sampling is performed in premultiplied linear light, then unassociated only
 * where sampled alpha is positive. A fixed one-pass bilateral preparation uses
 * perceptual OKLab distance and alpha distance as hard range barriers. This
 * smooths small within-form raster noise without allowing either strong color
 * boundaries or meaningful alpha boundaries to bleed into their neighbors.
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
import { WATERCOLOR_FORMS_LIMITS } from './limits'
import type { PreparedWatercolorRaster } from './types'

const CHANNELS_PER_PIXEL = 4
const BYTE_MAX = 255
const RED_LUMINANCE = 0.2126
const GREEN_LUMINANCE = 0.7152
const BLUE_LUMINANCE = 0.0722

// Fixed artistic policy: differences at or above either threshold receive no
// cross-boundary contribution. Values below it taper quadratically.
const PERCEPTUAL_HARD_EDGE = 0.12
const ALPHA_HARD_EDGE = 0.125

const SRGB_BYTE_TO_LINEAR = Float64Array.from(
  { length: BYTE_MAX + 1 },
  (_, byte) => srgbByteToLinear(byte),
)

const EMPTY_VALUES = Object.freeze([]) as readonly number[]
const EMPTY_SUPPORT = Object.freeze([]) as readonly boolean[]
const EMPTY_PREPARED_RASTER: PreparedWatercolorRaster = Object.freeze({
  sourceWidth: 0,
  sourceHeight: 0,
  width: 0,
  height: 0,
  linearRed: EMPTY_VALUES,
  linearGreen: EMPTY_VALUES,
  linearBlue: EMPTY_VALUES,
  luminance: EMPTY_VALUES,
  alpha: EMPTY_VALUES,
  positiveSupport: EMPTY_SUPPORT,
})

type LinearColor = readonly [number, number, number]
type PerceptualColor = readonly [number, number, number]

function analysisDimensions(
  sourceWidth: number,
  sourceHeight: number,
): readonly [number, number] {
  const scale = Math.min(
    1,
    WATERCOLOR_FORMS_LIMITS.analysisMaxDimension /
      Math.max(sourceWidth, sourceHeight),
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
  return data[index * CHANNELS_PER_PIXEL + 3]! / BYTE_MAX
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

function texelPremultipliedLinearChannel(
  data: Readonly<Rgba8Bytes>,
  index: number,
  channel: 0 | 1 | 2,
): number {
  const offset = index * CHANNELS_PER_PIXEL
  return SRGB_BYTE_TO_LINEAR[data[offset + channel]!]! * texelAlpha(data, index)
}

function sampleVisibleLinearColor(
  data: Readonly<Rgba8Bytes>,
  sample: Readonly<LatticeSample>,
  sampledAlpha: number,
): LinearColor {
  if (sampledAlpha <= 0) return [0, 0, 0]

  const channel = (channelIndex: 0 | 1 | 2): number =>
    clampUnit(
      bilinearSample(
        texelPremultipliedLinearChannel(
          data,
          sample.topLeft,
          channelIndex,
        ),
        texelPremultipliedLinearChannel(
          data,
          sample.topRight,
          channelIndex,
        ),
        texelPremultipliedLinearChannel(
          data,
          sample.bottomLeft,
          channelIndex,
        ),
        texelPremultipliedLinearChannel(
          data,
          sample.bottomRight,
          channelIndex,
        ),
        sample.horizontal,
        sample.vertical,
      ) / sampledAlpha,
    )

  return [channel(0), channel(1), channel(2)]
}

/**
 * Convert linear sRGB to OKLab for a perceptually meaningful range distance.
 *
 * OKLab remains private filter evidence: downstream region stages receive the
 * visible linear channels so they can derive whatever statistics they need.
 */
function linearRgbToPerceptual(
  red: number,
  green: number,
  blue: number,
): PerceptualColor {
  const long = Math.cbrt(
    0.4122214708 * red + 0.5363325363 * green + 0.0514459929 * blue,
  )
  const medium = Math.cbrt(
    0.2119034982 * red + 0.6806995451 * green + 0.1073969566 * blue,
  )
  const short = Math.cbrt(
    0.0883024619 * red + 0.2817188376 * green + 0.6299787005 * blue,
  )

  return [
    0.2104542553 * long + 0.793617785 * medium - 0.0040720468 * short,
    1.9779984951 * long - 2.428592205 * medium + 0.4505937099 * short,
    0.0259040371 * long + 0.7827717662 * medium - 0.808675766 * short,
  ]
}

function perceptualDistance(
  first: Readonly<PerceptualColor>,
  second: Readonly<PerceptualColor>,
): number {
  return Math.hypot(
    first[0] - second[0],
    first[1] - second[1],
    first[2] - second[2],
  )
}

function rangeWeight(
  colorDistance: number,
  alphaDistance: number,
): number {
  const normalizedDistance = Math.max(
    colorDistance / PERCEPTUAL_HARD_EDGE,
    alphaDistance / ALPHA_HARD_EDGE,
  )
  if (normalizedDistance >= 1) return 0
  const retained = 1 - normalizedDistance
  return retained * retained
}

interface RawPreparedChannels {
  readonly linearRed: readonly number[]
  readonly linearGreen: readonly number[]
  readonly linearBlue: readonly number[]
  readonly alpha: readonly number[]
  readonly positiveSupport: readonly boolean[]
}

function edgePreservingPreparation(
  width: number,
  height: number,
  raw: Readonly<RawPreparedChannels>,
): Readonly<{
  linearRed: number[]
  linearGreen: number[]
  linearBlue: number[]
  alpha: number[]
}> {
  const length = width * height
  const linearRed = new Array<number>(length)
  const linearGreen = new Array<number>(length)
  const linearBlue = new Array<number>(length)
  const alpha = new Array<number>(length)
  const perceptual = new Array<PerceptualColor>(length)

  for (let index = 0; index < length; index += 1) {
    perceptual[index] = linearRgbToPerceptual(
      raw.linearRed[index]!,
      raw.linearGreen[index]!,
      raw.linearBlue[index]!,
    )
  }

  for (let row = 0; row < height; row += 1) {
    for (let column = 0; column < width; column += 1) {
      const centerIndex = row * width + column
      const centerSupport = raw.positiveSupport[centerIndex]!
      const centerAlpha = raw.alpha[centerIndex]!
      const centerPerceptual = perceptual[centerIndex]!
      let totalWeight = 0
      let redSum = 0
      let greenSum = 0
      let blueSum = 0
      let alphaSum = 0

      for (
        let neighborRow = Math.max(0, row - 1);
        neighborRow <= Math.min(height - 1, row + 1);
        neighborRow += 1
      ) {
        for (
          let neighborColumn = Math.max(0, column - 1);
          neighborColumn <= Math.min(width - 1, column + 1);
          neighborColumn += 1
        ) {
          const neighborIndex = neighborRow * width + neighborColumn
          // Filtering may refine continuous alpha but never grows or erodes its
          // exact-zero support.
          if (raw.positiveSupport[neighborIndex] !== centerSupport) continue

          const rowDistance = Math.abs(neighborRow - row)
          const columnDistance = Math.abs(neighborColumn - column)
          const spatialWeight =
            rowDistance === 0 && columnDistance === 0
              ? 4
              : rowDistance + columnDistance === 1
                ? 2
                : 1
          const bilateralWeight =
            spatialWeight *
            rangeWeight(
              perceptualDistance(
                centerPerceptual,
                perceptual[neighborIndex]!,
              ),
              Math.abs(centerAlpha - raw.alpha[neighborIndex]!),
            )
          if (bilateralWeight <= 0) continue

          totalWeight += bilateralWeight
          redSum += raw.linearRed[neighborIndex]! * bilateralWeight
          greenSum += raw.linearGreen[neighborIndex]! * bilateralWeight
          blueSum += raw.linearBlue[neighborIndex]! * bilateralWeight
          alphaSum += raw.alpha[neighborIndex]! * bilateralWeight
        }
      }

      // The center always contributes with positive weight.
      linearRed[centerIndex] = clampUnit(redSum / totalWeight)
      linearGreen[centerIndex] = clampUnit(greenSum / totalWeight)
      linearBlue[centerIndex] = clampUnit(blueSum / totalWeight)
      alpha[centerIndex] = centerSupport
        ? clampUnit(alphaSum / totalWeight)
        : 0
    }
  }

  return { linearRed, linearGreen, linearBlue, alpha }
}

/**
 * Prepare decoded straight-RGBA8 pixels as one immutable bounded lattice.
 *
 * The normalized image extent is sampled independently of frame letterboxing;
 * original dimensions remain attached for exact later contain-fit mapping.
 * Malformed rasters or frames fail closed to a shared frozen empty result.
 */
export function prepareWatercolorFormsRaster(
  pixels: Readonly<DecodedPixels>,
  frame: Readonly<CoordinateSpace>,
): PreparedWatercolorRaster {
  const raster = validateDecodedRaster(pixels)
  if (raster === null || createRasterContainFit(raster, frame) === null) {
    return EMPTY_PREPARED_RASTER
  }

  const [width, height] = analysisDimensions(raster.width, raster.height)
  const length = width * height
  const rawLinearRed = new Array<number>(length)
  const rawLinearGreen = new Array<number>(length)
  const rawLinearBlue = new Array<number>(length)
  const rawAlpha = new Array<number>(length)
  const positiveSupport = new Array<boolean>(length)

  for (let row = 0; row < height; row += 1) {
    const v = (row + 0.5) / height
    for (let column = 0; column < width; column += 1) {
      const sample = mapImageUvToLatticeSample(
        { u: (column + 0.5) / width, v },
        raster.width,
        raster.height,
      )
      // Valid dimensions and unit coordinates guarantee a sample. Keep this
      // fail-closed guard in case the generic mapper contract changes.
      if (sample === null) return EMPTY_PREPARED_RASTER

      const index = row * width + column
      const sampledAlpha = sampleAlpha(raster.data, sample)
      const color = sampleVisibleLinearColor(
        raster.data,
        sample,
        sampledAlpha,
      )
      rawLinearRed[index] = color[0]
      rawLinearGreen[index] = color[1]
      rawLinearBlue[index] = color[2]
      rawAlpha[index] = sampledAlpha
      positiveSupport[index] = sampledAlpha > 0
    }
  }

  const prepared = edgePreservingPreparation(width, height, {
    linearRed: rawLinearRed,
    linearGreen: rawLinearGreen,
    linearBlue: rawLinearBlue,
    alpha: rawAlpha,
    positiveSupport,
  })
  const luminance = prepared.linearRed.map(
    (red, index) =>
      RED_LUMINANCE * red +
      GREEN_LUMINANCE * prepared.linearGreen[index]! +
      BLUE_LUMINANCE * prepared.linearBlue[index]!,
  )

  return Object.freeze({
    sourceWidth: raster.width,
    sourceHeight: raster.height,
    width,
    height,
    linearRed: Object.freeze(prepared.linearRed),
    linearGreen: Object.freeze(prepared.linearGreen),
    linearBlue: Object.freeze(prepared.linearBlue),
    luminance: Object.freeze(luminance),
    alpha: Object.freeze(prepared.alpha),
    positiveSupport: Object.freeze(positiveSupport),
  })
}
