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

const ZERO_RASTER_SOURCE: ToneSource = Object.freeze({
  toneField: createToneField(() => 0),
  shadingMask: createShadingMask(() => 0),
})

interface ValidatedRaster {
  readonly width: number
  readonly height: number
  readonly data: Readonly<Rgba8Bytes>
}

interface RasterFit {
  readonly left: number
  readonly top: number
  readonly right: number
  readonly bottom: number
  readonly scale: number
}

interface PreparedSample {
  readonly topLeft: number
  readonly topRight: number
  readonly bottomLeft: number
  readonly bottomRight: number
  readonly horizontal: number
  readonly vertical: number
}

function validateRaster(pixels: Readonly<DecodedPixels>): ValidatedRaster | null {
  if (typeof pixels !== 'object' || pixels === null) return null
  const { width, height, data } = pixels
  if (
    !Number.isSafeInteger(width) ||
    width <= 0 ||
    !Number.isSafeInteger(height) ||
    height <= 0 ||
    (!(data instanceof Uint8Array) && !(data instanceof Uint8ClampedArray))
  ) {
    return null
  }

  const pixelCount = width * height
  if (!Number.isSafeInteger(pixelCount)) return null
  const expectedLength = pixelCount * CHANNELS_PER_PIXEL
  if (!Number.isSafeInteger(expectedLength) || data.length !== expectedLength) {
    return null
  }

  return { width, height, data }
}

function containFit(
  raster: ValidatedRaster,
  frame: Readonly<CoordinateSpace>,
): RasterFit | null {
  if (typeof frame !== 'object' || frame === null) return null
  if (
    !Number.isFinite(frame.width) ||
    frame.width <= 0 ||
    !Number.isFinite(frame.height) ||
    frame.height <= 0
  ) {
    return null
  }

  const scale = Math.min(
    frame.width / raster.width,
    frame.height / raster.height,
  )
  if (!Number.isFinite(scale) || scale <= 0) return null

  const fittedWidth = raster.width * scale
  const fittedHeight = raster.height * scale
  const left = (frame.width - fittedWidth) / 2
  const top = (frame.height - fittedHeight) / 2
  const right = left + fittedWidth
  const bottom = top + fittedHeight
  if (
    !Number.isFinite(left) ||
    !Number.isFinite(top) ||
    !Number.isFinite(right) ||
    !Number.isFinite(bottom)
  ) {
    return null
  }

  return { left, top, right, bottom, scale }
}

function clampIndex(value: number, maximum: number): number {
  if (value <= 0) return 0
  if (value >= maximum) return maximum
  return value
}

function prepareSample(
  point: Readonly<Point>,
  raster: ValidatedRaster,
  fit: RasterFit,
): PreparedSample | null {
  if (typeof point !== 'object' || point === null) return null
  const x = point[0]
  const y = point[1]
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null
  if (x < fit.left || x > fit.right || y < fit.top || y > fit.bottom) {
    return null
  }

  // Pixel centers sit at `index + 0.5`; clamp only after confirming the point is
  // inside the fitted pixel extent so the half-pixel border repeats edge texels
  // without leaking them into the letterbox.
  const pixelX = clampIndex(
    (x - fit.left) / fit.scale - 0.5,
    raster.width - 1,
  )
  const pixelY = clampIndex(
    (y - fit.top) / fit.scale - 0.5,
    raster.height - 1,
  )
  const leftColumn = Math.floor(pixelX)
  const topRow = Math.floor(pixelY)
  const rightColumn = Math.min(leftColumn + 1, raster.width - 1)
  const bottomRow = Math.min(topRow + 1, raster.height - 1)
  const byteOffset = (row: number, column: number) =>
    (row * raster.width + column) * CHANNELS_PER_PIXEL

  return {
    topLeft: byteOffset(topRow, leftColumn),
    topRight: byteOffset(topRow, rightColumn),
    bottomLeft: byteOffset(bottomRow, leftColumn),
    bottomRight: byteOffset(bottomRow, rightColumn),
    horizontal: pixelX - leftColumn,
    vertical: pixelY - topRow,
  }
}

function srgbByteToLinear(byte: number): number {
  const encoded = byte / BYTE_MAX
  if (encoded <= 0.04045) return encoded / 12.92
  return ((encoded + 0.055) / 1.055) ** 2.4
}

function lerp(start: number, end: number, amount: number): number {
  return start + (end - start) * amount
}

function bilinear(
  topLeft: number,
  topRight: number,
  bottomLeft: number,
  bottomRight: number,
  horizontal: number,
  vertical: number,
): number {
  return lerp(
    lerp(topLeft, topRight, horizontal),
    lerp(bottomLeft, bottomRight, horizontal),
    vertical,
  )
}

function sampleLinearChannel(
  data: Readonly<Rgba8Bytes>,
  sample: PreparedSample,
  channel: 0 | 1 | 2,
): number {
  return bilinear(
    srgbByteToLinear(data[sample.topLeft + channel]!),
    srgbByteToLinear(data[sample.topRight + channel]!),
    srgbByteToLinear(data[sample.bottomLeft + channel]!),
    srgbByteToLinear(data[sample.bottomRight + channel]!),
    sample.horizontal,
    sample.vertical,
  )
}

function sampleAlpha(
  data: Readonly<Rgba8Bytes>,
  sample: PreparedSample,
): number {
  return (
    bilinear(
      data[sample.topLeft + 3]!,
      data[sample.topRight + 3]!,
      data[sample.bottomLeft + 3]!,
      data[sample.bottomRight + 3]!,
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
  const raster = validateRaster(pixels)
  if (raster === null) return ZERO_RASTER_SOURCE
  const fit = containFit(raster, frame)
  if (fit === null) return ZERO_RASTER_SOURCE

  return Object.freeze({
    toneField: createToneField((point) => {
      const sample = prepareSample(point, raster, fit)
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
      const sample = prepareSample(point, raster, fit)
      return sample === null ? 0 : sampleAlpha(raster.data, sample)
    }),
  })
}
