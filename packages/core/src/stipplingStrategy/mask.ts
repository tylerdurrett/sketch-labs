import type { CoordinateSpace } from '../scene'
import { sampleShadingMask, type ShadingMask } from '../shadingFields'
import type { Point } from '../types'

const MAX_STIPPLE_MASK_INTERVALS = 1_000_000

function assertValidMaxSpacing(maxSpacing: number): void {
  if (!Number.isFinite(maxSpacing) || maxSpacing <= 0) {
    throw new RangeError('maxSpacing must be finite and positive')
  }
}

function isFinitePoint(point: Readonly<Point>): boolean {
  return Number.isFinite(point[0]) && Number.isFinite(point[1])
}

function isPermittedSample(
  mask: ShadingMask,
  frame: CoordinateSpace,
  point: Readonly<Point>,
): boolean {
  const [x, y] = point

  return (
    isFinitePoint(point) &&
    x >= 0 &&
    x <= frame.width &&
    y >= 0 &&
    y <= frame.height &&
    sampleShadingMask(mask, point) !== 0
  )
}

/**
 * Validate one two-point Stipple against a Shading Mask at a declared spacing.
 *
 * The segment is split into `ceil(length / maxSpacing)` equal intervals. Both
 * endpoints and every interval boundary must be finite, inside the inclusive
 * Composition Frame, and have non-zero permission. Soft positive permission is
 * therefore allowed while an exact zero remains a hard prohibition. This is a
 * deterministic working-resolution check rather than an analytic proof over
 * every point of an arbitrary mask.
 */
export function isMaskPermittedStipple(
  mask: ShadingMask,
  frame: CoordinateSpace,
  start: Readonly<Point>,
  end: Readonly<Point>,
  maxSpacing: number,
): boolean {
  assertValidMaxSpacing(maxSpacing)

  if (!isFinitePoint(start) || !isFinitePoint(end)) return false

  const deltaX = end[0] - start[0]
  const deltaY = end[1] - start[1]
  const length = Math.hypot(deltaX, deltaY)

  if (!Number.isFinite(length)) return false

  const intervalCount = Math.ceil(length / maxSpacing)
  if (!Number.isSafeInteger(intervalCount)) {
    throw new RangeError('maxSpacing produces an unsafe interval count')
  }
  if (intervalCount > MAX_STIPPLE_MASK_INTERVALS) {
    throw new RangeError('maxSpacing exceeds the Stipple mask interval limit')
  }

  if (intervalCount === 0) return isPermittedSample(mask, frame, start)

  for (let interval = 0; interval <= intervalCount; interval++) {
    let point: Readonly<Point>
    if (interval === 0) point = start
    else if (interval === intervalCount) point = end
    else {
      const progress = interval / intervalCount
      point = [start[0] + deltaX * progress, start[1] + deltaY * progress]
    }

    if (!isPermittedSample(mask, frame, point)) return false
  }

  return true
}
