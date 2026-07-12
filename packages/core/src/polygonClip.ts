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

interface Bounds {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

interface PreparedEdge {
  c: Point
  d: Point
  bounds: Bounds
}

/** Cached broad-phase data for a polygon used by multiple clipping calls. */
export interface PreparedPolygon {
  polygon: Polyline
  /** Exact vertex bounds, used only to reject point-in-polygon tests. */
  bounds: Bounds | null
  /** Union of tolerant edge bounds, used to reject intersection tests. */
  intersectionBounds: Bounds | null
  edges: PreparedEdge[]
}

function coordinateRoundoff(...values: number[]): number {
  let scale = 1
  for (const value of values) scale = Math.max(scale, Math.abs(value))
  return Number.EPSILON * scale * 4
}

/**
 * Bounds of the portion of A->B accepted by segmentCrossParam's endpoint
 * tolerance. The coordinate-scaled term keeps the filter conservative across
 * the final floating-point rounding of the bound itself.
 */
function tolerantSegmentBounds(a: Point, b: Point): Bounds {
  const roundoff = coordinateRoundoff(a[0], a[1], b[0], b[1])
  const padX = EPS * Math.abs(b[0] - a[0]) + roundoff
  const padY = EPS * Math.abs(b[1] - a[1]) + roundoff
  return {
    minX: Math.min(a[0], b[0]) - padX,
    minY: Math.min(a[1], b[1]) - padY,
    maxX: Math.max(a[0], b[0]) + padX,
    maxY: Math.max(a[1], b[1]) + padY,
  }
}

function boundsOverlap(a: Bounds, b: Bounds): boolean {
  return (
    a.minX <= b.maxX &&
    a.maxX >= b.minX &&
    a.minY <= b.maxY &&
    a.maxY >= b.minY
  )
}

function boundsContain(bounds: Bounds, p: Point): boolean {
  return (
    p[0] >= bounds.minX &&
    p[0] <= bounds.maxX &&
    p[1] >= bounds.minY &&
    p[1] <= bounds.maxY
  )
}

/** Prepare immutable lookup data without copying or mutating polygon points. */
export function preparePolygon(polygon: Polyline): PreparedPolygon {
  if (polygon.length === 0) {
    return { polygon, bounds: null, intersectionBounds: null, edges: [] }
  }

  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  let intersectionMinX = Infinity
  let intersectionMinY = Infinity
  let intersectionMaxX = -Infinity
  let intersectionMaxY = -Infinity
  const edges: PreparedEdge[] = []
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const d = polygon[i]!
    const c = polygon[j]!
    if (d[0] < minX) minX = d[0]
    if (d[0] > maxX) maxX = d[0]
    if (d[1] < minY) minY = d[1]
    if (d[1] > maxY) maxY = d[1]
    const edgeBounds = tolerantSegmentBounds(c, d)
    if (edgeBounds.minX < intersectionMinX) intersectionMinX = edgeBounds.minX
    if (edgeBounds.minY < intersectionMinY) intersectionMinY = edgeBounds.minY
    if (edgeBounds.maxX > intersectionMaxX) intersectionMaxX = edgeBounds.maxX
    if (edgeBounds.maxY > intersectionMaxY) intersectionMaxY = edgeBounds.maxY
    edges.push({ c, d, bounds: edgeBounds })
  }
  return {
    polygon,
    bounds: { minX, minY, maxX, maxY },
    intersectionBounds: {
      minX: intersectionMinX,
      minY: intersectionMinY,
      maxX: intersectionMaxX,
      maxY: intersectionMaxY,
    },
    edges,
  }
}

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
function insideAny(p: Point, polygons: PreparedPolygon[]): boolean {
  for (const prepared of polygons) {
    if (
      prepared.bounds !== null &&
      boundsContain(prepared.bounds, p) &&
      pointInPolygon(p, prepared.polygon)
    ) {
      return true
    }
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
  return subtractPreparedPolygonsFromPolyline(
    polyline,
    polygons.map(preparePolygon),
  )
}

/**
 * Prepared variant for callers that reuse the same occluder polygons across
 * multiple outlines. Geometry and output ordering are identical to
 * subtractPolygonsFromPolyline; only provably disjoint intersection and
 * point-in-polygon work is skipped.
 */
export function subtractPreparedPolygonsFromPolyline(
  polyline: Polyline,
  polygons: PreparedPolygon[],
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

    // Skip zero-length input segments (coincident consecutive points). Otherwise
    // the split params degenerate to [0, 1] with no crossings, and the loop below
    // would build `[lerp(a,b,0), lerp(a,b,1)] = [a, a]` — a zero-length open
    // polyline — and, mid-`current`, push a duplicate coincident point. `current`
    // is intentionally left untouched so a contiguous run stays stitched across
    // the duplicate rather than being split by it.
    if (vec.dist(a, b) <= EPS) continue

    // Collect split parameters along this segment: endpoints + every crossing.
    const ts: number[] = [0, 1]
    const segmentBounds = tolerantSegmentBounds(a, b)
    for (const prepared of polygons) {
      if (
        prepared.intersectionBounds === null ||
        !boundsOverlap(segmentBounds, prepared.intersectionBounds)
      ) {
        continue
      }
      for (const edge of prepared.edges) {
        if (!boundsOverlap(segmentBounds, edge.bounds)) continue
        const t = segmentCrossParam(a, b, edge.c, edge.d)
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
