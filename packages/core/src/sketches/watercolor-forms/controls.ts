/**
 * Independent artist-facing controls for Watercolor Forms.
 *
 * The seven unit controls describe tone interpretation and selection policy
 * over a region hierarchy.
 * They intentionally do not reuse Pencil Contour's tone or local-edge controls:
 * Watercolor Forms starts from coherent regions and owns its parameter surface.
 */

import type { NumberParamSpec } from '../../sketch'
import {
  toneContrastGain,
  toneGammaExponent,
} from '../photo-scribble/tone'

/** The authored controls consumed by the headless Watercolor Forms pipeline. */
export interface WatercolorFormsControls {
  /** Identity-centred power-curve control in the declared `[0, 1]` range. */
  readonly gamma: number
  /** Identity-centred, pivot-anchored contrast control. */
  readonly contrast: number
  /** Anchor used by the contrast curve. */
  readonly pivot: number
  /** Higher values retain progressively finer or less-persistent forms. */
  readonly formDetail: number
  /**
   * Higher values preserve subtler visible color differences between neighbors.
   *
   * In particular, increasing this control must make merging more conservative;
   * it is sensitivity to a difference, not permission to merge through one.
   */
  readonly colorSensitivity: number
  /** Higher values require stronger persistent boundaries to emit a mark. */
  readonly boundaryStrength: number
  /** Higher values regularize selected boundary geometry more strongly. */
  readonly boundarySmoothing: number
}

export type WatercolorFormsControlName = keyof WatercolorFormsControls

const UNIT_CONTROL_MIN = 0
const UNIT_CONTROL_MAX = 1
const UNIT_CONTROL_DEFAULT = 0.5
const UNIT_CONTROL_STEP = 0.01

/** Public declarations in their authored display and serialization order. */
export const watercolorFormsControlSchema = Object.freeze({
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
  formDetail: Object.freeze({
    kind: 'number',
    min: UNIT_CONTROL_MIN,
    max: UNIT_CONTROL_MAX,
    default: UNIT_CONTROL_DEFAULT,
    step: UNIT_CONTROL_STEP,
  }),
  colorSensitivity: Object.freeze({
    kind: 'number',
    min: UNIT_CONTROL_MIN,
    max: UNIT_CONTROL_MAX,
    default: UNIT_CONTROL_DEFAULT,
    step: UNIT_CONTROL_STEP,
  }),
  boundaryStrength: Object.freeze({
    kind: 'number',
    min: UNIT_CONTROL_MIN,
    max: UNIT_CONTROL_MAX,
    default: UNIT_CONTROL_DEFAULT,
    step: UNIT_CONTROL_STEP,
  }),
  boundarySmoothing: Object.freeze({
    kind: 'number',
    min: UNIT_CONTROL_MIN,
    max: UNIT_CONTROL_MAX,
    default: UNIT_CONTROL_MAX,
    step: UNIT_CONTROL_STEP,
  }),
} satisfies Record<WatercolorFormsControlName, NumberParamSpec>)

/** Frozen defaults derived from the same declarations presented to artists. */
export const defaultWatercolorFormsControls: Readonly<WatercolorFormsControls> =
  Object.freeze({
    gamma: watercolorFormsControlSchema.gamma.default,
    contrast: watercolorFormsControlSchema.contrast.default,
    pivot: watercolorFormsControlSchema.pivot.default,
    formDetail: watercolorFormsControlSchema.formDetail.default,
    colorSensitivity: watercolorFormsControlSchema.colorSensitivity.default,
    boundaryStrength: watercolorFormsControlSchema.boundaryStrength.default,
    boundarySmoothing: watercolorFormsControlSchema.boundarySmoothing.default,
  })

function boundedControl(
  name: WatercolorFormsControlName,
  value: number,
): number {
  const spec = watercolorFormsControlSchema[name]
  if (!Number.isFinite(value)) return spec.default
  return Math.min(spec.max, Math.max(spec.min, value))
}

/**
 * Resolve partial or untrusted controls to one immutable, finite snapshot.
 *
 * Missing and non-finite values take their declared defaults. Finite values are
 * clamped to the schema bounds so none can expand a later work budget.
 */
export function normalizeWatercolorFormsControls(
  controls: Partial<WatercolorFormsControls> = defaultWatercolorFormsControls,
): Readonly<WatercolorFormsControls> {
  return Object.freeze({
    gamma: boundedControl(
      'gamma',
      controls.gamma ?? defaultWatercolorFormsControls.gamma,
    ),
    contrast: boundedControl(
      'contrast',
      controls.contrast ?? defaultWatercolorFormsControls.contrast,
    ),
    pivot: boundedControl(
      'pivot',
      controls.pivot ?? defaultWatercolorFormsControls.pivot,
    ),
    formDetail: boundedControl(
      'formDetail',
      controls.formDetail ?? defaultWatercolorFormsControls.formDetail,
    ),
    colorSensitivity: boundedControl(
      'colorSensitivity',
      controls.colorSensitivity ??
        defaultWatercolorFormsControls.colorSensitivity,
    ),
    boundaryStrength: boundedControl(
      'boundaryStrength',
      controls.boundaryStrength ??
        defaultWatercolorFormsControls.boundaryStrength,
    ),
    boundarySmoothing: boundedControl(
      'boundarySmoothing',
      controls.boundarySmoothing ??
        defaultWatercolorFormsControls.boundarySmoothing,
    ),
  })
}

/** Prepared per-sample tone transform for one normalized control snapshot. */
export type WatercolorFormsToneTransform = (luminance: number) => number

function clampUnit(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0
  if (value >= 1) return 1
  return value
}

/**
 * Adapt Watercolor Forms' independent controls to the established pure
 * gamma-then-pivoted-contrast math.
 *
 * The adapter captures an already-normalized snapshot once, before raster
 * preparation. Region-selection controls never enter tone shaping.
 */
export function createNormalizedWatercolorFormsToneTransform(
  controls: Readonly<WatercolorFormsControls>,
): WatercolorFormsToneTransform {
  const gammaExponent = toneGammaExponent(controls.gamma)
  const contrastGain = toneContrastGain(controls.contrast)
  return (luminance) => {
    const bounded = clampUnit(luminance)
    const gammaAdjusted =
      controls.gamma === UNIT_CONTROL_DEFAULT
        ? bounded
        : clampUnit(bounded ** gammaExponent)
    if (controls.contrast === UNIT_CONTROL_DEFAULT) return gammaAdjusted
    return clampUnit(
      controls.pivot +
        (gammaAdjusted - controls.pivot) * contrastGain,
    )
  }
}

/** Prepare Watercolor Forms' normalized gamma-then-contrast transform. */
export function createWatercolorFormsToneTransform(
  controls: Partial<WatercolorFormsControls> = defaultWatercolorFormsControls,
): WatercolorFormsToneTransform {
  return createNormalizedWatercolorFormsToneTransform(
    normalizeWatercolorFormsControls(controls),
  )
}
