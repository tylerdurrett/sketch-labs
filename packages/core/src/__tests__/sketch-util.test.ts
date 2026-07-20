import { describe, expect, expectTypeOf, it } from 'vitest'

import { bbox, choiceParam, imageAssetParam } from '../sketches/sketch-util'
import type { ParamSpec } from '../sketch'
import type { Point } from '../types'

describe('bbox', () => {
  it('computes correct min/max on both axes for a handful of points', () => {
    const points: Point[] = [
      [1, 2],
      [5, -3],
      [-4, 8],
      [0, 0],
    ]
    expect(bbox(points)).toEqual({ minX: -4, minY: -3, maxX: 5, maxY: 8 })
  })

  it('yields a zero-area box (min === max) for a single point', () => {
    const box = bbox([[7, -2]])
    expect(box).toEqual({ minX: 7, minY: -2, maxX: 7, maxY: -2 })
    expect(box.maxX - box.minX).toBe(0)
    expect(box.maxY - box.minY).toBe(0)
  })

  it('handles negative coordinates', () => {
    const points: Point[] = [
      [-10, -20],
      [-3, -5],
    ]
    expect(bbox(points)).toEqual({ minX: -10, minY: -20, maxX: -3, maxY: -5 })
  })
})

describe('imageAssetParam', () => {
  const schema = {
    image: { kind: 'image-asset', default: 'portrait-default' },
    count: { kind: 'number', min: 1, max: 10, default: 5 },
  } satisfies Record<string, ParamSpec>

  it('returns the authored stable ID unchanged', () => {
    expect(imageAssetParam({ image: 'portrait-selected' }, schema, 'image')).toBe(
      'portrait-selected',
    )
  })

  it('falls back to the declared default for a missing or non-string value', () => {
    expect(imageAssetParam({}, schema, 'image')).toBe('portrait-default')
    expect(imageAssetParam({ image: 42 }, schema, 'image')).toBe(
      'portrait-default',
    )
  })
})

describe('choiceParam', () => {
  const schema = {
    strategy: {
      kind: 'choice',
      options: [
        { value: 'scribble', label: 'Scribble' },
        { value: 'stippling', label: 'Stippling' },
      ],
      default: 'scribble',
    },
    count: { kind: 'number', min: 1, max: 10, default: 5 },
  } as const satisfies Record<string, ParamSpec>

  it('returns a declared present value with its exact value-union type', () => {
    const value = choiceParam({ strategy: 'stippling' }, schema, 'strategy')
    expect(value).toBe('stippling')
    expectTypeOf(value).toEqualTypeOf<'scribble' | 'stippling'>()
  })

  it('falls back to the declared default only when the key is absent', () => {
    expect(choiceParam({}, schema, 'strategy')).toBe('scribble')
  })

  it.each([undefined, 42, 'hatching'])(
    'rejects an invalid explicitly present value (%s)',
    (value) => {
      expect(() => choiceParam({ strategy: value }, schema, 'strategy')).toThrow(
        /value must be one of its declared option values/,
      )
    },
  )

  it('validates the Choice declaration before resolving a value', () => {
    const malformed = {
      strategy: {
        kind: 'choice',
        options: [{ value: 'scribble', label: '' }],
        default: 'scribble',
      },
    } as const satisfies Record<string, ParamSpec>
    expect(() => choiceParam({}, malformed, 'strategy')).toThrow(
      /nonempty string label/,
    )
  })
})
