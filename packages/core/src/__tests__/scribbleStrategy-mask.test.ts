import { describe, expect, it, vi } from 'vitest'

import { createShadingMask } from '../shadingFields'
import {
  isMaskPermittedPolyline,
  isMaskPermittedSegment,
} from '../scribbleStrategy/mask'
import type { ShadingMask } from '../shadingFields'
import type { CoordinateSpace } from '../scene'
import type { Point, Polyline } from '../types'

const FRAME: CoordinateSpace = { width: 10, height: 10 }

function expectFinelyPermitted(
  mask: ShadingMask,
  frame: CoordinateSpace,
  polyline: Polyline,
): void {
  for (let segment = 1; segment < polyline.length; segment++) {
    const start = polyline[segment - 1]!
    const end = polyline[segment]!

    // Deliberately independent of the production spacing calculation: inspect
    // each accepted segment at 201 fixed stations, including both endpoints.
    for (let station = 0; station <= 200; station++) {
      const progress = station / 200
      const point: Point = [
        start[0] + (end[0] - start[0]) * progress,
        start[1] + (end[1] - start[1]) * progress,
      ]

      expect(point[0]).toBeGreaterThanOrEqual(0)
      expect(point[0]).toBeLessThanOrEqual(frame.width)
      expect(point[1]).toBeGreaterThanOrEqual(0)
      expect(point[1]).toBeLessThanOrEqual(frame.height)
      expect(mask.sample(point)).toBeGreaterThan(0)
    }
  }
}

describe('Scribble mask segment validation', () => {
  it.each([1, 0.25, Number.MIN_VALUE])(
    'accepts full or soft permission %s without quantizing it',
    (permission) => {
      const mask = createShadingMask(() => permission)

      expect(
        isMaskPermittedSegment(mask, FRAME, [1, 2], [9, 8], 0.5),
      ).toBe(true)
    },
  )

  it('uses ceil(length / maxSpacing) equal intervals and includes both endpoints', () => {
    const sample = vi.fn(() => 1)
    const mask = createShadingMask(sample)

    expect(isMaskPermittedSegment(mask, FRAME, [0, 5], [10, 5], 3)).toBe(
      true,
    )
    expect(sample.mock.calls.map(([point]) => point)).toEqual([
      [0, 5],
      [2.5, 5],
      [5, 5],
      [7.5, 5],
      [10, 5],
    ])
  })

  it('rejects an exact-zero permission at either endpoint', () => {
    const startForbidden = createShadingMask(([x]) => (x === 1 ? 0 : 1))
    const endForbidden = createShadingMask(([x]) => (x === 9 ? 0 : 1))

    expect(
      isMaskPermittedSegment(startForbidden, FRAME, [1, 5], [9, 5], 2),
    ).toBe(false)
    expect(
      isMaskPermittedSegment(endForbidden, FRAME, [1, 5], [9, 5], 2),
    ).toBe(false)
  })

  it('rejects a thin exact-zero barrier even when both endpoints are permitted', () => {
    const mask = createShadingMask(([x]) => (x === 5 ? 0 : 1))

    expect(isMaskPermittedSegment(mask, FRAME, [0, 5], [10, 5], 2.5)).toBe(
      false,
    )
  })

  it('rejects a segment joining disconnected permission islands', () => {
    const mask = createShadingMask(([x]) =>
      x <= 3 || x >= 7 ? 1 : 0,
    )

    expect(isMaskPermittedSegment(mask, FRAME, [2, 5], [8, 5], 1)).toBe(
      false,
    )
  })

  it('uses inclusive frame edges and rejects samples outside the frame', () => {
    const mask = createShadingMask(() => 1)

    expect(isMaskPermittedSegment(mask, FRAME, [0, 0], [10, 10], 1)).toBe(
      true,
    )
    expect(isMaskPermittedSegment(mask, FRAME, [-0.01, 5], [5, 5], 1)).toBe(
      false,
    )
    expect(isMaskPermittedSegment(mask, FRAME, [5, 5], [10.01, 5], 1)).toBe(
      false,
    )
  })

  it('samples a zero-length segment exactly once', () => {
    const permittedSample = vi.fn(() => 0.4)
    const permitted = createShadingMask(permittedSample)
    const forbidden = createShadingMask(() => 0)

    expect(isMaskPermittedSegment(permitted, FRAME, [10, 0], [10, 0], 1)).toBe(
      true,
    )
    expect(permittedSample).toHaveBeenCalledTimes(1)
    expect(isMaskPermittedSegment(forbidden, FRAME, [5, 5], [5, 5], 1)).toBe(
      false,
    )
    expect(isMaskPermittedSegment(permitted, FRAME, [11, 5], [11, 5], 1)).toBe(
      false,
    )
  })

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects invalid maximum spacing %s',
    (maxSpacing) => {
      const mask = createShadingMask(() => 1)

      expect(() =>
        isMaskPermittedSegment(mask, FRAME, [1, 1], [2, 2], maxSpacing),
      ).toThrow(RangeError)
    },
  )

  it.each([
    ['non-finite', Number.MIN_VALUE],
    ['finite but unsafe', 2 ** -53],
  ])('fails fast when spacing produces a %s interval count', (_kind, spacing) => {
    const sample = vi.fn(() => 1)
    const mask = createShadingMask(sample)

    expect(() =>
      isMaskPermittedSegment(mask, FRAME, [1, 1], [2, 1], spacing),
    ).toThrow(RangeError)
    expect(sample).not.toHaveBeenCalled()
  })
})

describe('Scribble mask polyline validation', () => {
  it('validates every segment and catches a forbidden later segment', () => {
    const mask = createShadingMask(([x]) => (x >= 8 ? 0 : 1))
    const polyline: Polyline = [
      [1, 2],
      [5, 2],
      [9, 2],
    ]

    expect(isMaskPermittedPolyline(mask, FRAME, polyline, 0.5)).toBe(false)
  })

  it('accepts a safe polyline whose geometry passes independent fine sampling', () => {
    const mask = createShadingMask(([x, y]) =>
      x >= 1 && x <= 9 && y >= 2 && y <= 8 ? 0.2 : 0,
    )
    const polyline: Polyline = [
      [1, 2],
      [4, 6],
      [7, 3],
      [9, 8],
    ]

    expect(isMaskPermittedPolyline(mask, FRAME, polyline, 0.25)).toBe(true)
    expectFinelyPermitted(mask, FRAME, polyline)
  })

  it('rejects an empty polyline and validates a singleton as one point', () => {
    const mask = createShadingMask(([x]) => (x === 5 ? 0.5 : 0))

    expect(isMaskPermittedPolyline(mask, FRAME, [], 1)).toBe(false)
    expect(isMaskPermittedPolyline(mask, FRAME, [[5, 10]], 1)).toBe(true)
    expect(isMaskPermittedPolyline(mask, FRAME, [[4, 10]], 1)).toBe(false)
    expect(isMaskPermittedPolyline(mask, FRAME, [[5, 11]], 1)).toBe(false)
  })

  it('validates maximum spacing before handling empty geometry', () => {
    const mask = createShadingMask(() => 1)

    expect(() => isMaskPermittedPolyline(mask, FRAME, [], 0)).toThrow(
      RangeError,
    )
  })
})
