import { describe, expect, expectTypeOf, it, vi } from 'vitest'

import {
  createDetailField,
  createToneField,
  sampleDetailField,
  type DetailField,
  type ToneField,
} from '../index'

describe('Detail Field', () => {
  it.each([
    [-1, 0],
    [0, 0],
    [0.25, 0.25],
    [1, 1],
    [2, 1],
    [Number.NaN, 0],
    [Number.POSITIVE_INFINITY, 0],
    [Number.NEGATIVE_INFINITY, 0],
  ])('normalizes %s to %s', (input, expected) => {
    const field = createDetailField(() => input)

    expect(field.sample([10, 20])).toBe(expected)
    expect(sampleDetailField(field, [10, 20])).toBe(expected)
    expect(Number.isFinite(field.sample([10, 20]))).toBe(true)
  })

  it.each([
    null,
    undefined,
    {},
    [],
    [10],
    [10, 20, 30],
    [Number.NaN, 20],
    [10, Number.POSITIVE_INFINITY],
  ])('fails closed for malformed point %o before invoking its producer', (point) => {
    const producer = vi.fn(() => 1)
    const field = createDetailField(producer)

    expect(field.sample(point as never)).toBe(0)
    expect(producer).not.toHaveBeenCalled()
  })

  it('defensively validates and bounds manually implemented fields', () => {
    const sample = vi.fn(() => Number.POSITIVE_INFINITY)
    const manual: DetailField = { kind: 'detail-field', sample }

    expect(sampleDetailField(manual, [10, 20])).toBe(0)
    expect(sample).toHaveBeenCalledOnce()

    sample.mockClear()
    expect(sampleDetailField(manual, null as never)).toBe(0)
    expect(sample).not.toHaveBeenCalled()
  })

  it('samples deterministic producers repeatedly at fixed frame coordinates', () => {
    const field = createDetailField(([x, y]) => (x + y) / 100)
    const point = [12, 23] as const

    expect(field.sample(point)).toBe(0.35)
    expect(field.sample(point)).toBe(field.sample(point))
    expect(sampleDetailField(field, point)).toBe(0.35)
  })

  it('keeps Detail Field distinct from Tone Field at runtime and in types', () => {
    const detail: DetailField = createDetailField(() => 0.5)
    const tone: ToneField = createToneField(() => 0.5)

    expect(detail.kind).toBe('detail-field')
    expect(tone.kind).toBe('tone-field')
    expectTypeOf<DetailField>().not.toMatchTypeOf<ToneField>()
    expectTypeOf<ToneField>().not.toMatchTypeOf<DetailField>()
  })
})
