import { describe, expect, it } from 'vitest'

import {
  fitWatercolorBoundaryCurves,
  WATERCOLOR_BOUNDARY_MAX_DEVIATION,
  type WatercolorBoundaryCurveOptions,
} from '../sketches/watercolor-forms/curves'
import type { WatercolorBoundaryPath } from '../sketches/watercolor-forms/types'
import type { Point } from '../types'

function boundaryPath(
  points: readonly Readonly<Point>[],
  id = 0,
  closed = false,
): Readonly<WatercolorBoundaryPath> {
  return Object.freeze({
    points: Object.freeze(points.map((point) => Object.freeze([...point] as Point))),
    closed,
    boundarySegmentIds: Object.freeze(
      Array.from(
        { length: Math.max(1, closed ? points.length : points.length - 1) },
        (_, index) => id + index,
      ),
    ),
  })
}

function options(
  overrides: Partial<WatercolorBoundaryCurveOptions> = {},
): Readonly<WatercolorBoundaryCurveOptions> {
  return {
    latticeWidth: 40,
    latticeHeight: 16,
    ...overrides,
  }
}

function pointSegmentDistance(
  point: Readonly<Point>,
  start: Readonly<Point>,
  end: Readonly<Point>,
): number {
  const dx = end[0] - start[0]
  const dy = end[1] - start[1]
  const lengthSquared = dx * dx + dy * dy
  const amount =
    lengthSquared === 0
      ? 0
      : Math.max(
          0,
          Math.min(
            1,
            ((point[0] - start[0]) * dx +
              (point[1] - start[1]) * dy) /
              lengthSquared,
          ),
        )
  return Math.hypot(
    point[0] - (start[0] + dx * amount),
    point[1] - (start[1] + dy * amount),
  )
}

function distanceToPath(
  point: Readonly<Point>,
  path: readonly Readonly<Point>[],
  closed = false,
): number {
  const segmentCount = closed ? path.length : path.length - 1
  let nearest = Number.POSITIVE_INFINITY
  for (let index = 0; index < segmentCount; index += 1) {
    nearest = Math.min(
      nearest,
      pointSegmentDistance(
        point,
        path[index]!,
        path[(index + 1) % path.length]!,
      ),
    )
  }
  return nearest
}

function resampleAtFixedSpacing(
  points: readonly Readonly<Point>[],
  spacing: number,
): readonly Readonly<Point>[] {
  const cumulative = [0]
  for (let index = 1; index < points.length; index += 1) {
    cumulative.push(
      cumulative.at(-1)! +
        Math.hypot(
          points[index]![0] - points[index - 1]![0],
          points[index]![1] - points[index - 1]![1],
        ),
    )
  }
  const total = cumulative.at(-1)!
  const samples: Point[] = []
  let segment = 0
  for (let distance = 0; distance < total; distance += spacing) {
    while (
      segment + 1 < cumulative.length - 1 &&
      cumulative[segment + 1]! < distance
    ) {
      segment += 1
    }
    const segmentLength =
      cumulative[segment + 1]! - cumulative[segment]!
    const amount =
      segmentLength === 0
        ? 0
        : (distance - cumulative[segment]!) / segmentLength
    samples.push([
      points[segment]![0] +
        (points[segment + 1]![0] - points[segment]![0]) * amount,
      points[segment]![1] +
        (points[segment + 1]![1] - points[segment]![1]) * amount,
    ])
  }
  samples.push([...points.at(-1)!] as Point)
  return samples
}

function fixedSpacingTurnEnergy(
  points: readonly Readonly<Point>[],
  spacing = 0.25,
): number {
  const samples = resampleAtFixedSpacing(points, spacing)
  let energy = 0
  for (let index = 1; index + 1 < samples.length; index += 1) {
    const previous = samples[index - 1]!
    const current = samples[index]!
    const next = samples[index + 1]!
    const first = Math.atan2(
      current[1] - previous[1],
      current[0] - previous[0],
    )
    const second = Math.atan2(next[1] - current[1], next[0] - current[0])
    let turn = second - first
    while (turn > Math.PI) turn -= Math.PI * 2
    while (turn < -Math.PI) turn += Math.PI * 2
    energy += turn * turn
  }
  return energy
}

function sampledCurvePoints(
  points: readonly Readonly<Point>[],
): readonly Readonly<Point>[] {
  const sampled: Point[] = []
  for (let index = 1; index < points.length; index += 1) {
    const start = points[index - 1]!
    const end = points[index]!
    const count = Math.max(
      1,
      Math.ceil(
        Math.hypot(end[0] - start[0], end[1] - start[1]) / 0.05,
      ),
    )
    for (let step = 0; step <= count; step += 1) {
      sampled.push([
        start[0] + (end[0] - start[0]) * (step / count),
        start[1] + (end[1] - start[1]) * (step / count),
      ])
    }
  }
  return sampled
}

function pathEntersCellInterior(
  points: readonly Readonly<Point>[],
  cellX: number,
  cellY: number,
): boolean {
  for (let index = 1; index < points.length; index += 1) {
    const start = points[index - 1]!
    const end = points[index]!
    const amounts = [0, 1]
    for (const boundary of [cellX, cellX + 1]) {
      if (end[0] !== start[0]) {
        const amount = (boundary - start[0]) / (end[0] - start[0])
        if (amount > 0 && amount < 1) amounts.push(amount)
      }
    }
    for (const boundary of [cellY, cellY + 1]) {
      if (end[1] !== start[1]) {
        const amount = (boundary - start[1]) / (end[1] - start[1])
        if (amount > 0 && amount < 1) amounts.push(amount)
      }
    }
    amounts.sort((first, second) => first - second)
    for (let amountIndex = 1; amountIndex < amounts.length; amountIndex += 1) {
      const amount = (amounts[amountIndex - 1]! + amounts[amountIndex]!) / 2
      const point = interpolateForTest(start, end, amount)
      if (
        point[0] > cellX &&
        point[0] < cellX + 1 &&
        point[1] > cellY &&
        point[1] < cellY + 1
      ) {
        return true
      }
    }
  }
  return false
}

function interpolateForTest(
  start: Readonly<Point>,
  end: Readonly<Point>,
  amount: number,
): Point {
  return [
    start[0] + (end[0] - start[0]) * amount,
    start[1] + (end[1] - start[1]) * amount,
  ]
}

describe('Watercolor Forms bounded curve fitting', () => {
  it('damps a diagonal lattice staircase at authored midpoint smoothing', () => {
    const points: Point[] = []
    for (let coordinate = 1; coordinate <= 30; coordinate += 1) {
      points.push(
        [coordinate, coordinate],
        [coordinate, coordinate + 1],
      )
    }
    points.push([31, 31])
    const staircase = boundaryPath(points)
    const lattice = options({
      latticeWidth: 40,
      latticeHeight: 40,
      positiveSupport: Array<boolean>(40 * 40).fill(true),
    })

    const [curve] = fitWatercolorBoundaryCurves(
      [staircase],
      0.5,
      lattice,
    )

    expect(curve!.closed).toBe(false)
    expect(curve!.boundarySegmentIds).toEqual(
      staircase.boundarySegmentIds,
    )
    expect(curve!.points[0]).toEqual(staircase.points[0])
    expect(curve!.points.at(-1)).toEqual(staircase.points.at(-1))
    // A straight line has zero turn energy. A quarter radian-squared permits
    // the two bounded endpoint transitions while rejecting the visible
    // periodic left-right heading oscillation of the two-pass lattice fit.
    expect(fixedSpacingTurnEnergy(curve!.points, 0.5)).toBeLessThanOrEqual(
      0.25,
    )
    for (const point of sampledCurvePoints(curve!.points)) {
      expect(distanceToPath(point, staircase.points)).toBeLessThanOrEqual(
        WATERCOLOR_BOUNDARY_MAX_DEVIATION + 1e-9,
      )
    }
    expect(
      fitWatercolorBoundaryCurves([staircase], 0.5, lattice),
    ).toEqual([curve])
  })

  it(
    'strictly simplifies and lowers roughness on a multiperiod wavy path',
    () => {
      const points: Point[] = []
      for (let index = 0; index <= 160; index += 1) {
        const x = 2 + index * 0.2
        points.push([
          x,
          8 +
            Math.sin((x * Math.PI * 2) / 5) * 1.1 +
            (index % 2 === 0 ? -0.1 : 0.1),
        ])
      }
      const source = boundaryPath(points)

      const unsmoothed = fitWatercolorBoundaryCurves(
        [source],
        0,
        options(),
      )[0]!
      const smoothed = fitWatercolorBoundaryCurves([source], 1, options())[0]!

      expect(smoothed.points.length).toBeLessThan(unsmoothed.points.length)
      expect(fixedSpacingTurnEnergy(smoothed.points)).toBeLessThan(
        fixedSpacingTurnEnergy(unsmoothed.points),
      )
      for (const point of sampledCurvePoints(smoothed.points)) {
        expect(distanceToPath(point, source.points)).toBeLessThanOrEqual(
          WATERCOLOR_BOUNDARY_MAX_DEVIATION + 1e-9,
        )
      }
      expect(smoothed.points[0]).toEqual(source.points[0])
      expect(smoothed.points.at(-1)).toEqual(source.points.at(-1))
      expect(
        fitWatercolorBoundaryCurves([source], 1, options()),
      ).toEqual([smoothed])
    },
  )

  it('keeps complexity nested and preserves separate open arcs', () => {
    const first = boundaryPath([
      [1, 2],
      [2, 2.1],
      [3, 1.9],
      [4, 2.1],
      [5, 2],
    ], 10)
    const second = boundaryPath([
      [5.01, 2],
      [6, 2.1],
      [7, 2],
    ], 20)
    const counts = [0, 0.25, 0.5, 0.75, 1].map((smoothing) => {
      const curves = fitWatercolorBoundaryCurves(
        [first, second],
        smoothing,
        options(),
      )
      expect(curves).toHaveLength(2)
      expect(curves[0]!.points[0]).toEqual(first.points[0])
      expect(curves[0]!.points.at(-1)).toEqual(first.points.at(-1))
      expect(curves[1]!.points[0]).toEqual(second.points[0])
      expect(curves[1]!.points.at(-1)).toEqual(second.points.at(-1))
      expect(curves[0]!.boundarySegmentIds).toEqual(first.boundarySegmentIds)
      expect(curves[1]!.boundarySegmentIds).toEqual(second.boundarySegmentIds)
      return curves.reduce((sum, curve) => sum + curve.points.length, 0)
    })
    expect(counts).toEqual([...counts].sort((a, b) => b - a))
  })

  it('preserves closed seams and keeps rounded lattice corners inside the tube', () => {
    const square = boundaryPath([
      [3, 3],
      [8, 3],
      [8, 8],
      [3, 8],
      [3, 3],
    ], 0, true)
    const [curve] = fitWatercolorBoundaryCurves([square], 1, options())

    expect(curve!.closed).toBe(true)
    expect(curve!.points).toHaveLength(square.points.length)
    expect(curve!.points[0]).toEqual(curve!.points.at(-1))
    for (const point of sampledCurvePoints(curve!.points)) {
      expect(
        distanceToPath(point, square.points.slice(0, -1), true),
      ).toBeLessThanOrEqual(WATERCOLOR_BOUNDARY_MAX_DEVIATION + 1e-9)
    }
  })

  it('honors positive support, including supported sides of alpha holes', () => {
    const width = 8
    const height = 8
    const support = Array<boolean>(width * height).fill(true)
    for (let y = 3; y <= 4; y += 1) {
      for (let x = 3; x <= 4; x += 1) support[y * width + x] = false
    }
    const lattice = options({
      latticeWidth: width,
      latticeHeight: height,
      positiveSupport: support,
    })
    const holeBoundary = boundaryPath([
      [3, 3],
      [5, 3],
      [5, 5],
      [3, 5],
    ], 0, true)
    const unsupportedInterior = boundaryPath([
      [3.25, 3.25],
      [4.75, 4.75],
    ], 10)

    const curves = fitWatercolorBoundaryCurves(
      [holeBoundary, unsupportedInterior],
      1,
      lattice,
    )
    const unconstrained = fitWatercolorBoundaryCurves(
      [holeBoundary],
      1,
      options({ latticeWidth: width, latticeHeight: height }),
    )

    expect(curves).toHaveLength(1)
    expect(curves[0]!.closed).toBe(true)
    expect(curves[0]!.points).toEqual(holeBoundary.points)
    expect(unconstrained[0]!.points).not.toEqual(holeBoundary.points)
  })

  it('detects even a short segment clip through an unsupported cell', () => {
    const support = Array<boolean>(9).fill(true)
    support[4] = false
    const crossing = boundaryPath([
      [0, 2.01],
      [2.01, 0],
    ])

    expect(
      fitWatercolorBoundaryCurves(
        [crossing],
        0,
        options({
          latticeWidth: 3,
          latticeHeight: 3,
          positiveSupport: support,
        }),
      ),
    ).toEqual([])
  })

  it('does not round a lattice staircase through unsupported corner support', () => {
    const width = 35
    const height = 35
    const support = Array<boolean>(width * height).fill(true)
    support[3 * width + 1] = false
    const staircase = boundaryPath([
      [1, 1],
      [1, 2],
      [2, 2],
      [2, 3],
      [2, 4],
      [3, 4],
      [3, 5],
      [3, 6],
      [4, 6],
      [4, 7],
    ])

    const [curve] = fitWatercolorBoundaryCurves(
      [staircase],
      1,
      options({
        latticeWidth: width,
        latticeHeight: height,
        positiveSupport: support,
      }),
    )

    expect(pathEntersCellInterior(curve!.points, 1, 3)).toBe(false)
    expect(curve!.points[0]).toEqual(staircase.points[0])
    expect(curve!.points.at(-1)).toEqual(staircase.points.at(-1))
  })

  it('retains a valid maximum-width path before following short paths', () => {
    const long = boundaryPath([
      [0, 0],
      [256, 0],
    ])
    const short = boundaryPath([
      [1, 1],
      [2, 1],
    ], 10)
    const curves = fitWatercolorBoundaryCurves(
      [long, short],
      0,
      options({ latticeWidth: 256, latticeHeight: 256 }),
    )

    expect(curves).toHaveLength(2)
    expect(curves[0]!.points).toEqual(long.points)
    expect(curves[1]!.points).toEqual(short.points)
  })

  it('emits only a complete deterministic path prefix at the point cap', () => {
    const paths = [
      boundaryPath([[1, 1], [2, 1]], 0),
      boundaryPath([[3, 1], [4, 1], [5, 1]], 10),
      boundaryPath([[6, 1], [7, 1]], 20),
    ]

    expect(
      fitWatercolorBoundaryCurves(
        paths,
        0,
        options({ maxPointCount: 4 }),
      ).map(({ boundarySegmentIds }) => boundarySegmentIds),
    ).toEqual([paths[0]!.boundarySegmentIds])
    expect(
      fitWatercolorBoundaryCurves(
        paths,
        0,
        options({ maxPointCount: 4 }),
      ),
    ).toEqual(
      fitWatercolorBoundaryCurves(
        paths,
        0,
        options({ maxPointCount: 4 }),
      ),
    )
  })

  it('fails closed for invalid top-level inputs and skips malformed paths', () => {
    const valid = boundaryPath([[1, 1], [2, 1]], 10)
    const nonFinite = boundaryPath([[1, 1], [Number.NaN, 2]], 20)

    expect(
      fitWatercolorBoundaryCurves([nonFinite, valid], 0, options()),
    ).toHaveLength(1)
    expect(
      fitWatercolorBoundaryCurves([valid], Number.NaN, options()),
    ).toEqual([])
    expect(
      fitWatercolorBoundaryCurves(
        [valid],
        0,
        options({ positiveSupport: [true] }),
      ),
    ).toEqual([])
    expect(
      fitWatercolorBoundaryCurves(
        [boundaryPath([[1, 1], [1, 1]])],
        1,
        options(),
      ),
    ).toEqual([])

    const [curve] = fitWatercolorBoundaryCurves([valid], 0, options())
    expect(
      curve!.points.every(
        ([x, y]) => Number.isFinite(x) && Number.isFinite(y),
      ),
    ).toBe(true)
    expect(Object.isFrozen(curve)).toBe(true)
    expect(Object.isFrozen(curve!.points)).toBe(true)
    expect(Object.isFrozen(curve!.points[0])).toBe(true)
  })
})
