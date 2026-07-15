import { describe, expect, it } from 'vitest'

import { samplePoissonDisk } from '../poisson'
import { layoutHillBands } from '../sketches/grass-hills/depth'
import {
  scatterGrassRoots,
  type GrassRootCandidate,
} from '../sketches/grass-hills/grass-scatter'

const BASE_CANONICAL_RADIUS = 0.12

function canonicalDistance(
  a: GrassRootCandidate,
  b: GrassRootCandidate,
): number {
  return Math.hypot(a.u - b.u, a.v - b.v)
}

describe('grass-hills canonical grass scatter', () => {
  it.each([0.25, 1, 2])(
    'enforces canonical Poisson separation at density %s',
    (bladeDensity) => {
      const radius = BASE_CANONICAL_RADIUS / Math.sqrt(bladeDensity)
      const roots = scatterGrassRoots({
        seed: 'separation',
        hillKey: '1/2',
        bladeDensity,
      })

      expect(roots.length).toBeGreaterThan(1)
      for (let index = 0; index < roots.length; index++) {
        for (let other = index + 1; other < roots.length; other++) {
          expect(
            canonicalDistance(roots[index]!, roots[other]!),
          ).toBeGreaterThanOrEqual(radius - 1e-9)
        }
      }
    },
  )

  it('is exactly repeatable for the same seed, hill identity, and density', () => {
    const options = {
      seed: 42,
      hillKey: '3/4',
      bladeDensity: 1.25,
    } as const

    expect(scatterGrassRoots(options)).toEqual(scatterGrassRoots(options))
  })

  it('uses the pinned canonical radius and hill-local root seed', () => {
    const bladeDensity = 1.25
    const radius = BASE_CANONICAL_RADIUS / Math.sqrt(bladeDensity)
    const expected = samplePoissonDisk({
      width: 1,
      height: 1,
      radius: () => radius,
      minRadius: radius,
      seed: 'canonical-grass-roots-1/2',
    })
    const roots = scatterGrassRoots({
      seed: 'canonical',
      hillKey: '1/2',
      bladeDensity,
    })

    expect(roots.map(({ u, v }) => [u, v])).toEqual(expected)
  })

  it('re-seeding reshuffles the canonical root field', () => {
    const options = { hillKey: '2/3', bladeDensity: 1 } as const

    expect(scatterGrassRoots({ ...options, seed: 'seed-a' })).not.toEqual(
      scatterGrassRoots({ ...options, seed: 'seed-b' }),
    )
  })

  it('increases root count as density increases', () => {
    const low = scatterGrassRoots({
      seed: 'density-response',
      hillKey: '1/2',
      bladeDensity: 0.25,
    })
    const high = scatterGrassRoots({
      seed: 'density-response',
      hillKey: '1/2',
      bladeDensity: 2,
    })

    expect(high.length).toBeGreaterThan(low.length)
  })

  it('defines ordinals from the unfiltered sampler order and keys from hill identity', () => {
    const roots = scatterGrassRoots({
      seed: 'identity',
      hillKey: '3/5',
      bladeDensity: 1,
    })

    expect(roots.map(({ ordinal }) => ordinal)).toEqual(
      Array.from({ length: roots.length }, (_, ordinal) => ordinal),
    )
    expect(roots.map(({ rootKey }) => rootKey)).toEqual(
      roots.map((_, ordinal) => `3/5:${ordinal}`),
    )
  })

  it('keeps a shared reduced hill identity independent of hill count', () => {
    const projection = {
      frame: { height: 1000 },
      horizonHeight: 0.25,
      depthFalloff: 2,
    }
    const countThree = layoutHillBands(3, projection)
    const countSeven = layoutHillBands(7, projection)
    const sharedKey = '1/2'
    const keyAtThree = countThree.find(({ hillKey }) => hillKey === sharedKey)?.hillKey
    const keyAtSeven = countSeven.find(({ hillKey }) => hillKey === sharedKey)?.hillKey

    expect(keyAtThree).toBe(sharedKey)
    expect(keyAtSeven).toBe(sharedKey)

    const sharedOptions = {
      seed: 'count-independent',
      bladeDensity: 1,
    } as const
    expect(
      scatterGrassRoots({ ...sharedOptions, hillKey: keyAtThree! }),
    ).toEqual(scatterGrassRoots({ ...sharedOptions, hillKey: keyAtSeven! }))
  })

  it.each([0.25, 2])(
    'returns finite in-bounds roots at supported density %s',
    (bladeDensity) => {
      const roots = scatterGrassRoots({
        seed: 'supported-extremes',
        hillKey: '1/4',
        bladeDensity,
      })

      expect(roots.length).toBeGreaterThan(0)
      for (const root of roots) {
        expect(Number.isFinite(root.u)).toBe(true)
        expect(Number.isFinite(root.v)).toBe(true)
        expect(root.u).toBeGreaterThanOrEqual(0)
        expect(root.u).toBeLessThan(1)
        expect(root.v).toBeGreaterThanOrEqual(0)
        expect(root.v).toBeLessThan(1)
      }
    },
  )

  it('returns a frozen candidate collection', () => {
    const roots = scatterGrassRoots({
      seed: 'immutable',
      hillKey: '1/2',
      bladeDensity: 1,
    })

    expect(Object.isFrozen(roots)).toBe(true)
    expect(roots.every(Object.isFrozen)).toBe(true)
  })

  it('returns a frozen empty field at zero density', () => {
    const roots = scatterGrassRoots({
      seed: 'zero-density',
      hillKey: '1/2',
      bladeDensity: 0,
    })

    expect(roots).toEqual([])
    expect(Object.isFrozen(roots)).toBe(true)
  })

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects negative or non-finite density %s',
    (bladeDensity) => {
      expect(() =>
        scatterGrassRoots({
          seed: 'invalid-density',
          hillKey: '1/2',
          bladeDensity,
        }),
      ).toThrow(/bladeDensity must be a finite non-negative number/)
    },
  )
})
