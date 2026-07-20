/** Photo Scribble's Detail sensitivity and local-scale responses. */

import { sampleDetailField, type DetailField } from '../../detailFields'
import {
  createScribbleScaleField,
  type ScribbleScaleField,
} from '../../scribbleScaleField'

export const PHOTO_DETAIL_SENSITIVITY_MIN = 0
export const PHOTO_DETAIL_SENSITIVITY_MAX = 1
export const PHOTO_DETAIL_SENSITIVITY_DEFAULT = 0.5

export const PHOTO_DETAIL_INFLUENCE_MIN = 0
export const PHOTO_DETAIL_INFLUENCE_MAX = 1
export const PHOTO_DETAIL_INFLUENCE_DEFAULT = 0

const DETAIL_SENSITIVITY_EXPONENT_BASE = 4
const DETAIL_SCALE_BROADENING_BASE = 4

function clampUnit(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0
  if (value >= 1) return 1
  return value
}

function clampSensitivity(value: number): number {
  if (!Number.isFinite(value)) return PHOTO_DETAIL_SENSITIVITY_DEFAULT
  return clampUnit(value)
}

function clampInfluence(value: number): number {
  if (!Number.isFinite(value)) return PHOTO_DETAIL_INFLUENCE_DEFAULT
  return clampUnit(value)
}

/** Map Detail sensitivity to its reciprocal-pair exponent in `[1/4, 4]`. */
export function photoDetailSensitivityExponent(sensitivity: number): number {
  const control = clampSensitivity(sensitivity)
  return DETAIL_SENSITIVITY_EXPONENT_BASE ** (1 - 2 * control)
}

/**
 * Apply `detail^(4^(1 - 2*sensitivity))` with exact field endpoints and center.
 */
export function applyPhotoDetailSensitivity(
  detail: number,
  sensitivity: number,
): number {
  const boundedDetail = clampUnit(detail)
  if (boundedDetail === 0 || boundedDetail === 1) return boundedDetail

  const control = clampSensitivity(sensitivity)
  if (control === PHOTO_DETAIL_SENSITIVITY_DEFAULT) return boundedDetail
  return boundedDetail ** photoDetailSensitivityExponent(control)
}

/** Map Detail influence exponentially from exact identity to `4×` broadening. */
export function photoDetailBroadeningFactor(influence: number): number {
  return DETAIL_SCALE_BROADENING_BASE ** clampInfluence(influence)
}

/**
 * Map sensitivity-adjusted Detail onto local Scribble scale.
 *
 * Strongest detail is the exact authored fine anchor. Progressively smoother
 * regions broaden toward `scribbleScale × 4^influence`.
 */
export function createPhotoScribbleScaleField(
  detailField: DetailField,
  scribbleScale: number,
  influence: number,
): ScribbleScaleField {
  const broadening = photoDetailBroadeningFactor(influence)
  return createScribbleScaleField(
    scribbleScale,
    (point) => {
      const detail = sampleDetailField(detailField, point)
      return scribbleScale * broadening ** (1 - detail)
    },
    scribbleScale * broadening,
  )
}
