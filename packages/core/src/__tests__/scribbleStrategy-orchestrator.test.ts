import { describe, expect, it } from 'vitest'

import { createRandom } from '../random'
import { createShadingMask, createToneField } from '../shadingFields'
import { isMaskPermittedPolyline } from '../scribbleStrategy/mask'
import { createScribbleModel } from '../scribbleStrategy/model'
import {
  runScribbleOrchestrator,
  type ScribbleExecutionLimits,
} from '../scribbleStrategy/orchestrator'
import type { ScribbleControls } from '../scribbleStrategy/types'

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

describe('Scribble pass orchestration', () => {
  it('stops immediately when the initial residual meets the fixed threshold', () => {
    const result = runScribbleOrchestrator({
      model: model(() => 0.2),
      rng: createRandom('already-complete'),
      residualThreshold: 0.200_001,
      limits: {
        maxAcceptedSegments: 0,
        maxPolylines: 0,
        maxStagnations: 0,
        maxRestarts: 0,
      },
    })

    expect(result.polylines).toEqual([])
    expect(result.residualError).toBeCloseTo(0.2, 12)
    expect(result.acceptedSegments).toBe(0)
    expect(result.stopCause).toBe('threshold-reached')
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

  it('repeats residual-weighted restart order for the same Seed', () => {
    const islandMask = ([x, y]: readonly [number, number]) => {
      const column = x < 50 ? 20 : 80
      const row = y < 50 ? 20 : 80
      return Math.abs(x - column) < 7 && Math.abs(y - row) < 7 ? 1 : 0
    }
    const execute = (seed: string) =>
      runScribbleOrchestrator({
        model: model(() => 1, islandMask, { chaos: 0.6 }),
        rng: createRandom(seed),
        residualThreshold: 0.015,
        limits: GENEROUS_LIMITS,
      })

    const first = execute('restart-order')
    const repeated = execute('restart-order')
    const changed = execute('restart-order-changed')

    expect(first.polylines.length).toBeGreaterThan(1)
    expect(repeated).toEqual(first)
    expect(changed.polylines).not.toEqual(first.polylines)
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
  })
})
