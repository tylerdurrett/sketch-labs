import { describe, expect, it } from 'vitest'

import type { DecodedPixels } from '../imageAssets'
import { srgbByteToLinear } from '../rasterSampling'
import type { CoordinateSpace } from '../scene'
import { prepareWatercolorFormsRaster } from '../sketches/watercolor-forms/analysis'
import {
  createWatercolorFormsToneTransform,
  defaultWatercolorFormsControls,
} from '../sketches/watercolor-forms/controls'
import { WATERCOLOR_FORMS_LIMITS } from '../sketches/watercolor-forms/limits'

const FRAME: CoordinateSpace = { width: 320, height: 180 }

function pixels(
  width: number,
  height: number,
  bytes: readonly number[],
): DecodedPixels {
  return { width, height, data: Uint8Array.from(bytes) }
}

function solidPixels(
  width: number,
  height: number,
  rgba: readonly [number, number, number, number],
): DecodedPixels {
  return pixels(
    width,
    height,
    Array.from({ length: width * height }, () => rgba).flat(),
  )
}

function prepare(
  source: Readonly<DecodedPixels>,
  frame: Readonly<CoordinateSpace> = FRAME,
) {
  return prepareWatercolorFormsRaster(source, frame)
}

describe('prepareWatercolorFormsRaster', () => {
  it('prepares a flat visible raster as linear RGB, luminance, and alpha', () => {
    const source = solidPixels(2, 2, [128, 64, 32, 255])
    const result = prepare(source)
    const red = srgbByteToLinear(128)
    const green = srgbByteToLinear(64)
    const blue = srgbByteToLinear(32)
    const luminance = 0.2126 * red + 0.7152 * green + 0.0722 * blue

    expect(result.sourceWidth).toBe(2)
    expect(result.sourceHeight).toBe(2)
    expect(result.width).toBe(2)
    expect(result.height).toBe(2)
    for (let index = 0; index < 4; index += 1) {
      expect(result.linearRed[index]).toBeCloseTo(red, 15)
      expect(result.linearGreen[index]).toBeCloseTo(green, 15)
      expect(result.linearBlue[index]).toBeCloseTo(blue, 15)
      expect(result.luminance[index]).toBeCloseTo(luminance, 15)
      expect(result.alpha[index]).toBe(1)
      expect(result.positiveSupport[index]).toBe(true)
    }
  })

  it('protects a strong equal-luminance chromatic boundary', () => {
    // Linear luminance is nearly equal, while visible chroma is very different.
    const result = prepare(
      pixels(4, 1, [
        255, 0, 0, 255, 255, 0, 0, 255, 0, 148, 0, 255, 0, 148, 0, 255,
      ]),
    )
    const redLuminance = 0.2126
    const greenLuminance = 0.7152 * srgbByteToLinear(148)

    expect(redLuminance).toBeCloseTo(greenLuminance, 2)
    expect(result.linearRed.slice(0, 2)).toEqual([1, 1])
    expect(result.linearGreen.slice(0, 2)).toEqual([0, 0])
    expect(result.linearRed.slice(2)).toEqual([0, 0])
    for (const green of result.linearGreen.slice(2)) {
      expect(green).toBeCloseTo(srgbByteToLinear(148), 15)
    }
  })

  it('applies gamma then pivoted contrast after denoising and preserves chromaticity and alpha', () => {
    const source = solidPixels(1, 1, [128, 64, 32, 153])
    const identity = prepare(source)
    const controls = {
      ...defaultWatercolorFormsControls,
      gamma: 0.73,
      contrast: 0.29,
      pivot: 0.41,
    }
    const adjusted = prepareWatercolorFormsRaster(source, FRAME, controls)
    const expectedLuminance = createWatercolorFormsToneTransform(controls)(
      identity.luminance[0]!,
    )

    expect(adjusted.luminance[0]).toBeCloseTo(expectedLuminance, 14)
    expect(adjusted.linearRed[0]! / adjusted.linearGreen[0]!).toBeCloseTo(
      identity.linearRed[0]! / identity.linearGreen[0]!,
      14,
    )
    expect(adjusted.linearGreen[0]! / adjusted.linearBlue[0]!).toBeCloseTo(
      identity.linearGreen[0]! / identity.linearBlue[0]!,
      14,
    )
    expect(adjusted.alpha).toEqual(identity.alpha)
    expect(adjusted.positiveSupport).toEqual(identity.positiveSupport)
  })

  it('keeps identity preparation exactly equal and retains equal-luminance chromatic boundaries after tone shaping', () => {
    const source = pixels(4, 1, [
      255, 0, 0, 255, 255, 0, 0, 255, 0, 148, 0, 255, 0, 148, 0, 255,
    ])
    const implicitIdentity = prepare(source)
    const explicitIdentity = prepareWatercolorFormsRaster(
      source,
      FRAME,
      defaultWatercolorFormsControls,
    )
    const adjusted = prepareWatercolorFormsRaster(source, FRAME, {
      ...defaultWatercolorFormsControls,
      gamma: 0.7,
      contrast: 0.35,
      pivot: 0.4,
    })

    expect(explicitIdentity).toEqual(implicitIdentity)
    expect(adjusted.linearRed.slice(0, 2).every((value) => value > 0)).toBe(
      true,
    )
    expect(adjusted.linearGreen.slice(0, 2)).toEqual([0, 0])
    expect(adjusted.linearRed.slice(2)).toEqual([0, 0])
    expect(
      adjusted.linearGreen.slice(2).every((value) => value > 0),
    ).toBe(true)
    expect(adjusted.alpha).toEqual(implicitIdentity.alpha)
  })

  it('lifts visible black continuously while keeping transparent black colorless', () => {
    const source = pixels(3, 1, [
      0, 0, 0, 255,
      1, 1, 1, 255,
      0, 0, 0, 0,
    ])
    const adjusted = prepareWatercolorFormsRaster(source, FRAME, {
      ...defaultWatercolorFormsControls,
      contrast: 0,
      pivot: 0.5,
    })

    expect(adjusted.linearRed[0]).toBeCloseTo(0.475, 4)
    expect(adjusted.linearRed[1]).toBeCloseTo(adjusted.linearRed[0]!, 4)
    expect(adjusted.linearRed[2]).toBe(0)
    expect(adjusted.linearGreen[2]).toBe(0)
    expect(adjusted.linearBlue[2]).toBe(0)
    expect(adjusted.luminance[2]).toBe(0)
    expect(adjusted.positiveSupport).toEqual([true, true, false])
  })

  it('preserves meaningful alpha transitions and exact-zero support', () => {
    const result = prepare(
      pixels(4, 1, [
        80, 100, 120, 255, 80, 100, 120, 128, 250, 10, 30, 0, 0, 255, 0, 0,
      ]),
    )

    expect(result.alpha).toEqual([1, 128 / 255, 0, 0])
    expect(result.positiveSupport).toEqual([true, true, false, false])
    expect(result.linearRed[2]).toBe(0)
    expect(result.linearGreen[2]).toBe(0)
    expect(result.linearBlue[2]).toBe(0)
    expect(result.alpha[1]).toBeGreaterThan(0)
    expect(result.alpha[1]).toBeLessThan(1)
  })

  it('samples premultiplied linear RGB so hidden RGB never affects output', () => {
    const width = WATERCOLOR_FORMS_LIMITS.analysisMaxDimension * 2
    const makeSource = (hidden: readonly [number, number, number]) =>
      pixels(
        width,
        1,
        Array.from({ length: width }, (_, index) =>
          index % 2 === 0
            ? [96, 128, 192, 255]
            : [hidden[0], hidden[1], hidden[2], 0],
        ).flat(),
      )

    const hiddenRed = prepare(makeSource([255, 0, 0]))
    const hiddenGreen = prepare(makeSource([0, 255, 0]))

    expect(hiddenRed).toEqual(hiddenGreen)
    expect(hiddenRed.alpha.every((value) => value === 0.5)).toBe(true)
    expect(hiddenRed.positiveSupport.every(Boolean)).toBe(true)
    expect(
      hiddenRed.linearRed.every(
        (value) => Math.abs(value - srgbByteToLinear(96)) < 1e-14,
      ),
    ).toBe(true)
  })

  it('returns an empty prepared raster for a fully transparent input', () => {
    const result = prepare(solidPixels(3, 2, [255, 0, 255, 0]))

    expect(result.linearRed).toEqual([0, 0, 0, 0, 0, 0])
    expect(result.linearGreen).toEqual([0, 0, 0, 0, 0, 0])
    expect(result.linearBlue).toEqual([0, 0, 0, 0, 0, 0])
    expect(result.luminance).toEqual([0, 0, 0, 0, 0, 0])
    expect(result.alpha).toEqual([0, 0, 0, 0, 0, 0])
    expect(result.positiveSupport).toEqual([
      false,
      false,
      false,
      false,
      false,
      false,
    ])
  })

  it('smooths mild within-form noise deterministically', () => {
    const source = pixels(5, 1, [
      122, 122, 122, 255, 128, 128, 128, 255, 134, 134, 134, 255, 126, 126,
      126, 255, 132, 132, 132, 255,
    ])
    const first = prepare(source)
    const second = prepare(source)
    const rawCenter = srgbByteToLinear(134)

    expect(first).toEqual(second)
    expect(first.linearRed[2]).toBeLessThan(rawCenter)
    expect(first.linearRed.every(Number.isFinite)).toBe(true)
    expect(first.linearRed.every((value) => value >= 0 && value <= 1)).toBe(
      true,
    )
  })

  it.each([
    ['1x1', solidPixels(1, 1, [20, 40, 80, 255]), 1, 1],
    ['1xN', solidPixels(1, 7, [20, 40, 80, 255]), 1, 7],
    ['Nx1', solidPixels(9, 1, [20, 40, 80, 255]), 9, 1],
    [
      'extreme tall',
      solidPixels(1, 1000, [20, 40, 80, 255]),
      1,
      WATERCOLOR_FORMS_LIMITS.analysisMaxDimension,
    ],
    [
      'extreme wide',
      solidPixels(1000, 1, [20, 40, 80, 255]),
      WATERCOLOR_FORMS_LIMITS.analysisMaxDimension,
      1,
    ],
  ] as const)(
    'handles the %s raster without indexing instability',
    (_name, source, expectedWidth, expectedHeight) => {
      const result = prepare(source, { width: 1000, height: 3 })
      const length = expectedWidth * expectedHeight

      expect(result.width).toBe(expectedWidth)
      expect(result.height).toBe(expectedHeight)
      expect(result.linearRed).toHaveLength(length)
      expect(result.alpha).toHaveLength(length)
      expect(result.positiveSupport).toHaveLength(length)
      expect(result.linearRed.every(Number.isFinite)).toBe(true)
    },
  )

  it('caps a large noisy raster with an aspect-preserving lattice', () => {
    const width = 1000
    const height = 700
    const data = new Uint8Array(width * height * 4)
    for (let index = 0; index < data.length; index += 1) {
      data[index] = (index * 73 + 41) % 256
    }
    const result = prepare({ width, height, data })
    const sampleCount = result.width * result.height

    expect(result.width).toBe(
      WATERCOLOR_FORMS_LIMITS.analysisMaxDimension,
    )
    expect(result.height).toBe(179)
    expect(result.width / result.height).toBeCloseTo(width / height, 2)
    expect(sampleCount).toBeLessThanOrEqual(
      WATERCOLOR_FORMS_LIMITS.maxSampleCount,
    )
    expect(result.linearRed).toHaveLength(sampleCount)
    expect(result.linearGreen).toHaveLength(sampleCount)
    expect(result.linearBlue).toHaveLength(sampleCount)
    expect(result.luminance).toHaveLength(sampleCount)
    expect(result.alpha).toHaveLength(sampleCount)
    expect(result.positiveSupport).toHaveLength(sampleCount)
  })

  it.each([
    ['zero width', { width: 0, height: 1, data: new Uint8Array() }, FRAME],
    [
      'fractional height',
      { width: 1, height: 1.5, data: new Uint8Array() },
      FRAME,
    ],
    [
      'short data',
      { width: 1, height: 1, data: Uint8Array.from([0, 0, 0]) },
      FRAME,
    ],
    ['wrong data', { width: 1, height: 1, data: [0, 0, 0, 255] }, FRAME],
    ['null raster', null, FRAME],
    [
      'zero frame width',
      solidPixels(1, 1, [0, 0, 0, 255]),
      { width: 0, height: 1 },
    ],
    [
      'non-finite frame height',
      solidPixels(1, 1, [0, 0, 0, 255]),
      { width: 1, height: Number.NaN },
    ],
  ])('fails closed for %s', (_name, source, frame) => {
    const result = prepareWatercolorFormsRaster(
      source as unknown as DecodedPixels,
      frame,
    )

    expect(result).toEqual({
      sourceWidth: 0,
      sourceHeight: 0,
      width: 0,
      height: 0,
      linearRed: [],
      linearGreen: [],
      linearBlue: [],
      luminance: [],
      alpha: [],
      positiveSupport: [],
    })
    expect(Object.isFrozen(result)).toBe(true)
    expect(Object.isFrozen(result.linearRed)).toBe(true)
    expect(Object.isFrozen(result.alpha)).toBe(true)
    expect(Object.isFrozen(result.positiveSupport)).toBe(true)
  })

  it('does not mutate caller inputs and returns immutable snapshots', () => {
    const source = pixels(3, 1, [
      20, 30, 40, 64, 100, 110, 120, 128, 200, 210, 220, 255,
    ])
    const originalBytes = Uint8Array.from(source.data)
    const frame = { width: 123, height: 77 }
    const originalFrame = { ...frame }

    const result = prepare(source, frame)

    expect(source.data).toEqual(originalBytes)
    expect(frame).toEqual(originalFrame)
    expect(Object.isFrozen(result)).toBe(true)
    expect(Object.isFrozen(result.linearRed)).toBe(true)
    expect(Object.isFrozen(result.linearGreen)).toBe(true)
    expect(Object.isFrozen(result.linearBlue)).toBe(true)
    expect(Object.isFrozen(result.luminance)).toBe(true)
    expect(Object.isFrozen(result.alpha)).toBe(true)
    expect(Object.isFrozen(result.positiveSupport)).toBe(true)
  })
})
