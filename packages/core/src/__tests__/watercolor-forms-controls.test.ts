import { describe, expect, it } from 'vitest'

import {
  createWatercolorFormsToneTransform,
  defaultWatercolorFormsControls,
  normalizeWatercolorFormsControls,
  watercolorFormsControlSchema,
} from '../sketches/watercolor-forms/controls'
import {
  applyPhotoToneControls,
  applyToneContrast,
  applyToneGamma,
} from '../sketches/photo-scribble/tone'
import { WATERCOLOR_FORMS_LIMITS } from '../sketches/watercolor-forms/limits'

describe('Watercolor Forms authored controls', () => {
  it('declares seven independent frozen controls in authored order', () => {
    expect(Object.keys(watercolorFormsControlSchema)).toEqual([
      'gamma',
      'contrast',
      'pivot',
      'formDetail',
      'colorSensitivity',
      'boundaryStrength',
      'boundarySmoothing',
    ])

    for (const [name, spec] of Object.entries(watercolorFormsControlSchema)) {
      expect(spec.kind, name).toBe('number')
      expect(spec.min, name).toBeLessThan(spec.max)
      expect(spec.default, name).toBeGreaterThanOrEqual(spec.min)
      expect(spec.default, name).toBeLessThanOrEqual(spec.max)
      expect(
        defaultWatercolorFormsControls[
          name as keyof typeof defaultWatercolorFormsControls
        ],
      ).toBe(spec.default)
      expect(Object.isFrozen(spec), name).toBe(true)
    }

    expect(Object.isFrozen(watercolorFormsControlSchema)).toBe(true)
    expect(Object.isFrozen(defaultWatercolorFormsControls)).toBe(true)
    expect(watercolorFormsControlSchema.boundarySmoothing.default).toBe(1)
    for (const name of [
      'gamma',
      'contrast',
      'pivot',
      'formDetail',
      'colorSensitivity',
      'boundaryStrength',
    ] as const) {
      expect(watercolorFormsControlSchema[name].default, name).toBe(0.5)
    }
  })

  it('retains independently authored values', () => {
    expect(
      normalizeWatercolorFormsControls({
        gamma: 0.7,
        contrast: 0.6,
        pivot: 0.8,
        formDetail: 0.1,
        colorSensitivity: 0.2,
        boundaryStrength: 0.3,
        boundarySmoothing: 0.4,
      }),
    ).toEqual({
      gamma: 0.7,
      contrast: 0.6,
      pivot: 0.8,
      formDetail: 0.1,
      colorSensitivity: 0.2,
      boundaryStrength: 0.3,
      boundarySmoothing: 0.4,
    })
  })

  it('defaults legacy missing tone keys to exact identity', () => {
    const normalized = normalizeWatercolorFormsControls({ formDetail: 0.75 })

    expect(normalized).toEqual({
      ...defaultWatercolorFormsControls,
      formDetail: 0.75,
    })
    expect(normalized.gamma).toBe(0.5)
    expect(normalized.contrast).toBe(0.5)
    expect(normalized.pivot).toBe(0.5)
  })

  it('defaults non-finite inputs, clamps finite bounds, and freezes output', () => {
    const normalized = normalizeWatercolorFormsControls({
      gamma: Number.NaN,
      contrast: Number.POSITIVE_INFINITY,
      pivot: Number.NEGATIVE_INFINITY,
      formDetail: Number.NaN,
      colorSensitivity: Number.POSITIVE_INFINITY,
      boundaryStrength: -20,
      boundarySmoothing: 20,
    })

    expect(normalized).toEqual({
      gamma: defaultWatercolorFormsControls.gamma,
      contrast: defaultWatercolorFormsControls.contrast,
      pivot: defaultWatercolorFormsControls.pivot,
      formDetail: defaultWatercolorFormsControls.formDetail,
      colorSensitivity: defaultWatercolorFormsControls.colorSensitivity,
      boundaryStrength: watercolorFormsControlSchema.boundaryStrength.min,
      boundarySmoothing: watercolorFormsControlSchema.boundarySmoothing.max,
    })
    expect(Object.isFrozen(normalized)).toBe(true)
  })

  it('adapts independent values to exact gamma-then-contrast math', () => {
    const controls = {
      ...defaultWatercolorFormsControls,
      gamma: 0.79,
      contrast: 0.18,
      pivot: 0.37,
    }
    const applyTone = createWatercolorFormsToneTransform(controls)
    const gammaAdjusted = applyToneGamma(0.68, controls.gamma)

    expect(applyTone(0.68)).toBe(
      applyPhotoToneControls(0.68, {
        toneGamma: controls.gamma,
        toneContrast: controls.contrast,
        tonePivot: controls.pivot,
      }),
    )
    expect(applyTone(0.68)).toBe(
      applyToneContrast(
        gammaAdjusted,
        controls.contrast,
        controls.pivot,
      ),
    )
    expect(createWatercolorFormsToneTransform()(0.68)).toBe(0.68)
  })

  it('keeps low-contrast interpretation continuous through black', () => {
    const applyTone = createWatercolorFormsToneTransform({
      contrast: 0,
      pivot: 0.5,
    })
    const black = applyTone(0)
    const nearBlack = applyTone(1e-12)

    expect(black).toBeCloseTo(0.475, 15)
    expect(nearBlack).toBeGreaterThanOrEqual(black)
    expect(nearBlack - black).toBeLessThan(1e-10)
  })
})

describe('Watercolor Forms deterministic safety policy', () => {
  it('derives every topology cap from the bounded lattice', () => {
    const limits = WATERCOLOR_FORMS_LIMITS
    const samples =
      limits.analysisMaxDimension * limits.analysisMaxDimension
    const squareGridAdjacencies =
      2 * samples - 2 * limits.analysisMaxDimension

    expect(Object.isFrozen(limits)).toBe(true)
    expect(limits.maxSampleCount).toBe(samples)
    expect(limits.maxInitialRegionCount).toBe(samples)
    expect(limits.maxGridAdjacencyCount).toBe(squareGridAdjacencies)
    expect(limits.maxGridAdjacencyCount).toBeLessThan(2 * samples)
    expect(limits.maxMergeCount).toBe(limits.maxInitialRegionCount - 1)
    expect(limits.maxRetainedBoundarySegmentCount).toBe(
      limits.maxGridAdjacencyCount,
    )
    expect(limits.maxBoundaryPathCount).toBe(
      limits.maxRetainedBoundarySegmentCount,
    )
    expect(limits.maxPrimitiveCount).toBe(limits.maxBoundaryPathCount)
  })

  it('bounds secondary work as explicit multiples of structural inventories', () => {
    const limits = WATERCOLOR_FORMS_LIMITS

    expect(limits.maxMergeQueueEntryCount).toBe(
      8 * limits.maxGridAdjacencyCount,
    )
    expect(limits.maxRegionUpdateCount).toBe(
      8 * limits.maxGridAdjacencyCount,
    )
    expect(limits.maxCurvePointCount).toBe(
      2 * limits.maxRetainedBoundarySegmentCount,
    )
  })
})
