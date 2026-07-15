import { describe, expect, it } from 'vitest'

import { layoutHillBands } from '../sketches/grass-hills/depth'
import {
  scatterGrassRoots,
  type GrassRootCandidate,
} from '../sketches/grass-hills/grass-scatter'
import {
  ADOPTED_BLADE_COUNT,
  allocateGrassRootCounts,
  bladeCountForDensity,
  canonicalScale,
  selectGrassRoots,
} from '../sketches/grass-hills/grass-selection'

function root(rootKey: string, ordinal: number): GrassRootCandidate {
  return { rootKey, ordinal, u: ordinal / 10, v: ordinal / 10 }
}

describe('grass-hills composition density mapping', () => {
  it('maps the unchanged relative 0..2 schema onto the adopted full 10k target', () => {
    expect(ADOPTED_BLADE_COUNT).toBe(10_000)
    expect([0, 0.25, 0.5, 1, 1.5, 2].map(bladeCountForDensity)).toEqual([
      0, 1_250, 2_500, 5_000, 7_500, 10_000,
    ])
  })

  it.each([-1, 2.01, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects density outside the public schema at %s',
    (bladeDensity) => {
      expect(() => bladeCountForDensity(bladeDensity)).toThrow(
        /bladeDensity must be between 0 and 2/,
      )
    },
  )

  it('apportions the exact adopted count by continuous depth weight', () => {
    const bands = layoutHillBands(10, {
      frame: { height: 1_000 },
      horizonHeight: 0.25,
      depthFalloff: 2,
    })
    const counts = allocateGrassRootCounts(
      bands.map(({ depth }) => depth),
      2,
    )

    expect(counts).toEqual([
      3_094, 1_928, 1_316, 955, 724, 568, 457, 376, 315, 267,
    ])
    expect(counts.reduce((sum, count) => sum + count, 0)).toBe(10_000)
    expect(counts[0]! / counts.at(-1)!).toBeCloseTo(
      (1 / canonicalScale(bands[0]!.depth) ** 2) /
        (1 / canonicalScale(bands.at(-1)!.depth) ** 2),
      1,
    )
  })

  it('is house-monotone as density increases and emits an exact rounded total', () => {
    const depths = layoutHillBands(10, {
      frame: { height: 1_000 },
      horizonHeight: 0.25,
      depthFalloff: 2,
    }).map(({ depth }) => depth)
    let previous = allocateGrassRootCounts(depths, 0)

    for (let step = 1; step <= 40; step++) {
      const density = step / 20
      const next = allocateGrassRootCounts(depths, density)
      expect(next.reduce((sum, count) => sum + count, 0)).toBe(
        bladeCountForDensity(density),
      )
      expect(next.every((count, index) => count >= previous[index]!)).toBe(
        true,
      )
      previous = next
    }
  })

  it('returns a frozen all-zero allocation at zero density', () => {
    const counts = allocateGrassRootCounts([0.25, 0.5, 0.75], 0)
    expect(counts).toEqual([0, 0, 0])
    expect(Object.isFrozen(counts)).toBe(true)
  })
})

describe('grass-hills deterministic prefix selection', () => {
  it('selects a frozen prefix without mutating or replacing canonical identities', () => {
    const candidates = scatterGrassRoots({
      seed: 'immutable-selection',
      hillKey: '1/2',
    })
    const originalOrder = [...candidates]
    const selected = selectGrassRoots({ count: 1_000, candidates })

    expect(Object.isFrozen(selected)).toBe(true)
    expect(candidates).toEqual(originalOrder)
    expect(selected).toEqual(candidates.slice(0, 1_000))
    expect(selected.every((candidate) => candidates.includes(candidate))).toBe(
      true,
    )
  })

  it('keeps lower-density selections nested at unchanged coordinates and keys', () => {
    const candidates = scatterGrassRoots({ seed: 'nested', hillKey: '3/4' })
    const sparse = selectGrassRoots({ count: 400, candidates })
    const dense = selectGrassRoots({ count: 3_000, candidates })

    expect(dense.slice(0, sparse.length)).toEqual(sparse)
  })

  it('uses the canonical priority order directly instead of candidate geometry', () => {
    const candidates = [root('first', 0), root('second', 1), root('third', 2)]
    expect(selectGrassRoots({ count: 2, candidates })).toEqual(
      candidates.slice(0, 2),
    )
  })

  it.each([-1, 1.5])('rejects invalid root count %s', (count) => {
    expect(() => selectGrassRoots({ count, candidates: [] })).toThrow(
      /root count must be a non-negative integer/,
    )
  })

  it('rejects a count above the canonical capacity', () => {
    expect(() =>
      selectGrassRoots({ count: 2, candidates: [root('only', 0)] }),
    ).toThrow(/exceeds canonical capacity/)
  })
})
