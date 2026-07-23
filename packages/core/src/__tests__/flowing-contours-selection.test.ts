import { describe, expect, it } from 'vitest'

import {
  createFlowingContoursAccounting,
  snapshotFlowingContoursDiagnostics,
} from '../sketches/flowing-contours/accounting'
import { createFlowingContoursTestLimits } from '../sketches/flowing-contours/limits'
import {
  selectFlowingContoursCandidate,
  type FlowingContoursSelectionOptions,
} from '../sketches/flowing-contours/selection'
import type {
  CorrectedFlowingRidgeSample,
  FlowingContoursCandidate,
  FlowingContoursCandidateScore,
  FlowingContoursEndpointReason,
  FlowingContoursSpanSupportProvenance,
} from '../sketches/flowing-contours/types'

function sample(x: number): CorrectedFlowingRidgeSample {
  return {
    point: [x, 0],
    tangent: [1, 0],
    evidence: 0.8,
    coherence: 0.9,
    ambiguity: 0.1,
    scale: 1,
    alpha: 1,
  }
}

function score(total = 1): FlowingContoursCandidateScore {
  return {
    accumulatedEvidence: total,
    usefulLength: 0,
    directionalCoherence: 0,
    curvaturePenalty: 0,
    unsupportedTravelPenalty: 0,
    ambiguityPenalty: 0,
    representedOverlapPenalty: 0,
    total,
  }
}

function support(
  kind: 'direct-evidence' | 'bounded-gap',
  startSampleIndex: number,
  endSampleIndex: number,
  length: number,
): FlowingContoursSpanSupportProvenance {
  return {
    kind,
    startSampleIndex,
    endSampleIndex,
    length,
    entryEvidence: 0.8,
    exitEvidence: 0.7,
    directionalAlignment: 0.9,
  }
}

function candidate(
  points: readonly number[] = [0, 5, 10],
  overrides: {
    score?: FlowingContoursCandidateScore
    support?: readonly FlowingContoursSpanSupportProvenance[]
    start?: FlowingContoursEndpointReason
    end?: FlowingContoursEndpointReason
    anchorId?: number
  } = {},
): FlowingContoursCandidate {
  const samples = points.map(sample)
  const anchorIndex = Math.floor(samples.length / 2)
  const anchor = {
    id: overrides.anchorId ?? 4,
    fieldSampleIndex: 0,
    sample: samples[anchorIndex]!,
  }
  return {
    anchor,
    backward: {
      direction: 'backward',
      samples: samples.slice(0, anchorIndex + 1).reverse(),
      spanSupport: [],
      endpointReason: overrides.start ?? 'source-boundary',
      searchStepCount: anchorIndex,
    },
    forward: {
      direction: 'forward',
      samples: samples.slice(anchorIndex),
      spanSupport: [],
      endpointReason: overrides.end ?? 'evidence-exhausted',
      searchStepCount: samples.length - anchorIndex - 1,
    },
    samples,
    spanSupport:
      overrides.support ??
      points.slice(1).map((_point, index) =>
        support('direct-evidence', index, index + 1, 5),
      ),
    length: points.at(-1)! - points[0]!,
    score: overrides.score ?? score(),
  }
}

const OPTIONS: FlowingContoursSelectionOptions = Object.freeze({
  analysisWidth: 60,
  analysisHeight: 80,
  minimumStrokeLength: 0.1,
  nextAcceptedId: 7,
})

function select(
  source: FlowingContoursCandidate,
  optionOverrides: Partial<FlowingContoursSelectionOptions> = {},
  accounting = createFlowingContoursAccounting(),
  limits = createFlowingContoursTestLimits({
    'candidate-count': 8,
    'accepted-curve-count': 4,
    'raw-trajectory-point-count': 32,
  })!,
) {
  return {
    result: selectFlowingContoursCandidate(
      source,
      { ...OPTIONS, ...optionOverrides },
      accounting,
      limits,
    ),
    accounting,
  }
}

describe('Flowing Contours atomic candidate selection', () => {
  it('rejects below the useful composition-relative length and accepts equality', () => {
    const below = select(candidate([0, 4.999, 9.999]))
    const exact = select(candidate([0, 5, 10]))

    expect(below.result).toEqual({
      kind: 'rejected',
      reason: 'below-minimum-length',
    })
    expect(exact.result.kind).toBe('accepted')
    expect(exact.result.kind === 'accepted' && exact.result.trajectory.length)
      .toBe(10)
  })

  it('rejects below the whole-objective floor and accepts equality', () => {
    expect(select(candidate(undefined, { score: score(0.999) })).result)
      .toEqual({ kind: 'rejected', reason: 'below-minimum-score' })
    expect(select(candidate(undefined, { score: score(1) })).result.kind)
      .toBe('accepted')
  })

  it('never emits a partial trajectory or touches suppression-shaped counts', () => {
    const { result, accounting } = select(candidate([0, 2, 4]))

    expect(result).toEqual({
      kind: 'rejected',
      reason: 'below-minimum-length',
    })
    expect('trajectory' in result).toBe(false)
    expect(accounting.rawTrajectoryCount).toBe(0)
    expect(accounting.rawTrajectoryPointCount).toBe(0)
    expect(accounting.suppressedAnchorCount).toBe(0)
    expect(accounting.suppressedEvidenceSampleCount).toBe(0)
    expect(accounting.candidateCount).toBe(1)
    expect(accounting.rejectedCandidateCount).toBe(1)
  })

  it('retains exact unsupported-span aggregates and both endpoint reasons', () => {
    const { result, accounting } = select(
      candidate([0, 3, 7, 10], {
        support: [
          support('bounded-gap', 0, 1, 1.25),
          support('direct-evidence', 1, 2, 4),
          support('bounded-gap', 2, 3, 0.75),
        ],
        start: 'ambiguity',
        end: 'alpha-boundary',
      }),
    )

    expect(result.kind).toBe('accepted')
    if (result.kind !== 'accepted') return
    expect(result.trajectory.maximumUnsupportedSpanLength).toBe(1.25)
    expect(result.trajectory.totalUnsupportedSpanLength).toBe(2)
    expect(result.trajectory.startEndpointReason).toBe('ambiguity')
    expect(result.trajectory.endEndpointReason).toBe('alpha-boundary')
    expect(accounting.acceptedMaximumUnsupportedSpanLength).toBe(1.25)
    expect(accounting.acceptedTotalUnsupportedSpanLength).toBe(2)
    expect(accounting.endpointReasonCounts.ambiguity).toBe(1)
    expect(accounting.endpointReasonCounts['alpha-boundary']).toBe(1)
  })

  it.each([
    ['sample point', (value: FlowingContoursCandidate) => {
      ;(value.samples[1]!.point as number[])[0] = Number.NaN
    }],
    ['score term', (value: FlowingContoursCandidate) => {
      ;(value.score as { total: number }).total = Number.POSITIVE_INFINITY
    }],
    ['score aggregate', (value: FlowingContoursCandidate) => {
      ;(value.score as { total: number }).total = 2
    }],
    ['length aggregate', (value: FlowingContoursCandidate) => {
      ;(value as { length: number }).length = 11
    }],
    ['span aggregate', (value: FlowingContoursCandidate) => {
      ;(value.spanSupport[0] as { length: number }).length = Number.NaN
    }],
  ])('fails malformed/non-finite %s closed without accounting mutation', (_name, corrupt) => {
    const source = candidate()
    corrupt(source)
    const accounting = createFlowingContoursAccounting()
    const before = snapshotFlowingContoursDiagnostics(accounting)
    const { result } = select(source, {}, accounting)

    expect(result).toEqual({ kind: 'rejected', reason: 'invalid-input' })
    expect(snapshotFlowingContoursDiagnostics(accounting)).toEqual(before)
  })

  it('enforces the candidate cap exactly before considering another candidate', () => {
    const accounting = createFlowingContoursAccounting()
    const limits = createFlowingContoursTestLimits({
      'candidate-count': 1,
      'accepted-curve-count': 1,
      'raw-trajectory-point-count': 8,
    })!

    expect(select(candidate(), {}, accounting, limits).result.kind).toBe(
      'accepted',
    )
    const second = select(candidate(), {}, accounting, limits)
    expect(second.result).toEqual({
      kind: 'rejected',
      reason: 'candidate-count-limit',
    })
    expect(accounting.candidateCount).toBe(1)
    expect(accounting.acceptedCandidateCount).toBe(1)
    expect(accounting.termination).toBe('limit-reached')
    expect(accounting.limitedBy).toBe('candidate-count')
  })

  it('rejects the whole candidate at the accepted-curve cap', () => {
    const accounting = createFlowingContoursAccounting()
    accounting.acceptedCandidateCount = 1
    accounting.rawTrajectoryCount = 1
    accounting.candidateCount = 1
    const limits = createFlowingContoursTestLimits({
      'candidate-count': 3,
      'accepted-curve-count': 1,
      'raw-trajectory-point-count': 8,
    })!
    const { result } = select(candidate(), {}, accounting, limits)

    expect(result).toEqual({
      kind: 'rejected',
      reason: 'accepted-curve-count-limit',
    })
    expect(accounting.candidateCount).toBe(2)
    expect(accounting.acceptedCandidateCount).toBe(1)
    expect(accounting.rejectedCandidateCount).toBe(1)
    expect(accounting.rawTrajectoryCount).toBe(1)
    expect(accounting.rawTrajectoryPointCount).toBe(0)
    expect(accounting.limitedBy).toBe('accepted-curve-count')
  })

  it('accepts the raw-point cap exactly and rejects a one-point overrun', () => {
    const exactAccounting = createFlowingContoursAccounting()
    exactAccounting.rawTrajectoryPointCount = 2
    const overAccounting = createFlowingContoursAccounting()
    overAccounting.rawTrajectoryPointCount = 3
    const limits = createFlowingContoursTestLimits({
      'candidate-count': 3,
      'accepted-curve-count': 2,
      'raw-trajectory-point-count': 5,
    })!

    expect(select(candidate(), {}, exactAccounting, limits).result.kind)
      .toBe('accepted')
    const over = select(candidate(), {}, overAccounting, limits)
    expect(over.result).toEqual({
      kind: 'rejected',
      reason: 'raw-trajectory-point-count-limit',
    })
    expect(overAccounting.rawTrajectoryPointCount).toBe(3)
    expect(overAccounting.rawTrajectoryCount).toBe(0)
    expect(overAccounting.acceptedCandidateCount).toBe(0)
    expect(overAccounting.limitedBy).toBe('raw-trajectory-point-count')
  })

  it('uses caller-reserved IDs and preserves invocation order', () => {
    const accounting = createFlowingContoursAccounting()
    const first = select(candidate(undefined, { anchorId: 12 }), {
      nextAcceptedId: 40,
    }, accounting)
    const second = select(candidate(undefined, { anchorId: 3 }), {
      nextAcceptedId: 41,
    }, accounting)

    expect(first.result.kind === 'accepted' && first.result.trajectory.id)
      .toBe(40)
    expect(second.result.kind === 'accepted' && second.result.trajectory.id)
      .toBe(41)
    expect(first.result.kind === 'accepted' && first.result.trajectory.anchorId)
      .toBe(12)
    expect(second.result.kind === 'accepted' && second.result.trajectory.anchorId)
      .toBe(3)
  })

  it('returns a deeply frozen snapshot detached from the candidate', () => {
    const source = candidate()
    const { result } = select(source)
    expect(result.kind).toBe('accepted')
    if (result.kind !== 'accepted') return
    const before = result.trajectory.samples[0]!.point[0]

    ;(source.samples[0]!.point as number[])[0] = 99
    ;(source.spanSupport[0] as { length: number }).length = 99
    ;(source.score as { total: number }).total = 99

    expect(result.trajectory.samples[0]!.point[0]).toBe(before)
    expect(result.trajectory.spanSupport[0]!.length).toBe(5)
    expect(result.trajectory.score.total).toBe(1)
    expect(Object.isFrozen(result)).toBe(true)
    expect(Object.isFrozen(result.trajectory)).toBe(true)
    expect(Object.isFrozen(result.trajectory.samples)).toBe(true)
    expect(Object.isFrozen(result.trajectory.samples[0])).toBe(true)
    expect(Object.isFrozen(result.trajectory.samples[0]!.point)).toBe(true)
    expect(Object.isFrozen(result.trajectory.spanSupport[0])).toBe(true)
    expect(Object.isFrozen(result.trajectory.score)).toBe(true)
  })

  it('distinguishes evidence completion from conservatively accepted safety truncation', () => {
    const evidence = select(
      candidate(undefined, {
        start: 'source-boundary',
        end: 'evidence-exhausted',
      }),
    )
    const safety = select(
      candidate(undefined, {
        start: 'safety-limit',
        end: 'evidence-exhausted',
      }),
    )

    expect(evidence.result.kind).toBe('accepted')
    expect(safety.result.kind).toBe('accepted')
    if (
      evidence.result.kind !== 'accepted' ||
      safety.result.kind !== 'accepted'
    ) return
    expect(evidence.result.safetyTruncated).toBe(false)
    expect(safety.result.safetyTruncated).toBe(true)
    expect(safety.result.trajectory.startEndpointReason).toBe('safety-limit')
    expect(safety.result.trajectory.endEndpointReason).toBe(
      'evidence-exhausted',
    )
    expect(
      safety.accounting.endpointReasonCounts['safety-limit'],
    ).toBe(1)
    expect(
      safety.accounting.endpointReasonCounts['evidence-exhausted'],
    ).toBe(1)
  })

  it('never lets a safety endpoint override whole-candidate quality gates', () => {
    const result = select(
      candidate([0, 2, 4], {
        start: 'safety-limit',
        end: 'safety-limit',
      }),
    )

    expect(result.result).toEqual({
      kind: 'rejected',
      reason: 'below-minimum-length',
    })
    expect(result.accounting.rawTrajectoryCount).toBe(0)
    expect(result.accounting.endpointReasonCounts['safety-limit']).toBe(2)
  })
})
