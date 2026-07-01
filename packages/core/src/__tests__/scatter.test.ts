import { describe, expect, it } from 'vitest'

import { scatter } from '../sketches/scatter'
import type { Params } from '../sketch'
import type { Primitive } from '../scene'
import type { Point } from '../types'

/** Centroid of a baked dot polygon — the point the dot was scattered at. */
function centroid(primitive: Primitive): Point {
  const { points } = primitive
  let sx = 0
  let sy = 0
  for (const [x, y] of points) {
    sx += x
    sy += y
  }
  return [sx / points.length, sy / points.length]
}

/** Smallest pairwise distance between the given points (O(n²), fine for tests). */
function minPairwiseDistance(centers: readonly Point[]): number {
  let min = Infinity
  for (let i = 0; i < centers.length; i++) {
    for (let j = i + 1; j < centers.length; j++) {
      const d = Math.hypot(
        centers[i]![0] - centers[j]![0],
        centers[i]![1] - centers[j]![1],
      )
      if (d < min) min = d
    }
  }
  return min
}

describe('scatter Sketch contract', () => {
  it('is static (no time metadata) and declares its three knobs', () => {
    // No time metadata ⇒ the scrubber stays hidden (STATIC Sketch).
    expect(scatter.time).toBeUndefined()
    expect(Object.keys(scatter.schema)).toEqual([
      'baseRadius',
      'jitter',
      'kSamples',
    ])
    // k-samples is a whole-number candidate count.
    expect(scatter.schema.kSamples).toMatchObject({ integer: true })
  })

  it('bakes a Scene of closed-polygon dot Primitives', () => {
    const scene = scatter.generate({ baseRadius: 60 }, 'seed-a', 0)
    expect(scene.primitives.length).toBeGreaterThan(0)
    for (const primitive of scene.primitives) {
      expect(primitive.closed).toBe(true)
      // Each dot is a non-degenerate ring of perimeter points.
      expect(primitive.points.length).toBeGreaterThan(3)
    }
  })
})

describe('scatter determinism (ADR-0002)', () => {
  it('is deterministic at the Scene level for identical (params, seed, t)', () => {
    const params: Params = { baseRadius: 50, jitter: 0.2, kSamples: 20 }
    const a = scatter.generate(params, 'fixed-seed', 0)
    const b = scatter.generate(params, 'fixed-seed', 0)
    // Asserted at the Scene level (drawn Primitives), never at the pixel level.
    expect(a).toEqual(b)
  })

  it('produces the same Scene for the same inputs (re-evaluated), no cross-call state', () => {
    const params: Params = { baseRadius: 60 }
    // Interleave other generate calls to surface any accumulated state.
    const first = scatter.generate(params, 's', 0)
    scatter.generate(params, 'other', 0)
    scatter.generate({ baseRadius: 30 }, 's', 0)
    const again = scatter.generate(params, 's', 0)
    expect(again).toEqual(first)
  })
})

describe('scatter seed-independence', () => {
  it('reshuffles placement under a new seed while params hold', () => {
    const params: Params = { baseRadius: 60, jitter: 0.15, kSamples: 30 }
    const sceneA = scatter.generate(params, 'gen-seed-a', 0)
    const sceneB = scatter.generate(params, 'gen-seed-b', 0)
    // Same params, different seed ⇒ a different drawn arrangement.
    expect(sceneB).not.toEqual(sceneA)
  })

  it('raising base radius thins the scatter (density tracks the knob)', () => {
    const dense = scatter.generate({ baseRadius: 24 }, 's', 0)
    const sparse = scatter.generate({ baseRadius: 96 }, 's', 0)
    // A larger min-distance packs fewer points into the same extent.
    expect(sparse.primitives.length).toBeLessThan(dense.primitives.length)
  })
})

describe('scatter blue-noise sanity', () => {
  it('keeps baked dot centers at least the base radius apart (no clumps)', () => {
    const baseRadius = 60
    // No jitter so the sampler's min-distance guarantee is asserted directly.
    const scene = scatter.generate({ baseRadius, jitter: 0 }, 'blue-noise', 0)
    const centers = scene.primitives.map(centroid)
    expect(centers.length).toBeGreaterThan(1)
    const minDist = minPairwiseDistance(centers)
    // Blue-noise: every neighbour respects the base radius (allow float slack).
    expect(minDist).toBeGreaterThanOrEqual(baseRadius - 1e-6)
  })
})
