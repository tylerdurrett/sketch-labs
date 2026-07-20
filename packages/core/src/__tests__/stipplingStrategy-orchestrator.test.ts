import { describe, expect, it } from 'vitest'

import { createRandom } from '../random'
import { createShadingMask, createToneField } from '../shadingFields'
import type { ShadingProgress } from '../shadingStrategy'
import { createStipplingModel } from '../stipplingStrategy/model'
import {
  runStipplingOrchestrator,
  type StipplingExecutionLimits,
} from '../stipplingStrategy/orchestrator'
import { placeInitialStipples } from '../stipplingStrategy/placement'
import {
  refineStipples,
  resolveStipplingRefinementAttempts,
} from '../stipplingStrategy/refinement'
import type { StipplingControls } from '../stipplingStrategy/types'

const FRAME = Object.freeze({ width: 100, height: 100 })
const GENEROUS_LIMITS: StipplingExecutionLimits = Object.freeze({
  maxStipples: 1_000,
  maxPlacementAttempts: 100_000,
  maxRefinementAttempts: 10_000,
})

function model(
  tone: (point: readonly [number, number]) => number = () => 1,
  permission: (point: readonly [number, number]) => number = () => 1,
  controls: Partial<StipplingControls> = {},
) {
  return createStipplingModel(
    {
      toneField: createToneField(tone),
      shadingMask: createShadingMask(permission),
    },
    FRAME,
    { stippleDensity: 0.25, distributionFidelity: 0.05, ...controls },
  )
}

describe('Stippling orchestration', () => {
  it('composes placement then authored refinement on one deterministic stream', () => {
    const target = model(([x]) => (x < 60 ? 0.9 : 0.2))
    const directRng = createRandom('composed-stream')
    const placed = placeInitialStipples(target, directRng, {
      maxAttempts: GENEROUS_LIMITS.maxPlacementAttempts,
    })
    const requestedRefinement = resolveStipplingRefinementAttempts(
      placed.marks.length,
      target.controls.distributionFidelity,
    )
    const refined = refineStipples(target, directRng, placed.marks, {
      maxAttempts: requestedRefinement,
    })

    const outcome = runStipplingOrchestrator({
      model: target,
      rng: createRandom('composed-stream'),
      limits: GENEROUS_LIMITS,
    })

    expect(outcome).toMatchObject({
      marks: refined.marks,
      distributionError: target.distributionError(refined.marks),
      placementAttemptsUsed: placed.attemptsUsed,
      refinementAttemptsUsed: requestedRefinement,
      termination: 'completed',
      stopCause: 'completed',
    })
    expect(outcome.marks).toHaveLength(target.scales.targetCount)
    expect(Object.isFrozen(outcome)).toBe(true)
  })

  it('repeats exact termination, marks, work, error, and progress', () => {
    function execute() {
      const snapshots: ShadingProgress[] = []
      const outcome = runStipplingOrchestrator({
        model: model(),
        rng: createRandom('orchestrator-repeat'),
        limits: GENEROUS_LIMITS,
        observer: (progress) => snapshots.push(progress),
      })
      return { outcome, snapshots }
    }

    expect(execute()).toEqual(execute())
  })

  it('retains the exact ordered partial placement and recomputes its error', () => {
    const target = model()
    const direct = placeInitialStipples(
      target,
      createRandom('placement-ceiling'),
      { maxAttempts: 3 },
    )
    const outcome = runStipplingOrchestrator({
      model: target,
      rng: createRandom('placement-ceiling'),
      limits: { ...GENEROUS_LIMITS, maxPlacementAttempts: 3 },
    })

    expect(outcome).toMatchObject({
      marks: direct.marks,
      placementAttemptsUsed: 3,
      refinementAttemptsUsed: 0,
      termination: 'budget-exhausted',
      stopCause: 'placement-ceiling-reached',
    })
    expect(outcome.distributionError).toBe(
      target.distributionError(outcome.marks),
    )
    expect(Number.isFinite(outcome.distributionError)).toBe(true)
  })

  it('stops at the retained-geometry ceiling before refinement', () => {
    const target = model(() => 1, () => 1, { distributionFidelity: 1 })
    const outcome = runStipplingOrchestrator({
      model: target,
      rng: createRandom('geometry-ceiling'),
      limits: {
        maxStipples: 3,
        maxPlacementAttempts: 100,
        maxRefinementAttempts: 0,
      },
    })

    expect(outcome).toMatchObject({
      refinementAttemptsUsed: 0,
      termination: 'budget-exhausted',
      stopCause: 'geometry-ceiling-reached',
    })
    expect(outcome.marks).toHaveLength(3)
    expect(outcome.distributionError).toBe(
      target.distributionError(outcome.marks),
    )
  })

  it('retains selected count and exact partial error at refinement exhaustion', () => {
    const target = model(() => 1, () => 1, { distributionFidelity: 0.1 })
    const outcome = runStipplingOrchestrator({
      model: target,
      rng: createRandom('refinement-ceiling'),
      limits: { ...GENEROUS_LIMITS, maxRefinementAttempts: 2 },
    })

    expect(outcome).toMatchObject({
      refinementAttemptsUsed: 2,
      termination: 'budget-exhausted',
      stopCause: 'refinement-ceiling-reached',
    })
    expect(outcome.marks).toHaveLength(target.scales.targetCount)
    expect(outcome.distributionError).toBe(
      target.distributionError(outcome.marks),
    )
  })

  it('gives placement exhaustion precedence before an unfilled geometry ceiling', () => {
    const outcome = runStipplingOrchestrator({
      model: model(),
      rng: createRandom('placement-before-geometry'),
      limits: {
        maxStipples: 3,
        maxPlacementAttempts: 0,
        maxRefinementAttempts: 0,
      },
    })

    expect(outcome.stopCause).toBe('placement-ceiling-reached')
    expect(outcome.marks).toEqual([])
  })

  it('gives a filled geometry ceiling precedence over refinement exhaustion', () => {
    const outcome = runStipplingOrchestrator({
      model: model(() => 1, () => 1, { distributionFidelity: 1 }),
      rng: createRandom('geometry-before-refinement'),
      limits: {
        maxStipples: 1,
        maxPlacementAttempts: 100,
        maxRefinementAttempts: 0,
      },
    })

    expect(outcome.stopCause).toBe('geometry-ceiling-reached')
    expect(outcome.marks).toHaveLength(1)
    expect(outcome.refinementAttemptsUsed).toBe(0)
  })

  it('keeps placement work, count, order, and orientations independent of fidelity', () => {
    const loose = runStipplingOrchestrator({
      model: model(() => 1, () => 1, { distributionFidelity: 0 }),
      rng: createRandom('fidelity-independent-placement'),
      limits: GENEROUS_LIMITS,
    })
    const faithful = runStipplingOrchestrator({
      model: model(() => 1, () => 1, { distributionFidelity: 0.1 }),
      rng: createRandom('fidelity-independent-placement'),
      limits: GENEROUS_LIMITS,
    })

    expect(faithful.marks).toHaveLength(loose.marks.length)
    expect(faithful.placementAttemptsUsed).toBe(loose.placementAttemptsUsed)
    expect(faithful.marks.map(({ orientation }) => orientation)).toEqual(
      loose.marks.map(({ orientation }) => orientation),
    )
    expect(loose.termination).toBe('completed')
    expect(faithful.termination).toBe('completed')
  })

  it('validates every non-negative integer execution limit and attempt cap', () => {
    const target = model()
    const execute = (limits: StipplingExecutionLimits) => () =>
      runStipplingOrchestrator({
        model: target,
        rng: createRandom('bad-limits'),
        limits,
      })

    expect(execute({ ...GENEROUS_LIMITS, maxStipples: -1 })).toThrow(
      /maxStipples/,
    )
    expect(execute({ ...GENEROUS_LIMITS, maxStipples: 1.5 })).toThrow(
      /maxStipples/,
    )
    expect(
      execute({ ...GENEROUS_LIMITS, maxStipples: Number.POSITIVE_INFINITY }),
    ).toThrow(/maxStipples/)
    expect(
      execute({ ...GENEROUS_LIMITS, maxPlacementAttempts: -1 }),
    ).toThrow(/maxPlacementAttempts/)
    expect(
      execute({ ...GENEROUS_LIMITS, maxPlacementAttempts: 1_000_001 }),
    ).toThrow(/maxPlacementAttempts/)
    expect(
      execute({ ...GENEROUS_LIMITS, maxRefinementAttempts: 1.5 }),
    ).toThrow(/maxRefinementAttempts/)
    expect(
      execute({
        ...GENEROUS_LIMITS,
        maxRefinementAttempts: Number.NaN,
      }),
    ).toThrow(/maxRefinementAttempts/)
  })
})

describe('Stippling progress observation', () => {
  it('reports frozen monotonic snapshots against one stable work upper bound', () => {
    const snapshots: ShadingProgress[] = []
    const outcome = runStipplingOrchestrator({
      model: model(),
      rng: createRandom('monotonic-progress'),
      limits: GENEROUS_LIMITS,
      observer: (progress) => snapshots.push(progress),
    })

    expect(outcome.termination).toBe('completed')
    expect(snapshots).toHaveLength(3)
    expect(snapshots.every(Object.isFrozen)).toBe(true)
    expect(new Set(snapshots.map(({ totalWorkUnits }) => totalWorkUnits))).toEqual(
      new Set([
        GENEROUS_LIMITS.maxPlacementAttempts +
          GENEROUS_LIMITS.maxRefinementAttempts,
      ]),
    )
    expect(snapshots.at(-1)).toMatchObject({
      convergence: 1,
      terminal: true,
    })
    for (let index = 1; index < snapshots.length; index++) {
      expect(snapshots[index]!.completedWorkUnits).toBeGreaterThanOrEqual(
        snapshots[index - 1]!.completedWorkUnits,
      )
      expect(snapshots[index]!.convergence).toBeGreaterThanOrEqual(
        snapshots[index - 1]!.convergence,
      )
    }
  })

  it('isolates observer exceptions and attempted mutation from exact output', () => {
    const execute = (observer?: (progress: ShadingProgress) => void) =>
      runStipplingOrchestrator({
        model: model(),
        rng: createRandom('observer-isolation'),
        limits: GENEROUS_LIMITS,
        ...(observer === undefined ? {} : { observer }),
      })
    const baseline = execute()
    let observations = 0
    const observed = execute((progress) => {
      observations++
      expect(Object.isFrozen(progress)).toBe(true)
      ;(progress as { completedWorkUnits: number }).completedWorkUnits = -1
      throw new Error('observer failure')
    })

    expect(observations).toBeGreaterThan(0)
    expect(observed).toEqual(baseline)
  })

  it('reports empty demand as one terminal frozen zero-of-zero snapshot', () => {
    const snapshots: ShadingProgress[] = []
    const target = model(() => 0)
    const outcome = runStipplingOrchestrator({
      model: target,
      rng: createRandom('empty-demand'),
      limits: GENEROUS_LIMITS,
      observer: (progress) => snapshots.push(progress),
    })

    expect(outcome).toEqual({
      marks: [],
      distributionError: 0,
      placementAttemptsUsed: 0,
      refinementAttemptsUsed: 0,
      termination: 'completed',
      stopCause: 'completed',
    })
    expect(snapshots).toEqual([
      {
        completedWorkUnits: 0,
        totalWorkUnits: 0,
        convergence: 1,
        terminal: true,
      },
    ])
    expect(Object.isFrozen(snapshots[0])).toBe(true)
  })

  it('keeps terminal convergence below one at a geometry ceiling', () => {
    const snapshots: ShadingProgress[] = []
    const outcome = runStipplingOrchestrator({
      model: model(),
      rng: createRandom('partial-convergence'),
      limits: {
        maxStipples: 2,
        maxPlacementAttempts: 100,
        maxRefinementAttempts: 100,
      },
      observer: (progress) => snapshots.push(progress),
    })

    expect(outcome.stopCause).toBe('geometry-ceiling-reached')
    expect(snapshots.at(-1)!.terminal).toBe(true)
    expect(snapshots.at(-1)!.convergence).toBeLessThan(1)
    expect(snapshots.at(-1)!.completedWorkUnits).toBe(
      outcome.placementAttemptsUsed,
    )
  })
})
