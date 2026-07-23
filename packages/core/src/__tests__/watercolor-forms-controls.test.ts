import { describe, expect, it } from 'vitest'

import {
  defaultWatercolorFormsControls,
  normalizeWatercolorFormsControls,
  watercolorFormsControlSchema,
} from '../sketches/watercolor-forms/controls'
import { WATERCOLOR_FORMS_LIMITS } from '../sketches/watercolor-forms/limits'

describe('Watercolor Forms authored controls', () => {
  it('declares four independent frozen controls in authored order', () => {
    expect(Object.keys(watercolorFormsControlSchema)).toEqual([
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
  })

  it('retains independently authored values', () => {
    expect(
      normalizeWatercolorFormsControls({
        formDetail: 0.1,
        colorSensitivity: 0.2,
        boundaryStrength: 0.3,
        boundarySmoothing: 0.4,
      }),
    ).toEqual({
      formDetail: 0.1,
      colorSensitivity: 0.2,
      boundaryStrength: 0.3,
      boundarySmoothing: 0.4,
    })
  })

  it('fills missing values from declarations', () => {
    expect(normalizeWatercolorFormsControls({ formDetail: 0.75 })).toEqual({
      ...defaultWatercolorFormsControls,
      formDetail: 0.75,
    })
  })

  it('defaults non-finite inputs, clamps finite bounds, and freezes output', () => {
    const normalized = normalizeWatercolorFormsControls({
      formDetail: Number.NaN,
      colorSensitivity: Number.POSITIVE_INFINITY,
      boundaryStrength: -20,
      boundarySmoothing: 20,
    })

    expect(normalized).toEqual({
      formDetail: defaultWatercolorFormsControls.formDetail,
      colorSensitivity: defaultWatercolorFormsControls.colorSensitivity,
      boundaryStrength: watercolorFormsControlSchema.boundaryStrength.min,
      boundarySmoothing: watercolorFormsControlSchema.boundarySmoothing.max,
    })
    expect(Object.isFrozen(normalized)).toBe(true)
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
