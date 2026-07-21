import { describe, expect, it } from 'vitest'

import type { CoordinateSpace } from '../scene'
import { createShadingMask, createToneField } from '../shadingFields'
import { createStipplingModel } from '../stipplingStrategy/model'
import {
  MAXIMUM_STIPPLING_RELAXATION_PASSES,
  resolveStipplingRelaxationPasses,
  resolveStipplingRelaxationWorkUnits,
  runStipplingRelaxation,
  type StipplingRelaxationProgress,
} from '../stipplingStrategy/relaxation'
import type {
  StippleMark,
  StipplingDemandLattice,
  StipplingDemandSample,
  StipplingModel,
} from '../stipplingStrategy/types'
import type { Point } from '../types'

const FRAME: Readonly<CoordinateSpace> = Object.freeze({
  width: 10,
  height: 10,
})

function sample(point: Point, demand = 1): Readonly<StipplingDemandSample> {
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
  const demandSum = samples.reduce((sum, entry) => sum + entry.demand, 0)
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
  relaxation: number,
  samples: readonly Readonly<StipplingDemandSample>[],
): Readonly<StipplingModel> {
  const source = Object.freeze({
    toneField: createToneField(() => 1),
    shadingMask: createShadingMask(() => 1),
  })
  const base = createStipplingModel(source, FRAME, {
    voronoiRelaxation: relaxation,
  })
  return Object.freeze({
    ...base,
    lattice: lattice(samples),
    scales: Object.freeze({
      ...base.scales,
      minimumSpacing: 0.01,
      stippleLength: 0.01,
      maskCheckSpacing: 0.005,
    }),
    distributionError: () => 0,
  })
}

function marks(points: readonly Point[]): readonly Readonly<StippleMark>[] {
  return Object.freeze(
    points.map((center, index) =>
      Object.freeze({
        center: Object.freeze(center),
        orientation: index * 0.25,
      }),
    ),
  )
}

const prefixSamples = Object.freeze(
  Array.from({ length: 80 }, (_, index) =>
    sample([
      0.25 + ((index * 37) % 80) * 0.118,
      0.25 + ((index * 53) % 80) * 0.118,
    ]),
  ),
)
const prefixMarks = marks([
  [0.75, 0.75],
  [1.25, 1.5],
  [2, 2.25],
  [2.5, 2.75],
  [3.25, 3.5],
  [7.75, 7.25],
  [8.5, 8],
  [9.25, 9.25],
])

describe('Stippling relaxation work mapping', () => {
  it('maps zero to bypass and every positive control to 1..8 passes', () => {
    expect(resolveStipplingRelaxationPasses(0)).toBe(0)
    expect(resolveStipplingRelaxationPasses(Number.MIN_VALUE)).toBe(1)
    expect(resolveStipplingRelaxationPasses(0.125)).toBe(1)
    expect(resolveStipplingRelaxationPasses(0.125000001)).toBe(2)
    expect(resolveStipplingRelaxationPasses(0.5)).toBe(4)
    expect(resolveStipplingRelaxationPasses(1)).toBe(
      MAXIMUM_STIPPLING_RELAXATION_PASSES,
    )

    for (const invalid of [-0.01, 1.01, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => resolveStipplingRelaxationPasses(invalid)).toThrow(
        RangeError,
      )
    }
  })

  it('keeps the zero control out of the relaxation entry point', () => {
    expect(() =>
      runStipplingRelaxation({
        model: model(0, []),
        marks: Object.freeze([]),
        distributionError: 0,
        limits: { maxPasses: MAXIMUM_STIPPLING_RELAXATION_PASSES },
      }),
    ).toThrow('requires positive Voronoi relaxation')
  })

  it('exposes the exact composable sample, evaluation, and candidate work', () => {
    const target = model(1, [
      sample([1, 1]),
      sample([2, 2], 0),
      sample([3, 3], 0.5),
    ])

    // 3 samples considered + 2 positive-demand evaluations + 4 candidates.
    expect(resolveStipplingRelaxationWorkUnits(target, 4, 3)).toBe(9 * 3)
    expect(resolveStipplingRelaxationWorkUnits(target, 0, 3)).toBe(3 * 3)
  })
})

describe('complete Stippling relaxation scheduling', () => {
  it('makes lower authored effort an exact retained and observed prefix', () => {
    const execute = (relaxation: number) => {
      const progress: StipplingRelaxationProgress[] = []
      const outcome = runStipplingRelaxation({
        model: model(relaxation, prefixSamples),
        marks: prefixMarks,
        distributionError: 0,
        limits: { maxPasses: MAXIMUM_STIPPLING_RELAXATION_PASSES },
        observer: (snapshot) => progress.push(snapshot),
      })
      return { outcome, progress }
    }

    const lower = execute(0.25)
    const higher = execute(0.5)

    expect(lower.outcome.iterationsCompleted).toBe(2)
    expect(higher.outcome.iterationsCompleted).toBe(4)
    expect(higher.progress.slice(0, lower.progress.length)).toEqual(
      lower.progress,
    )
    expect(higher.outcome.completedWorkUnits).toBe(
      lower.outcome.completedWorkUnits * 2,
    )
    expect(lower.outcome.requestedWorkUnits).toBe(
      lower.outcome.completedWorkUnits,
    )
    expect(higher.outcome.requestedWorkUnits).toBe(
      higher.outcome.completedWorkUnits,
    )
    expect(higher.progress.map(({ objective }) => objective)).toEqual(
      [...higher.progress.map(({ objective }) => objective)].sort(
        (first, second) => second - first,
      ),
    )
  })

  it('applies injected ceilings only between complete retainable passes', () => {
    const execute = (maxPasses: number) => {
      const progress: StipplingRelaxationProgress[] = []
      const outcome = runStipplingRelaxation({
        model: model(1, prefixSamples),
        marks: prefixMarks,
        distributionError: 0,
        limits: { maxPasses },
        observer: (snapshot) => progress.push(snapshot),
      })
      return { outcome, progress }
    }

    const limited = execute(2)
    const complete = execute(MAXIMUM_STIPPLING_RELAXATION_PASSES)

    expect(limited.outcome).toMatchObject({
      iterationsCompleted: 2,
      termination: 'budget-exhausted',
      stopCause: 'pass-ceiling-reached',
    })
    expect(complete.progress.slice(0, limited.progress.length)).toEqual(
      limited.progress,
    )
    expect(limited.outcome.marks).toEqual(
      runStipplingRelaxation({
        model: model(0.25, prefixSamples),
        marks: prefixMarks,
        distributionError: 0,
        limits: { maxPasses: MAXIMUM_STIPPLING_RELAXATION_PASSES },
      }).marks,
    )
  })

  it('reports exact stable work and isolates observer errors and mutation', () => {
    const snapshots: StipplingRelaxationProgress[] = []
    const target = model(0.25, prefixSamples)
    const expectedPassWork =
      target.lattice.sampleCount * 2 + prefixMarks.length

    const outcome = runStipplingRelaxation({
      model: target,
      marks: prefixMarks,
      distributionError: 0,
      limits: { maxPasses: MAXIMUM_STIPPLING_RELAXATION_PASSES },
      observer: (snapshot) => {
        snapshots.push(snapshot)
        expect(Object.isFrozen(snapshot)).toBe(true)
        Reflect.set(snapshot, 'completedWorkUnits', -1)
        throw new Error('diagnostic failure')
      },
    })

    expect(outcome.completedWorkUnits).toBe(expectedPassWork * 2)
    expect(outcome.requestedWorkUnits).toBe(expectedPassWork * 2)
    expect(snapshots.map(({ completedWorkUnits }) => completedWorkUnits)).toEqual([
      expectedPassWork,
      expectedPassWork * 2,
    ])
    expect(new Set(snapshots.map(({ totalWorkUnits }) => totalWorkUnits))).toEqual(
      new Set([expectedPassWork * MAXIMUM_STIPPLING_RELAXATION_PASSES]),
    )
  })

  it('terminates finite and stable on empty and already-settled inputs', () => {
    const cases = [
      {
        target: model(1, []),
        initial: Object.freeze([]) as readonly Readonly<StippleMark>[],
      },
      {
        target: model(1, [sample([5, 5])]),
        initial: marks([[5, 5]]),
      },
    ]

    for (const fixture of cases) {
      const first = runStipplingRelaxation({
        model: fixture.target,
        marks: fixture.initial,
        distributionError: 0,
        limits: { maxPasses: MAXIMUM_STIPPLING_RELAXATION_PASSES },
      })
      const second = runStipplingRelaxation({
        model: fixture.target,
        marks: fixture.initial,
        distributionError: 0,
        limits: { maxPasses: MAXIMUM_STIPPLING_RELAXATION_PASSES },
      })

      expect(first).toEqual(second)
      expect(first).toMatchObject({
        marks: fixture.initial,
        iterationsCompleted: 1,
        relocationsAccepted: 0,
        objective: 0,
        termination: 'completed',
        stopCause: 'no-improvement',
      })
      expect(first.marks).toBe(fixture.initial)
      expect(Number.isFinite(first.objective)).toBe(true)
      expect(Number.isFinite(first.distributionError)).toBe(true)
    }
  })

  it('charges no relocation candidates when zero demand skips relocation', () => {
    const target = model(1, [
      sample([1, 1], 0),
      sample([5, 5], 0),
      sample([9, 9], 0),
    ])
    const initial = marks([
      [2, 2],
      [8, 8],
    ])
    const progress: StipplingRelaxationProgress[] = []

    const outcome = runStipplingRelaxation({
      model: target,
      marks: initial,
      distributionError: 0,
      limits: { maxPasses: MAXIMUM_STIPPLING_RELAXATION_PASSES },
      observer: (snapshot) => progress.push(snapshot),
    })

    expect(resolveStipplingRelaxationWorkUnits(target, initial.length, 1)).toBe(
      target.lattice.sampleCount,
    )
    expect(outcome).toMatchObject({
      marks: initial,
      requestedWorkUnits:
        target.lattice.sampleCount * MAXIMUM_STIPPLING_RELAXATION_PASSES,
      completedWorkUnits: target.lattice.sampleCount,
      iterationsCompleted: 1,
      relocationsAccepted: 0,
      objective: 0,
      stopCause: 'no-improvement',
    })
    expect(progress).toEqual([
      {
        completedWorkUnits: target.lattice.sampleCount,
        totalWorkUnits:
          target.lattice.sampleCount * MAXIMUM_STIPPLING_RELAXATION_PASSES,
        iterationsCompleted: 1,
        objective: 0,
      },
    ])
  })
})
