import { describe, expect, it } from 'vitest'

import {
  compareFlowingContoursCandidateScores,
  compareFlowingContoursCandidates,
  compareFlowingContoursObjectiveOrder,
  scoreFlowingContoursCandidate,
  type FlowingContoursObjectiveInput,
  type FlowingContoursObjectiveOrderKey,
} from '../sketches/flowing-contours/objective'
import type {
  CorrectedFlowingRidgeSample,
  FlowingContoursCandidate,
  FlowingContoursCandidateScore,
} from '../sketches/flowing-contours/types'

const BASE_INPUT = Object.freeze({
  accumulatedEvidence: 0.4,
  usefulLength: 0.4,
  directionalCoherence: 0.4,
  curvatureChange: 0.4,
  unsupportedTravel: 0.4,
  ambiguity: 0.4,
  representedOverlap: 0.4,
}) satisfies FlowingContoursObjectiveInput

const SCORE_FIELDS = Object.freeze([
  'accumulatedEvidence',
  'usefulLength',
  'directionalCoherence',
  'curvaturePenalty',
  'unsupportedTravelPenalty',
  'ambiguityPenalty',
  'representedOverlapPenalty',
  'total',
] as const satisfies readonly (keyof FlowingContoursCandidateScore)[])

function score(
  overrides: Partial<FlowingContoursObjectiveInput> = {},
  smoothing: unknown = 0.5,
): Readonly<FlowingContoursCandidateScore> {
  return scoreFlowingContoursCandidate(
    { ...BASE_INPUT, ...overrides },
    smoothing,
  )
}

function orderKey(
  overrides: Partial<FlowingContoursObjectiveOrderKey> = {},
): FlowingContoursObjectiveOrderKey {
  return {
    score: score(),
    stableId: 2,
    sampleIndex: 7,
    point: [3, 5],
    ...overrides,
  }
}

function candidate(
  id: number,
  fieldSampleIndex: number,
  point: readonly [number, number],
  candidateScore = score(),
): Pick<FlowingContoursCandidate, 'anchor' | 'score'> {
  const sample = {
    point,
    tangent: [1, 0],
    evidence: 1,
    coherence: 1,
    ambiguity: 0,
    scale: 1,
    alpha: 1,
  } as const satisfies CorrectedFlowingRidgeSample
  return {
    anchor: { id, fieldSampleIndex, sample },
    score: candidateScore,
  }
}

describe('Flowing Contours whole-candidate objective', () => {
  it('varies each reward and penalty independently with the documented sign', () => {
    const baseline = score()
    const cases = [
      ['accumulatedEvidence', 'accumulatedEvidence', 1] as const,
      ['usefulLength', 'usefulLength', 1] as const,
      ['directionalCoherence', 'directionalCoherence', 1] as const,
      ['curvatureChange', 'curvaturePenalty', -1] as const,
      ['unsupportedTravel', 'unsupportedTravelPenalty', -1] as const,
      ['ambiguity', 'ambiguityPenalty', -1] as const,
      ['representedOverlap', 'representedOverlapPenalty', -1] as const,
    ]

    for (const [inputField, scoreField, totalDirection] of cases) {
      const varied = score({ [inputField]: 0.6 })
      const changedFields = SCORE_FIELDS.filter(
        (field) => varied[field] !== baseline[field],
      )
      expect(changedFields, inputField).toEqual([scoreField, 'total'])
      expect(Math.sign(varied.total - baseline.total), inputField).toBe(
        totalDirection,
      )
    }
  })

  it('uses Flow smoothing only to strengthen curvature-change cost', () => {
    const low = score({}, 0)
    const middle = score({}, 0.5)
    const high = score({}, 1)
    const termsUnaffectedBySmoothing = SCORE_FIELDS.filter(
      (field) => field !== 'curvaturePenalty' && field !== 'total',
    )

    expect(high.curvaturePenalty).toBeGreaterThan(middle.curvaturePenalty)
    expect(middle.curvaturePenalty).toBeGreaterThan(low.curvaturePenalty)
    expect(high.total).toBeLessThan(middle.total)
    expect(middle.total).toBeLessThan(low.total)
    for (const field of termsUnaffectedBySmoothing) {
      expect(high[field], field).toBe(low[field])
    }
  })

  it('clamps finite measurements and fails malformed rewards and costs closed', () => {
    const malformed = scoreFlowingContoursCandidate(
      {
        accumulatedEvidence: Number.NaN,
        usefulLength: Number.POSITIVE_INFINITY,
        directionalCoherence: -10,
        curvatureChange: Number.NaN,
        unsupportedTravel: Number.NEGATIVE_INFINITY,
        ambiguity: 10,
        representedOverlap: -10,
      },
      Number.NaN,
    )

    expect(malformed).toEqual({
      accumulatedEvidence: 0,
      usefulLength: 0,
      directionalCoherence: 0,
      curvaturePenalty: 3,
      unsupportedTravelPenalty: 4.5,
      ambiguityPenalty: 3,
      representedOverlapPenalty: 0,
      total: -10.5,
    })
    expect(
      Object.values(malformed).every((value) => Number.isFinite(value)),
    ).toBe(true)
    expect(Object.isFrozen(malformed)).toBe(true)

    const absent = scoreFlowingContoursCandidate(null, undefined)
    expect(absent.accumulatedEvidence).toBe(0)
    expect(absent.usefulLength).toBe(0)
    expect(absent.directionalCoherence).toBe(0)
    expect(absent.curvaturePenalty).toBe(3)
    expect(absent.unsupportedTravelPenalty).toBe(4.5)
    expect(absent.ambiguityPenalty).toBe(3)
    expect(absent.representedOverlapPenalty).toBe(5)
    expect(Number.isFinite(absent.total)).toBe(true)
  })

  it('penalizes weak travel and represented overlap at whole-curve rank time', () => {
    const supported = score({
      unsupportedTravel: 0,
      representedOverlap: 0,
    })
    const weakTravel = score({
      unsupportedTravel: 0.5,
      representedOverlap: 0,
    })
    const represented = score({
      unsupportedTravel: 0,
      representedOverlap: 0.5,
    })

    expect(weakTravel.total).toBeLessThan(supported.total)
    expect(represented.total).toBeLessThan(supported.total)
    expect(compareFlowingContoursCandidateScores(supported, weakTravel)).toBe(
      -1,
    )
    expect(compareFlowingContoursCandidateScores(supported, represented)).toBe(
      -1,
    )
  })
})

describe('Flowing Contours deterministic objective ordering', () => {
  it('compares the exact term tuple before stable identity', () => {
    const totalTieWithMoreEvidence = {
      ...score(),
      accumulatedEvidence: score().accumulatedEvidence + 0.25,
      usefulLength: score().usefulLength - 0.25,
    }
    const weakerTupleWithEarlierId = orderKey({
      stableId: 0,
      score: score(),
    })
    const strongerTupleWithLaterId = orderKey({
      stableId: 99,
      score: totalTieWithMoreEvidence,
    })

    expect(totalTieWithMoreEvidence.total).toBe(score().total)
    expect(
      compareFlowingContoursObjectiveOrder(
        strongerTupleWithLaterId,
        weakerTupleWithEarlierId,
      ),
    ).toBe(-1)
  })

  it('breaks exact score ties by ID, sample index, then row-major point', () => {
    const keys = [
      orderKey({ stableId: 3 }),
      orderKey({ sampleIndex: 8 }),
      orderKey({ point: [2, 6] }),
      orderKey({ point: [4, 5] }),
      orderKey(),
    ]

    expect([...keys].sort(compareFlowingContoursObjectiveOrder)).toEqual([
      orderKey(),
      orderKey({ point: [4, 5] }),
      orderKey({ point: [2, 6] }),
      orderKey({ sampleIndex: 8 }),
      orderKey({ stableId: 3 }),
    ])
  })

  it('is antisymmetric and transitive across repeated stable sorts', () => {
    const first = orderKey({ stableId: 1 })
    const second = orderKey({ stableId: 2 })
    const third = orderKey({ stableId: 3 })
    const unordered = [third, first, second, third, second, first]
    const expected = [first, first, second, second, third, third]

    expect(compareFlowingContoursObjectiveOrder(first, second)).toBe(-1)
    expect(compareFlowingContoursObjectiveOrder(second, first)).toBe(1)
    expect(compareFlowingContoursObjectiveOrder(first, first)).toBe(0)
    expect(compareFlowingContoursObjectiveOrder(first, second)).toBeLessThan(0)
    expect(compareFlowingContoursObjectiveOrder(second, third)).toBeLessThan(0)
    expect(compareFlowingContoursObjectiveOrder(first, third)).toBeLessThan(0)
    expect([...unordered].sort(compareFlowingContoursObjectiveOrder)).toEqual(
      expected,
    )
    expect([...unordered].sort(compareFlowingContoursObjectiveOrder)).toEqual(
      expected,
    )
  })

  it('orders malformed keys after finite keys without returning NaN', () => {
    const finite = orderKey()
    const malformed = orderKey({
      stableId: Number.NaN,
      sampleIndex: Number.POSITIVE_INFINITY,
      point: [Number.NaN, Number.NEGATIVE_INFINITY],
    })

    expect(compareFlowingContoursObjectiveOrder(finite, malformed)).toBe(-1)
    expect(compareFlowingContoursObjectiveOrder(malformed, finite)).toBe(1)
    expect(
      Number.isNaN(compareFlowingContoursObjectiveOrder(finite, malformed)),
    ).toBe(false)
  })

  it('provides candidate ordering directly from stable anchor provenance', () => {
    const candidates = [
      candidate(2, 9, [5, 5]),
      candidate(1, 9, [5, 5]),
      candidate(1, 7, [5, 5]),
      candidate(1, 7, [4, 5]),
    ]

    expect([...candidates].sort(compareFlowingContoursCandidates)).toEqual([
      candidate(1, 7, [4, 5]),
      candidate(1, 7, [5, 5]),
      candidate(1, 9, [5, 5]),
      candidate(2, 9, [5, 5]),
    ])
  })
})
