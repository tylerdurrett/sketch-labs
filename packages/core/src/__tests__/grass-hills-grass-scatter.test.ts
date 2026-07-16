import { performance } from 'node:perf_hooks'

import { describe, expect, it } from 'vitest'

import { layoutHillBands } from '../sketches/grass-hills/depth'
import { scatterGrassRoots } from '../sketches/grass-hills/grass-scatter'

describe('grass-hills stable-cell canonical roots', () => {
  it('builds one finite jittered root in every cell of the adopted 100 x 100 bank', () => {
    const roots = scatterGrassRoots({ seed: 12345, hillKey: '1/2' })

    expect(roots).toHaveLength(10_000)
    expect(new Set(roots.map(({ rootKey }) => rootKey)).size).toBe(10_000)
    expect(roots.map(({ ordinal }) => ordinal)).toEqual(
      Array.from({ length: 10_000 }, (_, ordinal) => ordinal),
    )
    for (const { u, v, rootKey } of roots) {
      expect(u).toBeGreaterThanOrEqual(0)
      expect(u).toBeLessThan(1)
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThan(1)
      expect(rootKey).toMatch(/^1\/2:cell:\d{1,2},\d{1,2}$/)
    }
    expect(Object.isFrozen(roots)).toBe(true)
    expect(roots.every(Object.isFrozen)).toBe(true)
  })

  it('is repeatable and keeps a reduced hill identity independent of hill count', () => {
    const projection = {
      frame: { height: 1_000 },
      horizonHeight: 0.25,
      depthFalloff: 2,
    }
    expect(
      layoutHillBands(3, projection).some(({ hillKey }) => hillKey === '1/2'),
    ).toBe(true)
    expect(
      layoutHillBands(7, projection).some(({ hillKey }) => hillKey === '1/2'),
    ).toBe(true)

    const options = { seed: 'count-independent', hillKey: '1/2' } as const
    expect(scatterGrassRoots(options)).toEqual(scatterGrassRoots(options))
  })

  it('appends deterministic density layers without changing the adopted bank', () => {
    const options = { seed: 'extended-density', hillKey: '1/2' } as const
    const adopted = scatterGrassRoots(options)
    const extended = scatterGrassRoots({ ...options, minimumCount: 50_000 })

    expect(extended).toHaveLength(50_000)
    expect(extended.slice(0, adopted.length)).toEqual(adopted)
    expect(new Set(extended.map(({ rootKey }) => rootKey)).size).toBe(50_000)
    expect(extended.at(-1)?.ordinal).toBe(49_999)
    expect(
      extended.slice(10_000).every(
        ({ u, v, rootKey }) =>
          u >= 0 &&
          u < 1 &&
          v >= 0 &&
          v < 1 &&
          /^1\/2:layer:[1-4]:cell:\d{1,2},\d{1,2}$/.test(rootKey),
      ),
    ).toBe(true)
  })

  it('re-seeding changes priority order and jitter without changing cell identities', () => {
    const first = scatterGrassRoots({ seed: 'seed-a', hillKey: '2/3' })
    const reseeded = scatterGrassRoots({ seed: 'seed-b', hillKey: '2/3' })

    expect(reseeded).not.toEqual(first)
    expect(new Set(reseeded.map(({ rootKey }) => rootKey))).toEqual(
      new Set(first.map(({ rootKey }) => rootKey)),
    )
  })

  it('spreads a low priority prefix across the canonical hill', () => {
    const prefix = scatterGrassRoots({
      seed: 'low-prefix-coverage',
      hillKey: '9/10',
    }).slice(0, 40)

    expect(Math.max(...prefix.map(({ u }) => u))).toBeGreaterThan(0.85)
    expect(Math.min(...prefix.map(({ u }) => u))).toBeLessThan(0.15)
    expect(Math.max(...prefix.map(({ v }) => v))).toBeGreaterThan(0.85)
    expect(Math.min(...prefix.map(({ v }) => v))).toBeLessThan(0.15)
    for (const [uSide, vSide] of [
      [(u: number) => u < 0.5, (v: number) => v < 0.5],
      [(u: number) => u >= 0.5, (v: number) => v < 0.5],
      [(u: number) => u < 0.5, (v: number) => v >= 0.5],
      [(u: number) => u >= 0.5, (v: number) => v >= 0.5],
    ] as const) {
      expect(prefix.some(({ u, v }) => uSide(u) && vSide(v))).toBe(true)
    }
  })

  it('prepares the full canonical bank in linear generation plus one sort', () => {
    const started = performance.now()
    const roots = scatterGrassRoots({ seed: 'performance', hillKey: '9/10' })

    expect(roots).toHaveLength(10_000)
    // A generous regression guard: the retired quadratic selector took work
    // proportional to selected roots squared at dense counts.
    expect(performance.now() - started).toBeLessThan(2_000)
  })
})
