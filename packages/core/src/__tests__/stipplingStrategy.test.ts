import { describe, expect, expectTypeOf, it } from 'vitest'

import * as core from '../index'
import type { CoordinateSpace } from '../scene'
import type { ShadingObserver, ShadingProgress } from '../shadingStrategy'
import {
  createShadingMask,
  type ShadingMask,
  type ToneSource,
} from '../shadingFields'
import { createStipplingModel } from '../stipplingStrategy/model'
import type { StipplingExecutionLimits } from '../stipplingStrategy/orchestrator'
import {
  defaultStipplingControls,
  resolveProductionStipplingExecutionLimits,
  runStipplingStrategyForTesting,
  stipplingControlSchema,
  stipplingStrategy,
  type StipplingResult,
  type StipplingStrategyInput,
} from '../stipplingStrategy/index'
import type { StipplingControls } from '../stipplingStrategy/types'
import type { Point, Polyline } from '../types'
import {
  constantTone,
  disconnectedIslandsMask,
  featheredBoundaryMask,
  horizontalGradientTone,
  thinZeroBarrierMask,
  whiteHoleTone,
} from './shadingFieldFixtures'

const FRAME: CoordinateSpace = Object.freeze({ width: 100, height: 100 })
const FULL_MASK = createShadingMask(() => 1)
const FAST_CONTROLS: Readonly<StipplingControls> = Object.freeze({
  stippleDensity: 0.25,
  distributionFidelity: 0,
  voronoiRelaxation: 0,
})
const PARTIAL_LIMITS: StipplingExecutionLimits = Object.freeze({
  maxStipples: 5,
  maxPlacementAttempts: 1_000,
  maxRefinementAttempts: 0,
  maxRelaxationPasses: 8,
  maxRelaxationWorkUnits: Number.MAX_SAFE_INTEGER,
})

function source(
  toneField = constantTone(0.8),
  shadingMask = FULL_MASK,
): ToneSource {
  return { toneField, shadingMask }
}

function input(
  toneSource: ToneSource = source(),
  seed: string | number = 'stipple-strategy',
  controls: Partial<StipplingControls> = {},
  frame: CoordinateSpace = FRAME,
): StipplingStrategyInput {
  return {
    source: toneSource,
    frame,
    controls: { ...FAST_CONTROLS, ...controls },
    seed,
  }
}

function center(polyline: readonly Point[]): Point {
  return [
    (polyline[0]![0] + polyline[1]![0]) / 2,
    (polyline[0]![1] + polyline[1]![1]) / 2,
  ]
}

function length(polyline: readonly Point[]): number {
  return Math.hypot(
    polyline[1]![0] - polyline[0]![0],
    polyline[1]![1] - polyline[0]![1],
  )
}

function expectValidResult(result: StipplingResult): void {
  expect(['completed', 'budget-exhausted']).toContain(result.termination)
  expect(Number.isFinite(result.distributionError)).toBe(true)
  expect(result.distributionError).toBeGreaterThanOrEqual(0)
  for (const polyline of result.polylines) {
    expect(polyline).toHaveLength(2)
    expect(polyline[0]).not.toEqual(polyline[1])
    expect(polyline.every((point) => point.every(Number.isFinite))).toBe(true)
  }
}

function expectMaskSafe(
  result: StipplingResult,
  mask: ShadingMask,
  maxSpacing = 0.025,
): void {
  for (const polyline of result.polylines) {
    const intervals = Math.ceil(length(polyline) / maxSpacing)
    for (let step = 0; step <= intervals; step++) {
      const progress = step / intervals
      const point: Point = [
        polyline[0]![0] + (polyline[1]![0] - polyline[0]![0]) * progress,
        polyline[0]![1] + (polyline[1]![1] - polyline[0]![1]) * progress,
      ]
      expect(mask.sample(point)).toBeGreaterThan(0)
    }
  }
}

function normalizedGeometry(
  polylines: readonly Polyline[],
  frame: CoordinateSpace,
): readonly (readonly (readonly [number, number])[])[] {
  return polylines.map((polyline) =>
    polyline.map(([x, y]) => [x / frame.width, y / frame.height] as const),
  )
}

describe('public Stippling strategy boundary', () => {
  it('root-exports only authored controls and public strategy contracts', () => {
    expect(core.stipplingStrategy).toBe(stipplingStrategy)
    expect(core.stipplingControlSchema).toBe(stipplingControlSchema)
    expect(core.defaultStipplingControls).toBe(defaultStipplingControls)
    expect('runStipplingStrategyForTesting' in core).toBe(false)
    expect('createStipplingModel' in core).toBe(false)
    expect('placeInitialStipples' in core).toBe(false)
    expect('refineStipples' in core).toBe(false)
    expectTypeOf<StipplingStrategyInput>().toMatchTypeOf<
      core.ShadingStrategyInput<StipplingControls>
    >()
    expectTypeOf<StipplingStrategyInput['observer']>().toEqualTypeOf<
      ShadingObserver | undefined
    >()
    expectTypeOf<core.ShadingProgress>().toEqualTypeOf<ShadingProgress>()
    expectTypeOf<StipplingResult>().toMatchTypeOf<core.ShadingResult>()
    expect(Object.keys(stipplingControlSchema)).toEqual([
      'stippleDensity',
      'distributionFidelity',
      'voronoiRelaxation',
    ])
    expect(Object.keys(defaultStipplingControls)).toEqual(
      Object.keys(stipplingControlSchema),
    )
  })

  it('derives bounded production limits that complete ordinary work', () => {
    const ordinary = createStipplingModel(
      source(constantTone(1)),
      FRAME,
      FAST_CONTROLS,
    )

    expect(resolveProductionStipplingExecutionLimits(ordinary)).toEqual({
      maxStipples: 200,
      maxPlacementAttempts: 16_000,
      maxRefinementAttempts: 0,
      maxRelaxationPasses: 8,
      maxRelaxationWorkUnits: 0,
    })
    expect(
      resolveProductionStipplingExecutionLimits({
        controls: {
          stippleDensity: 400,
          distributionFidelity: 1,
          voronoiRelaxation: 0,
        },
        lattice: { ...ordinary.lattice, averageDemand: 0.001 },
        scales: { ...ordinary.scales, targetCount: 20_000 },
      }),
    ).toEqual({
      maxStipples: 20_000,
      maxPlacementAttempts: 1_000_000,
      maxRefinementAttempts: 400_000,
      maxRelaxationPasses: 8,
      maxRelaxationWorkUnits: 0,
    })

    const relaxedLimits = resolveProductionStipplingExecutionLimits({
      controls: { ...ordinary.controls, voronoiRelaxation: 0.25 },
      lattice: ordinary.lattice,
      scales: ordinary.scales,
    })
    expect(relaxedLimits.maxRelaxationPasses).toBe(8)
    expect(relaxedLimits.maxRelaxationWorkUnits).toBeGreaterThan(0)
    expect(
      resolveProductionStipplingExecutionLimits({
        controls: {
          stippleDensity: 400,
          distributionFidelity: 0,
          voronoiRelaxation: 0,
        },
        lattice: { ...ordinary.lattice, averageDemand: 0.5 },
        scales: { ...ordinary.scales, targetCount: 160_000 },
      }),
    ).toEqual({
      maxStipples: 160_000,
      maxPlacementAttempts: 1_000_000,
      maxRefinementAttempts: 0,
      maxRelaxationPasses: 8,
      maxRelaxationWorkUnits: 0,
    })
  })

  it('materializes one finite open fixed-length two-point path per mark', () => {
    const strategyInput = input(source(constantTone(1)), 'materialization')
    const result = stipplingStrategy(strategyInput)
    const target = createStipplingModel(
      strategyInput.source,
      strategyInput.frame,
      strategyInput.controls,
    )

    expect(result.termination).toBe('completed')
    expect(result.polylines).toHaveLength(target.scales.targetCount)
    expectValidResult(result)
    for (const polyline of result.polylines) {
      expect(length(polyline)).toBeCloseTo(target.scales.stippleLength, 12)
    }
  })

  it('recomputes finite distribution error from the exact returned marks', () => {
    const strategyInput = input(
      source(horizontalGradientTone(FRAME)),
      'returned-error',
      { distributionFidelity: 0.2 },
    )
    const result = stipplingStrategy(strategyInput)
    const target = createStipplingModel(
      strategyInput.source,
      strategyInput.frame,
      strategyInput.controls,
    )
    const returnedMarks = result.polylines.map((polyline) => ({
      center: center(polyline),
      orientation: Math.atan2(
        polyline[1]![1] - polyline[0]![1],
        polyline[1]![0] - polyline[0]![0],
      ),
    }))

    expect(result.distributionError).toBeCloseTo(
      target.distributionError(returnedMarks),
      12,
    )
    expectValidResult(result)
  })
})

describe('Stippling deterministic execution and progress', () => {
  it('reproduces termination, geometry, order, progress, and diagnostics exactly', () => {
    function execute() {
      const progress: ShadingProgress[] = []
      const result = stipplingStrategy({
        ...input(source(horizontalGradientTone(FRAME)), 'repeatable', {
          distributionFidelity: 0.1,
        }),
        observer: (snapshot) => progress.push(snapshot),
      })
      return { result, progress }
    }

    const first = execute()
    expect(execute()).toEqual(first)
    expect(first.result.termination).toBe('completed')
    expect(first.progress.at(-1)).toMatchObject({
      convergence: 1,
      terminal: true,
    })
    expect(first.progress.every(Object.isFrozen)).toBe(true)
    for (let index = 1; index < first.progress.length; index++) {
      expect(first.progress[index]!.completedWorkUnits).toBeGreaterThanOrEqual(
        first.progress[index - 1]!.completedWorkUnits,
      )
      expect(first.progress[index]!.convergence).toBeGreaterThanOrEqual(
        first.progress[index - 1]!.convergence,
      )
    }
  })

  it('changes seeded placement or unbiased orientation for a different Seed', () => {
    const shared = input(source(constantTone(1)), 'seed-a')
    const first = stipplingStrategy(shared)
    const changed = stipplingStrategy({ ...shared, seed: 'seed-b' })

    expect(changed.polylines).not.toEqual(first.polylines)
    expect(changed.polylines).toHaveLength(first.polylines.length)
  })

  it('isolates observer mutation and exceptions from byte-identical output', () => {
    const strategyInput = input(source(constantTone(1)), 'observer-isolation', {
      distributionFidelity: 0.1,
    })
    const baseline = stipplingStrategy(strategyInput)
    let calls = 0
    const observed = stipplingStrategy({
      ...strategyInput,
      observer: (progress) => {
        calls++
        Reflect.set(progress, 'completedWorkUnits', -1)
        throw new Error('diagnostic observer failure')
      },
    })

    expect(calls).toBeGreaterThan(0)
    expect(JSON.stringify(observed)).toBe(JSON.stringify(baseline))
  })
})

describe('Stippling analytic demand and permission conformance', () => {
  it('places more marks in darker gradient demand and none in a white hole', () => {
    const gradient = stipplingStrategy(
      input(source(horizontalGradientTone(FRAME)), 'gradient-demand'),
    )
    const dark = gradient.polylines.filter(
      (polyline) => center(polyline)[0] >= FRAME.width / 2,
    ).length
    const light = gradient.polylines.length - dark
    const hole = stipplingStrategy(
      input(source(whiteHoleTone(FRAME)), 'white-hole'),
    )

    expect(dark).toBeGreaterThan(light)
    expect(
      hole.polylines.every((polyline) => {
        const [x, y] = center(polyline)
        return Math.hypot(x / FRAME.width - 0.5, y / FRAME.height - 0.5) > 0.15
      }),
    ).toBe(true)
  })

  it('returns no marks for exact-zero tone and scales soft permission linearly', () => {
    const empty = stipplingStrategy(input(source(constantTone(0)), 'zero-tone'))
    const withPermission = (permission: number) =>
      stipplingStrategy(
        input(
          source(
            constantTone(1),
            createShadingMask(() => permission),
          ),
          'soft-permission',
        ),
      )
    const full = withPermission(1)
    const half = withPermission(0.5)
    const quarter = withPermission(0.25)

    expect(empty).toEqual({
      polylines: [],
      termination: 'completed',
      distributionError: 0,
    })
    expect(half.polylines).toHaveLength(full.polylines.length / 2)
    expect(quarter.polylines).toHaveLength(full.polylines.length / 4)
    expect(
      [full, half, quarter].every(
        ({ termination }) => termination === 'completed',
      ),
    ).toBe(true)
  })

  it.each([
    ['thin barrier', thinZeroBarrierMask(FRAME)],
    ['disconnected islands', disconnectedIslandsMask(FRAME)],
    ['hard and feathered boundary', featheredBoundaryMask(FRAME)],
  ] as const)('never crosses exact-zero permission at a %s', (_name, mask) => {
    const result = stipplingStrategy(
      input(source(constantTone(0.8), mask), `mask-${_name}`, {
        distributionFidelity: 0.1,
      }),
    )

    expect(result.termination).toBe('completed')
    expect(result.polylines.length).toBeGreaterThan(0)
    expectMaskSafe(result, mask)
    if (_name === 'disconnected islands') {
      expect(
        result.polylines.some((polyline) => center(polyline)[0] < 40),
      ).toBe(true)
      expect(
        result.polylines.some((polyline) => center(polyline)[0] > 60),
      ).toBe(true)
    }
  })
})

describe('Stippling authored controls and frame scaling', () => {
  it('density changes abundance and spacing without changing Stipple length', () => {
    const fixture = source(constantTone(1))
    const sparse = stipplingStrategy(
      input(fixture, 'density-control', { stippleDensity: 0.25 }),
    )
    const dense = stipplingStrategy(
      input(fixture, 'density-control', { stippleDensity: 0.5 }),
    )

    expect(dense.polylines.length).toBeGreaterThan(sparse.polylines.length)
    expect(length(dense.polylines[0]!)).toBeCloseTo(
      length(sparse.polylines[0]!),
      12,
    )
  })

  it('higher fidelity preserves count and length without worsening error', () => {
    const fixture = source(horizontalGradientTone(FRAME))
    const loose = stipplingStrategy(
      input(fixture, 'fidelity-control', { distributionFidelity: 0 }),
    )
    const faithful = stipplingStrategy(
      input(fixture, 'fidelity-control', { distributionFidelity: 1 }),
    )

    expect(faithful.polylines).toHaveLength(loose.polylines.length)
    expect(faithful.distributionError).toBeLessThanOrEqual(
      loose.distributionError,
    )
    expect(length(faithful.polylines[0]!)).toBeCloseTo(
      length(loose.polylines[0]!),
      12,
    )
  })

  it('preserves normalized placement, count, termination, and error under proportional scaling', () => {
    const smallFrame = { width: 100, height: 50 }
    const largeFrame = { width: 300, height: 150 }
    const controls = { distributionFidelity: 0.2 }
    const small = stipplingStrategy(
      input(
        source(constantTone(0.8)),
        'proportional-frame',
        controls,
        smallFrame,
      ),
    )
    const large = stipplingStrategy(
      input(
        source(constantTone(0.8)),
        'proportional-frame',
        controls,
        largeFrame,
      ),
    )
    const smallNormalized = normalizedGeometry(small.polylines, smallFrame)
    const largeNormalized = normalizedGeometry(large.polylines, largeFrame)

    expect(large.termination).toBe(small.termination)
    expect(large.polylines).toHaveLength(small.polylines.length)
    expect(large.distributionError).toBeCloseTo(small.distributionError, 12)
    expect(largeNormalized).toHaveLength(smallNormalized.length)
    for (let path = 0; path < smallNormalized.length; path++) {
      for (let point = 0; point < 2; point++) {
        expect(largeNormalized[path]![point]![0]).toBeCloseTo(
          smallNormalized[path]![point]![0],
          12,
        )
        expect(largeNormalized[path]![point]![1]).toBeCloseTo(
          smallNormalized[path]![point]![1],
          12,
        )
      }
    }
    expect(length(large.polylines[0]!)).toBeCloseTo(
      length(small.polylines[0]!) * 3,
      12,
    )
  })
})

describe('Stippling completion and safety ceilings', () => {
  it('reports empty demand as one immutable terminal zero-of-zero snapshot', () => {
    const progress: ShadingProgress[] = []
    const result = stipplingStrategy({
      ...input(source(constantTone(0)), 'empty-progress'),
      observer: (snapshot) => progress.push(snapshot),
    })

    expect(result.termination).toBe('completed')
    expect(progress).toEqual([
      {
        completedWorkUnits: 0,
        totalWorkUnits: 0,
        convergence: 1,
        terminal: true,
      },
    ])
    expect(Object.isFrozen(progress[0])).toBe(true)
  })

  it('normalizes malformed controls and rejects malformed frames', () => {
    const malformed = {
      stippleDensity: Number.NaN,
      distributionFidelity: Number.POSITIVE_INFINITY,
      voronoiRelaxation: Number.NaN,
    } as StipplingControls
    const malformedResult = runStipplingStrategyForTesting(
      {
        ...input(source(constantTone(1)), 'malformed-controls'),
        controls: malformed,
      },
      PARTIAL_LIMITS,
    )
    const defaultResult = runStipplingStrategyForTesting(
      {
        ...input(source(constantTone(1)), 'malformed-controls'),
        controls: defaultStipplingControls,
      },
      PARTIAL_LIMITS,
    )

    expect(malformedResult).toEqual(defaultResult)
    for (const frame of [
      { width: 0, height: 100 },
      { width: -1, height: 100 },
      { width: Number.NaN, height: 100 },
      { width: Number.POSITIVE_INFINITY, height: 100 },
    ]) {
      expect(() =>
        stipplingStrategy(input(source(), 'bad-frame', {}, frame)),
      ).toThrow(/Stippling frame/)
    }
  })

  it('keeps missing and explicit-zero Voronoi relaxation bit-for-bit compatible', () => {
    const legacyControls = {
      stippleDensity: FAST_CONTROLS.stippleDensity,
      distributionFidelity: FAST_CONTROLS.distributionFidelity,
    } as StipplingControls
    const explicitZero = {
      ...legacyControls,
      voronoiRelaxation: 0,
    }

    const legacy = runStipplingStrategyForTesting(
      input(source(constantTone(1)), 'zero-relaxation', legacyControls),
      PARTIAL_LIMITS,
    )
    const explicit = runStipplingStrategyForTesting(
      input(source(constantTone(1)), 'zero-relaxation', explicitZero),
      PARTIAL_LIMITS,
    )

    expect(explicit).toEqual(legacy)
    expect(Object.hasOwn(legacy, 'relaxation')).toBe(false)
    expect(Object.hasOwn(explicit, 'relaxation')).toBe(false)
    expect(Object.keys(explicit)).toEqual([
      'polylines',
      'termination',
      'distributionError',
    ])
  })

  it.each([
    { ...PARTIAL_LIMITS, maxStipples: -1 },
    { ...PARTIAL_LIMITS, maxPlacementAttempts: 1.5 },
    { ...PARTIAL_LIMITS, maxRefinementAttempts: 1_000_001 },
    { ...PARTIAL_LIMITS, maxRelaxationPasses: 9 },
    { ...PARTIAL_LIMITS, maxRelaxationWorkUnits: -1 },
  ])('rejects malformed injected execution limits', (limits) => {
    expect(() =>
      runStipplingStrategyForTesting(
        input(source(constantTone(1)), 'bad-limits'),
        limits,
      ),
    ).toThrow(RangeError)
  })

  it('returns deterministic finite valid partial artwork when a tiny budget exhausts', () => {
    const execute = () =>
      runStipplingStrategyForTesting(
        input(source(constantTone(1)), 'tiny-budget'),
        PARTIAL_LIMITS,
      )
    const first = execute()

    expect(execute()).toEqual(first)
    expect(first.termination).toBe('budget-exhausted')
    expect(first.polylines).toHaveLength(PARTIAL_LIMITS.maxStipples)
    expectValidResult(first)
    expectMaskSafe(first, FULL_MASK)
    expect(Object.hasOwn(first, 'relaxation')).toBe(false)
  })

  it('exports the last complete relaxed geometry when the relaxation budget exhausts', () => {
    const limits = {
      ...resolveProductionStipplingExecutionLimits(
        createStipplingModel(source(constantTone(1)), FRAME, {
          ...FAST_CONTROLS,
          voronoiRelaxation: 0.5,
        }),
      ),
      maxRelaxationPasses: 1,
    }
    const execute = () =>
      runStipplingStrategyForTesting(
        input(source(constantTone(1)), 'partial-relaxation', {
          voronoiRelaxation: 0.5,
        }),
        limits,
      )
    const first = execute()

    expect(execute()).toEqual(first)
    expect(first.termination).toBe('budget-exhausted')
    expect(first.polylines).toHaveLength(200)
    expectValidResult(first)
    expectMaskSafe(first, FULL_MASK)
    expect(first.relaxation).toEqual({
      objective: expect.any(Number),
      requestedWorkUnits: expect.any(Number),
      completedWorkUnits: expect.any(Number),
      iterationsCompleted: 1,
      relocationsAccepted: expect.any(Number),
    })
    expect(first.relaxation!.completedWorkUnits).toBeLessThan(
      first.relaxation!.requestedWorkUnits,
    )
  })

  it('revalidates final materialized segments without regenerating', () => {
    const barrier = thinZeroBarrierMask(FRAME)
    let calls = 0

    expect(() =>
      runStipplingStrategyForTesting(
        input(source(constantTone(1), barrier), 'invalid-final'),
        PARTIAL_LIMITS,
        ({ model }) => {
          calls++
          return {
            marks: [{ center: [50, 50], orientation: 0 }],
            distributionError: model.distributionError([]),
            placementAttemptsUsed: 1,
            refinementAttemptsUsed: 0,
            termination: 'budget-exhausted',
            stopCause: 'placement-ceiling-reached',
          }
        },
      ),
    ).toThrow(/invalid geometry/)
    expect(calls).toBe(1)
  })
})
