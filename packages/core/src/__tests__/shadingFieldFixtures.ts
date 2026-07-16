import {
  createShadingMask,
  createToneField,
  type ShadingMask,
  type ToneField,
} from '../shadingFields'
import type { CoordinateSpace } from '../scene'

function normalizedPoint(
  frame: CoordinateSpace,
  [x, y]: readonly [number, number],
): readonly [number, number] {
  return [x / frame.width, y / frame.height]
}

function distance(
  [x1, y1]: readonly [number, number],
  [x2, y2]: readonly [number, number],
): number {
  return Math.hypot(x2 - x1, y2 - y1)
}

/** A uniform analytic darkness fixture. */
export function constantTone(value: number): ToneField {
  return createToneField(() => value)
}

/** A paper-to-darkness gradient across the Composition Frame's width. */
export function horizontalGradientTone(frame: CoordinateSpace): ToneField {
  return createToneField((point) => normalizedPoint(frame, point)[0])
}

/** A dark field with a circular exact-white hole at its normalized center. */
export function whiteHoleTone(frame: CoordinateSpace): ToneField {
  return createToneField((point) =>
    distance(normalizedPoint(frame, point), [0.5, 0.5]) <= 0.15 ? 0 : 0.8,
  )
}

/** A left-to-right permission boundary with a visible soft interval. */
export function featheredBoundaryMask(frame: CoordinateSpace): ShadingMask {
  return createShadingMask((point) => {
    const x = normalizedPoint(frame, point)[0]
    if (x <= 0.4) return 1
    if (x >= 0.6) return 0
    return (0.6 - x) / 0.2
  })
}

/** Two separated circular regions of full permission. */
export function disconnectedIslandsMask(frame: CoordinateSpace): ShadingMask {
  return createShadingMask((point) => {
    const normalized = normalizedPoint(frame, point)
    return distance(normalized, [0.25, 0.5]) <= 0.14 ||
      distance(normalized, [0.75, 0.5]) <= 0.14
      ? 1
      : 0
  })
}

/** Full permission except for a narrow, exact-zero vertical barrier. */
export function thinZeroBarrierMask(frame: CoordinateSpace): ShadingMask {
  return createShadingMask((point) => {
    const x = normalizedPoint(frame, point)[0]
    return Math.abs(x - 0.5) <= 0.01 ? 0 : 1
  })
}
