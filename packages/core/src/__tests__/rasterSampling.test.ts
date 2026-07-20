import { describe, expect, it } from 'vitest'

import type { DecodedPixels } from '../imageAssets'
import {
  bilinearSample,
  createRasterContainFit,
  mapFramePointToImageUv,
  mapImageUvToLatticeSample,
  srgbByteToLinear,
  validateDecodedRaster,
} from '../rasterSampling'

describe('decoded-raster sampling', () => {
  it('validates the decoded record and both ordinary RGBA8 storage types', () => {
    const bytes = Uint8Array.from([0, 64, 128, 255])
    expect(validateDecodedRaster({ width: 1, height: 1, data: bytes })).toEqual({
      width: 1,
      height: 1,
      data: bytes,
    })

    const clamped = Uint8ClampedArray.from([255, 128, 64, 0])
    expect(
      validateDecodedRaster({ width: 1, height: 1, data: clamped }),
    ).toEqual({ width: 1, height: 1, data: clamped })
  })

  it.each([
    null,
    { width: 0, height: 1, data: Uint8Array.from([]) },
    { width: 1.5, height: 1, data: Uint8Array.from([]) },
    { width: 1, height: Infinity, data: Uint8Array.from([]) },
    {
      width: Number.MAX_SAFE_INTEGER,
      height: Number.MAX_SAFE_INTEGER,
      data: Uint8Array.from([]),
    },
    { width: 1, height: 1, data: Uint8Array.from([0, 0, 0]) },
    { width: 1, height: 1, data: [0, 0, 0, 255] },
  ])('rejects a malformed decoded record: %o', (pixels) => {
    expect(
      validateDecodedRaster(pixels as unknown as DecodedPixels),
    ).toBeNull()
  })

  it('uses original dimensions for contain bounds despite lattice aspect rounding', () => {
    const fit = createRasterContainFit(
      { width: 13, height: 7 },
      { width: 200, height: 100 },
    )!

    expect(fit.left).toBeCloseTo(50 / 7, 12)
    expect(fit.right).toBeCloseTo(1350 / 7, 12)
    expect(mapFramePointToImageUv([fit.left - 0.001, 50], fit)).toBeNull()
    expect(mapFramePointToImageUv([fit.right + 0.001, 50], fit)).toBeNull()
    expect(mapFramePointToImageUv([fit.left, 0], fit)).toEqual({ u: 0, v: 0 })
    expect(mapFramePointToImageUv([fit.right, 100], fit)).toEqual({ u: 1, v: 1 })

    const uv = mapFramePointToImageUv([100, 50], fit)!
    expect(uv).toEqual({ u: 0.5, v: 0.5 })
    expect(mapImageUvToLatticeSample(uv, 13, 7)).toEqual({
      topLeft: 45,
      topRight: 46,
      bottomLeft: 58,
      bottomRight: 59,
      horizontal: 0,
      vertical: 0,
    })
    expect(mapImageUvToLatticeSample(uv, 6, 3)).toEqual({
      topLeft: 8,
      topRight: 9,
      bottomLeft: 14,
      bottomRight: 15,
      horizontal: 0.5,
      vertical: 0,
    })
  })

  it('maps square, wide, and tall fits through exact fitted edges', () => {
    for (const [source, frame] of [
      [{ width: 2, height: 2 }, { width: 100, height: 100 }],
      [{ width: 2, height: 1 }, { width: 100, height: 100 }],
      [{ width: 1, height: 2 }, { width: 100, height: 100 }],
    ] as const) {
      const fit = createRasterContainFit(source, frame)!
      expect(mapFramePointToImageUv([fit.left, fit.top], fit)).toEqual({
        u: 0,
        v: 0,
      })
      expect(mapFramePointToImageUv([fit.right, fit.bottom], fit)).toEqual({
        u: 1,
        v: 1,
      })
      expect(
        mapFramePointToImageUv(
          [(fit.left + fit.right) / 2, (fit.top + fit.bottom) / 2],
          fit,
        ),
      ).toEqual({ u: 0.5, v: 0.5 })
    }
  })

  it('repeats lattice edges across their half-pixel extents', () => {
    expect(mapImageUvToLatticeSample({ u: 0, v: 0 }, 3, 2)).toEqual({
      topLeft: 0,
      topRight: 1,
      bottomLeft: 3,
      bottomRight: 4,
      horizontal: 0,
      vertical: 0,
    })
    expect(mapImageUvToLatticeSample({ u: 1, v: 1 }, 3, 2)).toEqual({
      topLeft: 5,
      topRight: 5,
      bottomLeft: 5,
      bottomRight: 5,
      horizontal: 0,
      vertical: 0,
    })
    expect(mapImageUvToLatticeSample({ u: 1 / 6, v: 0.25 }, 3, 2)).toEqual({
      topLeft: 0,
      topRight: 1,
      bottomLeft: 3,
      bottomRight: 4,
      horizontal: 0,
      vertical: 0,
    })
  })

  it('fails closed for invalid frames, points, normalized positions, and lattices', () => {
    expect(
      createRasterContainFit(
        { width: 1, height: 1 },
        { width: Number.NaN, height: 1 },
      ),
    ).toBeNull()
    expect(
      createRasterContainFit(
        { width: 0, height: 1 },
        { width: 1, height: 1 },
      ),
    ).toBeNull()

    const fit = createRasterContainFit(
      { width: 1, height: 1 },
      { width: 1, height: 1 },
    )!
    expect(mapFramePointToImageUv([Number.NaN, 0], fit)).toBeNull()
    expect(mapFramePointToImageUv(null as never, fit)).toBeNull()
    expect(mapImageUvToLatticeSample({ u: -0.001, v: 0.5 }, 1, 1)).toBeNull()
    expect(
      mapImageUvToLatticeSample({ u: Number.NaN, v: 0.5 }, 1, 1),
    ).toBeNull()
    expect(mapImageUvToLatticeSample({ u: 0.5, v: 0.5 }, 0, 1)).toBeNull()
    expect(
      mapImageUvToLatticeSample(
        { u: 0.5, v: 0.5 },
        Number.MAX_SAFE_INTEGER,
        2,
      ),
    ).toBeNull()
  })

  it('shares linear-light decoding and scalar bilinear interpolation', () => {
    expect(srgbByteToLinear(10)).toBeCloseTo(10 / 255 / 12.92, 15)
    expect(srgbByteToLinear(128)).toBeCloseTo(
      ((128 / 255 + 0.055) / 1.055) ** 2.4,
      15,
    )
    expect(bilinearSample(0, 1, 2, 3, 0.25, 0.5)).toBe(1.25)
  })
})
