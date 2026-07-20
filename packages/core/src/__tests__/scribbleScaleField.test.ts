import { describe, expect, expectTypeOf, it, vi } from 'vitest'

import * as core from '../index'
import {
  createScribbleScaleField,
  sampleScribbleScaleField,
  type ScribbleScaleField,
  type ScribbleScaleFieldProducer,
} from '../scribbleScaleField'
import type { ToneField } from '../shadingFields'
import type { Point } from '../types'

describe('Scribble Scale Field', () => {
  it('is a distinct package-root field contract', () => {
    const producer: ScribbleScaleFieldProducer = ([x]) => x
    const field: ScribbleScaleField = createScribbleScaleField(0.5, producer)

    expect(core.createScribbleScaleField).toBe(createScribbleScaleField)
    expect(core.sampleScribbleScaleField).toBe(sampleScribbleScaleField)
    expect(field.kind).toBe('scribble-scale-field')
    expect(Object.isFrozen(field)).toBe(true)
    expectTypeOf<core.ScribbleScaleField>().toEqualTypeOf<ScribbleScaleField>()
    expectTypeOf<core.ScribbleScaleFieldProducer>().toEqualTypeOf<
      ScribbleScaleFieldProducer
    >()
    expectTypeOf<ScribbleScaleField>().not.toEqualTypeOf<ToneField>()
  })

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    'eagerly rejects invalid fine anchor %s',
    (fineAnchor) => {
      const producer = vi.fn(() => 1)

      expect(() => createScribbleScaleField(fineAnchor, producer)).toThrow(
        'fine anchor must be finite and positive',
      )
      expect(producer).not.toHaveBeenCalled()
    },
  )

  it.each([
    [Number.NaN, 0],
    [0, Number.NEGATIVE_INFINITY],
    [Number.POSITIVE_INFINITY, 0],
    [0],
  ])('returns the anchor without producing for invalid point %j', (point) => {
    const producer = vi.fn(() => 2)
    const field = createScribbleScaleField(0.5, producer)

    expect(field.sample(point as Point)).toBe(0.5)
    expect(producer).not.toHaveBeenCalled()
  })

  it.each([
    [Number.NaN, 0.5],
    [Number.NEGATIVE_INFINITY, 0.5],
    [Number.POSITIVE_INFINITY, 0.5],
    [-1, 0.5],
    [0, 0.5],
    [0.499, 0.5],
    [0.5, 0.5],
    [2.75, 2.75],
    [Number.MAX_VALUE, Number.MAX_VALUE],
  ])('normalizes producer sample %s to %s', (sample, expected) => {
    const field = createScribbleScaleField(0.5, () => sample)

    expect(field.sample([4, 8])).toBe(expected)
  })

  it('revalidates manual fields, points, and the caller anchor', () => {
    const sample = vi.fn(() => 0.75)
    const manual: ScribbleScaleField = {
      kind: 'scribble-scale-field',
      sample,
    }

    expect(sampleScribbleScaleField(manual, [1, 2], 1)).toBe(1)
    expect(sampleScribbleScaleField(manual, [1, 2], 0.5)).toBe(0.75)
    expect(
      sampleScribbleScaleField(
        { ...manual, sample: () => Number.MAX_VALUE },
        [1, 2],
        0.5,
      ),
    ).toBe(Number.MAX_VALUE)

    sample.mockClear()
    expect(sampleScribbleScaleField(manual, [Number.NaN, 2], 0.5)).toBe(0.5)
    expect(sample).not.toHaveBeenCalled()

    for (const fineAnchor of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => sampleScribbleScaleField(manual, [1, 2], fineAnchor)).toThrow(
        'fine anchor must be finite and positive',
      )
    }
  })
})
