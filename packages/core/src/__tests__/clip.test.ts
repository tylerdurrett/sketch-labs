import { describe, expect, it } from 'vitest'
import { clipPolylinesToBox } from '../clip'
import type { BBox } from '../clip'
import type { Polyline } from '../types'

const box: BBox = [0, 0, 10, 10]

describe('clipPolylinesToBox', () => {
  it('returns a line fully inside the box unchanged', () => {
    const lines: Polyline[] = [
      [
        [2, 2],
        [8, 8],
      ],
    ]
    const result = clipPolylinesToBox(lines, box)
    expect(result).toHaveLength(1)
    expect(result[0]).toEqual([
      [2, 2],
      [8, 8],
    ])
  })

  it('removes a line fully outside the box', () => {
    const lines: Polyline[] = [
      [
        [15, 15],
        [20, 20],
      ],
    ]
    const result = clipPolylinesToBox(lines, box)
    expect(result).toHaveLength(0)
  })

  it('clips a line crossing the box boundary at the intersection', () => {
    const lines: Polyline[] = [
      [
        [5, 5],
        [15, 5],
      ],
    ]
    const result = clipPolylinesToBox(lines, box)
    expect(result).toHaveLength(1)
    expect(result[0][0]).toEqual([5, 5])
    expect(result[0][1][0]).toBeCloseTo(10)
    expect(result[0][1][1]).toBeCloseTo(5)
  })

  it('splits a polyline that exits and re-enters the box into segments', () => {
    // Polyline goes right (exits at x=10), then down, then back left (re-enters at x=10)
    const lines: Polyline[] = [
      [
        [1, 5],
        [12, 5],
        [12, 8],
        [1, 8],
      ],
    ]
    const result = clipPolylinesToBox(lines, box)
    expect(result).toHaveLength(2)
    // First segment: [1,5] → [10,5] (clipped at right edge)
    expect(result[0][0]).toEqual([1, 5])
    expect(result[0][1][0]).toBeCloseTo(10)
    expect(result[0][1][1]).toBeCloseTo(5)
    // Second segment: [10,8] → [1,8] (re-enters at right edge)
    expect(result[1][0][0]).toBeCloseTo(10)
    expect(result[1][0][1]).toBeCloseTo(8)
    expect(result[1][1]).toEqual([1, 8])
  })

  it('returns empty array for empty input', () => {
    const result = clipPolylinesToBox([], box)
    expect(result).toEqual([])
  })

  it('handles multiple polylines with mixed inside/outside behavior', () => {
    const lines: Polyline[] = [
      [
        [1, 1],
        [9, 9],
      ], // fully inside
      [
        [15, 15],
        [20, 20],
      ], // fully outside
      [
        [5, 5],
        [15, 5],
      ], // partially inside
    ]
    const result = clipPolylinesToBox(lines, box)
    // First line unchanged, second removed, third clipped = 2 results
    expect(result).toHaveLength(2)
    expect(result[0]).toEqual([
      [1, 1],
      [9, 9],
    ])
    expect(result[1][0]).toEqual([5, 5])
    expect(result[1][1][0]).toBeCloseTo(10)
  })

  it('handles a single-point polyline gracefully', () => {
    const lines: Polyline[] = [[[5, 5]]]
    const result = clipPolylinesToBox(lines, box)
    // Single-point lines cannot form a segment
    expect(result).toHaveLength(0)
  })
})
