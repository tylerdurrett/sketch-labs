import { describe, expect, it } from 'vitest'

import { createRandom } from '../random'
import type { CoordinateSpace } from '../scene'
import {
  createShadingMask,
  createToneField,
  sampleEffectiveTone,
  type ToneSource,
} from '../shadingFields'
import { isMaskPermittedStipple } from '../stipplingStrategy/mask'
import { createStipplingModel } from '../stipplingStrategy/model'
import { placeInitialStipples } from '../stipplingStrategy/placement'
import {
  computeStipplingDistributionError,
  refineStipples,
} from '../stipplingStrategy/refinement'
import type {
  StippleMark,
  StipplingControls,
  StipplingModel,
} from '../stipplingStrategy/types'
import type { Point, Random } from '../types'

const FRAME: CoordinateSpace = Object.freeze({ width: 100, height: 100 })

function source(
  tone: (point: Readonly<Point>) => number = () => 1,
  permission: (point: Readonly<Point>) => number = () => 1,
): ToneSource {
  return {
    toneField: createToneField(tone),
    shadingMask: createShadingMask(permission),
  }
}

function model(
  toneSource = source(),
  controls: Partial<StipplingControls> = {},
): StipplingModel {
  return createStipplingModel(toneSource, FRAME, controls)
}

function mark(center: Point, orientation: number): Readonly<StippleMark> {
  return Object.freeze({ center: Object.freeze(center), orientation })
}

function frozenMarks(
  entries: readonly (readonly [Point, number])[],
): readonly Readonly<StippleMark>[] {
  return Object.freeze(
    entries.map(([center, orientation]) => mark(center, orientation)),
  )
}

function endpoints(
  stipple: Readonly<StippleMark>,
  length: number,
): readonly [Point, Point] {
  const halfX = (Math.cos(stipple.orientation) * length) / 2
  const halfY = (Math.sin(stipple.orientation) * length) / 2
  return [
    [stipple.center[0] - halfX, stipple.center[1] - halfY],
    [stipple.center[0] + halfX, stipple.center[1] + halfY],
  ]
}

const RIGHT_HEAVY_MARKS = frozenMarks([
  [[70, 15], 0.1],
  [[80, 30], 0.4],
  [[90, 45], 0.7],
  [[70, 60], 1],
  [[80, 75], 1.3],
  [[90, 90], 1.6],
])

describe('Stipple distribution error', () => {
  it('delegates to the model distribution metric without mutating marks', () => {
    const target = model()
    const marks = frozenMarks([
      [[10, 20], 0.25],
      [[70, 80], 0.75],
    ])
    const before = [...marks]

    expect(computeStipplingDistributionError(target, marks)).toBe(
      target.distributionError(marks),
    )
    expect(marks).toEqual(before)
  })

  it('rejects a non-finite model distribution error', () => {
    const target = model()
    const malformed = {
      ...target,
      distributionError: () => Number.NaN,
    } satisfies StipplingModel

    expect(() => computeStipplingDistributionError(malformed, [])).toThrow(
      'Stippling distribution error must be finite',
    )
  })
})

describe('bounded Stipple refinement', () => {
  it('returns exact frozen identity for zero requested attempts', () => {
    const target = model()
    const initial = frozenMarks([[[25, 25], 0.5]])
    const rng = createRandom('zero-attempts')
    const outcome = refineStipples(target, rng, initial, { maxAttempts: 0 })

    expect(outcome).toEqual({
      marks: initial,
      error: target.distributionError(initial),
      attemptsUsed: 0,
      requestedRefinementReached: true,
    })
    expect(outcome.marks).toBe(initial)
    expect(Object.isFrozen(outcome)).toBe(true)
    expect(Object.isFrozen(outcome.marks)).toBe(true)
  })

  it('uses zero-fidelity defaults as an identity pass', () => {
    const target = model(source(), { distributionFidelity: 0 })
    const outcome = refineStipples(
      target,
      createRandom('zero-fidelity'),
      RIGHT_HEAVY_MARKS,
    )

    expect(outcome.marks).toBe(RIGHT_HEAVY_MARKS)
    expect(outcome.attemptsUsed).toBe(0)
  })

  it('accepts only strict distribution-error reductions into demand', () => {
    const target = model(source(([x]) => (x < 50 ? 1 : 0)))
    const initialError = computeStipplingDistributionError(
      target,
      RIGHT_HEAVY_MARKS,
    )
    const outcome = refineStipples(
      target,
      createRandom('strict-reductions'),
      RIGHT_HEAVY_MARKS,
      { maxAttempts: 100 },
    )

    expect(outcome.error).toBeLessThan(initialError)
    expect(outcome.error).toBe(target.distributionError(outcome.marks))
    expect(outcome.marks.some(({ center }) => center[0] < 50)).toBe(true)
    expect(outcome.attemptsUsed).toBe(100)
    expect(outcome.requestedRefinementReached).toBe(true)
  })

  it('preserves count, array order, orientation, and fixed materialized length', () => {
    const target = model(source(([x]) => (x < 50 ? 1 : 0)))
    const orientations = RIGHT_HEAVY_MARKS.map(({ orientation }) => orientation)
    const outcome = refineStipples(
      target,
      createRandom('preserve-marks'),
      RIGHT_HEAVY_MARKS,
      { maxAttempts: 200 },
    )

    expect(outcome.marks).toHaveLength(RIGHT_HEAVY_MARKS.length)
    expect(outcome.marks.map(({ orientation }) => orientation)).toEqual(
      orientations,
    )
    for (const stipple of outcome.marks) {
      const [start, end] = endpoints(stipple, target.scales.stippleLength)
      expect(Math.hypot(end[0] - start[0], end[1] - start[1])).toBeCloseTo(
        target.scales.stippleLength,
        12,
      )
    }
  })

  it('keeps every refined complete segment mask-safe and center-separated', () => {
    const barrierSource = source(
      () => 1,
      ([x]) => (Math.abs(x - 50) <= 0.5 ? 0 : 1),
    )
    const target = model(barrierSource, { stippleDensity: 0.25 })
    const rng = createRandom('refinement-safety')
    const placed = placeInitialStipples(target, rng)
    const outcome = refineStipples(target, rng, placed.marks, {
      maxAttempts: 300,
    })

    for (let left = 0; left < outcome.marks.length; left++) {
      const stipple = outcome.marks[left]!
      const [start, end] = endpoints(stipple, target.scales.stippleLength)
      expect(
        isMaskPermittedStipple(
          barrierSource.shadingMask,
          FRAME,
          start,
          end,
          target.scales.maskCheckSpacing,
        ),
      ).toBe(true)

      for (let right = left + 1; right < outcome.marks.length; right++) {
        const other = outcome.marks[right]!
        expect(
          Math.hypot(
            stipple.center[0] - other.center[0],
            stipple.center[1] - other.center[1],
          ),
        ).toBeGreaterThanOrEqual(target.scales.minimumSpacing)
      }
    }
  })

  it('continues the placement RNG state and repeats the full pipeline', () => {
    function run() {
      const target = model(source(([x]) => (x < 60 ? 0.9 : 0.2)), {
        stippleDensity: 0.25,
      })
      const rng = createRandom('placement-then-refinement')
      const placed = placeInitialStipples(target, rng)
      return refineStipples(target, rng, placed.marks, { maxAttempts: 120 })
    }

    expect(run()).toEqual(run())
  })

  it('returns the original marks when no strict improvement exists', () => {
    const target = model()
    const initial = frozenMarks([[[25, 25], 0.75]])
    const outcome = refineStipples(
      target,
      createRandom('no-improvement'),
      initial,
      { maxAttempts: 100 },
    )

    expect(outcome.marks).toBe(initial)
    expect(outcome.error).toBe(target.distributionError(initial))
  })

  it('rejects non-finite candidate errors without discarding the valid draft', () => {
    const target = model()
    const initial = frozenMarks([[[25, 25], 0.75]])
    const initialError = target.distributionError(initial)
    let evaluations = 0
    const nonFiniteCandidates = {
      ...target,
      distributionError: () =>
        evaluations++ === 0 ? initialError : Number.POSITIVE_INFINITY,
    } satisfies StipplingModel
    const outcome = refineStipples(
      nonFiniteCandidates,
      createRandom('non-finite-candidates'),
      initial,
      { maxAttempts: 20 },
    )

    expect(evaluations).toBeGreaterThan(1)
    expect(outcome.marks).toBe(initial)
    expect(outcome.error).toBe(initialError)
  })

  it('keeps refined centers out of an off-lattice exact-zero tone hole', () => {
    const holeCenter: Point = [20.2, 20.2]
    const holeSource = source(([x, y]) =>
      Math.hypot(x - holeCenter[0], y - holeCenter[1]) <= 0.2 ? 0 : 1,
    )
    const target = model(holeSource)
    const column = Math.floor(holeCenter[0] / target.lattice.cellWidth)
    const row = Math.floor(holeCenter[1] / target.lattice.cellHeight)
    const cellIndex = row * target.lattice.columns + column
    const cellStartX = column * target.lattice.cellWidth
    const cellStartY = row * target.lattice.cellHeight
    const initial = frozenMarks([[[90, 90], 0.75]])
    const errorByX = {
      ...target,
      distributionError: (marks: readonly StippleMark[]) =>
        marks[0]?.center[0] ?? 0,
    } satisfies StipplingModel
    const draws = [
      0,
      (cellIndex + 0.5) / target.lattice.sampleCount,
      (holeCenter[0] - cellStartX) / target.lattice.cellWidth,
      (holeCenter[1] - cellStartY) / target.lattice.cellHeight,
      0,
    ]
    const rng = {
      value: () => draws.shift() ?? 0,
    } as Random

    expect(target.lattice.samples[cellIndex]!.demand).toBe(1)
    expect(sampleEffectiveTone(holeSource, holeCenter)).toBe(0)

    const outcome = refineStipples(errorByX, rng, initial, {
      maxAttempts: 1,
    })

    expect(outcome.marks).toBe(initial)
    for (const stipple of outcome.marks) {
      expect(sampleEffectiveTone(holeSource, stipple.center)).toBeGreaterThan(0)
    }
  })

  it('extends lower attempt budgets as an exact deterministic prefix', () => {
    const target = model(source(([x]) => (x < 50 ? 1 : 0)))
    const stagedRng = createRandom('prefix-extension')
    const firstPrefix = refineStipples(
      target,
      stagedRng,
      RIGHT_HEAVY_MARKS,
      { maxAttempts: 20 },
    )
    const staged = refineStipples(target, stagedRng, firstPrefix.marks, {
      maxAttempts: 80,
    })
    const single = refineStipples(
      target,
      createRandom('prefix-extension'),
      RIGHT_HEAVY_MARKS,
      { maxAttempts: 100 },
    )

    expect(staged.marks).toEqual(single.marks)
    expect(staged.error).toBe(single.error)
    expect(single.error).toBeLessThanOrEqual(firstPrefix.error)
  })

  it('never worsens distribution error across increasing prefix budgets', () => {
    const target = model(source(([x]) => (x < 50 ? 1 : 0)))
    const budgets = [0, 5, 25, 100]
    const outcomes = budgets.map((maxAttempts) =>
      refineStipples(
        target,
        createRandom('monotonic-prefixes'),
        RIGHT_HEAVY_MARKS,
        { maxAttempts },
      ),
    )

    for (let index = 1; index < outcomes.length; index++) {
      expect(outcomes[index]!.error).toBeLessThanOrEqual(
        outcomes[index - 1]!.error,
      )
    }
  })

  it.each([-1, 1.5, Number.POSITIVE_INFINITY, 1_000_001])(
    'rejects malformed explicit attempt bound %s',
    (maxAttempts) => {
      expect(() =>
        refineStipples(
          model(),
          createRandom('invalid-refinement-bound'),
          RIGHT_HEAVY_MARKS,
          { maxAttempts },
        ),
      ).toThrow(RangeError)
    },
  )
})
