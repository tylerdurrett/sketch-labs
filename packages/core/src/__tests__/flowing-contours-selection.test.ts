import { describe, expect, it } from 'vitest'

import {
  createFlowingContoursAccounting,
  snapshotFlowingContoursDiagnostics,
  type FlowingContoursAccounting,
} from '../sketches/flowing-contours/accounting'
import { sampleFlowingContoursField } from '../sketches/flowing-contours/field'
import { measureFlowingContoursCurvatureChange } from '../sketches/flowing-contours/growth'
import {
  createFlowingContoursTestLimits,
  FLOWING_CONTOURS_LIMITS,
  type FlowingContoursLimits,
} from '../sketches/flowing-contours/limits'
import { scoreFlowingContoursCandidate } from '../sketches/flowing-contours/objective'
import { searchFlowingContoursCandidate } from '../sketches/flowing-contours/search'
import {
  isFlowingContoursAcceptedSelectionFromField,
  selectFlowingContoursCandidate,
  type FlowingContoursSelectionOptions,
} from '../sketches/flowing-contours/selection'
import type {
  CorrectedFlowingRidgeSample,
  FlowingContoursCandidate,
  FlowingContoursCandidateScore,
  FlowingContoursEndpointReason,
  FlowingContoursField,
  FlowingContoursSpanSupportProvenance,
} from '../sketches/flowing-contours/types'

const ANALYSIS_DIAGONAL = 100

function sample(
  x: number,
  overrides: Partial<CorrectedFlowingRidgeSample> = {},
): CorrectedFlowingRidgeSample {
  return {
    point: [x, 0],
    tangent: [1, 0],
    evidence: 0.8,
    coherence: 0.9,
    ambiguity: 0.1,
    scale: 1,
    alpha: 1,
    ...overrides,
  }
}

function lengthBetween(
  samples: readonly CorrectedFlowingRidgeSample[],
  start: number,
  end: number,
): number {
  let length = 0
  for (let index = start + 1; index <= end; index += 1) {
    const previous = samples[index - 1]!.point
    const current = samples[index]!.point
    length += Math.hypot(current[0] - previous[0], current[1] - previous[1])
  }
  return length
}

function tangentAlignment(
  samples: readonly CorrectedFlowingRidgeSample[],
  start: number,
  end: number,
): number {
  let result = 1
  for (let index = start + 1; index <= end; index += 1) {
    const previous = samples[index - 1]!.tangent
    const current = samples[index]!.tangent
    result = Math.min(
      result,
      previous[0] * current[0] + previous[1] * current[1],
    )
  }
  return result
}

function support(
  samples: readonly CorrectedFlowingRidgeSample[],
  kind: 'direct-evidence' | 'bounded-gap',
  startSampleIndex: number,
  endSampleIndex: number,
): FlowingContoursSpanSupportProvenance {
  return {
    kind,
    startSampleIndex,
    endSampleIndex,
    length: lengthBetween(samples, startSampleIndex, endSampleIndex),
    entryEvidence: samples[startSampleIndex]!.evidence,
    exitEvidence: samples[endSampleIndex]!.evidence,
    directionalAlignment: tangentAlignment(
      samples,
      startSampleIndex,
      endSampleIndex,
    ),
  }
}

function candidateScore(
  samples: readonly CorrectedFlowingRidgeSample[],
  spans: readonly FlowingContoursSpanSupportProvenance[],
  directionalCoherence?: number,
): Readonly<FlowingContoursCandidateScore> {
  const length = lengthBetween(samples, 0, samples.length - 1)
  const segmentCount = samples.length - 1
  const unsupportedLength = spans.reduce(
    (sum, span) => sum + (span.kind === 'bounded-gap' ? span.length : 0),
    0,
  )
  return scoreFlowingContoursCandidate(
    {
      accumulatedEvidence:
        samples.reduce((sum, value) => sum + value.evidence, 0) /
        samples.length,
      usefulLength: length / ANALYSIS_DIAGONAL,
      directionalCoherence:
        directionalCoherence ??
        (samples.slice(1).reduce((sum, value, index) => {
          const previous = samples[index]!.tangent
          return (
            sum +
            Math.max(
              0,
              previous[0] * value.tangent[0] + previous[1] * value.tangent[1],
            )
          )
        }, 0) /
          segmentCount),
      curvatureChange:
        measureFlowingContoursCurvatureChange(
          samples.map((value) => value.point),
        ) / segmentCount,
      unsupportedTravel: unsupportedLength / ANALYSIS_DIAGONAL,
      ambiguity:
        samples.reduce((sum, value) => sum + value.ambiguity, 0) /
        samples.length,
      representedOverlap: 0,
    },
    0,
  )
}

interface CandidateOverrides {
  readonly samples?: readonly CorrectedFlowingRidgeSample[]
  readonly score?: Readonly<FlowingContoursCandidateScore>
  readonly support?: readonly FlowingContoursSpanSupportProvenance[]
  readonly start?: FlowingContoursEndpointReason
  readonly end?: FlowingContoursEndpointReason
  readonly anchorId?: number
}

function candidate(
  points: readonly number[] = [0, 5, 10],
  overrides: CandidateOverrides = {},
): FlowingContoursCandidate {
  const samples = overrides.samples ?? points.map((point) => sample(point))
  const spans = overrides.support ?? [
    support(samples, 'direct-evidence', 0, samples.length - 1),
  ]
  const anchorSample = samples[0]!
  const backwardAnchor = {
    ...anchorSample,
    point: [...anchorSample.point] as [number, number],
    tangent: [-anchorSample.tangent[0], -anchorSample.tangent[1]] as [
      number,
      number,
    ],
  }
  return {
    anchor: {
      id: overrides.anchorId ?? 4,
      fieldSampleIndex: 0,
      sample: anchorSample,
    },
    backward: {
      direction: 'backward',
      samples: [backwardAnchor],
      spanSupport: [],
      endpointReason: overrides.start ?? 'source-boundary',
      searchStepCount: 0,
    },
    forward: {
      direction: 'forward',
      samples,
      spanSupport: spans,
      endpointReason: overrides.end ?? 'evidence-exhausted',
      searchStepCount: samples.length - 1,
    },
    samples,
    spanSupport: spans,
    length: lengthBetween(samples, 0, samples.length - 1),
    score: { ...(overrides.score ?? candidateScore(samples, spans)) },
  }
}

function replaceSupport(
  source: FlowingContoursCandidate,
  spans: readonly FlowingContoursSpanSupportProvenance[],
): void {
  ;(source as { spanSupport: typeof spans }).spanSupport = spans
  ;(source.forward as { spanSupport: typeof spans }).spanSupport = spans
}

const OPTIONS: FlowingContoursSelectionOptions = Object.freeze({
  analysisWidth: 60,
  analysisHeight: 80,
  minimumStrokeLength: 0.1,
})

function limits(
  overrides: Partial<Readonly<FlowingContoursLimits>> = {},
): FlowingContoursLimits {
  const result = createFlowingContoursTestLimits({
    'candidate-count': 8,
    'accepted-curve-count': 4,
    'raw-trajectory-point-count': 32,
    ...overrides,
  })
  if (result === null) throw new Error('Expected valid test limits')
  return result
}

function select(
  source: FlowingContoursCandidate,
  optionOverrides: Partial<FlowingContoursSelectionOptions> = {},
  accounting = createFlowingContoursAccounting(),
  policy = limits(),
) {
  return {
    result: selectFlowingContoursCandidate(
      source,
      { ...OPTIONS, ...optionOverrides },
      accounting,
      policy,
    ),
    accounting,
  }
}

function seedAccepted(
  accounting: FlowingContoursAccounting,
  rawPointCount: number,
): void {
  accounting.candidateCount = 1
  accounting.acceptedCandidateCount = 1
  accounting.rawTrajectoryCount = 1
  accounting.rawTrajectoryPointCount = rawPointCount
  accounting.endpointReasonCounts['source-boundary'] = 1
  accounting.endpointReasonCounts['evidence-exhausted'] = 1
}

function straightField(width: number, height: number): FlowingContoursField {
  const sampleCount = width * height
  const center = (height - 1) / 2
  const evidence = Array.from({ length: sampleCount }, (_value, index) => {
    const y = Math.floor(index / width)
    const distance = y - center
    return Math.exp(-(distance * distance) / (2 * 0.55 * 0.55))
  })
  return Object.freeze({
    sourceWidth: width,
    sourceHeight: height,
    width,
    height,
    luminance: Object.freeze(Array(sampleCount).fill(0.5)),
    alpha: Object.freeze(Array(sampleCount).fill(1)),
    positiveSupport: Object.freeze(Array(sampleCount).fill(true)),
    contourEvidence: Object.freeze(evidence),
    tangentX: Object.freeze(Array(sampleCount).fill(1)),
    tangentY: Object.freeze(Array(sampleCount).fill(0)),
    tangentCoherence: Object.freeze(Array(sampleCount).fill(1)),
    ambiguity: Object.freeze(Array(sampleCount).fill(0)),
    ridgeScale: Object.freeze(Array(sampleCount).fill(1)),
  })
}

describe('Flowing Contours atomic candidate selection', () => {
  it('accepts the exact canonical assembly produced by FC10', () => {
    const field = straightField(21, 11)
    const point = [10, 5] as const
    const anchorSample = sampleFlowingContoursField(field, point)
    expect(anchorSample).not.toBeNull()
    const policy = limits({ 'search-step-count': 96 })
    const searched = searchFlowingContoursCandidate(
      field,
      {
        id: 2,
        fieldSampleIndex: 5 * field.width + 10,
        sample: anchorSample!,
      },
      {
        continuity: 0.45,
        flowSmoothing: 0.7,
        ridgeStepOptions: { stepLength: 1 },
      },
      policy,
    )
    expect(searched).not.toBeNull()

    const result = selectFlowingContoursCandidate(
      searched!,
      {
        analysisWidth: field.width,
        analysisHeight: field.height,
        minimumStrokeLength: 0.1,
      },
      createFlowingContoursAccounting(),
      policy,
    )
    expect(result.kind).toBe('accepted')
    if (result.kind !== 'accepted') return
    expect(result.trajectory.samples).toEqual(searched!.samples)
    expect(result.trajectory.length).toBe(searched!.length)
    expect(result.trajectory.anchorId).toBe(2)
    expect(isFlowingContoursAcceptedSelectionFromField(result, field)).toBe(
      true,
    )
    expect(
      isFlowingContoursAcceptedSelectionFromField(
        result,
        straightField(21, 11),
      ),
    ).toBe(false)
    expect(
      isFlowingContoursAcceptedSelectionFromField({ ...result }, field),
    ).toBe(false)
  })

  it('keeps structural-candidate acceptance unbranded', () => {
    const result = select(candidate([0, 5, 10])).result

    expect(result.kind).toBe('accepted')
    expect(
      isFlowingContoursAcceptedSelectionFromField(
        result,
        straightField(21, 11),
      ),
    ).toBe(false)
  })

  it('accepts canonical coherence scored from legal near-unit tangents', () => {
    const tangentScale = 1 + 5e-9
    const samples = [
      sample(0, { tangent: [1, 0] }),
      sample(10, {
        tangent: [0.8 * tangentScale, 0.6 * tangentScale],
      }),
    ]
    const firstTangentLength = Math.hypot(...samples[0]!.tangent)
    const secondTangentLength = Math.hypot(...samples[1]!.tangent)
    const rawAlignment =
      samples[0]!.tangent[0] * samples[1]!.tangent[0] +
      samples[0]!.tangent[1] * samples[1]!.tangent[1]
    const normalizedAlignment =
      (samples[0]!.tangent[0] / firstTangentLength) *
        (samples[1]!.tangent[0] / secondTangentLength) +
      (samples[0]!.tangent[1] / firstTangentLength) *
        (samples[1]!.tangent[1] / secondTangentLength)
    const spans = [support(samples, 'direct-evidence', 0, 1)]
    const source = candidate(undefined, {
      samples,
      support: spans,
      score: candidateScore(samples, spans, normalizedAlignment),
    })

    expect(Math.abs(secondTangentLength - 1)).toBeLessThan(1e-8)
    expect(normalizedAlignment).not.toBe(rawAlignment)
    expect(select(source).result.kind).toBe('accepted')
  })

  it('uses exact recomputed composition-relative length below and at the threshold', () => {
    const nextBelowTen = 10 - Number.EPSILON * 10
    const below = select(candidate([0, 5, nextBelowTen]))
    const exact = select(candidate([0, 5, 10]))

    expect(below.result).toEqual({
      kind: 'rejected',
      reason: 'below-minimum-length',
    })
    expect(exact.result.kind).toBe('accepted')
    expect(
      exact.result.kind === 'accepted' && exact.result.trajectory.length,
    ).toBe(10)
  })

  it('rejects below the whole-objective floor and accepts exact equality', () => {
    const exactSamples = [
      sample(0, {
        tangent: [1, 0],
        evidence: 0.175,
        ambiguity: 0,
      }),
      sample(10, {
        tangent: [0, 1],
        evidence: 0.175,
        ambiguity: 0,
      }),
    ]
    const belowSamples = exactSamples.map((value) => ({
      ...value,
      point: [...value.point] as [number, number],
      tangent: [...value.tangent] as [number, number],
      evidence: value.evidence - Number.EPSILON,
    }))
    const exactCandidate = candidate(undefined, { samples: exactSamples })
    const belowCandidate = candidate(undefined, { samples: belowSamples })

    expect(exactCandidate.score.total).toBe(1)
    expect(belowCandidate.score.total).toBeLessThan(1)
    expect(select(belowCandidate).result).toEqual({
      kind: 'rejected',
      reason: 'below-minimum-score',
    })
    expect(select(exactCandidate).result.kind).toBe('accepted')
  })

  it('gates on canonical unsupported penalty after a tolerance-only comparison', () => {
    const samples = [sample(0), sample(5), sample(10)]
    const spans = [support(samples, 'bounded-gap', 0, 2)]
    const source = candidate(undefined, { samples, support: spans })
    const score = source.score as {
      unsupportedTravelPenalty: number
      representedOverlapPenalty: number
      total: number
    }
    const canonicalTarget = 1 - 5e-13
    const canonicalUnsupported = score.unsupportedTravelPenalty
    const canonicalBeforeOverlap =
      source.score.accumulatedEvidence +
      source.score.usefulLength +
      source.score.directionalCoherence -
      source.score.curvaturePenalty -
      canonicalUnsupported -
      source.score.ambiguityPenalty
    score.representedOverlapPenalty = canonicalBeforeOverlap - canonicalTarget
    score.unsupportedTravelPenalty = canonicalUnsupported - 9e-13
    score.total =
      source.score.accumulatedEvidence +
      source.score.usefulLength +
      source.score.directionalCoherence -
      source.score.curvaturePenalty -
      score.unsupportedTravelPenalty -
      source.score.ambiguityPenalty -
      score.representedOverlapPenalty

    expect(canonicalTarget).toBeLessThan(1)
    expect(score.total).toBeGreaterThan(1)
    expect(select(source).result).toEqual({
      kind: 'rejected',
      reason: 'below-minimum-score',
    })
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

  it('derives unsupported aggregates only from canonical gap geometry', () => {
    const samples = [
      sample(0),
      sample(1),
      sample(3),
      sample(7),
      sample(9),
      sample(10),
    ]
    const spans = [
      support(samples, 'bounded-gap', 0, 2),
      support(samples, 'direct-evidence', 2, 3),
      support(samples, 'bounded-gap', 3, 5),
    ]
    const { result, accounting } = select(
      candidate(undefined, {
        samples,
        support: spans,
        start: 'ambiguity',
        end: 'alpha-boundary',
      }),
    )

    expect(result.kind).toBe('accepted')
    if (result.kind !== 'accepted') return
    expect(result.trajectory.maximumUnsupportedSpanLength).toBe(3)
    expect(result.trajectory.totalUnsupportedSpanLength).toBe(6)
    expect(result.trajectory.startEndpointReason).toBe('ambiguity')
    expect(result.trajectory.endEndpointReason).toBe('alpha-boundary')
    expect(accounting.acceptedMaximumUnsupportedSpanLength).toBe(3)
    expect(accounting.acceptedTotalUnsupportedSpanLength).toBe(6)
    expect(accounting.endpointReasonCounts.ambiguity).toBe(1)
    expect(accounting.endpointReasonCounts['alpha-boundary']).toBe(1)
  })

  it.each([
    [
      'forward direction',
      (value: FlowingContoursCandidate) => {
        ;(value.forward as { direction: string }).direction = 'backward'
      },
    ],
    [
      'shared anchor',
      (value: FlowingContoursCandidate) => {
        ;(value.forward.samples[0]!.point as number[])[0] = 1
      },
    ],
    [
      'canonical assembly',
      (value: FlowingContoursCandidate) => {
        ;(value.samples as CorrectedFlowingRidgeSample[]).reverse()
      },
    ],
    [
      'sample point',
      (value: FlowingContoursCandidate) => {
        ;(value.samples[1]!.point as number[])[0] = Number.NaN
      },
    ],
    [
      'score total',
      (value: FlowingContoursCandidate) => {
        ;(value.score as { total: number }).total = Number.POSITIVE_INFINITY
      },
    ],
    [
      'forged reward',
      (value: FlowingContoursCandidate) => {
        ;(value.score as { accumulatedEvidence: number }).accumulatedEvidence =
          4
        ;(value.score as { total: number }).total += 0.8
      },
    ],
    [
      'forged directional coherence',
      (value: FlowingContoursCandidate) => {
        ;(
          value.score as {
            directionalCoherence: number
            total: number
          }
        ).directionalCoherence -= 0.25
        ;(value.score as { total: number }).total -= 0.25
      },
    ],
    [
      'length aggregate',
      (value: FlowingContoursCandidate) => {
        ;(value as { length: number }).length = 10 + Number.EPSILON * 10
      },
    ],
    [
      'span aggregate',
      (value: FlowingContoursCandidate) => {
        ;(value.spanSupport[0] as { length: number }).length = Number.NaN
      },
    ],
  ])(
    'fails malformed %s closed without accounting mutation',
    (_name, corrupt) => {
      const source = candidate()
      corrupt(source)
      const accounting = createFlowingContoursAccounting()
      const before = snapshotFlowingContoursDiagnostics(accounting)
      const { result } = select(source, {}, accounting)

      expect(result).toEqual({
        kind: 'rejected',
        reason: 'invalid-input',
      })
      expect(snapshotFlowingContoursDiagnostics(accounting)).toEqual(before)
    },
  )

  it.each([
    [
      'missing',
      (source: FlowingContoursCandidate) => replaceSupport(source, []),
    ],
    [
      'overlapping',
      (source: FlowingContoursCandidate) => {
        const samples = source.samples
        replaceSupport(source, [
          support(samples, 'direct-evidence', 0, 2),
          support(samples, 'direct-evidence', 1, 2),
        ])
      },
    ],
    [
      'out-of-order',
      (source: FlowingContoursCandidate) => {
        const samples = source.samples
        replaceSupport(source, [
          support(samples, 'direct-evidence', 1, 2),
          support(samples, 'direct-evidence', 0, 1),
        ])
      },
    ],
    [
      'wrong-length',
      (source: FlowingContoursCandidate) => {
        const span = {
          ...source.spanSupport[0]!,
          length: source.spanSupport[0]!.length + 0.25,
        }
        replaceSupport(source, [span])
      },
    ],
    [
      'wrong-boundary',
      (source: FlowingContoursCandidate) => {
        const span = {
          ...source.spanSupport[0]!,
          exitEvidence: 0.2,
        }
        replaceSupport(source, [span])
      },
    ],
    [
      'fabricated-extra',
      (source: FlowingContoursCandidate) => {
        const samples = source.samples
        replaceSupport(source, [
          support(samples, 'direct-evidence', 0, 1),
          support(samples, 'direct-evidence', 1, 2),
        ])
      },
    ],
  ])('rejects %s support provenance', (_name, corrupt) => {
    const source = candidate()
    corrupt(source)
    expect(select(source).result).toEqual({
      kind: 'rejected',
      reason: 'invalid-input',
    })
  })

  it('enforces absolute weak-span distance and step caps', () => {
    const distanceSamples = [sample(0), sample(3), sample(10)]
    const distanceSpan = [support(distanceSamples, 'bounded-gap', 0, 2)]
    const stepSamples = [sample(0), sample(1), sample(2), sample(10)]
    const stepSpan = [support(stepSamples, 'bounded-gap', 0, 3)]

    expect(
      select(
        candidate(undefined, {
          samples: distanceSamples,
          support: distanceSpan,
        }),
        {},
        createFlowingContoursAccounting(),
        limits({ 'weak-span-distance': 9 }),
      ).result,
    ).toEqual({ kind: 'rejected', reason: 'invalid-input' })
    expect(
      select(
        candidate(undefined, {
          samples: stepSamples,
          support: stepSpan,
        }),
        {},
        createFlowingContoursAccounting(),
        limits({ 'weak-span-step-count': 1 }),
      ).result,
    ).toEqual({ kind: 'rejected', reason: 'invalid-input' })
  })

  it('enforces the candidate cap before touching candidate properties', () => {
    const accounting = createFlowingContoursAccounting()
    const policy = limits({
      'candidate-count': 1,
      'accepted-curve-count': 1,
      'raw-trajectory-point-count': 8,
    })
    expect(select(candidate(), {}, accounting, policy).result.kind).toBe(
      'accepted',
    )

    let inspected = false
    const hostile = new Proxy(candidate(), {
      getOwnPropertyDescriptor() {
        inspected = true
        throw new Error('candidate must remain untouched')
      },
    })
    const second = select(hostile, {}, accounting, policy)
    expect(second.result).toEqual({
      kind: 'rejected',
      reason: 'candidate-count-limit',
    })
    expect(inspected).toBe(false)
    expect(accounting.candidateCount).toBe(1)
    expect(accounting.termination).toBe('limit-reached')
    expect(accounting.limitedBy).toBe('candidate-count')
  })

  it('rejects accessors and absolute oversize arrays before element reads', () => {
    let getterCalls = 0
    const accessor = candidate()
    Object.defineProperty(accessor, 'samples', {
      get() {
        getterCalls += 1
        return []
      },
    })
    expect(select(accessor).result).toEqual({
      kind: 'rejected',
      reason: 'invalid-input',
    })
    expect(getterCalls).toBe(0)

    const oversized = candidate()
    ;(oversized as { samples: unknown[] }).samples = new Array(
      FLOWING_CONTOURS_LIMITS['raw-trajectory-point-count'] + 1,
    )
    expect(select(oversized).result).toEqual({
      kind: 'rejected',
      reason: 'invalid-input',
    })
  })

  it('rejects the whole candidate at the accepted-curve cap', () => {
    const accounting = createFlowingContoursAccounting()
    seedAccepted(accounting, 2)
    const policy = limits({
      'candidate-count': 3,
      'accepted-curve-count': 1,
      'raw-trajectory-point-count': 8,
    })
    const { result } = select(candidate(), {}, accounting, policy)

    expect(result).toEqual({
      kind: 'rejected',
      reason: 'accepted-curve-count-limit',
    })
    expect(accounting.candidateCount).toBe(2)
    expect(accounting.acceptedCandidateCount).toBe(1)
    expect(accounting.rejectedCandidateCount).toBe(1)
    expect(accounting.rawTrajectoryCount).toBe(1)
    expect(accounting.rawTrajectoryPointCount).toBe(2)
    expect(accounting.limitedBy).toBe('accepted-curve-count')
  })

  it('accepts the raw-point cap exactly and rejects a one-point overrun', () => {
    const exactAccounting = createFlowingContoursAccounting()
    seedAccepted(exactAccounting, 2)
    const overAccounting = createFlowingContoursAccounting()
    seedAccepted(overAccounting, 3)
    const policy = limits({
      'candidate-count': 3,
      'accepted-curve-count': 2,
      'raw-trajectory-point-count': 5,
    })

    expect(select(candidate(), {}, exactAccounting, policy).result.kind).toBe(
      'accepted',
    )
    const over = select(candidate(), {}, overAccounting, policy)
    expect(over.result).toEqual({
      kind: 'rejected',
      reason: 'raw-trajectory-point-count-limit',
    })
    expect(overAccounting.rawTrajectoryPointCount).toBe(3)
    expect(overAccounting.rawTrajectoryCount).toBe(1)
    expect(overAccounting.acceptedCandidateCount).toBe(1)
    expect(overAccounting.limitedBy).toBe('raw-trajectory-point-count')
  })

  it('derives stable IDs from accepted order and rejection consumes no ID', () => {
    const accounting = createFlowingContoursAccounting()
    const rejected = select(candidate([0, 2, 4]), {}, accounting)
    const first = select(candidate(undefined, { anchorId: 12 }), {}, accounting)
    const second = select(candidate(undefined, { anchorId: 3 }), {}, accounting)

    expect(rejected.result.kind).toBe('rejected')
    expect(first.result.kind === 'accepted' && first.result.trajectory.id).toBe(
      0,
    )
    expect(
      second.result.kind === 'accepted' && second.result.trajectory.id,
    ).toBe(1)
    expect(
      first.result.kind === 'accepted' && first.result.trajectory.anchorId,
    ).toBe(12)
    expect(
      second.result.kind === 'accepted' && second.result.trajectory.anchorId,
    ).toBe(3)
  })

  it.each([
    [
      'nonmonotonic stage counts',
      (accounting: FlowingContoursAccounting) => {
        accounting.candidateCount = 1
      },
    ],
    [
      'raw trajectory mismatch',
      (accounting: FlowingContoursAccounting) => {
        accounting.rawTrajectoryCount = 1
        accounting.rawTrajectoryPointCount = 2
      },
    ],
    [
      'inconsistent termination',
      (accounting: FlowingContoursAccounting) => {
        accounting.termination = 'limit-reached'
        accounting.limitedBy = null
      },
    ],
    [
      'unsupported aggregate mismatch',
      (accounting: FlowingContoursAccounting) => {
        seedAccepted(accounting, 2)
        accounting.acceptedTotalUnsupportedSpanLength = 1
        accounting.acceptedMaximumUnsupportedSpanLength = 0
      },
    ],
  ])('fails closed on %s accounting', (_name, corrupt) => {
    const accounting = createFlowingContoursAccounting()
    corrupt(accounting)
    const before = { ...accounting }
    expect(select(candidate(), {}, accounting).result).toEqual({
      kind: 'rejected',
      reason: 'invalid-input',
    })
    expect(accounting).toEqual(before)
  })

  it('rejects proxy and nonwritable accounting without a partial commit', () => {
    const target = createFlowingContoursAccounting()
    let writes = 0
    const proxy = new Proxy(target, {
      defineProperty() {
        writes += 1
        throw new Error('no writes')
      },
      set() {
        writes += 1
        throw new Error('no writes')
      },
    })
    const beforeProxy = snapshotFlowingContoursDiagnostics(target)
    expect(select(candidate(), {}, proxy).result).toEqual({
      kind: 'rejected',
      reason: 'invalid-input',
    })
    expect(writes).toBe(0)
    expect(snapshotFlowingContoursDiagnostics(target)).toEqual(beforeProxy)

    const nonwritable = createFlowingContoursAccounting()
    Object.defineProperty(nonwritable, 'candidateCount', {
      value: 0,
      writable: false,
      enumerable: true,
      configurable: true,
    })
    const beforeNonwritable = snapshotFlowingContoursDiagnostics(nonwritable)
    expect(select(candidate(), {}, nonwritable).result).toEqual({
      kind: 'rejected',
      reason: 'invalid-input',
    })
    expect(snapshotFlowingContoursDiagnostics(nonwritable)).toEqual(
      beforeNonwritable,
    )
  })

  it('returns a deeply frozen snapshot detached from the candidate', () => {
    const source = candidate()
    const { result } = select(source)
    expect(result.kind).toBe('accepted')
    if (result.kind !== 'accepted') return
    const expectedScore = result.trajectory.score.total

    ;(source.samples[0]!.point as number[])[0] = 99
    ;(source.spanSupport[0] as { length: number }).length = 99
    ;(source.score as { total: number }).total = 99

    expect(result.trajectory.samples[0]!.point[0]).toBe(0)
    expect(result.trajectory.spanSupport[0]!.length).toBe(10)
    expect(result.trajectory.score.total).toBe(expectedScore)
    expect(Object.isFrozen(result)).toBe(true)
    expect(Object.isFrozen(result.trajectory)).toBe(true)
    expect(Object.isFrozen(result.trajectory.samples)).toBe(true)
    expect(Object.isFrozen(result.trajectory.samples[0])).toBe(true)
    expect(Object.isFrozen(result.trajectory.samples[0]!.point)).toBe(true)
    expect(Object.isFrozen(result.trajectory.spanSupport[0])).toBe(true)
    expect(Object.isFrozen(result.trajectory.score)).toBe(true)
  })

  it('distinguishes evidence completion from conservative safety truncation', () => {
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
    ) {
      return
    }
    expect(evidence.result.safetyTruncated).toBe(false)
    expect(safety.result.safetyTruncated).toBe(true)
    expect(safety.result.trajectory.startEndpointReason).toBe('safety-limit')
    expect(safety.result.trajectory.endEndpointReason).toBe(
      'evidence-exhausted',
    )
    expect(safety.accounting.endpointReasonCounts['safety-limit']).toBe(1)
    expect(safety.accounting.endpointReasonCounts['evidence-exhausted']).toBe(1)
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
