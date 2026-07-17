import type { CoordinateSpace } from '../scene'
import type { ShadingMask } from '../shadingFields'
import type { Point, Polyline } from '../types'
import { isMaskPermittedPolyline } from './mask'

const SMOOTHING_PASSES = 2

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
