import { lerp } from './math'
import type { Point, Polyline } from './types'

/**
 * Create a 2-point polyline from (x1, y1) to (x2, y2).
 */
export function line(x1: number, y1: number, x2: number, y2: number): Polyline {
  return [
    [x1, y1],
    [x2, y2],
  ]
}

/**
 * Create a closed rectangular polyline (5 points, last = first).
 * (x, y) is the top-left corner; w and h are width and height.
 */
export function rect(x: number, y: number, w: number, h: number): Polyline {
  return [
    [x, y],
    [x + w, y],
    [x + w, y + h],
    [x, y + h],
    [x, y],
  ]
}

/**
 * Create a closed polyline approximating a circle.
 * Default segment count of 64 produces visually smooth curves.
 */
export function circle(
  cx: number,
  cy: number,
  r: number,
  segments: number = 64,
): Polyline {
  return ellipse(cx, cy, r, r, segments)
}

/**
 * Create an open polyline approximating a circular arc.
 * Angles are in radians. Default 64 segments.
 */
export function arc(
  cx: number,
  cy: number,
  r: number,
  startAngle: number,
  endAngle: number,
  segments: number = 64,
): Polyline {
  const count = segments + 1
  const points: Polyline = new Array(count)
  for (let i = 0; i < count; i++) {
    const angle = lerp(startAngle, endAngle, i / segments)
    points[i] = [cx + r * Math.cos(angle), cy + r * Math.sin(angle)]
  }
  return points
}

/**
 * Create a closed polyline approximating an ellipse.
 * Default segment count of 64 produces visually smooth curves.
 */
export function ellipse(
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  segments: number = 64,
): Polyline {
  const count = segments + 1
  const points: Polyline = new Array(count)
  for (let i = 0; i < segments; i++) {
    const angle = (i / segments) * Math.PI * 2
    points[i] = [cx + rx * Math.cos(angle), cy + ry * Math.sin(angle)]
  }
  // Close exactly by copying first point (avoids floating-point drift from cos/sin of 2*PI)
  points[segments] = [points[0]![0], points[0]![1]]
  return points
}

/**
 * Create a closed regular polygon as a polyline (sides + 1 points, last = first).
 * Vertices are evenly spaced on a circle of the given radius.
 * First vertex is at the top (angle = -PI/2) for visual consistency.
 */
export function polygon(
  cx: number,
  cy: number,
  r: number,
  sides: number,
): Polyline {
  const count = sides + 1
  const points: Polyline = new Array(count)
  for (let i = 0; i < sides; i++) {
    // Start at -PI/2 so first vertex points up
    const angle = (i / sides) * Math.PI * 2 - Math.PI / 2
    points[i] = [cx + r * Math.cos(angle), cy + r * Math.sin(angle)]
  }
  // Close exactly by copying first point
  points[sides] = [points[0]![0], points[0]![1]]
  return points
}

/**
 * Create a polyline from a quadratic Bezier curve (p0, p1, p2).
 * Points are Vec2 tuples. Default 32 segments.
 */
export function quadratic(
  p0: Point,
  p1: Point,
  p2: Point,
  segments: number = 32,
): Polyline {
  const count = segments + 1
  const points: Polyline = new Array(count)
  for (let i = 0; i < count; i++) {
    const t = i / segments
    const mt = 1 - t
    // B(t) = (1-t)^2 * P0 + 2(1-t)t * P1 + t^2 * P2
    points[i] = [
      mt * mt * p0[0] + 2 * mt * t * p1[0] + t * t * p2[0],
      mt * mt * p0[1] + 2 * mt * t * p1[1] + t * t * p2[1],
    ]
  }
  return points
}

/**
 * Create a polyline from a cubic Bezier curve (p0, p1, p2, p3).
 * Points are Vec2 tuples. Default 64 segments.
 */
export function cubic(
  p0: Point,
  p1: Point,
  p2: Point,
  p3: Point,
  segments: number = 64,
): Polyline {
  const count = segments + 1
  const points: Polyline = new Array(count)
  for (let i = 0; i < count; i++) {
    const t = i / segments
    const mt = 1 - t
    // B(t) = (1-t)^3*P0 + 3(1-t)^2*t*P1 + 3(1-t)*t^2*P2 + t^3*P3
    points[i] = [
      mt * mt * mt * p0[0] +
        3 * mt * mt * t * p1[0] +
        3 * mt * t * t * p2[0] +
        t * t * t * p3[0],
      mt * mt * mt * p0[1] +
        3 * mt * mt * t * p1[1] +
        3 * mt * t * t * p2[1] +
        t * t * t * p3[1],
    ]
  }
  return points
}

/**
 * Create an open polyline tracing an Archimedean spiral.
 * Radius interpolates linearly from rStart to rEnd over the given number of turns.
 * Default segments = turns * 64.
 */
export function spiral(
  cx: number,
  cy: number,
  rStart: number,
  rEnd: number,
  turns: number,
  segments?: number,
): Polyline {
  const segs = segments ?? Math.ceil(turns * 64)
  const totalAngle = turns * Math.PI * 2
  const count = segs + 1
  const points: Polyline = new Array(count)
  for (let i = 0; i < count; i++) {
    const t = i / segs
    const angle = t * totalAngle
    const r = lerp(rStart, rEnd, t)
    points[i] = [cx + r * Math.cos(angle), cy + r * Math.sin(angle)]
  }
  return points
}
