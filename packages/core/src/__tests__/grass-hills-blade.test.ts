import { describe, expect, it } from 'vitest'

import * as core from '../index'
import { blade, type BladeShape } from '../sketches/grass-hills/blade'
import type { Point, Polyline } from '../types'

const baseShape: BladeShape = {
  length: 100,
  width: 12,
  lean: 0,
  stiffness: 2.5,
}

interface FlankStation {
  right: Point
  left: Point
}

/** Pair the equal-y stations on the outward and return traces. */
function flankStations(outline: Polyline): FlankStation[] {
  const apexIndex = outline.findIndex(([, y]) => y === -baseShape.length)
  const right = outline.slice(0, apexIndex + 1)
  const left = outline.slice(apexIndex).reverse()
  expect(right).toHaveLength(left.length)
  return right.map((point, index) => ({ right: point, left: left[index]! }))
}

describe('grass-hills blade', () => {
  it('returns a finite outline rooted at the origin and explicitly closed', () => {
    const outline = blade(baseShape)

    expect(outline).toHaveLength(7)
    expect(outline[0]).toEqual([0, 0])
    expect(outline.at(-1)).toEqual([0, 0])
    for (const point of outline) {
      expect(point).toHaveLength(2)
      expect(point.every(Number.isFinite)).toBe(true)
    }
  })

  it('keeps every point finite at the largest finite width', () => {
    const outline = blade({ ...baseShape, width: Number.MAX_VALUE })

    expect(outline[0]).toEqual([0, 0])
    expect(outline.at(-1)).toEqual(outline[0])
    expect(outline.find(([, y]) => y === -baseShape.length)).toEqual([
      0,
      -baseShape.length,
    ])
    for (const point of outline) {
      expect(point.every(Number.isFinite)).toBe(true)
    }
  })

  it('tapers both flanks into one shared apex', () => {
    const outline = blade(baseShape)
    const apexes = outline.filter(([, y]) => y === -baseShape.length)

    expect(apexes).toEqual([[0, -baseShape.length]])
    const stations = flankStations(outline)
    expect(stations.at(-1)!.right).toEqual(stations.at(-1)!.left)
    expect(stations.at(-2)!.right[0] - stations.at(-2)!.left[0]).toBeGreaterThan(0)
  })

  it('widens then tapers while keeping the two flanks non-crossing', () => {
    const stations = flankStations(blade(baseShape))
    const widths = stations.map(({ right, left }) => {
      expect(right[1]).toBe(left[1])
      expect(right[0]).toBeGreaterThanOrEqual(left[0])
      return right[0] - left[0]
    })

    expect(widths[0]).toBe(0)
    expect(Math.max(...widths)).toBeCloseTo(baseShape.width)
    expect(widths.at(-1)).toBe(0)
    expect(widths[1]).toBeGreaterThan(widths[0]!)
    expect(widths[1]).toBeGreaterThan(widths[2]!)
    expect(widths[2]).toBeGreaterThan(widths[3]!)
  })

  it('stands upright at zero lean', () => {
    for (const { right, left } of flankStations(blade(baseShape))) {
      expect((right[0] + left[0]) / 2).toBeCloseTo(0, 12)
    }
  })

  it('mirrors its bend when the lean sign changes', () => {
    const right = flankStations(blade({ ...baseShape, lean: 0.35 }))
    const left = flankStations(blade({ ...baseShape, lean: -0.35 }))
    const centerX = ({ right, left }: FlankStation) => (right[0] + left[0]) / 2

    expect(right).toHaveLength(left.length)
    for (let index = 0; index < right.length; index++) {
      expect(centerX(right[index]!)).toBeCloseTo(-centerX(left[index]!), 12)
      expect(right[index]!.right[1]).toBe(left[index]!.right[1])
    }
    expect(centerX(right.at(-1)!)).toBeCloseTo(35)
    expect(centerX(left.at(-1)!)).toBeCloseTo(-35)
  })

  it('delays bend progressively across the supported stiffness range', () => {
    const flexible = flankStations(
      blade({ ...baseShape, lean: 0.5, stiffness: 1 }),
    )
    const medium = flankStations(
      blade({ ...baseShape, lean: 0.5, stiffness: 2.5 }),
    )
    const stiff = flankStations(
      blade({ ...baseShape, lean: 0.5, stiffness: 4 }),
    )
    const middle = Math.floor(flexible.length / 2)
    const centerX = ({ right, left }: FlankStation) => (right[0] + left[0]) / 2

    expect(centerX(flexible[middle]!)).toBeGreaterThan(centerX(medium[middle]!))
    expect(centerX(medium[middle]!)).toBeGreaterThan(centerX(stiff[middle]!))
    expect(centerX(stiff[middle]!)).toBeLessThan(centerX(flexible[middle]!))
    expect(centerX(stiff[1]!)).toBeLessThan(centerX(flexible[1]!))
    expect(centerX(medium.at(-1)!)).toBeCloseTo(centerX(flexible.at(-1)!), 12)
    expect(centerX(stiff.at(-1)!)).toBeCloseTo(centerX(flexible.at(-1)!), 12)
  })

  it('supports stiffness endpoints and rejects values outside [1, 4]', () => {
    expect(() => blade({ ...baseShape, stiffness: 1 })).not.toThrow()
    expect(() => blade({ ...baseShape, stiffness: 4 })).not.toThrow()
    expect(() => blade({ ...baseShape, stiffness: 1 - Number.EPSILON })).toThrow(
      RangeError,
    )
    expect(() =>
      blade({ ...baseShape, stiffness: 4 + Number.EPSILON * 4 }),
    ).toThrow(RangeError)
  })

  it('rejects dimensions or bend inputs that cannot produce finite geometry', () => {
    expect(() => blade({ ...baseShape, length: 0 })).toThrow(RangeError)
    expect(() => blade({ ...baseShape, width: -1 })).toThrow(RangeError)
    expect(() => blade({ ...baseShape, lean: Number.POSITIVE_INFINITY })).toThrow(
      RangeError,
    )
    expect(() => blade({ ...baseShape, stiffness: Number.NaN })).toThrow(RangeError)
  })

  it('keeps the blade generator and domain type out of the public barrel', () => {
    const surface = core as Record<string, unknown>
    expect(surface).not.toHaveProperty('blade')
    expect(surface).not.toHaveProperty('BladeShape')
  })

  it('treats rootSink 0 and absent options as the exact closed emission', () => {
    const closed = blade(baseShape)

    expect(blade(baseShape, { rootSink: 0 })).toEqual(closed)
    expect(blade(baseShape, {})).toEqual(closed)
    const leaned = { ...baseShape, lean: -0.4, stiffness: 3 }
    expect(blade(leaned, { rootSink: 0 })).toEqual(blade(leaned))
  })

  it('cuts the buried fraction open at rootSink 0.25', () => {
    const shape = { ...baseShape, lean: 0.35 }
    const outline = blade(shape, { rootSink: 0.25 })
    const tipOffset = shape.lean * shape.length
    const cutSpineX = tipOffset * 0.25 ** (shape.stiffness + 1)
    const cutHalfWidth = shape.width * (2 * 0.25 * (1 - 0.25))

    expect(outline).toHaveLength(7)
    expect(outline[0]).toEqual([cutSpineX + cutHalfWidth, 0])
    expect(outline.at(-1)).toEqual([cutSpineX - cutHalfWidth, 0])
    expect(outline[0]).not.toEqual(outline.at(-1))
    expect(outline[0]![0] - outline.at(-1)![0]).toBeCloseTo(
      2 * shape.width * (2 * 0.25 * 0.75),
      12,
    )
    expect(outline[3]).toEqual([tipOffset, -0.75 * shape.length])
    for (const point of outline) {
      expect(point.every(Number.isFinite)).toBe(true)
    }
  })

  it('deduplicates the mid station at the maximum rootSink 0.5', () => {
    const outline = blade(baseShape, { rootSink: 0.5 })
    const cutHalfWidth = baseShape.width * (2 * 0.5 * (1 - 0.5))

    expect(outline).toHaveLength(5)
    expect(outline[0]).toEqual([cutHalfWidth, 0])
    expect(outline.at(-1)).toEqual([-cutHalfWidth, 0])
    expect(outline[2]).toEqual([0, -0.5 * baseShape.length])
  })

  it('rejects rootSink values outside the finite [0, 0.5] domain', () => {
    expect(() => blade(baseShape, { rootSink: 0.5 })).not.toThrow()
    expect(() => blade(baseShape, { rootSink: -0.01 })).toThrow(RangeError)
    expect(() =>
      blade(baseShape, { rootSink: 0.5 + Number.EPSILON }),
    ).toThrow(RangeError)
    expect(() => blade(baseShape, { rootSink: Number.NaN })).toThrow(RangeError)
    expect(() =>
      blade(baseShape, { rootSink: Number.POSITIVE_INFINITY }),
    ).toThrow(RangeError)
  })
})
