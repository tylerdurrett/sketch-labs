import type { CoordinateSpace } from '../scene'
import { sampleShadingMask, type ShadingMask } from '../shadingFields'
import type { Point, Polyline } from '../types'

function assertValidMaxSpacing(maxSpacing: number): void {
  if (!Number.isFinite(maxSpacing) || maxSpacing <= 0) {
    throw new RangeError('maxSpacing must be finite and positive')
  }
}

function isPermittedSample(
  mask: ShadingMask,
  frame: CoordinateSpace,
  point: Readonly<Point>,
): boolean {
  const [x, y] = point

  return (
    x >= 0 &&
    x <= frame.width &&
    y >= 0 &&
    y <= frame.height &&
    sampleShadingMask(mask, point) !== 0
  )
}

/**
 * Check a segment against a mask at a declared maximum sample spacing.
 *
 * The segment is split into `ceil(length / maxSpacing)` equal intervals. Both
 * endpoints and every interval boundary must be inside the inclusive Composition
 * Frame and have non-zero permission. A zero-length segment samples its point
 * once. This is a deterministic working-resolution check, not an analytic proof
 * over every point of an arbitrary mask.
 */
export function isMaskPermittedSegment(
  mask: ShadingMask,
  frame: CoordinateSpace,
  start: Readonly<Point>,
  end: Readonly<Point>,
  maxSpacing: number,
): boolean {
  assertValidMaxSpacing(maxSpacing)

  const deltaX = end[0] - start[0]
  const deltaY = end[1] - start[1]
  const length = Math.hypot(deltaX, deltaY)

  if (!Number.isFinite(length)) return false

  const intervalCount = Math.ceil(length / maxSpacing)
  if (!Number.isSafeInteger(intervalCount)) {
    throw new RangeError('maxSpacing produces an unsafe interval count')
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

/** Check every segment in a non-empty polyline at one explicit resolution. */
export function isMaskPermittedPolyline(
  mask: ShadingMask,
  frame: CoordinateSpace,
  polyline: Readonly<Polyline>,
  maxSpacing: number,
): boolean {
  assertValidMaxSpacing(maxSpacing)

  if (polyline.length === 0) return false
  if (polyline.length === 1) {
    const point = polyline[0]!
    return isMaskPermittedSegment(mask, frame, point, point, maxSpacing)
  }

  for (let index = 1; index < polyline.length; index++) {
    if (
      !isMaskPermittedSegment(
        mask,
        frame,
        polyline[index - 1]!,
        polyline[index]!,
        maxSpacing,
      )
    ) {
      return false
    }
  }

  return true
}
