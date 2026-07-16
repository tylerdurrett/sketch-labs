/**
 * Deterministic analytic source model for Tone Calibration.
 *
 * The target deliberately contains only two fixed, frame-relative tone ramps:
 * a full-frame vertical background and a centered circular inverse ramp. The
 * circle hard-overwrites the background, including at its boundary, so later
 * Shading Strategies can be judged against a simple target without blending,
 * feathering, authored guide geometry, or procedural variation. Permission is
 * fully open everywhere; mask behavior is intentionally absent from this
 * calibration case.
 */

import type { CoordinateSpace } from '../../scene'
import {
  createShadingMask,
  createToneField,
  type ToneSource,
} from '../../shadingFields'
import type { Point } from '../../types'

export interface ToneCalibrationCircle {
  readonly center: Readonly<Point>
  readonly radius: number
  readonly diameter: number
}

export interface ToneCalibrationLayout {
  readonly frame: Readonly<CoordinateSpace>
  readonly circle: ToneCalibrationCircle
}

export interface ToneCalibrationSource extends ToneSource {
  readonly layout: ToneCalibrationLayout
}

function assertFrame(frame: CoordinateSpace): void {
  if (
    !Number.isFinite(frame.width) ||
    !Number.isFinite(frame.height) ||
    frame.width <= 0 ||
    frame.height <= 0
  ) {
    throw new Error(
      `createToneCalibrationLayout: frame must have finite positive dimensions, got ${frame.width} × ${frame.height}`,
    )
  }
}

/** Build the fixed, deeply immutable layout for one Composition Frame. */
export function createToneCalibrationLayout(
  frame: CoordinateSpace,
): ToneCalibrationLayout {
  assertFrame(frame)

  const diameter = Math.min(frame.width, frame.height) * 0.8
  const center = Object.freeze([frame.width / 2, frame.height / 2] as const)
  const circle = Object.freeze({
    center,
    radius: diameter / 2,
    diameter,
  })

  return Object.freeze({
    frame: Object.freeze({ width: frame.width, height: frame.height }),
    circle,
  })
}

/** Create the fixed Tone Calibration target and fully permissive mask. */
export function createToneCalibrationSource(
  frame: CoordinateSpace,
): ToneCalibrationSource {
  const layout = createToneCalibrationLayout(frame)
  const { circle } = layout
  const circleBottom = circle.center[1] + circle.radius

  const toneField = createToneField((point) => {
    const dx = point[0] - circle.center[0]
    const dy = point[1] - circle.center[1]
    const insideCircle = dx * dx + dy * dy <= circle.radius * circle.radius

    return insideCircle
      ? (circleBottom - point[1]) / circle.diameter
      : point[1] / layout.frame.height
  })
  const shadingMask = createShadingMask(() => 1)

  return Object.freeze({ layout, toneField, shadingMask })
}
