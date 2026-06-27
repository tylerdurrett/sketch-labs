import { clipPolyline } from 'lineclip'
import type { Polyline } from './types'

/** Axis-aligned bounding box as [minX, minY, maxX, maxY] */
export type BBox = [number, number, number, number]

/**
 * Clip an array of polylines to a rectangular bounding box.
 *
 * Each input polyline may produce zero, one, or multiple output segments
 * depending on how it intersects the box boundary. Uses the Cohen-Sutherland
 * algorithm via the `lineclip` package.
 */
export function clipPolylinesToBox(
  lines: Polyline[],
  bounds: BBox,
): Polyline[] {
  const result: Polyline[] = []
  for (const line of lines) {
    const clipped = clipPolyline(line, bounds)
    for (const segment of clipped) {
      result.push(segment)
    }
  }
  return result
}
