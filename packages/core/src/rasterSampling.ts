/**
 * Internal decoded-raster validation and resolution-independent sampling.
 *
 * Contain fitting deliberately uses the decoded image's original dimensions.
 * Sampling a derived lattice is a separate step so a rounded analysis grid can
 * share the image placement without changing its aspect ratio or letterbox.
 */

import type { DecodedPixels, Rgba8Bytes } from './imageAssets'
import type { CoordinateSpace } from './scene'
import type { Point } from './types'

const CHANNELS_PER_PIXEL = 4
const BYTE_MAX = 255

export interface ValidatedDecodedRaster {
  readonly width: number
  readonly height: number
  readonly data: Readonly<Rgba8Bytes>
}

export interface RasterContainFit {
  readonly sourceWidth: number
  readonly sourceHeight: number
  readonly left: number
  readonly top: number
  readonly right: number
  readonly bottom: number
  readonly fittedWidth: number
  readonly fittedHeight: number
}

export interface ImageUv {
  readonly u: number
  readonly v: number
}

/** Pixel indices and interpolation weights for one scalar row-major lattice. */
export interface LatticeSample {
  readonly topLeft: number
  readonly topRight: number
  readonly bottomLeft: number
  readonly bottomRight: number
  readonly horizontal: number
  readonly vertical: number
}

export function validateDecodedRaster(
  pixels: Readonly<DecodedPixels>,
): ValidatedDecodedRaster | null {
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

export function createRasterContainFit(
  source: Readonly<{ width: number; height: number }>,
  frame: Readonly<CoordinateSpace>,
): RasterContainFit | null {
  if (
    typeof source !== 'object' ||
    source === null ||
    !Number.isSafeInteger(source.width) ||
    source.width <= 0 ||
    !Number.isSafeInteger(source.height) ||
    source.height <= 0 ||
    typeof frame !== 'object' ||
    frame === null ||
    !Number.isFinite(frame.width) ||
    frame.width <= 0 ||
    !Number.isFinite(frame.height) ||
    frame.height <= 0
  ) {
    return null
  }

  const scale = Math.min(
    frame.width / source.width,
    frame.height / source.height,
  )
  if (!Number.isFinite(scale) || scale <= 0) return null

  const fittedWidth = source.width * scale
  const fittedHeight = source.height * scale
  const left = (frame.width - fittedWidth) / 2
  const top = (frame.height - fittedHeight) / 2
  const right = left + fittedWidth
  const bottom = top + fittedHeight
  if (
    !Number.isFinite(fittedWidth) ||
    !Number.isFinite(fittedHeight) ||
    !Number.isFinite(left) ||
    !Number.isFinite(top) ||
    !Number.isFinite(right) ||
    !Number.isFinite(bottom)
  ) {
    return null
  }

  return {
    sourceWidth: source.width,
    sourceHeight: source.height,
    left,
    top,
    right,
    bottom,
    fittedWidth,
    fittedHeight,
  }
}

function clampUnit(value: number): number {
  if (value <= 0) return 0
  if (value >= 1) return 1
  return value
}

export function mapFramePointToImageUv(
  point: Readonly<Point>,
  fit: Readonly<RasterContainFit>,
): ImageUv | null {
  if (typeof point !== 'object' || point === null) return null
  const x = point[0]
  const y = point[1]
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null
  if (x < fit.left || x > fit.right || y < fit.top || y > fit.bottom) {
    return null
  }

  const u = (x - fit.left) / fit.fittedWidth
  const v = (y - fit.top) / fit.fittedHeight
  if (!Number.isFinite(u) || !Number.isFinite(v)) return null
  return { u: clampUnit(u), v: clampUnit(v) }
}

function clampIndex(value: number, maximum: number): number {
  if (value <= 0) return 0
  if (value >= maximum) return maximum
  return value
}

export function mapImageUvToLatticeSample(
  uv: Readonly<ImageUv>,
  width: number,
  height: number,
): LatticeSample | null {
  if (
    typeof uv !== 'object' ||
    uv === null ||
    !Number.isFinite(uv.u) ||
    uv.u < 0 ||
    uv.u > 1 ||
    !Number.isFinite(uv.v) ||
    uv.v < 0 ||
    uv.v > 1 ||
    !Number.isSafeInteger(width) ||
    width <= 0 ||
    !Number.isSafeInteger(height) ||
    height <= 0 ||
    !Number.isSafeInteger(width * height)
  ) {
    return null
  }

  // Pixel centers sit at `index + 0.5`. Clamping normalized coordinates at
  // the lattice edges repeats the edge values across their half-pixel extents.
  const pixelX = clampIndex(uv.u * width - 0.5, width - 1)
  const pixelY = clampIndex(uv.v * height - 0.5, height - 1)
  const leftColumn = Math.floor(pixelX)
  const topRow = Math.floor(pixelY)
  const rightColumn = Math.min(leftColumn + 1, width - 1)
  const bottomRow = Math.min(topRow + 1, height - 1)

  return {
    topLeft: topRow * width + leftColumn,
    topRight: topRow * width + rightColumn,
    bottomLeft: bottomRow * width + leftColumn,
    bottomRight: bottomRow * width + rightColumn,
    horizontal: pixelX - leftColumn,
    vertical: pixelY - topRow,
  }
}

function lerp(start: number, end: number, amount: number): number {
  return start + (end - start) * amount
}

export function bilinearSample(
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

export function srgbByteToLinear(byte: number): number {
  const encoded = byte / BYTE_MAX
  if (encoded <= 0.04045) return encoded / 12.92
  return ((encoded + 0.055) / 1.055) ** 2.4
}
