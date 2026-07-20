import { describe, expect, it } from 'vitest'

import type { DecodedPixels } from '../imageAssets'
import {
  createScalarGrid,
  prepareAnalysisGrid,
} from '../detailAnalysis/grid'
import {
  gaussianSmooth,
  localStructureEnergy,
} from '../detailAnalysis/scaleSpace'

function pixels(
  width: number,
  height: number,
  at: (x: number, y: number) => readonly [number, number, number, number],
): DecodedPixels {
  const data = new Uint8Array(width * height * 4)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      data.set(at(x, y), (y * width + x) * 4)
    }
  }
  return { width, height, data }
}

describe('detail-analysis grid', () => {
  it('builds finite immutable scalar grids and rejects malformed values', () => {
    const source = [1, 2, 3, 4]
    const grid = createScalarGrid(2, 2, source)!
    source[0] = 99

    expect(grid).toEqual({ width: 2, height: 2, values: [1, 2, 3, 4] })
    expect(Object.isFrozen(grid)).toBe(true)
    expect(Object.isFrozen(grid.values)).toBe(true)
    expect(createScalarGrid(0, 2, [])).toBeNull()
    expect(createScalarGrid(2, 2, [1, 2, 3])).toBeNull()
    expect(createScalarGrid(1, 1, [Number.NaN])).toBeNull()
  })

  it('preserves aspect within lattice rounding, respects its cap, and never upscales', () => {
    const productionCapped = prepareAnalysisGrid(
      pixels(300, 150, () => [128, 128, 128, 255]),
    )!
    expect([
      productionCapped.luminance.width,
      productionCapped.luminance.height,
    ]).toEqual([256, 128])

    const large = prepareAnalysisGrid(
      pixels(1000, 375, () => [128, 128, 128, 255]),
      200,
    )!
    expect([large.luminance.width, large.luminance.height]).toEqual([200, 75])
    expect(large.luminance.width / large.luminance.height).toBeCloseTo(
      1000 / 375,
      12,
    )

    const small = prepareAnalysisGrid(
      pixels(7, 3, () => [128, 128, 128, 255]),
      200,
    )!
    expect([small.luminance.width, small.luminance.height]).toEqual([7, 3])
  })

  it('area-averages alpha independently and ignores hidden RGB across a mixed cell', () => {
    const blackHidden = prepareAnalysisGrid(
      pixels(2, 1, (x) =>
        x === 0 ? [255, 255, 255, 255] : [0, 0, 0, 0],
      ),
      1,
    )!
    const redHidden = prepareAnalysisGrid(
      pixels(2, 1, (x) =>
        x === 0 ? [255, 255, 255, 255] : [255, 0, 0, 0],
      ),
      1,
    )!

    expect(blackHidden.alpha.values[0]).toBeCloseTo(0.5, 14)
    expect(blackHidden.luminance.values[0]).toBeCloseTo(1, 14)
    expect(redHidden).toEqual(blackHidden)
  })

  it('uses alpha-weighted visible linear Rec. 709 luminance', () => {
    const grid = prepareAnalysisGrid(
      pixels(2, 1, (x) =>
        x === 0 ? [255, 0, 0, 255] : [0, 255, 0, 128],
      ),
      1,
    )!
    const halfAlpha = 128 / 255

    expect(grid.alpha.values[0]).toBeCloseTo((1 + halfAlpha) / 2, 15)
    expect(grid.luminance.values[0]).toBeCloseTo(
      (0.2126 + 0.7152 * halfAlpha) / (1 + halfAlpha),
      15,
    )
  })

  it('is deterministic, leaves decoded bytes untouched, and fails closed', () => {
    const source = pixels(17, 9, (x, y) => [x * 7, y * 11, x + y, 200])
    const before = Uint8Array.from(source.data)
    const first = prepareAnalysisGrid(source, 8)
    const second = prepareAnalysisGrid(source, 8)

    expect(second).toEqual(first)
    expect(source.data).toEqual(before)
    expect(
      first!.luminance.values.every((value) => value >= 0 && value <= 1),
    ).toBe(true)
    expect(first!.alpha.values.every((value) => value >= 0 && value <= 1)).toBe(
      true,
    )
    expect(
      prepareAnalysisGrid({ width: 1, height: 1, data: new Uint8Array(3) }),
    ).toBeNull()
    expect(prepareAnalysisGrid(source, 0)).toBeNull()
  })

  it('antialiases commensurate and noncommensurate patterns above the capped lattice Nyquist rate', () => {
    const reduced = prepareAnalysisGrid(
      pixels(64, 8, (x) =>
        x % 2 === 0 ? [0, 0, 0, 255] : [255, 255, 255, 255],
      ),
      16,
    )!
    const energy = localStructureEnergy(reduced.luminance, 1)!

    const commensurateMean =
      energy.values.reduce((sum, value) => sum + value, 0) /
      energy.values.length
    const residualMeans = [commensurateMean]
    for (const { width, period } of [
      { width: 64, period: 3 },
      { width: 67, period: 5 },
    ]) {
      const noncommensurate = prepareAnalysisGrid(
        pixels(width, 8, (x) => {
          const value = Math.round(
            127.5 + 127.5 * Math.sin((x * Math.PI * 2) / period),
          )
          return [value, value, value, 255]
        }),
        16,
      )!
      const noncommensurateEnergy = localStructureEnergy(
        noncommensurate.luminance,
        1,
      )!
      residualMeans.push(
        noncommensurateEnergy.values.reduce((sum, value) => sum + value, 0) /
          noncommensurateEnergy.values.length,
      )
    }

    const retained = prepareAnalysisGrid(
      pixels(64, 8, (x) => {
        const value = Math.round(
          127.5 + 127.5 * Math.sin((x * Math.PI * 2) / 16),
        )
        return [value, value, value, 255]
      }),
      16,
    )!
    const retainedEnergy = localStructureEnergy(retained.luminance, 1)!
    const retainedMean =
      retainedEnergy.values.reduce((sum, value) => sum + value, 0) /
      retainedEnergy.values.length
    expect(retainedMean).toBeGreaterThan(1e-3)
    for (const residual of residualMeans) {
      expect(residual).toBeLessThan(retainedMean * 0.005)
    }
  })
})

describe('detail-analysis scale space', () => {
  it('preserves constants through smoothing and produces zero constant energy', () => {
    const constant = createScalarGrid(9, 7, new Array(63).fill(0.375))!
    const smoothed = gaussianSmooth(constant, 1.25)!
    const energy = localStructureEnergy(constant, 1)!

    for (const value of smoothed.values) expect(value).toBeCloseTo(0.375, 14)
    for (const value of energy.values) expect(value).toBe(0)
  })

  it('smooths an impulse symmetrically with reflected deterministic borders', () => {
    const values = new Array(9 * 9).fill(0)
    values[4 * 9 + 4] = 1
    const impulse = createScalarGrid(9, 9, values)!
    const first = gaussianSmooth(impulse, 1)!
    const second = gaussianSmooth(impulse, 1)!

    expect(second).toEqual(first)
    for (let y = 0; y < 9; y += 1) {
      for (let x = 0; x < 9; x += 1) {
        const value = first.values[y * 9 + x]
        expect(value).toBeCloseTo(first.values[y * 9 + (8 - x)], 15)
        expect(value).toBeCloseTo(first.values[(8 - y) * 9 + x], 15)
        expect(value).toBeCloseTo(first.values[x * 9 + y], 15)
      }
    }
  })

  it('gives horizontal and vertical ramps equal energy with diagonal tolerance', () => {
    const size = 25
    const makeRamp = (axis: 'x' | 'y' | 'diagonal') =>
      createScalarGrid(
        size,
        size,
        Array.from({ length: size * size }, (_, index) => {
          const x = index % size
          const y = Math.floor(index / size)
          if (axis === 'x') return x / (size - 1)
          if (axis === 'y') return y / (size - 1)
          return (x + y) / (Math.SQRT2 * (size - 1))
        }),
      )!
    const meanInterior = (grid: ReturnType<typeof localStructureEnergy>) => {
      let sum = 0
      let count = 0
      for (let y = 4; y < size - 4; y += 1) {
        for (let x = 4; x < size - 4; x += 1) {
          sum += grid!.values[y * size + x]
          count += 1
        }
      }
      return sum / count
    }

    const horizontal = meanInterior(localStructureEnergy(makeRamp('x'), 1))
    const vertical = meanInterior(localStructureEnergy(makeRamp('y'), 1))
    const diagonal = meanInterior(
      localStructureEnergy(makeRamp('diagonal'), 1),
    )

    expect(horizontal).toBeCloseTo(vertical, 15)
    expect(diagonal).toBeCloseTo(horizontal, 12)
  })

  it('does not mutate inputs and rejects non-finite grids or invalid scales', () => {
    const values = [0, 1, 0, 1]
    const grid = createScalarGrid(2, 2, values)!
    gaussianSmooth(grid, 0.8)
    localStructureEnergy(grid, 0.8)

    expect(values).toEqual([0, 1, 0, 1])
    expect(grid.values).toEqual(values)
    expect(gaussianSmooth(grid, 0)).toBeNull()
    expect(gaussianSmooth(grid, Number.POSITIVE_INFINITY)).toBeNull()
    expect(
      gaussianSmooth(
        { width: 1, height: 1, values: [Number.NaN] },
        1,
      ),
    ).toBeNull()
  })

  it('keeps all smoothing and energy outputs finite', () => {
    const grid = createScalarGrid(
      11,
      7,
      Array.from({ length: 77 }, (_, index) =>
        index % 3 === 0 ? Number.MAX_VALUE / 1e300 : index / 77,
      ),
    )!
    const smoothed = gaussianSmooth(grid, 1.5)!
    const energy = localStructureEnergy(smoothed, 1)!

    expect(smoothed.values.every(Number.isFinite)).toBe(true)
    expect(energy.values.every(Number.isFinite)).toBe(true)
  })
})
