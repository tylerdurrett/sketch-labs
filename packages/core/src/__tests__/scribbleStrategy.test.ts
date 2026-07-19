import { describe, expect, expectTypeOf, it } from 'vitest'

import * as core from '../index'
import { totalPathLength } from '../shadingStrategy'
import { createShadingMask, type ToneSource } from '../shadingFields'
import {
  defaultScribbleControls,
  resolveProductionScribbleExecutionLimits,
  runScribbleStrategyForTesting,
  scribbleControlSchema,
  scribbleStrategy,
  type ScribbleObserver,
  type ScribbleProgress,
  type ScribbleResult,
  type ScribbleStrategyInput,
} from '../scribbleStrategy/index'
import { createScribbleModel } from '../scribbleStrategy/model'
import type { ScribbleExecutionLimits } from '../scribbleStrategy/orchestrator'
import type { ScribbleControls } from '../scribbleStrategy/types'
import type { Point, Polyline } from '../types'
import {
  constantTone,
  disconnectedIslandsMask,
  featheredBoundaryMask,
  horizontalGradientTone,
  thinZeroBarrierMask,
  whiteHoleTone,
} from './shadingFieldFixtures'

const FRAME = { width: 100, height: 100 }
const FULL_MASK = createShadingMask(() => 1)
const TINY_LIMITS: ScribbleExecutionLimits = {
  maxAcceptedSegments: 1,
  maxPolylines: 1,
  maxStagnations: 1,
  maxRestarts: 0,
}

function input(
  source: ToneSource,
  seed: string | number = 'strategy-seed',
  controls: Partial<ScribbleControls> = {},
  frame = FRAME,
): ScribbleStrategyInput {
  return {
    source,
    frame,
    controls: { ...defaultScribbleControls, ...controls },
    seed,
  }
}

function source(
  toneField = constantTone(0.8),
  shadingMask = FULL_MASK,
): ToneSource {
  return { toneField, shadingMask }
}

function points(polylines: readonly Polyline[]): Point[] {
  return polylines.flatMap((polyline) => polyline)
}

function segmentCount(result: ScribbleResult): number {
  return result.polylines.reduce(
    (sum, polyline) => sum + Math.max(0, polyline.length - 1),
    0,
  )
}

function meanSegmentLength(result: ScribbleResult): number {
  return totalPathLength(result.polylines) / segmentCount(result)
}

function maximumTurn(polyline: readonly Point[]): number {
  let maximum = 0
  for (let index = 2; index < polyline.length; index++) {
    const start = polyline[index - 2]!
    const corner = polyline[index - 1]!
    const end = polyline[index]!
    const incoming = Math.atan2(
      corner[1] - start[1],
      corner[0] - start[0],
    )
    const outgoing = Math.atan2(end[1] - corner[1], end[0] - corner[0])
    maximum = Math.max(
      maximum,
      Math.abs(
        Math.atan2(
          Math.sin(outgoing - incoming),
          Math.cos(outgoing - incoming),
        ),
      ),
    )
  }
  return maximum
}

function expectValidResult(result: ScribbleResult): void {
  expect(['completed', 'budget-exhausted']).toContain(result.termination)
  expect(Number.isFinite(result.residualError)).toBe(true)
  expect(result.residualError).toBeGreaterThanOrEqual(0)
  expect(result.residualError).toBeLessThanOrEqual(1)
  for (const polyline of result.polylines) {
    expect(polyline.length).toBeGreaterThanOrEqual(2)
    for (const point of polyline) {
      expect(point.every(Number.isFinite)).toBe(true)
    }
  }
}

function independentlyMaskSafe(
  candidate: ScribbleResult,
  sourceInput: ToneSource,
  spacing: number,
): boolean {
  for (const polyline of candidate.polylines) {
    for (let index = 1; index < polyline.length; index++) {
      const start = polyline[index - 1]!
      const end = polyline[index]!
      const intervals = Math.max(
        1,
        Math.ceil(Math.hypot(end[0] - start[0], end[1] - start[1]) / spacing),
      )
      for (let step = 0; step <= intervals; step++) {
        const progress = step / intervals
        const point: Point = [
          start[0] + (end[0] - start[0]) * progress,
          start[1] + (end[1] - start[1]) * progress,
        ]
        if (sourceInput.shadingMask.sample(point) === 0) return false
      }
    }
  }
  return true
}

describe('public Scribble strategy boundary', () => {
  it('gives production work the raised hard ceilings', () => {
    expect(
      resolveProductionScribbleExecutionLimits({
        controls: { pathDensity: 20 },
        lattice: { sampleCount: 100_000 },
      }),
    ).toEqual({
      maxAcceptedSegments: 1_000_000,
      maxPolylines: 16_000,
      maxStagnations: 32_000,
      maxRestarts: 16_000,
    })
  })

  it('keeps ordinary production work proportional to weighted samples', () => {
    expect(
      resolveProductionScribbleExecutionLimits({
        controls: { pathDensity: 1 },
        lattice: { sampleCount: 100 },
      }),
    ).toEqual({
      maxAcceptedSegments: 200,
      maxPolylines: 200,
      maxStagnations: 300,
      maxRestarts: 300,
    })
  })

  it('root-exports only the intended strategy controls, result, and shared contracts', () => {
    expect(core.scribbleStrategy).toBe(scribbleStrategy)
    expect(core.scribbleControlSchema).toBe(scribbleControlSchema)
    expect(core.defaultScribbleControls).toBe(defaultScribbleControls)
    expect('runScribbleStrategyForTesting' in core).toBe(false)
    expectTypeOf<ScribbleStrategyInput>().toMatchTypeOf<
      core.ShadingStrategyInput<ScribbleControls>
    >()
    expectTypeOf<core.ScribbleObserver>().toEqualTypeOf<ScribbleObserver>()
    expectTypeOf<core.ScribbleProgress>().toEqualTypeOf<ScribbleProgress>()
    expectTypeOf<ScribbleResult>().toMatchTypeOf<core.ShadingResult>()

    expect(Object.keys(scribbleControlSchema)).toEqual([
      'pathDensity',
      'scribbleScale',
      'momentum',
      'chaos',
      'toneFidelity',
    ])
    expect(Object.keys(defaultScribbleControls)).toEqual(
      Object.keys(scribbleControlSchema),
    )
    expect(Object.keys(scribbleStrategy(input(source())))).toEqual([
      'polylines',
      'termination',
      'residualError',
    ])
  })

  it('maps higher fidelity monotonically to an equal or lower finite threshold', () => {
    const thresholds: number[] = []

    for (const toneFidelity of [0, 0.25, 0.5, 0.75, 1]) {
      runScribbleStrategyForTesting(
        input(source(), 'threshold-map', { toneFidelity }),
        TINY_LIMITS,
        (orchestratorInput) => {
          thresholds.push(orchestratorInput.residualThreshold)
          return {
            polylines: [],
            residualError: orchestratorInput.model.residualError(),
            acceptedSegments: 0,
            stopCause: 'threshold-reached',
          }
        },
      )
    }

    for (const [index, threshold] of thresholds.entries()) {
      expect(Number.isFinite(threshold)).toBe(true)
      expect(threshold).toBeGreaterThanOrEqual(0)
      expect(threshold).toBeLessThanOrEqual(1)
      if (index > 0) expect(threshold).toBeLessThanOrEqual(thresholds[index - 1]!)
    }
  })

  it('completes zero demand without calling E1 or creating geometry', () => {
    let calls = 0
    const result = runScribbleStrategyForTesting(
      input(source(constantTone(0))),
      TINY_LIMITS,
      () => {
        calls++
        throw new Error('E1 must not run')
      },
    )

    expect(calls).toBe(0)
    expect(result).toEqual({
      polylines: [],
      termination: 'completed',
      residualError: 0,
    })
  })

  it('reports terminal zero-of-zero for public no-demand completion', () => {
    const snapshots: ScribbleProgress[] = []
    const result = scribbleStrategy({
      ...input(source(constantTone(0))),
      observer: (progress) => snapshots.push(progress),
    })

    expect(result).toEqual({
      polylines: [],
      termination: 'completed',
      residualError: 0,
    })
    expect(snapshots).toEqual([
      { completedWorkUnits: 0, totalWorkUnits: 0, terminal: true },
    ])
    expect(Object.isFrozen(snapshots[0])).toBe(true)
  })

  it('keeps public output byte-identical when observers mutate or throw', () => {
    const strategyInput = input(
      source(constantTone(1)),
      'public-observer-isolation',
    )
    const unobserved = runScribbleStrategyForTesting(
      strategyInput,
      TINY_LIMITS,
    )
    let mutationSucceeded = true
    const mutationObserved = runScribbleStrategyForTesting(
      {
        ...strategyInput,
        observer: (progress) => {
          mutationSucceeded = Reflect.set(
            progress,
            'completedWorkUnits',
            999,
          )
        },
      },
      TINY_LIMITS,
    )
    let throwingCalls = 0
    const throwingObserved = runScribbleStrategyForTesting(
      {
        ...strategyInput,
        observer: () => {
          throwingCalls++
          throw new Error('diagnostic observer failure')
        },
      },
      TINY_LIMITS,
    )

    expect(mutationSucceeded).toBe(false)
    expect(throwingCalls).toBeGreaterThan(0)
    expect(JSON.stringify(mutationObserved)).toBe(JSON.stringify(unobserved))
    expect(JSON.stringify(throwingObserved)).toBe(JSON.stringify(unobserved))
  })

  it('calls E1 exactly once for nonzero demand and translates both stop causes', () => {
    for (const [stopCause, termination] of [
      ['threshold-reached', 'completed'],
      ['budget-reached', 'budget-exhausted'],
    ] as const) {
      let calls = 0
      const result = runScribbleStrategyForTesting(
        input(source(), stopCause),
        TINY_LIMITS,
        ({ model }) => {
          calls++
          return {
            polylines: [],
            residualError: model.residualError(),
            acceptedSegments: 0,
            stopCause,
          }
        },
      )

      expect(calls).toBe(1)
      expect(result.termination).toBe(termination)
    }
  })

  it('retains deterministic visible geometry when a tiny injected budget exhausts', () => {
    const execute = () =>
      runScribbleStrategyForTesting(
        input(source(constantTone(1)), 'tiny-public-budget'),
        TINY_LIMITS,
      )

    const first = execute()
    expect(first).toEqual(execute())
    expect(first.termination).toBe('budget-exhausted')
    expect(first.polylines).toHaveLength(1)
    expect(first.polylines[0]).toHaveLength(2)
    expect(first.polylines[0]![0]).not.toEqual(first.polylines[0]![1])
    expectValidResult(first)
  })

  it('refines sharp solver corners into deterministic curved output', () => {
    const raw: Polyline = [
      [10, 10],
      [40, 10],
      [40, 40],
      [70, 40],
    ]
    const execute = () =>
      runScribbleStrategyForTesting(
        input(source(), 'smooth-public-geometry'),
        TINY_LIMITS,
        ({ model }) => ({
          polylines: [raw],
          residualError: model.residualError(),
          acceptedSegments: raw.length - 1,
          stopCause: 'budget-reached',
        }),
      )

    const result = execute()
    expect(result).toEqual(execute())
    expect(result.polylines[0]!.length).toBeGreaterThan(raw.length)
    expect(result.polylines[0]![0]).toEqual(raw[0])
    expect(result.polylines[0]!.at(-1)).toEqual(raw.at(-1))
    expect(maximumTurn(result.polylines[0]!)).toBeLessThan(
      maximumTurn(raw) / 2,
    )
  })

  it('keeps the last mask-safe path when corner rounding would cross zero permission', () => {
    const cornerMask = createShadingMask(([x, y]) =>
      x < 49 && y < 49 ? 0 : 1,
    )
    const raw: Polyline = [
      [10, 50],
      [50, 50],
      [50, 10],
    ]
    const result = runScribbleStrategyForTesting(
      input(source(constantTone(1), cornerMask), 'mask-safe-smoothing'),
      TINY_LIMITS,
      ({ model }) => ({
        polylines: [raw],
        residualError: model.residualError(),
        acceptedSegments: raw.length - 1,
        stopCause: 'budget-reached',
      }),
    )

    expect(result.polylines).toEqual([raw])
  })

  it('rejects invalid E1 geometry at B-derived mask resolution without regenerating', () => {
    let calls = 0
    expect(() =>
      runScribbleStrategyForTesting(
        input(source(constantTone(1), thinZeroBarrierMask(FRAME))),
        TINY_LIMITS,
        ({ model }) => {
          calls++
          return {
            polylines: [[[25, 50], [75, 50]]],
            residualError: model.residualError(),
            acceptedSegments: 1,
            stopCause: 'budget-reached',
          }
        },
      ),
    ).toThrow(/invalid geometry/)
    expect(calls).toBe(1)
  })
})

describe('Scribble analytic conformance', () => {
  it('is exactly deterministic for one Seed and changes routing for another', () => {
    const shared = input(source(horizontalGradientTone(FRAME)), 'same-seed')
    const first = scribbleStrategy(shared)
    const repeated = scribbleStrategy(shared)
    const changed = scribbleStrategy({ ...shared, seed: 'different-seed' })

    expect(repeated).toEqual(first)
    expect(changed.polylines).not.toEqual(first.polylines)
    expectValidResult(first)
    expectValidResult(changed)
  })

  it.each([
    ['constant', source(constantTone(0.8))],
    ['gradient', source(horizontalGradientTone(FRAME))],
    ['white hole', source(whiteHoleTone(FRAME))],
    [
      'feathered boundary',
      source(constantTone(0.8), featheredBoundaryMask(FRAME)),
    ],
    [
      'disconnected islands',
      source(constantTone(0.8), disconnectedIslandsMask(FRAME)),
    ],
    ['thin barrier', source(constantTone(0.8), thinZeroBarrierMask(FRAME))],
  ] as const)('reduces residual on the %s fixture', (_name, fixture) => {
    const initial = createScribbleModel(
      fixture,
      FRAME,
      defaultScribbleControls,
    ).residualError()
    const oneSegment = runScribbleStrategyForTesting(
      input(fixture, `fixture-${_name}`),
      TINY_LIMITS,
    )
    const result = scribbleStrategy(input(fixture, `fixture-${_name}`))

    expectValidResult(result)
    expect(oneSegment.residualError).toBeLessThan(initial)
    expect(result.residualError).toBeLessThan(oneSegment.residualError)
    expect(result.termination).toBe('completed')
    expect(result.residualError).toBeLessThanOrEqual(
      0.12 - defaultScribbleControls.toneFidelity * (0.12 - 0.005),
    )
  })

  it('concentrates gradient geometry in darker demand', () => {
    const result = scribbleStrategy(
      input(source(horizontalGradientTone(FRAME)), 'gradient-abundance'),
    )
    const all = points(result.polylines)
    const light = all.filter(([x]) => x < FRAME.width / 2).length
    const dark = all.filter(([x]) => x >= FRAME.width / 2).length

    expect(dark).toBeGreaterThan(light)
  })

  it('weights soft permission and never enters exact-zero permission', () => {
    const fixture = source(
      constantTone(0.8),
      featheredBoundaryMask(FRAME),
    )
    const result = scribbleStrategy(input(fixture, 'permission-weighting'))
    const all = points(result.polylines)
    const full = all.filter(([x]) => x <= 40).length
    const soft = all.filter(([x]) => x > 40 && x < 60).length

    expect(full).toBeGreaterThan(soft)
    expect(all.every(([x]) => x < 60)).toBe(true)
    expect(independentlyMaskSafe(result, fixture, 0.1)).toBe(true)
  })

  it('lifts between disconnected islands and independently clears a thin barrier', () => {
    const islands = source(
      constantTone(0.8),
      disconnectedIslandsMask(FRAME),
    )
    const islandResult = scribbleStrategy(input(islands, 'island-lifts'))
    const barrier = source(constantTone(0.8), thinZeroBarrierMask(FRAME))
    const barrierResult = scribbleStrategy(input(barrier, 'barrier-safety'))

    expect(islandResult.polylines.length).toBeGreaterThan(1)
    expect(points(islandResult.polylines).some(([x]) => x < 40)).toBe(true)
    expect(points(islandResult.polylines).some(([x]) => x > 60)).toBe(true)
    expect(independentlyMaskSafe(islandResult, islands, 0.1)).toBe(true)
    expect(independentlyMaskSafe(barrierResult, barrier, 0.1)).toBe(true)
  })
})

describe('Scribble authored control behavior', () => {
  it('makes higher path density require more geometry', () => {
    const sparse = scribbleStrategy(
      input(source(), 'path-density', { pathDensity: 0.5 }),
    )
    const dense = scribbleStrategy(
      input(source(), 'path-density', { pathDensity: 2.5 }),
    )

    expect(totalPathLength(dense.polylines)).toBeGreaterThan(
      totalPathLength(sparse.polylines),
    )
  })

  it('keeps scale-coherent routing across proportionally scaled frames', () => {
    const smallFrame = { width: 100, height: 50 }
    const largeFrame = { width: 200, height: 100 }
    const small = scribbleStrategy(
      input(source(), 'scale-coherence', {}, smallFrame),
    )
    const large = scribbleStrategy(
      input(source(), 'scale-coherence', {}, largeFrame),
    )

    expect(large.termination).toBe(small.termination)
    expect(large.residualError).toBeCloseTo(small.residualError, 12)
    expect(segmentCount(large)).toBe(segmentCount(small))
    expect(totalPathLength(large.polylines)).toBeCloseTo(
      totalPathLength(small.polylines) * 2,
      8,
    )
  })

  it('changes characteristic spatial detail with Scribble scale on one frame', () => {
    const controls = { toneFidelity: 0 }
    const fixture = source()
    const fine = scribbleStrategy(
      input(fixture, 'scribble-scale', {
        ...controls,
        scribbleScale: 0.75,
      }),
    )
    const broad = scribbleStrategy(
      input(fixture, 'scribble-scale', {
        ...controls,
        scribbleScale: 1.5,
      }),
    )

    expect(fine.termination).toBe('completed')
    expect(broad.termination).toBe('completed')
    expect(meanSegmentLength(broad)).toBeCloseTo(
      meanSegmentLength(fine) * 2,
      2,
    )
    expect(segmentCount(fine)).toBeGreaterThan(segmentCount(broad))
  })

  it('lets Momentum and Chaos alter routing independently', () => {
    const baseline = scribbleStrategy(
      input(source(), 'independent-controls', { momentum: 0, chaos: 0 }),
    )
    const momentum = scribbleStrategy(
      input(source(), 'independent-controls', { momentum: 1, chaos: 0 }),
    )
    const chaos = scribbleStrategy(
      input(source(), 'independent-controls', { momentum: 0, chaos: 1 }),
    )

    expect(momentum.polylines).not.toEqual(baseline.polylines)
    expect(chaos.polylines).not.toEqual(baseline.polylines)
    expect(momentum.polylines).not.toEqual(chaos.polylines)
  })

  it('makes tighter fidelity retain no greater residual with controlled extra work', () => {
    const loose = scribbleStrategy(
      input(source(), 'tone-fidelity', { toneFidelity: 0 }),
    )
    const tight = scribbleStrategy(
      input(source(), 'tone-fidelity', { toneFidelity: 1 }),
    )

    expect(tight.residualError).toBeLessThanOrEqual(loose.residualError)
    expect(segmentCount(tight)).toBeGreaterThanOrEqual(segmentCount(loose))
    expect(segmentCount(tight)).toBeLessThanOrEqual(segmentCount(loose) * 8)
  })
})
