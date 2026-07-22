import { describe, expect, it } from 'vitest'

import type { CoordinateSpace } from '../scene'
import {
  createShadingMask,
  createToneField,
  type ToneSource,
} from '../shadingFields'
import { isMaskPermittedStipple } from '../stipplingStrategy/mask'
import { createStipplingModel } from '../stipplingStrategy/model'
import {
  findStipplingSpacingConflictsForTesting,
  relocateStipplesToVoronoiCentroids,
  traceStipplingSpacingConflictDegreesForTesting,
} from '../stipplingStrategy/relocation'
import type {
  StippleMark,
  StipplingDemandLattice,
  StipplingDemandSample,
  StipplingModel,
} from '../stipplingStrategy/types'
import {
  assignStipplingVoronoi,
  type StipplingVoronoiAssignment,
} from '../stipplingStrategy/voronoi'
import type { Point } from '../types'

const FRAME: Readonly<CoordinateSpace> = Object.freeze({
  width: 10,
  height: 10,
})

function source(
  tone: (point: Readonly<Point>) => number = () => 1,
  permission: (point: Readonly<Point>) => number = () => 1,
): ToneSource {
  return Object.freeze({
    toneField: createToneField(tone),
    shadingMask: createShadingMask(permission),
  })
}

function demandSample(
  point: Point,
  demand = 1,
): Readonly<StipplingDemandSample> {
  return Object.freeze({
    point: Object.freeze(point),
    tone: demand,
    permission: demand === 0 ? 0 : 1,
    demand,
  })
}

function lattice(
  samples: readonly Readonly<StipplingDemandSample>[],
): Readonly<StipplingDemandLattice> {
  const demandSum = samples.reduce((sum, sample) => sum + sample.demand, 0)
  return Object.freeze({
    frame: FRAME,
    columns: samples.length,
    rows: samples.length === 0 ? 0 : 1,
    cellWidth: samples.length === 0 ? FRAME.width : FRAME.width / samples.length,
    cellHeight: FRAME.height,
    cellArea:
      samples.length === 0
        ? 0
        : (FRAME.width * FRAME.height) / samples.length,
    sampleCount: samples.length,
    demandSum,
    averageDemand: samples.length === 0 ? 0 : demandSum / samples.length,
    samples: Object.freeze([...samples]),
  })
}

function model(
  samples: readonly Readonly<StipplingDemandSample>[],
  options: {
    readonly toneSource?: ToneSource
    readonly minimumSpacing?: number
    readonly stippleLength?: number
    readonly distributionError?: (marks: readonly StippleMark[]) => number
  } = {},
): StipplingModel {
  const base = createStipplingModel(options.toneSource ?? source(), FRAME)
  return Object.freeze({
    ...base,
    lattice: lattice(samples),
    scales: Object.freeze({
      ...base.scales,
      minimumSpacing: options.minimumSpacing ?? 0.25,
      stippleLength: options.stippleLength ?? 0.4,
      maskCheckSpacing: 0.05,
    }),
    distributionError: options.distributionError ?? (() => 0),
  })
}

function mark(center: Point, orientation = 0): Readonly<StippleMark> {
  return Object.freeze({ center: Object.freeze(center), orientation })
}

function marks(
  entries: readonly (readonly [Point, number])[],
): readonly Readonly<StippleMark>[] {
  return Object.freeze(
    entries.map(([center, orientation]) => mark(center, orientation)),
  )
}

function solve(
  target: Readonly<StipplingModel>,
  initial: readonly Readonly<StippleMark>[],
): StipplingVoronoiAssignment {
  return assignStipplingVoronoi(target, initial)
}

function stringKeyedSpacingConflicts(
  centers: readonly Readonly<Point>[],
  minimumSpacing: number,
): Uint8Array {
  const conflicts = new Uint8Array(centers.length)
  const cells = new Map<string, number[]>()
  const minimumSpacingSquared = minimumSpacing * minimumSpacing

  for (let index = 0; index < centers.length; index++) {
    const center = centers[index]!
    if (!Number.isFinite(center[0]) || !Number.isFinite(center[1])) continue
    const cellX = Math.floor(center[0] / minimumSpacing)
    const cellY = Math.floor(center[1] / minimumSpacing)
    for (let y = cellY - 1; y <= cellY + 1; y++) {
      for (let x = cellX - 1; x <= cellX + 1; x++) {
        for (const otherIndex of cells.get(`${x},${y}`) ?? []) {
          const other = centers[otherIndex]!
          const deltaX = center[0] - other[0]
          const deltaY = center[1] - other[1]
          if (deltaX * deltaX + deltaY * deltaY < minimumSpacingSquared) {
            conflicts[index] = 1
            conflicts[otherIndex] = 1
          }
        }
      }
    }
    const key = `${cellX},${cellY}`
    const bucket = cells.get(key)
    if (bucket === undefined) cells.set(key, [index])
    else bucket.push(index)
  }

  return conflicts
}

function quadraticSpacingConflictDegrees(
  centers: readonly Readonly<Point>[],
  minimumSpacing: number,
): Uint32Array {
  const degrees = new Uint32Array(centers.length)
  const minimumSpacingSquared = minimumSpacing * minimumSpacing
  for (let index = 0; index < centers.length; index++) {
    const center = centers[index]!
    if (!Number.isFinite(center[0]) || !Number.isFinite(center[1])) continue
    for (let otherIndex = 0; otherIndex < index; otherIndex++) {
      const other = centers[otherIndex]!
      if (!Number.isFinite(other[0]) || !Number.isFinite(other[1])) continue
      const deltaX = center[0] - other[0]
      const deltaY = center[1] - other[1]
      if (deltaX * deltaX + deltaY * deltaY < minimumSpacingSquared) {
        degrees[index] = degrees[index]! + 1
        degrees[otherIndex] = degrees[otherIndex]! + 1
      }
    }
  }
  return degrees
}

function expectedConflictTrace(
  initialCenters: readonly Readonly<Point>[],
  minimumSpacing: number,
  batches: readonly (readonly (readonly [number, Readonly<Point>])[])[],
): readonly Uint32Array[] {
  const centers = [...initialCenters]
  const snapshots = [quadraticSpacingConflictDegrees(centers, minimumSpacing)]
  for (const batch of batches) {
    for (const [index, center] of batch) centers[index] = center
    snapshots.push(quadraticSpacingConflictDegrees(centers, minimumSpacing))
  }
  return snapshots
}

describe('one-pass Stipple centroid relocation', () => {
  it('matches string-keyed conflicts across boundaries and numeric extremes', () => {
    const points: readonly Readonly<Point>[] = [
      [0, 0],
      [0.249999999999, 0],
      [0.25, 0],
      [-0.000000000001, 0],
      [-0.25, 0],
      [4.9, 5],
      [5.1, 5],
      [9.75, 10],
      [10, 10],
      [1_000_000_000_000, -1_000_000_000_000],
      [Number.NaN, 5],
    ]

    for (const minimumSpacing of [0.25, 0.5, 2]) {
      for (const first of points) {
        for (const second of points) {
          for (const third of points) {
            const centers = [first, second, third]
            expect(
              findStipplingSpacingConflictsForTesting(centers, minimumSpacing),
            ).toEqual(stringKeyedSpacingConflicts(centers, minimumSpacing))
          }
        }
      }
    }
  })

  it('maintains exact conflict degrees across simultaneous move batches', () => {
    const initial: readonly Readonly<Point>[] = [
      [0, 0],
      [0.249999999999, 0],
      [0.25, 0],
      [-0.000000000001, 0],
      [-0.25, 0],
      [4.9, 5],
      [5.1, 5],
      [1_000_000_000_000, -1_000_000_000_000],
      [Number.NaN, 5],
    ]
    const batches: readonly (readonly (readonly [number, Readonly<Point>])[])[] = [
      [[6, [8, 8]], [1, [5, 5]], [3, [5.2, 5]]],
      [[8, [5.1, 5]], [7, [5.15, 5]], [0, [Number.POSITIVE_INFINITY, 0]]],
      [[0, [-0.5, -0.5]], [2, [-0.250000000001, -0.5]], [5, [1e12, -1e12]]],
    ]

    for (const minimumSpacing of [0.25, 0.5, 2]) {
      const actual = traceStipplingSpacingConflictDegreesForTesting(
        initial,
        minimumSpacing,
        batches,
      )
      const expected = expectedConflictTrace(initial, minimumSpacing, batches)
      expect(actual).toEqual(expected)
      expect(
        actual.map((degrees) => [...degrees].map((degree) => degree > 0)),
      ).toEqual(
        expected.map((degrees) => [...degrees].map((degree) => degree > 0)),
      )
    }
  })

  it('matches a quadratic oracle through deterministic randomized move sequences', () => {
    let state = 0x3890_4001
    const random = () => {
      state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0
      return state / 0x1_0000_0000
    }
    const initial = Array.from({ length: 48 }, (): Readonly<Point> =>
      Object.freeze([(random() - 0.25) * 24, (random() - 0.25) * 24]),
    )
    const batches = Array.from({ length: 120 }, (_, batchIndex) => {
      const count = 1 + Math.floor(random() * 12)
      const indices = new Set<number>()
      while (indices.size < count) indices.add(Math.floor(random() * initial.length))
      return Object.freeze(
        [...indices].reverse().map((index, moveIndex) => {
          const special = (batchIndex * 13 + moveIndex) % 37
          const center: Readonly<Point> =
            special === 0
              ? [Number.NaN, random() * 10]
              : special === 1
                ? [1e12, -1e12]
                : special === 2
                  ? [-0.5, 0.5]
                  : [(random() - 0.25) * 24, (random() - 0.25) * 24]
          return Object.freeze([index, Object.freeze(center)] as const)
        }),
      )
    })

    for (const minimumSpacing of [0.125, 0.5, 3]) {
      const actual = traceStipplingSpacingConflictDegreesForTesting(
        initial,
        minimumSpacing,
        batches,
      )
      const expected = expectedConflictTrace(initial, minimumSpacing, batches)
      expect(actual).toEqual(expected)
      expect(
        actual.map((degrees) => [...degrees].map((degree) => degree > 0)),
      ).toEqual(
        expected.map((degrees) => [...degrees].map((degree) => degree > 0)),
      )
    }
  })

  it('simultaneously improves fixed cells without changing identity or geometry', () => {
    const target = model([
      demandSample([3, 2]),
      demandSample([3, 4]),
      demandSample([7, 6]),
      demandSample([7, 8]),
    ])
    const initial = marks([
      [[1, 3], 0.25],
      [[9, 7], 1.25],
    ])
    const assignment = solve(target, initial)
    const before = JSON.stringify({ target, initial, assignment })

    const outcome = relocateStipplesToVoronoiCentroids(
      target,
      initial,
      assignment,
      0,
    )

    expect(outcome).toMatchObject({
      acceptedRelocationCount: 2,
      passAccepted: true,
      reason: 'accepted',
      distributionError: 0,
    })
    expect(outcome.normalizedObjective).toBeLessThan(
      assignment.normalizedObjective,
    )
    expect(outcome.marks.map(({ center }) => center)).toEqual([
      [3, 3],
      [7, 7],
    ])
    expect(outcome.marks.map(({ orientation }) => orientation)).toEqual([
      0.25,
      1.25,
    ])
    expect(outcome.marks).toHaveLength(initial.length)
    for (const stipple of outcome.marks) {
      const halfX = (Math.cos(stipple.orientation) * target.scales.stippleLength) / 2
      const halfY = (Math.sin(stipple.orientation) * target.scales.stippleLength) / 2
      expect(
        Math.hypot(
          stipple.center[0] + halfX - (stipple.center[0] - halfX),
          stipple.center[1] + halfY - (stipple.center[1] - halfY),
        ),
      ).toBeCloseTo(target.scales.stippleLength, 12)
    }
    expect(Object.isFrozen(outcome)).toBe(true)
    expect(Object.isFrozen(outcome.marks)).toBe(true)
    expect(JSON.stringify({ target, initial, assignment })).toBe(before)
    expect(
      relocateStipplesToVoronoiCentroids(target, initial, assignment, 0),
    ).toEqual(outcome)
  })

  it('backtracks both simultaneous proposals until minimum spacing holds', () => {
    const target = model(
      [demandSample([4.9, 5]), demandSample([5.1, 5])],
      { minimumSpacing: 2 },
    )
    const initial = marks([
      [[2, 5], 0],
      [[8, 5], Math.PI / 2],
    ])
    const outcome = relocateStipplesToVoronoiCentroids(
      target,
      initial,
      solve(target, initial),
      0,
    )

    expect(outcome.passAccepted).toBe(true)
    expect(outcome.acceptedRelocationCount).toBe(2)
    expect(outcome.marks.map(({ center }) => center)).toEqual([
      [3.45, 5],
      [6.55, 5],
    ])
    expect(
      Math.hypot(
        outcome.marks[0]!.center[0] - outcome.marks[1]!.center[0],
        outcome.marks[0]!.center[1] - outcome.marks[1]!.center[1],
      ),
    ).toBeGreaterThanOrEqual(target.scales.minimumSpacing)
  })

  it('backtracks complete strokes away from thin barriers, holes, and edges', () => {
    const cases = [
      {
        name: 'thin barrier',
        initial: mark([2, 2]),
        sample: demandSample([4, 2]),
        permission: ([x]: Readonly<Point>) =>
          x >= 3.75 && x <= 4.25 ? 0 : 1,
      },
      {
        name: 'hole',
        initial: mark([2, 5]),
        sample: demandSample([5, 5]),
        permission: ([x, y]: Readonly<Point>) =>
          Math.hypot(x - 5, y - 5) <= 0.75 ? 0 : 1,
      },
      {
        name: 'frame edge',
        initial: mark([2, 8]),
        sample: demandSample([0, 8]),
        permission: () => 1,
      },
    ]

    for (const fixture of cases) {
      const target = model([fixture.sample], {
        toneSource: source(() => 1, fixture.permission),
        stippleLength: 1,
      })
      const initial = Object.freeze([fixture.initial])
      const outcome = relocateStipplesToVoronoiCentroids(
        target,
        initial,
        solve(target, initial),
        0,
      )

      expect(outcome.passAccepted, fixture.name).toBe(true)
      expect(outcome.marks[0]!.center, fixture.name).not.toEqual(
        fixture.sample.point,
      )
      const center = outcome.marks[0]!.center
      expect(center[0], fixture.name).toBeGreaterThanOrEqual(0.5)
      expect(center[0], fixture.name).toBeLessThanOrEqual(9.5)
      expect(fixture.permission(center), fixture.name).toBeGreaterThan(0)
      expect(
        isMaskPermittedStipple(
          target.source.shadingMask,
          target.frame,
          [center[0] - 0.5, center[1]],
          [center[0] + 0.5, center[1]],
          target.scales.maskCheckSpacing,
        ),
        fixture.name,
      ).toBe(true)
    }
  })

  it('allows positive soft permission and safe moves between disconnected islands', () => {
    const target = model([demandSample([8, 5], 0.2)], {
      toneSource: source(
        () => 1,
        ([x]) => (x <= 3 ? 0.2 : x >= 7 ? 0.2 : 0),
      ),
    })
    const initial = Object.freeze([mark([2, 5], Math.PI / 2)])
    const outcome = relocateStipplesToVoronoiCentroids(
      target,
      initial,
      solve(target, initial),
      0,
    )

    expect(outcome.passAccepted).toBe(true)
    expect(outcome.marks[0]!.center).toEqual([8, 5])
  })

  it('requires positive effective demand at the proposed center', () => {
    const target = model([demandSample([6, 5])], {
      toneSource: source(([x]) => (x >= 5 ? 0 : 1)),
    })
    const initial = Object.freeze([mark([2, 5])])
    const outcome = relocateStipplesToVoronoiCentroids(
      target,
      initial,
      solve(target, initial),
      0,
    )

    expect(outcome.passAccepted).toBe(true)
    expect(outcome.marks[0]!.center).toEqual([4, 5])
  })

  it('returns exact input identity when no finite strict improvement survives', () => {
    const target = model([demandSample([2, 2])])
    const initial = Object.freeze([mark([2, 2], 0.75)])
    const assignment = solve(target, initial)
    const malformedCentroid = Object.freeze({
      ...assignment,
      cells: Object.freeze([
        Object.freeze({
          ...assignment.cells[0]!,
          centroid: Object.freeze([Number.NaN, 2] as Point),
        }),
      ]),
    })

    for (const completed of [assignment, malformedCentroid]) {
      const outcome = relocateStipplesToVoronoiCentroids(
        target,
        initial,
        completed,
        0,
      )
      expect(outcome).toMatchObject({
        marks: initial,
        acceptedRelocationCount: 0,
        normalizedObjective: completed.normalizedObjective,
        passAccepted: false,
        reason: 'no-spatial-improvement',
      })
      expect(outcome.marks).toBe(initial)
    }
  })

  it('atomically rolls back a spatially better pass that worsens distribution', () => {
    const initial = Object.freeze([mark([2, 5])])
    const target = model([demandSample([6, 5])], {
      distributionError: (candidateMarks) =>
        candidateMarks === initial ? 0.25 : 0.5,
    })
    const assignment = solve(target, initial)
    const outcome = relocateStipplesToVoronoiCentroids(
      target,
      initial,
      assignment,
      0.25,
    )

    expect(outcome).toEqual({
      marks: initial,
      acceptedRelocationCount: 0,
      normalizedObjective: assignment.normalizedObjective,
      distributionError: 0.25,
      passAccepted: false,
      reason: 'distribution-error-worsened',
    })
    expect(outcome.marks).toBe(initial)
  })

  it('backtracks a spatially better pass until distribution is preserved', () => {
    const initial = Object.freeze([mark([2, 5])])
    const target = model([demandSample([6, 5])], {
      distributionError: ([candidate]) =>
        candidate!.center[0] <= 3 ? 0.25 : 0.5,
    })
    const assignment = solve(target, initial)
    const outcome = relocateStipplesToVoronoiCentroids(
      target,
      initial,
      assignment,
      0.25,
    )

    expect(outcome).toMatchObject({
      acceptedRelocationCount: 1,
      distributionError: 0.25,
      passAccepted: true,
      reason: 'accepted',
    })
    expect(outcome.normalizedObjective).toBeLessThan(
      assignment.normalizedObjective,
    )
    expect(outcome.marks[0]!.center).toEqual([3, 5])
  })
})
