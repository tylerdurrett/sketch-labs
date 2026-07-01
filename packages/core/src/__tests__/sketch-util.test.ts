import { describe, expect, it } from 'vitest'

import { bbox } from '../sketches/sketch-util'
import type { Point } from '../types'

describe('bbox', () => {
  it('computes correct min/max on both axes for a handful of points', () => {
    const points: Point[] = [
      [1, 2],
      [5, -3],
      [-4, 8],
      [0, 0],
    ]
    expect(bbox(points)).toEqual({ minX: -4, minY: -3, maxX: 5, maxY: 8 })
  })

  it('yields a zero-area box (min === max) for a single point', () => {
    const box = bbox([[7, -2]])
    expect(box).toEqual({ minX: 7, minY: -2, maxX: 7, maxY: -2 })
    expect(box.maxX - box.minX).toBe(0)
    expect(box.maxY - box.minY).toBe(0)
  })

  it('handles negative coordinates', () => {
    const points: Point[] = [
      [-10, -20],
      [-3, -5],
    ]
    expect(bbox(points)).toEqual({ minX: -10, minY: -20, maxX: -3, maxY: -5 })
  })
})
