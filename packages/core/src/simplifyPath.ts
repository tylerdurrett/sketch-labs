import type { Point, Polyline } from './types'

/**
 * Perpendicular distance from a point to the segment (a, b).
 *
 * Degenerate zero-length segments (a and b coincide) fall back to the
 * plain point-to-point distance from `p` to `a`.
 */
function perpendicularDistance(p: Point, a: Point, b: Point): number {
  const dx = b[0] - a[0]
  const dy = b[1] - a[1]
  const lengthSq = dx * dx + dy * dy
  if (lengthSq === 0) {
    // Zero-length segment: distance to the shared endpoint.
    const px = p[0] - a[0]
    const py = p[1] - a[1]
    return Math.hypot(px, py)
  }
  // Perpendicular distance = |cross(b - a, p - a)| / |b - a|.
  const cross = dx * (p[1] - a[1]) - dy * (p[0] - a[0])
  return Math.abs(cross) / Math.sqrt(lengthSq)
}

/**
 * Simplify a polyline with the Douglas–Peucker algorithm.
 *
 * Recursively keeps the two endpoints, finds the intermediate vertex with the
 * greatest perpendicular distance from the current chord, and keeps it (and
 * recurses on both halves) when that distance exceeds `tolerance`; otherwise it
 * drops every intermediate vertex. Larger tolerances yield more aggressive
 * reduction, while endpoints and sharp corners well off the chord survive.
 *
 * Pure: never mutates the input array or its point tuples.
 *
 * A `tolerance` of 0 is a no-op and returns the input array by reference.
 * Degenerate paths (0, 1, or 2 points) pass through unchanged by reference.
 */
export function simplifyPath(points: Polyline, tolerance: number): Polyline {
  // Tolerance 0 is a no-op; return the same reference (identity).
  if (tolerance === 0) return points
  // Nothing to simplify: no interior vertices to drop.
  if (points.length <= 2) return points

  const keep = new Array<boolean>(points.length).fill(false)
  keep[0] = true
  keep[points.length - 1] = true

  // Iterative stack of [start, end] index pairs to avoid recursion limits.
  const stack: Array<[number, number]> = [[0, points.length - 1]]
  while (stack.length > 0) {
    const [start, end] = stack.pop() as [number, number]
    const a = points[start] as Point
    const b = points[end] as Point
    let maxDist = 0
    let maxIndex = -1
    for (let i = start + 1; i < end; i++) {
      const dist = perpendicularDistance(points[i] as Point, a, b)
      if (dist > maxDist) {
        maxDist = dist
        maxIndex = i
      }
    }
    if (maxIndex !== -1 && maxDist > tolerance) {
      keep[maxIndex] = true
      stack.push([start, maxIndex])
      stack.push([maxIndex, end])
    }
  }

  const result: Polyline = []
  for (let i = 0; i < points.length; i++) {
    if (keep[i]) result.push(points[i] as Point)
  }
  return result
}
