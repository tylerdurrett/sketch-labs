import { describe, expect, it } from 'vitest'

import { createRandom } from '../random'
import { flowField } from '../sketches/flow-field'
import type { Params } from '../sketch'
import type { Primitive } from '../scene'
import { DEFAULT_COMPOSITION_FRAME } from '../compositionFrame'

/**
 * A minimal engine-level param roll — mirrors circles.test.ts. Stands in for
 * what the Harness engine will eventually do (sample each schema knob within its
 * declared `[min, max]` from a seeded RNG) WITHOUT any Lock/Randomize UI, so the
 * tests can exercise rolled param VALUES independently of the arrangement
 * `generate` produces.
 */
function rollParams(seed: string | number): Params {
  const rng = createRandom(seed)
  const params: Params = {}
  for (const [key, spec] of Object.entries(flowField.schema)) {
    const { min, max } = spec as { min: number; max: number }
    params[key] = rng.range(min, max)
  }
  return params
}

/** The five knobs the brief exposes, in declaration order. */
const SCHEMA_KEYS = [
  'fieldScale',
  'octaves',
  'turbulence',
  'tickDensity',
  'tickLength',
]

describe('flow-field Sketch contract', () => {
  it('ships static (no time metadata) and declares the five-knob schema', () => {
    // Absence of `time` ⇒ static Sketch (scrubber hidden). This is the load-
    // bearing "stage 1 ships STATIC" assertion.
    expect(flowField.time).toBeUndefined()
    expect(Object.keys(flowField.schema)).toEqual(SCHEMA_KEYS)
  })

  it('marks octaves and tickDensity integer, and every knob has a range/default', () => {
    for (const key of SCHEMA_KEYS) {
      const spec = flowField.schema[key]!
      expect(spec.kind).toBe('number')
      expect(spec.min).toBeLessThan(spec.max)
      expect(spec.default).toBeGreaterThanOrEqual(spec.min)
      expect(spec.default).toBeLessThanOrEqual(spec.max)
    }
    expect(flowField.schema.octaves!.integer).toBe(true)
    expect(flowField.schema.tickDensity!.integer).toBe(true)
  })

  it('emits one oriented tick per grid point as a 2-point open stroked Polyline', () => {
    const density = 8
    const scene = flowField.generate({ tickDensity: density }, 'seed-a', 0, DEFAULT_COMPOSITION_FRAME)
    // density × density grid ⇒ one tick each.
    expect(scene.primitives).toHaveLength(density * density)
    for (const primitive of scene.primitives) {
      expect(primitive.closed).toBe(false)
      // A tick is a 2-point open segment centered on its grid point.
      expect(primitive.points).toHaveLength(2)
      expect(primitive.stroke).toEqual({ color: 'black', width: 1 })
      // Non-degenerate: the two endpoints differ (the tick has length).
      expect(primitive.points[0]).not.toEqual(primitive.points[1])
    }
  })

  it('bakes only generic Scene Primitives — no domain fields leak', () => {
    const scene = flowField.generate({ tickDensity: 6 }, 'seed-a', 0, DEFAULT_COMPOSITION_FRAME)
    for (const primitive of scene.primitives) {
      // Every key must belong to the generic Primitive shape.
      const allowed = new Set(['points', 'closed', 'fill', 'stroke'])
      for (const key of Object.keys(primitive as Primitive)) {
        expect(allowed.has(key)).toBe(true)
      }
    }
  })
})

describe('flow-field determinism (ADR-0002)', () => {
  it('is deterministic at the Scene level for identical (params, seed, t)', () => {
    const params: Params = {
      fieldScale: 3,
      octaves: 4,
      turbulence: 0.5,
      tickDensity: 10,
      tickLength: 20,
    }
    const a = flowField.generate(params, 'fixed-seed', 1.25, DEFAULT_COMPOSITION_FRAME)
    const b = flowField.generate(params, 'fixed-seed', 1.25, DEFAULT_COMPOSITION_FRAME)
    // Same primitive count, order, and geometry — asserted at the Scene level.
    expect(a).toEqual(b)
  })

  it('carries no cross-call state — interleaved calls do not perturb a repeat', () => {
    const params: Params = { tickDensity: 7 }
    const first = flowField.generate(params, 's', 0.5, DEFAULT_COMPOSITION_FRAME)
    // Interleave unrelated calls to surface any accumulated state.
    flowField.generate(params, 's', 9.9, DEFAULT_COMPOSITION_FRAME)
    flowField.generate({ tickDensity: 3 }, 'other', 2, DEFAULT_COMPOSITION_FRAME)
    const again = flowField.generate(params, 's', 0.5, DEFAULT_COMPOSITION_FRAME)
    expect(again).toEqual(first)
  })

  it('threads t through the field: a different t yields a different Scene', () => {
    const params: Params = { tickDensity: 12 }
    const atZero = flowField.generate(params, 's', 0, DEFAULT_COMPOSITION_FRAME)
    const atLater = flowField.generate(params, 's', 5, DEFAULT_COMPOSITION_FRAME)
    expect(atLater).not.toEqual(atZero)
  })
})

describe('flow-field seed independence (field vs param values)', () => {
  it('re-seeding changes tick orientations while the params hold', () => {
    // The engine-rolled param values come from their own roll seed and do not
    // depend on the generate seed at all.
    const params = rollParams('param-roll-seed')
    expect(rollParams('param-roll-seed')).toEqual(params)

    // Feeding the SAME params through generate under two different seeds
    // reshuffles the underlying field, so the tick orientations differ...
    const sceneA = flowField.generate(params, 'gen-seed-a', 0, DEFAULT_COMPOSITION_FRAME)
    const sceneB = flowField.generate(params, 'gen-seed-b', 0, DEFAULT_COMPOSITION_FRAME)
    expect(sceneB).not.toEqual(sceneA)
    // ...but the grid is the same size (same params ⇒ same tick count).
    expect(sceneB.primitives).toHaveLength(sceneA.primitives.length)

    // ...while the rolled param values the test holds are still untouched.
    expect(params).toEqual(rollParams('param-roll-seed'))
  })
})

describe('flow-field engine-rolled param bounds', () => {
  it('keeps every rolled param value within its schema control [min, max]', () => {
    for (let i = 0; i < 200; i++) {
      const params = rollParams(`bounds-${i}`)
      for (const [key, spec] of Object.entries(flowField.schema)) {
        const { min, max } = spec as { min: number; max: number }
        const value = params[key] as number
        expect(value).toBeGreaterThanOrEqual(min)
        expect(value).toBeLessThan(max)
      }
    }
  })
})
