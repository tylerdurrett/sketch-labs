import { describe, expect, it } from 'vitest'
import {
  pointInPolygon,
  subtractPolygonsFromPolyline,
} from '../polygonClip'
import type { Polyline } from '../types'

/** Axis-aligned square [0,0]..[10,10], given closed. */
const square: Polyline = [
  [0, 0],
  [10, 0],
  [10, 10],
  [0, 10],
  [0, 0],
]

/**
 * Concave "notched" polygon — a square with a rectangular bite taken out of the
 * top edge, forming a C/U shape. The notch spans x in [4,6], y in [4,10].
 * A point at (5, 7) sits INSIDE the notch, i.e. OUTSIDE the polygon, which a
 * convex-only test would get wrong.
 */
const concave: Polyline = [
  [0, 0],
  [10, 0],
  [10, 10],
  [6, 10],
  [6, 4],
  [4, 4],
  [4, 10],
  [0, 10],
]

describe('pointInPolygon', () => {
  it('detects points inside and outside a convex polygon', () => {
    expect(pointInPolygon([5, 5], square)).toBe(true)
    expect(pointInPolygon([15, 5], square)).toBe(false)
  })

  it('is correct inside the concavity of a concave polygon', () => {
    // Deep inside the two solid legs of the U:
    expect(pointInPolygon([2, 7], concave)).toBe(true)
    expect(pointInPolygon([8, 7], concave)).toBe(true)
    // In the notch — outside the polygon even though within its bounding box:
    expect(pointInPolygon([5, 7], concave)).toBe(false)
    // Below the notch, in the solid base:
    expect(pointInPolygon([5, 2], concave)).toBe(true)
  })
})

describe('subtractPolygonsFromPolyline', () => {
  it('returns the polyline intact with no polygons to subtract', () => {
    const line: Polyline = [
      [20, 20],
      [30, 30],
    ]
    const result = subtractPolygonsFromPolyline(line, [])
    expect(result).toEqual([line])
  })

  it('removes a polyline fully inside the polygon (empty output)', () => {
    const line: Polyline = [
      [3, 5],
      [7, 5],
    ]
    const result = subtractPolygonsFromPolyline(line, [square])
    expect(result).toEqual([])
  })

  it('passes a polyline fully outside the polygon through intact', () => {
    const line: Polyline = [
      [20, 20],
      [25, 22],
      [30, 20],
    ]
    const result = subtractPolygonsFromPolyline(line, [square])
    expect(result).toHaveLength(1)
    expect(result[0]).toEqual(line)
  })

  it('splits a boundary-crossing polyline, removing the inside portion', () => {
    // Horizontal line crossing the square: enters at x=0, exits at x=10.
    const line: Polyline = [
      [-5, 5],
      [15, 5],
    ]
    const result = subtractPolygonsFromPolyline(line, [square])
    expect(result).toHaveLength(2)
    // Left stub outside the square:
    expect(result[0][0]).toEqual([-5, 5])
    expect(result[0][1][0]).toBeCloseTo(0)
    expect(result[0][1][1]).toBeCloseTo(5)
    // Right stub outside the square:
    expect(result[1][0][0]).toBeCloseTo(10)
    expect(result[1][0][1]).toBeCloseTo(5)
    expect(result[1][1]).toEqual([15, 5])
  })

  it('keeps only the entering stub when the polyline ends inside', () => {
    const line: Polyline = [
      [-5, 5],
      [5, 5],
    ]
    const result = subtractPolygonsFromPolyline(line, [square])
    expect(result).toHaveLength(1)
    expect(result[0][0]).toEqual([-5, 5])
    expect(result[0][1][0]).toBeCloseTo(0)
    expect(result[0][1][1]).toBeCloseTo(5)
  })

  it('removes the union of multiple polygons', () => {
    // Second square [20,0]..[30,10]; line crosses both plus the gap between.
    const square2: Polyline = [
      [20, 0],
      [30, 0],
      [30, 10],
      [20, 10],
      [20, 0],
    ]
    const line: Polyline = [
      [-5, 5],
      [35, 5],
    ]
    const result = subtractPolygonsFromPolyline(line, [square, square2])
    // Three surviving stubs: before sq1, between the squares, after sq2.
    expect(result).toHaveLength(3)
    expect(result[0][0]).toEqual([-5, 5])
    expect(result[0][1][0]).toBeCloseTo(0)
    // Middle stub spans the gap x in [10,20]:
    expect(result[1][0][0]).toBeCloseTo(10)
    expect(result[1][1][0]).toBeCloseTo(20)
    // Trailing stub:
    expect(result[2][0][0]).toBeCloseTo(30)
    expect(result[2][1]).toEqual([35, 5])
  })

  it('handles a concave polygon: the notch lets a middle portion survive', () => {
    // Horizontal line at y=7 crosses the concave U left-to-right. It is inside
    // the left leg (x in [0,4]), OUTSIDE in the notch (x in [4,6]), and inside
    // the right leg (x in [6,10]). A convex-only clip would wrongly remove the
    // whole span.
    const line: Polyline = [
      [-5, 7],
      [15, 7],
    ]
    const result = subtractPolygonsFromPolyline(line, [concave])
    // Surviving pieces: left stub before the polygon, the notch gap, and the
    // right stub after the polygon.
    expect(result).toHaveLength(3)
    expect(result[0][0]).toEqual([-5, 7])
    expect(result[0][1][0]).toBeCloseTo(0)
    // Notch gap: x in [4,6]:
    expect(result[1][0][0]).toBeCloseTo(4)
    expect(result[1][1][0]).toBeCloseTo(6)
    // Right stub: from x=10 outward:
    expect(result[2][0][0]).toBeCloseTo(10)
    expect(result[2][1]).toEqual([15, 7])
  })

  it('reconstructs a multi-vertex outside polyline exactly', () => {
    const line: Polyline = [
      [-5, 20],
      [0, 22],
      [5, 25],
      [10, 21],
    ]
    const result = subtractPolygonsFromPolyline(line, [square])
    expect(result).toHaveLength(1)
    expect(result[0]).toEqual(line)
  })

  it('returns empty for a degenerate single-point polyline', () => {
    const result = subtractPolygonsFromPolyline([[5, 5]], [square])
    expect(result).toEqual([])
  })

  it('does not emit a degenerate polyline from a zero-length outside segment', () => {
    // Two coincident points, fully outside the square: the zero-length segment
    // must not produce a degenerate [a, a] open polyline.
    const line: Polyline = [
      [20, 20],
      [20, 20],
    ]
    const result = subtractPolygonsFromPolyline(line, [square])
    // No output at all here: there is no real (non-zero-length) span to keep.
    expect(result).toEqual([])
    for (const pl of result) {
      expect(isDegenerate(pl)).toBe(false)
    }
  })

  it('keeps the valid span but drops the coincident stub around a duplicate point', () => {
    // A duplicate consecutive point followed by a real segment, all outside the
    // square. The genuine [20,20]->[30,30] span must survive; the leading
    // zero-length [20,20]->[20,20] must not spawn a degenerate polyline.
    const line: Polyline = [
      [20, 20],
      [20, 20],
      [30, 30],
    ]
    const result = subtractPolygonsFromPolyline(line, [square])
    expect(result).toHaveLength(1)
    expect(result[0]).toEqual([
      [20, 20],
      [30, 30],
    ])
    expect(isDegenerate(result[0]!)).toBe(false)
  })
})

/** True when every point of the polyline is coincident (a collapsed line). */
function isDegenerate(pl: Polyline): boolean {
  if (pl.length < 2) return true
  const [x0, y0] = pl[0]!
  return pl.every(([x, y]) => Math.abs(x - x0) < 1e-9 && Math.abs(y - y0) < 1e-9)
}
