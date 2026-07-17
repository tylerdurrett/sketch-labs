import { describe, expect, it } from 'vitest'

import {
  applyPhotoToneControls,
  applyToneContrast,
  applyToneGamma,
  PHOTO_TONE_CONTROL_DEFAULT,
  PHOTO_TONE_CONTROL_MAX,
  PHOTO_TONE_CONTROL_MIN,
  toneGammaExponent,
} from '../sketches/photo-scribble/tone'

const TONES = [0, 0.01, 0.2, 0.5, 0.8, 0.99, 1] as const

function expectMonotonic(transform: (tone: number) => number): void {
  const transformed = TONES.map(transform)
  for (let index = 1; index < transformed.length; index += 1) {
    expect(transformed[index]).toBeGreaterThanOrEqual(transformed[index - 1]!)
  }
}

describe('Photo Scribble tone controls', () => {
  it('uses centered defaults as exact identities', () => {
    expect(PHOTO_TONE_CONTROL_MIN).toBe(0)
    expect(PHOTO_TONE_CONTROL_DEFAULT).toBe(0.5)
    expect(PHOTO_TONE_CONTROL_MAX).toBe(1)
    expect(toneGammaExponent(PHOTO_TONE_CONTROL_DEFAULT)).toBe(1)

    for (const tone of TONES) {
      expect(applyToneGamma(tone, PHOTO_TONE_CONTROL_DEFAULT)).toBe(tone)
      expect(applyToneContrast(tone, PHOTO_TONE_CONTROL_DEFAULT)).toBe(tone)
      expect(
        applyPhotoToneControls(tone, {
          toneGamma: PHOTO_TONE_CONTROL_DEFAULT,
          toneContrast: PHOTO_TONE_CONTROL_DEFAULT,
        }),
      ).toBe(tone)
    }
  })

  it('maps gamma symmetrically to reciprocal exponents around the center', () => {
    expect(toneGammaExponent(0)).toBe(0.5)
    expect(toneGammaExponent(1)).toBe(2)
    expect(toneGammaExponent(0.25) * toneGammaExponent(0.75)).toBeCloseTo(1, 14)
  })

  it('applies non-identity gamma and contrast with the pinned mappings', () => {
    expect(applyToneGamma(0.25, 0)).toBe(0.5)
    expect(applyToneGamma(0.5, 1)).toBe(0.25)

    expect(applyToneContrast(0.25, 0)).toBeCloseTo(0.4625, 14)
    expect(applyToneContrast(0.75, 1)).toBeCloseTo(0.9625, 14)
  })

  it('preserves exact zero and clamps every result to the tone domain', () => {
    for (const control of [0, 0.5, 1]) {
      expect(applyToneGamma(0, control)).toBe(0)
      expect(applyToneContrast(0, control)).toBe(0)
      expect(
        applyPhotoToneControls(0, {
          toneGamma: control,
          toneContrast: control,
        }),
      ).toBe(0)
    }

    expect(applyToneGamma(-1, 0)).toBe(0)
    expect(applyToneGamma(2, 1)).toBe(1)
    expect(applyToneContrast(-1, 1)).toBe(0)
    expect(applyToneContrast(2, 1)).toBe(1)
  })

  it('keeps both transforms monotonic across every control extreme', () => {
    for (const control of [0, 0.5, 1]) {
      expectMonotonic((tone) => applyToneGamma(tone, control))
      expectMonotonic((tone) => applyToneContrast(tone, control))
    }
  })

  it('composes gamma before contrast', () => {
    const tone = 0.75
    const controls = { toneGamma: 1, toneContrast: 1 }
    const gammaThenContrast = applyToneContrast(
      applyToneGamma(tone, controls.toneGamma),
      controls.toneContrast,
    )
    const contrastThenGamma = applyToneGamma(
      applyToneContrast(tone, controls.toneContrast),
      controls.toneGamma,
    )

    expect(applyPhotoToneControls(tone, controls)).toBe(gammaThenContrast)
    expect(gammaThenContrast).not.toBeCloseTo(contrastThenGamma, 10)
  })
})
