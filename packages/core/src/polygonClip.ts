import { vec } from './vec'
import type { Point, Polyline } from './types'

/**
 * Arbitrary-polygon clip geometry: subtract fill polygons from a polyline.
 *
 * `subtractPolygonsFromPolyline` computes `polyline - polygon(s)`, returning the
 * sub-polylines that lie OUTSIDE every polygon. Unlike the box-only
 * `clipPolylinesToBox` (see `clip.ts`), the clip regions here are arbitrary
 * polygons — including CONCAVE ones (a leaf silhouette is not convex).
 *
 * Algorithm
 * ---------
 * 1. Each polyline segment is split at every point where it crosses a polygon
 *    edge (segment-vs-segment intersection).
 * 2. Each resulting sub-segment is classified by its MIDPOINT: if the midpoint
 *    is inside ANY polygon it is dropped, otherwise it is kept (union removal —
 *    a portion inside any polygon disappears).
 * 3. Inside-tests use even-odd ray casting, which is correct for concave and
 *    self-touching polygons alike.
 * 4. Contiguous kept sub-segments are stitched back into open polylines.
 *
 * Polygons may be supplied open or closed (last point == first); the ray-cast
 * and edge walk both treat the vertex ring as implicitly closed, so a repeated
 * closing vertex is harmless (it contributes a degenerate, ignored edge).
 *
 * Tolerance / edge-case policy (EPS = 1e-9, in coordinate units)
 * -------------------------------------------------------------
 * - Intersection parameters within EPS of a segment endpoint are clamped to
 *   [0, 1]; split points closer than EPS along a segment are merged, so
 *   vertex-grazing crossings do not spawn zero-length slivers.
 * - COLLINEAR / boundary-overlapping segments (a polyline running exactly along
 *   a polygon edge) are treated as NON-crossing: parallel intersections are
 *   ignored and classification falls to the midpoint inside-test. We do not
 *   attempt exact boundary-overlap handling.
 * - Even-odd ray casting uses the standard half-open rule
 *   `(yi > y) !== (yj > y)`, so a point lying exactly on the boundary is
 *   classified deterministically but arbitrarily. Because classification is
 *   done on sub-segment midpoints (which are off-boundary except in degenerate
 *   collinear cases), this arbitrariness does not affect normal output.
 *
 * This module is PURE GEOMETRY: no Scene, no renderer, no leaf-domain knowledge.
 */

const EPS = 1e-9

/** 2D scalar cross product: a.x*b.y - a.y*b.x */
function cross2(a: Point, b: Point): number {
  return a[0] * b[1] - a[1] * b[0]
}

/**
 * Even-odd ray-cast point-in-polygon test. Correct for concave polygons.
 * Treats the vertex ring as implicitly closed (wrap edge from last to first).
 */
export function pointInPolygon(p: Point, polygon: Polyline): boolean {
  const n = polygon.length
  if (n < 3) return false
  let inside = false
  const [px, py] = p
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const [xi, yi] = polygon[i]!
    const [xj, yj] = polygon[j]!
    const straddles = yi > py !== yj > py
    if (straddles && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) {
      inside = !inside
    }
  }
  return inside
}

/** True if `p` is inside ANY of the polygons (union). */
function insideAny(p: Point, polygons: Polyline[]): boolean {
  for (const poly of polygons) {
    if (pointInPolygon(p, poly)) return true
  }
  return false
}

/**
 * Parameter t in [0, 1] along segment A->B where it crosses segment C->D, or
 * null when they do not cross (or are parallel/collinear — see policy above).
 */
function segmentCrossParam(
  a: Point,
  b: Point,
  c: Point,
  d: Point,
): number | null {
  const r = vec.sub(b, a)
  const s = vec.sub(d, c)
  const denom = cross2(r, s)
  if (Math.abs(denom) < EPS) return null // parallel or collinear — ignored
  const qp = vec.sub(c, a)
  const t = cross2(qp, s) / denom
  const u = cross2(qp, r) / denom
  if (t < -EPS || t > 1 + EPS || u < -EPS || u > 1 + EPS) return null
  return Math.min(1, Math.max(0, t))
}

/**
 * Subtract one or more fill polygons from a polyline.
 *
 * Returns zero or more OPEN polylines: the portions of `polyline` that lie
 * outside EVERY polygon. A polyline fully inside a polygon yields `[]`; one
 * fully outside passes through intact; one crossing a boundary is split at the
 * intersection points with the inside portions removed. Subtracting multiple
 * polygons removes the union of their interiors.
 *
 * The input polyline may be open or closed; it is treated as a sequence of
 * segments either way (a closed polyline simply has a final segment back to its
 * start). Input points are never mutated.
 */
export function subtractPolygonsFromPolyline(
  polyline: Polyline,
  polygons: Polyline[],
): Polyline[] {
  if (polyline.length < 2) return []
  if (polygons.length === 0) return [polyline.map((p) => [p[0], p[1]] as Point)]

  const output: Polyline[] = []
  let current: Polyline | null = null

  const flush = () => {
    if (current && current.length >= 2) output.push(current)
    current = null
  }

  for (let i = 0; i < polyline.length - 1; i++) {
    const a = polyline[i]!
    const b = polyline[i + 1]!

    // Collect split parameters along this segment: endpoints + every crossing.
    const ts: number[] = [0, 1]
    for (const poly of polygons) {
      const n = poly.length
      for (let k = 0, m = n - 1; k < n; m = k++) {
        const t = segmentCrossParam(a, b, poly[m]!, poly[k]!)
        if (t !== null) ts.push(t)
      }
    }

    // Sort and merge near-duplicate split points.
    ts.sort((x, y) => x - y)
    const cuts: number[] = []
    for (const t of ts) {
      if (cuts.length === 0 || t - cuts[cuts.length - 1]! > EPS) cuts.push(t)
    }

    // Build sub-segments between consecutive cuts; classify by midpoint.
    for (let s = 0; s < cuts.length - 1; s++) {
      const t0 = cuts[s]!
      const t1 = cuts[s + 1]!
      const p1 = vec.lerp(a, b, t1)
      const mid = vec.lerp(a, b, (t0 + t1) / 2)
      if (insideAny(mid, polygons)) {
        flush()
      } else if (current === null) {
        current = [vec.lerp(a, b, t0), p1]
      } else {
        current.push(p1)
      }
    }
  }

  flush()
  return output
}
