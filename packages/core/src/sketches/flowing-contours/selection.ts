/**
 * Atomic whole-candidate acceptance for Flowing Contours.
 *
 * Selection is deliberately trajectory-sized: it either snapshots the entire
 * FC10 candidate into one accepted trajectory or emits no geometry. Nearby
 * evidence and represented-curve occupancy are owned by FC12 and are never
 * touched here.
 *
 * Safety-truncated candidates are conservative but not automatically useless.
 * They may be accepted only when the complete geometry still passes the same
 * score and composition-relative length gates as an evidence-complete
 * candidate. A prospective cap overrun always rejects the whole candidate.
 */

import type { Point } from '../../types'
import type { FlowingContoursAccounting } from './accounting'
import {
  canConsumeFlowingContoursLimit,
  FLOWING_CONTOURS_LIMITS,
  isWithinFlowingContoursLimit,
  type FlowingContoursLimits,
} from './limits'
import {
  FLOWING_CONTOURS_ENDPOINT_REASONS,
  type AcceptedFlowingTrajectory,
  type CorrectedFlowingRidgeSample,
  type FlowingContoursCandidate,
  type FlowingContoursCandidateScore,
  type FlowingContoursEndpointReason,
  type FlowingContoursSpanSupportProvenance,
} from './types'

const SCORE_EPSILON = 1e-12

/**
 * Provisional internal whole-objective floor.
 *
 * FC08 totals can range from strongly negative to nine positive reward
 * points. Requiring one net point rejects candidates whose penalties erase
 * essentially all evidence, length, and coherence reward while leaving room
 * for later reference-image calibration.
 */
const MINIMUM_WHOLE_CANDIDATE_SCORE = 1

const ENDPOINT_REASON_SET: ReadonlySet<string> = new Set(
  FLOWING_CONTOURS_ENDPOINT_REASONS,
)

export interface FlowingContoursSelectionOptions {
  /** Bounded analysis/fitted-image dimensions, before Composition Frame map. */
  readonly analysisWidth: number
  readonly analysisHeight: number
  /** Authored fraction of the analysis diagonal. */
  readonly minimumStrokeLength: number
  /** Stable ID reserved for this candidate if and only if it is accepted. */
  readonly nextAcceptedId: number
}

export type FlowingContoursSelectionRejectionReason =
  | 'invalid-input'
  | 'candidate-count-limit'
  | 'below-minimum-length'
  | 'below-minimum-score'
  | 'accepted-curve-count-limit'
  | 'raw-trajectory-point-count-limit'

export type FlowingContoursSelectionResult =
  | Readonly<{
      readonly kind: 'accepted'
      readonly trajectory: Readonly<AcceptedFlowingTrajectory>
      /**
       * True when either directional search ended at a safety boundary.
       *
       * The exact one-or-two endpoint inventory remains on `trajectory`.
       */
      readonly safetyTruncated: boolean
    }>
  | Readonly<{
      readonly kind: 'rejected'
      readonly reason: FlowingContoursSelectionRejectionReason
    }>

function frozenPoint(source: Readonly<Point>): Readonly<Point> | null {
  try {
    const x = source[0]
    const y = source[1]
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null
    return Object.freeze([x, y] as Point)
  } catch {
    return null
  }
}

function unitInterval(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= 1
  )
}

function snapshotSample(
  source: Readonly<CorrectedFlowingRidgeSample>,
): Readonly<CorrectedFlowingRidgeSample> | null {
  try {
    const point = frozenPoint(source.point)
    const tangent = frozenPoint(source.tangent)
    const tangentLength =
      tangent === null ? Number.NaN : Math.hypot(tangent[0], tangent[1])
    if (
      point === null ||
      tangent === null ||
      !Number.isFinite(tangentLength) ||
      Math.abs(tangentLength - 1) > 1e-8 ||
      !unitInterval(source.evidence) ||
      !unitInterval(source.coherence) ||
      !unitInterval(source.ambiguity) ||
      typeof source.scale !== 'number' ||
      !Number.isFinite(source.scale) ||
      source.scale <= 0 ||
      !unitInterval(source.alpha) ||
      source.alpha <= 0
    ) {
      return null
    }
    return Object.freeze({
      point,
      tangent,
      evidence: source.evidence,
      coherence: source.coherence,
      ambiguity: source.ambiguity,
      scale: source.scale,
      alpha: source.alpha,
    })
  } catch {
    return null
  }
}

function snapshotSamples(
  source: readonly Readonly<CorrectedFlowingRidgeSample>[],
): readonly Readonly<CorrectedFlowingRidgeSample>[] | null {
  try {
    if (!Array.isArray(source) || source.length < 2) return null
    const result: Readonly<CorrectedFlowingRidgeSample>[] = []
    for (const sample of source) {
      const snapshot = snapshotSample(sample)
      if (snapshot === null) return null
      result.push(snapshot)
    }
    return Object.freeze(result)
  } catch {
    return null
  }
}

function snapshotSpanSupport(
  source: readonly Readonly<FlowingContoursSpanSupportProvenance>[],
  sampleCount: number,
): readonly Readonly<FlowingContoursSpanSupportProvenance>[] | null {
  try {
    if (!Array.isArray(source)) return null
    const result: Readonly<FlowingContoursSpanSupportProvenance>[] = []
    for (const span of source) {
      if (
        (span.kind !== 'direct-evidence' &&
          span.kind !== 'bounded-gap') ||
        !Number.isSafeInteger(span.startSampleIndex) ||
        !Number.isSafeInteger(span.endSampleIndex) ||
        span.startSampleIndex < 0 ||
        span.endSampleIndex <= span.startSampleIndex ||
        span.endSampleIndex >= sampleCount ||
        !Number.isFinite(span.length) ||
        span.length < 0 ||
        !unitInterval(span.entryEvidence) ||
        !unitInterval(span.exitEvidence) ||
        !Number.isFinite(span.directionalAlignment) ||
        span.directionalAlignment < -1 ||
        span.directionalAlignment > 1
      ) {
        return null
      }
      result.push(
        Object.freeze({
          kind: span.kind,
          startSampleIndex: span.startSampleIndex,
          endSampleIndex: span.endSampleIndex,
          length: span.length,
          entryEvidence: span.entryEvidence,
          exitEvidence: span.exitEvidence,
          directionalAlignment: span.directionalAlignment,
        }),
      )
    }
    return Object.freeze(result)
  } catch {
    return null
  }
}

function snapshotScore(
  source: Readonly<FlowingContoursCandidateScore>,
): Readonly<FlowingContoursCandidateScore> | null {
  try {
    const values = [
      source.accumulatedEvidence,
      source.usefulLength,
      source.directionalCoherence,
      source.curvaturePenalty,
      source.unsupportedTravelPenalty,
      source.ambiguityPenalty,
      source.representedOverlapPenalty,
      source.total,
    ]
    if (
      values.some((value) => !Number.isFinite(value)) ||
      values.slice(0, 7).some((value) => value < 0)
    ) {
      return null
    }
    const expectedTotal =
      source.accumulatedEvidence +
      source.usefulLength +
      source.directionalCoherence -
      source.curvaturePenalty -
      source.unsupportedTravelPenalty -
      source.ambiguityPenalty -
      source.representedOverlapPenalty
    if (
      !Number.isFinite(expectedTotal) ||
      Math.abs(expectedTotal - source.total) >
        SCORE_EPSILON * Math.max(1, Math.abs(expectedTotal))
    ) {
      return null
    }
    return Object.freeze({
      accumulatedEvidence: source.accumulatedEvidence,
      usefulLength: source.usefulLength,
      directionalCoherence: source.directionalCoherence,
      curvaturePenalty: source.curvaturePenalty,
      unsupportedTravelPenalty: source.unsupportedTravelPenalty,
      ambiguityPenalty: source.ambiguityPenalty,
      representedOverlapPenalty: source.representedOverlapPenalty,
      total: source.total,
    })
  } catch {
    return null
  }
}

function endpointReason(
  value: unknown,
): FlowingContoursEndpointReason | null {
  return typeof value === 'string' && ENDPOINT_REASON_SET.has(value)
    ? (value as FlowingContoursEndpointReason)
    : null
}

function polylineLength(
  samples: readonly Readonly<CorrectedFlowingRidgeSample>[],
): number | null {
  let total = 0
  for (let index = 1; index < samples.length; index += 1) {
    const first = samples[index - 1]!.point
    const second = samples[index]!.point
    const segment = Math.hypot(second[0] - first[0], second[1] - first[1])
    if (!Number.isFinite(segment) || segment <= 0) return null
    total += segment
  }
  return Number.isFinite(total) ? total : null
}

interface CandidateSnapshot {
  readonly anchorId: number
  readonly samples: readonly Readonly<CorrectedFlowingRidgeSample>[]
  readonly spanSupport: readonly Readonly<FlowingContoursSpanSupportProvenance>[]
  readonly startEndpointReason: FlowingContoursEndpointReason
  readonly endEndpointReason: FlowingContoursEndpointReason
  readonly length: number
  readonly maximumUnsupportedSpanLength: number
  readonly totalUnsupportedSpanLength: number
  readonly score: Readonly<FlowingContoursCandidateScore>
}

function snapshotCandidate(
  source: Readonly<FlowingContoursCandidate>,
): Readonly<CandidateSnapshot> | null {
  try {
    const samples = snapshotSamples(source.samples)
    if (samples === null) return null
    const spanSupport = snapshotSpanSupport(
      source.spanSupport,
      samples.length,
    )
    const score = snapshotScore(source.score)
    const startReason = endpointReason(source.backward.endpointReason)
    const endReason = endpointReason(source.forward.endpointReason)
    const measuredLength = polylineLength(samples)
    if (
      spanSupport === null ||
      score === null ||
      startReason === null ||
      endReason === null ||
      measuredLength === null ||
      !Number.isSafeInteger(source.anchor.id) ||
      source.anchor.id < 0 ||
      !Number.isFinite(source.length) ||
      source.length < 0 ||
      Math.abs(source.length - measuredLength) >
        SCORE_EPSILON * Math.max(1, measuredLength)
    ) {
      return null
    }

    let maximumUnsupportedSpanLength = 0
    let totalUnsupportedSpanLength = 0
    for (const span of spanSupport) {
      if (span.kind !== 'bounded-gap') continue
      maximumUnsupportedSpanLength = Math.max(
        maximumUnsupportedSpanLength,
        span.length,
      )
      totalUnsupportedSpanLength += span.length
    }
    if (!Number.isFinite(totalUnsupportedSpanLength)) return null

    return Object.freeze({
      anchorId: source.anchor.id,
      samples,
      spanSupport,
      startEndpointReason: startReason,
      endEndpointReason: endReason,
      length: source.length,
      maximumUnsupportedSpanLength,
      totalUnsupportedSpanLength,
      score,
    })
  } catch {
    return null
  }
}

function snapshotLimits(
  source: Readonly<FlowingContoursLimits>,
): Readonly<FlowingContoursLimits> | null {
  try {
    const result = {} as Record<keyof FlowingContoursLimits, number>
    for (const name of Object.keys(FLOWING_CONTOURS_LIMITS) as Array<
      keyof FlowingContoursLimits
    >) {
      const descriptor = Object.getOwnPropertyDescriptor(source, name)
      if (
        descriptor === undefined ||
        !('value' in descriptor) ||
        !isWithinFlowingContoursLimit(name, descriptor.value, source)
      ) {
        return null
      }
      result[name] = descriptor.value
    }
    return Object.freeze(result)
  } catch {
    return null
  }
}

function validCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0
}

function hasValidAccounting(
  accounting: Readonly<FlowingContoursAccounting>,
  limits: Readonly<FlowingContoursLimits>,
): boolean {
  try {
    if (
      !validCount(accounting.candidateCount) ||
      !validCount(accounting.acceptedCandidateCount) ||
      !validCount(accounting.rejectedCandidateCount) ||
      !validCount(accounting.rawTrajectoryCount) ||
      !validCount(accounting.rawTrajectoryPointCount) ||
      !isWithinFlowingContoursLimit(
        'candidate-count',
        accounting.candidateCount,
        limits,
      ) ||
      !isWithinFlowingContoursLimit(
        'accepted-curve-count',
        accounting.acceptedCandidateCount,
        limits,
      ) ||
      !isWithinFlowingContoursLimit(
        'accepted-curve-count',
        accounting.rawTrajectoryCount,
        limits,
      ) ||
      !isWithinFlowingContoursLimit(
        'raw-trajectory-point-count',
        accounting.rawTrajectoryPointCount,
        limits,
      ) ||
      !Number.isFinite(accounting.acceptedMaximumUnsupportedSpanLength) ||
      accounting.acceptedMaximumUnsupportedSpanLength < 0 ||
      !Number.isFinite(accounting.acceptedTotalUnsupportedSpanLength) ||
      accounting.acceptedTotalUnsupportedSpanLength < 0
    ) {
      return false
    }
    return FLOWING_CONTOURS_ENDPOINT_REASONS.every((reason) =>
      validCount(accounting.endpointReasonCounts[reason]),
    )
  } catch {
    return false
  }
}

function rejected(
  reason: FlowingContoursSelectionRejectionReason,
): FlowingContoursSelectionResult {
  return Object.freeze({ kind: 'rejected', reason })
}

interface AccountingOutcome {
  readonly accepted: boolean
  readonly limitedBy:
    | 'accepted-curve-count'
    | 'raw-trajectory-point-count'
    | null
}

/**
 * Commit the diagnostics for one fully decided, valid candidate.
 *
 * All prospective values are checked before the first write. This is the only
 * mutation point in selection.
 */
function commitCandidateAccounting(
  accounting: FlowingContoursAccounting,
  candidate: Readonly<CandidateSnapshot>,
  outcome: Readonly<AccountingOutcome>,
): boolean {
  try {
    const candidateCount = accounting.candidateCount + 1
    const acceptedCandidateCount =
      accounting.acceptedCandidateCount + (outcome.accepted ? 1 : 0)
    const rejectedCandidateCount =
      accounting.rejectedCandidateCount + (outcome.accepted ? 0 : 1)
    const rawTrajectoryCount =
      accounting.rawTrajectoryCount + (outcome.accepted ? 1 : 0)
    const rawTrajectoryPointCount =
      accounting.rawTrajectoryPointCount +
      (outcome.accepted ? candidate.samples.length : 0)
    const endpointReasonCounts = {
      ...accounting.endpointReasonCounts,
    }
    endpointReasonCounts[candidate.startEndpointReason] += 1
    endpointReasonCounts[candidate.endEndpointReason] += 1
    const acceptedMaximumUnsupportedSpanLength = outcome.accepted
      ? Math.max(
          accounting.acceptedMaximumUnsupportedSpanLength,
          candidate.maximumUnsupportedSpanLength,
        )
      : accounting.acceptedMaximumUnsupportedSpanLength
    const acceptedTotalUnsupportedSpanLength = outcome.accepted
      ? accounting.acceptedTotalUnsupportedSpanLength +
        candidate.totalUnsupportedSpanLength
      : accounting.acceptedTotalUnsupportedSpanLength
    if (
      !validCount(candidateCount) ||
      !validCount(acceptedCandidateCount) ||
      !validCount(rejectedCandidateCount) ||
      !validCount(rawTrajectoryCount) ||
      !validCount(rawTrajectoryPointCount) ||
      !FLOWING_CONTOURS_ENDPOINT_REASONS.every((reason) =>
        validCount(endpointReasonCounts[reason]),
      ) ||
      !Number.isFinite(acceptedMaximumUnsupportedSpanLength) ||
      !Number.isFinite(acceptedTotalUnsupportedSpanLength)
    ) {
      return false
    }

    accounting.candidateCount = candidateCount
    accounting.acceptedCandidateCount = acceptedCandidateCount
    accounting.rejectedCandidateCount = rejectedCandidateCount
    accounting.rawTrajectoryCount = rawTrajectoryCount
    accounting.rawTrajectoryPointCount = rawTrajectoryPointCount
    accounting.endpointReasonCounts = endpointReasonCounts
    accounting.acceptedMaximumUnsupportedSpanLength =
      acceptedMaximumUnsupportedSpanLength
    accounting.acceptedTotalUnsupportedSpanLength =
      acceptedTotalUnsupportedSpanLength
    if (outcome.limitedBy !== null) {
      accounting.termination = 'limit-reached'
      accounting.limitedBy = outcome.limitedBy
    }
    return true
  } catch {
    return false
  }
}

function terminateAtCandidateLimit(
  accounting: FlowingContoursAccounting,
): boolean {
  try {
    if (
      accounting.termination === 'invalid-input' ||
      (accounting.termination === 'limit-reached' &&
        accounting.limitedBy !== 'candidate-count')
    ) {
      return false
    }
    accounting.termination = 'limit-reached'
    accounting.limitedBy = 'candidate-count'
    return true
  } catch {
    return false
  }
}

/**
 * Accept or reject one complete FC10 candidate.
 *
 * Minimum stroke length is evaluated against the analysis/fitted-image
 * diagonal. It is therefore independent of page, tool, and output-profile
 * dimensions. Equality at both the length and whole-score gates is accepted.
 */
export function selectFlowingContoursCandidate(
  candidateSource: Readonly<FlowingContoursCandidate>,
  options: Readonly<FlowingContoursSelectionOptions>,
  accounting: FlowingContoursAccounting,
  limitsSource: Readonly<FlowingContoursLimits> = FLOWING_CONTOURS_LIMITS,
): FlowingContoursSelectionResult {
  try {
    const limits = snapshotLimits(limitsSource)
    const candidate = snapshotCandidate(candidateSource)
    if (
      limits === null ||
      candidate === null ||
      !Number.isSafeInteger(options.analysisWidth) ||
      options.analysisWidth <= 0 ||
      !Number.isSafeInteger(options.analysisHeight) ||
      options.analysisHeight <= 0 ||
      !isWithinFlowingContoursLimit(
        'analysis-dimension',
        options.analysisWidth,
        limits,
      ) ||
      !isWithinFlowingContoursLimit(
        'analysis-dimension',
        options.analysisHeight,
        limits,
      ) ||
      !isWithinFlowingContoursLimit(
        'analysis-sample-count',
        options.analysisWidth * options.analysisHeight,
        limits,
      ) ||
      !Number.isFinite(options.minimumStrokeLength) ||
      options.minimumStrokeLength < 0 ||
      options.minimumStrokeLength > 1 ||
      !Number.isSafeInteger(options.nextAcceptedId) ||
      options.nextAcceptedId < 0 ||
      !hasValidAccounting(accounting, limits)
    ) {
      return rejected('invalid-input')
    }

    if (
      candidate.samples.some(
        (sample) =>
          sample.point[0] < 0 ||
          sample.point[1] < 0 ||
          sample.point[0] > options.analysisWidth - 1 ||
          sample.point[1] > options.analysisHeight - 1,
      )
    ) {
      return rejected('invalid-input')
    }

    if (
      !canConsumeFlowingContoursLimit(
        'candidate-count',
        accounting.candidateCount,
        1,
        limits,
      )
    ) {
      terminateAtCandidateLimit(accounting)
      return rejected('candidate-count-limit')
    }

    const diagonal = Math.hypot(
      options.analysisWidth,
      options.analysisHeight,
    )
    const minimumLength = options.minimumStrokeLength * diagonal
    if (
      !Number.isFinite(diagonal) ||
      !Number.isFinite(minimumLength) ||
      candidate.length < minimumLength
    ) {
      if (
        !commitCandidateAccounting(accounting, candidate, {
          accepted: false,
          limitedBy: null,
        })
      ) {
        return rejected('invalid-input')
      }
      return rejected('below-minimum-length')
    }

    if (candidate.score.total < MINIMUM_WHOLE_CANDIDATE_SCORE) {
      if (
        !commitCandidateAccounting(accounting, candidate, {
          accepted: false,
          limitedBy: null,
        })
      ) {
        return rejected('invalid-input')
      }
      return rejected('below-minimum-score')
    }

    if (
      !canConsumeFlowingContoursLimit(
        'accepted-curve-count',
        accounting.acceptedCandidateCount,
        1,
        limits,
      )
    ) {
      if (
        !commitCandidateAccounting(accounting, candidate, {
          accepted: false,
          limitedBy: 'accepted-curve-count',
        })
      ) {
        return rejected('invalid-input')
      }
      return rejected('accepted-curve-count-limit')
    }

    if (
      !canConsumeFlowingContoursLimit(
        'raw-trajectory-point-count',
        accounting.rawTrajectoryPointCount,
        candidate.samples.length,
        limits,
      )
    ) {
      if (
        !commitCandidateAccounting(accounting, candidate, {
          accepted: false,
          limitedBy: 'raw-trajectory-point-count',
        })
      ) {
        return rejected('invalid-input')
      }
      return rejected('raw-trajectory-point-count-limit')
    }

    const trajectory: Readonly<AcceptedFlowingTrajectory> = Object.freeze({
      id: options.nextAcceptedId,
      anchorId: candidate.anchorId,
      samples: candidate.samples,
      spanSupport: candidate.spanSupport,
      startEndpointReason: candidate.startEndpointReason,
      endEndpointReason: candidate.endEndpointReason,
      length: candidate.length,
      maximumUnsupportedSpanLength:
        candidate.maximumUnsupportedSpanLength,
      totalUnsupportedSpanLength: candidate.totalUnsupportedSpanLength,
      score: candidate.score,
    })
    if (
      !commitCandidateAccounting(accounting, candidate, {
        accepted: true,
        limitedBy: null,
      })
    ) {
      return rejected('invalid-input')
    }
    return Object.freeze({
      kind: 'accepted',
      trajectory,
      safetyTruncated:
        candidate.startEndpointReason === 'safety-limit' ||
        candidate.endEndpointReason === 'safety-limit',
    })
  } catch {
    return rejected('invalid-input')
  }
}
