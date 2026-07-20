/**
 * Default decoded-raster adapter for resolution-independent shading fields.
 *
 * Raster decoding and Image Asset resolution remain outside core (ADR-0014).
 * This module receives only a validated-shape RGBA8 record and maps it into the
 * source-independent Tone Field and Shading Mask contracts (ADR-0013).
 *
 * The complete image is centered and contain-fitted in the Composition Frame.
 * RGB texels are decoded from sRGB to linear light BEFORE bilinear interpolation;
 * straight alpha is interpolated independently. This ordering is load-bearing:
 * interpolating encoded sRGB values would produce physically incorrect tone.
 */

import type { DecodedPixels, Rgba8Bytes } from './imageAssets'
import {
  bilinearSample,
  createRasterContainFit,
  mapFramePointToImageUv,
  mapImageUvToLatticeSample,
  srgbByteToLinear,
  validateDecodedRaster,
  type LatticeSample,
} from './rasterSampling'
import type { CoordinateSpace } from './scene'
import {
  createShadingMask,
  createToneField,
  type ToneSource,
} from './shadingFields'
import type { Point } from './types'

const RED_LUMINANCE = 0.2126
const GREEN_LUMINANCE = 0.7152
const BLUE_LUMINANCE = 0.0722
const CHANNELS_PER_PIXEL = 4
const BYTE_MAX = 255
const SRGB_BYTE_TO_LINEAR = Float64Array.from(
  { length: BYTE_MAX + 1 },
  (_, byte) => srgbByteToLinear(byte),
)

const ZERO_RASTER_SOURCE: ToneSource = Object.freeze({
  toneField: createToneField(() => 0),
  shadingMask: createShadingMask(() => 0),
})

function sampleLinearChannel(
  data: Readonly<Rgba8Bytes>,
  sample: LatticeSample,
  channel: 0 | 1 | 2,
): number {
  return bilinearSample(
    SRGB_BYTE_TO_LINEAR[
      data[sample.topLeft * CHANNELS_PER_PIXEL + channel]!
    ]!,
    SRGB_BYTE_TO_LINEAR[
      data[sample.topRight * CHANNELS_PER_PIXEL + channel]!
    ]!,
    SRGB_BYTE_TO_LINEAR[
      data[sample.bottomLeft * CHANNELS_PER_PIXEL + channel]!
    ]!,
    SRGB_BYTE_TO_LINEAR[
      data[sample.bottomRight * CHANNELS_PER_PIXEL + channel]!
    ]!,
    sample.horizontal,
    sample.vertical,
  )
}

function sampleAlpha(
  data: Readonly<Rgba8Bytes>,
  sample: LatticeSample,
): number {
  return (
    bilinearSample(
      data[sample.topLeft * CHANNELS_PER_PIXEL + 3]!,
      data[sample.topRight * CHANNELS_PER_PIXEL + 3]!,
      data[sample.bottomLeft * CHANNELS_PER_PIXEL + 3]!,
      data[sample.bottomRight * CHANNELS_PER_PIXEL + 3]!,
      sample.horizontal,
      sample.vertical,
    ) / BYTE_MAX
  )
}

/**
 * Adapt decoded straight-RGBA8 pixels into a contain-fitted photographic source.
 *
 * Malformed decoded data, an invalid frame, non-finite sample points, and points
 * outside the fitted extent all fail closed to exact-zero tone and permission.
 * The input record and borrowed byte array are never mutated.
 */
export function createRasterToneSource(
  pixels: Readonly<DecodedPixels>,
  frame: Readonly<CoordinateSpace>,
): ToneSource {
  const raster = validateDecodedRaster(pixels)
  if (raster === null) return ZERO_RASTER_SOURCE
  const fit = createRasterContainFit(raster, frame)
  if (fit === null) return ZERO_RASTER_SOURCE

  const sampleAt = (point: Readonly<Point>) => {
    const uv = mapFramePointToImageUv(point, fit)
    return uv === null
      ? null
      : mapImageUvToLatticeSample(uv, raster.width, raster.height)
  }

  return Object.freeze({
    toneField: createToneField((point) => {
      const sample = sampleAt(point)
      if (sample === null) return 0
      const red = sampleLinearChannel(raster.data, sample, 0)
      const green = sampleLinearChannel(raster.data, sample, 1)
      const blue = sampleLinearChannel(raster.data, sample, 2)
      const luminance =
        red * RED_LUMINANCE +
        green * GREEN_LUMINANCE +
        blue * BLUE_LUMINANCE
      return luminance >= 1 ? 0 : 1 - luminance
    }),
    shadingMask: createShadingMask((point) => {
      const sample = sampleAt(point)
      return sample === null ? 0 : sampleAlpha(raster.data, sample)
    }),
  })
}
