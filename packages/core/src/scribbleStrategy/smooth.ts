import type { CoordinateSpace } from '../scene'
import type { ShadingMask } from '../shadingFields'
import type { Point, Polyline } from '../types'
import { isMaskPermittedPolyline } from './mask'

const SMOOTHING_PASSES = 2

type ScribbleSegmentSafety = (
  start: Readonly<Point>,
  end: Readonly<Point>,
) => boolean

function interpolate(
  start: Readonly<Point>,
  end: Readonly<Point>,
  endWeight: number,
): Point {
  return [
    start[0] + (end[0] - start[0]) * endWeight,
    start[1] + (end[1] - start[1]) * endWeight,
  ]
}

/** One endpoint-preserving Chaikin corner-cutting pass. */
function smoothOnce(polyline: Readonly<Polyline>): Polyline {
  if (polyline.length < 3) {
    return polyline.map(([x, y]) => [x, y])
  }

  const first = polyline[0]!
  const smoothed: Polyline = [[first[0], first[1]]]

  for (let index = 1; index < polyline.length; index++) {
    const start = polyline[index - 1]!
    const end = polyline[index]!
    smoothed.push(interpolate(start, end, 0.25))
    smoothed.push(interpolate(start, end, 0.75))
  }

  const last = polyline[polyline.length - 1]!
  smoothed.push([last[0], last[1]])
  return smoothed
}

function isPolylineSegmentSafe(
  polyline: Readonly<Polyline>,
  isSegmentSafe: ScribbleSegmentSafety,
): boolean {
  for (let index = 1; index < polyline.length; index++) {
    if (!isSegmentSafe(polyline[index - 1]!, polyline[index]!)) return false
  }

  return true
}

/**
 * Refine solver polylines into visibly curved, plotter-ready geometry.
 *
 * Corner cutting stays inside the solver segment neighborhood, which is much
 * smaller than its virtual-coverage footprint. Every pass is nevertheless
 * checked against the same hard-mask resolution as growth; if a rounded corner
 * would enter forbidden space, that path keeps its last safe representation.
 */
export function smoothScribblePolylines(
  polylines: readonly Polyline[],
  mask: ShadingMask,
  frame: CoordinateSpace,
  maskCheckSpacing: number,
): Polyline[] {
  return polylines.map((polyline) => {
    let safe = polyline

    for (let pass = 0; pass < SMOOTHING_PASSES; pass++) {
      const candidate = smoothOnce(safe)
      if (
        !isMaskPermittedPolyline(mask, frame, candidate, maskCheckSpacing)
      ) {
        break
      }
      safe = candidate
    }

    return safe
  })
}

/**
 * Refine field-aware paths while preserving the last representation accepted
 * by the model's shared scale, frame, and mask predicate.
 *
 * Kept separate from {@link smoothScribblePolylines} so runs without a field
 * retain their established mask traversal and arithmetic exactly.
 */
export function smoothScaleFieldScribblePolylines(
  polylines: readonly Polyline[],
  isSegmentSafe: ScribbleSegmentSafety,
): Polyline[] {
  let safe = polylines.map((polyline) => polyline)

  for (let pass = 0; pass < SMOOTHING_PASSES; pass++) {
    const candidate = safe.map(smoothOnce)
    if (
      !candidate.every((polyline) =>
        isPolylineSegmentSafe(polyline, isSegmentSafe),
      )
    ) {
      break
    }
    safe = candidate
  }

  return safe
}
