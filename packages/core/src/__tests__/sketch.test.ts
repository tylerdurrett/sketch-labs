import { describe, expect, it, vi } from 'vitest'

import {
  defaultParams,
  definePreparedSketch,
  newSeed,
  prepareSketch,
  randomize,
} from '../sketch'
import type { Params, ParamSchema, StatelessSketch } from '../sketch'
import type { Scene } from '../scene'
import { DEFAULT_COMPOSITION_FRAME } from '../compositionFrame'
import {
  createShadingMask,
  createToneField,
  sampleEffectiveTone,
} from '../shadingFields'
import type { ScribbleProgress } from '../scribbleStrategy'

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

describe('caller-owned prepared frames', () => {
  const sceneAt = (value: number): Scene => ({
    space: { width: 10, height: 10 },
    primitives: [{ points: [[value, value]] }],
  })

  it('derives public generate from the same prepare implementation', () => {
    const calls: Array<[Params, string | number]> = []
    const sketch = definePreparedSketch({
      id: 'prepared',
      name: 'Prepared',
      schema: {},
      prepare(params, seed) {
        calls.push([params, seed])
        const offset = params.offset as number
        return (t) => sceneAt(offset + Number(seed) + t)
      },
    })

    const params = { offset: 2 }
    expect(sketch.generate(params, 3, 4, DEFAULT_COMPOSITION_FRAME)).toEqual(sceneAt(9))
    expect(sketch.prepare(params, 3, DEFAULT_COMPOSITION_FRAME)(4)).toEqual(sceneAt(9))
    expect(calls).toEqual([
      [params, 3],
      [params, 3],
    ])
  })

  it('uses specialized preparation when present and adapts legacy generate otherwise', () => {
    let prepared = 0
    let generated = 0
    const specialized = definePreparedSketch({
      id: 'specialized',
      name: 'Specialized',
      schema: {},
      prepare() {
        prepared++
        return sceneAt
      },
    })
    const legacy: StatelessSketch = {
      id: 'legacy',
      name: 'Legacy',
      schema: {},
      generate(_params, _seed, t) {
        generated++
        return sceneAt(t)
      },
    }

    const warm = prepareSketch(specialized, {}, 1, DEFAULT_COMPOSITION_FRAME)
    expect(prepared).toBe(1)
    expect(warm(1)).toEqual(sceneAt(1))
    expect(warm(2)).toEqual(sceneAt(2))
    expect(prepared).toBe(1)

    const adapted = prepareSketch(legacy, {}, 1, DEFAULT_COMPOSITION_FRAME)
    expect(adapted(1)).toEqual(sceneAt(1))
    expect(adapted(2)).toEqual(sceneAt(2))
    expect(generated).toBe(2)
  })

  it('preserves an optional Scribble artwork capability on a prepared Sketch', () => {
    const progress: ScribbleProgress[] = []
    const artworkScene = sceneAt(7)
    const sketch = definePreparedSketch({
      id: 'prepared-scribble',
      name: 'Prepared Scribble',
      schema: {},
      prepare() {
        return sceneAt
      },
      generateScribbleArtwork(_params, _seed, _frame, observer) {
        observer?.({
          completedWorkUnits: 2,
          totalWorkUnits: 2,
          terminal: true,
        })
        return {
          scene: artworkScene,
          diagnostics: {
            termination: 'completed',
            residualError: 0,
            pathLength: 1,
            polylineCount: 1,
            penLiftCount: 0,
          },
        }
      },
    })

    expect(
      sketch.generateScribbleArtwork?.(
        {},
        'seed',
        DEFAULT_COMPOSITION_FRAME,
        (snapshot) => progress.push(snapshot),
      ),
    ).toEqual({
      scene: artworkScene,
      diagnostics: {
        termination: 'completed',
        residualError: 0,
        pathLength: 1,
        polylineCount: 1,
        penLiftCount: 0,
      },
    })
    expect(progress).toEqual([
      { completedWorkUnits: 2, totalWorkUnits: 2, terminal: true },
    ])
  })

  it('preserves completed-Scene Outline derivation on a prepared Sketch', () => {
    const completed = sceneAt(7)
    const derived = sceneAt(9)
    const deriveOutlineSource = vi.fn(() => derived)
    const sketch = definePreparedSketch({
      id: 'prepared-outline',
      name: 'Prepared Outline',
      schema: {},
      prepare() {
        return sceneAt
      },
      deriveOutlineSource,
    })
    const target = {
      toolWidthMillimeters: 0.3,
      millimetersPerSceneUnit: 0.18,
    }

    expect(sketch.deriveOutlineSource?.(completed, target)).toBe(derived)
    expect(deriveOutlineSource).toHaveBeenCalledOnce()
    expect(deriveOutlineSource).toHaveBeenCalledWith(completed, target)
  })
})

describe('optional tone-source capability', () => {
  const emptyScene = (): Scene => ({
    space: DEFAULT_COMPOSITION_FRAME,
    primitives: [],
  })

  it('leaves an ordinary Sketch valid without the capability', () => {
    const ordinary: StatelessSketch = {
      id: 'ordinary',
      name: 'Ordinary',
      schema: {},
      generate: emptyScene,
    }

    expect(ordinary.generateToneSource).toBeUndefined()
  })

  it('lets a tone-aware Sketch derive a source from only params and frame', () => {
    const toneAware: StatelessSketch = {
      id: 'tone-aware',
      name: 'Tone aware',
      schema: {
        tone: { kind: 'number', min: 0, max: 1, default: 0.5 },
      },
      generate: emptyScene,
      generateToneSource(params, frame) {
        const tone = params.tone as number
        return {
          toneField: createToneField(([x]) => tone * (x / frame.width)),
          shadingMask: createShadingMask(() => 1),
        }
      },
    }

    const source = toneAware.generateToneSource?.(
      { tone: 0.8 },
      DEFAULT_COMPOSITION_FRAME,
    )

    expect(source).toBeDefined()
    expect(source && sampleEffectiveTone(source, [500, 500])).toBe(0.4)
  })
})
