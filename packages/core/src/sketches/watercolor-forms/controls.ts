/**
 * Independent artist-facing controls for Watercolor Forms.
 *
 * The four unit controls describe selection policy over a region hierarchy.
 * They intentionally do not reuse Pencil Contour's tone or local-edge controls:
 * Watercolor Forms starts from coherent regions and owns its parameter surface.
 */

import type { NumberParamSpec } from '../../sketch'

/** The authored controls consumed by the headless Watercolor Forms pipeline. */
export interface WatercolorFormsControls {
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
    default: UNIT_CONTROL_DEFAULT,
    step: UNIT_CONTROL_STEP,
  }),
} satisfies Record<WatercolorFormsControlName, NumberParamSpec>)

/** Frozen defaults derived from the same declarations presented to artists. */
export const defaultWatercolorFormsControls: Readonly<WatercolorFormsControls> =
  Object.freeze({
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
