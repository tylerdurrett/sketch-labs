import { describe, expect, it } from 'vitest'

import * as barrel from '../index'
import { circles } from '../sketches/circles'
import { leafField } from '../sketches/leaf-field'
import { bbox as pointsBBox } from '../sketches/sketch-util'
import type { Params } from '../sketch'
import type { Primitive } from '../scene'

/** The six leaf-field knobs, in declaration order. */
const KNOBS = [
  'fieldScale',
  'turbulence',
  'density',
  'leafSizeMin',
  'leafSizeMax',
  'variation',
] as const

/** The bold dark fill and paper-colored rim the audit pinned (see the sketch header). */
const LEAF_FILL = '#1a1a1a'
const PAPER_STROKE = '#f4f1ea'

/** Axis-aligned bounding box of a single primitive's points. */
function primitiveBBox(primitive: Primitive) {
  return pointsBBox(primitive.points)
}

/** True if two axis-aligned bounding boxes overlap. */
function bboxesOverlap(
  a: ReturnType<typeof primitiveBBox>,
  b: ReturnType<typeof primitiveBBox>,
): boolean {
  return a.minX <= b.maxX && b.minX <= a.maxX && a.minY <= b.maxY && b.minY <= a.maxY
}

describe('leaf-field Sketch contract', () => {
  it('declares exactly the six knobs in order and NO time metadata (static)', () => {
    expect(Object.keys(leafField.schema)).toEqual([...KNOBS])
    // Static Sketch: absence of `time` is what makes the Harness hide the scrubber.
    expect(leafField.time).toBeUndefined()
  })

  it('bakes a FIELD of closed leaves, each dark-filled with a distinct paper rim', () => {
    const scene = leafField.generate({}, 'seed-a', 0)
    // A field, not one leaf.
    expect(scene.primitives.length).toBeGreaterThan(1)
    for (const primitive of scene.primitives) {
      expect(primitive.closed).toBe(true)
      // Audit's painter's-order-observability requirement: bold dark FILL AND a
      // light paper STROKE, and the two colors must be distinct so overlap reads.
      expect(primitive.fill?.color).toBe(LEAF_FILL)
      expect(primitive.stroke?.color).toBe(PAPER_STROKE)
      expect(primitive.fill?.color).not.toBe(primitive.stroke?.color)
      // A closed leaf outline is a non-degenerate ring of points.
      expect(primitive.points.length).toBeGreaterThan(3)
    }
  })
})

describe('leaf-field density is live-tunable', () => {
  it('a higher density yields strictly more leaves than a lower density at the same seed', () => {
    const seed = 'held'
    const sparse = leafField.generate({ density: 2 }, seed, 0)
    const dense = leafField.generate({ density: 10 }, seed, 0)
    expect(dense.primitives.length).toBeGreaterThan(sparse.primitives.length)
  })
})

describe("leaf-field painter's order / overlap", () => {
  it('bakes many overlapping leaves in draw order (index 0 = bottom)', () => {
    // A dense field of large leaves: total leaf area far exceeds the canvas, so
    // leaves must overlap. Assert externally-observable overlap of two bboxes.
    const scene = leafField.generate(
      { density: 12, leafSizeMin: 300, leafSizeMax: 400 },
      'overlap-seed',
      0,
    )
    expect(scene.primitives.length).toBeGreaterThan(1)

    // At least one pair of primitive bounding boxes intersects.
    let foundOverlap = false
    outer: for (let i = 0; i < scene.primitives.length; i++) {
      const a = primitiveBBox(scene.primitives[i]!)
      for (let j = i + 1; j < scene.primitives.length; j++) {
        if (bboxesOverlap(a, primitiveBBox(scene.primitives[j]!))) {
          foundOverlap = true
          break outer
        }
      }
    }
    expect(foundOverlap).toBe(true)
  })
})

describe('leaf-field determinism (ADR-0002)', () => {
  it('is deterministic at the Scene level for identical (params, seed, t)', () => {
    const params: Params = { density: 6, leafSizeMin: 120, leafSizeMax: 200 }
    const a = leafField.generate(params, 'fixed-seed', 0)
    const b = leafField.generate(params, 'fixed-seed', 0)
    expect(a).toEqual(b)
  })

  it('carries no cross-call state — an interleaved generate does not perturb the result', () => {
    const params: Params = { density: 7 }
    const first = leafField.generate(params, 's', 0)
    // Interleave unrelated generate calls to surface any accumulated state.
    leafField.generate({ density: 3 }, 'other', 3)
    circles.generate({ count: 5 }, 'yet-another', 1)
    const again = leafField.generate(params, 's', 0)
    expect(again).toEqual(first)
  })

  it('ignores t (static): the same params/seed at different t yield the same Scene', () => {
    const params: Params = { density: 5 }
    const atZero = leafField.generate(params, 's', 0)
    const atLater = leafField.generate(params, 's', 42)
    expect(atLater).toEqual(atZero)
  })
})

describe('leaf-field seed independence', () => {
  it('a different seed rearranges the field while params hold', () => {
    const params: Params = { density: 6 }
    const sceneA = leafField.generate(params, 'seed-a', 0)
    const sceneB = leafField.generate(params, 'seed-b', 0)
    // The Poisson scatter is seeded, so a re-seed reshuffles placement.
    expect(sceneB).not.toEqual(sceneA)
  })
})

describe('leaf-field draw boundary', () => {
  it('emits only generic Primitive records — no leaf-typed field crosses the boundary', () => {
    const scene = leafField.generate({}, 'seed', 0)
    // The Scene container carries only `space` and `primitives`.
    expect(Object.keys(scene).sort()).toEqual(['primitives', 'space'])
    const allowed = new Set(['points', 'closed', 'fill', 'stroke'])
    for (const primitive of scene.primitives) {
      // Each Primitive is a plain record: only points/closed/fill/stroke keys.
      for (const key of Object.keys(primitive)) {
        expect(allowed.has(key)).toBe(true)
      }
      // Points are plain [x, y] number tuples — no domain object smuggled in.
      for (const point of primitive.points) {
        expect(point).toHaveLength(2)
        expect(typeof point[0]).toBe('number')
        expect(typeof point[1]).toBe('number')
      }
    }
  })

  it('the public barrel exposes leafField but no leaf domain type', () => {
    expect(barrel.leafField).toBe(leafField)
    // The private leaf generator/type must never leak across the public barrel.
    expect('leaf' in barrel).toBe(false)
    expect('LeafShape' in barrel).toBe(false)
  })
})
