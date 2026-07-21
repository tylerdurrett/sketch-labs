import { describe, expect, expectTypeOf, it, vi } from 'vitest'

import {
  activeParams,
  defaultParams,
  definePreparedSketch,
  isParamActive,
  newSeed,
  prepareSketch,
  randomize,
  validateChoiceParamSpec,
  validateChoiceParamValue,
  validateParamSchema,
} from '../sketch'
import type { Params, ParamSchema, StatelessSketch } from '../sketch'
import type { Scene } from '../scene'
import type { DecodedPixels, SketchEnvironment } from '../imageAssets'
import { DEFAULT_COMPOSITION_FRAME } from '../compositionFrame'
import {
  createShadingMask,
  createToneField,
  sampleEffectiveTone,
} from '../shadingFields'
import type { ShadingProgress } from '../shadingStrategy'

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

  it('seeds an Image Asset param with its stable string ID default', () => {
    const schema: ParamSchema = {
      image: { kind: 'image-asset', default: 'portrait-a1b2c3d4' },
    }
    expect(defaultParams(schema)).toEqual({ image: 'portrait-a1b2c3d4' })
  })

  it('seeds a Choice param with its declared stable-value default', () => {
    const schema: ParamSchema = {
      strategy: {
        kind: 'choice',
        options: [
          { value: 'scribble', label: 'Scribble' },
          { value: 'stippling', label: 'Stippling' },
        ],
        default: 'scribble',
      },
    }
    expect(defaultParams(schema)).toEqual({ strategy: 'scribble' })
  })
})

describe('validateChoiceParamSpec', () => {
  const valid = {
    kind: 'choice',
    options: [
      { value: 'scribble', label: 'Scribble' },
      { value: 'stippling', label: 'Stippling' },
    ],
    default: 'scribble',
  } as const

  it('accepts a nonempty option set with unique stable values and a declared default', () => {
    expect(() => validateChoiceParamSpec(valid, 'strategy')).not.toThrow()
  })

  it.each([
    [
      'an empty option set',
      { ...valid, options: [] },
      /must declare at least one option/,
    ],
    [
      'an empty value',
      { ...valid, options: [{ value: ' ', label: 'Scribble' }] },
      /nonempty string value/,
    ],
    [
      'an empty label',
      { ...valid, options: [{ value: 'scribble', label: '' }] },
      /nonempty string label/,
    ],
    [
      'a repeated stable value',
      {
        ...valid,
        options: [
          { value: 'scribble', label: 'Scribble' },
          { value: 'scribble', label: 'Another label' },
        ],
      },
      /duplicate option value/,
    ],
    [
      'a default outside the option set',
      { ...valid, default: 'hatching' },
      /default must be one of its declared option values/,
    ],
  ])('rejects %s', (_name, spec, message) => {
    expect(() => validateChoiceParamSpec(spec, 'strategy')).toThrow(message)
  })

  it('makes defaultParams a loud Choice declaration boundary', () => {
    const schema = {
      strategy: { ...valid, default: 'hatching' },
    } as unknown as ParamSchema
    expect(() => defaultParams(schema)).toThrow(/Choice param `strategy` default/)
  })
})

describe('validateChoiceParamValue', () => {
  const spec = {
    kind: 'choice',
    options: [
      { value: 'scribble', label: 'Scribble' },
      { value: 'stippling', label: 'Stippling' },
    ],
    default: 'scribble',
  } as const

  it('returns a declared string value', () => {
    const value = validateChoiceParamValue(spec, 'stippling', 'strategy')
    expect(value).toBe('stippling')
    expectTypeOf(value).toEqualTypeOf<'scribble' | 'stippling'>()
  })

  it('rejects a non-string present value directly', () => {
    expect(() => validateChoiceParamValue(spec, 42, 'strategy')).toThrow(
      /value must be one of its declared option values/,
    )
  })

  it('rejects an undeclared string value directly', () => {
    expect(() =>
      validateChoiceParamValue(spec, 'hatching', 'strategy'),
    ).toThrow(/value must be one of its declared option values/)
  })
})

describe('conditional parameter applicability', () => {
  const strategy = {
    kind: 'choice',
    options: [
      { value: 'scribble', label: 'Scribble' },
      { value: 'stippling', label: 'Stippling' },
    ],
    default: 'scribble',
  } as const

  it.each([
    ['number', { kind: 'number', min: 0, max: 1, default: 0.5 }],
    ['color', { kind: 'color', default: '#1a2b3c' }],
    ['image asset', { kind: 'image-asset', default: 'portrait-a1b2c3d4' }],
    [
      'Choice',
      {
        kind: 'choice',
        options: [{ value: 'fine', label: 'Fine' }],
        default: 'fine',
      },
    ],
  ] as const)(
    'supports activeWhen on a %s parameter',
    (_name, dependentSpec) => {
      const schema = {
        strategy,
        dependent: {
          ...dependentSpec,
          activeWhen: { key: 'strategy', equals: 'stippling' },
        },
      } satisfies ParamSchema

      expect(() => validateParamSchema(schema)).not.toThrow()
      expect(isParamActive(schema, { strategy: 'stippling' }, 'dependent')).toBe(
        true,
      )
      expect(isParamActive(schema, { strategy: 'scribble' }, 'dependent')).toBe(
        false,
      )
    },
  )

  it('treats an unconditional parameter as active', () => {
    const schema = { strategy } satisfies ParamSchema
    expect(isParamActive(schema, {}, 'strategy')).toBe(true)
  })

  it('uses the validated Choice default when the controller value is missing', () => {
    const schema = {
      strategy,
      scribbleDensity: {
        kind: 'number',
        min: 1,
        max: 10,
        default: 5,
        activeWhen: { key: 'strategy', equals: 'scribble' },
      },
      stippleDensity: {
        kind: 'number',
        min: 1,
        max: 10,
        default: 5,
        activeWhen: { key: 'strategy', equals: 'stippling' },
      },
    } satisfies ParamSchema

    expect(isParamActive(schema, {}, 'scribbleDensity')).toBe(true)
    expect(isParamActive(schema, {}, 'stippleDensity')).toBe(false)
  })

  it('rejects a present controller value outside its declared options', () => {
    const schema = {
      strategy,
      density: {
        kind: 'number',
        min: 1,
        max: 10,
        default: 5,
        activeWhen: { key: 'strategy', equals: 'stippling' },
      },
    } satisfies ParamSchema

    expect(() =>
      isParamActive(schema, { strategy: 'hatching' }, 'density'),
    ).toThrow(/Choice param `strategy` value must be one of/)
  })

  it.each([
    [
      'a missing controller',
      {
        activeWhen: { key: 'missing', equals: 'stippling' },
      },
      /missing controller `missing`/,
    ],
    [
      'a non-Choice controller',
      {
        activeWhen: { key: 'amount', equals: 'stippling' },
      },
      /controller `amount` must be a Choice param/,
    ],
    [
      'a self-reference',
      {
        activeWhen: { key: 'dependent', equals: 'stippling' },
      },
      /cannot reference itself/,
    ],
    [
      'an undeclared comparison value',
      {
        activeWhen: { key: 'strategy', equals: 'hatching' },
      },
      /equals must be a declared option/,
    ],
  ])('rejects %s', (_name, overrides, message) => {
    const schema = {
      strategy,
      amount: { kind: 'number', min: 0, max: 1, default: 0.5 },
      dependent: {
        kind: 'number',
        min: 0,
        max: 1,
        default: 0.5,
        ...overrides,
      },
    } as ParamSchema

    expect(() => validateParamSchema(schema)).toThrow(message)
    expect(() => defaultParams(schema)).toThrow(message)
  })

  it('rejects a requested key inherited through the schema prototype', () => {
    const schema = Object.create({ inherited: strategy }) as ParamSchema

    expect(() => isParamActive(schema, {}, 'inherited')).toThrow(
      /Unknown param `inherited`/,
    )
  })

  it('rejects an activeWhen controller supplied by the schema prototype', () => {
    const schema = Object.assign(Object.create({ strategy }), {
      density: {
        kind: 'number' as const,
        min: 0,
        max: 1,
        default: 0.5,
        activeWhen: { key: 'strategy', equals: 'stippling' },
      },
    }) as ParamSchema

    expect(() => validateParamSchema(schema)).toThrow(
      /missing controller `strategy`/,
    )
    expect(() =>
      isParamActive(schema, { strategy: 'stippling' }, 'density'),
    ).toThrow(/missing controller `strategy`/)
  })

  it('is pure and does not recursively evaluate the Choice controller', () => {
    const schema = Object.freeze({
      mode: Object.freeze({
        kind: 'choice' as const,
        options: Object.freeze([
          Object.freeze({ value: 'advanced', label: 'Advanced' }),
        ]),
        default: 'advanced',
      }),
      strategy: Object.freeze({
        kind: 'choice' as const,
        options: Object.freeze([
          Object.freeze({ value: 'stippling', label: 'Stippling' }),
        ]),
        default: 'stippling',
        activeWhen: Object.freeze({ key: 'mode', equals: 'never-declared' }),
      }),
      density: Object.freeze({
        kind: 'number' as const,
        min: 0,
        max: 1,
        default: 0.5,
        activeWhen: Object.freeze({ key: 'strategy', equals: 'stippling' }),
      }),
    }) as ParamSchema
    const params = Object.freeze({ strategy: 'stippling' })

    expect(isParamActive(schema, params, 'density')).toBe(true)
    expect(params).toEqual({ strategy: 'stippling' })
  })
})

describe('activeParams', () => {
  const schema = {
    strategy: {
      kind: 'choice',
      options: [
        { value: 'scribble', label: 'Scribble' },
        { value: 'stippling', label: 'Stippling' },
      ],
      default: 'scribble',
    },
    always: { kind: 'color', default: '#1a2b3c' },
    scribbleDensity: {
      kind: 'number',
      min: 1,
      max: 10,
      default: 4,
      activeWhen: { key: 'strategy', equals: 'scribble' },
    },
    stippleSource: {
      kind: 'image-asset',
      default: 'portrait-default',
      activeWhen: { key: 'strategy', equals: 'stippling' },
    },
  } as const satisfies ParamSchema

  it('projects a mixed schema to active keys with exact present values', () => {
    expect(
      activeParams(schema, {
        strategy: 'scribble',
        always: '#abcdef',
        scribbleDensity: 99,
        stippleSource: 'portrait-selected',
      }),
    ).toEqual({
      strategy: 'scribble',
      always: '#abcdef',
      scribbleDensity: 99,
    })
  })

  it('switches the projected dependent while retaining inactive input values', () => {
    const params = {
      strategy: 'stippling',
      always: '#abcdef',
      scribbleDensity: 7,
      stippleSource: 'portrait-selected',
    }

    expect(activeParams(schema, params)).toEqual({
      strategy: 'stippling',
      always: '#abcdef',
      stippleSource: 'portrait-selected',
    })
    expect(params).toEqual({
      strategy: 'stippling',
      always: '#abcdef',
      scribbleDensity: 7,
      stippleSource: 'portrait-selected',
    })
  })

  it('uses validated defaults for absent active values', () => {
    expect(activeParams(schema, {})).toEqual({
      strategy: 'scribble',
      always: '#1a2b3c',
      scribbleDensity: 4,
    })
  })

  it('keeps active implicit identity defaults in the complete projection', () => {
    const widened = {
      ...schema,
      relaxation: {
        kind: 'number',
        min: 0,
        max: 10,
        default: 0,
        identityDefault: 'implicit',
        activeWhen: { key: 'strategy', equals: 'stippling' },
      },
    } as const satisfies ParamSchema

    expect(activeParams(widened, { strategy: 'stippling' })).toEqual({
      strategy: 'stippling',
      always: '#1a2b3c',
      stippleSource: 'portrait-default',
      relaxation: 0,
    })
  })

  it('preserves schema order and excludes extras and inherited schema keys', () => {
    const withInherited = Object.assign(
      Object.create({ inherited: { kind: 'color', default: '#000000' } }),
      schema,
    ) as ParamSchema
    const projected = activeParams(withInherited, {
      extra: 'discarded',
      strategy: 'scribble',
      scribbleDensity: 6,
    })

    expect(Object.keys(projected)).toEqual([
      'strategy',
      'always',
      'scribbleDensity',
    ])
    expect(projected).not.toHaveProperty('extra')
    expect(projected).not.toHaveProperty('inherited')
  })

  it('is pure over frozen schema and Params inputs', () => {
    const frozenSchema = Object.freeze(schema)
    const params = Object.freeze({ strategy: 'scribble', scribbleDensity: 8 })

    const projected = activeParams(frozenSchema, params)

    expect(projected).toEqual({
      strategy: 'scribble',
      always: '#1a2b3c',
      scribbleDensity: 8,
    })
    expect(projected).not.toBe(params)
  })

  it('rejects a malformed applicability relationship before projecting', () => {
    const malformed = {
      strategy: schema.strategy,
      density: {
        kind: 'number',
        min: 1,
        max: 10,
        default: 4,
        activeWhen: { key: 'strategy', equals: 'hatching' },
      },
    } as const satisfies ParamSchema

    expect(() => activeParams(malformed, {})).toThrow(
      /equals must be a declared option/,
    )
  })

  it('rejects an invalid present Choice value before projecting', () => {
    expect(() => activeParams(schema, { strategy: 'hatching' })).toThrow(
      /Choice param `strategy` value must be one of/,
    )
  })

  it.each([42, 'coarse'])(
    'rejects an invalid present inactive Choice value (%s)',
    (inactiveValue) => {
      const withInactiveChoice = {
        ...schema,
        stippleQuality: {
          kind: 'choice',
          options: [{ value: 'fine', label: 'Fine' }],
          default: 'fine',
          activeWhen: { key: 'strategy', equals: 'stippling' },
        },
      } as const satisfies ParamSchema

      expect(() =>
        activeParams(withInactiveChoice, {
          strategy: 'scribble',
          stippleQuality: inactiveValue,
        }),
      ).toThrow(/Choice param `stippleQuality` value must be one of/)
    },
  )
})

describe('randomize', () => {
  const conditionalSchema = {
    strategy: {
      kind: 'choice',
      options: [
        { value: 'scribble', label: 'Scribble' },
        { value: 'stippling', label: 'Stippling' },
      ],
      default: 'scribble',
    },
    scribbleDensity: {
      kind: 'number',
      min: 0,
      max: 10,
      default: 4,
      activeWhen: { key: 'strategy', equals: 'scribble' },
    },
    stippleSpacing: {
      kind: 'number',
      min: 20,
      max: 100,
      default: 60,
      activeWhen: { key: 'strategy', equals: 'stippling' },
    },
    lockedActive: {
      kind: 'number',
      min: 0,
      max: 100,
      default: 50,
    },
    always: { kind: 'number', min: 0, max: 100, default: 50 },
    ink: { kind: 'color', default: '#1a2b3c' },
    image: { kind: 'image-asset', default: 'portrait-default' },
  } as const satisfies ParamSchema

  const conditionalParams = {
    strategy: 'scribble',
    scribbleDensity: 4,
    stippleSpacing: 60,
    lockedActive: 50,
    always: 50,
    ink: '#c0ffee',
    image: 'portrait-selected',
    extra: 'keep-me',
  }

  it('consumes RNG only for active unlocked Number params in schema order', () => {
    const rand = vi.fn(scriptedRand([0.25, 0.75]))
    const next = randomize(
      conditionalSchema,
      conditionalParams,
      new Set(['strategy', 'lockedActive']),
      rand,
    )

    expect(rand).toHaveBeenCalledTimes(2)
    expect(next).toEqual({
      strategy: 'scribble',
      scribbleDensity: 2.5,
      stippleSpacing: 60,
      lockedActive: 50,
      always: 75,
      ink: '#c0ffee',
      image: 'portrait-selected',
      extra: 'keep-me',
    })
  })

  it('switches which conditional Number consumes the scripted sample', () => {
    const next = randomize(
      conditionalSchema,
      { ...conditionalParams, strategy: 'stippling' },
      new Set(['lockedActive', 'always']),
      scriptedRand([0.25]),
    )

    expect(next.scribbleDensity).toBe(4)
    expect(next.stippleSpacing).toBe(40)
    expect(next.always).toBe(50)
  })

  it('uses the Choice default to determine activity when its value is absent', () => {
    const params = { ...conditionalParams }
    delete (params as Partial<typeof params>).strategy

    const next = randomize(
      conditionalSchema,
      params,
      new Set(['lockedActive', 'always']),
      scriptedRand([0.5]),
    )

    expect(next.scribbleDensity).toBe(5)
    expect(next.stippleSpacing).toBe(60)
  })

  it('rejects an invalid present controlling Choice before consuming RNG', () => {
    const rand = vi.fn(scriptedRand([]))

    expect(() =>
      randomize(
        conditionalSchema,
        { ...conditionalParams, strategy: 'hatching' },
        new Set(['lockedActive', 'always']),
        rand,
      ),
    ).toThrow(/Choice param `strategy` value must be one of/)
    expect(rand).not.toHaveBeenCalled()
  })

  it.each([42, 'hatching'])(
    'rejects an invalid standalone Choice value (%s) without consuming RNG',
    (value) => {
      const schema = {
        strategy: conditionalSchema.strategy,
      } satisfies ParamSchema
      const rand = vi.fn(scriptedRand([]))

      expect(() =>
        randomize(schema, { strategy: value }, new Set(), rand),
      ).toThrow(/Choice param `strategy` value must be one of/)
      expect(rand).not.toHaveBeenCalled()
    },
  )

  it('validates a Choice controller even when all its dependents are locked', () => {
    const schema = {
      strategy: conditionalSchema.strategy,
      density: conditionalSchema.scribbleDensity,
    } satisfies ParamSchema
    const rand = vi.fn(scriptedRand([]))

    expect(() =>
      randomize(
        schema,
        { strategy: 'hatching', density: 4 },
        new Set(['density']),
        rand,
      ),
    ).toThrow(/Choice param `strategy` value must be one of/)
    expect(rand).not.toHaveBeenCalled()
  })

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

  it('rolls logarithmic sliders uniformly across their declared decades', () => {
    const schema: ParamSchema = {
      density: {
        kind: 'number',
        min: 0.25,
        max: 400,
        default: 1,
        sliderScale: 'logarithmic',
      },
    }

    const next = randomize(
      schema,
      { density: 1 },
      new Set(),
      scriptedRand([0.25]),
    )
    expect(next.density).toBeCloseTo(
      0.25 * (400 / 0.25) ** 0.25,
      12,
    )
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

  it('passes an unlocked Image Asset ID through without consuming randomness', () => {
    const schema: ParamSchema = {
      image: { kind: 'image-asset', default: 'portrait-default' },
    }
    const next = randomize(
      schema,
      { image: 'portrait-selected' },
      new Set(),
      scriptedRand([]),
    )
    expect(next.image).toBe('portrait-selected')
  })

  it('passes a locked Image Asset ID through untouched too', () => {
    const schema: ParamSchema = {
      image: { kind: 'image-asset', default: 'portrait-default' },
    }
    const next = randomize(
      schema,
      { image: 'portrait-selected' },
      new Set(['image']),
      scriptedRand([]),
    )
    expect(next.image).toBe('portrait-selected')
  })

  it('passes a locked Choice value through untouched without consuming randomness', () => {
    const schema: ParamSchema = {
      strategy: {
        kind: 'choice',
        options: [
          { value: 'scribble', label: 'Scribble' },
          { value: 'stippling', label: 'Stippling' },
        ],
        default: 'scribble',
      },
    }
    const next = randomize(
      schema,
      { strategy: 'stippling' },
      new Set(['strategy']),
      scriptedRand([]),
    )
    expect(next.strategy).toBe('stippling')
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

  it('preserves exact legacy invocation arity when no environment is supplied', () => {
    const params = { offset: 2 }
    const prepare = vi.fn(() => sceneAt)
    const specialized = definePreparedSketch({
      id: 'legacy-arity-prepared',
      name: 'Legacy arity prepared',
      schema: {},
      prepare,
    })
    const generate = vi.fn(
      (_params: Params, _seed: string | number, t: number) => sceneAt(t),
    )
    const legacy: StatelessSketch = {
      id: 'legacy-arity-generate',
      name: 'Legacy arity generate',
      schema: {},
      generate,
    }

    specialized.generate(params, 1, 2, DEFAULT_COMPOSITION_FRAME)
    expect(prepare).toHaveBeenLastCalledWith(
      params,
      1,
      DEFAULT_COMPOSITION_FRAME,
    )

    prepare.mockClear()
    prepareSketch(specialized, params, 1, DEFAULT_COMPOSITION_FRAME)(2)
    expect(prepare).toHaveBeenCalledOnce()
    expect(prepare).toHaveBeenCalledWith(
      params,
      1,
      DEFAULT_COMPOSITION_FRAME,
    )

    prepareSketch(legacy, params, 1, DEFAULT_COMPOSITION_FRAME)(2)
    expect(generate).toHaveBeenCalledOnce()
    expect(generate).toHaveBeenCalledWith(
      params,
      1,
      2,
      DEFAULT_COMPOSITION_FRAME,
    )
  })

  it('forwards the optional environment through prepared and legacy paths', () => {
    const pixels: DecodedPixels = {
      width: 1,
      height: 1,
      data: Uint8Array.from([0, 0, 0, 255]),
    }
    const environment: SketchEnvironment = {
      imageAssets: (id) => (id === 'fixture' ? pixels : undefined),
    }
    const preparedEnvironments: Array<SketchEnvironment | undefined> = []
    const generatedEnvironments: Array<SketchEnvironment | undefined> = []
    const specialized = definePreparedSketch({
      id: 'environment-prepared',
      name: 'Environment prepared',
      schema: {},
      prepare(_params, _seed, _frame, received) {
        preparedEnvironments.push(received)
        return sceneAt
      },
    })
    const legacy: StatelessSketch = {
      id: 'environment-legacy',
      name: 'Environment legacy',
      schema: {},
      generate(_params, _seed, t, _frame, received) {
        generatedEnvironments.push(received)
        return sceneAt(t)
      },
    }

    specialized.generate({}, 1, 2, DEFAULT_COMPOSITION_FRAME, environment)
    specialized.prepare({}, 1, DEFAULT_COMPOSITION_FRAME, environment)(2)
    prepareSketch(
      specialized,
      {},
      1,
      DEFAULT_COMPOSITION_FRAME,
      environment,
    )(2)
    prepareSketch(legacy, {}, 1, DEFAULT_COMPOSITION_FRAME, environment)(2)

    expect(preparedEnvironments).toEqual([
      environment,
      environment,
      environment,
    ])
    expect(generatedEnvironments).toEqual([environment])
  })

  it('preserves an optional Shading artwork capability on a prepared Sketch', () => {
    const progress: ShadingProgress[] = []
    const artworkScene = sceneAt(7)
    const sketch = definePreparedSketch({
      id: 'prepared-scribble',
      name: 'Prepared Scribble',
      schema: {},
      prepare() {
        return sceneAt
      },
      generateShadingArtwork(_params, _seed, _frame, observer) {
        observer?.({
          completedWorkUnits: 2,
          totalWorkUnits: 2,
          terminal: true,
        })
        return {
          scene: artworkScene,
          diagnostics: {
            termination: 'completed',
            pathLength: 1,
            polylineCount: 1,
            penLiftCount: 0,
            fidelity: { kind: 'scribble', residualError: 0 },
          },
        }
      },
    })

    expect(
      sketch.generateShadingArtwork?.(
        {},
        'seed',
        DEFAULT_COMPOSITION_FRAME,
        (snapshot) => progress.push(snapshot),
      ),
    ).toEqual({
      scene: artworkScene,
      diagnostics: {
        termination: 'completed',
        pathLength: 1,
        polylineCount: 1,
        penLiftCount: 0,
        fidelity: { kind: 'scribble', residualError: 0 },
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

describe('optional Sketch environment', () => {
  const scene: Scene = {
    space: DEFAULT_COMPOSITION_FRAME,
    primitives: [],
  }
  const pixels: DecodedPixels = {
    width: 1,
    height: 1,
    data: Uint8ClampedArray.from([0, 0, 0, 255]),
  }
  const environment: SketchEnvironment = {
    imageAssets: (id) => (id === 'fixture' ? pixels : undefined),
  }

  it('reaches tone, Scribble, cold generate, and generated Outline hooks', () => {
    const received: Array<SketchEnvironment | undefined> = []
    const sketch: StatelessSketch = {
      id: 'environment-hooks',
      name: 'Environment hooks',
      schema: {},
      generate(_params, _seed, _t, _frame, current) {
        received.push(current)
        return scene
      },
      generateToneSource(_params, _frame, current) {
        received.push(current)
        return {
          toneField: createToneField(() => 0),
          shadingMask: createShadingMask(() => 0),
        }
      },
      generateShadingArtwork(_params, _seed, _frame, _observer, current) {
        received.push(current)
        return {
          scene,
          diagnostics: {
            termination: 'completed',
            pathLength: 0,
            polylineCount: 0,
            penLiftCount: 0,
            fidelity: { kind: 'scribble', residualError: 0 },
          },
        }
      },
      generateOutlineSource(_params, _seed, _t, _frame, _target, current) {
        received.push(current)
        return scene
      },
    }

    sketch.generate({}, 1, 0, DEFAULT_COMPOSITION_FRAME, environment)
    sketch.generateToneSource?.({}, DEFAULT_COMPOSITION_FRAME, environment)
    sketch.generateShadingArtwork?.(
      {},
      1,
      DEFAULT_COMPOSITION_FRAME,
      undefined,
      environment,
    )
    sketch.generateOutlineSource?.(
      {},
      1,
      0,
      DEFAULT_COMPOSITION_FRAME,
      { toolWidthMillimeters: 0.3, millimetersPerSceneUnit: 0.1 },
      environment,
    )

    expect(received).toEqual([
      environment,
      environment,
      environment,
      environment,
    ])
  })

  it('keeps legacy calls valid and completed-Scene Outline derivation environment-free', () => {
    const deriveOutlineSource = vi.fn(() => scene)
    const sketch: StatelessSketch = {
      id: 'legacy-environment',
      name: 'Legacy environment',
      schema: {},
      generate() {
        return scene
      },
      deriveOutlineSource,
    }
    const target = {
      toolWidthMillimeters: 0.3,
      millimetersPerSceneUnit: 0.1,
    }

    expect(sketch.generate({}, 1, 0, DEFAULT_COMPOSITION_FRAME)).toBe(scene)
    expect(sketch.deriveOutlineSource?.(scene, target)).toBe(scene)
    expect(deriveOutlineSource).toHaveBeenCalledWith(scene, target)
  })
})
