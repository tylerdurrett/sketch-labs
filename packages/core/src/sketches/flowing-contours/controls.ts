/**
 * Independent artist-facing controls for Flowing Contours.
 *
 * These declarations belong only to the whole-curve search and fitting
 * pipeline. They deliberately do not reuse Pencil Contour or Watercolor Forms
 * controls: similarly named ideas must remain independently tunable while the
 * three sketches explore different representations.
 */

import type { NumberParamSpec } from '../../sketch'
import {
  toneContrastGain,
  toneGammaExponent,
} from '../photo-scribble/tone'

/** The authored controls consumed by the headless Flowing Contours pipeline. */
export interface FlowingContoursControls {
  /** Identity-centred power-curve control in the declared `[0, 1]` range. */
  readonly gamma: number
  /** Identity-centred, pivot-anchored contrast control. */
  readonly contrast: number
  /** Anchor used by the contrast curve. */
  readonly pivot: number
  /** Admission of progressively weaker secondary evidence and more anchors. */
  readonly curveDetail: number
  /** Bounded permission to cross weak evidence while direction stays coherent. */
  readonly continuity: number
  /** Strength of curvature preference and final curve regularization. */
  readonly flowSmoothing: number
  /**
   * Shortest admissible complete curve, as a fraction of the fitted-image
   * diagonal.
   *
   * This dimensionless composition-relative value is generation policy. It
   * must never be interpreted through page dimensions, Output Profile values,
   * Tool width, or another physical-output setting.
   */
  readonly minimumStrokeLength: number
}

export type FlowingContoursControlName = keyof FlowingContoursControls

const UNIT_CONTROL_MIN = 0
const UNIT_CONTROL_MAX = 1
const UNIT_CONTROL_DEFAULT = 0.5
const UNIT_CONTROL_STEP = 0.01

const CURVE_DETAIL_MIN = 0
const CURVE_DETAIL_MAX = 2
const CURVE_DETAIL_STEP = 0.01

const MINIMUM_STROKE_LENGTH_MIN = 0.005
const MINIMUM_STROKE_LENGTH_MAX = 0.25
const MINIMUM_STROKE_LENGTH_STEP = 0.005

/**
 * Public declarations in their authored display and serialization order.
 *
 * Defaults are initial policy values. A later evidence-backed calibration may
 * tune them without changing the meaning or independence of the seven controls.
 */
export const flowingContoursControlSchema = Object.freeze({
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
  curveDetail: Object.freeze({
    kind: 'number',
    min: CURVE_DETAIL_MIN,
    max: CURVE_DETAIL_MAX,
    default: 1,
    step: CURVE_DETAIL_STEP,
  }),
  continuity: Object.freeze({
    kind: 'number',
    min: UNIT_CONTROL_MIN,
    max: UNIT_CONTROL_MAX,
    default: 0.08,
    step: UNIT_CONTROL_STEP,
  }),
  flowSmoothing: Object.freeze({
    kind: 'number',
    min: UNIT_CONTROL_MIN,
    max: UNIT_CONTROL_MAX,
    default: 0.7,
    step: UNIT_CONTROL_STEP,
  }),
  minimumStrokeLength: Object.freeze({
    kind: 'number',
    min: MINIMUM_STROKE_LENGTH_MIN,
    max: MINIMUM_STROKE_LENGTH_MAX,
    default: 0.04,
    step: MINIMUM_STROKE_LENGTH_STEP,
  }),
} satisfies Record<FlowingContoursControlName, NumberParamSpec>)

/** Frozen defaults derived from the declarations presented to artists. */
export const defaultFlowingContoursControls: Readonly<FlowingContoursControls> =
  Object.freeze({
    gamma: flowingContoursControlSchema.gamma.default,
    contrast: flowingContoursControlSchema.contrast.default,
    pivot: flowingContoursControlSchema.pivot.default,
    curveDetail: flowingContoursControlSchema.curveDetail.default,
    continuity: flowingContoursControlSchema.continuity.default,
    flowSmoothing: flowingContoursControlSchema.flowSmoothing.default,
    minimumStrokeLength:
      flowingContoursControlSchema.minimumStrokeLength.default,
  })

/** Untrusted persistence and API boundaries may supply malformed values. */
export type FlowingContoursControlInput = Readonly<
  Partial<Record<FlowingContoursControlName, unknown>>
>

function boundedControl(
  name: FlowingContoursControlName,
  value: unknown,
): number {
  const spec = flowingContoursControlSchema[name]
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return spec.default
  }
  return Math.min(spec.max, Math.max(spec.min, value))
}

/**
 * Resolve partial or untrusted controls to one immutable, finite snapshot.
 *
 * Missing, malformed, and non-finite values take their own declared default.
 * Finite values clamp independently to their own schema bounds.
 */
export function normalizeFlowingContoursControls(
  controls: FlowingContoursControlInput | null =
    defaultFlowingContoursControls,
): Readonly<FlowingContoursControls> {
  const source = controls ?? {}
  return Object.freeze({
    gamma: boundedControl('gamma', source.gamma),
    contrast: boundedControl('contrast', source.contrast),
    pivot: boundedControl('pivot', source.pivot),
    curveDetail: boundedControl('curveDetail', source.curveDetail),
    continuity: boundedControl('continuity', source.continuity),
    flowSmoothing: boundedControl('flowSmoothing', source.flowSmoothing),
    minimumStrokeLength: boundedControl(
      'minimumStrokeLength',
      source.minimumStrokeLength,
    ),
  })
}

/** Prepared per-sample transform for one normalized Flowing Contours snapshot. */
export type FlowingContoursToneTransform = (luminance: number) => number

function clampUnit(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0
  if (value >= 1) return 1
  return value
}

/**
 * Prepare Flowing Contours' independent gamma-then-pivoted-contrast transform.
 *
 * The established pure curve mappings are reused, while this sketch owns its
 * schema, defaults, normalized snapshot, and application point.
 */
export function createNormalizedFlowingContoursToneTransform(
  controls: Readonly<FlowingContoursControls>,
): FlowingContoursToneTransform {
  const gammaExponent = toneGammaExponent(controls.gamma)
  const contrastGain = toneContrastGain(controls.contrast)
  return (luminance) => {
    const bounded = clampUnit(luminance)
    const gammaAdjusted =
      controls.gamma === UNIT_CONTROL_DEFAULT
        ? bounded
        : clampUnit(bounded ** gammaExponent)
    if (controls.contrast === UNIT_CONTROL_DEFAULT) return gammaAdjusted
    if (gammaAdjusted === 0) return 0
    return clampUnit(
      controls.pivot +
        (gammaAdjusted - controls.pivot) * contrastGain,
    )
  }
}
