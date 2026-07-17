import { describe, expect, expectTypeOf, it } from 'vitest'

import { createShadingMask, createToneField } from '../shadingFields'
import {
  penLiftCount,
  polylineCount,
  totalPathLength,
} from '../shadingStrategy'
import type {
  ShadingResult,
  ShadingStrategy,
  ShadingStrategyInput,
  ShadingTermination,
} from '../shadingStrategy'
import type { Polyline } from '../types'

describe('shading strategy contract', () => {
  const terminations = [
    'completed',
    'budget-exhausted',
  ] as const satisfies readonly ShadingTermination[]

  interface Controls {
    readonly density: number
  }

  const input: ShadingStrategyInput<Controls> = {
    source: {
      toneField: createToneField(() => 0.5),
      shadingMask: createShadingMask(() => 1),
    },
    frame: { width: 200, height: 100 },
    controls: { density: 0.75 },
    seed: 'contract-seed',
  }

  it('restricts generic strategy input to source, frame, controls, and Seed', () => {
    expectTypeOf<keyof ShadingStrategyInput<Controls>>().toEqualTypeOf<
      'source' | 'frame' | 'controls' | 'seed'
    >()

    const strategy: ShadingStrategy<Controls> = (received) => ({
      polylines: [
        [
          [0, 0],
          [received.frame.width, received.frame.height],
        ],
      ],
      termination:
        received.controls.density > 0 ? 'completed' : 'budget-exhausted',
    })

    expect(strategy(input)).toEqual({
      polylines: [
        [
          [0, 0],
          [200, 100],
        ],
      ],
      termination: 'completed',
    })
  })

  it.each(terminations)(
    'preserves the truthful %s termination reason',
    (termination) => {
      const result: ShadingResult = { polylines: [], termination }
      expectTypeOf(result.termination).toEqualTypeOf<ShadingTermination>()
      expect(result.termination).toBe(termination)
    },
  )
})

describe('shading geometry metrics', () => {
  it('reports zero geometry for no polylines', () => {
    expect(totalPathLength([])).toBe(0)
    expect(polylineCount([])).toBe(0)
    expect(penLiftCount([])).toBe(0)
  })

  it('reports a single polyline without a pen lift', () => {
    const polylines: Polyline[] = [
      [
        [0, 0],
        [3, 4],
      ],
    ]

    expect(totalPathLength(polylines)).toBe(5)
    expect(polylineCount(polylines)).toBe(1)
    expect(penLiftCount(polylines)).toBe(0)
  })

  it('sums unequal segment lengths and counts lifts between polylines', () => {
    const polylines: Polyline[] = [
      [
        [0, 0],
        [3, 4],
        [3, 12],
      ],
      [
        [10, 10],
        [10, 12],
      ],
      [[20, 20]],
    ]

    expect(totalPathLength(polylines)).toBe(15)
    expect(polylineCount(polylines)).toBe(3)
    expect(penLiftCount(polylines)).toBe(2)
  })
})
