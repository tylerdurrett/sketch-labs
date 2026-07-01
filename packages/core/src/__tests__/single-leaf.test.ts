import { describe, expect, it } from 'vitest'

import * as barrel from '../index'
import { circles } from '../sketches/circles'
import { singleLeaf } from '../sketches/single-leaf'
import type { Params } from '../sketch'
import type { Scene } from '../scene'

/** The five leaf shape knobs, in declaration order. */
const KNOBS = ['length', 'width', 'curl', 'wobble', 'tipSharpness'] as const

/** Axis-aligned bounding box of every point across a Scene's primitives. */
function bbox(scene: Scene): {
  minX: number
  minY: number
  maxX: number
  maxY: number
} {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const primitive of scene.primitives) {
    for (const [x, y] of primitive.points) {
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
    }
  }
  return { minX, minY, maxX, maxY }
}

describe('single-leaf Sketch contract', () => {
  it('declares exactly the five leaf knobs and NO time metadata (static)', () => {
    expect(Object.keys(singleLeaf.schema)).toEqual([...KNOBS])
    // Static Sketch: absence of `time` is what makes the Harness hide the scrubber.
    expect(singleLeaf.time).toBeUndefined()
  })

  it('bakes a Scene of one closed, filled leaf Primitive', () => {
    const scene = singleLeaf.generate({}, 'seed-a', 0)
    expect(scene.primitives).toHaveLength(1)
    const [leafPrimitive] = scene.primitives
    expect(leafPrimitive!.closed).toBe(true)
    expect(leafPrimitive!.fill).toBeDefined()
    // A closed leaf outline is a non-degenerate ring of points.
    expect(leafPrimitive!.points.length).toBeGreaterThan(3)
    // First point === last point (the outline closes).
    expect(leafPrimitive!.points.at(-1)).toEqual(leafPrimitive!.points[0])
  })
})

describe('single-leaf determinism (ADR-0002)', () => {
  it('is deterministic at the Scene level for identical (params, seed, t)', () => {
    const params: Params = { length: 600, width: 300, curl: 0.2, wobble: 8, tipSharpness: 0.5 }
    const a = singleLeaf.generate(params, 'fixed-seed', 0)
    const b = singleLeaf.generate(params, 'fixed-seed', 0)
    expect(a).toEqual(b)
  })

  it('carries no cross-call state — an interleaved generate does not perturb the result', () => {
    const params: Params = { wobble: 12 }
    const first = singleLeaf.generate(params, 's', 0)
    // Interleave unrelated generate calls to surface any accumulated state.
    singleLeaf.generate({ length: 200 }, 'other', 3)
    circles.generate({ count: 5 }, 'yet-another', 1)
    const again = singleLeaf.generate(params, 's', 0)
    expect(again).toEqual(first)
  })

  it('ignores t (static): the same params/seed at different t yield the same Scene', () => {
    const params: Params = { wobble: 10 }
    const atZero = singleLeaf.generate(params, 's', 0)
    const atLater = singleLeaf.generate(params, 's', 42)
    expect(atLater).toEqual(atZero)
  })
})

describe('single-leaf seed independence', () => {
  it('a different seed reshapes the leaf while params hold', () => {
    const params: Params = { wobble: 15 }
    const sceneA = singleLeaf.generate(params, 'seed-a', 0)
    const sceneB = singleLeaf.generate(params, 'seed-b', 0)
    // Wobble is seeded per-vertex, so a re-seed visibly varies the outline.
    expect(sceneB).not.toEqual(sceneA)
  })
})

describe('single-leaf knob response', () => {
  it('changing a shape knob measurably reshapes the outline', () => {
    const seed = 'held'
    const base: Params = { length: 400, width: 200, curl: 0, wobble: 0, tipSharpness: 0.5 }

    // Length grows the leaf's vertical extent.
    const shortBox = bbox(singleLeaf.generate({ ...base, length: 300 }, seed, 0))
    const tallBox = bbox(singleLeaf.generate({ ...base, length: 800 }, seed, 0))
    expect(tallBox.maxY - tallBox.minY).toBeGreaterThan(shortBox.maxY - shortBox.minY)

    // Width grows the leaf's horizontal extent.
    const narrowBox = bbox(singleLeaf.generate({ ...base, width: 80 }, seed, 0))
    const wideBox = bbox(singleLeaf.generate({ ...base, width: 480 }, seed, 0))
    expect(wideBox.maxX - wideBox.minX).toBeGreaterThan(narrowBox.maxX - narrowBox.minX)

    // Curl bends the silhouette, moving vertices vs. a straight spine.
    const straight = singleLeaf.generate({ ...base, curl: 0 }, seed, 0)
    const curled = singleLeaf.generate({ ...base, curl: 0.4 }, seed, 0)
    expect(curled).not.toEqual(straight)

    // tipSharpness slides the apex control points, reshaping the outline.
    const blunt = singleLeaf.generate({ ...base, tipSharpness: 0 }, seed, 0)
    const sharp = singleLeaf.generate({ ...base, tipSharpness: 1 }, seed, 0)
    expect(sharp).not.toEqual(blunt)
  })
})

describe('single-leaf draw boundary', () => {
  it('emits only generic Primitive records — no leaf-typed field crosses the boundary', () => {
    const scene = singleLeaf.generate({}, 'seed', 0)
    // The Scene container carries only `space` and `primitives`.
    expect(Object.keys(scene).sort()).toEqual(['primitives', 'space'])
    for (const primitive of scene.primitives) {
      // Each Primitive is a plain record: only points/closed/fill/stroke keys.
      const allowed = new Set(['points', 'closed', 'fill', 'stroke'])
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

  it('the public barrel exposes singleLeaf but no leaf domain type', () => {
    expect(barrel.singleLeaf).toBe(singleLeaf)
    // The private leaf generator/type must never leak across the public barrel.
    expect('leaf' in barrel).toBe(false)
    expect('LeafShape' in barrel).toBe(false)
  })
})
