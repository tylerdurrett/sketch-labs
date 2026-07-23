import { describe, expect, it } from 'vitest'

import type { DecodedPixels } from '../imageAssets'
import { createFlowingContoursAccounting } from '../sketches/flowing-contours/accounting'
import {
  FLOWING_CONTOURS_LIMITS,
  createFlowingContoursTestLimits,
} from '../sketches/flowing-contours/limits'
import { prepareFlowingContoursRaster } from '../sketches/flowing-contours/raster'

function pixels(
  width: number,
  height: number,
  data: Uint8Array | Uint8ClampedArray,
): DecodedPixels {
  return { width, height, data }
}

function solidRaster(
  width: number,
  height: number,
  rgba: readonly [number, number, number, number],
): DecodedPixels {
  const data = new Uint8ClampedArray(width * height * 4)
  for (let offset = 0; offset < data.length; offset += 4) {
    data.set(rgba, offset)
  }
  return pixels(width, height, data)
}

function prepare(source: DecodedPixels) {
  const accounting = createFlowingContoursAccounting()
  return {
    accounting,
    raster: prepareFlowingContoursRaster(source, accounting),
  }
}

describe('Flowing Contours raster preparation', () => {
  it('prepares a one-pixel straight-alpha raster without fabricated samples', () => {
    const { accounting, raster } = prepare(
      pixels(1, 1, Uint8Array.of(255, 0, 0, 128)),
    )

    expect(raster).toEqual({
      sourceWidth: 1,
      sourceHeight: 1,
      width: 1,
      height: 1,
      luminance: [0.2126],
      alpha: [128 / 255],
      positiveSupport: [true],
    })
    expect(accounting.analysisWidth).toBe(1)
    expect(accounting.analysisHeight).toBe(1)
    expect(accounting.analysisSampleCount).toBe(1)
    expect(accounting.termination).toBe('complete')
  })

  it('keeps straight-alpha color unassociated and preserves exact support', () => {
    const { raster } = prepare(
      pixels(2, 1, Uint8Array.of(255, 0, 0, 128, 255, 0, 0, 255)),
    )

    expect(raster.alpha).toEqual([128 / 255, 1])
    expect(raster.luminance[0]).toBeCloseTo(raster.luminance[1]!, 15)
    expect(raster.positiveSupport).toEqual([true, true])
  })

  it('returns finite all-zero signal for a fully transparent raster', () => {
    const { accounting, raster } = prepare(solidRaster(3, 2, [191, 73, 255, 0]))

    expect(raster.luminance).toEqual(Array<number>(6).fill(0))
    expect(raster.alpha).toEqual(Array<number>(6).fill(0))
    expect(raster.positiveSupport).toEqual(Array<boolean>(6).fill(false))
    expect(accounting).toMatchObject({
      termination: 'complete',
      analysisWidth: 3,
      analysisHeight: 2,
      analysisSampleCount: 6,
    })
  })

  it('makes resampled visible signal invariant to RGB behind zero alpha', () => {
    const first = solidRaster(257, 1, [0, 0, 0, 255])
    const second = solidRaster(257, 1, [0, 0, 0, 255])
    first.data.set([255, 0, 255, 0], 0)
    second.data.set([0, 255, 0, 0], 0)

    const firstRaster = prepare(first).raster
    const secondRaster = prepare(second).raster

    expect(firstRaster.width).toBe(256)
    expect(firstRaster.luminance).toEqual(secondRaster.luminance)
    expect(firstRaster.alpha).toEqual(secondRaster.alpha)
    expect(firstRaster.positiveSupport).toEqual(secondRaster.positiveSupport)
  })

  it('resamples identical decoded bytes deterministically', () => {
    const source = solidRaster(257, 2, [40, 90, 170, 192])
    source.data.set([210, 20, 70, 96], 4)

    const first = prepare(source).raster
    const second = prepare(source).raster

    expect(first).not.toBe(second)
    expect(first).toEqual(second)
  })

  it.each([
    [1, 600, 1, 256],
    [600, 1, 256, 1],
    [1024, 512, 256, 128],
    [512, 1024, 128, 256],
  ])(
    'bounds %ix%i to a contain-aspect %ix%i analysis lattice',
    (sourceWidth, sourceHeight, width, height) => {
      const { accounting, raster } = prepare(
        solidRaster(sourceWidth, sourceHeight, [64, 128, 192, 255]),
      )

      expect(raster).toMatchObject({
        sourceWidth,
        sourceHeight,
        width,
        height,
      })
      expect(raster.luminance).toHaveLength(width * height)
      expect(raster.alpha).toHaveLength(width * height)
      expect(raster.positiveSupport).toHaveLength(width * height)
      expect(accounting.analysisSampleCount).toBe(width * height)
      expect(Math.max(raster.width, raster.height)).toBeLessThanOrEqual(
        FLOWING_CONTOURS_LIMITS['analysis-dimension'],
      )
      expect(raster.width * raster.height).toBeLessThanOrEqual(
        FLOWING_CONTOURS_LIMITS['analysis-sample-count'],
      )
      expect(raster.luminance.every(Number.isFinite)).toBe(true)
      expect(raster.alpha.every(Number.isFinite)).toBe(true)
    },
  )

  it('accounts for the exact maximum analysis lattice', () => {
    const { accounting, raster } = prepare(
      solidRaster(257, 257, [255, 255, 255, 255]),
    )

    expect(raster.width).toBe(256)
    expect(raster.height).toBe(256)
    expect(raster.luminance).toHaveLength(65_536)
    expect(accounting).toMatchObject({
      termination: 'complete',
      limitedBy: null,
      analysisWidth: 256,
      analysisHeight: 256,
      analysisSampleCount: 65_536,
    })
  })

  it('returns detached frozen snapshots without mutating decoded bytes', () => {
    const source = pixels(2, 1, Uint8Array.of(0, 0, 0, 255, 255, 255, 255, 255))
    const before = source.data.slice()
    const { raster } = prepare(source)

    expect(source.data).toEqual(before)
    expect(Object.isFrozen(raster)).toBe(true)
    expect(Object.isFrozen(raster.luminance)).toBe(true)
    expect(Object.isFrozen(raster.alpha)).toBe(true)
    expect(Object.isFrozen(raster.positiveSupport)).toBe(true)
    expect(raster.luminance).not.toBe(source.data)
  })

  it.each([
    null,
    {},
    { width: 0, height: 1, data: new Uint8Array() },
    { width: 1, height: 0, data: new Uint8Array() },
    { width: Number.NaN, height: 1, data: new Uint8Array(4) },
    { width: 1, height: Number.POSITIVE_INFINITY, data: new Uint8Array(4) },
    { width: 1.5, height: 1, data: new Uint8Array(4) },
    { width: 1, height: 1, data: new Uint8Array(3) },
    { width: 1, height: 1, data: [0, 0, 0, 255] },
    {
      width: Number.MAX_SAFE_INTEGER,
      height: Number.MAX_SAFE_INTEGER,
      data: new Uint8Array(),
    },
  ])('fails malformed decoded input closed (%o)', (source) => {
    const accounting = createFlowingContoursAccounting()
    const raster = prepareFlowingContoursRaster(
      source as unknown as DecodedPixels,
      accounting,
    )

    expect(raster).toEqual({
      sourceWidth: 0,
      sourceHeight: 0,
      width: 0,
      height: 0,
      luminance: [],
      alpha: [],
      positiveSupport: [],
    })
    expect(accounting).toMatchObject({
      termination: 'invalid-input',
      limitedBy: null,
      analysisWidth: 0,
      analysisHeight: 0,
      analysisSampleCount: 0,
    })
  })

  it('fails hostile decoded records closed without invoking further work', () => {
    const accounting = createFlowingContoursAccounting()
    const source = Object.defineProperty({}, 'width', {
      get() {
        throw new Error('hostile decoded record')
      },
    })

    expect(() =>
      prepareFlowingContoursRaster(
        source as unknown as DecodedPixels,
        accounting,
      ),
    ).not.toThrow()
    expect(accounting.termination).toBe('invalid-input')
    expect(accounting.analysisSampleCount).toBe(0)
  })

  it('returns the shared frozen empty record for repeated failures', () => {
    const firstAccounting = createFlowingContoursAccounting()
    const secondAccounting = createFlowingContoursAccounting()
    const malformed = pixels(1, 1, new Uint8Array())
    const first = prepareFlowingContoursRaster(malformed, firstAccounting)
    const second = prepareFlowingContoursRaster(malformed, secondAccounting)

    expect(first).toBe(second)
    expect(Object.isFrozen(first)).toBe(true)
    expect(Object.isFrozen(first.luminance)).toBe(true)
    expect(Object.isFrozen(first.alpha)).toBe(true)
    expect(Object.isFrozen(first.positiveSupport)).toBe(true)
  })

  it('reports the first forced analysis-dimension cap exactly', () => {
    const accounting = createFlowingContoursAccounting()
    const limits = createFlowingContoursTestLimits({
      'analysis-dimension': 2,
    })!
    const raster = prepareFlowingContoursRaster(
      solidRaster(3, 2, [0, 0, 0, 255]),
      accounting,
      limits,
    )

    expect(raster.width).toBe(0)
    expect(accounting).toMatchObject({
      termination: 'limit-reached',
      limitedBy: 'analysis-dimension',
      analysisWidth: 0,
      analysisHeight: 0,
      analysisSampleCount: 0,
    })
  })

  it('reports a forced sample-count cap after dimension validation', () => {
    const accounting = createFlowingContoursAccounting()
    const limits = createFlowingContoursTestLimits({
      'analysis-sample-count': 5,
    })!
    const raster = prepareFlowingContoursRaster(
      solidRaster(3, 2, [0, 0, 0, 255]),
      accounting,
      limits,
    )

    expect(raster.width).toBe(0)
    expect(accounting).toMatchObject({
      termination: 'limit-reached',
      limitedBy: 'analysis-sample-count',
      analysisWidth: 0,
      analysisHeight: 0,
      analysisSampleCount: 0,
    })
  })
})
