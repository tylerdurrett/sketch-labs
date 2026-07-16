/**
 * Grass Hills' faithful production Outline source.
 *
 * Outline starts from the exact sampled Fill Scene: the same hill rings and
 * seven-point tapered blade silhouettes, in the same painter order and with the
 * same authored closure metadata. Every primitive is both a contour source and
 * an occluder, so the generic indexed Hidden-line pass reproduces painter
 * visibility without any Grass-specific reconstruction or density reduction.
 *
 * The physical target affects only the stroke style of the processed output.
 * It never selects roots or changes geometry. Dense source generation remains
 * behind the optional `generateOutlineSource` worker hook used by Studio.
 */

import type { OutlineTarget } from '../../sketch'
import type { Primitive, Scene } from '../../scene'

/** The default physical fineliner width pinned by the production plot profile. */
export const GRASS_HILLS_TOOL_WIDTH_MILLIMETERS = 0.3

const OUTLINE_COLOR = '#111111'

/**
 * Clone a sampled Fill Scene into its role-annotated Hidden-line source.
 *
 * Geometry, closure, primitive count, and painter order are deliberately copied
 * without interpretation. Retaining each fill lets every later hill or blade
 * occlude every earlier contour exactly as it does in the Fill renderer.
 */
export function grassHillsOutlineSource(
  fill: Scene,
  target: OutlineTarget,
): Scene {
  validateGrassHillsOutlineTarget(target)
  const toolWidthSceneUnits =
    target.toolWidthMillimeters / target.millimetersPerSceneUnit

  return {
    space: { width: fill.space.width, height: fill.space.height },
    primitives: fill.primitives.map(
      (primitive): Primitive => ({
        points: primitive.points.map(([x, y]) => [x, y]),
        ...(primitive.closed === undefined
          ? {}
          : { closed: primitive.closed }),
        ...(primitive.fill === undefined
          ? {}
          : { fill: { ...primitive.fill } }),
        stroke: { color: OUTLINE_COLOR, width: toolWidthSceneUnits },
        hiddenLineRole: 'both',
      }),
    ),
    ...(fill.background === undefined
      ? {}
      : { background: { ...fill.background } }),
  }
}

export function validateGrassHillsOutlineTarget(target: OutlineTarget): void {
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
