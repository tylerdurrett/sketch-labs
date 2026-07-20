import { describe, expect, it } from 'vitest'

import {
  applyPhotoDetailSensitivity,
  photoDetailSensitivityExponent,
} from '../sketches/photo-scribble/detail'

describe('Photo Scribble Detail sensitivity', () => {
  it('uses exact endpoints and exact centered identity', () => {
    for (const sensitivity of [0, 0.25, 0.5, 0.75, 1]) {
      expect(applyPhotoDetailSensitivity(0, sensitivity)).toBe(0)
      expect(applyPhotoDetailSensitivity(1, sensitivity)).toBe(1)
    }
    for (const detail of [0, 0.125, 0.5, 0.875, 1]) {
      expect(applyPhotoDetailSensitivity(detail, 0.5)).toBe(detail)
    }
  })

  it('maps the range to reciprocal exponents and preserves pair symmetry', () => {
    expect(photoDetailSensitivityExponent(0)).toBe(4)
    expect(photoDetailSensitivityExponent(0.5)).toBe(1)
    expect(photoDetailSensitivityExponent(1)).toBe(0.25)

    for (const sensitivity of [0, 0.1, 0.25, 0.4, 0.5]) {
      expect(
        photoDetailSensitivityExponent(sensitivity) *
          photoDetailSensitivityExponent(1 - sensitivity),
      ).toBeCloseTo(1, 14)
    }
  })

  it('responds monotonically at intermediate detail and clamps malformed inputs safely', () => {
    const response = [0, 0.25, 0.5, 0.75, 1].map((sensitivity) =>
      applyPhotoDetailSensitivity(0.25, sensitivity),
    )

    expect(response).toEqual([...response].sort((a, b) => a - b))
    expect(new Set(response).size).toBe(response.length)
    expect(applyPhotoDetailSensitivity(Number.NaN, 0.5)).toBe(0)
    expect(applyPhotoDetailSensitivity(0.25, Number.NaN)).toBe(0.25)
    expect(applyPhotoDetailSensitivity(-1, 0.5)).toBe(0)
    expect(applyPhotoDetailSensitivity(2, 0.5)).toBe(1)
  })
})
