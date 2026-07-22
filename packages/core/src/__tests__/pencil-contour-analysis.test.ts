import { describe, expect, it } from 'vitest'

import type { DecodedPixels } from '../imageAssets'
import { createRasterContainFit, srgbByteToLinear } from '../rasterSampling'
import type { CoordinateSpace } from '../scene'
import { analyzePencilContourRaster } from '../sketches/pencil-contour/analysis'
import {
  createPencilContourToneTransform,
  defaultPencilContourControls,
} from '../sketches/pencil-contour/controls'

const FRAME: CoordinateSpace = { width: 320, height: 180 }
const ANALYSIS_MAX_DIMENSION = 256

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

function identityAnalysis(
  source: Readonly<DecodedPixels>,
  frame: Readonly<CoordinateSpace> = FRAME,
) {
  return analyzePencilContourRaster(source, frame, defaultPencilContourControls)
}

describe('analyzePencilContourRaster', () => {
  it.each([
    ['wide', 3, 1, { width: 100, height: 100 }],
    ['tall', 1, 3, { width: 100, height: 100 }],
    ['square', 2, 2, { width: 160, height: 90 }],
  ] as const)(
    'analyzes the complete %s source while retaining exact contain-fit inputs',
    (_name, width, height, frame) => {
      const bytes = Array.from({ length: width * height }, (_, index) => {
        const byte = Math.round((index / Math.max(1, width * height - 1)) * 255)
        return [byte, byte, byte, 255]
      }).flat()
      const source = pixels(width, height, bytes)
      const result = identityAnalysis(source, frame)

      expect(result.sourceWidth).toBe(width)
      expect(result.sourceHeight).toBe(height)
      expect(result.width).toBe(width)
      expect(result.height).toBe(height)
      expect(result.luminance).toHaveLength(width * height)
      expect(result.luminance[0]).toBe(0)
      expect(result.luminance.at(-1)).toBe(1)
      expect(
        createRasterContainFit(
          { width: result.sourceWidth, height: result.sourceHeight },
          frame,
        ),
      ).toEqual(createRasterContainFit(source, frame))
    },
  )

  it('decodes sRGB to linear light before applying the prepared tone curve', () => {
    const byte = 128
    const controls = {
      ...defaultPencilContourControls,
      gamma: 0.72,
      contrast: 0.21,
      pivot: 0.37,
    }
    const result = analyzePencilContourRaster(
      solidPixels(1, 1, [byte, byte, byte, 255]),
      FRAME,
      controls,
    )

    expect(result.luminance[0]).toBeCloseTo(
      createPencilContourToneTransform(controls)(srgbByteToLinear(byte)),
      14,
    )
  })

  it('applies gamma, contrast, and pivot independently of each other', () => {
    const source = solidPixels(1, 1, [176, 176, 176, 255])
    const base = { ...defaultPencilContourControls }
    const variants = [
      { ...base, gamma: 0.8 },
      { ...base, contrast: 0.8 },
      { ...base, contrast: 0.8, pivot: 0.2 },
    ]
    const raw = srgbByteToLinear(176)

    for (const controls of variants) {
      const result = analyzePencilContourRaster(source, FRAME, controls)
      expect(result.luminance[0]).toBeCloseTo(
        createPencilContourToneTransform(controls)(raw),
        14,
      )
    }

    expect(identityAnalysis(source).luminance[0]).toBeCloseTo(raw, 14)
    expect(
      analyzePencilContourRaster(source, FRAME, variants[0]!).luminance[0],
    ).not.toBe(identityAnalysis(source).luminance[0])
    expect(
      analyzePencilContourRaster(source, FRAME, variants[1]!).luminance[0],
    ).not.toBe(
      analyzePencilContourRaster(source, FRAME, variants[2]!).luminance[0],
    )
  })

  it('keeps geometry controls out of tone analysis', () => {
    const source = solidPixels(1, 1, [96, 128, 192, 255])
    const first = analyzePencilContourRaster(source, FRAME, {
      ...defaultPencilContourControls,
      contourDetail: 0,
      contourSmoothing: 1,
    })
    const second = analyzePencilContourRaster(source, FRAME, {
      ...defaultPencilContourControls,
      contourDetail: 1,
      contourSmoothing: 0,
    })

    expect(first.luminance).toEqual(second.luminance)
  })

  it('preserves continuous straight alpha and explicit exact-zero support', () => {
    const result = identityAnalysis(
      pixels(
        4,
        1,
        [20, 30, 40, 0, 20, 30, 40, 1, 20, 30, 40, 128, 20, 30, 40, 255],
      ),
    )

    expect(result.alpha).toEqual([0, 1 / 255, 128 / 255, 1])
    expect(result.positiveSupport).toEqual([false, true, true, true])
    expect(result.luminance[0]).toBe(0)
  })

  it('makes hidden RGB irrelevant, including beside visible pixels when bounded', () => {
    const width = ANALYSIS_MAX_DIMENSION * 2
    const makeSource = (hidden: readonly [number, number, number]) => {
      const bytes = Array.from({ length: width }, (_, index) =>
        index % 2 === 0
          ? [96, 128, 192, 255]
          : [hidden[0], hidden[1], hidden[2], 0],
      ).flat()
      return pixels(width, 1, bytes)
    }

    const redHidden = identityAnalysis(makeSource([255, 0, 0]))
    const greenHidden = identityAnalysis(makeSource([0, 255, 0]))

    expect(redHidden).toEqual(greenHidden)
    expect(redHidden.alpha.every((value) => value === 0.5)).toBe(true)
    expect(redHidden.positiveSupport.every(Boolean)).toBe(true)
  })

  it('hard-caps a large noisy source with an aspect-preserving lattice', () => {
    const width = 1000
    const height = 700
    const data = new Uint8Array(width * height * 4)
    for (let index = 0; index < data.length; index += 1) {
      data[index] = (index * 73 + 41) % 256
    }
    const result = identityAnalysis({ width, height, data })

    expect(result.width).toBe(ANALYSIS_MAX_DIMENSION)
    expect(result.height).toBe(179)
    expect(result.width / result.height).toBeCloseTo(width / height, 2)
    expect(result.luminance).toHaveLength(result.width * result.height)
    expect(result.alpha).toHaveLength(result.width * result.height)
    expect(result.positiveSupport).toHaveLength(result.width * result.height)
    expect(Math.max(result.width, result.height)).toBeLessThanOrEqual(
      ANALYSIS_MAX_DIMENSION,
    )
  })

  it('clamps source edges instead of adding a letterbox-zero comparison', () => {
    const result = identityAnalysis(solidPixels(1, 1, [255, 255, 255, 255]), {
      width: 1000,
      height: 10,
    })

    expect(result.luminance).toEqual([1])
    expect(result.alpha).toEqual([1])
    expect(result.positiveSupport).toEqual([true])
  })

  it.each([
    ['tiny black', solidPixels(1, 1, [0, 0, 0, 255]), [0], [1], [true]],
    [
      'flat gray',
      solidPixels(2, 2, [128, 128, 128, 255]),
      null,
      [1, 1, 1, 1],
      [true, true, true, true],
    ],
    [
      'transparent',
      solidPixels(2, 1, [255, 0, 255, 0]),
      [0, 0],
      [0, 0],
      [false, false],
    ],
  ] as const)(
    'returns a finite bounded result for %s input',
    (_name, source, expectedLuminance, expectedAlpha, expectedSupport) => {
      const result = identityAnalysis(source)

      if (expectedLuminance !== null) {
        expect(result.luminance).toEqual(expectedLuminance)
      }
      expect(result.alpha).toEqual(expectedAlpha)
      expect(result.positiveSupport).toEqual(expectedSupport)
      expect(result.luminance.every(Number.isFinite)).toBe(true)
      expect(result.luminance.every((value) => value >= 0 && value <= 1)).toBe(
        true,
      )
    },
  )

  it.each([
    ['zero width', { width: 0, height: 1, data: Uint8Array.from([]) }, FRAME],
    [
      'fractional height',
      { width: 1, height: 1.5, data: Uint8Array.from([]) },
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
  ])(
    'fails closed to a bounded empty analysis for %s',
    (_name, source, frame) => {
      const result = analyzePencilContourRaster(
        source as unknown as DecodedPixels,
        frame,
        defaultPencilContourControls,
      )

      expect(result).toEqual({
        sourceWidth: 0,
        sourceHeight: 0,
        width: 0,
        height: 0,
        luminance: [],
        alpha: [],
        positiveSupport: [],
      })
      expect(Object.isFrozen(result)).toBe(true)
      expect(Object.isFrozen(result.luminance)).toBe(true)
      expect(Object.isFrozen(result.alpha)).toBe(true)
      expect(Object.isFrozen(result.positiveSupport)).toBe(true)
    },
  )

  it('does not mutate its decoded bytes, frame, controls, or returned snapshots', () => {
    const source = pixels(2, 1, [20, 30, 40, 64, 200, 210, 220, 255])
    const originalBytes = Uint8Array.from(source.data)
    const frame = { width: 123, height: 77 }
    const originalFrame = { ...frame }
    const controls = { ...defaultPencilContourControls, gamma: 0.61 }
    const originalControls = { ...controls }

    const result = analyzePencilContourRaster(source, frame, controls)

    expect(source.data).toEqual(originalBytes)
    expect(frame).toEqual(originalFrame)
    expect(controls).toEqual(originalControls)
    expect(Object.isFrozen(result)).toBe(true)
    expect(Object.isFrozen(result.luminance)).toBe(true)
    expect(Object.isFrozen(result.alpha)).toBe(true)
    expect(Object.isFrozen(result.positiveSupport)).toBe(true)
  })
})
