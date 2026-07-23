/**
 * Atomic whole-candidate acceptance for Flowing Contours.
 *
 * FC10's complete bidirectional candidate is the sole unit of trust and
 * acceptance. This module validates and snapshots its canonical assembly,
 * recomputes geometry and every derivable objective term, then either commits
 * one complete accepted trajectory or no geometry. FC12 alone owns occupancy
 * and suppression.
 *
 * A safety-truncated candidate may be useful, but receives no quality
 * exemption: both whole-curve gates and every prospective cap must still pass.
 */

import type { Point } from '../../types'
import type { FlowingContoursAccounting } from './accounting'
import { measureFlowingContoursCurvatureChange } from './growth'
import {
  canConsumeFlowingContoursLimit,
  FLOWING_CONTOURS_LIMITS,
  isWithinFlowingContoursLimit,
  type FlowingContoursLimits,
} from './limits'
import { flowingContoursCandidateSourceField } from './search'
import {
  FLOWING_CONTOURS_ENDPOINT_REASONS,
  type AcceptedFlowingTrajectory,
  type CorrectedFlowingRidgeSample,
  type FlowingContoursCandidate,
  type FlowingContoursCandidateScore,
  type FlowingContoursEndpointReason,
  type FlowingContoursField,
  type FlowingContoursLimitName,
  type FlowingContoursSpanSupportProvenance,
} from './types'

const VECTOR_EPSILON = 1e-12
const PROVENANCE_EPSILON = 1e-12
const GAP_ALIGNMENT_FLOOR = 0.75
const LOOP_ALIGNMENT_FLOOR = 0.75

const ACCUMULATED_EVIDENCE_WEIGHT = 4
const USEFUL_LENGTH_WEIGHT = 3
const DIRECTIONAL_COHERENCE_WEIGHT = 2
const MINIMUM_CURVATURE_WEIGHT = 0.5
const MAXIMUM_CURVATURE_WEIGHT = 3
const UNSUPPORTED_TRAVEL_WEIGHT = 4.5
const AMBIGUITY_WEIGHT = 3
const REPRESENTED_OVERLAP_WEIGHT = 5

interface AcceptedSelectionProvenance {
  readonly field: Readonly<FlowingContoursField>
  readonly trajectory: Readonly<AcceptedFlowingTrajectory>
}

const ACCEPTED_SELECTION_PROVENANCE = new WeakMap<
  Readonly<object>,
  Readonly<AcceptedSelectionProvenance>
>()

const ACCEPTED_TRAJECTORY_SOURCE_FIELDS = new WeakMap<
  Readonly<AcceptedFlowingTrajectory>,
  Readonly<FlowingContoursField>
>()

/**
 * Provisional internal whole-objective floor.
 *
 * FC08 has nine positive reward points. One net point rejects candidates whose
 * penalties erase essentially all evidence, length, and coherence reward,
 * while leaving an explicit calibration seam for FC25.
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
      /** True when either exact endpoint reason is `safety-limit`. */
      readonly safetyTruncated: boolean
    }>
  | Readonly<{
      readonly kind: 'rejected'
      readonly reason: FlowingContoursSelectionRejectionReason
    }>

/**
 * Verify the exact FC11 result and trajectory inherited FC10's field brand.
 *
 * No public mint or rebinding seam exists. Structural accepted results and
 * authentic results from an equivalent but distinct field both fail.
 */
export function isFlowingContoursAcceptedSelectionFromField(
  selection: Readonly<FlowingContoursSelectionResult>,
  field: Readonly<FlowingContoursField>,
): boolean {
  try {
    const provenance = ACCEPTED_SELECTION_PROVENANCE.get(selection)
    return (
      provenance !== undefined &&
      provenance.field === field &&
      ACCEPTED_TRAJECTORY_SOURCE_FIELDS.get(provenance.trajectory) === field
    )
  } catch {
    return false
  }
}

type UnknownRecord = Readonly<Record<PropertyKey, unknown>>

function ownDataValue(source: unknown, key: PropertyKey): unknown | null {
  if (source === null || typeof source !== 'object') return null
  try {
    const descriptor = Object.getOwnPropertyDescriptor(source, key)
    return descriptor !== undefined && 'value' in descriptor
      ? descriptor.value
      : null
  } catch {
    return null
  }
}

function hasOwnDataProperty(source: unknown, key: PropertyKey): boolean {
  if (source === null || typeof source !== 'object') return false
  try {
    const descriptor = Object.getOwnPropertyDescriptor(source, key)
    return descriptor !== undefined && 'value' in descriptor
  } catch {
    return false
  }
}

function boundedOwnArray(
  source: unknown,
  minimumLength: number,
  maximumLength: number,
): readonly unknown[] | null {
  try {
    if (!Array.isArray(source)) return null
    const length = ownDataValue(source, 'length')
    if (
      !Number.isSafeInteger(length) ||
      (length as number) < minimumLength ||
      (length as number) > maximumLength
    ) {
      return null
    }
    const result: unknown[] = []
    for (let index = 0; index < (length as number); index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(source, index)
      if (descriptor === undefined || !('value' in descriptor)) return null
      result.push(descriptor.value)
    }
    return result
  } catch {
    return null
  }
}

function finitePoint(source: unknown): Readonly<Point> | null {
  const coordinates = boundedOwnArray(source, 2, 2)
  if (coordinates === null) return null
  const x = coordinates[0]
  const y = coordinates[1]
  if (
    typeof x !== 'number' ||
    !Number.isFinite(x) ||
    typeof y !== 'number' ||
    !Number.isFinite(y)
  ) {
    return null
  }
  return Object.freeze([x, y] as Point)
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
  source: unknown,
): Readonly<CorrectedFlowingRidgeSample> | null {
  const point = finitePoint(ownDataValue(source, 'point'))
  const tangent = finitePoint(ownDataValue(source, 'tangent'))
  const evidence = ownDataValue(source, 'evidence')
  const coherence = ownDataValue(source, 'coherence')
  const ambiguity = ownDataValue(source, 'ambiguity')
  const scale = ownDataValue(source, 'scale')
  const alpha = ownDataValue(source, 'alpha')
  const tangentLength =
    tangent === null ? Number.NaN : Math.hypot(tangent[0], tangent[1])
  if (
    point === null ||
    tangent === null ||
    !Number.isFinite(tangentLength) ||
    Math.abs(tangentLength - 1) > 1e-8 ||
    !unitInterval(evidence) ||
    !unitInterval(coherence) ||
    !unitInterval(ambiguity) ||
    typeof scale !== 'number' ||
    !Number.isFinite(scale) ||
    scale <= 0 ||
    !unitInterval(alpha) ||
    alpha <= 0
  ) {
    return null
  }
  return Object.freeze({
    point,
    tangent,
    evidence,
    coherence,
    ambiguity,
    scale,
    alpha,
  })
}

function snapshotSamples(
  source: unknown,
  minimumLength: number,
  maximumLength: number,
): readonly Readonly<CorrectedFlowingRidgeSample>[] | null {
  const values = boundedOwnArray(source, minimumLength, maximumLength)
  if (values === null) return null
  const result: Readonly<CorrectedFlowingRidgeSample>[] = []
  for (const value of values) {
    const sample = snapshotSample(value)
    if (sample === null) return null
    result.push(sample)
  }
  return Object.freeze(result)
}

function samePoint(first: Readonly<Point>, second: Readonly<Point>): boolean {
  return Object.is(first[0], second[0]) && Object.is(first[1], second[1])
}

function sameSample(
  first: Readonly<CorrectedFlowingRidgeSample>,
  second: Readonly<CorrectedFlowingRidgeSample>,
  tangentSign = 1,
): boolean {
  return (
    samePoint(first.point, second.point) &&
    Object.is(first.tangent[0], second.tangent[0] * tangentSign) &&
    Object.is(first.tangent[1], second.tangent[1] * tangentSign) &&
    Object.is(first.evidence, second.evidence) &&
    Object.is(first.coherence, second.coherence) &&
    Object.is(first.ambiguity, second.ambiguity) &&
    Object.is(first.scale, second.scale) &&
    Object.is(first.alpha, second.alpha)
  )
}

function segmentLength(
  first: Readonly<CorrectedFlowingRidgeSample>,
  second: Readonly<CorrectedFlowingRidgeSample>,
): number | null {
  const length = Math.hypot(
    second.point[0] - first.point[0],
    second.point[1] - first.point[1],
  )
  return Number.isFinite(length) && length > VECTOR_EPSILON ? length : null
}

function polylineLength(
  samples: readonly Readonly<CorrectedFlowingRidgeSample>[],
  start = 0,
  end = samples.length - 1,
): number | null {
  let total = 0
  for (let index = start + 1; index <= end; index += 1) {
    const length = segmentLength(samples[index - 1]!, samples[index]!)
    if (length === null) return null
    total += length
  }
  return Number.isFinite(total) ? total : null
}

function closeEnough(first: number, second: number): boolean {
  return (
    Number.isFinite(first) &&
    Number.isFinite(second) &&
    Math.abs(first - second) <=
      PROVENANCE_EPSILON * Math.max(1, Math.abs(second))
  )
}

function dot(first: Readonly<Point>, second: Readonly<Point>): number {
  return Math.max(-1, Math.min(1, first[0] * second[0] + first[1] * second[1]))
}

function normalizedAlignment(
  first: Readonly<Point>,
  second: Readonly<Point>,
): number | null {
  const firstLength = Math.hypot(first[0], first[1])
  const secondLength = Math.hypot(second[0], second[1])
  if (
    !Number.isFinite(firstLength) ||
    firstLength <= VECTOR_EPSILON ||
    !Number.isFinite(secondLength) ||
    secondLength <= VECTOR_EPSILON
  ) {
    return null
  }
  return Math.max(
    -1,
    Math.min(
      1,
      (first[0] / firstLength) * (second[0] / secondLength) +
        (first[1] / firstLength) * (second[1] / secondLength),
    ),
  )
}

function displacementUnit(
  first: Readonly<Point>,
  second: Readonly<Point>,
): Readonly<Point> | null {
  const x = second[0] - first[0]
  const y = second[1] - first[1]
  const length = Math.hypot(x, y)
  return Number.isFinite(length) && length > VECTOR_EPSILON
    ? Object.freeze([x / length, y / length] as Point)
    : null
}

function directAlignment(
  samples: readonly Readonly<CorrectedFlowingRidgeSample>[],
  start: number,
  end: number,
): number {
  let minimum = 1
  for (let index = start + 1; index <= end; index += 1) {
    minimum = Math.min(
      minimum,
      dot(samples[index - 1]!.tangent, samples[index]!.tangent),
    )
  }
  return minimum
}

function gapAlignment(
  samples: readonly Readonly<CorrectedFlowingRidgeSample>[],
  start: number,
  end: number,
): number | null {
  const entry = samples[start]!
  let minimum = 1
  for (let index = start + 1; index <= end; index += 1) {
    const previous = samples[index - 1]!
    const sample = samples[index]!
    const displacement = displacementUnit(entry.point, sample.point)
    if (displacement === null) return null
    minimum = Math.min(
      minimum,
      dot(previous.tangent, sample.tangent),
      dot(entry.tangent, sample.tangent),
      dot(entry.tangent, displacement),
      dot(sample.tangent, displacement),
    )
  }
  return minimum
}

interface CanonicalSupport {
  readonly spans: readonly Readonly<FlowingContoursSpanSupportProvenance>[]
  readonly maximumUnsupportedSpanLength: number
  readonly totalUnsupportedSpanLength: number
}

function snapshotSupport(
  source: unknown,
  samples: readonly Readonly<CorrectedFlowingRidgeSample>[],
  limits: Readonly<FlowingContoursLimits>,
  allowClosingSpan: boolean,
  allowedDirectJoinIndices: ReadonlySet<number> = new Set(),
  expectedDirectionalSpans:
    | readonly Readonly<FlowingContoursSpanSupportProvenance>[]
    | null = null,
): Readonly<CanonicalSupport> | null {
  const segmentCount = samples.length - 1
  const values = boundedOwnArray(
    source,
    segmentCount === 0 ? 0 : 1,
    segmentCount,
  )
  if (values === null) return null

  const result: Readonly<FlowingContoursSpanSupportProvenance>[] = []
  let expectedStart = 0
  let maximumUnsupportedSpanLength = 0
  let totalUnsupportedSpanLength = 0
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index]
    const kind = ownDataValue(value, 'kind')
    const startSampleIndex = ownDataValue(value, 'startSampleIndex')
    const endSampleIndex = ownDataValue(value, 'endSampleIndex')
    const suppliedLength = ownDataValue(value, 'length')
    const entryEvidence = ownDataValue(value, 'entryEvidence')
    const exitEvidence = ownDataValue(value, 'exitEvidence')
    const suppliedAlignment = ownDataValue(value, 'directionalAlignment')
    if (
      (kind !== 'direct-evidence' && kind !== 'bounded-gap') ||
      (kind === 'direct-evidence' &&
        result[result.length - 1]?.kind === 'direct-evidence' &&
        !allowedDirectJoinIndices.has(startSampleIndex as number)) ||
      !Number.isSafeInteger(startSampleIndex) ||
      !Number.isSafeInteger(endSampleIndex) ||
      startSampleIndex !== expectedStart ||
      (endSampleIndex as number) <= (startSampleIndex as number) ||
      (endSampleIndex as number) > segmentCount ||
      typeof suppliedLength !== 'number' ||
      !Number.isFinite(suppliedLength) ||
      !unitInterval(entryEvidence) ||
      !unitInterval(exitEvidence) ||
      typeof suppliedAlignment !== 'number' ||
      !Number.isFinite(suppliedAlignment) ||
      suppliedAlignment < -1 ||
      suppliedAlignment > 1
    ) {
      return null
    }

    const start = startSampleIndex as number
    const end = endSampleIndex as number
    const length = polylineLength(samples, start, end)
    const alignment =
      kind === 'bounded-gap'
        ? gapAlignment(samples, start, end)
        : directAlignment(samples, start, end)
    const closingSpan =
      allowClosingSpan &&
      index === values.length - 1 &&
      end === segmentCount &&
      sameSample(samples[end]!, samples[0]!)
    const expectedDirectionalSpan = expectedDirectionalSpans?.[index]
    const matchesDirectionalGapProvenance =
      kind === 'bounded-gap' &&
      expectedDirectionalSpan?.kind === 'bounded-gap' &&
      expectedDirectionalSpan.startSampleIndex === start &&
      expectedDirectionalSpan.endSampleIndex === end &&
      closeEnough(
        suppliedAlignment,
        expectedDirectionalSpan.directionalAlignment,
      )
    if (
      length === null ||
      alignment === null ||
      !closeEnough(suppliedLength, length) ||
      !Object.is(entryEvidence, samples[start]!.evidence) ||
      !Object.is(exitEvidence, samples[end]!.evidence) ||
      (closingSpan
        ? suppliedAlignment > alignment + PROVENANCE_EPSILON ||
          suppliedAlignment < LOOP_ALIGNMENT_FLOOR
        : !closeEnough(suppliedAlignment, alignment) &&
          !matchesDirectionalGapProvenance)
    ) {
      return null
    }
    if (
      kind === 'bounded-gap' &&
      (end - start < 2 ||
        entryEvidence <= 0 ||
        exitEvidence <= 0 ||
        length > limits['weak-span-distance'] ||
        end - start - 1 > limits['weak-span-step-count'] ||
        alignment < GAP_ALIGNMENT_FLOOR)
    ) {
      return null
    }
    if (
      kind === 'direct-evidence' &&
      samples.slice(start, end + 1).some((sample) => sample.evidence <= 0)
    ) {
      return null
    }

    const canonicalAlignment =
      closingSpan || matchesDirectionalGapProvenance
        ? suppliedAlignment
        : alignment
    result.push(
      Object.freeze({
        kind,
        startSampleIndex: start,
        endSampleIndex: end,
        length,
        entryEvidence,
        exitEvidence,
        directionalAlignment: canonicalAlignment,
      }),
    )
    if (kind === 'bounded-gap') {
      maximumUnsupportedSpanLength = Math.max(
        maximumUnsupportedSpanLength,
        length,
      )
      totalUnsupportedSpanLength += length
      if (!Number.isFinite(totalUnsupportedSpanLength)) return null
    }
    expectedStart = end
  }
  if (expectedStart !== segmentCount) return null

  return Object.freeze({
    spans: Object.freeze(result),
    maximumUnsupportedSpanLength,
    totalUnsupportedSpanLength,
  })
}

interface TraceSnapshot {
  readonly direction: 'forward' | 'backward'
  readonly samples: readonly Readonly<CorrectedFlowingRidgeSample>[]
  readonly support: Readonly<CanonicalSupport>
  readonly endpointReason: FlowingContoursEndpointReason
  readonly searchStepCount: number
}

function endpointReason(value: unknown): FlowingContoursEndpointReason | null {
  return typeof value === 'string' && ENDPOINT_REASON_SET.has(value)
    ? (value as FlowingContoursEndpointReason)
    : null
}

function snapshotTrace(
  source: unknown,
  expectedDirection: 'forward' | 'backward',
  limits: Readonly<FlowingContoursLimits>,
): Readonly<TraceSnapshot> | null {
  const direction = ownDataValue(source, 'direction')
  const endpoint = endpointReason(ownDataValue(source, 'endpointReason'))
  const searchStepCount = ownDataValue(source, 'searchStepCount')
  const samples = snapshotSamples(
    ownDataValue(source, 'samples'),
    1,
    limits['raw-trajectory-point-count'],
  )
  if (
    direction !== expectedDirection ||
    endpoint === null ||
    !Number.isSafeInteger(searchStepCount) ||
    (searchStepCount as number) < 0 ||
    (searchStepCount as number) > limits['search-step-count'] ||
    samples === null
  ) {
    return null
  }
  const support = snapshotSupport(
    ownDataValue(source, 'spanSupport'),
    samples,
    limits,
    false,
  )
  if (support === null) return null
  return Object.freeze({
    direction: expectedDirection,
    samples,
    support,
    endpointReason: endpoint,
    searchStepCount: searchStepCount as number,
  })
}

function reverseBackwardSamples(
  samples: readonly Readonly<CorrectedFlowingRidgeSample>[],
): readonly Readonly<CorrectedFlowingRidgeSample>[] {
  return Object.freeze(
    [...samples].reverse().map((sample) =>
      Object.freeze({
        ...sample,
        tangent: Object.freeze([
          -sample.tangent[0],
          -sample.tangent[1],
        ] as Point),
      }),
    ),
  )
}

function reverseBackwardSupport(
  trace: Readonly<TraceSnapshot>,
): readonly Readonly<FlowingContoursSpanSupportProvenance>[] {
  const lastIndex = trace.samples.length - 1
  return Object.freeze(
    [...trace.support.spans].reverse().map((span) =>
      Object.freeze({
        kind: span.kind,
        startSampleIndex: lastIndex - span.endSampleIndex,
        endSampleIndex: lastIndex - span.startSampleIndex,
        length: span.length,
        entryEvidence: span.exitEvidence,
        exitEvidence: span.entryEvidence,
        directionalAlignment: span.directionalAlignment,
      }),
    ),
  )
}

function shiftedForwardSupport(
  trace: Readonly<TraceSnapshot>,
  offset: number,
): readonly Readonly<FlowingContoursSpanSupportProvenance>[] {
  return Object.freeze(
    trace.support.spans.map((span) =>
      Object.freeze({
        ...span,
        startSampleIndex: span.startSampleIndex + offset,
        endSampleIndex: span.endSampleIndex + offset,
      }),
    ),
  )
}

function sameSpan(
  first: Readonly<FlowingContoursSpanSupportProvenance>,
  second: Readonly<FlowingContoursSpanSupportProvenance>,
): boolean {
  return (
    first.kind === second.kind &&
    first.startSampleIndex === second.startSampleIndex &&
    first.endSampleIndex === second.endSampleIndex &&
    closeEnough(first.length, second.length) &&
    Object.is(first.entryEvidence, second.entryEvidence) &&
    Object.is(first.exitEvidence, second.exitEvidence) &&
    closeEnough(first.directionalAlignment, second.directionalAlignment)
  )
}

function clampReward(value: number): number {
  if (value <= 0) return 0
  return value >= 1 ? 1 : value
}

function finiteTotal(value: number): number {
  if (!Number.isFinite(value)) return -Number.MAX_VALUE
  return Object.is(value, -0) ? 0 : value
}

function snapshotAndValidateScore(
  source: unknown,
  samples: readonly Readonly<CorrectedFlowingRidgeSample>[],
  support: Readonly<CanonicalSupport>,
  length: number,
  diagonal: number,
): Readonly<FlowingContoursCandidateScore> | null {
  const accumulatedEvidence = ownDataValue(source, 'accumulatedEvidence')
  const usefulLength = ownDataValue(source, 'usefulLength')
  const directionalCoherence = ownDataValue(source, 'directionalCoherence')
  const curvaturePenalty = ownDataValue(source, 'curvaturePenalty')
  const unsupportedTravelPenalty = ownDataValue(
    source,
    'unsupportedTravelPenalty',
  )
  const ambiguityPenalty = ownDataValue(source, 'ambiguityPenalty')
  const representedOverlapPenalty = ownDataValue(
    source,
    'representedOverlapPenalty',
  )
  const total = ownDataValue(source, 'total')
  const values = [
    accumulatedEvidence,
    usefulLength,
    directionalCoherence,
    curvaturePenalty,
    unsupportedTravelPenalty,
    ambiguityPenalty,
    representedOverlapPenalty,
    total,
  ]
  if (
    values.some((value) => typeof value !== 'number' || !Number.isFinite(value))
  ) {
    return null
  }

  let evidenceSum = 0
  let ambiguitySum = 0
  let coherenceSum = 0
  for (let index = 0; index < samples.length; index += 1) {
    const sample = samples[index]!
    evidenceSum += sample.evidence
    ambiguitySum += sample.ambiguity
    if (index > 0) {
      const alignment = normalizedAlignment(
        samples[index - 1]!.tangent,
        sample.tangent,
      )
      if (alignment === null) return null
      coherenceSum += Math.max(0, alignment)
    }
  }
  const expectedAccumulatedEvidence =
    ACCUMULATED_EVIDENCE_WEIGHT * clampReward(evidenceSum / samples.length)
  const expectedUsefulLength =
    USEFUL_LENGTH_WEIGHT * clampReward(length / diagonal)
  const expectedDirectionalCoherence =
    DIRECTIONAL_COHERENCE_WEIGHT *
    (samples.length < 2 ? 0 : coherenceSum / (samples.length - 1))
  const expectedUnsupportedPenalty =
    UNSUPPORTED_TRAVEL_WEIGHT *
    clampReward(support.totalUnsupportedSpanLength / diagonal)
  const expectedAmbiguityPenalty =
    AMBIGUITY_WEIGHT * clampReward(ambiguitySum / samples.length)
  const segmentCount = Math.max(1, samples.length - 1)
  const curvatureChange =
    measureFlowingContoursCurvatureChange(
      samples.map((sample) => sample.point),
    ) / segmentCount
  const minimumCurvaturePenalty =
    MINIMUM_CURVATURE_WEIGHT * clampReward(curvatureChange)
  const maximumCurvaturePenalty =
    MAXIMUM_CURVATURE_WEIGHT * clampReward(curvatureChange)

  if (
    !Object.is(accumulatedEvidence, expectedAccumulatedEvidence) ||
    !Object.is(usefulLength, expectedUsefulLength) ||
    !Object.is(directionalCoherence, expectedDirectionalCoherence) ||
    !closeEnough(
      unsupportedTravelPenalty as number,
      expectedUnsupportedPenalty,
    ) ||
    !Object.is(ambiguityPenalty, expectedAmbiguityPenalty) ||
    (curvaturePenalty as number) < minimumCurvaturePenalty ||
    (curvaturePenalty as number) > maximumCurvaturePenalty ||
    (representedOverlapPenalty as number) < 0 ||
    (representedOverlapPenalty as number) > REPRESENTED_OVERLAP_WEIGHT
  ) {
    return null
  }
  const suppliedTotal = finiteTotal(
    (accumulatedEvidence as number) +
      (usefulLength as number) +
      (directionalCoherence as number) -
      (curvaturePenalty as number) -
      (unsupportedTravelPenalty as number) -
      (ambiguityPenalty as number) -
      (representedOverlapPenalty as number),
  )
  if (!Object.is(total, suppliedTotal)) return null
  const canonicalTotal = finiteTotal(
    (accumulatedEvidence as number) +
      (usefulLength as number) +
      (directionalCoherence as number) -
      (curvaturePenalty as number) -
      expectedUnsupportedPenalty -
      (ambiguityPenalty as number) -
      (representedOverlapPenalty as number),
  )

  return Object.freeze({
    accumulatedEvidence: accumulatedEvidence as number,
    usefulLength: usefulLength as number,
    directionalCoherence: directionalCoherence as number,
    curvaturePenalty: curvaturePenalty as number,
    unsupportedTravelPenalty: expectedUnsupportedPenalty,
    ambiguityPenalty: ambiguityPenalty as number,
    representedOverlapPenalty: representedOverlapPenalty as number,
    total: canonicalTotal,
  })
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
  analysisWidth: number,
  analysisHeight: number,
  diagonal: number,
  limits: Readonly<FlowingContoursLimits>,
): Readonly<CandidateSnapshot> | null {
  const anchorSource = ownDataValue(source, 'anchor')
  const anchorId = ownDataValue(anchorSource, 'id')
  const fieldSampleIndex = ownDataValue(anchorSource, 'fieldSampleIndex')
  const anchorSample = snapshotSample(ownDataValue(anchorSource, 'sample'))
  const backward = snapshotTrace(
    ownDataValue(source, 'backward'),
    'backward',
    limits,
  )
  const forward = snapshotTrace(
    ownDataValue(source, 'forward'),
    'forward',
    limits,
  )
  const suppliedSamples = snapshotSamples(
    ownDataValue(source, 'samples'),
    2,
    limits['raw-trajectory-point-count'],
  )
  if (
    !Number.isSafeInteger(anchorId) ||
    (anchorId as number) < 0 ||
    !Number.isSafeInteger(fieldSampleIndex) ||
    (fieldSampleIndex as number) < 0 ||
    (fieldSampleIndex as number) >= analysisWidth * analysisHeight ||
    anchorSample === null ||
    backward === null ||
    forward === null ||
    suppliedSamples === null ||
    backward.searchStepCount + forward.searchStepCount >
      limits['search-step-count'] ||
    !sameSample(forward.samples[0]!, anchorSample) ||
    !sameSample(backward.samples[0]!, anchorSample, -1)
  ) {
    return null
  }

  const reversedBackward = reverseBackwardSamples(backward.samples)
  const assembled = [...reversedBackward, ...forward.samples.slice(1)]
  const hasClosure =
    suppliedSamples.length === assembled.length + 1 &&
    sameSample(suppliedSamples[suppliedSamples.length - 1]!, assembled[0]!)
  if (
    (!hasClosure && suppliedSamples.length !== assembled.length) ||
    assembled.some(
      (sample, index) => !sameSample(sample, suppliedSamples[index]!),
    ) ||
    suppliedSamples.some(
      (sample) =>
        sample.point[0] < 0 ||
        sample.point[1] < 0 ||
        sample.point[0] > analysisWidth - 1 ||
        sample.point[1] > analysisHeight - 1,
    )
  ) {
    return null
  }

  const expectedSupport = [
    ...reverseBackwardSupport(backward),
    ...shiftedForwardSupport(forward, backward.samples.length - 1),
  ]
  const support = snapshotSupport(
    ownDataValue(source, 'spanSupport'),
    suppliedSamples,
    limits,
    hasClosure,
    new Set([
      backward.samples.length - 1,
      ...(hasClosure ? [assembled.length - 1] : []),
    ]),
    expectedSupport,
  )
  if (support === null) return null
  const expectedSupportCount = expectedSupport.length + (hasClosure ? 1 : 0)
  if (
    support.spans.length !== expectedSupportCount ||
    expectedSupport.some(
      (span, index) => !sameSpan(span, support.spans[index]!),
    ) ||
    (hasClosure &&
      support.spans[support.spans.length - 1]!.startSampleIndex !==
        assembled.length - 1)
  ) {
    return null
  }

  const length = polylineLength(suppliedSamples)
  const suppliedLength = ownDataValue(source, 'length')
  if (
    length === null ||
    typeof suppliedLength !== 'number' ||
    !Object.is(suppliedLength, length)
  ) {
    return null
  }
  const score = snapshotAndValidateScore(
    ownDataValue(source, 'score'),
    suppliedSamples,
    support,
    length,
    diagonal,
  )
  if (score === null) return null

  return Object.freeze({
    anchorId: anchorId as number,
    samples: suppliedSamples,
    spanSupport: support.spans,
    startEndpointReason: backward.endpointReason,
    endEndpointReason: forward.endpointReason,
    length,
    maximumUnsupportedSpanLength: support.maximumUnsupportedSpanLength,
    totalUnsupportedSpanLength: support.totalUnsupportedSpanLength,
    score,
  })
}

function snapshotLimits(
  source: Readonly<FlowingContoursLimits>,
): Readonly<FlowingContoursLimits> | null {
  try {
    const result = {} as Record<FlowingContoursLimitName, number>
    for (const name of Object.keys(
      FLOWING_CONTOURS_LIMITS,
    ) as FlowingContoursLimitName[]) {
      const value = ownDataValue(source, name)
      if (
        typeof value !== 'number' ||
        !isWithinFlowingContoursLimit(name, value, source)
      ) {
        return null
      }
      result[name] = value
    }
    return Object.freeze(result)
  } catch {
    return null
  }
}

interface SelectionOptionsSnapshot {
  readonly analysisWidth: number
  readonly analysisHeight: number
  readonly analysisSampleCount: number
  readonly diagonal: number
  readonly minimumStrokeLength: number
}

function snapshotOptions(
  source: Readonly<FlowingContoursSelectionOptions>,
  limits: Readonly<FlowingContoursLimits>,
): Readonly<SelectionOptionsSnapshot> | null {
  const analysisWidth = ownDataValue(source, 'analysisWidth')
  const analysisHeight = ownDataValue(source, 'analysisHeight')
  const minimumStrokeLength = ownDataValue(source, 'minimumStrokeLength')
  if (
    !Number.isSafeInteger(analysisWidth) ||
    (analysisWidth as number) <= 0 ||
    !Number.isSafeInteger(analysisHeight) ||
    (analysisHeight as number) <= 0 ||
    !isWithinFlowingContoursLimit(
      'analysis-dimension',
      analysisWidth as number,
      limits,
    ) ||
    !isWithinFlowingContoursLimit(
      'analysis-dimension',
      analysisHeight as number,
      limits,
    ) ||
    typeof minimumStrokeLength !== 'number' ||
    !Number.isFinite(minimumStrokeLength) ||
    minimumStrokeLength < 0 ||
    minimumStrokeLength > 1
  ) {
    return null
  }
  const analysisSampleCount =
    (analysisWidth as number) * (analysisHeight as number)
  const diagonal = Math.hypot(analysisWidth as number, analysisHeight as number)
  if (
    !isWithinFlowingContoursLimit(
      'analysis-sample-count',
      analysisSampleCount,
      limits,
    ) ||
    !Number.isFinite(diagonal)
  ) {
    return null
  }
  return Object.freeze({
    analysisWidth: analysisWidth as number,
    analysisHeight: analysisHeight as number,
    analysisSampleCount,
    diagonal,
    minimumStrokeLength,
  })
}

function validCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0
}

const ACCOUNTING_FIELD_NAMES = Object.freeze([
  'termination',
  'limitedBy',
  'candidateCount',
  'acceptedCandidateCount',
  'rejectedCandidateCount',
  'rawTrajectoryCount',
  'rawTrajectoryPointCount',
  'acceptedMaximumUnsupportedSpanLength',
  'acceptedTotalUnsupportedSpanLength',
] as const)

interface AccountingSnapshot {
  readonly termination: 'complete'
  readonly limitedBy: null
  readonly candidateCount: number
  readonly acceptedCandidateCount: number
  readonly rejectedCandidateCount: number
  readonly rawTrajectoryCount: number
  readonly rawTrajectoryPointCount: number
  readonly acceptedMaximumUnsupportedSpanLength: number
  readonly acceptedTotalUnsupportedSpanLength: number
  readonly endpointReasonCounts: Readonly<
    Record<FlowingContoursEndpointReason, number>
  >
}

function plainWritableDataRecord(
  source: unknown,
  verifyClone = true,
): source is UnknownRecord {
  try {
    if (
      source === null ||
      typeof source !== 'object' ||
      Array.isArray(source) ||
      Object.getPrototypeOf(source) !== Object.prototype
    ) {
      return false
    }
    for (const key of Reflect.ownKeys(source)) {
      const descriptor = Object.getOwnPropertyDescriptor(source, key)
      if (
        descriptor === undefined ||
        !('value' in descriptor) ||
        descriptor.writable !== true
      ) {
        return false
      }
    }
    if (verifyClone) {
      // Native structured cloning rejects Proxy exotics. Rejecting them keeps
      // the later multi-field commit transactional rather than trap-dependent.
      const clone = (
        globalThis as unknown as {
          readonly structuredClone?: (value: unknown) => unknown
        }
      ).structuredClone
      if (typeof clone !== 'function') return false
      clone(source)
    }
    return true
  } catch {
    return false
  }
}

function snapshotAccounting(
  accounting: FlowingContoursAccounting,
  limits: Readonly<FlowingContoursLimits>,
): Readonly<AccountingSnapshot> | null {
  if (!plainWritableDataRecord(accounting, false)) return null
  for (const name of ACCOUNTING_FIELD_NAMES) {
    if (!hasOwnDataProperty(accounting, name)) return null
  }
  if (!hasOwnDataProperty(accounting, 'endpointReasonCounts')) return null
  const endpointSource = ownDataValue(accounting, 'endpointReasonCounts')
  if (
    !plainWritableDataRecord(endpointSource, false) ||
    !plainWritableDataRecord(accounting)
  ) {
    return null
  }
  const termination = ownDataValue(accounting, 'termination')
  const limitedBy = ownDataValue(accounting, 'limitedBy')
  const candidateCount = ownDataValue(accounting, 'candidateCount')
  const acceptedCandidateCount = ownDataValue(
    accounting,
    'acceptedCandidateCount',
  )
  const rejectedCandidateCount = ownDataValue(
    accounting,
    'rejectedCandidateCount',
  )
  const rawTrajectoryCount = ownDataValue(accounting, 'rawTrajectoryCount')
  const rawTrajectoryPointCount = ownDataValue(
    accounting,
    'rawTrajectoryPointCount',
  )
  const acceptedMaximumUnsupportedSpanLength = ownDataValue(
    accounting,
    'acceptedMaximumUnsupportedSpanLength',
  )
  const acceptedTotalUnsupportedSpanLength = ownDataValue(
    accounting,
    'acceptedTotalUnsupportedSpanLength',
  )
  const endpointReasonCounts = {} as Record<
    FlowingContoursEndpointReason,
    number
  >
  let endpointCount = 0
  for (const reason of FLOWING_CONTOURS_ENDPOINT_REASONS) {
    const count = ownDataValue(endpointSource, reason)
    if (!validCount(count)) return null
    endpointReasonCounts[reason] = count
    endpointCount += count
  }
  if (
    termination !== 'complete' ||
    limitedBy !== null ||
    !validCount(candidateCount) ||
    !validCount(acceptedCandidateCount) ||
    !validCount(rejectedCandidateCount) ||
    !validCount(rawTrajectoryCount) ||
    !validCount(rawTrajectoryPointCount) ||
    candidateCount !== acceptedCandidateCount + rejectedCandidateCount ||
    rawTrajectoryCount !== acceptedCandidateCount ||
    endpointCount !== candidateCount * 2 ||
    (rawTrajectoryCount === 0
      ? rawTrajectoryPointCount !== 0
      : rawTrajectoryPointCount < rawTrajectoryCount * 2) ||
    typeof acceptedMaximumUnsupportedSpanLength !== 'number' ||
    !Number.isFinite(acceptedMaximumUnsupportedSpanLength) ||
    acceptedMaximumUnsupportedSpanLength < 0 ||
    typeof acceptedTotalUnsupportedSpanLength !== 'number' ||
    !Number.isFinite(acceptedTotalUnsupportedSpanLength) ||
    acceptedTotalUnsupportedSpanLength < 0 ||
    acceptedMaximumUnsupportedSpanLength > acceptedTotalUnsupportedSpanLength ||
    (acceptedMaximumUnsupportedSpanLength === 0) !==
      (acceptedTotalUnsupportedSpanLength === 0) ||
    (acceptedCandidateCount === 0 &&
      (acceptedMaximumUnsupportedSpanLength !== 0 ||
        acceptedTotalUnsupportedSpanLength !== 0)) ||
    !isWithinFlowingContoursLimit('candidate-count', candidateCount, limits) ||
    !isWithinFlowingContoursLimit(
      'accepted-curve-count',
      acceptedCandidateCount,
      limits,
    ) ||
    !isWithinFlowingContoursLimit(
      'raw-trajectory-point-count',
      rawTrajectoryPointCount,
      limits,
    )
  ) {
    return null
  }

  return Object.freeze({
    termination,
    limitedBy,
    candidateCount,
    acceptedCandidateCount,
    rejectedCandidateCount,
    rawTrajectoryCount,
    rawTrajectoryPointCount,
    acceptedMaximumUnsupportedSpanLength,
    acceptedTotalUnsupportedSpanLength,
    endpointReasonCounts: Object.freeze(endpointReasonCounts),
  })
}

interface AccountingPatch {
  readonly accepted: boolean
  readonly candidate: Readonly<CandidateSnapshot>
  readonly limitedBy:
    | 'accepted-curve-count'
    | 'raw-trajectory-point-count'
    | null
}

function unchangedAccounting(
  accounting: FlowingContoursAccounting,
  snapshot: Readonly<AccountingSnapshot>,
): boolean {
  return (
    ACCOUNTING_FIELD_NAMES.every((name) =>
      Object.is(ownDataValue(accounting, name), snapshot[name]),
    ) &&
    ownDataValue(accounting, 'endpointReasonCounts') !== null &&
    FLOWING_CONTOURS_ENDPOINT_REASONS.every((reason) =>
      Object.is(
        ownDataValue(ownDataValue(accounting, 'endpointReasonCounts'), reason),
        snapshot.endpointReasonCounts[reason],
      ),
    )
  )
}

function commitAccounting(
  accounting: FlowingContoursAccounting,
  snapshot: Readonly<AccountingSnapshot>,
  patch: Readonly<AccountingPatch>,
): boolean {
  if (!unchangedAccounting(accounting, snapshot)) return false
  const candidateCount = snapshot.candidateCount + 1
  const acceptedCandidateCount =
    snapshot.acceptedCandidateCount + (patch.accepted ? 1 : 0)
  const rejectedCandidateCount =
    snapshot.rejectedCandidateCount + (patch.accepted ? 0 : 1)
  const rawTrajectoryCount =
    snapshot.rawTrajectoryCount + (patch.accepted ? 1 : 0)
  const rawTrajectoryPointCount =
    snapshot.rawTrajectoryPointCount +
    (patch.accepted ? patch.candidate.samples.length : 0)
  const endpointReasonCounts = {
    ...snapshot.endpointReasonCounts,
  }
  endpointReasonCounts[patch.candidate.startEndpointReason] += 1
  endpointReasonCounts[patch.candidate.endEndpointReason] += 1
  const maximumUnsupported = patch.accepted
    ? Math.max(
        snapshot.acceptedMaximumUnsupportedSpanLength,
        patch.candidate.maximumUnsupportedSpanLength,
      )
    : snapshot.acceptedMaximumUnsupportedSpanLength
  const totalUnsupported = patch.accepted
    ? snapshot.acceptedTotalUnsupportedSpanLength +
      patch.candidate.totalUnsupportedSpanLength
    : snapshot.acceptedTotalUnsupportedSpanLength
  if (
    !validCount(candidateCount) ||
    !validCount(acceptedCandidateCount) ||
    !validCount(rejectedCandidateCount) ||
    !validCount(rawTrajectoryCount) ||
    !validCount(rawTrajectoryPointCount) ||
    !Number.isFinite(maximumUnsupported) ||
    !Number.isFinite(totalUnsupported)
  ) {
    return false
  }

  try {
    Object.defineProperties(accounting, {
      termination: {
        ...Object.getOwnPropertyDescriptor(accounting, 'termination'),
        value: patch.limitedBy === null ? 'complete' : 'limit-reached',
      },
      limitedBy: {
        ...Object.getOwnPropertyDescriptor(accounting, 'limitedBy'),
        value: patch.limitedBy,
      },
      candidateCount: {
        ...Object.getOwnPropertyDescriptor(accounting, 'candidateCount'),
        value: candidateCount,
      },
      acceptedCandidateCount: {
        ...Object.getOwnPropertyDescriptor(
          accounting,
          'acceptedCandidateCount',
        ),
        value: acceptedCandidateCount,
      },
      rejectedCandidateCount: {
        ...Object.getOwnPropertyDescriptor(
          accounting,
          'rejectedCandidateCount',
        ),
        value: rejectedCandidateCount,
      },
      rawTrajectoryCount: {
        ...Object.getOwnPropertyDescriptor(accounting, 'rawTrajectoryCount'),
        value: rawTrajectoryCount,
      },
      rawTrajectoryPointCount: {
        ...Object.getOwnPropertyDescriptor(
          accounting,
          'rawTrajectoryPointCount',
        ),
        value: rawTrajectoryPointCount,
      },
      endpointReasonCounts: {
        ...Object.getOwnPropertyDescriptor(accounting, 'endpointReasonCounts'),
        value: endpointReasonCounts,
      },
      acceptedMaximumUnsupportedSpanLength: {
        ...Object.getOwnPropertyDescriptor(
          accounting,
          'acceptedMaximumUnsupportedSpanLength',
        ),
        value: maximumUnsupported,
      },
      acceptedTotalUnsupportedSpanLength: {
        ...Object.getOwnPropertyDescriptor(
          accounting,
          'acceptedTotalUnsupportedSpanLength',
        ),
        value: totalUnsupported,
      },
    })
    return true
  } catch {
    return false
  }
}

function commitCandidateLimit(
  accounting: FlowingContoursAccounting,
  snapshot: Readonly<AccountingSnapshot>,
): boolean {
  if (!unchangedAccounting(accounting, snapshot)) return false
  try {
    Object.defineProperties(accounting, {
      termination: {
        ...Object.getOwnPropertyDescriptor(accounting, 'termination'),
        value: 'limit-reached',
      },
      limitedBy: {
        ...Object.getOwnPropertyDescriptor(accounting, 'limitedBy'),
        value: 'candidate-count',
      },
    })
    return true
  } catch {
    return false
  }
}

function rejected(
  reason: FlowingContoursSelectionRejectionReason,
): FlowingContoursSelectionResult {
  return Object.freeze({ kind: 'rejected', reason })
}

/**
 * Accept or reject one canonical FC10 candidate.
 *
 * Minimum stroke length uses the exact recomputed analysis-space length and
 * analysis diagonal. Equality at both quality gates is accepted.
 */
export function selectFlowingContoursCandidate(
  candidateSource: Readonly<FlowingContoursCandidate>,
  optionsSource: Readonly<FlowingContoursSelectionOptions>,
  accounting: FlowingContoursAccounting,
  limitsSource: Readonly<FlowingContoursLimits> = FLOWING_CONTOURS_LIMITS,
): FlowingContoursSelectionResult {
  try {
    const candidateSourceField =
      flowingContoursCandidateSourceField(candidateSource)
    // Candidate inspection intentionally occurs only after policy, state, and
    // the candidate-count budget are known valid.
    const limits = snapshotLimits(limitsSource)
    if (limits === null) return rejected('invalid-input')
    const options = snapshotOptions(optionsSource, limits)
    if (options === null) return rejected('invalid-input')
    const accountingSnapshot = snapshotAccounting(accounting, limits)
    if (accountingSnapshot === null) return rejected('invalid-input')
    if (
      !canConsumeFlowingContoursLimit(
        'candidate-count',
        accountingSnapshot.candidateCount,
        1,
        limits,
      )
    ) {
      if (!commitCandidateLimit(accounting, accountingSnapshot)) {
        return rejected('invalid-input')
      }
      return rejected('candidate-count-limit')
    }

    const candidate = snapshotCandidate(
      candidateSource,
      options.analysisWidth,
      options.analysisHeight,
      options.diagonal,
      limits,
    )
    if (candidate === null) return rejected('invalid-input')

    const minimumLength = options.minimumStrokeLength * options.diagonal
    if (!Number.isFinite(minimumLength) || candidate.length < minimumLength) {
      if (
        !commitAccounting(accounting, accountingSnapshot, {
          accepted: false,
          candidate,
          limitedBy: null,
        })
      ) {
        return rejected('invalid-input')
      }
      return rejected('below-minimum-length')
    }
    if (candidate.score.total < MINIMUM_WHOLE_CANDIDATE_SCORE) {
      if (
        !commitAccounting(accounting, accountingSnapshot, {
          accepted: false,
          candidate,
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
        accountingSnapshot.acceptedCandidateCount,
        1,
        limits,
      )
    ) {
      if (
        !commitAccounting(accounting, accountingSnapshot, {
          accepted: false,
          candidate,
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
        accountingSnapshot.rawTrajectoryPointCount,
        candidate.samples.length,
        limits,
      )
    ) {
      if (
        !commitAccounting(accounting, accountingSnapshot, {
          accepted: false,
          candidate,
          limitedBy: 'raw-trajectory-point-count',
        })
      ) {
        return rejected('invalid-input')
      }
      return rejected('raw-trajectory-point-count-limit')
    }

    const trajectory: Readonly<AcceptedFlowingTrajectory> = Object.freeze({
      id: accountingSnapshot.acceptedCandidateCount,
      anchorId: candidate.anchorId,
      samples: candidate.samples,
      spanSupport: candidate.spanSupport,
      startEndpointReason: candidate.startEndpointReason,
      endEndpointReason: candidate.endEndpointReason,
      length: candidate.length,
      maximumUnsupportedSpanLength: candidate.maximumUnsupportedSpanLength,
      totalUnsupportedSpanLength: candidate.totalUnsupportedSpanLength,
      score: candidate.score,
    })
    if (
      !commitAccounting(accounting, accountingSnapshot, {
        accepted: true,
        candidate,
        limitedBy: null,
      })
    ) {
      return rejected('invalid-input')
    }
    const result: FlowingContoursSelectionResult = Object.freeze({
      kind: 'accepted',
      trajectory,
      safetyTruncated:
        candidate.startEndpointReason === 'safety-limit' ||
        candidate.endEndpointReason === 'safety-limit',
    })
    if (candidateSourceField !== null) {
      ACCEPTED_TRAJECTORY_SOURCE_FIELDS.set(trajectory, candidateSourceField)
      ACCEPTED_SELECTION_PROVENANCE.set(
        result,
        Object.freeze({
          field: candidateSourceField,
          trajectory,
        }),
      )
    }
    return result
  } catch {
    return rejected('invalid-input')
  }
}
