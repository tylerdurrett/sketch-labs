import { describe, expect, it } from 'vitest'

import { createRandom } from '../random'
import type { CoordinateSpace } from '../scene'
import {
  createShadingMask,
  createToneField,
  type ToneSource,
} from '../shadingFields'
import { isMaskPermittedStipple } from '../stipplingStrategy/mask'
import { createStipplingModel } from '../stipplingStrategy/model'
import { placeInitialStipples } from '../stipplingStrategy/placement'
import type {
  StippleMark,
  StipplingControls,
  StipplingModel,
} from '../stipplingStrategy/types'
import type { Point } from '../types'

const FRAME: CoordinateSpace = Object.freeze({ width: 1000, height: 1000 })

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

function endpoints(
  mark: Readonly<StippleMark>,
  length: number,
): readonly [Point, Point] {
  const halfX = (Math.cos(mark.orientation) * length) / 2
  const halfY = (Math.sin(mark.orientation) * length) / 2
  return [
    [mark.center[0] - halfX, mark.center[1] - halfY],
    [mark.center[0] + halfX, mark.center[1] + halfY],
  ]
}

describe('initial Stipple placement', () => {
  it('repeats marks, order, work, and completion for the same Seed', () => {
    const target = model()
    const first = placeInitialStipples(target, createRandom('repeatable'))
    const second = placeInitialStipples(target, createRandom('repeatable'))

    expect(first).toEqual(second)
    expect(first.requestedCountReached).toBe(true)
    expect(first.marks).toHaveLength(target.scales.targetCount)
  })

  it('changes placement or unbiased orientation with a different Seed', () => {
    const target = model()
    const first = placeInitialStipples(target, createRandom('variation-a'))
    const second = placeInitialStipples(target, createRandom('variation-b'))

    expect(second.marks).not.toEqual(first.marks)
    expect(second.marks).toHaveLength(first.marks.length)
  })

  it('draws aggregate orientations uniformly over the undirected half-circle', () => {
    const outcome = placeInitialStipples(
      model(),
      createRandom('orientation-uniformity'),
    )
    const quartiles = [0, 0, 0, 0]

    for (const mark of outcome.marks) {
      expect(mark.orientation).toBeGreaterThanOrEqual(0)
      expect(mark.orientation).toBeLessThan(Math.PI)
      const quartile = Math.min(
        3,
        Math.floor((mark.orientation / Math.PI) * 4),
      )
      quartiles[quartile] = quartiles[quartile]! + 1
    }

    for (const count of quartiles) {
      expect(count / outcome.marks.length).toBeGreaterThan(0.2)
      expect(count / outcome.marks.length).toBeLessThan(0.3)
    }
  })

  it('places substantially more marks in darker demand', () => {
    const target = model(source(([x]) => (x < FRAME.width / 2 ? 0.9 : 0.15)))
    const outcome = placeInitialStipples(target, createRandom('tone-weighting'))
    const darkCount = outcome.marks.filter(
      ({ center }) => center[0] < FRAME.width / 2,
    ).length
    const lightCount = outcome.marks.length - darkCount

    expect(outcome.requestedCountReached).toBe(true)
    expect(darkCount).toBeGreaterThan(lightCount * 2)
  })

  it('applies uniform soft permission linearly to requested abundance', () => {
    const fullModel = model(source(() => 1, () => 1))
    const halfModel = model(source(() => 1, () => 0.5))
    const quarterModel = model(source(() => 1, () => 0.25))
    const full = placeInitialStipples(fullModel, createRandom('permission'))
    const half = placeInitialStipples(halfModel, createRandom('permission'))
    const quarter = placeInitialStipples(
      quarterModel,
      createRandom('permission'),
    )

    expect(full.requestedCountReached).toBe(true)
    expect(half.requestedCountReached).toBe(true)
    expect(quarter.requestedCountReached).toBe(true)
    expect(half.marks.length).toBe(full.marks.length / 2)
    expect(quarter.marks.length).toBe(full.marks.length / 4)
  })

  it.each([
    [0.005, 4],
    [0.001, 1],
  ])(
    'completes deterministic low soft permission %s with %s requested marks',
    (permission, expectedCount) => {
      const target = model(source(() => 1, () => permission))
      const first = placeInitialStipples(
        target,
        createRandom(`low-permission-${permission}`),
      )
      const second = placeInitialStipples(
        target,
        createRandom(`low-permission-${permission}`),
      )

      expect(target.scales.targetCount).toBe(expectedCount)
      expect(first).toEqual(second)
      expect(first.requestedCountReached).toBe(true)
      expect(first.marks).toHaveLength(expectedCount)
      expect(first.attemptsUsed).toBeLessThanOrEqual(1_000_000)
    },
  )

  it('validates every complete fixed-length segment against exact-zero permission', () => {
    const barrierSource = source(
      () => 1,
      ([x]) => (Math.abs(x - FRAME.width / 2) <= 1 ? 0 : 1),
    )
    const target = model(barrierSource)
    const outcome = placeInitialStipples(target, createRandom('thin-barrier'))

    expect(outcome.requestedCountReached).toBe(true)
    for (const mark of outcome.marks) {
      const [start, end] = endpoints(mark, target.scales.stippleLength)
      expect(
        isMaskPermittedStipple(
          barrierSource.shadingMask,
          FRAME,
          start,
          end,
          target.scales.maskCheckSpacing,
        ),
      ).toBe(true)
      expect(Math.hypot(end[0] - start[0], end[1] - start[1])).toBeCloseTo(
        target.scales.stippleLength,
        12,
      )
    }
  })

  it('enforces density-derived minimum center separation', () => {
    const target = model()
    const outcome = placeInitialStipples(target, createRandom('separation'))
    const minimum = target.scales.minimumSpacing

    for (let left = 0; left < outcome.marks.length; left++) {
      for (let right = left + 1; right < outcome.marks.length; right++) {
        const a = outcome.marks[left]!.center
        const b = outcome.marks[right]!.center
        expect(Math.hypot(a[0] - b[0], a[1] - b[1])).toBeGreaterThanOrEqual(
          minimum,
        )
      }
    }
  })

  it('increases accepted abundance with density without consulting fidelity', () => {
    const sparseModel = model(source(), {
      stippleDensity: 0.5,
      distributionFidelity: 0,
    })
    const denseLooseModel = model(source(), {
      stippleDensity: 2,
      distributionFidelity: 0,
    })
    const denseFaithfulModel = model(source(), {
      stippleDensity: 2,
      distributionFidelity: 1,
    })
    const sparse = placeInitialStipples(sparseModel, createRandom('density'))
    const denseLoose = placeInitialStipples(
      denseLooseModel,
      createRandom('density'),
    )
    const denseFaithful = placeInitialStipples(
      denseFaithfulModel,
      createRandom('density'),
    )

    expect(sparse.requestedCountReached).toBe(true)
    expect(denseLoose.requestedCountReached).toBe(true)
    expect(denseLoose.marks.length).toBe(sparse.marks.length * 4)
    expect(denseFaithful).toEqual(denseLoose)
  })

  it('returns an immutable ordered partial result at a failed-placement bound', () => {
    const cell = FRAME.width / 64
    const impossibleSource = source(
      () => 1,
      ([x, y]) => {
        const offsetX = Math.abs(x / cell - (Math.floor(x / cell) + 0.5))
        const offsetY = Math.abs(y / cell - (Math.floor(y / cell) + 0.5))
        return offsetX < 0.0001 && offsetY < 0.0001 ? 1 : 0
      },
    )
    const target = model(impossibleSource)
    const outcome = placeInitialStipples(target, createRandom('bounded'), {
      maxAttempts: 200,
    })

    expect(target.scales.targetCount).toBeGreaterThan(0)
    expect(outcome).toEqual({
      marks: [],
      attemptsUsed: 200,
      requestedCountReached: false,
    })
    expect(Object.isFrozen(outcome)).toBe(true)
    expect(Object.isFrozen(outcome.marks)).toBe(true)
  })

  it.each([-1, 1.5, Number.POSITIVE_INFINITY, 1_000_001])(
    'rejects malformed explicit attempt bound %s',
    (maxAttempts) => {
      expect(() =>
        placeInitialStipples(model(), createRandom('invalid-bound'), {
          maxAttempts,
        }),
      ).toThrow(RangeError)
    },
  )

  it('preserves acceptance order rather than sorting geometry afterward', () => {
    const outcome = placeInitialStipples(
      model(source(), { stippleDensity: 0.25 }),
      createRandom('ordered-output'),
    )
    const firstCenters = outcome.marks.slice(0, 5).map(({ center }) =>
      center.map((coordinate) => Number(coordinate.toFixed(6))),
    )

    expect(firstCenters).toMatchInlineSnapshot(`
      [
        [
          164.70557,
          359.140858,
        ],
        [
          24.305763,
          171.420159,
        ],
        [
          90.556516,
          115.10137,
        ],
        [
          514.063507,
          208.201528,
        ],
        [
          435.715711,
          852.85348,
        ],
      ]
    `)
    expect(Object.isFrozen(outcome.marks[0])).toBe(true)
    expect(Object.isFrozen(outcome.marks[0]!.center)).toBe(true)
  })
})
