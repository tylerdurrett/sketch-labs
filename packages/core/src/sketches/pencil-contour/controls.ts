/**
 * Reusable authored controls for Pencil Contour.
 *
 * Tone controls deliberately use Pencil Contour names and declarations while
 * sharing Photo Scribble's proven identity-centred curve implementation. This
 * keeps the two Sketch parameter surfaces independent: changing either schema
 * does not silently change the other Sketch's authored values.
 */

import type { NumberParamSpec } from '../../sketch'
import {
  applyPhotoToneControls,
  type PhotoToneControls,
} from '../photo-scribble/tone'

/** The five artist-facing controls consumed by the headless contour pipeline. */
export interface PencilContourControls {
  /** Identity-centred power-curve control in the declared `[0, 1]` range. */
  readonly gamma: number
  /** Identity-centred, pivot-anchored contrast control. */
  readonly contrast: number
  /** Anchor used by the contrast curve. */
  readonly pivot: number
  /** Admission of progressively weaker secondary image structure. */
  readonly contourDetail: number
  /** Strength of deterministic path cleanup and simplification. */
  readonly contourSmoothing: number
}

export type PencilContourControlName = keyof PencilContourControls

const UNIT_CONTROL_MIN = 0
const UNIT_CONTROL_MAX = 1
const UNIT_CONTROL_DEFAULT = 0.5
const UNIT_CONTROL_STEP = 0.01

/** Public declarations for Pencil Contour's independent authored controls. */
export const pencilContourControlSchema = Object.freeze({
  gamma: Object.freeze({
    kind: 'number',
    min: UNIT_CONTROL_MIN,
    max: UNIT_CONTROL_MAX,
    default: UNIT_CONTROL_DEFAULT,
    step: UNIT_CONTROL_STEP,
  }),
  contrast: Object.freeze({
    kind: 'number',
    min: UNIT_CONTROL_MIN,
    max: UNIT_CONTROL_MAX,
    default: UNIT_CONTROL_DEFAULT,
    step: UNIT_CONTROL_STEP,
  }),
  pivot: Object.freeze({
    kind: 'number',
    min: UNIT_CONTROL_MIN,
    max: UNIT_CONTROL_MAX,
    default: UNIT_CONTROL_DEFAULT,
    step: UNIT_CONTROL_STEP,
  }),
  contourDetail: Object.freeze({
    kind: 'number',
    min: UNIT_CONTROL_MIN,
    max: UNIT_CONTROL_MAX,
    default: UNIT_CONTROL_DEFAULT,
    step: UNIT_CONTROL_STEP,
  }),
  contourSmoothing: Object.freeze({
    kind: 'number',
    min: UNIT_CONTROL_MIN,
    max: UNIT_CONTROL_MAX,
    default: UNIT_CONTROL_DEFAULT,
    step: UNIT_CONTROL_STEP,
  }),
} satisfies Record<PencilContourControlName, NumberParamSpec>)

/** Frozen defaults derived from the same declarations presented to artists. */
export const defaultPencilContourControls: Readonly<PencilContourControls> =
  Object.freeze({
    gamma: pencilContourControlSchema.gamma.default,
    contrast: pencilContourControlSchema.contrast.default,
    pivot: pencilContourControlSchema.pivot.default,
    contourDetail: pencilContourControlSchema.contourDetail.default,
    contourSmoothing: pencilContourControlSchema.contourSmoothing.default,
  })

function boundedControl(name: PencilContourControlName, value: number): number {
  const spec = pencilContourControlSchema[name]
  if (!Number.isFinite(value)) return spec.default
  return Math.min(spec.max, Math.max(spec.min, value))
}

/** Bound untrusted or partial inputs with the authored declarations. */
export function normalizePencilContourControls(
  controls: Partial<PencilContourControls> = defaultPencilContourControls,
): Readonly<PencilContourControls> {
  return Object.freeze({
    gamma: boundedControl(
      'gamma',
      controls.gamma ?? defaultPencilContourControls.gamma,
    ),
    contrast: boundedControl(
      'contrast',
      controls.contrast ?? defaultPencilContourControls.contrast,
    ),
    pivot: boundedControl(
      'pivot',
      controls.pivot ?? defaultPencilContourControls.pivot,
    ),
    contourDetail: boundedControl(
      'contourDetail',
      controls.contourDetail ?? defaultPencilContourControls.contourDetail,
    ),
    contourSmoothing: boundedControl(
      'contourSmoothing',
      controls.contourSmoothing ??
        defaultPencilContourControls.contourSmoothing,
    ),
  })
}

/** Prepared per-sample tone transform for one normalized control snapshot. */
export type PencilContourToneTransform = (luminance: number) => number

/**
 * Prepare Pencil Contour's gamma-then-contrast luminance transform.
 *
 * Normalization, freezing, and adaptation to Photo Scribble's pure tone
 * contract happen once here, outside the raster loop. The returned hot-path
 * function only applies the already-prepared values to each luminance sample.
 * Detail and smoothing never enter tone shaping.
 */
export function createPencilContourToneTransform(
  controls: Partial<PencilContourControls> = defaultPencilContourControls,
): PencilContourToneTransform {
  const normalized = normalizePencilContourControls(controls)
  const photoToneControls: Readonly<PhotoToneControls> = Object.freeze({
    toneGamma: normalized.gamma,
    toneContrast: normalized.contrast,
    tonePivot: normalized.pivot,
  })
  return (luminance) => applyPhotoToneControls(luminance, photoToneControls)
}
