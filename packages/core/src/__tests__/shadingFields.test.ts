import { describe, expect, it } from 'vitest'

import {
  createShadingMask,
  createToneField,
  normalizeShadingSample,
  resolveCompositionFrame,
  sampleEffectiveTone,
  sampleShadingMask,
  sampleToneField,
} from '../index'
import type { ToneField, ToneSource } from '../index'
import {
  constantTone,
  disconnectedIslandsMask,
  featheredBoundaryMask,
  horizontalGradientTone,
  thinZeroBarrierMask,
  whiteHoleTone,
} from './shadingFieldFixtures'

describe('bounded shading fields', () => {
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
    const tone = createToneField(() => input)
    const mask = createShadingMask(() => input)

    expect(tone.sample([0, 0])).toBe(expected)
    expect(mask.sample([0, 0])).toBe(expected)
    expect(sampleToneField(tone, [0, 0])).toBe(expected)
    expect(sampleShadingMask(mask, [0, 0])).toBe(expected)
    expect(Number.isFinite(tone.sample([0, 0]))).toBe(true)
    expect(Number.isFinite(mask.sample([0, 0]))).toBe(true)
  })

  it('preserves exact zero and does not quantize soft permission', () => {
    expect(Object.is(normalizeShadingSample(0), 0)).toBe(true)
    expect(createShadingMask(() => 0).sample([10, 20])).toBe(0)
    expect(createShadingMask(() => 0.25).sample([10, 20])).toBe(0.25)
  })

  it('defensively bounds manually implemented fields at helper boundaries', () => {
    const malformed = {
      kind: 'tone-field' as const,
      sample: () => Number.POSITIVE_INFINITY,
    }

    expect(sampleToneField(malformed, [0, 0])).toBe(0)
  })

  it('defines effective tone as bounded darkness multiplied by bounded permission', () => {
    const source: ToneSource = {
      toneField: createToneField(() => 0.8),
      shadingMask: createShadingMask(() => 0.25),
    }

    expect(sampleEffectiveTone(source, [20, 30])).toBe(0.8 * 0.25)

    const forbidden: ToneSource = {
      toneField: createToneField(() => 1),
      shadingMask: createShadingMask(() => 0),
    }
    expect(Object.is(sampleEffectiveTone(forbidden, [20, 30]), 0)).toBe(true)
  })

  it('keeps Tone Field and Shading Mask distinct at the type boundary', () => {
    const tone: ToneField = createToneField(() => 0.5)
    expect(tone.kind).toBe('tone-field')
    expect(createShadingMask(() => 0.5).kind).toBe('shading-mask')
  })
})

describe('analytic field fixtures', () => {
  const frame = resolveCompositionFrame(1)

  it('samples constant tone and a horizontal gradient deterministically', () => {
    const constant = constantTone(0.6)
    const gradient = horizontalGradientTone(frame)

    expect(constant.sample([123, 456])).toBe(0.6)
    expect(gradient.sample([250, 800])).toBe(0.25)
    expect(gradient.sample([250, 800])).toBe(gradient.sample([250, 800]))
  })

  it('provides a dark field with an exact-white hole', () => {
    const field = whiteHoleTone(frame)

    expect(field.sample([500, 500])).toBe(0)
    expect(field.sample([100, 100])).toBe(0.8)
  })

  it('provides a feathered boundary with full, soft, and exact-zero permission', () => {
    const mask = featheredBoundaryMask(frame)

    expect(mask.sample([300, 500])).toBe(1)
    expect(mask.sample([550, 500])).toBeCloseTo(0.25)
    expect(mask.sample([700, 500])).toBe(0)
  })

  it('provides separated permission islands', () => {
    const mask = disconnectedIslandsMask(frame)

    expect(mask.sample([250, 500])).toBe(1)
    expect(mask.sample([750, 500])).toBe(1)
    expect(mask.sample([500, 500])).toBe(0)
  })

  it('provides a thin exact-zero barrier between otherwise permitted points', () => {
    const mask = thinZeroBarrierMask(frame)

    expect(mask.sample([480, 500])).toBe(1)
    expect(mask.sample([500, 500])).toBe(0)
    expect(mask.sample([520, 500])).toBe(1)
  })

  it('produces repeated identical fixture samples at fixed frame coordinates', () => {
    const fields = [
      constantTone(0.3),
      horizontalGradientTone(frame),
      whiteHoleTone(frame),
      featheredBoundaryMask(frame),
      disconnectedIslandsMask(frame),
      thinZeroBarrierMask(frame),
    ]
    const point = [550, 500] as const

    for (const field of fields) {
      const first = field.sample(point)
      expect(field.sample(point)).toBe(first)
      expect(Number.isFinite(first)).toBe(true)
      expect(first).toBeGreaterThanOrEqual(0)
      expect(first).toBeLessThanOrEqual(1)
    }
  })

  it('uses Composition Frame coordinates rather than output resolution', () => {
    const frames = [
      resolveCompositionFrame(1),
      resolveCompositionFrame(2 / 3),
      resolveCompositionFrame(3 / 2),
    ]

    const samples = frames.map((candidateFrame) =>
      horizontalGradientTone(candidateFrame).sample([
        candidateFrame.width * 0.37,
        candidateFrame.height * 0.62,
      ]),
    )

    expect(samples).toEqual([0.37, 0.37, 0.37])
  })
})
