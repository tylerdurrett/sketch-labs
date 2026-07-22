/**
 * Tone Calibration's completed-artwork Outline source.
 *
 * Shading preparation is authoritative: Outline only clones the exact paths
 * that preparation completed and applies the active physical tool width. It
 * never samples the analytic Tone reference or generates replacement geometry.
 */

import type { Primitive, Scene } from '../../scene'
import type { OutlineTarget } from '../../sketch'

const OUTLINE_COLOR = 'black'

/** Restyle an exact completed Tone Calibration Scene for Hidden-line output. */
export function toneCalibrationOutlineSource(
  completedScene: Readonly<Scene>,
  target: OutlineTarget,
): Scene {
  validateToneCalibrationOutlineTarget(target)
  const strokeWidth =
    target.toolWidthMillimeters / target.millimetersPerSceneUnit

  return {
    space: {
      width: completedScene.space.width,
      height: completedScene.space.height,
    },
    primitives: completedScene.primitives.map(
      (primitive): Primitive => ({
        points: primitive.points.map(([x, y]) => [x, y]),
        ...(primitive.closed === undefined
          ? {}
          : { closed: primitive.closed }),
        stroke: {
          color: OUTLINE_COLOR,
          width: strokeWidth,
          ...(primitive.stroke?.lineCap === undefined
            ? {}
            : { lineCap: primitive.stroke.lineCap }),
        },
        hiddenLineRole: 'source',
      }),
    ),
  }
}

function validateToneCalibrationOutlineTarget(target: OutlineTarget): void {
  if (
    !Number.isFinite(target.toolWidthMillimeters) ||
    target.toolWidthMillimeters <= 0
  ) {
    throw new RangeError('toolWidthMillimeters must be finite and positive')
  }
  if (
    !Number.isFinite(target.millimetersPerSceneUnit) ||
    target.millimetersPerSceneUnit <= 0
  ) {
    throw new RangeError(
      'millimetersPerSceneUnit must be finite and positive',
    )
  }
}
