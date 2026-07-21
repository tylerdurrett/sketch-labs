import { describe, expect, it } from 'vitest'

import type { CoordinateSpace } from '../scene'
import { createShadingMask, createToneField } from '../shadingFields'
import { createStipplingModel } from '../stipplingStrategy/model'
import type {
  StippleMark,
  StipplingDemandLattice,
  StipplingDemandSample,
} from '../stipplingStrategy/types'
import { assignStipplingVoronoi } from '../stipplingStrategy/voronoi'
import type { Point } from '../types'
import {
  stipplingVoronoiReference,
  type StipplingVoronoiReferenceSample,
} from './support/stipplingVoronoiReference'

function mark(point: Readonly<Point>, orientation = 0): Readonly<StippleMark> {
  return Object.freeze({
    center: Object.freeze([point[0], point[1]] as Point),
    orientation,
  })
}

function demandSample(
  point: Readonly<Point>,
  demand: number,
): Readonly<StipplingDemandSample> {
  return Object.freeze({
    point: Object.freeze([point[0], point[1]] as Point),
    tone: demand,
    permission: demand === 0 ? 0 : 1,
    demand,
  })
}

function lattice(
  frame: Readonly<CoordinateSpace>,
  samples: readonly Readonly<StipplingDemandSample>[],
): Readonly<StipplingDemandLattice> {
  const demandSum = samples.reduce((sum, sample) => sum + sample.demand, 0)
  return Object.freeze({
    frame,
    columns: samples.length,
    rows: samples.length === 0 ? 0 : 1,
    cellWidth: samples.length === 0 ? frame.width : frame.width / samples.length,
    cellHeight: frame.height,
    cellArea:
      samples.length === 0
        ? 0
        : (frame.width / samples.length) * frame.height,
    sampleCount: samples.length,
    demandSum,
    averageDemand: samples.length === 0 ? 0 : demandSum / samples.length,
    samples: Object.freeze([...samples]),
  })
}

function solve(
  frame: Readonly<CoordinateSpace>,
  sites: readonly Readonly<Point>[],
  samples: readonly Readonly<StipplingDemandSample>[],
) {
  return assignStipplingVoronoi(
    { frame, lattice: lattice(frame, samples) },
    sites.map((site) => mark(site)),
  )
}

function referenceSamples(
  samples: readonly Readonly<StipplingDemandSample>[],
): readonly Readonly<StipplingVoronoiReferenceSample>[] {
  return samples.map(({ point, demand }) => ({ point, weight: demand }))
}

function expectReferenceMatch(
  frame: Readonly<CoordinateSpace>,
  sites: readonly Readonly<Point>[],
  samples: readonly Readonly<StipplingDemandSample>[],
): void {
  const expected = stipplingVoronoiReference(
    frame,
    sites,
    referenceSamples(samples),
  )
  const actual = solve(frame, sites, samples)

  expect(actual.assignments).toEqual(expected.assignments)
  expect(actual.cells).toEqual(expected.cells)
  expect(actual.totalWeight).toBe(expected.totalWeight)
  expect(actual.normalizedObjective).toBe(expected.normalizedObjective)
  expect(actual.work).toMatchObject({
    sampleCount: samples.length,
    assignedSampleCount:
      sites.length === 0
        ? 0
        : samples.filter((sample) => sample.demand > 0).length,
  })
}

describe('Stippling weighted Voronoi assignment', () => {
  it('matches the exhaustive oracle for flat, ramp, soft, and zero demand', () => {
    const frame = Object.freeze({ width: 10, height: 10 })
    const sites = Object.freeze([
      Object.freeze([2, 5] as Point),
      Object.freeze([8, 5] as Point),
    ])
    const samples = Object.freeze([
      demandSample([0, 5], 0),
      demandSample([1, 5], 0.1),
      demandSample([3, 5], 0.3),
      demandSample([5, 5], 0.25),
      demandSample([7, 5], 0.7),
      demandSample([9, 5], 0.9),
    ])

    expectReferenceMatch(frame, sites, samples)
    const result = solve(frame, sites, samples)
    expect(result.assignments).toEqual([null, 0, 0, 0, 1, 1])
    expect(result.work).toMatchObject({
      sampleCount: 6,
      assignedSampleCount: 5,
    })
  })

  it('keeps lower ordered-site ties stable at cell and Frame edges', () => {
    const frame = Object.freeze({ width: 12, height: 4 })
    const sites: readonly Readonly<Point>[] = [
      [8, 2],
      [4, 2],
      [0, 0],
      [12, 4],
      [4, 2],
    ]
    const samples = [
      demandSample([6, 2], 1),
      demandSample([4, 2], 0.5),
      demandSample([0, 0], 1),
      demandSample([12, 4], 1),
      demandSample([6, 0], 0.25),
    ]

    expectReferenceMatch(frame, sites, samples)
    expect(solve(frame, sites, samples).assignments).toEqual([0, 1, 2, 3, 0])
  })

  it('keeps collinear and exact-duplicate site sets oracle-exact', () => {
    const frame = Object.freeze({ width: 10, height: 10 })
    const sites: readonly Readonly<Point>[] = [
      [8, 5],
      [2, 5],
      [5, 5],
      [2, 5],
      [10, 5],
    ]
    const samples = [
      demandSample([0, 5], 1),
      demandSample([2, 5], 1),
      demandSample([3.5, 5], 1),
      demandSample([6.5, 5], 1),
      demandSample([10, 5], 1),
    ]

    expectReferenceMatch(frame, sites, samples)
    expect(solve(frame, sites, samples).assignments).toEqual([1, 1, 1, 0, 4])
  })

  it('matches the exhaustive oracle on deterministic randomized fixtures', () => {
    let state = 0x389d
    const random = (): number => {
      state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0
      return state / 0x1_0000_0000
    }

    for (let fixture = 0; fixture < 40; fixture++) {
      const frame = Object.freeze({
        width: fixture % 2 === 0 ? 37 : 1_000,
        height: fixture % 2 === 0 ? 113 : 3,
      })
      const siteCount = 1 + Math.floor(random() * 12)
      const sampleCount = 8 + Math.floor(random() * 32)
      const sites = Array.from({ length: siteCount }, () =>
        Object.freeze([
          random() * frame.width,
          random() * frame.height,
        ] as Point),
      )
      const samples = Array.from({ length: sampleCount }, () =>
        demandSample(
          [random() * frame.width, random() * frame.height],
          random() < 0.2 ? 0 : Math.floor(random() * 9) / 8,
        ),
      )

      expectReferenceMatch(frame, sites, samples)
    }
  })

  it('handles sparse and dense anisotropic site layouts exactly', () => {
    const frame = Object.freeze({ width: 1_000_000, height: 1 })
    const samples = [
      demandSample([0, 0], 1),
      demandSample([499_999, 0.5], 0.25),
      demandSample([500_001, 0.5], 0.75),
      demandSample([1_000_000, 1], 1),
    ]

    expectReferenceMatch(frame, [[500_000, 0.5]], samples)
    expectReferenceMatch(
      frame,
      Array.from({ length: 64 }, (_, index) =>
        Object.freeze([
          500_000 + (index % 8) * 1e-6,
          0.5 + Math.floor(index / 8) * 1e-6,
        ] as Point),
      ),
      samples,
    )
  })

  it('is immutable, deterministic, and scale invariant at large finite scale', () => {
    const run = (scale: number) => {
      const frame = Object.freeze({ width: 10 * scale, height: 5 * scale })
      const marks = Object.freeze([
        mark([2 * scale, 2 * scale], 0.25),
        mark([8 * scale, 2 * scale], 1.25),
      ])
      const samples = Object.freeze([
        demandSample([1 * scale, 1 * scale], 0.25),
        demandSample([4 * scale, 3 * scale], 0.5),
        demandSample([9 * scale, 4 * scale], 1),
      ])
      const model = Object.freeze({ frame, lattice: lattice(frame, samples) })
      const before = JSON.stringify({ model, marks })
      const first = assignStipplingVoronoi(model, marks)
      const second = assignStipplingVoronoi(model, marks)

      expect(first).toEqual(second)
      expect(JSON.stringify({ model, marks })).toBe(before)
      expect(Object.isFrozen(first)).toBe(true)
      expect(Object.isFrozen(first.assignments)).toBe(true)
      expect(Object.isFrozen(first.cells)).toBe(true)
      expect(Object.isFrozen(first.cells[0])).toBe(true)
      expect(Object.isFrozen(first.cells[0]!.centroid)).toBe(true)
      expect(Object.isFrozen(first.work)).toBe(true)
      return first
    }

    const ordinary = run(1)
    const huge = run(1e150)
    expect(huge.assignments).toEqual(ordinary.assignments)
    expect(huge.normalizedObjective).toBeCloseTo(
      ordinary.normalizedObjective,
      15,
    )
    expect(Number.isFinite(huge.normalizedObjective)).toBe(true)
  })

  it('matches noncollinear oracle fixtures at extreme proportional scales', () => {
    let state = 0x3895ca1e
    const random = (): number => {
      state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0
      return state / 0x1_0000_0000
    }
    const baseSites = Array.from({ length: 12 }, () =>
      Object.freeze([0.25 + random() * 11.5, 0.25 + random() * 6.5] as Point),
    )
    const baseSamples = Array.from({ length: 24 }, () => ({
      point: Object.freeze([random() * 12, random() * 7] as Point),
      demand: 0.125 + Math.floor(random() * 8) / 8,
    }))
    const solveScale = (scale: number) => {
      const frame = Object.freeze({ width: 12 * scale, height: 7 * scale })
      const sites = baseSites.map(
        ([x, y]) => Object.freeze([x * scale, y * scale] as Point),
      )
      const samples = baseSamples.map(({ point: [x, y], demand }) =>
        demandSample([x * scale, y * scale], demand),
      )
      expectReferenceMatch(frame, sites, samples)
      return solve(frame, sites, samples)
    }

    const tiny = solveScale(1e-150)
    const ordinary = solveScale(1)
    const huge = solveScale(1e150)
    expect(tiny.assignments).toEqual(ordinary.assignments)
    expect(huge.assignments).toEqual(ordinary.assignments)
    expect(tiny.normalizedObjective).toBeCloseTo(
      ordinary.normalizedObjective,
      15,
    )
    expect(huge.normalizedObjective).toBeCloseTo(
      ordinary.normalizedObjective,
      15,
    )
  })

  it('preserves tight noncollinear site clusters inside a much larger frame', () => {
    const frame = Object.freeze({ width: 1, height: 1 })
    const spacing = 2e-16
    const sites = Array.from({ length: 12 }, (_, index) =>
      Object.freeze([
        0.5 + (index % 4) * spacing,
        0.5 + Math.floor(index / 4) * spacing,
      ] as Point),
    )
    const samples = [
      demandSample([0.5, 0.5], 1),
      demandSample([0.5 + spacing * 1.4, 0.5 + spacing * 0.6], 0.75),
      demandSample([0.5 + spacing * 2.6, 0.5 + spacing * 1.4], 0.5),
      demandSample([0.5 + spacing * 3, 0.5 + spacing * 2], 0.25),
    ]

    expectReferenceMatch(frame, sites, samples)
  })

  it('preserves a tight noncollinear cluster alongside a distant outlier', () => {
    const frame = Object.freeze({ width: 1, height: 1 })
    const spacing = 2e-16
    const cluster = Array.from({ length: 12 }, (_, index) =>
      Object.freeze([
        0.25 + (index % 4) * spacing,
        0.25 + Math.floor(index / 4) * spacing,
      ] as Point),
    )
    const sites = [...cluster, Object.freeze([1, 1] as Point)]
    const samples = [
      demandSample([0.25, 0.25], 1),
      demandSample([0.25 + spacing * 1.4, 0.25 + spacing * 0.6], 0.75),
      demandSample([0.25 + spacing * 2.6, 0.25 + spacing * 1.4], 0.5),
      demandSample([1, 1], 0.25),
    ]

    expectReferenceMatch(frame, sites, samples)
  })

  it('dynamically resolves a 2e-50 cluster beside three outliers', () => {
    const frame = Object.freeze({ width: 1, height: 1 })
    const spacing = 2e-50
    const cluster = Array.from({ length: 12 }, (_, index) =>
      Object.freeze([
        5e-49 + (index % 4) * spacing,
        5e-49 + Math.floor(index / 4) * spacing,
      ] as Point),
    )
    const sites = [
      ...cluster,
      Object.freeze([1, 1] as Point),
      Object.freeze([1, 0] as Point),
      Object.freeze([0, 1] as Point),
    ]
    const samples = [
      demandSample(cluster[0]!, 1),
      demandSample(cluster[6]!, 0.75),
      demandSample(cluster[11]!, 0.5),
      demandSample([0.9, 0.9], 0.25),
    ]

    expectReferenceMatch(frame, sites, samples)
    const result = solve(frame, sites, samples)
    expect(result.assignments).toEqual([0, 6, 11, cluster.length])
    expect(
      result.assignments.filter(
        (siteIndex) => siteIndex !== null && siteIndex >= cluster.length,
      ),
    ).toEqual([cluster.length])
  })

  it('exact-scans an unrepresentable topology cluster locally', () => {
    const frame = Object.freeze({ width: 1, height: 1 })
    const spacing = 2e-155
    const cluster: readonly Readonly<Point>[] = [
      [1e-154, 1e-154],
      [1e-154 + spacing, 1e-154],
      [1e-154, 1e-154 + spacing],
      [1e-154 + spacing, 1e-154 + spacing],
    ]
    const sites = [
      ...cluster,
      Object.freeze([1, 1] as Point),
      Object.freeze([1, 0] as Point),
      Object.freeze([0, 1] as Point),
    ]
    const samples = cluster.map((point) => demandSample(point, 1))

    expectReferenceMatch(frame, sites, samples)
    const result = solve(frame, sites, samples)
    expect(result.assignments).toEqual([0, 1, 2, 3])
    expect(result.work.distanceEvaluationCount).toBeGreaterThanOrEqual(
      samples.length * 3,
    )
    expect(result.work.distanceEvaluationCount).toBeLessThanOrEqual(
      samples.length * sites.length,
    )
  })

  it('uses the density-400 bounded lattice without quadratic assignment work', () => {
    const frame = Object.freeze({ width: 1_600, height: 900 })
    const model = createStipplingModel(
      {
        toneField: createToneField(() => 1),
        shadingMask: createShadingMask(() => 1),
      },
      frame,
      { stippleDensity: 400, distributionFidelity: 0 },
    )
    const columns = 400
    const rows = 400
    const marks = Array.from({ length: columns * rows }, (_, index) => {
      const column = index % columns
      const row = Math.floor(index / columns)
      return mark([
        ((column + 0.5) / columns) * frame.width,
        ((row + 0.5) / rows) * frame.height,
      ])
    })

    const result = assignStipplingVoronoi(model, marks)
    const exhaustivePairCount = model.lattice.sampleCount * marks.length

    expect(model.lattice.sampleCount).toBeLessThanOrEqual(65_536)
    expect(model.lattice.sampleCount).toBeGreaterThan(60_000)
    expect(marks).toHaveLength(model.scales.targetCount)
    expect(result.work).toMatchObject({
      sampleCount: model.lattice.sampleCount,
      assignedSampleCount: model.lattice.sampleCount,
    })
    expect(result.work.distanceEvaluationCount).toBeLessThan(
      exhaustivePairCount / 32,
    )
    expect(result.work.indexBuildOperationCount).toBeLessThan(
      marks.length * 128,
    )
  })

  it('bounds exact work for angular shells across arbitrary interior queries', () => {
    const frame = Object.freeze({ width: 1_000, height: 1_000 })
    const center = Object.freeze([500, 500] as Point)
    const ringSites = (siteCount: number): readonly Readonly<Point>[] =>
      Array.from({ length: siteCount }, (_, siteIndex) => {
        const angle = (siteIndex / siteCount) * Math.PI * 2
        return Object.freeze([
          center[0] + Math.cos(angle) * 400,
          center[1] + Math.sin(angle) * 400,
        ] as Point)
      })
    expectReferenceMatch(
      frame,
      ringSites(128),
      [demandSample(center, 1)],
    )

    const siteCount = 160_000
    const marks = ringSites(siteCount).map((point) => mark(point))
    const uniqueInteriorSamples = Array.from({ length: 128 }, (_, index) => {
      const angle = index * Math.PI * (3 - Math.sqrt(5))
      const radius = 200 * Math.sqrt((index + 1) / 129)
      return demandSample(
        [
          center[0] + Math.cos(angle) * radius,
          center[1] + Math.sin(angle) * radius,
        ],
        1,
      )
    })
    const repeatedCenterSamples = Array.from({ length: 64 }, () =>
      demandSample(center, 1),
    )
    const samples = [
      ...uniqueInteriorSamples.slice(0, 12),
      ...repeatedCenterSamples,
      ...uniqueInteriorSamples.slice(12),
    ]
    const model = Object.freeze({ frame, lattice: lattice(frame, samples) })

    const first = assignStipplingVoronoi(model, marks)
    const second = assignStipplingVoronoi(model, marks)

    expect(first).toEqual(second)
    expect(
      new Set(first.assignments.slice(12, 12 + repeatedCenterSamples.length)),
    ).toHaveLength(1)
    expect(first.work.distanceEvaluationCount).toBeLessThan(
      samples.length * 512,
    )
    expect(first.work.indexBuildOperationCount).toBeLessThan(siteCount * 128)
  })

  it('bounds partial shells and alternating-radius wedges independent of query order', () => {
    const frame = Object.freeze({ width: 1_000, height: 1_000 })
    const center = Object.freeze([500, 500] as Point)
    const shapedSites = (
      count: number,
      startAngle: number,
      endAngle: number,
      radiusAt: (index: number) => number,
    ): readonly Readonly<Point>[] =>
      Array.from({ length: count }, (_, index) => {
        const progress = count === 1 ? 0 : index / (count - 1)
        const angle = startAngle + (endAngle - startAngle) * progress
        const radius = radiusAt(index)
        return Object.freeze([
          center[0] + Math.cos(angle) * radius,
          center[1] + Math.sin(angle) * radius,
        ] as Point)
      })
    const cases = [
      {
        sites: shapedSites(40_000, -Math.PI / 2, Math.PI / 2, () => 400),
        samples: [center, [550, 475], [600, 525], [525, 550]] as const,
      },
      {
        sites: shapedSites(40_000, 0, Math.PI / 2, () => 400),
        samples: [center, [550, 550], [625, 525], [525, 625]] as const,
      },
      {
        sites: shapedSites(40_000, -0.15, 0.15, (index) =>
          index % 2 === 0 ? 250 : 400,
        ),
        samples: [
          [825, 500],
          [700, 515],
          [875, 475],
          [760, 490],
        ] as const,
      },
    ]

    for (const fixture of cases) {
      const smallSites = fixture.sites.filter((_, index) => index % 625 === 0)
      const smallSamples = fixture.samples.map((point) =>
        demandSample(point, 1),
      )
      expectReferenceMatch(frame, smallSites, smallSamples)

      const samples = Array.from({ length: 64 }, (_, index) =>
        demandSample(fixture.samples[(index * 3) % fixture.samples.length]!, 1),
      )
      const result = solve(frame, fixture.sites, samples)
      const exhaustivePairCount = fixture.sites.length * samples.length
      expect(result.work.distanceEvaluationCount).toBeLessThan(
        exhaustivePairCount / 16,
      )
      expect(result.work.indexBuildOperationCount).toBeLessThan(
        fixture.sites.length * 128,
      )
    }
  })

  it('binary-searches large collinear sets under alternating endpoint queries', () => {
    const siteCount = 40_000
    const frame = Object.freeze({ width: siteCount - 1, height: 100 })
    const sites = Array.from({ length: siteCount }, (_, index) =>
      Object.freeze([index, 50] as Point),
    )
    const samples = Array.from({ length: 128 }, (_, index) =>
      demandSample(index % 2 === 0 ? [0, 50] : [siteCount - 1, 50], 1),
    )

    const result = solve(frame, sites, samples)

    expect(result.assignments).toEqual(
      samples.map((_, index) => (index % 2 === 0 ? 0 : siteCount - 1)),
    )
    expect(result.work.distanceEvaluationCount).toBeLessThanOrEqual(
      samples.length * 2,
    )
    expect(result.work.indexBuildOperationCount).toBeLessThan(siteCount * 128)
  })

  it('hierarchically seeds parallel rows under alternating endpoint queries', () => {
    const columns = 20_000
    const frame = Object.freeze({ width: columns - 1, height: 1 })
    const sites = [0.25, 0.75].flatMap((y) =>
      Array.from({ length: columns }, (_, x) =>
        Object.freeze([x, y] as Point),
      ),
    )
    const samples = Array.from({ length: 128 }, (_, index) =>
      demandSample(
        index % 2 === 0 ? [0, 0.25] : [columns - 1, 0.75],
        1,
      ),
    )

    const result = solve(frame, sites, samples)

    expect(result.assignments).toEqual(
      samples.map((_, index) => (index % 2 === 0 ? 0 : sites.length - 1)),
    )
    expect(result.work.distanceEvaluationCount).toBeLessThan(
      samples.length * 64,
    )
    expect(result.work.indexBuildOperationCount).toBeLessThan(
      sites.length * 128,
    )
  })

  it('adaptively seeds a narrow two-row strip despite a distant outlier', () => {
    const columns = 20_000
    const stripStart = 0.2
    const stripSpan = 1e-5
    const rowY = [0.4, 0.400_001] as const
    const frame = Object.freeze({ width: 1, height: 1 })
    const sites = [
      ...rowY.flatMap((y) =>
        Array.from({ length: columns }, (_, index) =>
          Object.freeze([
            stripStart + (index / (columns - 1)) * stripSpan,
            y,
          ] as Point),
        ),
      ),
      Object.freeze([1, 1] as Point),
    ]
    const firstColumn = Math.round((columns - 1) / 3)
    const secondColumn = Math.round(((columns - 1) * 2) / 3)
    const samples = Array.from({ length: 128 }, (_, index) =>
      demandSample(
        index % 2 === 0
          ? [stripStart + stripSpan / 3, rowY[0]]
          : [stripStart + (stripSpan * 2) / 3, rowY[1]],
        1,
      ),
    )

    const result = solve(frame, sites, samples)

    expect(result.assignments).toEqual(
      samples.map((_, index) =>
        index % 2 === 0 ? firstColumn : columns + secondColumn,
      ),
    )
    expect(result.work.distanceEvaluationCount).toBeLessThan(
      samples.length * 64,
    )
    expect(result.work.seedLookupCount).toBeLessThan(samples.length * 32)
    expect(result.work.indexBuildOperationCount).toBeLessThan(
      sites.length * 128,
    )
  })

  it('uses finite zero conventions and rejects malformed domain values', () => {
    const frame = Object.freeze({ width: 10, height: 10 })
    const zero = solve(frame, [[5, 5]], [demandSample([5, 5], 0)])
    const noSites = solve(frame, [], [demandSample([5, 5], 1)])

    expect(zero).toMatchObject({
      assignments: [null],
      totalWeight: 0,
      normalizedObjective: 0,
      work: { sampleCount: 1, assignedSampleCount: 0 },
    })
    expect(noSites).toMatchObject({
      assignments: [null],
      cells: [],
      totalWeight: 1,
      normalizedObjective: 0,
      work: {
        sampleCount: 1,
        assignedSampleCount: 0,
        distanceEvaluationCount: 0,
      },
    })
    expect(() => solve(frame, [[11, 5]], [])).toThrow(/site 0.*inside the frame/)
    expect(() =>
      solve(frame, [[5, 5]], [demandSample([5, 5], Number.NaN)]),
    ).toThrow(/sample 0 demand must be finite/)
  })
})
