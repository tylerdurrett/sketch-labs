import { describe, expect, it } from 'vitest'

import type { CoordinateSpace } from '../scene'
import type { ShadingProgress } from '../shadingStrategy'
import {
  createShadingMask,
  type ShadingMask,
  type ToneSource,
} from '../shadingFields'
import { createStipplingModel } from '../stipplingStrategy/model'
import {
  stipplingStrategy,
  type StipplingResult,
} from '../stipplingStrategy/index'
import type { StipplingControls } from '../stipplingStrategy/types'
import { assignStipplingVoronoi } from '../stipplingStrategy/voronoi'
import type { Point, Polyline } from '../types'
import {
  constantTone,
  disconnectedIslandsMask,
  horizontalGradientTone,
  thinZeroBarrierMask,
} from './shadingFieldFixtures'
import {
  minimumStippleSpacing,
  stippleCenters,
  summarizeStipplingBands,
  summarizeStipplingSpatialStats,
} from './support/stipplingSpatialStats'

const FRAME: Readonly<CoordinateSpace> = Object.freeze({
  width: 100,
  height: 100,
})
const FULL_MASK = createShadingMask(() => 1)
const FLAT_SOURCE: ToneSource = Object.freeze({
  toneField: constantTone(0.75),
  shadingMask: FULL_MASK,
})
const BASE_CONTROLS: Readonly<StipplingControls> = Object.freeze({
  stippleDensity: 0.25,
  distributionFidelity: 0.5,
  voronoiRelaxation: 0,
})
const RELAXATION_LEVELS = Object.freeze([0, 0.5, 1] as const)

const OBJECTIVE_TOLERANCE = 1e-5
const MATERIALIZATION_TOLERANCE = 1e-10
const VOID_IMPROVEMENT_TOLERANCE = 1e-3
const RAMP_BALANCE_TOLERANCE = 1e-2
const DIRECTIONAL_BIAS_TOLERANCE = 0.22

interface ObservedRun {
  readonly result: StipplingResult
  readonly progress: readonly ShadingProgress[]
}

function execute(
  source: ToneSource,
  seed: string,
  voronoiRelaxation: number,
  controls: Partial<StipplingControls> = {},
): ObservedRun {
  const progress: ShadingProgress[] = []
  const result = stipplingStrategy({
    source,
    frame: FRAME,
    seed,
    controls: {
      ...BASE_CONTROLS,
      ...controls,
      voronoiRelaxation,
    },
    observer: (snapshot) => progress.push(snapshot),
  })
  return { result, progress }
}

function markLength(polyline: Readonly<Polyline>): number {
  return Math.hypot(
    polyline[1]![0] - polyline[0]![0],
    polyline[1]![1] - polyline[0]![1],
  )
}

function markDirection(polyline: Readonly<Polyline>): Readonly<Point> {
  const length = markLength(polyline)
  return [
    (polyline[1]![0] - polyline[0]![0]) / length,
    (polyline[1]![1] - polyline[0]![1]) / length,
  ]
}

function objective(
  source: ToneSource,
  result: Readonly<StipplingResult>,
  controls: Readonly<StipplingControls>,
): number {
  const model = createStipplingModel(source, FRAME, controls)
  const marks = result.polylines.map((polyline) => ({
    center: [
      (polyline[0]![0] + polyline[1]![0]) / 2,
      (polyline[0]![1] + polyline[1]![1]) / 2,
    ] as const,
    orientation: Math.atan2(
      polyline[1]![1] - polyline[0]![1],
      polyline[1]![0] - polyline[0]![0],
    ),
  }))
  return assignStipplingVoronoi(model, marks).normalizedObjective
}

function expectFixedOrderedMarks(
  baseline: Readonly<StipplingResult>,
  candidate: Readonly<StipplingResult>,
  expectedLength: number,
): void {
  expect(candidate.polylines).toHaveLength(baseline.polylines.length)
  for (let index = 0; index < baseline.polylines.length; index++) {
    const before = baseline.polylines[index]!
    const after = candidate.polylines[index]!
    expect(markLength(after)).toBeCloseTo(expectedLength, 10)
    expect(markDirection(after)[0]).toBeCloseTo(markDirection(before)[0], 10)
    expect(markDirection(after)[1]).toBeCloseTo(markDirection(before)[1], 10)
  }
}

function expectSegmentSafe(
  result: Readonly<StipplingResult>,
  mask: ShadingMask,
): void {
  for (const polyline of result.polylines) {
    const checks = Math.ceil(markLength(polyline) / 0.025)
    for (let check = 0; check <= checks; check++) {
      const progress = check / checks
      expect(
        mask.sample([
          polyline[0]![0] + (polyline[1]![0] - polyline[0]![0]) * progress,
          polyline[0]![1] + (polyline[1]![1] - polyline[0]![1]) * progress,
        ]),
      ).toBeGreaterThan(0)
    }
  }
}

describe('quantitative Stippling relaxation integration', () => {
  it('reproduces bounded work, termination, ordered geometry, objective, and error', () => {
    const controls = BASE_CONTROLS
    const model = createStipplingModel(FLAT_SOURCE, FRAME, controls)
    const runs = RELAXATION_LEVELS.map((level) =>
      execute(FLAT_SOURCE, 'quantitative-flat', level),
    )

    for (let index = 0; index < runs.length; index++) {
      const level = RELAXATION_LEVELS[index]!
      const run = runs[index]!
      expect(execute(FLAT_SOURCE, 'quantitative-flat', level)).toEqual(run)
      expect(run.result.termination).toBe('completed')
      expect(run.progress.at(-1)).toMatchObject({
        terminal: true,
        convergence: 1,
      })
      expect(run.progress.every(Object.isFrozen)).toBe(true)
      for (let progress = 0; progress < run.progress.length; progress++) {
        const snapshot = run.progress[progress]!
        expect(Number.isSafeInteger(snapshot.completedWorkUnits)).toBe(true)
        expect(snapshot.completedWorkUnits).toBeLessThanOrEqual(
          snapshot.totalWorkUnits,
        )
        if (progress > 0) {
          expect(snapshot.completedWorkUnits).toBeGreaterThanOrEqual(
            run.progress[progress - 1]!.completedWorkUnits,
          )
        }
      }
      expectFixedOrderedMarks(
        runs[0]!.result,
        run.result,
        model.scales.stippleLength,
      )
      expect(
        minimumStippleSpacing(stippleCenters(run.result.polylines)),
      ).toBeGreaterThanOrEqual(
        model.scales.minimumSpacing - MATERIALIZATION_TOLERANCE,
      )
      expect(run.result.distributionError).toBeLessThanOrEqual(
        runs[0]!.result.distributionError,
      )
    }

    const completedWork = runs.map(
      ({ progress }) => progress.at(-1)!.completedWorkUnits,
    )
    expect(completedWork[1]).toBeGreaterThan(completedWork[0]!)
    expect(completedWork[2]).toBeGreaterThan(completedWork[1]!)
    expect(runs[1]!.result.polylines).not.toEqual(runs[0]!.result.polylines)
    expect(runs[2]!.result.polylines).not.toEqual(runs[1]!.result.polylines)
  })

  it('strictly improves the pinned flat objective and nonworsens every void metric', () => {
    const runs = RELAXATION_LEVELS.map(
      (level) => execute(FLAT_SOURCE, 'quantitative-flat', level).result,
    )
    const objectives = runs.map((result) =>
      objective(FLAT_SOURCE, result, BASE_CONTROLS),
    )
    const stats = runs.map((result) =>
      summarizeStipplingSpatialStats(FRAME, stippleCenters(result.polylines)),
    )

    for (let index = 1; index < runs.length; index++) {
      expect(objectives[index]!).toBeLessThan(
        objectives[index - 1]! - OBJECTIVE_TOLERANCE,
      )
      expect(stats[index]!.rmsVoid).toBeLessThanOrEqual(
        stats[index - 1]!.rmsVoid,
      )
      expect(stats[index]!.maximumVoid).toBeLessThanOrEqual(
        stats[index - 1]!.maximumVoid,
      )
      expect(stats[index]!.voidDispersion).toBeLessThanOrEqual(
        stats[index - 1]!.voidDispersion,
      )
      expect(stats[index]!.nearestNeighborDispersion).toBeLessThanOrEqual(
        stats[index - 1]!.nearestNeighborDispersion,
      )
    }

    expect(objectives[0]! - objectives[2]!).toBeGreaterThan(OBJECTIVE_TOLERANCE)
    expect(stats[0]!.rmsVoid - stats[2]!.rmsVoid).toBeGreaterThan(
      VOID_IMPROVEMENT_TOLERANCE,
    )
    for (const level of stats) {
      expect(level.horizontalVerticalBias).toBeLessThanOrEqual(
        DIRECTIONAL_BIAS_TOLERANCE,
      )
      expect(level.diagonalBias).toBeLessThanOrEqual(DIRECTIONAL_BIAS_TOLERANCE)
      expect(level.axisDiagonalBias).toBeLessThanOrEqual(
        DIRECTIONAL_BIAS_TOLERANCE,
      )
    }
  })

  it('changes Seed-dependent starts and results without changing authored invariants', () => {
    const firstStart = execute(FLAT_SOURCE, 'quantitative-seed-a', 0).result
    const secondStart = execute(FLAT_SOURCE, 'quantitative-seed-b', 0).result
    const firstRelaxed = execute(FLAT_SOURCE, 'quantitative-seed-a', 1).result
    const secondRelaxed = execute(FLAT_SOURCE, 'quantitative-seed-b', 1).result
    const expectedLength = createStipplingModel(
      FLAT_SOURCE,
      FRAME,
      BASE_CONTROLS,
    ).scales.stippleLength

    expect(secondStart.polylines).not.toEqual(firstStart.polylines)
    expect(secondRelaxed.polylines).not.toEqual(firstRelaxed.polylines)
    expectFixedOrderedMarks(firstStart, firstRelaxed, expectedLength)
    expectFixedOrderedMarks(secondStart, secondRelaxed, expectedLength)
    expect(secondRelaxed.polylines).toHaveLength(firstRelaxed.polylines.length)
    expect(secondRelaxed.termination).toBe(firstRelaxed.termination)
  })

  it('keeps density and Distribution refinement independent of spatial settling', () => {
    const denseControls = { stippleDensity: 0.5 }
    const sparse = execute(FLAT_SOURCE, 'quantitative-density', 1).result
    const dense = execute(
      FLAT_SOURCE,
      'quantitative-density',
      1,
      denseControls,
    ).result
    expect(dense.polylines.length).toBeGreaterThan(sparse.polylines.length)
    expect(markLength(dense.polylines[0]!)).toBeCloseTo(
      markLength(sparse.polylines[0]!),
      10,
    )

    const fidelitySource: ToneSource = {
      toneField: horizontalGradientTone(FRAME),
      shadingMask: FULL_MASK,
    }
    const looseStart = execute(fidelitySource, 'fidelity-control', 0, {
      distributionFidelity: 0,
    }).result
    const faithfulStart = execute(fidelitySource, 'fidelity-control', 0, {
      distributionFidelity: 1,
    }).result
    const looseRelaxed = execute(fidelitySource, 'fidelity-control', 1, {
      distributionFidelity: 0,
    }).result
    const faithfulRelaxed = execute(fidelitySource, 'fidelity-control', 1, {
      distributionFidelity: 1,
    }).result

    expect(faithfulStart.polylines).not.toEqual(looseStart.polylines)
    expect(faithfulRelaxed.polylines).not.toEqual(looseRelaxed.polylines)
    expect(faithfulRelaxed.polylines).toHaveLength(
      looseRelaxed.polylines.length,
    )
    expect(faithfulStart.distributionError).toBeLessThanOrEqual(
      looseStart.distributionError,
    )
    expect(looseRelaxed.distributionError).toBeLessThanOrEqual(
      looseStart.distributionError,
    )
    expect(faithfulRelaxed.distributionError).toBeLessThanOrEqual(
      faithfulStart.distributionError,
    )
    expect(faithfulRelaxed.distributionError).toBeLessThanOrEqual(
      looseRelaxed.distributionError,
    )
  })

  it('preserves analytic abundance and linear permission at maximum relaxation', () => {
    const withPermission = (permission: number) =>
      execute(
        {
          toneField: constantTone(1),
          shadingMask: createShadingMask(() => permission),
        },
        'quantitative-permission',
        1,
      ).result
    const full = withPermission(1)
    const half = withPermission(0.5)
    const quarter = withPermission(0.25)
    const empty = execute(
      { toneField: constantTone(0), shadingMask: FULL_MASK },
      'quantitative-empty',
      1,
    ).result

    expect(empty).toEqual({
      polylines: [],
      termination: 'completed',
      distributionError: 0,
    })
    expect(half.polylines).toHaveLength(full.polylines.length / 2)
    expect(quarter.polylines).toHaveLength(full.polylines.length / 4)
  })

  it.each([
    ['thin barrier', thinZeroBarrierMask(FRAME)],
    ['disconnected islands', disconnectedIslandsMask(FRAME)],
  ] as const)(
    'keeps complete relaxed segments safe across a %s',
    (name, shadingMask) => {
      const result = execute(
        { toneField: constantTone(0.8), shadingMask },
        `quantitative-${name}`,
        1,
      ).result

      expect(result.polylines.length).toBeGreaterThan(0)
      expectSegmentSafe(result, shadingMask)
      if (name === 'disconnected islands') {
        const centers = stippleCenters(result.polylines)
        expect(centers.some(([x]) => x < 40)).toBe(true)
        expect(centers.some(([x]) => x > 60)).toBe(true)
      }
    },
  )

  it('improves ramp balance while retaining strictly increasing dark-band abundance', () => {
    const source: ToneSource = Object.freeze({
      toneField: horizontalGradientTone(FRAME),
      shadingMask: FULL_MASK,
    })
    const controls: Readonly<StipplingControls> = Object.freeze({
      ...BASE_CONTROLS,
      stippleDensity: 1,
    })
    const runs = RELAXATION_LEVELS.map(
      (level) => execute(source, 'ramp-c', level, controls).result,
    )
    const stats = runs.map((result) =>
      summarizeStipplingBands(FRAME, stippleCenters(result.polylines)),
    )

    for (let level = 0; level < stats.length; level++) {
      const counts = stats[level]!.counts
      for (let band = 1; band < counts.length; band++) {
        expect(counts[band]).toBeGreaterThan(counts[band - 1]!)
      }
      if (level > 0) {
        expect(stats[level]!.spatialBalance).toBeLessThanOrEqual(
          stats[level - 1]!.spatialBalance,
        )
      }
    }
    expect(stats[0]!.spatialBalance - stats[2]!.spatialBalance).toBeGreaterThan(
      RAMP_BALANCE_TOLERANCE,
    )
    expect(
      objective(source, runs[0]!, controls) -
        objective(source, runs[2]!, controls),
    ).toBeGreaterThan(OBJECTIVE_TOLERANCE)
  })
})
