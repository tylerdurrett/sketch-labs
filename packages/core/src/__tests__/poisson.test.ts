import { describe, expect, it } from 'vitest'

import { createRandom } from '../random'
import { samplePoissonDisk } from '../poisson'
import type { Point } from '../types'

const REGION = { width: 400, height: 300 }

function dist(a: Point, b: Point): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1])
}

describe('samplePoissonDisk', () => {
  it('fills the region with points inside the bounds', () => {
    const points = samplePoissonDisk({
      ...REGION,
      radius: () => 20,
      seed: 'fill',
    })
    expect(points.length).toBeGreaterThan(10)
    for (const [x, y] of points) {
      expect(x).toBeGreaterThanOrEqual(0)
      expect(x).toBeLessThan(REGION.width)
      expect(y).toBeGreaterThanOrEqual(0)
      expect(y).toBeLessThan(REGION.height)
    }
  })

  it('returns an empty array for a degenerate region', () => {
    expect(samplePoissonDisk({ width: 0, height: 100, radius: () => 10 })).toEqual([])
    expect(samplePoissonDisk({ width: 100, height: 0, radius: () => 10 })).toEqual([])
  })
})

describe('determinism', () => {
  it('same (seed, region, radius, k) produces an identical array', () => {
    const opts = { ...REGION, radius: () => 18, k: 30, seed: 'deterministic' }
    const a = samplePoissonDisk(opts)
    const b = samplePoissonDisk(opts)
    expect(a).toEqual(b)
    // Identical count, order, and coordinates (deep equality above covers all three).
    expect(a.length).toBe(b.length)
  })

  it('accepts an already-constructed Random and stays deterministic', () => {
    const opts = { ...REGION, radius: () => 22, k: 30 }
    const a = samplePoissonDisk({ ...opts, seed: createRandom('shared') })
    const b = samplePoissonDisk({ ...opts, seed: createRandom('shared') })
    expect(a).toEqual(b)
  })

  it('varying k changes the point set', () => {
    const base = { ...REGION, radius: () => 18, seed: 'k-sensitivity' }
    const few = samplePoissonDisk({ ...base, k: 3 })
    const many = samplePoissonDisk({ ...base, k: 40 })
    // More candidates typically pack more points; at minimum the sets differ.
    expect(many).not.toEqual(few)
  })
})

describe('seed-independence', () => {
  it('different seeds yield a different point set for the same region and radius', () => {
    const base = { ...REGION, radius: () => 20, k: 30 }
    const a = samplePoissonDisk({ ...base, seed: 'seed-a' })
    const b = samplePoissonDisk({ ...base, seed: 'seed-b' })
    expect(a).not.toEqual(b)
  })
})

describe('min-distance guarantee (constant radius)', () => {
  it('no two points are closer than the constant radius', () => {
    const R = 25
    const points = samplePoissonDisk({
      ...REGION,
      radius: () => R,
      k: 30,
      seed: 'constant-mindist',
    })
    expect(points.length).toBeGreaterThan(10)
    for (let i = 0; i < points.length; i++) {
      for (let j = i + 1; j < points.length; j++) {
        // Allow a hair of floating-point slack.
        expect(dist(points[i]!, points[j]!)).toBeGreaterThanOrEqual(R - 1e-9)
      }
    }
  })

  it('produces sane blue-noise spacing (points not clustered)', () => {
    const R = 30
    const points = samplePoissonDisk({
      ...REGION,
      radius: () => R,
      seed: 'blue-noise',
    })
    // Nearest-neighbour distance should be >= R for every point.
    for (let i = 0; i < points.length; i++) {
      let nearest = Infinity
      for (let j = 0; j < points.length; j++) {
        if (i === j) continue
        nearest = Math.min(nearest, dist(points[i]!, points[j]!))
      }
      if (points.length > 1) expect(nearest).toBeGreaterThanOrEqual(R - 1e-9)
    }
  })
})

describe('min-distance guarantee (variable radius, pinned max rule)', () => {
  it('honors max(radius(a), radius(b)) for a monotonically-varying field', () => {
    // Radius grows with x: sparse on the right, dense on the left.
    const radius = (x: number): number => 12 + (x / REGION.width) * 40
    const points = samplePoissonDisk({
      ...REGION,
      radius,
      minRadius: 12,
      k: 30,
      seed: 'variable-mindist',
    })
    expect(points.length).toBeGreaterThan(10)
    for (let i = 0; i < points.length; i++) {
      for (let j = i + 1; j < points.length; j++) {
        const a = points[i]!
        const b = points[j]!
        const required = Math.max(radius(a[0]), radius(b[0]))
        expect(dist(a, b)).toBeGreaterThanOrEqual(required - 1e-9)
      }
    }
  })

  it('a coarse (large-radius) point is not violated by a fine-radius neighbour', () => {
    // Left half fine, right half coarse — the pinned max rule must protect the
    // coarse point's larger radius even against a candidate whose own radius is small.
    const radius = (x: number): number => (x < REGION.width / 2 ? 15 : 60)
    const points = samplePoissonDisk({
      ...REGION,
      radius,
      minRadius: 15,
      seed: 'coarse-vs-fine',
    })
    for (let i = 0; i < points.length; i++) {
      for (let j = i + 1; j < points.length; j++) {
        const a = points[i]!
        const b = points[j]!
        const required = Math.max(radius(a[0]), radius(b[0]))
        expect(dist(a, b)).toBeGreaterThanOrEqual(required - 1e-9)
      }
    }
  })
})
