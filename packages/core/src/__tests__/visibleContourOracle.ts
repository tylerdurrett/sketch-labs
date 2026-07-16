/**
 * Test-only visible-contour fidelity oracle.
 *
 * This deliberately re-derives the answer from Scene geometry. It must remain
 * independent of the production hidden-line pass, polygon clipping helpers,
 * spatial planner/index, sketch-specific outline code, and benchmark
 * prototypes. Otherwise a production bug could teach its own test oracle what
 * to accept.
 *
 * At exact (zero-tolerance) fidelity, the oracle:
 *  1. treats every filled path as an implicitly closed polygon,
 *  2. clips only its authored boundary segments to the Composition Frame,
 *  3. splits those segments at every nearer filled-polygon edge,
 *  4. removes atomic intervals covered by a nearer fill, and
 *  5. compares the canonical interval union with the Outline Scene in both
 *     directions (missing Fill contours and extra Outline geometry).
 *
 * The exact final Composition Frame path optionally appended by Studio is not
 * sketch geometry. Callers explicitly request its exclusion; only a matching
 * final primitive is then excluded, while an earlier frame-shaped path remains
 * ordinary Outline geometry.
 */

import type { Primitive, Scene } from '../scene'
import type { Point } from '../types'

export type ContourInterval = readonly [Point, Point]

export interface VisibleContourComparison {
  readonly matches: boolean
  /** Fill-visible contour intervals not covered by the Outline Scene. */
  readonly missing: readonly ContourInterval[]
  /** Outline intervals not covered by Fill-visible contours. */
  readonly extra: readonly ContourInterval[]
}

export interface OutlineContourOptions {
  /** Ignore an exact final Composition Frame path appended by the output profile. */
  readonly excludeCompositionFrame?: boolean
}

const ROUND_OFF_ULPS = 64

/** Scale-aware floating-point roundoff, not an authored geometry tolerance. */
function roundOff(...values: number[]): number {
  let scale = 1
  for (const value of values) scale = Math.max(scale, Math.abs(value))
  return Number.EPSILON * scale * ROUND_OFF_ULPS
}

function nearlyEqual(a: number, b: number, ...context: number[]): boolean {
  return Math.abs(a - b) <= roundOff(a, b, ...context)
}

function pointsEqual(a: Point, b: Point): boolean {
  return nearlyEqual(a[0], b[0]) && nearlyEqual(a[1], b[1])
}

function comparePoints(a: Point, b: Point): number {
  return nearlyEqual(a[0], b[0]) ? a[1] - b[1] : a[0] - b[0]
}

function crossIsZero(a: Point, b: Point, c: Point): boolean {
  const first = (b[0] - a[0]) * (c[1] - a[1])
  const second = (b[1] - a[1]) * (c[0] - a[0])
  return nearlyEqual(first, second)
}

function interpolate(a: Point, b: Point, t: number): Point {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]
}

function canonicalInterval(a: Point, b: Point): ContourInterval | null {
  if (pointsEqual(a, b)) return null
  const start: Point = [a[0], a[1]]
  const end: Point = [b[0], b[1]]
  return comparePoints(start, end) <= 0 ? [start, end] : [end, start]
}

function pointOnInterval(point: Point, interval: ContourInterval): boolean {
  const [start, end] = interval
  const xRoundOff = roundOff(point[0], start[0], end[0])
  const yRoundOff = roundOff(point[1], start[1], end[1])
  return (
    crossIsZero(start, end, point) &&
    point[0] >= Math.min(start[0], end[0]) - xRoundOff &&
    point[0] <= Math.max(start[0], end[0]) + xRoundOff &&
    point[1] >= Math.min(start[1], end[1]) - yRoundOff &&
    point[1] <= Math.max(start[1], end[1]) + yRoundOff
  )
}

function collinear(a: ContourInterval, b: ContourInterval): boolean {
  return crossIsZero(a[0], a[1], b[0]) && crossIsZero(a[0], a[1], b[1])
}

function mergeIntervals(
  a: ContourInterval,
  b: ContourInterval,
): ContourInterval | null {
  if (!collinear(a, b)) return null
  if (
    !pointOnInterval(a[0], b) &&
    !pointOnInterval(a[1], b) &&
    !pointOnInterval(b[0], a) &&
    !pointOnInterval(b[1], a)
  ) {
    return null
  }
  const points = [a[0], a[1], b[0], b[1]].sort(comparePoints)
  return [points[0]!, points[3]!]
}

/** Normalize direction, remove zero intervals, deduplicate, and join coverage. */
function canonicalize(
  intervals: readonly ContourInterval[],
): ContourInterval[] {
  const result: ContourInterval[] = []

  for (const interval of intervals) {
    let merged = canonicalInterval(interval[0], interval[1])
    if (merged === null) continue

    for (let index = result.length - 1; index >= 0; index--) {
      const combined = mergeIntervals(merged, result[index]!)
      if (combined === null) continue
      result.splice(index, 1)
      merged = combined
    }
    result.push(merged)
  }

  return result.sort(
    (a, b) => comparePoints(a[0], b[0]) || comparePoints(a[1], b[1]),
  )
}

/** Liang-Barsky clipping of one authored segment; no frame edges are invented. */
function clipIntervalToFrame(
  a: Point,
  b: Point,
  width: number,
  height: number,
): ContourInterval | null {
  const dx = b[0] - a[0]
  const dy = b[1] - a[1]
  let lower = 0
  let upper = 1

  const tests: ReadonlyArray<readonly [number, number]> = [
    [-dx, a[0]],
    [dx, width - a[0]],
    [-dy, a[1]],
    [dy, height - a[1]],
  ]
  for (const [p, q] of tests) {
    if (nearlyEqual(p, 0, dx, dy)) {
      if (q < -roundOff(q, width, height)) return null
      continue
    }
    const ratio = q / p
    if (p < 0) lower = Math.max(lower, ratio)
    else upper = Math.min(upper, ratio)
    if (lower > upper + roundOff(lower, upper)) return null
  }

  const clippedStart = interpolate(a, b, Math.max(0, Math.min(1, lower)))
  const clippedEnd = interpolate(a, b, Math.max(0, Math.min(1, upper)))
  const snapToFrame = ([x, y]: Point): Point => [
    nearlyEqual(x, 0, width) ? 0 : nearlyEqual(x, width) ? width : x,
    nearlyEqual(y, 0, height) ? 0 : nearlyEqual(y, height) ? height : y,
  ]
  return canonicalInterval(snapToFrame(clippedStart), snapToFrame(clippedEnd))
}

function polygonPoints(primitive: Primitive): Point[] {
  const points = primitive.points.map(([x, y]) => [x, y] as Point)
  while (
    points.length > 1 &&
    pointsEqual(points[0]!, points[points.length - 1]!)
  ) {
    points.pop()
  }
  return points
}

function polygonIntervals(points: readonly Point[]): ContourInterval[] {
  if (points.length < 2) return []
  const intervals: ContourInterval[] = []
  for (let index = 0; index < points.length; index++) {
    const interval = canonicalInterval(
      points[index]!,
      points[(index + 1) % points.length]!,
    )
    if (interval !== null) intervals.push(interval)
  }
  return intervals
}

function pointOnPolygonBoundary(point: Point, polygon: readonly Point[]): boolean {
  return polygonIntervals(polygon).some((edge) => pointOnInterval(point, edge))
}

/** Exact even-odd containment with polygon boundaries considered covered. */
function polygonCoversPoint(point: Point, polygon: readonly Point[]): boolean {
  if (polygon.length < 3) return false
  if (pointOnPolygonBoundary(point, polygon)) return true

  let inside = false
  const [px, py] = point
  for (let index = 0, previous = polygon.length - 1;
    index < polygon.length;
    previous = index++) {
    const [x, y] = polygon[index]!
    const [previousX, previousY] = polygon[previous]!
    if (
      (y > py) !== (previousY > py) &&
      px < ((previousX - x) * (py - y)) / (previousY - y) + x
    ) {
      inside = !inside
    }
  }
  return inside
}

function parameterOnSegment(a: Point, b: Point, point: Point): number {
  const dx = b[0] - a[0]
  const dy = b[1] - a[1]
  return Math.abs(dx) >= Math.abs(dy)
    ? (point[0] - a[0]) / dx
    : (point[1] - a[1]) / dy
}

/** Add topology-exact split parameters, accepting only roundoff-scale drift. */
function addIntersectionParameters(
  parameters: number[],
  a: Point,
  b: Point,
  c: Point,
  d: Point,
): void {
  const rx = b[0] - a[0]
  const ry = b[1] - a[1]
  const sx = d[0] - c[0]
  const sy = d[1] - c[1]
  const firstProduct = rx * sy
  const secondProduct = ry * sx
  const denominator = firstProduct - secondProduct
  const cax = c[0] - a[0]
  const cay = c[1] - a[1]

  if (!nearlyEqual(firstProduct, secondProduct)) {
    const t = (cax * sy - cay * sx) / denominator
    const u = (cax * ry - cay * rx) / denominator
    const parameterRoundOff = roundOff(t, u)
    if (
      t >= -parameterRoundOff &&
      t <= 1 + parameterRoundOff &&
      u >= -parameterRoundOff &&
      u <= 1 + parameterRoundOff
    ) {
      parameters.push(Math.max(0, Math.min(1, t)))
    }
    return
  }

  if (!nearlyEqual(cax * ry, cay * rx)) return
  const cParameter = parameterOnSegment(a, b, c)
  const dParameter = parameterOnSegment(a, b, d)
  const overlapStart = Math.max(0, Math.min(cParameter, dParameter))
  const overlapEnd = Math.min(1, Math.max(cParameter, dParameter))
  if (overlapStart <= overlapEnd + roundOff(overlapStart, overlapEnd)) {
    parameters.push(overlapStart, overlapEnd)
  }
}

function visibleAtoms(
  interval: ContourInterval,
  nearerPolygons: readonly (readonly Point[])[],
): ContourInterval[] {
  const parameters = [0, 1]
  for (const polygon of nearerPolygons) {
    for (const edge of polygonIntervals(polygon)) {
      addIntersectionParameters(
        parameters,
        interval[0],
        interval[1],
        edge[0],
        edge[1],
      )
    }
  }
  parameters.sort((a, b) => a - b)
  const uniqueParameters = parameters.filter(
    (parameter, index) =>
      index === 0 || !nearlyEqual(parameter, parameters[index - 1]!),
  )

  const visible: ContourInterval[] = []
  for (let index = 1; index < uniqueParameters.length; index++) {
    const startParameter = uniqueParameters[index - 1]!
    const endParameter = uniqueParameters[index]!
    if (nearlyEqual(startParameter, endParameter)) continue
    const midpoint = interpolate(
      interval[0],
      interval[1],
      (startParameter + endParameter) / 2,
    )
    if (nearerPolygons.some((polygon) => polygonCoversPoint(midpoint, polygon))) {
      continue
    }
    const atom = canonicalInterval(
      interpolate(interval[0], interval[1], startParameter),
      interpolate(interval[0], interval[1], endParameter),
    )
    if (atom !== null) visible.push(atom)
  }
  return visible
}

/** Derive the exact painter-order-visible boundary union of a Fill Scene. */
export function deriveVisibleFillContours(scene: Scene): readonly ContourInterval[] {
  const polygons = scene.primitives.map((primitive) =>
    primitive.fill === undefined ? null : polygonPoints(primitive),
  )
  const intervals: ContourInterval[] = []

  for (let index = 0; index < polygons.length; index++) {
    const polygon = polygons[index]!
    if (polygon === null || polygon.length < 3) continue
    const nearer = polygons
      .slice(index + 1)
      .filter(
        (candidate): candidate is Point[] =>
          candidate !== null && candidate.length >= 3,
      )
    for (const boundary of polygonIntervals(polygon)) {
      const clipped = clipIntervalToFrame(
        boundary[0],
        boundary[1],
        scene.space.width,
        scene.space.height,
      )
      if (clipped !== null) intervals.push(...visibleAtoms(clipped, nearer))
    }
  }

  return canonicalize(intervals)
}

function primitiveIntervals(primitive: Primitive): ContourInterval[] {
  const intervals: ContourInterval[] = []
  for (let index = 1; index < primitive.points.length; index++) {
    const interval = canonicalInterval(
      primitive.points[index - 1]!,
      primitive.points[index]!,
    )
    if (interval !== null) intervals.push(interval)
  }
  if (primitive.closed && primitive.points.length >= 2) {
    const interval = canonicalInterval(
      primitive.points[primitive.points.length - 1]!,
      primitive.points[0]!,
    )
    if (interval !== null) intervals.push(interval)
  }
  return intervals
}

function intervalsCover(
  wanted: readonly ContourInterval[],
  available: readonly ContourInterval[],
): boolean {
  return uncoveredIntervals(wanted, available).length === 0
}

function isOptionalCompositionFrame(
  primitive: Primitive,
  scene: Scene,
): boolean {
  if (primitive.fill !== undefined || primitive.stroke === undefined) return false
  const frame = canonicalize([
    [[0, 0], [scene.space.width, 0]],
    [[scene.space.width, 0], [scene.space.width, scene.space.height]],
    [[scene.space.width, scene.space.height], [0, scene.space.height]],
    [[0, scene.space.height], [0, 0]],
  ])
  const candidate = canonicalize(primitiveIntervals(primitive))
  return intervalsCover(frame, candidate) && intervalsCover(candidate, frame)
}

/**
 * Extract frame-clipped Outline geometry without inventing connector edges.
 *
 * The output-profile frame is compared by default. Callers must explicitly opt
 * out, and only the exact final frame-shaped primitive is eligible.
 */
export function deriveOutlineContours(
  scene: Scene,
  options: OutlineContourOptions = {},
): readonly ContourInterval[] {
  const lastIndex = scene.primitives.length - 1
  return canonicalize(
    scene.primitives.flatMap((primitive, index) =>
      options.excludeCompositionFrame === true &&
      index === lastIndex &&
      isOptionalCompositionFrame(primitive, scene)
        ? []
        : primitiveIntervals(primitive).flatMap((interval) => {
            const clipped = clipIntervalToFrame(
              interval[0],
              interval[1],
              scene.space.width,
              scene.space.height,
            )
            return clipped === null ? [] : [clipped]
          }),
    ),
  )
}

function coverageParameters(
  interval: ContourInterval,
  available: readonly ContourInterval[],
): Array<readonly [number, number]> {
  const covered: Array<readonly [number, number]> = []
  for (const candidate of available) {
    if (!collinear(interval, candidate)) continue
    const first = parameterOnSegment(interval[0], interval[1], candidate[0])
    const second = parameterOnSegment(interval[0], interval[1], candidate[1])
    const start = Math.max(0, Math.min(first, second))
    const end = Math.min(1, Math.max(first, second))
    if (start < end - roundOff(start, end)) covered.push([start, end])
  }
  return covered.sort((a, b) => a[0] - b[0] || a[1] - b[1])
}

function uncoveredIntervals(
  wanted: readonly ContourInterval[],
  available: readonly ContourInterval[],
): ContourInterval[] {
  const uncovered: ContourInterval[] = []
  for (const interval of wanted) {
    let cursor = 0
    for (const [start, end] of coverageParameters(interval, available)) {
      if (start > cursor + roundOff(start, cursor)) {
        const gap = canonicalInterval(
          interpolate(interval[0], interval[1], cursor),
          interpolate(interval[0], interval[1], start),
        )
        if (gap !== null) uncovered.push(gap)
      }
      cursor = Math.max(cursor, end)
      if (cursor >= 1 - roundOff(cursor, 1)) {
        cursor = 1
        break
      }
    }
    if (cursor < 1 - roundOff(cursor, 1)) {
      const gap = canonicalInterval(
        interpolate(interval[0], interval[1], cursor),
        interval[1],
      )
      if (gap !== null) uncovered.push(gap)
    }
  }
  return canonicalize(uncovered)
}

/** Compare Fill-visible and Outline interval unions exactly and bidirectionally. */
export function compareVisibleContours(
  fillScene: Scene,
  outlineScene: Scene,
  options: OutlineContourOptions = {},
): VisibleContourComparison {
  if (
    fillScene.space.width !== outlineScene.space.width ||
    fillScene.space.height !== outlineScene.space.height
  ) {
    throw new Error('visible-contour oracle requires identical Composition Frames')
  }

  const fill = deriveVisibleFillContours(fillScene)
  const outline = deriveOutlineContours(outlineScene, options)
  const missing = uncoveredIntervals(fill, outline)
  const extra = uncoveredIntervals(outline, fill)
  return Object.freeze({
    matches: missing.length === 0 && extra.length === 0,
    missing: Object.freeze(missing),
    extra: Object.freeze(extra),
  })
}
