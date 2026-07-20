import { describe, expect, it } from 'vitest'

import { createScalarGrid, type ScalarGrid } from '../detailAnalysis/grid'
import { normalizeDetailEnergy } from '../detailAnalysis/normalize'

function energy(values: readonly number[]): ScalarGrid {
  return createScalarGrid(values.length, 1, values)!
}

describe('detail-analysis energy normalization', () => {
  it('collapses bounded noise and reviewed alias and ramp residuals to exact zero', () => {
    const boundedNoise = energy([
      0,
      1e-12,
      4e-6,
      1.25e-5,
      1.999e-5,
      2e-5,
    ])
    const cappedAliasResidual = energy([0, 3.1e-6, 9.8e-6, 1.48e-5])
    const cappedRampResidual = energy([0, 1.2e-6, 4.7e-6, 6.63e-6])

    for (const input of [
      boundedNoise,
      cappedAliasResidual,
      cappedRampResidual,
    ]) {
      const normalized = normalizeDetailEnergy(input)!
      expect(normalized.values.every((value) => value === 0)).toBe(true)
    }
  })

  it('spreads low-contrast meaningful structure above the floor across a useful range', () => {
    const normalized = normalizeDetailEnergy(
      energy([0, 2e-5, 2.1e-5, 2.3e-5, 2.6e-5, 3e-5]),
    )!
    const positive = normalized.values.filter((value) => value > 0)

    expect(Math.min(...positive)).toBeLessThan(0.2)
    expect(normalized.values[3]).toBeGreaterThan(0.4)
    expect(normalized.values[3]).toBeLessThan(0.6)
    expect(Math.max(...positive)).toBe(1)
    expect(new Set(positive).size).toBeGreaterThan(2)
  })

  it('keeps sparse meaningful structure from collapsing into the floor', () => {
    const normalized = normalizeDetailEnergy(energy([0, 0, 2.01e-5, 0]))!

    expect(normalized.values[2]).toBe(1)
    expect(
      normalized.values.filter((value) => value !== 0).length,
    ).toBe(1)
  })

  it('clamps an isolated extreme without flattening ordinary structure', () => {
    const ordinary = Array.from(
      { length: 99 },
      (_, index) => 3e-5 + (index / 98) * 7e-5,
    )
    const control = normalizeDetailEnergy(energy([...ordinary, 1e-4]))!
    const withExtreme = normalizeDetailEnergy(energy([...ordinary, 1e6]))!

    for (let index = 0; index < ordinary.length; index += 1) {
      expect(withExtreme.values[index]).toBe(control.values[index])
    }
    expect(withExtreme.values.at(-1)).toBe(1)
    expect(withExtreme.values[48]).toBeGreaterThan(0.4)
  })

  it('is deterministic, finite, immutable, and leaves its input untouched', () => {
    const source = [0, 2e-5, 2.5e-5, 5e-5, 1e-4]
    const input = energy(source)
    const first = normalizeDetailEnergy(input)
    const second = normalizeDetailEnergy(input)

    expect(second).toEqual(first)
    expect(input.values).toEqual(source)
    expect(first!.values.every(Number.isFinite)).toBe(true)
    expect(first!.values.every((value) => value >= 0 && value <= 1)).toBe(true)
    expect(Object.isFrozen(first)).toBe(true)
    expect(Object.isFrozen(first!.values)).toBe(true)
  })

  it('fails closed for malformed, negative, and non-finite energy grids', () => {
    expect(normalizeDetailEnergy(null as unknown as ScalarGrid)).toBeNull()
    expect(
      normalizeDetailEnergy({ width: 0, height: 1, values: [] }),
    ).toBeNull()
    expect(
      normalizeDetailEnergy({ width: 2, height: 1, values: [1] }),
    ).toBeNull()
    expect(
      normalizeDetailEnergy({ width: 1, height: 1, values: [-1] }),
    ).toBeNull()
    expect(
      normalizeDetailEnergy({ width: 1, height: 1, values: [Number.NaN] }),
    ).toBeNull()
    expect(
      normalizeDetailEnergy({
        width: 1,
        height: 1,
        values: [Number.POSITIVE_INFINITY],
      }),
    ).toBeNull()
  })
})
