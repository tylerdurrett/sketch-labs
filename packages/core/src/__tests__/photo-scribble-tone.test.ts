import { describe, expect, it } from 'vitest'

import {
  applyPhotoToneControls,
  applyToneContrast,
  applyToneGamma,
  PHOTO_TONE_CONTROL_DEFAULT,
  PHOTO_TONE_CONTROL_MAX,
  PHOTO_TONE_CONTROL_MIN,
  toneContrastGain,
  toneGammaExponent,
} from '../sketches/photo-scribble/tone'

const TONES = [0, 0.01, 0.2, 0.5, 0.8, 0.99, 1] as const
const CONTROL_GRID = [0, 0.25, 0.5, 0.75, 1] as const

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
    expect(toneContrastGain(PHOTO_TONE_CONTROL_DEFAULT)).toBe(1)

    for (const tone of TONES) {
      expect(applyToneGamma(tone, PHOTO_TONE_CONTROL_DEFAULT)).toBe(tone)
      expect(
        applyToneContrast(
          tone,
          PHOTO_TONE_CONTROL_DEFAULT,
          PHOTO_TONE_CONTROL_DEFAULT,
        ),
      ).toBe(tone)
      expect(applyToneContrast(tone, PHOTO_TONE_CONTROL_DEFAULT, 0.2)).toBe(
        tone,
      )
      expect(
        applyPhotoToneControls(tone, {
          toneGamma: PHOTO_TONE_CONTROL_DEFAULT,
          toneContrast: PHOTO_TONE_CONTROL_DEFAULT,
          tonePivot: PHOTO_TONE_CONTROL_DEFAULT,
        }),
      ).toBe(tone)
    }
  })

  it('maps gamma symmetrically to reciprocal exponents around the center', () => {
    expect(toneGammaExponent(0)).toBeCloseTo(0.125, 14)
    expect(toneGammaExponent(1)).toBe(8)
    expect(toneGammaExponent(0.25)).toBeCloseTo(8 ** -0.5, 14)
    expect(toneGammaExponent(0.75)).toBeCloseTo(8 ** 0.5, 14)
    expect(toneGammaExponent(0.25) * toneGammaExponent(0.75)).toBeCloseTo(1, 14)
  })

  it('maps contrast symmetrically to reciprocal gains around the center', () => {
    expect(toneContrastGain(0)).toBeCloseTo(0.05, 14)
    expect(toneContrastGain(1)).toBe(20)
    expect(toneContrastGain(0.25) * toneContrastGain(0.75)).toBeCloseTo(1, 12)
  })

  it('applies non-identity gamma and contrast with the pinned mappings', () => {
    expect(applyToneGamma(0.25, 0)).toBeCloseTo(2 ** -0.25, 14)
    expect(applyToneGamma(0.5, 1)).toBe(0.00390625)

    expect(applyToneContrast(0.25, 0, 0.5)).toBeCloseTo(0.4875, 14)
    expect(applyToneContrast(0.75, 1, 0.5)).toBe(1)
    expect(applyToneContrast(0.51, 1, 0.5)).toBeCloseTo(0.7, 12)
  })

  it('preserves exact zero and clamps every result to the tone domain', () => {
    for (const control of [0, 0.5, 1]) {
      for (const pivot of [0, 0.5, 1]) {
        expect(applyToneGamma(0, control)).toBe(0)
        expect(applyToneContrast(0, control, pivot)).toBe(0)
        expect(
          applyPhotoToneControls(0, {
            toneGamma: control,
            toneContrast: control,
            tonePivot: pivot,
          }),
        ).toBe(0)
      }
    }

    expect(applyToneGamma(-1, 0)).toBe(0)
    expect(applyToneGamma(2, 1)).toBe(1)
    expect(applyToneContrast(-1, 1, 0.5)).toBe(0)
    expect(applyToneContrast(2, 1, 0.5)).toBe(1)
  })

  it('keeps both transforms monotonic across every control extreme', () => {
    for (const control of [0, 0.5, 1]) {
      expectMonotonic((tone) => applyToneGamma(tone, control))
      for (const pivot of CONTROL_GRID) {
        expectMonotonic((tone) => applyToneContrast(tone, control, pivot))
      }
    }
  })

  it('composes gamma before contrast', () => {
    const tone = 0.75
    const controls = { toneGamma: 1, toneContrast: 1, tonePivot: 0.5 }
    const gammaThenContrast = applyToneContrast(
      applyToneGamma(tone, controls.toneGamma),
      controls.toneContrast,
      controls.tonePivot,
    )
    const contrastThenGamma = applyToneGamma(
      applyToneContrast(tone, controls.toneContrast, controls.tonePivot),
      controls.toneGamma,
    )

    expect(applyPhotoToneControls(tone, controls)).toBe(gammaThenContrast)
    expect(gammaThenContrast).toBe(0)
    expect(contrastThenGamma).toBe(1)
    expect(gammaThenContrast).not.toBeCloseTo(contrastThenGamma, 10)
  })

  it('renders a smooth ramp effectively binary at maximum contrast', () => {
    const controls = { toneGamma: 0.5, toneContrast: 1, tonePivot: 0.5 }
    let transitional = 0
    for (let step = 0; step <= 100; step += 1) {
      const tone = step / 100
      const mapped = applyPhotoToneControls(tone, controls)
      if (tone <= 0.47) expect(mapped).toBe(0)
      if (tone >= 0.53) expect(mapped).toBe(1)
      if (mapped > 0 && mapped < 1) transitional += 1
    }
    expect(transitional).toBeLessThanOrEqual(5)
  })

  it('moves the tonal cut point with the pivot at maximum contrast', () => {
    expect(applyToneContrast(0.15, 1, 0.2)).toBe(0)
    expect(applyToneContrast(0.25, 1, 0.2)).toBe(1)
    expect(applyToneContrast(0.75, 1, 0.8)).toBe(0)
    expect(applyToneContrast(0.85, 1, 0.8)).toBe(1)
  })

  it('reaches gamma extremes beyond the old exponent range', () => {
    expect(applyToneGamma(0.5, 1)).toBe(0.00390625)
    expect(applyToneGamma(0.5, 0)).toBeCloseTo(2 ** -0.125, 14)
  })

  it('preserves exact zero across the full control grid', () => {
    for (const toneGamma of CONTROL_GRID) {
      for (const toneContrast of CONTROL_GRID) {
        for (const tonePivot of CONTROL_GRID) {
          expect(
            applyPhotoToneControls(0, { toneGamma, toneContrast, tonePivot }),
          ).toBe(0)
        }
      }
    }

    expect(applyToneContrast(0, 0, 1)).toBe(0)
    expect(applyToneContrast(0.001, 0, 1)).toBeCloseTo(0.95005, 5)
  })
})
