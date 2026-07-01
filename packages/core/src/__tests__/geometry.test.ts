import { describe, expect, it } from 'vitest'
import {
  line,
  rect,
  circle,
  arc,
  ellipse,
  polygon,
  quadratic,
  cubic,
  spiral,
} from '../geometry'
import type { Point } from '../types'

describe('line', () => {
  it('returns exactly two points', () => {
    const result = line(0, 0, 1, 1)
    expect(result).toEqual([
      [0, 0],
      [1, 1],
    ])
  })

  it('handles negative coordinates', () => {
    const result = line(-1, -2, -3, -4)
    expect(result).toEqual([
      [-1, -2],
      [-3, -4],
    ])
  })
})

describe('rect', () => {
  it('returns 5 points with correct corners', () => {
    const result = rect(0, 0, 2, 3)
    expect(result).toHaveLength(5)
    expect(result).toEqual([
      [0, 0],
      [2, 0],
      [2, 3],
      [0, 3],
      [0, 0],
    ])
  })

  it('is closed (first point === last point)', () => {
    const result = rect(1, 2, 5, 4)
    expect(result[0]).toEqual(result[result.length - 1])
  })

  it('handles zero dimensions', () => {
    const result = rect(1, 1, 0, 0)
    expect(result).toHaveLength(5)
    expect(result[0]).toEqual([1, 1])
  })
})

describe('circle', () => {
  it('returns segments + 1 points', () => {
    const result = circle(0, 0, 1, 4)
    expect(result).toHaveLength(5)
  })

  it('is closed (first point === last point)', () => {
    const result = circle(0, 0, 1, 4)
    expect(result[0][0]).toBeCloseTo(result[result.length - 1][0])
    expect(result[0][1]).toBeCloseTo(result[result.length - 1][1])
  })

  it('all points are at the correct radius', () => {
    const r = 5
    const result = circle(0, 0, r, 32)
    // Skip last point (duplicate of first) to avoid floating-point edge case
    for (let i = 0; i < result.length - 1; i++) {
      const dist = Math.sqrt(result[i][0] ** 2 + result[i][1] ** 2)
      expect(dist).toBeCloseTo(r)
    }
  })

  it('respects center offset', () => {
    const cx = 3
    const cy = 4
    const r = 2
    const result = circle(cx, cy, r, 16)
    for (let i = 0; i < result.length - 1; i++) {
      const dist = Math.sqrt(
        (result[i][0] - cx) ** 2 + (result[i][1] - cy) ** 2,
      )
      expect(dist).toBeCloseTo(r)
    }
  })

  it('defaults to 64 segments', () => {
    const result = circle(0, 0, 1)
    expect(result).toHaveLength(65)
  })

  it('with 4 segments forms a square-ish shape', () => {
    const result = circle(0, 0, 1, 4)
    // 4-segment circle: points at 0, PI/2, PI, 3PI/2, 2PI
    expect(result[0][0]).toBeCloseTo(1) // right
    expect(result[0][1]).toBeCloseTo(0)
    expect(result[1][0]).toBeCloseTo(0) // top
    expect(result[1][1]).toBeCloseTo(1)
    expect(result[2][0]).toBeCloseTo(-1) // left
    expect(result[2][1]).toBeCloseTo(0)
    expect(result[3][0]).toBeCloseTo(0) // bottom
    expect(result[3][1]).toBeCloseTo(-1)
  })
})

describe('arc', () => {
  it('returns segments + 1 points', () => {
    const result = arc(0, 0, 1, 0, Math.PI, 8)
    expect(result).toHaveLength(9)
  })

  it('is open (first point !== last point for partial arc)', () => {
    const result = arc(0, 0, 1, 0, Math.PI, 8)
    // Half circle: start at (1,0), end at (-1,0)
    expect(result[0][0]).toBeCloseTo(1)
    expect(result[0][1]).toBeCloseTo(0)
    expect(result[result.length - 1][0]).toBeCloseTo(-1)
    expect(result[result.length - 1][1]).toBeCloseTo(0)
  })

  it('all points are at the correct radius', () => {
    const r = 3
    const result = arc(0, 0, r, 0, Math.PI, 16)
    for (const p of result) {
      const dist = Math.sqrt(p[0] ** 2 + p[1] ** 2)
      expect(dist).toBeCloseTo(r)
    }
  })

  it('respects start and end angles', () => {
    const result = arc(0, 0, 1, Math.PI / 2, Math.PI, 4)
    // Start at PI/2 (top), end at PI (left)
    expect(result[0][0]).toBeCloseTo(0)
    expect(result[0][1]).toBeCloseTo(1)
    expect(result[result.length - 1][0]).toBeCloseTo(-1)
    expect(result[result.length - 1][1]).toBeCloseTo(0)
  })

  it('defaults to 64 segments', () => {
    const result = arc(0, 0, 1, 0, Math.PI)
    expect(result).toHaveLength(65)
  })
})

describe('ellipse', () => {
  it('returns segments + 1 points', () => {
    const result = ellipse(0, 0, 3, 2, 8)
    expect(result).toHaveLength(9)
  })

  it('is closed (first point ≈ last point)', () => {
    const result = ellipse(0, 0, 3, 2, 16)
    expect(result[0][0]).toBeCloseTo(result[result.length - 1][0])
    expect(result[0][1]).toBeCloseTo(result[result.length - 1][1])
  })

  it('has correct rx and ry at cardinal points', () => {
    const rx = 5
    const ry = 3
    const result = ellipse(0, 0, rx, ry, 4)
    // 4 segments: points at 0, PI/2, PI, 3PI/2
    expect(result[0][0]).toBeCloseTo(rx) // right
    expect(result[0][1]).toBeCloseTo(0)
    expect(result[1][0]).toBeCloseTo(0) // top
    expect(result[1][1]).toBeCloseTo(ry)
    expect(result[2][0]).toBeCloseTo(-rx) // left
    expect(result[2][1]).toBeCloseTo(0)
    expect(result[3][0]).toBeCloseTo(0) // bottom
    expect(result[3][1]).toBeCloseTo(-ry)
  })

  it('defaults to 64 segments', () => {
    const result = ellipse(0, 0, 3, 2)
    expect(result).toHaveLength(65)
  })
})

describe('polygon', () => {
  it('returns sides + 1 points (hexagon)', () => {
    const result = polygon(0, 0, 1, 6)
    expect(result).toHaveLength(7)
  })

  it('is closed (first point ≈ last point)', () => {
    const result = polygon(0, 0, 1, 6)
    expect(result[0][0]).toBeCloseTo(result[result.length - 1][0])
    expect(result[0][1]).toBeCloseTo(result[result.length - 1][1])
  })

  it('all vertices are at the correct radius', () => {
    const r = 4
    const result = polygon(0, 0, r, 5)
    // Skip last point (duplicate of first)
    for (let i = 0; i < result.length - 1; i++) {
      const dist = Math.sqrt(result[i][0] ** 2 + result[i][1] ** 2)
      expect(dist).toBeCloseTo(r)
    }
  })

  it('first vertex points up (angle = -PI/2)', () => {
    const result = polygon(0, 0, 1, 4)
    // First vertex should be at top: (0, -1)
    expect(result[0][0]).toBeCloseTo(0)
    expect(result[0][1]).toBeCloseTo(-1)
  })

  it('triangle has 4 points', () => {
    const result = polygon(0, 0, 1, 3)
    expect(result).toHaveLength(4)
  })

  it('respects center offset', () => {
    const cx = 5
    const cy = 5
    const r = 2
    const result = polygon(cx, cy, r, 4)
    for (let i = 0; i < result.length - 1; i++) {
      const dist = Math.sqrt(
        (result[i][0] - cx) ** 2 + (result[i][1] - cy) ** 2,
      )
      expect(dist).toBeCloseTo(r)
    }
  })
})

describe('quadratic', () => {
  const p0: Point = [0, 0]
  const p1: Point = [1, 2]
  const p2: Point = [2, 0]

  it('returns segments + 1 points', () => {
    const result = quadratic(p0, p1, p2, 10)
    expect(result).toHaveLength(11)
  })

  it('starts at p0 and ends at p2', () => {
    const result = quadratic(p0, p1, p2, 16)
    expect(result[0]).toEqual(p0)
    expect(result[result.length - 1]).toEqual(p2)
  })

  it('midpoint is pulled toward control point', () => {
    const result = quadratic(p0, p1, p2, 2)
    // At t=0.5: B = 0.25*p0 + 0.5*p1 + 0.25*p2 = (1, 1)
    expect(result[1][0]).toBeCloseTo(1)
    expect(result[1][1]).toBeCloseTo(1)
  })

  it('defaults to 32 segments', () => {
    const result = quadratic(p0, p1, p2)
    expect(result).toHaveLength(33)
  })

  it('segment count controls point density', () => {
    expect(quadratic(p0, p1, p2, 5)).toHaveLength(6)
    expect(quadratic(p0, p1, p2, 20)).toHaveLength(21)
  })
})

describe('cubic', () => {
  const p0: Point = [0, 0]
  const p1: Point = [0, 2]
  const p2: Point = [2, 2]
  const p3: Point = [2, 0]

  it('returns segments + 1 points', () => {
    const result = cubic(p0, p1, p2, p3, 10)
    expect(result).toHaveLength(11)
  })

  it('starts at p0 and ends at p3', () => {
    const result = cubic(p0, p1, p2, p3, 16)
    expect(result[0]).toEqual(p0)
    expect(result[result.length - 1]).toEqual(p3)
  })

  it('midpoint for symmetric S-curve is at expected position', () => {
    const result = cubic(p0, p1, p2, p3, 2)
    // At t=0.5: B = 0.125*p0 + 0.375*p1 + 0.375*p2 + 0.125*p3
    // x = 0 + 0 + 0.75 + 0.25 = 1.0
    // y = 0 + 0.75 + 0.75 + 0 = 1.5
    expect(result[1][0]).toBeCloseTo(1.0)
    expect(result[1][1]).toBeCloseTo(1.5)
  })

  it('defaults to 64 segments', () => {
    const result = cubic(p0, p1, p2, p3)
    expect(result).toHaveLength(65)
  })

  it('segment count controls point density', () => {
    expect(cubic(p0, p1, p2, p3, 8)).toHaveLength(9)
    expect(cubic(p0, p1, p2, p3, 32)).toHaveLength(33)
  })
})

describe('spiral', () => {
  it('starts at rStart radius and ends at rEnd radius', () => {
    const rStart = 1
    const rEnd = 5
    const result = spiral(0, 0, rStart, rEnd, 3, 100)
    const startDist = Math.sqrt(result[0][0] ** 2 + result[0][1] ** 2)
    const endDist = Math.sqrt(
      result[result.length - 1][0] ** 2 + result[result.length - 1][1] ** 2,
    )
    expect(startDist).toBeCloseTo(rStart)
    expect(endDist).toBeCloseTo(rEnd)
  })

  it('returns segments + 1 points', () => {
    const result = spiral(0, 0, 1, 5, 2, 50)
    expect(result).toHaveLength(51)
  })

  it('defaults segments to turns * 64', () => {
    const turns = 3
    const result = spiral(0, 0, 1, 5, turns)
    expect(result).toHaveLength(turns * 64 + 1)
  })

  it('respects center offset', () => {
    const cx = 3
    const cy = 4
    const rStart = 0
    const result = spiral(cx, cy, rStart, 2, 1, 8)
    // First point should be at center when rStart = 0
    expect(result[0][0]).toBeCloseTo(cx)
    expect(result[0][1]).toBeCloseTo(cy)
  })

  it('radius increases monotonically when rEnd > rStart', () => {
    const result = spiral(0, 0, 1, 10, 2, 200)
    // Check that radius generally increases (sample every quarter turn)
    const step = 50 // ~quarter turn with 200 segments over 2 turns
    for (let i = step; i < result.length; i += step) {
      const prevR = Math.sqrt(
        result[i - step][0] ** 2 + result[i - step][1] ** 2,
      )
      const currR = Math.sqrt(result[i][0] ** 2 + result[i][1] ** 2)
      expect(currR).toBeGreaterThan(prevR)
    }
  })

  it('handles fractional turns', () => {
    const result = spiral(0, 0, 1, 2, 0.5, 16)
    expect(result).toHaveLength(17)
    // Half turn: end angle = PI, so last point should be at angle PI
    const endDist = Math.sqrt(
      result[result.length - 1][0] ** 2 + result[result.length - 1][1] ** 2,
    )
    expect(endDist).toBeCloseTo(2)
  })
})

describe('all geometry functions', () => {
  it('return arrays of [number, number] tuples', () => {
    const fns = [
      () => line(0, 0, 1, 1),
      () => rect(0, 0, 1, 1),
      () => circle(0, 0, 1, 4),
      () => arc(0, 0, 1, 0, Math.PI, 4),
      () => ellipse(0, 0, 2, 1, 4),
      () => polygon(0, 0, 1, 4),
      () => quadratic([0, 0], [1, 1], [2, 0], 4),
      () => cubic([0, 0], [0, 1], [1, 1], [1, 0], 4),
      () => spiral(0, 0, 1, 2, 1, 4),
    ]
    for (const fn of fns) {
      const result = fn()
      expect(Array.isArray(result)).toBe(true)
      for (const point of result) {
        expect(point).toHaveLength(2)
        expect(typeof point[0]).toBe('number')
        expect(typeof point[1]).toBe('number')
      }
    }
  })
})
