import { describe, expect, it } from 'vitest'
import {
  pointInPolygon,
  preparePolygon,
  subtractPreparedPolygonsFromPolyline,
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

  it('prepared ray bins preserve half-open results at vertices and bin boundaries', () => {
    const prepared = preparePolygon(concave)
    const next = (value: number, direction: 'up' | 'down') => {
      if (value === 0) {
        return direction === 'up' ? Number.MIN_VALUE : -Number.MIN_VALUE
      }
      const view = new DataView(new ArrayBuffer(8))
      view.setFloat64(0, value)
      let bits = view.getBigUint64(0)
      bits += direction === 'up' ? 1n : -1n
      view.setBigUint64(0, bits)
      return view.getFloat64(0)
    }
    const ys = [0, 4, 10]
    for (let bin = 1; bin < 32; bin++) ys.push((10 * bin) / 32)

    for (const y of ys) {
      for (const py of [next(y, 'down'), y, next(y, 'up')]) {
        expect(classifyWithPreparedBins([5, py], prepared)).toBe(
          pointInPolygon([5, py], concave),
        )
      }
    }
  })

  it('prepared ray bins match the full ray cast for randomized points', () => {
    const prepared = preparePolygon(concave)
    let state = 0x6d2b79f5
    const random = () => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0
      return state / 0x1_0000_0000
    }

    for (let i = 0; i < 2000; i++) {
      const point: [number, number] = [random() * 10, random() * 10]
      expect(classifyWithPreparedBins(point, prepared)).toBe(
        pointInPolygon(point, concave),
      )
    }
  })

  it('falls back to the full ray cast when a subnormal polygon height overflows bin scale', () => {
    const tiny: Polyline = [
      [0, 1e-310],
      [1, 1e-310],
      [1, 2e-310],
      [0, 2e-310],
    ]
    const midpoint: [number, number] = [0.5, 1.5e-310]
    const prepared = preparePolygon(tiny)

    expect(pointInPolygon(midpoint, tiny)).toBe(true)
    expect(prepared.rayBins).toBeNull()
    expect(
      subtractPreparedPolygonsFromPolyline(
        [
          [0.25, midpoint[1]],
          [0.75, midpoint[1]],
        ],
        [prepared],
      ),
    ).toEqual([])
  })
})

function classifyWithPreparedBins(
  point: [number, number],
  prepared: ReturnType<typeof preparePolygon>,
): boolean {
  const delta = 1e-7
  const line: Polyline = [
    [point[0] - delta, point[1]],
    [point[0] + delta, point[1]],
  ]
  return subtractPreparedPolygonsFromPolyline(line, [prepared]).length === 0
}

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

  it('preserves crossings accepted just beyond an edge endpoint by EPS', () => {
    // The line sits 5e-9 below the square. That is outside the polygon's raw
    // AABB, but each vertical edge is length 10, so its u parameter is only
    // -5e-10: inside segmentCrossParam's ±1e-9 endpoint tolerance. The current
    // policy therefore records crossings at x=0 and x=10 even though midpoint
    // classification keeps all three outside spans. Prepared polygon bounds
    // must not prune those accepted crossings.
    const line: Polyline = [
      [-5, -5e-9],
      [15, -5e-9],
    ]

    expect(subtractPolygonsFromPolyline(line, [square])).toEqual([
      [
        [-5, -5e-9],
        [0, -5e-9],
        [10, -5e-9],
        [15, -5e-9],
      ],
    ])
  })
})

/** True when every point of the polyline is coincident (a collapsed line). */
function isDegenerate(pl: Polyline): boolean {
  if (pl.length < 2) return true
  const [x0, y0] = pl[0]!
  return pl.every(([x, y]) => Math.abs(x - x0) < 1e-9 && Math.abs(y - y0) < 1e-9)
}
