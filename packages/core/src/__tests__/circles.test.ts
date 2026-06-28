import { describe, expect, it } from 'vitest'

import { createRandom } from '../random'
import { circles } from '../sketches/circles'
import type { Params } from '../sketch'

/**
 * A minimal engine-level param roll. This stands in for what the Harness engine
 * will eventually do — sample each schema knob within its declared `[min, max]`
 * bounds from a seeded RNG — WITHOUT any Lock/Randomize UI (that is slice 4).
 * It exists only so the tests can exercise rolled param VALUES independently of
 * the per-circle arrangement `generate` produces.
 */
function rollParams(seed: string | number): Params {
  const rng = createRandom(seed)
  const params: Params = {}
  for (const [key, spec] of Object.entries(circles.schema)) {
    const { min, max } = spec as { min: number; max: number }
    params[key] = rng.range(min, max)
  }
  return params
}

describe('circles Sketch contract', () => {
  it('declares a loop time metadata and a Parameter Schema', () => {
    expect(circles.time).toEqual({ duration: 4, mode: 'loop' })
    expect(Object.keys(circles.schema)).toEqual(['count', 'minRadius', 'maxRadius'])
  })

  it('bakes a Scene of closed-polygon circle Primitives', () => {
    const scene = circles.generate({ count: 5 }, 'seed-a', 0)
    expect(scene.primitives).toHaveLength(5)
    for (const primitive of scene.primitives) {
      expect(primitive.closed).toBe(true)
      // Each circle is a non-degenerate ring of perimeter points.
      expect(primitive.points.length).toBeGreaterThan(3)
    }
  })
})

describe('circles determinism (ADR-0002)', () => {
  it('is deterministic at the Scene level for identical (params, seed, t)', () => {
    const params: Params = { count: 12, minRadius: 8, maxRadius: 40 }
    const a = circles.generate(params, 'fixed-seed', 1.25)
    const b = circles.generate(params, 'fixed-seed', 1.25)
    // Asserted at the Scene level (drawn Primitives), never at the pixel level.
    expect(a).toEqual(b)
  })

  it('produces the same Scene for the same t (re-evaluated), no cross-call state', () => {
    const params: Params = { count: 7 }
    // Interleave other generate calls to surface any accumulated state.
    const first = circles.generate(params, 's', 0.5)
    circles.generate(params, 's', 9.9)
    circles.generate({ count: 3 }, 'other', 2)
    const again = circles.generate(params, 's', 0.5)
    expect(again).toEqual(first)
  })

  it('animates with t: a different t yields a different Scene', () => {
    const params: Params = { count: 10 }
    const atZero = circles.generate(params, 's', 0)
    const atQuarter = circles.generate(params, 's', 1) // duration/4 ⇒ pulse peak
    expect(atQuarter).not.toEqual(atZero)
  })
})

describe('circles two-axis independence (arrangement vs param values)', () => {
  it('re-seeding generate changes the arrangement but leaves rolled param VALUES untouched', () => {
    // Axis 1: the engine-rolled param values come from their own roll seed and
    // do not depend on the generate seed at all.
    const params = rollParams('param-roll-seed')
    const paramsAgain = rollParams('param-roll-seed')
    expect(paramsAgain).toEqual(params)

    // Axis 2: feeding the SAME params through generate under two different seeds
    // changes the circle arrangement...
    const sceneA = circles.generate(params, 'gen-seed-a', 0)
    const sceneB = circles.generate(params, 'gen-seed-b', 0)
    expect(sceneB).not.toEqual(sceneA)

    // ...while the rolled param values the test holds are still untouched.
    expect(params).toEqual(rollParams('param-roll-seed'))
  })
})

describe('circles engine-rolled param bounds', () => {
  it('keeps every rolled param value within its schema control [min, max]', () => {
    for (let i = 0; i < 200; i++) {
      const params = rollParams(`bounds-${i}`)
      for (const [key, spec] of Object.entries(circles.schema)) {
        const { min, max } = spec as { min: number; max: number }
        const value = params[key] as number
        expect(value).toBeGreaterThanOrEqual(min)
        expect(value).toBeLessThan(max)
      }
    }
  })
})
