import { describe, expect, it } from 'vitest'

import { createRandom } from '../random'
import type { ShadingProgress } from '../shadingStrategy'
import { createShadingMask, createToneField } from '../shadingFields'
import { isMaskPermittedPolyline } from '../scribbleStrategy/mask'
import { createScribbleModel } from '../scribbleStrategy/model'
import {
  runScribbleOrchestrator,
  type ScribbleExecutionLimits,
} from '../scribbleStrategy/orchestrator'
import type { ScribbleControls } from '../scribbleStrategy/types'
import type { Random } from '../types'

const FRAME = { width: 100, height: 100 }
const GENEROUS_LIMITS: ScribbleExecutionLimits = {
  maxAcceptedSegments: 4_000,
  maxPolylines: 200,
  maxStagnations: 400,
  maxRestarts: 400,
}

function model(
  tone: (point: readonly [number, number]) => number,
  mask: (point: readonly [number, number]) => number = () => 1,
  controls: Partial<ScribbleControls> = {},
) {
  return createScribbleModel(
    {
      toneField: createToneField(tone),
      shadingMask: createShadingMask(mask),
    },
    FRAME,
    controls,
  )
}

function scriptedRandom(draws: readonly number[]): {
  readonly rng: Random
  readonly valueCalls: () => number
} {
  const fallback = createRandom('scripted-growth-fallback')
  let drawIndex = 0

  return {
    rng: {
      ...fallback,
      value(): number {
        const draw = draws[drawIndex]
        drawIndex++
        return draw ?? fallback.value()
      },
      // Candidate jitter must not consume the restart-selection script.
      range(min: number, max: number): number {
        return (min + max) / 2
      },
    },
    valueCalls: () => drawIndex,
  }
}

describe('Scribble pass orchestration', () => {
  it('stops immediately when the initial residual meets the fixed threshold', () => {
    const snapshots: ShadingProgress[] = []
    const result = runScribbleOrchestrator({
      model: model(() => 0.2),
      rng: createRandom('already-complete'),
      residualThreshold: 0.200_001,
      authoredAcceptedSegmentLimit: 0,
      limits: {
        maxAcceptedSegments: 0,
        maxPolylines: 0,
        maxStagnations: 0,
        maxRestarts: 0,
      },
      observer: (progress) => snapshots.push(progress),
    })

    expect(result.polylines).toEqual([])
    expect(result.residualError).toBeCloseTo(0.2, 12)
    expect(result.acceptedSegments).toBe(0)
    expect(result.stopCause).toBe('threshold-reached')
    expect(snapshots).toEqual([
      {
        completedWorkUnits: 0,
        totalWorkUnits: 0,
        convergence: 1,
        terminal: true,
      },
    ])
    expect(Object.keys(result)).toEqual([
      'polylines',
      'residualError',
      'acceptedSegments',
      'stopCause',
    ])
  })

  it('reduces an ordinary constant target to a fixed threshold', () => {
    const residual = model(() => 0.8)
    const initialError = residual.residualError()
    const result = runScribbleOrchestrator({
      model: residual,
      rng: createRandom('ordinary-convergence'),
      residualThreshold: 0.55,
      limits: GENEROUS_LIMITS,
    })

    expect(result.stopCause).toBe('threshold-reached')
    expect(result.residualError).toBeLessThanOrEqual(0.55)
    expect(result.residualError).toBeLessThan(initialError)
    expect(result.acceptedSegments).toBeGreaterThan(0)
  })

  it('keeps growing a long polyline before lifting from viable demand', () => {
    const result = runScribbleOrchestrator({
      model: model(() => 1, () => 1, { momentum: 1, chaos: 0.15 }),
      rng: createRandom('long-path'),
      residualThreshold: 0.78,
      limits: GENEROUS_LIMITS,
    })

    expect(result.stopCause).toBe('threshold-reached')
    expect(Math.max(...result.polylines.map((line) => line.length))).toBeGreaterThan(
      10,
    )
    expect(result.acceptedSegments).toBe(
      result.polylines.reduce((sum, line) => sum + line.length - 1, 0),
    )
  })

  it('uses residual weights, rather than uniform or global-max restart selection', () => {
    const islandMask = ([x, y]: readonly [number, number]) =>
      (x < 1.2 && y < 1.2) ||
      (x > 30 && x < 50 && y > 10 && y < 25) ||
      (x > 30 && x < 50 && y > 70 && y < 85)
        ? 1
        : 0
    const islandTone = ([x, y]: readonly [number, number]) => {
      if (x < 1.2 && y < 1.2) return 0.5
      return y < 50 ? 0.2 : 1
    }
    const createResidual = () =>
      model(islandTone, islandMask, { chaos: 0.5 })
    const residual = createResidual()
    const samples = residual.samples()
    const low = samples.filter(
      ({ point: [x, y] }) => x > 30 && x < 50 && y > 10 && y < 25,
    )
    const high = samples.filter(
      ({ point: [x, y] }) => x > 30 && x < 50 && y > 70 && y < 85,
    )
    const lowWeight = low.reduce((sum, sample) => sum + sample.residual, 0)
    const highWeight = high.reduce((sum, sample) => sum + sample.residual, 0)
    const { rng, valueCalls } = scriptedRandom([0, 0.3, 0.5])

    expect(low).toHaveLength(high.length)
    // Draw 0.3 lies after the low island by residual weight, but before it if
    // cells were sampled uniformly. Draw 0 first selects the lower-residual,
    // isolated cell, which a global-max selector would never choose.
    expect(lowWeight / (lowWeight + highWeight)).toBeLessThan(0.3)
    expect(low.length / (low.length + high.length)).toBeGreaterThan(0.3)

    const result = runScribbleOrchestrator({
      model: residual,
      rng,
      residualThreshold: 0,
      limits: { ...GENEROUS_LIMITS, maxAcceptedSegments: 1 },
    })

    expect(valueCalls()).toBe(3)
    expect(result.stopCause).toBe('budget-reached')
    expect(result.polylines).toHaveLength(1)
    expect(result.polylines[0]![0]![1]).toBeGreaterThan(70)

    const repeatedScript = scriptedRandom([0, 0.3, 0.5])
    const repeated = runScribbleOrchestrator({
      model: createResidual(),
      rng: repeatedScript.rng,
      residualThreshold: 0,
      limits: { ...GENEROUS_LIMITS, maxAcceptedSegments: 1 },
    })
    expect(repeatedScript.valueCalls()).toBe(3)
    expect(repeated).toEqual(result)
  })

  it('lifts between disconnected islands without crossing exact-zero space', () => {
    const islandMask = ([x, y]: readonly [number, number]) =>
      (x > 10 && x < 35 && y > 25 && y < 75) ||
      (x > 65 && x < 90 && y > 25 && y < 75)
        ? 1
        : 0
    const residual = model(() => 0.9, islandMask, { chaos: 0.8 })
    const result = runScribbleOrchestrator({
      model: residual,
      rng: createRandom('disconnected-islands'),
      residualThreshold: 0.04,
      limits: GENEROUS_LIMITS,
    })

    expect(result.stopCause).toBe('threshold-reached')
    expect(result.polylines.length).toBeGreaterThan(1)
    for (const polyline of result.polylines) {
      expect(
        isMaskPermittedPolyline(
          residual.source.shadingMask,
          FRAME,
          polyline,
          residual.scales.maskCheckSpacing,
        ),
      ).toBe(true)
    }
    expect(
      result.polylines.some((line) => line.some(([x]) => x < 35)),
    ).toBe(true)
    expect(
      result.polylines.some((line) => line.some(([x]) => x > 65)),
    ).toBe(true)
  })

  it('recovers when a residual-weighted start is locally stagnant', () => {
    const mask = ([x, y]: readonly [number, number]) =>
      (x < 1.2 && y < 1.2) || Math.hypot(x - 80, y - 80) < 5 ? 1 : 0
    const result = runScribbleOrchestrator({
      model: model(() => 1, mask, { chaos: 0.5 }),
      // This Seed samples the isolated first lattice cell before the viable disc.
      rng: createRandom('stagnation-123'),
      residualThreshold: 0.001,
      limits: GENEROUS_LIMITS,
    })

    expect(result.acceptedSegments).toBeGreaterThan(0)
    expect(result.polylines[0]![0]![0]).toBeGreaterThan(70)
    expect(result.polylines[0]![0]![1]).toBeGreaterThan(70)
  })

  it('retains exactly one deterministic segment at a tiny segment budget', () => {
    const execute = () =>
      runScribbleOrchestrator({
        model: model(() => 1),
        rng: createRandom('tiny-budget'),
        residualThreshold: 0,
        limits: {
          ...GENEROUS_LIMITS,
          maxAcceptedSegments: 1,
        },
      })

    const first = execute()
    const repeated = execute()

    expect(first.stopCause).toBe('budget-reached')
    expect(first.acceptedSegments).toBe(1)
    expect(first.polylines).toHaveLength(1)
    expect(first.polylines[0]).toHaveLength(2)
    expect(first.polylines[0]![0]).not.toEqual(first.polylines[0]![1])
    expect(repeated).toEqual(first)
  })

  it('retains exactly the authored number of accepted segments', () => {
    const result = runScribbleOrchestrator({
      model: model(() => 1),
      rng: createRandom('authored-limit'),
      residualThreshold: 0,
      authoredAcceptedSegmentLimit: 3,
      limits: GENEROUS_LIMITS,
    })

    expect(result.stopCause).toBe('authored-limit-reached')
    expect(result.acceptedSegments).toBe(3)
    expect(
      result.polylines.reduce((sum, line) => sum + line.length - 1, 0),
    ).toBe(3)
  })

  it('checks convergence before an authored cap reached by the same segment', () => {
    const result = runScribbleOrchestrator({
      model: model(() => 1),
      rng: createRandom('authored-limit-convergence'),
      residualThreshold: 0.999_824,
      authoredAcceptedSegmentLimit: 1,
      limits: GENEROUS_LIMITS,
    })

    expect(result.acceptedSegments).toBe(1)
    expect(result.stopCause).toBe('threshold-reached')
  })

  it('checks the threshold before a segment that also reaches its budget', () => {
    const result = runScribbleOrchestrator({
      model: model(() => 1),
      rng: createRandom('tiny-budget'),
      residualThreshold: 0.999_824,
      limits: { ...GENEROUS_LIMITS, maxAcceptedSegments: 1 },
    })

    expect(result.acceptedSegments).toBe(1)
    expect(result.residualError).toBeLessThanOrEqual(0.999_824)
    expect(result.stopCause).toBe('threshold-reached')
  })

  it('rejects non-normalized thresholds and unsafe execution caps', () => {
    const residual = model(() => 1)
    expect(() =>
      runScribbleOrchestrator({
        model: residual,
        rng: createRandom('bad-threshold'),
        residualThreshold: Number.NaN,
        limits: GENEROUS_LIMITS,
      }),
    ).toThrow(/residualThreshold/)

    expect(() =>
      runScribbleOrchestrator({
        model: residual,
        rng: createRandom('bad-limit'),
        residualThreshold: 0.1,
        limits: { ...GENEROUS_LIMITS, maxRestarts: -1 },
      }),
    ).toThrow(/maxRestarts/)

    expect(() =>
      runScribbleOrchestrator({
        model: residual,
        rng: createRandom('bad-authored-limit'),
        residualThreshold: 0.1,
        limits: GENEROUS_LIMITS,
        authoredAcceptedSegmentLimit:
          GENEROUS_LIMITS.maxAcceptedSegments + 1,
      }),
    ).toThrow(/authoredAcceptedSegmentLimit/)
  })
})

describe('Scribble pass progress observation', () => {
  it('preserves byte-identical output with or without observation', () => {
    const execute = (observer?: (progress: ShadingProgress) => void) =>
      runScribbleOrchestrator({
        model: model(() => 0.8),
        rng: createRandom('observed-determinism'),
        residualThreshold: 0.55,
        limits: GENEROUS_LIMITS,
        ...(observer === undefined ? {} : { observer }),
      })
    const snapshots: ShadingProgress[] = []

    const unobserved = execute()
    const observed = execute((progress) => snapshots.push(progress))

    expect(JSON.stringify(observed)).toBe(JSON.stringify(unobserved))
    expect(snapshots.length).toBeGreaterThan(1)
  })

  it('reports immutable, monotonic actual work against one stable total', () => {
    const snapshots: ShadingProgress[] = []
    const result = runScribbleOrchestrator({
      model: model(() => 0.8),
      rng: createRandom('observed-convergence'),
      residualThreshold: 0.55,
      limits: GENEROUS_LIMITS,
      observer: (progress) => snapshots.push(progress),
    })

    expect(result.stopCause).toBe('threshold-reached')
    expect(snapshots.every(Object.isFrozen)).toBe(true)
    expect(
      new Set(snapshots.map((progress) => progress.totalWorkUnits)),
    ).toEqual(
      new Set([
        GENEROUS_LIMITS.maxAcceptedSegments +
          GENEROUS_LIMITS.maxStagnations,
      ]),
    )
    expect(snapshots.at(-1)!.terminal).toBe(true)
    expect(snapshots.at(-2)!.terminal).toBe(false)
    expect(snapshots.at(-1)!.completedWorkUnits).toBe(
      snapshots.at(-2)!.completedWorkUnits,
    )

    const intermediate = snapshots.slice(0, -1)
    for (let index = 0; index < intermediate.length; index++) {
      expect(intermediate[index]!.completedWorkUnits).toBe(index + 1)
      expect(intermediate[index]!.terminal).toBe(false)
      expect(intermediate[index]!.convergence).toBeGreaterThanOrEqual(
        index === 0 ? 0 : intermediate[index - 1]!.convergence!,
      )
    }
    expect(snapshots.at(-1)!.convergence).toBe(1)
    expect(snapshots.at(-1)!.completedWorkUnits).toBeGreaterThanOrEqual(
      result.acceptedSegments,
    )
  })

  it('preserves the actual count when the accepted-segment budget stops work', () => {
    const snapshots: ShadingProgress[] = []
    const limits = {
      ...GENEROUS_LIMITS,
      maxAcceptedSegments: 1,
      maxStagnations: 5,
    }
    const result = runScribbleOrchestrator({
      model: model(() => 1),
      rng: createRandom('observed-budget'),
      residualThreshold: 0,
      limits,
      observer: (progress) => snapshots.push(progress),
    })

    expect(result.stopCause).toBe('budget-reached')
    expect(snapshots).toEqual([
      expect.objectContaining({
        completedWorkUnits: 1,
        totalWorkUnits: 6,
        terminal: false,
      }),
      expect.objectContaining({
        completedWorkUnits: 1,
        totalWorkUnits: 6,
        terminal: true,
      }),
    ])
    expect(snapshots[0]!.convergence).toBeGreaterThan(0)
    expect(snapshots[1]!.convergence).toBe(snapshots[0]!.convergence)
  })

  it('reports threshold-first convergence before a 99% authored cap', () => {
    const snapshots: ShadingProgress[] = []
    const authoredAcceptedSegmentLimit = Math.floor(
      GENEROUS_LIMITS.maxAcceptedSegments * 0.99,
    )
    const result = runScribbleOrchestrator({
      model: model(() => 0.8),
      rng: createRandom('observed-threshold-before-99-percent'),
      residualThreshold: 0.55,
      authoredAcceptedSegmentLimit,
      limits: GENEROUS_LIMITS,
      observer: (progress) => snapshots.push(progress),
    })

    expect(result.stopCause).toBe('threshold-reached')
    expect(result.acceptedSegments).toBeLessThan(authoredAcceptedSegmentLimit)
    expect(snapshots.at(-1)).toMatchObject({
      convergence: 1,
      terminal: true,
    })
  })

  it('reports both progress signals when the authored cap wins', () => {
    const snapshots: ShadingProgress[] = []
    const result = runScribbleOrchestrator({
      model: model(() => 1),
      rng: createRandom('observed-authored-limit'),
      residualThreshold: 0,
      authoredAcceptedSegmentLimit: 1,
      limits: { ...GENEROUS_LIMITS, maxStagnations: 5 },
      observer: (progress) => snapshots.push(progress),
    })

    expect(result.stopCause).toBe('authored-limit-reached')
    expect(snapshots).toEqual([
      expect.objectContaining({
        completedWorkUnits: 1,
        totalWorkUnits: 6,
        terminal: false,
      }),
      expect.objectContaining({
        completedWorkUnits: 1,
        totalWorkUnits: 6,
        terminal: true,
      }),
    ])
    expect(snapshots[0]!.convergence).toBeGreaterThan(0)
    expect(snapshots[0]!.convergence).toBeLessThan(1)
    expect(snapshots[1]!.convergence).toBe(snapshots[0]!.convergence)
  })

  it('counts a stagnant growth attempt as one completed work unit', () => {
    const snapshots: ShadingProgress[] = []
    const limits = {
      ...GENEROUS_LIMITS,
      maxAcceptedSegments: 3,
      maxStagnations: 1,
    }
    const result = runScribbleOrchestrator({
      model: model(
        () => 1,
        ([x, y]) => (x < 1.2 && y < 1.2 ? 1 : 0),
      ),
      rng: createRandom('observed-stagnation'),
      residualThreshold: 0,
      limits,
      observer: (progress) => snapshots.push(progress),
    })

    expect(result.acceptedSegments).toBe(0)
    expect(result.stopCause).toBe('budget-reached')
    expect(snapshots).toEqual([
      {
        completedWorkUnits: 1,
        totalWorkUnits: 4,
        convergence: 0,
        terminal: false,
      },
      {
        completedWorkUnits: 1,
        totalWorkUnits: 4,
        convergence: 0,
        terminal: true,
      },
    ])
  })

  it('reports immediate no-demand completion as terminal zero-of-zero', () => {
    const snapshots: ShadingProgress[] = []
    const result = runScribbleOrchestrator({
      model: model(() => 0),
      rng: createRandom('observed-no-demand'),
      residualThreshold: 0,
      limits: GENEROUS_LIMITS,
      observer: (progress) => snapshots.push(progress),
    })

    expect(result.stopCause).toBe('threshold-reached')
    expect(snapshots).toEqual([
      {
        completedWorkUnits: 0,
        totalWorkUnits: 0,
        convergence: 1,
        terminal: true,
      },
    ])
  })
})

describe('Scribble lift-budget accounting', () => {
  function execute(limits: ScribbleExecutionLimits) {
    const islandMask = ([x, y]: readonly [number, number]) =>
      Math.hypot(x - 20, y - 20) < 5 ||
      Math.hypot(x - 50, y - 50) < 5 ||
      Math.hypot(x - 80, y - 80) < 5
        ? 1
        : 0

    return runScribbleOrchestrator({
      model: model(() => 1, islandMask, { momentum: 0.8, chaos: 0.5 }),
      rng: createRandom('lift-accounting'),
      residualThreshold: 0,
      limits,
    })
  }

  it('returns no geometry when the polyline cap is zero', () => {
    const result = execute({
      ...GENEROUS_LIMITS,
      maxPolylines: 0,
    })

    expect(result.stopCause).toBe('budget-reached')
    expect(result.polylines).toEqual([])
    expect(result.acceptedSegments).toBe(0)
    expect(result.residualError).toBeGreaterThan(0)
  })

  it('retains exactly one non-empty polyline at the tiny polyline cap', () => {
    const result = execute({
      ...GENEROUS_LIMITS,
      maxPolylines: 1,
    })

    expect(result.stopCause).toBe('budget-reached')
    expect(result.polylines).toHaveLength(1)
    expect(result.polylines[0]!.length).toBeGreaterThan(1)
    expect(result.acceptedSegments).toBe(result.polylines[0]!.length - 1)
    expect(result.residualError).toBeGreaterThan(0)
  })

  it('retains initial-island geometry when the restart cap is zero', () => {
    const result = execute({
      ...GENEROUS_LIMITS,
      maxRestarts: 0,
    })

    expect(result.stopCause).toBe('budget-reached')
    expect(result.polylines).toHaveLength(1)
    expect(result.polylines[0]!.length).toBeGreaterThan(1)
    expect(result.acceptedSegments).toBe(result.polylines[0]!.length - 1)
    expect(result.residualError).toBeGreaterThan(0)
  })

  it('retains initial-island geometry at one allowed stagnation', () => {
    const result = execute({
      ...GENEROUS_LIMITS,
      maxStagnations: 1,
    })

    expect(result.stopCause).toBe('budget-reached')
    expect(result.polylines).toHaveLength(1)
    expect(result.polylines[0]!.length).toBeGreaterThan(1)
    expect(result.acceptedSegments).toBe(result.polylines[0]!.length - 1)
    expect(result.residualError).toBeGreaterThan(0)
  })
})
