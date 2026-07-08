import { describe, expect, it } from 'vitest'

import { defaultParams, newSeed, randomize } from '../sketch'
import type { Params, ParamSchema } from '../sketch'

/**
 * A scripted `rand` stub: yields the given values in order, so a test can pin
 * exactly which `[0, 1)` samples `randomize` / `newSeed` consume.
 */
function scriptedRand(values: readonly number[]): () => number {
  let i = 0
  return () => {
    if (i >= values.length) throw new Error('scriptedRand exhausted')
    return values[i++]!
  }
}

describe('defaultParams', () => {
  it('returns an empty params object for an empty schema', () => {
    expect(defaultParams({})).toEqual({})
  })

  it('returns the single key set to its spec default', () => {
    const schema: ParamSchema = {
      count: { kind: 'number', min: 1, max: 80, default: 24 },
    }
    expect(defaultParams(schema)).toEqual({ count: 24 })
  })

  it('returns every key of a multi-key schema set to its spec default', () => {
    const schema: ParamSchema = {
      count: { kind: 'number', min: 1, max: 80, default: 24 },
      minRadius: { kind: 'number', min: 2, max: 100, default: 12 },
      maxRadius: { kind: 'number', min: 2, max: 200, default: 60 },
    }
    expect(defaultParams(schema)).toEqual({
      count: 24,
      minRadius: 12,
      maxRadius: 60,
    })
  })

  it('returns the raw default for an integer-marked param (no rounding/coercion)', () => {
    const schema: ParamSchema = {
      sides: { kind: 'number', min: 3, max: 12, default: 6, integer: true },
    }
    expect(defaultParams(schema)).toEqual({ sides: 6 })
  })

  it('seeds a color param with its hex default — defaultParams is kind-generic', () => {
    const schema: ParamSchema = {
      count: { kind: 'number', min: 1, max: 80, default: 24 },
      ink: { kind: 'color', default: '#1a2b3c' },
    }
    expect(defaultParams(schema)).toEqual({ count: 24, ink: '#1a2b3c' })
  })
})

describe('randomize', () => {
  it('rolls each unlocked numeric param within its own [min, max] via min + rand()*(max-min)', () => {
    const schema: ParamSchema = {
      count: { kind: 'number', min: 1, max: 80, default: 24 },
      radius: { kind: 'number', min: 2, max: 100, default: 12 },
    }
    const params: Params = { count: 24, radius: 12 }
    // 0.5 -> midpoint of each range.
    const next = randomize(schema, params, new Set(), scriptedRand([0.5, 0.5]))
    expect(next).toEqual({ count: 40.5, radius: 51 })
  })

  it('rounds an integer-marked param to a whole number, ignoring step', () => {
    const schema: ParamSchema = {
      sides: { kind: 'number', min: 3, max: 12, default: 6, integer: true, step: 5 },
    }
    // 0.4 -> 3 + 0.4*9 = 6.6 -> rounds to 7 (step:5 is irrelevant).
    const next = randomize(schema, { sides: 6 }, new Set(), scriptedRand([0.4]))
    expect(next).toEqual({ sides: 7 })
    expect(Number.isInteger(next.sides)).toBe(true)
  })

  it('leaves a locked param unchanged while unlocked siblings move', () => {
    const schema: ParamSchema = {
      count: { kind: 'number', min: 1, max: 80, default: 24 },
      radius: { kind: 'number', min: 2, max: 100, default: 12 },
    }
    const params: Params = { count: 24, radius: 12 }
    // Only `radius` is rolled (one sample); `count` is locked.
    const next = randomize(schema, params, new Set(['count']), scriptedRand([0]))
    expect(next.count).toBe(24)
    expect(next.radius).toBe(2)
  })

  it('does not mutate the input params object (purity)', () => {
    const schema: ParamSchema = {
      count: { kind: 'number', min: 1, max: 80, default: 24 },
    }
    const params: Params = { count: 24 }
    const next = randomize(schema, params, new Set(), scriptedRand([1]))
    expect(params).toEqual({ count: 24 })
    expect(next).not.toBe(params)
  })

  it('passes a color param through UNTOUCHED — Randomize is numeric-only (ADR-0010)', () => {
    // The pass-through is a stated contract, not an implementation accident: a
    // color is a deliberate aesthetic choice, never rolled. Only the numeric
    // sibling consumes a rand() sample — the scripted stub has exactly one value,
    // so a color roll would throw `scriptedRand exhausted`.
    const schema: ParamSchema = {
      ink: { kind: 'color', default: '#1a2b3c' },
      count: { kind: 'number', min: 0, max: 10, default: 5 },
    }
    const params: Params = { ink: '#c0ffee', count: 5 }
    const next = randomize(schema, params, new Set(), scriptedRand([0.5]))
    expect(next.ink).toBe('#c0ffee')
    expect(next.count).toBe(5) // rolled: 0 + 0.5*10
  })

  it('passes a LOCKED color param through untouched too (lock adds nothing to skip)', () => {
    // Locked or not, a color never rolls — the lock is redundant for colors but
    // harmless, and the value survives either way.
    const schema: ParamSchema = {
      ink: { kind: 'color', default: '#1a2b3c' },
    }
    const next = randomize(schema, { ink: '#c0ffee' }, new Set(['ink']), scriptedRand([]))
    expect(next.ink).toBe('#c0ffee')
  })

  it('passes non-rolled keys present in params but absent from schema through unchanged', () => {
    const schema: ParamSchema = {
      count: { kind: 'number', min: 1, max: 80, default: 24 },
    }
    const params: Params = { count: 24, label: 'keep-me' }
    const next = randomize(schema, params, new Set(), scriptedRand([0]))
    expect(next.label).toBe('keep-me')
  })
})

describe('newSeed', () => {
  it('returns a numeric seed derived from the injected rand', () => {
    const seed = newSeed(scriptedRand([0.5]))
    expect(typeof seed).toBe('number')
  })

  it('re-seeding is independent of params — it leaves a given params object identical', () => {
    const params: Params = { count: 24, radius: 12 }
    newSeed(scriptedRand([0.123]))
    expect(params).toEqual({ count: 24, radius: 12 })
  })
})
