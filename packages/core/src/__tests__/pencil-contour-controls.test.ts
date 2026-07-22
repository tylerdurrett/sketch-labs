import { describe, expect, it } from 'vitest'

import {
  applyPhotoToneControls,
  applyToneContrast,
  applyToneGamma,
} from '../sketches/photo-scribble/tone'
import {
  createPencilContourToneTransform,
  defaultPencilContourControls,
  normalizePencilContourControls,
  pencilContourControlSchema,
} from '../sketches/pencil-contour/controls'

describe('Pencil Contour authored controls', () => {
  it('declares five independent frozen controls and derives defaults', () => {
    expect(Object.keys(pencilContourControlSchema)).toEqual([
      'gamma',
      'contrast',
      'pivot',
      'contourDetail',
      'contourSmoothing',
    ])

    for (const [name, spec] of Object.entries(pencilContourControlSchema)) {
      expect(spec.kind, name).toBe('number')
      expect(spec.min, name).toBeLessThan(spec.max)
      expect(spec.default, name).toBeGreaterThanOrEqual(spec.min)
      expect(spec.default, name).toBeLessThanOrEqual(spec.max)
      expect(
        defaultPencilContourControls[
          name as keyof typeof defaultPencilContourControls
        ],
      ).toBe(spec.default)
      expect(Object.isFrozen(spec), name).toBe(true)
    }

    expect(Object.isFrozen(pencilContourControlSchema)).toBe(true)
    expect(Object.isFrozen(defaultPencilContourControls)).toBe(true)
  })

  it('retains independently authored values', () => {
    const normalized = normalizePencilContourControls({
      gamma: 0.1,
      contrast: 0.2,
      pivot: 0.3,
      contourDetail: 0.4,
      contourSmoothing: 0.5,
    })

    expect(normalized).toEqual({
      gamma: 0.1,
      contrast: 0.2,
      pivot: 0.3,
      contourDetail: 0.4,
      contourSmoothing: 0.5,
    })
  })

  it('defaults non-finite inputs, clamps finite bounds, and freezes output', () => {
    const normalized = normalizePencilContourControls({
      gamma: Number.NaN,
      contrast: Number.POSITIVE_INFINITY,
      pivot: Number.NEGATIVE_INFINITY,
      contourDetail: -20,
      contourSmoothing: 20,
    })

    expect(normalized).toEqual({
      gamma: defaultPencilContourControls.gamma,
      contrast: defaultPencilContourControls.contrast,
      pivot: defaultPencilContourControls.pivot,
      contourDetail: pencilContourControlSchema.contourDetail.min,
      contourSmoothing: pencilContourControlSchema.contourSmoothing.max,
    })
    expect(Object.isFrozen(normalized)).toBe(true)
  })

  it('uses Photo Scribble tone math without coupling its control values', () => {
    const pencilControls = {
      gamma: 0.27,
      contrast: 0.81,
      pivot: 0.36,
      contourDetail: 0.12,
      contourSmoothing: 0.94,
    }
    const photoControls = {
      toneGamma: pencilControls.gamma,
      toneContrast: pencilControls.contrast,
      tonePivot: pencilControls.pivot,
    }
    const applyTone = createPencilContourToneTransform(pencilControls)
    const applyToneWithDifferentGeometry = createPencilContourToneTransform({
      ...pencilControls,
      contourDetail: 0.99,
      contourSmoothing: 0.01,
    })

    expect(applyTone(0.63)).toBe(
      applyPhotoToneControls(0.63, photoControls),
    )
    expect(applyToneWithDifferentGeometry(0.63)).toBe(
      applyPhotoToneControls(0.63, photoControls),
    )
  })

  it('captures normalized tone values once before raster sampling', () => {
    const controls = {
      gamma: 0.27,
      contrast: 0.81,
      pivot: 0.36,
      contourDetail: 0.12,
      contourSmoothing: 0.94,
    }
    const applyTone = createPencilContourToneTransform(controls)
    const beforeMutation = applyTone(0.63)

    controls.gamma = Number.NaN
    controls.contrast = 0
    controls.pivot = 1

    expect(applyTone(0.63)).toBe(beforeMutation)
  })
})

describe('Photo Scribble tone regression', () => {
  it('preserves its gamma-then-contrast behavior and zero/identity guards', () => {
    const controls = {
      toneGamma: 0.75,
      toneContrast: 0.25,
      tonePivot: 0.4,
    }
    const gammaAdjusted = applyToneGamma(0.7, controls.toneGamma)

    expect(applyPhotoToneControls(0.7, controls)).toBe(
      applyToneContrast(
        gammaAdjusted,
        controls.toneContrast,
        controls.tonePivot,
      ),
    )
    expect(
      applyPhotoToneControls(0, {
        toneGamma: 1,
        toneContrast: 0,
        tonePivot: 1,
      }),
    ).toBe(0)
    expect(
      applyPhotoToneControls(0.7, {
        toneGamma: 0.5,
        toneContrast: 0.5,
        tonePivot: 0,
      }),
    ).toBe(0.7)
  })
})
