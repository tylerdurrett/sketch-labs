/**
 * Independent artist-facing controls for Flowing Contours.
 *
 * These declarations belong only to the whole-curve search and fitting
 * pipeline. They deliberately do not reuse Pencil Contour or Watercolor Forms
 * controls: similarly named ideas must remain independently tunable while the
 * three sketches explore different representations.
 */

import type { NumberParamSpec } from '../../sketch'

/** The authored controls consumed by the headless Flowing Contours pipeline. */
export interface FlowingContoursControls {
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
const UNIT_CONTROL_STEP = 0.01

const MINIMUM_STROKE_LENGTH_MIN = 0.005
const MINIMUM_STROKE_LENGTH_MAX = 0.25
const MINIMUM_STROKE_LENGTH_STEP = 0.005

/**
 * Public declarations in their authored display and serialization order.
 *
 * Defaults are initial policy values. A later evidence-backed calibration may
 * tune them without changing the meaning or independence of the four controls.
 */
export const flowingContoursControlSchema = Object.freeze({
  curveDetail: Object.freeze({
    kind: 'number',
    min: UNIT_CONTROL_MIN,
    max: UNIT_CONTROL_MAX,
    default: 0.45,
    step: UNIT_CONTROL_STEP,
  }),
  continuity: Object.freeze({
    kind: 'number',
    min: UNIT_CONTROL_MIN,
    max: UNIT_CONTROL_MAX,
    default: 0.45,
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
    curveDetail: boundedControl('curveDetail', source.curveDetail),
    continuity: boundedControl('continuity', source.continuity),
    flowSmoothing: boundedControl('flowSmoothing', source.flowSmoothing),
    minimumStrokeLength: boundedControl(
      'minimumStrokeLength',
      source.minimumStrokeLength,
    ),
  })
}
