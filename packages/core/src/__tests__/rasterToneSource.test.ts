import { describe, expect, it } from 'vitest'

import type { DecodedPixels } from '../imageAssets'
import { createRasterToneSource } from '../rasterToneSource'
import type { CoordinateSpace } from '../scene'

const SQUARE: CoordinateSpace = { width: 100, height: 100 }

function pixels(
  width: number,
  height: number,
  bytes: readonly number[],
  clamped = false,
): DecodedPixels {
  return {
    width,
    height,
    data: clamped ? Uint8ClampedArray.from(bytes) : Uint8Array.from(bytes),
  }
}

function samples(source: ReturnType<typeof createRasterToneSource>, x: number, y: number) {
  return {
    tone: source.toneField.sample([x, y]),
    permission: source.shadingMask.sample([x, y]),
  }
}

describe('createRasterToneSource', () => {
  it('samples one straight-RGBA texel across its full fitted pixel extent', () => {
    const source = createRasterToneSource(
      pixels(1, 1, [255, 0, 0, 128], true),
      SQUARE,
    )

    for (const point of [
      [0, 0],
      [50, 50],
      [100, 100],
    ] as const) {
      expect(source.toneField.sample(point)).toBeCloseTo(1 - 0.2126, 12)
      expect(source.shadingMask.sample(point)).toBeCloseTo(128 / 255, 12)
    }
  })

  it('decodes each sRGB texel before bilinear interpolation', () => {
    const source = createRasterToneSource(
      pixels(2, 1, [0, 0, 0, 255, 255, 255, 255, 255]),
      { width: 2, height: 1 },
    )

    // Halfway between black and white pixel centers: interpolating LINEAR
    // texels yields luminance 0.5 and tone 0.5. The wrong encoded-first path
    // would decode sRGB 0.5 to ~0.214 and yield tone ~0.786.
    expect(source.toneField.sample([1, 0.5])).toBeCloseTo(0.5, 12)
    expect(source.toneField.sample([1, 0.5])).not.toBeCloseTo(
      1 - 0.21404114048223255,
      3,
    )
  })

  it('bilinearly combines four decoded texels and straight alpha', () => {
    const source = createRasterToneSource(
      pixels(2, 2, [
        0, 0, 0, 0,
        255, 0, 0, 85,
        0, 255, 0, 170,
        0, 0, 255, 255,
      ]),
      { width: 2, height: 2 },
    )

    expect(samples(source, 1, 1)).toEqual({
      tone: 0.75,
      permission: 0.5,
    })
  })

  it('uses inverted Rec. 709 luminance after linear decoding', () => {
    const source = createRasterToneSource(
      pixels(3, 1, [
        255, 0, 0, 255,
        0, 255, 0, 255,
        0, 0, 255, 255,
      ]),
      { width: 3, height: 1 },
    )

    expect(source.toneField.sample([0.5, 0.5])).toBeCloseTo(1 - 0.2126, 12)
    expect(source.toneField.sample([1.5, 0.5])).toBeCloseTo(1 - 0.7152, 12)
    expect(source.toneField.sample([2.5, 0.5])).toBeCloseTo(1 - 0.0722, 12)
  })

  it.each([
    [10, 10 / 255 / 12.92],
    [128, ((128 / 255 + 0.055) / 1.055) ** 2.4],
  ])('decodes an sRGB gray byte of %i through the correct branch', (byte, linear) => {
    const source = createRasterToneSource(
      pixels(1, 1, [byte, byte, byte, 255]),
      SQUARE,
    )
    expect(source.toneField.sample([50, 50])).toBeCloseTo(1 - linear, 12)
  })

  it('keeps straight alpha independent from unassociated RGB', () => {
    const source = createRasterToneSource(
      pixels(3, 1, [
        64, 128, 192, 0,
        64, 128, 192, 128,
        64, 128, 192, 255,
      ]),
      { width: 3, height: 1 },
    )
    const tones = [0.5, 1.5, 2.5].map((x) =>
      source.toneField.sample([x, 0.5]),
    )

    expect(tones[1]).toBe(tones[0])
    expect(tones[2]).toBe(tones[0])
    expect(source.shadingMask.sample([0.5, 0.5])).toBe(0)
    expect(source.shadingMask.sample([1.5, 0.5])).toBeCloseTo(128 / 255, 12)
    expect(source.shadingMask.sample([2.5, 0.5])).toBe(1)
  })

  it('preserves exact-zero tone for white pixels', () => {
    const source = createRasterToneSource(
      pixels(1, 1, [255, 255, 255, 255]),
      SQUARE,
    )
    expect(source.toneField.sample([50, 50])).toBe(0)
    expect(source.shadingMask.sample([50, 50])).toBe(1)
  })

  it('contain-fits a square raster into a wide frame with exact-zero side bands', () => {
    const source = createRasterToneSource(
      pixels(1, 1, [0, 0, 0, 255]),
      { width: 200, height: 100 },
    )

    expect(samples(source, 49.999, 50)).toEqual({ tone: 0, permission: 0 })
    expect(samples(source, 50, 0)).toEqual({ tone: 1, permission: 1 })
    expect(samples(source, 150, 100)).toEqual({ tone: 1, permission: 1 })
    expect(samples(source, 150.001, 50)).toEqual({ tone: 0, permission: 0 })
  })

  it('contain-fits a square raster into a tall frame with exact-zero top/bottom bands', () => {
    const source = createRasterToneSource(
      pixels(1, 1, [0, 0, 0, 255]),
      { width: 100, height: 200 },
    )

    expect(samples(source, 50, 49.999)).toEqual({ tone: 0, permission: 0 })
    expect(samples(source, 0, 50)).toEqual({ tone: 1, permission: 1 })
    expect(samples(source, 100, 150)).toEqual({ tone: 1, permission: 1 })
    expect(samples(source, 50, 150.001)).toEqual({ tone: 0, permission: 0 })
  })

  it.each([
    ['zero width', { width: 0, height: 1, data: Uint8Array.from([]) }],
    ['negative height', { width: 1, height: -1, data: Uint8Array.from([]) }],
    ['fractional width', { width: 1.5, height: 1, data: Uint8Array.from([]) }],
    ['NaN width', { width: Number.NaN, height: 1, data: Uint8Array.from([]) }],
    ['non-finite height', { width: 1, height: Infinity, data: Uint8Array.from([]) }],
    [
      'overflowing pixel count',
      {
        width: Number.MAX_SAFE_INTEGER,
        height: Number.MAX_SAFE_INTEGER,
        data: Uint8Array.from([]),
      },
    ],
    [
      'safe pixel count but overflowing RGBA byte length',
      {
        width: Number.MAX_SAFE_INTEGER,
        height: 1,
        data: Uint8Array.from([]),
      },
    ],
    ['short data', { width: 1, height: 1, data: Uint8Array.from([0, 0, 0]) }],
    ['long data', { width: 1, height: 1, data: Uint8Array.from([0, 0, 0, 0, 0]) }],
    ['wrong data type', { width: 1, height: 1, data: [0, 0, 0, 255] }],
    ['null record', null],
  ])('fails closed for malformed decoded data: %s', (_name, malformed) => {
    const source = createRasterToneSource(
      malformed as unknown as DecodedPixels,
      SQUARE,
    )
    expect(samples(source, 50, 50)).toEqual({ tone: 0, permission: 0 })
  })

  it.each([
    { width: 0, height: 100 },
    { width: -1, height: 100 },
    { width: 100, height: 0 },
    { width: 100, height: Infinity },
    { width: Number.NaN, height: 100 },
    null,
  ])('fails closed for an invalid Composition Frame: %o', (frame) => {
    const source = createRasterToneSource(
      pixels(1, 1, [0, 0, 0, 255]),
      frame as CoordinateSpace,
    )
    expect(samples(source, 0, 0)).toEqual({ tone: 0, permission: 0 })
  })

  it.each([
    [Number.NaN, 50],
    [Infinity, 50],
    [50, -Infinity],
  ])('fails closed for a non-finite sample point (%s, %s)', (x, y) => {
    const source = createRasterToneSource(
      pixels(1, 1, [0, 0, 0, 255]),
      SQUARE,
    )
    expect(samples(source, x, y)).toEqual({ tone: 0, permission: 0 })
  })

  it('fails closed for a structurally malformed sample point', () => {
    const source = createRasterToneSource(
      pixels(1, 1, [0, 0, 0, 255]),
      SQUARE,
    )
    expect(source.toneField.sample(null as never)).toBe(0)
    expect(source.shadingMask.sample(null as never)).toBe(0)
  })

  it('does not mutate the borrowed decoded record or byte array', () => {
    const data = Uint8Array.from([
      0, 64, 128, 192,
      255, 192, 128, 64,
    ])
    const record: DecodedPixels = { width: 2, height: 1, data }
    const before = Uint8Array.from(data)
    const source = createRasterToneSource(record, { width: 2, height: 1 })

    samples(source, 0.5, 0.5)
    samples(source, 1, 0.5)
    samples(source, 1.5, 0.5)

    expect(data).toEqual(before)
    expect(record).toEqual({ width: 2, height: 1, data })
  })
})
