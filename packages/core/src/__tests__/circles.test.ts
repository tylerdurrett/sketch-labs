import { describe, expect, it } from 'vitest'

import { createRandom } from '../random'
import { circles } from '../sketches/circles'
import type { Params } from '../sketch'
import {
  DEFAULT_COMPOSITION_FRAME,
  resolveCompositionFrame,
} from '../compositionFrame'

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
    const scene = circles.generate({ count: 5 }, 'seed-a', 0, DEFAULT_COMPOSITION_FRAME)
    expect(scene.primitives).toHaveLength(5)
    for (const primitive of scene.primitives) {
      expect(primitive.closed).toBe(true)
      // Each circle is a non-degenerate ring of perimeter points.
      expect(primitive.points.length).toBeGreaterThan(3)
    }
  })
})

describe('circles composes into the supplied Composition Frame', () => {
  it('returns a Scene whose space equals the supplied frame exactly', () => {
    const params: Params = { count: 8 }
    // Default (square) frame.
    const square = circles.generate(params, 'frame-seed', 0, DEFAULT_COMPOSITION_FRAME)
    expect(square.space).toEqual(DEFAULT_COMPOSITION_FRAME)

    // A non-square frame and its transpose — the Scene must adopt each exactly,
    // not the historical hardcoded 1000×1000 extent.
    const wide = resolveCompositionFrame(2)
    const tall = resolveCompositionFrame(0.5)
    expect(circles.generate(params, 'frame-seed', 0, wide).space).toEqual(wide)
    expect(circles.generate(params, 'frame-seed', 0, tall).space).toEqual(tall)
  })

  it('fills the non-square extent — geometry reaches toward the frame width, not 1000', () => {
    // Many circles so the seeded centers sample the full width; a still-hardcoded
    // 1000-wide implementation would cap maxX near 1000 and fail this.
    const wide = resolveCompositionFrame(2) // width = 1000·√2 ≈ 1414
    const scene = circles.generate({ count: 80, minRadius: 2, maxRadius: 4 }, 'fill', 0, wide)
    let maxX = -Infinity
    for (const primitive of scene.primitives) {
      for (const [x] of primitive.points) if (x > maxX) maxX = x
    }
    expect(maxX).toBeGreaterThan(1000)
    // Centers land in [0, width]; the tiny radius keeps maxX just past the edge.
    expect(maxX).toBeLessThanOrEqual(wide.width + 10)
  })
})

describe('circles determinism (ADR-0002)', () => {
  it('is deterministic at the Scene level for identical (params, seed, t)', () => {
    const params: Params = { count: 12, minRadius: 8, maxRadius: 40 }
    const a = circles.generate(params, 'fixed-seed', 1.25, DEFAULT_COMPOSITION_FRAME)
    const b = circles.generate(params, 'fixed-seed', 1.25, DEFAULT_COMPOSITION_FRAME)
    // Asserted at the Scene level (drawn Primitives), never at the pixel level.
    expect(a).toEqual(b)
  })

  it('is deterministic for a fixed non-square frame', () => {
    const params: Params = { count: 12, minRadius: 8, maxRadius: 40 }
    const frame = resolveCompositionFrame(2)
    const a = circles.generate(params, 'fixed-seed', 1.25, frame)
    const b = circles.generate(params, 'fixed-seed', 1.25, frame)
    expect(a).toEqual(b)
  })

  it('produces the same Scene for the same t (re-evaluated), no cross-call state', () => {
    const params: Params = { count: 7 }
    // Interleave other generate calls to surface any accumulated state.
    const first = circles.generate(params, 's', 0.5, DEFAULT_COMPOSITION_FRAME)
    circles.generate(params, 's', 9.9, DEFAULT_COMPOSITION_FRAME)
    circles.generate({ count: 3 }, 'other', 2, DEFAULT_COMPOSITION_FRAME)
    const again = circles.generate(params, 's', 0.5, DEFAULT_COMPOSITION_FRAME)
    expect(again).toEqual(first)
  })

  it('animates with t: a different t yields a different Scene', () => {
    const params: Params = { count: 10 }
    const atZero = circles.generate(params, 's', 0, DEFAULT_COMPOSITION_FRAME)
    const atQuarter = circles.generate(params, 's', 1, DEFAULT_COMPOSITION_FRAME) // duration/4 ⇒ pulse peak
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
    const sceneA = circles.generate(params, 'gen-seed-a', 0, DEFAULT_COMPOSITION_FRAME)
    const sceneB = circles.generate(params, 'gen-seed-b', 0, DEFAULT_COMPOSITION_FRAME)
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
