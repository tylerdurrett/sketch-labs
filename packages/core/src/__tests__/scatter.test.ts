import { describe, expect, it } from 'vitest'

import { scatter } from '../sketches/scatter'
import type { Params } from '../sketch'
import type { Primitive } from '../scene'
import type { Point } from '../types'
import {
  DEFAULT_COMPOSITION_FRAME,
  resolveCompositionFrame,
} from '../compositionFrame'

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
    const scene = scatter.generate({ baseRadius: 60 }, 'seed-a', 0, DEFAULT_COMPOSITION_FRAME)
    expect(scene.primitives.length).toBeGreaterThan(0)
    for (const primitive of scene.primitives) {
      expect(primitive.closed).toBe(true)
      // Each dot is a non-degenerate ring of perimeter points.
      expect(primitive.points.length).toBeGreaterThan(3)
    }
  })
})

describe('scatter composes into the supplied Composition Frame', () => {
  it('returns a Scene whose space equals the supplied frame exactly', () => {
    const params: Params = { baseRadius: 60 }
    const square = scatter.generate(params, 'frame-seed', 0, DEFAULT_COMPOSITION_FRAME)
    expect(square.space).toEqual(DEFAULT_COMPOSITION_FRAME)

    const wide = resolveCompositionFrame(2)
    const tall = resolveCompositionFrame(0.5)
    expect(scatter.generate(params, 'frame-seed', 0, wide).space).toEqual(wide)
    expect(scatter.generate(params, 'frame-seed', 0, tall).space).toEqual(tall)
  })

  it('scatters across the whole non-square extent — dots reach toward the frame width, not 1000', () => {
    // The Poisson sampler fills the frame, so a non-square frame's dots must reach
    // past x=1000; a still-hardcoded 1000-wide sampler would cap them near 1000.
    const wide = resolveCompositionFrame(2) // width = 1000·√2 ≈ 1414
    const scene = scatter.generate({ baseRadius: 60, jitter: 0 }, 'fill', 0, wide)
    let maxX = -Infinity
    for (const primitive of scene.primitives) {
      for (const [x] of primitive.points) if (x > maxX) maxX = x
    }
    expect(maxX).toBeGreaterThan(1000)
    expect(maxX).toBeLessThanOrEqual(wide.width + 100)
  })
})

describe('scatter determinism (ADR-0002)', () => {
  it('is deterministic at the Scene level for identical (params, seed, t)', () => {
    const params: Params = { baseRadius: 50, jitter: 0.2, kSamples: 20 }
    const a = scatter.generate(params, 'fixed-seed', 0, DEFAULT_COMPOSITION_FRAME)
    const b = scatter.generate(params, 'fixed-seed', 0, DEFAULT_COMPOSITION_FRAME)
    // Asserted at the Scene level (drawn Primitives), never at the pixel level.
    expect(a).toEqual(b)
  })

  it('is deterministic for a fixed non-square frame', () => {
    const params: Params = { baseRadius: 50, jitter: 0.2, kSamples: 20 }
    const frame = resolveCompositionFrame(2)
    const a = scatter.generate(params, 'fixed-seed', 0, frame)
    const b = scatter.generate(params, 'fixed-seed', 0, frame)
    expect(a).toEqual(b)
  })

  it('produces the same Scene for the same inputs (re-evaluated), no cross-call state', () => {
    const params: Params = { baseRadius: 60 }
    // Interleave other generate calls to surface any accumulated state.
    const first = scatter.generate(params, 's', 0, DEFAULT_COMPOSITION_FRAME)
    scatter.generate(params, 'other', 0, DEFAULT_COMPOSITION_FRAME)
    scatter.generate({ baseRadius: 30 }, 's', 0, DEFAULT_COMPOSITION_FRAME)
    const again = scatter.generate(params, 's', 0, DEFAULT_COMPOSITION_FRAME)
    expect(again).toEqual(first)
  })
})

describe('scatter seed-independence', () => {
  it('reshuffles placement under a new seed while params hold', () => {
    const params: Params = { baseRadius: 60, jitter: 0.15, kSamples: 30 }
    const sceneA = scatter.generate(params, 'gen-seed-a', 0, DEFAULT_COMPOSITION_FRAME)
    const sceneB = scatter.generate(params, 'gen-seed-b', 0, DEFAULT_COMPOSITION_FRAME)
    // Same params, different seed ⇒ a different drawn arrangement.
    expect(sceneB).not.toEqual(sceneA)
  })

  it('raising base radius thins the scatter (density tracks the knob)', () => {
    const dense = scatter.generate({ baseRadius: 24 }, 's', 0, DEFAULT_COMPOSITION_FRAME)
    const sparse = scatter.generate({ baseRadius: 96 }, 's', 0, DEFAULT_COMPOSITION_FRAME)
    // A larger min-distance packs fewer points into the same extent.
    expect(sparse.primitives.length).toBeLessThan(dense.primitives.length)
  })
})

describe('scatter blue-noise sanity', () => {
  it('keeps baked dot centers at least the base radius apart (no clumps)', () => {
    const baseRadius = 60
    // No jitter so the sampler's min-distance guarantee is asserted directly.
    const scene = scatter.generate({ baseRadius, jitter: 0 }, 'blue-noise', 0, DEFAULT_COMPOSITION_FRAME)
    const centers = scene.primitives.map(centroid)
    expect(centers.length).toBeGreaterThan(1)
    const minDist = minPairwiseDistance(centers)
    // Blue-noise: every neighbour respects the base radius (allow float slack).
    expect(minDist).toBeGreaterThanOrEqual(baseRadius - 1e-6)
  })
})
