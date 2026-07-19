import { describe, expect, it } from 'vitest'

import { bbox, imageAssetParam } from '../sketches/sketch-util'
import type { ParamSpec } from '../sketch'
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

describe('imageAssetParam', () => {
  const schema = {
    image: { kind: 'image-asset', default: 'portrait-default' },
    count: { kind: 'number', min: 1, max: 10, default: 5 },
  } satisfies Record<string, ParamSpec>

  it('returns the authored stable ID unchanged', () => {
    expect(imageAssetParam({ image: 'portrait-selected' }, schema, 'image')).toBe(
      'portrait-selected',
    )
  })

  it('falls back to the declared default for a missing or non-string value', () => {
    expect(imageAssetParam({}, schema, 'image')).toBe('portrait-default')
    expect(imageAssetParam({ image: 42 }, schema, 'image')).toBe(
      'portrait-default',
    )
  })
})
