import { describe, expect, it } from 'vitest'

import { calculateDetailEnergy } from '../detailAnalysis/energy'
import {
  createScalarGrid,
  prepareAnalysisGrid,
  type AnalysisGrid,
  type ScalarGrid,
} from '../detailAnalysis/grid'
import type { DecodedPixels } from '../imageAssets'

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

function energyOf(source: DecodedPixels, maxDimension?: number): ScalarGrid {
  const analysis = prepareAnalysisGrid(source, maxDimension)
  expect(analysis).not.toBeNull()
  const energy = calculateDetailEnergy(analysis!)
  expect(energy).not.toBeNull()
  return energy!
}

function total(grid: Readonly<ScalarGrid>): number {
  return grid.values.reduce((sum, value) => sum + value, 0)
}

function mean(grid: Readonly<ScalarGrid>): number {
  return total(grid) / grid.values.length
}

function linearGrayByte(value: number): number {
  const srgb =
    value <= 0.0031308
      ? value * 12.92
      : 1.055 * value ** (1 / 2.4) - 0.055
  return Math.round(srgb * 255)
}

function interiorMean(grid: Readonly<ScalarGrid>, border: number): number {
  let sum = 0
  let count = 0
  for (let y = border; y < grid.height - border; y += 1) {
    for (let x = border; x < grid.width - border; x += 1) {
      sum += grid.values[y * grid.width + x]!
      count += 1
    }
  }
  return sum / count
}

describe('detail-analysis band energy', () => {
  it('leaves opaque constants at zero or floating-point noise', () => {
    const energy = energyOf(pixels(48, 32, () => [137, 137, 137, 255]))

    expect(Math.max(...energy.values)).toBeLessThan(1e-28)
  })

  it('rejects broad linear illumination ramps while retaining localized edges', () => {
    const width = 96
    const height = 48
    const ramp = energyOf(
      pixels(width, height, (x) => {
        const value = Math.round((x / (width - 1)) * 255)
        return [value, value, value, 255]
      }),
    )
    const edge = energyOf(
      pixels(width, height, (x, y) =>
        x >= 36 && x < 60 && y >= 12 && y < 36
          ? [232, 232, 232, 255]
          : [24, 24, 24, 255],
      ),
    )

    expect(interiorMean(edge, 12)).toBeGreaterThan(0)
    expect(interiorMean(ramp, 12)).toBeLessThan(
      interiorMean(edge, 12) * 0.001,
    )
  })

  it('keeps capped high-resolution ramps negligible across the whole field', () => {
    const width = 1024
    const height = 512
    for (const axis of ['horizontal', 'vertical'] as const) {
      const energy = energyOf(
        pixels(width, height, (x, y) => {
          const position =
            axis === 'horizontal' ? x / (width - 1) : y / (height - 1)
          const value = linearGrayByte(position)
          return [value, value, value, 255]
        }),
      )
      expect(Math.max(...energy.values)).toBeLessThan(2e-5)
    }
  })

  it('registers fixed fine and medium periodic bands', () => {
    const ramp = interiorMean(
      energyOf(
        pixels(96, 48, (x) => {
          const value = Math.round((x / 95) * 255)
          return [value, value, value, 255]
        }),
      ),
      12,
    )
    const periodicEnergy = (period: number) =>
      interiorMean(
        energyOf(
          pixels(96, 48, (x) => {
            const value = Math.round(
              128 + 96 * Math.sin((x * Math.PI * 2) / period),
            )
            return [value, value, value, 255]
          }),
        ),
        12,
      )

    const fine = periodicEnergy(4)
    const medium = periodicEnergy(12)
    expect(fine).toBeGreaterThan(1e-7)
    expect(medium).toBeGreaterThan(1e-7)
    expect(ramp).toBeLessThan(fine * 0.001)
    expect(ramp).toBeLessThan(medium * 0.001)
  })

  it('ignores hidden zero-alpha RGB through the complete energy path', () => {
    const withBlackHidden = energyOf(
      pixels(64, 32, (x) =>
        x < 32 ? [180, 180, 180, 255] : [0, 0, 0, 0],
      ),
      16,
    )
    const withPatternHidden = energyOf(
      pixels(64, 32, (x, y) =>
        x < 32
          ? [180, 180, 180, 255]
          : [(x * 71) % 256, (y * 97) % 256, ((x + y) * 43) % 256, 0],
      ),
      16,
    )

    expect(withPatternHidden).toEqual(withBlackHidden)
  })

  it('registers hard and soft alpha transitions over black RGB', () => {
    const hard = energyOf(
      pixels(64, 32, (x) => [0, 0, 0, x < 32 ? 255 : 0]),
    )
    const soft = energyOf(
      pixels(64, 32, (x) => {
        const alpha = Math.round(Math.max(0, Math.min(1, (40 - x) / 16)) * 255)
        return [0, 0, 0, alpha]
      }),
    )

    expect(total(hard)).toBeGreaterThan(0)
    expect(total(soft)).toBeGreaterThan(0)
    expect(total(soft)).toBeLessThan(total(hard))
  })

  it('preserves alpha transitions beside the repaired capped margin', () => {
    const hard = energyOf(
      pixels(64, 32, (x) => [0, 0, 0, x < 10 ? 255 : 0]),
      16,
    )
    const soft = energyOf(
      pixels(64, 32, (x) => {
        const alpha = Math.round(
          Math.max(0, Math.min(1, (16 - x) / 12)) * 255,
        )
        return [0, 0, 0, alpha]
      }),
      16,
    )

    expect(total(hard)).toBeGreaterThan(0)
    expect(total(soft)).toBeGreaterThan(0)
    expect(total(soft)).toBeLessThan(total(hard))
  })

  it('responds continuously to a one-byte change in a soft alpha boundary', () => {
    const makeSoftBoundary = (centerAlpha: number) =>
      energyOf(
        pixels(33, 17, (x) => {
          let alpha = 255 - (x - 12) * 32
          if (x < 12) alpha = 255
          if (x > 20) alpha = 0
          if (x === 16) alpha = centerAlpha
          return [0, 0, 0, Math.max(0, Math.min(255, alpha))]
        }),
      )
    const lower = makeSoftBoundary(127)
    const upper = makeSoftBoundary(128)
    const difference = Math.abs(total(upper) - total(lower))

    expect(difference).toBeGreaterThan(0)
    expect(difference).toBeLessThan(total(lower) * 0.01)
  })

  it('does not treat an equal-linear-luminance chromatic boundary as detail', () => {
    // Linear Rec. 709 luminance is 0.2126 for red and about 0.2118 for this
    // byte-quantized green. The tiny residual is deliberately compared with a
    // true luminance boundary instead of requiring impossible byte equality.
    const chromatic = energyOf(
      pixels(64, 32, (x) =>
        x < 32 ? [255, 0, 0, 255] : [0, 148, 0, 255],
      ),
    )
    const luminance = energyOf(
      pixels(64, 32, (x) =>
        x < 32 ? [0, 0, 0, 255] : [255, 255, 255, 255],
      ),
    )

    expect(total(chromatic)).toBeLessThan(total(luminance) * 1e-5)
  })

  it('does not alias above-Nyquist source detail into a lower band after capping', () => {
    const residuals: ScalarGrid[] = []
    for (const { width, period } of [
      { width: 64, period: 2 },
      { width: 64, period: 3 },
      { width: 67, period: 5 },
    ]) {
      const energy = energyOf(
        pixels(width, 8, (x) => {
          let value = x % 2 === 0 ? 0 : 255
          if (period !== 2) {
            value = Math.round(
              127.5 + 127.5 * Math.sin((x * Math.PI * 2) / period),
            )
          }
          return [value, value, value, 255]
        }),
        16,
      )
      residuals.push(energy)
    }

    const retained = [16, 32].map((period) =>
      energyOf(
        pixels(64, 8, (x) => {
          const value = Math.round(
            127.5 + 127.5 * Math.sin((x * Math.PI * 2) / period),
          )
          return [value, value, value, 255]
        }),
        16,
      ),
    )
    const fine = retained[0]!
    const medium = retained[1]!
    expect(mean(fine)).toBeGreaterThan(1e-3)
    expect(mean(medium)).toBeGreaterThan(1e-3)
    for (const residual of residuals) {
      expect(mean(residual)).toBeLessThan(mean(fine) * 0.0025)
      expect(mean(residual)).toBeLessThan(mean(medium) * 0.001)
      expect(Math.max(...residual.values)).toBeLessThan(2e-5)
      expect(Math.max(...residual.values)).toBeLessThan(
        Math.max(...fine.values) * 0.01,
      )
    }
  })

  it('is deterministic, finite, immutable, and fails closed on invalid grids', () => {
    const analysis = prepareAnalysisGrid(
      pixels(41, 27, (x, y) => [x * 5, y * 7, (x + y) * 3, (x * y) % 256]),
    )!
    const luminanceBefore = [...analysis.luminance.values]
    const alphaBefore = [...analysis.alpha.values]
    const first = calculateDetailEnergy(analysis)
    const second = calculateDetailEnergy(analysis)

    expect(second).toEqual(first)
    expect(first!.values.every(Number.isFinite)).toBe(true)
    expect(Object.isFrozen(first)).toBe(true)
    expect(Object.isFrozen(first!.values)).toBe(true)
    expect(analysis.luminance.values).toEqual(luminanceBefore)
    expect(analysis.alpha.values).toEqual(alphaBefore)

    const one = createScalarGrid(1, 1, [0])!
    const two = createScalarGrid(2, 1, [0, 0])!
    expect(calculateDetailEnergy(null as unknown as AnalysisGrid)).toBeNull()
    expect(
      calculateDetailEnergy({
        luminance: { width: 1, height: 1, values: [Number.NaN] },
        alpha: one,
      }),
    ).toBeNull()
    expect(
      calculateDetailEnergy({
        luminance: {
          width: 3,
          height: 1,
          values: [Number.MAX_VALUE, -Number.MAX_VALUE, Number.MAX_VALUE],
        },
        alpha: createScalarGrid(3, 1, [0, 0, 0])!,
      }),
    ).toBeNull()
    expect(calculateDetailEnergy({ luminance: one, alpha: two })).toBeNull()
  })
})
