/**
 * Bidirectional whole-candidate search for Flowing Contours.
 *
 * One FC06 anchor produces one atomic endpoint-to-endpoint candidate. FC09
 * remains responsible for each signed half; this layer owns the shared FC03
 * work budget, canonical assembly, supported loop closure, and complete FC08
 * measurement. It never joins endpoints from different candidates.
 */

import type { Point } from '../../types'
import { sampleFlowingContoursField } from './field'
import {
  growFlowingContoursDirection,
  isFlowingContoursSupportedSelfLoopTrace,
  measureFlowingContoursCurvatureChange,
  type FlowingContoursDirectionalGrowthOptions,
  type FlowingContoursRepresentedOverlapSampler,
} from './growth'
import {
  FLOWING_CONTOURS_LIMITS,
  isWithinFlowingContoursLimit,
  type FlowingContoursLimits,
} from './limits'
import { scoreFlowingContoursCandidate } from './objective'
import type {
  CorrectedFlowingRidgeSample,
  FlowingContoursAnchor,
  FlowingContoursCandidate,
  FlowingContoursDirectionalTrace,
  FlowingContoursField,
  FlowingContoursSpanSupportProvenance,
} from './types'

const VECTOR_EPSILON = 1e-12
const LOOP_ENDPOINT_DISTANCE = 3
const LOOP_ALIGNMENT_FLOOR = 0.75
const LOOP_SAMPLE_SPACING = 0.25
const MAXIMUM_LOOP_SAMPLES = 12
const OVERLAP_SAMPLE_SPACING = 0.25
const MAXIMUM_OVERLAP_SAMPLES_PER_SEGMENT = 64
const DEFAULT_REPRESENTED_COLLISION_THRESHOLD = 0.7
const DEFAULT_MINIMUM_EVIDENCE = 0.04
const DEFAULT_MINIMUM_COHERENCE = 0.25
const DEFAULT_MAXIMUM_AMBIGUITY = 0.7
const HARD_RESOLVED_AMBIGUITY_MAXIMUM = 1 - 1e-9
const ANCHOR_EVIDENCE_EPSILON = 1e-12
const ANCHOR_MATCH_TOLERANCE = 1e-10
const ANCHOR_MINIMUM_COHERENCE = 0.2
const ANCHOR_MAXIMUM_AMBIGUITY = 0.82
const ANCHOR_MINIMUM_SELECTION_SCORE = 0.04
const LOCAL_CERTIFICATE_ALIGNMENT_FLOOR = 0.75
const LOCAL_CERTIFICATE_SAMPLE_SPACING = 0.25
const MAXIMUM_LOCAL_CERTIFICATE_SAMPLES_PER_SEGMENT = 64

const CANDIDATE_SOURCE_FIELDS = new WeakMap<
  Readonly<FlowingContoursCandidate>,
  Readonly<FlowingContoursField>
>()
export interface FlowingContoursSearchOptions
  extends FlowingContoursDirectionalGrowthOptions {
  /** Internal high-detail admission floor; ordinary callers retain `0.04`. */
  readonly minimumAnchorSelectionScore?: number
}

interface ResolvedSearchOptions {
  readonly forward: Readonly<FlowingContoursDirectionalGrowthOptions>
  readonly backward: Readonly<FlowingContoursDirectionalGrowthOptions>
  readonly flowSmoothing: number
  readonly representedOverlapSampler: FlowingContoursRepresentedOverlapSampler | null
  readonly overlapSamplerInvalid: () => boolean
  readonly minimumEvidence: number
  readonly minimumCoherence: number
  readonly maximumAmbiguity: number
}

/**
 * Read FC10 provenance without exposing a mint or rebinding seam.
 *
 * Only the exact candidate object returned by search has a source field.
 * FC11 uses this once before snapshotting its structurally accepted input.
 */
export function flowingContoursCandidateSourceField(
  candidate: Readonly<FlowingContoursCandidate>,
): Readonly<FlowingContoursField> | null {
  try {
    return CANDIDATE_SOURCE_FIELDS.get(candidate) ?? null
  } catch {
    return null
  }
}

export interface FlowingContoursCandidateOverlapMeasurement {
  readonly mean: number
  readonly representedCollisionFraction: number
}

/**
 * Measure one authentic whole candidate against evolving occupancy.
 *
 * The candidate is never cloned or rebound: callers retain the exact FC10
 * object and pass this bounded tangent-aware measurement into FC11.
 */
export function measureFlowingContoursCandidateRepresentedOverlap(
  candidate: Readonly<FlowingContoursCandidate>,
  sampler: FlowingContoursRepresentedOverlapSampler,
): Readonly<FlowingContoursCandidateOverlapMeasurement> | null {
  try {
    if (
      CANDIDATE_SOURCE_FIELDS.get(candidate) === undefined ||
      !Object.isFrozen(candidate)
    ) {
      return null
    }
    const measurement = measureRepresentedOverlap(
      sampler,
      candidate.samples,
    )
    if (measurement === null) return null
    return Object.freeze({
      mean: measurement.mean,
      representedCollisionFraction: measurement.collisionFraction,
    })
  } catch {
    return null
  }
}

function frozenPoint(x: number, y: number): Readonly<Point> {
  return Object.freeze([x, y] as Point)
}

function unit(vector: Readonly<Point>): Readonly<Point> | null {
  try {
    const x = vector[0]
    const y = vector[1]
    const length = Math.hypot(x, y)
    if (
      !Number.isFinite(x) ||
      !Number.isFinite(y) ||
      !Number.isFinite(length) ||
      length <= VECTOR_EPSILON
    ) {
      return null
    }
    return frozenPoint(x / length, y / length)
  } catch {
    return null
  }
}

function snapshotSample(
  source: Readonly<CorrectedFlowingRidgeSample>,
  tangentSign = 1,
): Readonly<CorrectedFlowingRidgeSample> | null {
  try {
    const point = frozenPoint(source.point[0], source.point[1])
    const tangent = unit(source.tangent)
    const tangentLength = Math.hypot(source.tangent[0], source.tangent[1])
    if (
      tangent === null ||
      !Number.isFinite(tangentLength) ||
      Math.abs(tangentLength - 1) > 1e-8 ||
      !Number.isFinite(point[0]) ||
      !Number.isFinite(point[1]) ||
      !Number.isFinite(source.evidence) ||
      source.evidence < 0 ||
      source.evidence > 1 ||
      !Number.isFinite(source.coherence) ||
      source.coherence < 0 ||
      source.coherence > 1 ||
      !Number.isFinite(source.ambiguity) ||
      source.ambiguity < 0 ||
      source.ambiguity > 1 ||
      !Number.isFinite(source.scale) ||
      source.scale <= 0 ||
      !Number.isFinite(source.alpha) ||
      source.alpha <= 0 ||
      source.alpha > 1
    ) {
      return null
    }
    return Object.freeze({
      point,
      // Preserve the already validated trace components exactly. Repeated
      // normalization makes long canonical assemblies drift from their own
      // directional trace provenance by a few ulps.
      tangent: frozenPoint(
        source.tangent[0] * tangentSign,
        source.tangent[1] * tangentSign,
      ),
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

function bilinearEvidence(
  field: Readonly<FlowingContoursField>,
  point: Readonly<Point>,
): number | null {
  const x = point[0]
  const y = point[1]
  if (
    !Number.isFinite(x) ||
    !Number.isFinite(y) ||
    x < 0 ||
    y < 0 ||
    x > field.width - 1 ||
    y > field.height - 1
  ) {
    return null
  }
  const left = Math.floor(x)
  const top = Math.floor(y)
  const right = Math.min(left + 1, field.width - 1)
  const bottom = Math.min(top + 1, field.height - 1)
  const horizontal = x - left
  const vertical = y - top
  const topValue =
    field.contourEvidence[top * field.width + left]! * (1 - horizontal) +
    field.contourEvidence[top * field.width + right]! * horizontal
  const bottomValue =
    field.contourEvidence[bottom * field.width + left]! * (1 - horizontal) +
    field.contourEvidence[bottom * field.width + right]! * horizontal
  const value = topValue * (1 - vertical) + bottomValue * vertical
  return Number.isFinite(value) ? value : null
}

function nearlyEqual(first: number, second: number): boolean {
  return (
    Number.isFinite(first) &&
    Number.isFinite(second) &&
    Math.abs(first - second) <= ANCHOR_MATCH_TOLERANCE
  )
}

function matchesSample(
  supplied: Readonly<CorrectedFlowingRidgeSample>,
  expected: Readonly<CorrectedFlowingRidgeSample>,
): boolean {
  return (
    nearlyEqual(supplied.point[0], expected.point[0]) &&
    nearlyEqual(supplied.point[1], expected.point[1]) &&
    nearlyEqual(supplied.tangent[0], expected.tangent[0]) &&
    nearlyEqual(supplied.tangent[1], expected.tangent[1]) &&
    nearlyEqual(supplied.evidence, expected.evidence) &&
    nearlyEqual(supplied.coherence, expected.coherence) &&
    nearlyEqual(supplied.ambiguity, expected.ambiguity) &&
    nearlyEqual(supplied.scale, expected.scale) &&
    nearlyEqual(supplied.alpha, expected.alpha)
  )
}

function ownedAnchorSample(
  field: Readonly<FlowingContoursField>,
  fieldSampleIndex: number,
  minimumSelectionScore: number,
): Readonly<CorrectedFlowingRidgeSample> | null {
  if (
    !field.positiveSupport[fieldSampleIndex] ||
    field.contourEvidence[fieldSampleIndex]! <= ANCHOR_EVIDENCE_EPSILON
  ) {
    return null
  }
  const x = fieldSampleIndex % field.width
  const y = Math.floor(fieldSampleIndex / field.width)
  const tangentX = field.tangentX[fieldSampleIndex]!
  const tangentY = field.tangentY[fieldSampleIndex]!
  const normalX = -tangentY
  const normalY = tangentX
  const centerEvidence = field.contourEvidence[fieldSampleIndex]!
  const minusEvidence = bilinearEvidence(field, [x - normalX, y - normalY])
  const plusEvidence = bilinearEvidence(field, [x + normalX, y + normalY])
  if (
    minusEvidence === null ||
    plusEvidence === null ||
    centerEvidence + ANCHOR_EVIDENCE_EPSILON < minusEvidence ||
    centerEvidence + ANCHOR_EVIDENCE_EPSILON < plusEvidence
  ) {
    return null
  }
  const denominator = minusEvidence - 2 * centerEvidence + plusEvidence
  const correction =
    denominator < -ANCHOR_EVIDENCE_EPSILON
      ? Math.max(
          -0.5,
          Math.min(0.5, (0.5 * (minusEvidence - plusEvidence)) / denominator),
        )
      : 0
  const expected = sampleFlowingContoursField(field, [
    x + normalX * correction,
    y + normalY * correction,
  ])
  if (
    expected === null ||
    expected.evidence <= ANCHOR_EVIDENCE_EPSILON ||
    expected.coherence < ANCHOR_MINIMUM_COHERENCE ||
    expected.ambiguity > ANCHOR_MAXIMUM_AMBIGUITY ||
    expected.evidence *
      (0.45 + 0.55 * expected.coherence) *
      (1 - 0.7 * expected.ambiguity) +
      ANCHOR_EVIDENCE_EPSILON <
      minimumSelectionScore
  ) {
    return null
  }
  return expected
}

function snapshotAnchor(
  source: Readonly<FlowingContoursAnchor>,
  field: Readonly<FlowingContoursField>,
  minimumSelectionScore: number,
): Readonly<FlowingContoursAnchor> | null {
  try {
    const sample = snapshotSample(source.sample)
    if (
      sample === null ||
      !Number.isSafeInteger(source.id) ||
      source.id < 0 ||
      !Number.isSafeInteger(source.fieldSampleIndex) ||
      source.fieldSampleIndex < 0 ||
      source.fieldSampleIndex >= field.width * field.height
    ) {
      return null
    }
    const expected = ownedAnchorSample(
      field,
      source.fieldSampleIndex,
      minimumSelectionScore,
    )
    if (expected === null || !matchesSample(sample, expected)) return null
    return Object.freeze({
      id: source.id,
      fieldSampleIndex: source.fieldSampleIndex,
      sample,
    })
  } catch {
    return null
  }
}

function isUnitInterval(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= 1
  )
}

function optionalUnitInterval(
  source: Readonly<Record<string, unknown>>,
  name: string,
): number | undefined | null {
  const value = source[name]
  return value === undefined ? undefined : isUnitInterval(value) ? value : null
}

function resolveOptions(
  source: Readonly<FlowingContoursSearchOptions>,
  forwardDirection: Readonly<Point>,
  limits: Readonly<FlowingContoursLimits>,
): Readonly<ResolvedSearchOptions> | null {
  try {
    if (
      !isUnitInterval(source.continuity) ||
      !isUnitInterval(source.flowSmoothing)
    ) {
      return null
    }

    const breadth = limits['search-breadth']
    if (
      !isWithinFlowingContoursLimit('search-breadth', breadth, limits) ||
      breadth < 1
    ) {
      return null
    }

    const suppliedAlternatives = source.directionAlternatives ?? []
    if (
      !Array.isArray(suppliedAlternatives) ||
      suppliedAlternatives.length + 1 > breadth
    ) {
      return null
    }
    const forwardAlternatives: Readonly<Point>[] = []
    const backwardAlternatives: Readonly<Point>[] = []
    for (const alternative of suppliedAlternatives) {
      const direction = unit(alternative)
      if (
        direction === null ||
        direction[0] * forwardDirection[0] +
          direction[1] * forwardDirection[1] <=
          VECTOR_EPSILON
      ) {
        return null
      }
      forwardAlternatives.push(direction)
      backwardAlternatives.push(frozenPoint(-direction[0], -direction[1]))
    }

    const ridgeSource = (source.ridgeStepOptions ?? {}) as Readonly<
      Record<string, unknown>
    >
    if (
      ridgeSource === null ||
      typeof ridgeSource !== 'object' ||
      Array.isArray(ridgeSource)
    ) {
      return null
    }
    const stepLength = ridgeSource.stepLength
    const maximumTurnRadians = ridgeSource.maximumTurnRadians
    const minimumEvidence = optionalUnitInterval(ridgeSource, 'minimumEvidence')
    const minimumCoherence = optionalUnitInterval(
      ridgeSource,
      'minimumCoherence',
    )
    const maximumAmbiguity = optionalUnitInterval(
      ridgeSource,
      'maximumAmbiguity',
    )
    const ambiguityMargin = optionalUnitInterval(ridgeSource, 'ambiguityMargin')
    const minimumTangentAlignment = optionalUnitInterval(
      ridgeSource,
      'minimumTangentAlignment',
    )
    const predictorHeadingInfluence = optionalUnitInterval(
      ridgeSource,
      'predictorHeadingInfluence',
    )
    const maximumOwnershipRadius = ridgeSource.maximumOwnershipRadius
    if (
      (stepLength !== undefined &&
        (typeof stepLength !== 'number' ||
          !Number.isFinite(stepLength) ||
          stepLength < 0.125 ||
          stepLength > 4)) ||
      (maximumTurnRadians !== undefined &&
        (typeof maximumTurnRadians !== 'number' ||
          !Number.isFinite(maximumTurnRadians) ||
          maximumTurnRadians <= 0 ||
          maximumTurnRadians > Math.PI / 2)) ||
      minimumEvidence === null ||
      minimumCoherence === null ||
      maximumAmbiguity === null ||
      ambiguityMargin === null ||
      minimumTangentAlignment === null ||
      predictorHeadingInfluence === null ||
      (maximumOwnershipRadius !== undefined &&
        (typeof maximumOwnershipRadius !== 'number' ||
          !Number.isFinite(maximumOwnershipRadius) ||
          maximumOwnershipRadius <= 0 ||
          maximumOwnershipRadius > 0.75))
    ) {
      return null
    }
    const ridgeStepOptions = Object.freeze({
      ...(stepLength === undefined ? {} : { stepLength }),
      ...(minimumEvidence === undefined ? {} : { minimumEvidence }),
      ...(minimumCoherence === undefined ? {} : { minimumCoherence }),
      ...(maximumAmbiguity === undefined ? {} : { maximumAmbiguity }),
      ...(maximumTurnRadians === undefined ? {} : { maximumTurnRadians }),
      ...(ambiguityMargin === undefined ? {} : { ambiguityMargin }),
      ...(minimumTangentAlignment === undefined
        ? {}
        : { minimumTangentAlignment }),
      ...(predictorHeadingInfluence === undefined
        ? {}
        : { predictorHeadingInfluence }),
      ...(maximumOwnershipRadius === undefined
        ? {}
        : { maximumOwnershipRadius }),
    })

    const sourceSampler = source.representedOverlapSampler ?? null
    const collisionThreshold = source.representedCollisionThreshold ?? 0.7
    if (
      (sourceSampler !== null && typeof sourceSampler !== 'function') ||
      !isUnitInterval(collisionThreshold)
    ) {
      return null
    }
    let invalidOverlapSample = false
    const sampler =
      sourceSampler === null
        ? null
        : (
            point: Readonly<Point>,
            travelTangent: Readonly<Point>,
          ): number => {
            if (invalidOverlapSample) return Number.NaN
            try {
              const value = sourceSampler(point, travelTangent)
              if (!isUnitInterval(value)) {
                invalidOverlapSample = true
                return Number.NaN
              }
              return value
            } catch {
              invalidOverlapSample = true
              return Number.NaN
            }
          }
    const common: FlowingContoursDirectionalGrowthOptions = {
      continuity: source.continuity,
      flowSmoothing: source.flowSmoothing,
      ridgeStepOptions,
      representedCollisionThreshold: collisionThreshold,
      ...(sampler === null ? {} : { representedOverlapSampler: sampler }),
    } as const
    return Object.freeze({
      forward: Object.freeze({
        ...common,
        directionAlternatives: Object.freeze(forwardAlternatives),
      }),
      backward: Object.freeze({
        ...common,
        directionAlternatives: Object.freeze(backwardAlternatives),
      }),
      flowSmoothing: source.flowSmoothing,
      representedOverlapSampler: sampler,
      overlapSamplerInvalid: () => invalidOverlapSample,
      minimumEvidence: minimumEvidence ?? DEFAULT_MINIMUM_EVIDENCE,
      minimumCoherence: minimumCoherence ?? DEFAULT_MINIMUM_COHERENCE,
      maximumAmbiguity: maximumAmbiguity ?? DEFAULT_MAXIMUM_AMBIGUITY,
    })
  } catch {
    return null
  }
}

function snapshotLimits(
  source: Readonly<FlowingContoursLimits>,
): Readonly<FlowingContoursLimits> | null {
  try {
    const snapshot = {} as Record<keyof FlowingContoursLimits, number>
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
      snapshot[name] = descriptor.value
    }
    return Object.freeze(snapshot)
  } catch {
    return null
  }
}

function withGrowthLimits(
  limits: Readonly<FlowingContoursLimits>,
  searchStepCount: number,
  rawTrajectoryPointCount: number,
): Readonly<FlowingContoursLimits> {
  return Object.freeze({
    ...limits,
    'search-step-count': searchStepCount,
    'raw-trajectory-point-count': rawTrajectoryPointCount,
  })
}

function hasValidField(
  field: Readonly<FlowingContoursField>,
  limits: Readonly<FlowingContoursLimits>,
): boolean {
  try {
    const sampleCount = field.width * field.height
    if (
      !Number.isSafeInteger(field.sourceWidth) ||
      field.sourceWidth <= 0 ||
      !Number.isSafeInteger(field.sourceHeight) ||
      field.sourceHeight <= 0 ||
      !Number.isSafeInteger(field.width) ||
      field.width <= 0 ||
      !Number.isSafeInteger(field.height) ||
      field.height <= 0 ||
      !Number.isSafeInteger(sampleCount) ||
      !isWithinFlowingContoursLimit(
        'analysis-dimension',
        field.width,
        limits,
      ) ||
      !isWithinFlowingContoursLimit(
        'analysis-dimension',
        field.height,
        limits,
      ) ||
      !isWithinFlowingContoursLimit(
        'analysis-sample-count',
        sampleCount,
        limits,
      )
    ) {
      return false
    }
    const arrays = [
      field.luminance,
      field.alpha,
      field.positiveSupport,
      field.contourEvidence,
      field.tangentX,
      field.tangentY,
      field.tangentCoherence,
      field.ambiguity,
      field.ridgeScale,
    ]
    if (arrays.some((values) => values.length !== sampleCount)) return false
    for (let index = 0; index < sampleCount; index += 1) {
      const luminance = field.luminance[index]
      const alpha = field.alpha[index]
      const evidence = field.contourEvidence[index]
      const tangentX = field.tangentX[index]
      const tangentY = field.tangentY[index]
      const coherence = field.tangentCoherence[index]
      const ambiguity = field.ambiguity[index]
      const scale = field.ridgeScale[index]
      const support = field.positiveSupport[index]
      const tangentLength = Math.hypot(tangentX ?? 0, tangentY ?? 0)
      if (
        !isUnitInterval(luminance) ||
        !isUnitInterval(alpha) ||
        !isUnitInterval(evidence) ||
        typeof tangentX !== 'number' ||
        !Number.isFinite(tangentX) ||
        typeof tangentY !== 'number' ||
        !Number.isFinite(tangentY) ||
        !Number.isFinite(tangentLength) ||
        (evidence > VECTOR_EPSILON && Math.abs(tangentLength - 1) > 1e-8) ||
        !isUnitInterval(coherence) ||
        !isUnitInterval(ambiguity) ||
        typeof scale !== 'number' ||
        !Number.isFinite(scale) ||
        scale < 0 ||
        typeof support !== 'boolean' ||
        support !== alpha > 0
      ) {
        return false
      }
    }
    return true
  } catch {
    return false
  }
}

function samePoint(first: Readonly<Point>, second: Readonly<Point>): boolean {
  return Object.is(first[0], second[0]) && Object.is(first[1], second[1])
}

function isValidTrace(
  trace: Readonly<FlowingContoursDirectionalTrace>,
  direction: 'forward' | 'backward',
  anchorPoint: Readonly<Point>,
  stepLimit: number,
): boolean {
  try {
    if (
      trace.direction !== direction ||
      !Number.isSafeInteger(trace.searchStepCount) ||
      trace.searchStepCount < 0 ||
      trace.searchStepCount > stepLimit ||
      trace.samples.length < 1 ||
      !samePoint(trace.samples[0]!.point, anchorPoint)
    ) {
      return false
    }
    return trace.samples.every((sample) => snapshotSample(sample) !== null)
  } catch {
    return false
  }
}

function reverseBackwardSamples(
  trace: Readonly<FlowingContoursDirectionalTrace>,
): readonly Readonly<CorrectedFlowingRidgeSample>[] | null {
  const samples: Readonly<CorrectedFlowingRidgeSample>[] = []
  for (let index = trace.samples.length - 1; index >= 0; index -= 1) {
    const sample = snapshotSample(trace.samples[index]!, -1)
    if (sample === null) return null
    samples.push(sample)
  }
  return Object.freeze(samples)
}

function snapshotForwardSamples(
  trace: Readonly<FlowingContoursDirectionalTrace>,
): readonly Readonly<CorrectedFlowingRidgeSample>[] | null {
  const samples: Readonly<CorrectedFlowingRidgeSample>[] = []
  for (const source of trace.samples) {
    const sample = snapshotSample(source)
    if (sample === null) return null
    samples.push(sample)
  }
  return Object.freeze(samples)
}

function reverseBackwardSupport(
  trace: Readonly<FlowingContoursDirectionalTrace>,
): readonly Readonly<FlowingContoursSpanSupportProvenance>[] | null {
  try {
    const lastIndex = trace.samples.length - 1
    const result: Readonly<FlowingContoursSpanSupportProvenance>[] = []
    for (let index = trace.spanSupport.length - 1; index >= 0; index -= 1) {
      const span = trace.spanSupport[index]!
      if (
        (span.kind !== 'direct-evidence' && span.kind !== 'bounded-gap') ||
        !Number.isSafeInteger(span.startSampleIndex) ||
        !Number.isSafeInteger(span.endSampleIndex) ||
        span.startSampleIndex < 0 ||
        span.endSampleIndex <= span.startSampleIndex ||
        span.endSampleIndex > lastIndex
      ) {
        return null
      }
      result.push(
        Object.freeze({
          kind: span.kind,
          startSampleIndex: lastIndex - span.endSampleIndex,
          endSampleIndex: lastIndex - span.startSampleIndex,
          length: span.length,
          entryEvidence: span.exitEvidence,
          exitEvidence: span.entryEvidence,
          directionalAlignment: span.directionalAlignment,
        }),
      )
    }
    return Object.freeze(result)
  } catch {
    return null
  }
}

function shiftedForwardSupport(
  trace: Readonly<FlowingContoursDirectionalTrace>,
  offset: number,
): readonly Readonly<FlowingContoursSpanSupportProvenance>[] | null {
  try {
    const lastIndex = trace.samples.length - 1
    const result: Readonly<FlowingContoursSpanSupportProvenance>[] = []
    for (const span of trace.spanSupport) {
      if (
        (span.kind !== 'direct-evidence' && span.kind !== 'bounded-gap') ||
        !Number.isSafeInteger(span.startSampleIndex) ||
        !Number.isSafeInteger(span.endSampleIndex) ||
        span.startSampleIndex < 0 ||
        span.endSampleIndex <= span.startSampleIndex ||
        span.endSampleIndex > lastIndex
      ) {
        return null
      }
      result.push(
        Object.freeze({
          kind: span.kind,
          startSampleIndex: span.startSampleIndex + offset,
          endSampleIndex: span.endSampleIndex + offset,
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

function segmentLength(
  first: Readonly<CorrectedFlowingRidgeSample>,
  second: Readonly<CorrectedFlowingRidgeSample>,
): number {
  return Math.hypot(
    second.point[0] - first.point[0],
    second.point[1] - first.point[1],
  )
}

function polylineLength(
  samples: readonly Readonly<CorrectedFlowingRidgeSample>[],
): number | null {
  let length = 0
  for (let index = 1; index < samples.length; index += 1) {
    const segment = segmentLength(samples[index - 1]!, samples[index]!)
    if (!Number.isFinite(segment)) return null
    length += segment
  }
  return Number.isFinite(length) ? length : null
}

function alignment(first: Readonly<Point>, second: Readonly<Point>): number {
  const firstUnit = unit(first)
  const secondUnit = unit(second)
  if (firstUnit === null || secondUnit === null) return -1
  return Math.max(
    -1,
    Math.min(1, firstUnit[0] * secondUnit[0] + firstUnit[1] * secondUnit[1]),
  )
}

function supportedLoopClosure(
  field: Readonly<FlowingContoursField>,
  samples: readonly Readonly<CorrectedFlowingRidgeSample>[],
  options: Readonly<ResolvedSearchOptions>,
): Readonly<FlowingContoursSpanSupportProvenance> | null {
  if (samples.length < 4) return null
  const first = samples[0]!
  const last = samples[samples.length - 1]!
  const dx = first.point[0] - last.point[0]
  const dy = first.point[1] - last.point[1]
  const length = Math.hypot(dx, dy)
  if (
    !Number.isFinite(length) ||
    length <= VECTOR_EPSILON ||
    length > LOOP_ENDPOINT_DISTANCE
  ) {
    return null
  }
  const closureDirection = unit([dx, dy])
  if (
    closureDirection === null ||
    alignment(last.tangent, first.tangent) < LOOP_ALIGNMENT_FLOOR ||
    alignment(last.tangent, closureDirection) < LOOP_ALIGNMENT_FLOOR ||
    alignment(first.tangent, closureDirection) < LOOP_ALIGNMENT_FLOOR
  ) {
    return null
  }

  const intervalCount = Math.max(1, Math.ceil(length / LOOP_SAMPLE_SPACING))
  if (intervalCount > MAXIMUM_LOOP_SAMPLES) return null
  let minimumAlignment = 1
  for (let index = 1; index <= intervalCount; index += 1) {
    const parameter = index / intervalCount
    const sampled = sampleFlowingContoursField(
      field,
      frozenPoint(
        last.point[0] + dx * parameter,
        last.point[1] + dy * parameter,
      ),
    )
    const sampledTangent = sampled === null ? null : unit(sampled.tangent)
    if (
      sampled === null ||
      sampledTangent === null ||
      sampled.alpha <= 0 ||
      sampled.evidence <= 0 ||
      sampled.coherence <= 0 ||
      sampled.ambiguity >= HARD_RESOLVED_AMBIGUITY_MAXIMUM ||
      sampled.evidence < options.minimumEvidence ||
      sampled.coherence < options.minimumCoherence ||
      sampled.ambiguity > options.maximumAmbiguity
    ) {
      return null
    }
    const sampledAlignment = Math.abs(
      alignment(sampledTangent, closureDirection),
    )
    if (sampledAlignment < LOOP_ALIGNMENT_FLOOR) return null
    minimumAlignment = Math.min(minimumAlignment, sampledAlignment)
  }

  return Object.freeze({
    kind: 'direct-evidence',
    startSampleIndex: samples.length - 1,
    endSampleIndex: samples.length,
    length,
    entryEvidence: last.evidence,
    exitEvidence: first.evidence,
    directionalAlignment: Math.min(
      minimumAlignment,
      alignment(last.tangent, first.tangent),
      alignment(last.tangent, closureDirection),
      alignment(first.tangent, closureDirection),
    ),
  })
}

function singletonBackwardLoopTrace(
  anchor: Readonly<CorrectedFlowingRidgeSample>,
): Readonly<FlowingContoursDirectionalTrace> | null {
  const sample = snapshotSample(anchor, -1)
  return sample === null
    ? null
    : Object.freeze({
        direction: 'backward',
        samples: Object.freeze([sample]),
        spanSupport: Object.freeze([]),
        // A proven self-loop reached geometry represented by its own prefix.
        endpointReason: 'represented-collision',
        searchStepCount: 0,
      })
}

interface RepresentedOverlapMeasurement {
  readonly mean: number
  readonly collisionFraction: number
}

function measureRepresentedOverlap(
  sampler: FlowingContoursRepresentedOverlapSampler | null,
  samples: readonly Readonly<CorrectedFlowingRidgeSample>[],
  collisionThreshold = DEFAULT_REPRESENTED_COLLISION_THRESHOLD,
): Readonly<RepresentedOverlapMeasurement> | null {
  if (sampler === null) {
    return Object.freeze({ mean: 0, collisionFraction: 0 })
  }
  try {
    const segmentTangents: Readonly<Point>[] = []
    for (let index = 1; index < samples.length; index += 1) {
      const start = samples[index - 1]!.point
      const end = samples[index]!.point
      const tangent = unit([end[0] - start[0], end[1] - start[1]])
      if (tangent === null) return null
      segmentTangents.push(tangent)
    }
    const initialTangent = segmentTangents[0]
    if (initialTangent === undefined) return null

    let sum = 0
    let count = 0
    let collisionCount = 0
    const initial = sampler(samples[0]!.point, initialTangent)
    if (!isUnitInterval(initial)) return null
    sum += initial
    count += 1
    if (initial >= collisionThreshold) collisionCount += 1
    for (let index = 1; index < samples.length; index += 1) {
      const start = samples[index - 1]!.point
      const end = samples[index]!.point
      const dx = end[0] - start[0]
      const dy = end[1] - start[1]
      const length = Math.hypot(dx, dy)
      if (!Number.isFinite(length) || length <= VECTOR_EPSILON) return null
      const tangent = segmentTangents[index - 1]!
      const intervalCount = Math.max(
        1,
        Math.ceil(length / OVERLAP_SAMPLE_SPACING),
      )
      if (intervalCount > MAXIMUM_OVERLAP_SAMPLES_PER_SEGMENT) return null
      for (
        let sampleIndex = 1;
        sampleIndex <= intervalCount;
        sampleIndex += 1
      ) {
        const parameter = sampleIndex / intervalCount
        const value = sampler(
          frozenPoint(start[0] + dx * parameter, start[1] + dy * parameter),
          tangent,
        )
        if (!isUnitInterval(value)) return null
        sum += value
        count += 1
        if (value >= collisionThreshold) collisionCount += 1
      }
    }
    const mean = sum / count
    const collisionFraction = collisionCount / count
    return Number.isFinite(mean) && Number.isFinite(collisionFraction)
      ? Object.freeze({ mean, collisionFraction })
      : null
  } catch {
    return null
  }
}

function sampleRepresentedOverlap(
  sampler: FlowingContoursRepresentedOverlapSampler | null,
  samples: readonly Readonly<CorrectedFlowingRidgeSample>[],
): number | null {
  return measureRepresentedOverlap(sampler, samples)?.mean ?? null
}

function directionalCoherence(
  samples: readonly Readonly<CorrectedFlowingRidgeSample>[],
): number {
  if (samples.length < 2) return 0
  let sum = 0
  for (let index = 1; index < samples.length; index += 1) {
    sum += Math.max(
      0,
      alignment(samples[index - 1]!.tangent, samples[index]!.tangent),
    )
  }
  return sum / (samples.length - 1)
}

type LocalSegmentCertificate = 'direct' | 'weak' | 'contradiction'

function locallyResolved(
  sample: Readonly<CorrectedFlowingRidgeSample>,
): boolean {
  return (
    sample.evidence >= DEFAULT_MINIMUM_EVIDENCE &&
    sample.coherence >= DEFAULT_MINIMUM_COHERENCE &&
    sample.ambiguity <= DEFAULT_MAXIMUM_AMBIGUITY
  )
}

function certifyLocalSegment(
  field: Readonly<FlowingContoursField>,
  start: Readonly<CorrectedFlowingRidgeSample>,
  end: Readonly<CorrectedFlowingRidgeSample>,
): LocalSegmentCertificate | null {
  const dx = end.point[0] - start.point[0]
  const dy = end.point[1] - start.point[1]
  const length = Math.hypot(dx, dy)
  const chord = unit([dx, dy])
  if (!Number.isFinite(length) || length <= VECTOR_EPSILON || chord === null) {
    return null
  }
  const intervalCount = Math.max(
    1,
    Math.ceil(length / LOCAL_CERTIFICATE_SAMPLE_SPACING),
  )
  if (intervalCount > MAXIMUM_LOCAL_CERTIFICATE_SAMPLES_PER_SEGMENT) {
    return null
  }
  let direct = true
  for (let index = 0; index <= intervalCount; index += 1) {
    const amount = index / intervalCount
    const sampled = sampleFlowingContoursField(
      field,
      frozenPoint(start.point[0] + dx * amount, start.point[1] + dy * amount),
    )
    if (sampled === null) return 'contradiction'
    if (!locallyResolved(sampled)) {
      direct = false
      continue
    }
    if (
      Math.abs(alignment(sampled.tangent, chord)) <
      LOCAL_CERTIFICATE_ALIGNMENT_FLOOR
    ) {
      return 'contradiction'
    }
  }
  return direct ? 'direct' : 'weak'
}

function localTraceSample(
  field: Readonly<FlowingContoursField>,
  proposal: Readonly<CorrectedFlowingRidgeSample>,
): Readonly<CorrectedFlowingRidgeSample> | null {
  const sampled = sampleFlowingContoursField(field, proposal.point)
  if (sampled === null) return null
  const sign =
    alignment(sampled.tangent, proposal.tangent) < 0 ? -1 : 1
  return snapshotSample(
    {
      ...sampled,
      tangent: frozenPoint(
        sampled.tangent[0] * sign,
        sampled.tangent[1] * sign,
      ),
    },
  )
}

function certifiedGapAlignment(
  samples: readonly Readonly<CorrectedFlowingRidgeSample>[],
  start: number,
  end: number,
): number | null {
  const entry = samples[start]
  if (entry === undefined || end <= start || end >= samples.length) return null
  let minimum = 1
  for (let index = start + 1; index <= end; index += 1) {
    const previous = samples[index - 1]!
    const sample = samples[index]!
    const displacement = unit([
      sample.point[0] - entry.point[0],
      sample.point[1] - entry.point[1],
    ])
    if (displacement === null) return null
    minimum = Math.min(
      minimum,
      alignment(previous.tangent, sample.tangent),
      alignment(entry.tangent, sample.tangent),
      alignment(entry.tangent, displacement),
      alignment(sample.tangent, displacement),
    )
  }
  return minimum
}

function appendCertifiedDirectSupport(
  spans: Readonly<FlowingContoursSpanSupportProvenance>[],
  start: number,
  end: number,
  samples: readonly Readonly<CorrectedFlowingRidgeSample>[],
  length: number,
): void {
  const entry = samples[start]!
  const exit = samples[end]!
  const directionalAlignment = alignment(entry.tangent, exit.tangent)
  const previous = spans[spans.length - 1]
  if (
    previous?.kind === 'direct-evidence' &&
    previous.endSampleIndex === start
  ) {
    spans[spans.length - 1] = Object.freeze({
      ...previous,
      endSampleIndex: end,
      length: previous.length + length,
      exitEvidence: exit.evidence,
      directionalAlignment: Math.min(
        previous.directionalAlignment,
        directionalAlignment,
      ),
    })
    return
  }
  spans.push(
    Object.freeze({
      kind: 'direct-evidence',
      startSampleIndex: start,
      endSampleIndex: end,
      length,
      entryEvidence: entry.evidence,
      exitEvidence: exit.evidence,
      directionalAlignment,
    }),
  )
}

function certifyLocalTrace(
  field: Readonly<FlowingContoursField>,
  proposal: Readonly<FlowingContoursDirectionalTrace>,
  continuity: number,
  limits: Readonly<FlowingContoursLimits>,
): Readonly<FlowingContoursDirectionalTrace> | null {
  const samples: Readonly<CorrectedFlowingRidgeSample>[] = []
  for (const source of proposal.samples) {
    const sample = localTraceSample(field, source)
    if (sample === null) return null
    samples.push(sample)
  }
  if (samples.length < 1) return null
  const allowedWeakSteps = Math.min(
    limits['weak-span-step-count'],
    Math.floor(
      continuity * FLOWING_CONTOURS_LIMITS['weak-span-step-count'],
    ),
  )
  const allowedWeakDistance = Math.min(
    limits['weak-span-distance'],
    continuity * FLOWING_CONTOURS_LIMITS['weak-span-distance'],
  )
  const spans: Readonly<FlowingContoursSpanSupportProvenance>[] = []
  let gapStart: number | null = null
  let gapStepCount = 0
  let gapLength = 0
  for (let index = 1; index < samples.length; index += 1) {
    const first = samples[index - 1]!
    const second = samples[index]!
    const length = segmentLength(first, second)
    const certificate = certifyLocalSegment(field, first, second)
    if (certificate === 'contradiction') return null
    if (
      certificate === null ||
      !Number.isFinite(length) ||
      length <= VECTOR_EPSILON
    ) {
      return null
    }
    if (certificate === 'weak') {
      gapStart ??= index - 1
      gapStepCount += 1
      gapLength += length
      if (
        gapStepCount > allowedWeakSteps ||
        gapLength > allowedWeakDistance
      ) {
        return null
      }
      continue
    }
    if (gapStart !== null) {
      const gapEnd = index
      const certifiedLength = gapLength + length
      const gapAlignment = certifiedGapAlignment(samples, gapStart, gapEnd)
      if (
        gapAlignment === null ||
        gapAlignment < LOCAL_CERTIFICATE_ALIGNMENT_FLOOR ||
        certifiedLength > allowedWeakDistance
      ) {
        return null
      }
      spans.push(
        Object.freeze({
          kind: 'bounded-gap',
          startSampleIndex: gapStart,
          endSampleIndex: gapEnd,
          length: certifiedLength,
          entryEvidence: samples[gapStart]!.evidence,
          exitEvidence: samples[gapEnd]!.evidence,
          directionalAlignment: gapAlignment,
        }),
      )
      gapStart = null
      gapStepCount = 0
      gapLength = 0
      continue
    }
    appendCertifiedDirectSupport(
      spans,
      index - 1,
      index,
      samples,
      length,
    )
  }
  // Weak travel must be bounded by recovered direct evidence on both sides.
  if (gapStart !== null) return null
  return Object.freeze({
    direction: proposal.direction,
    samples: Object.freeze(samples),
    spanSupport: Object.freeze(spans),
    endpointReason: proposal.endpointReason,
    searchStepCount: proposal.searchStepCount,
  })
}

/**
 * Re-certify a broad geometric proposal against one exact local proof field.
 *
 * Geometry is retained, but every stored sample, support label, objective
 * component, durable field brand, and later evidence tube comes from `field`.
 * Strong locally aligned travel becomes direct support; unresolved travel may
 * survive only through the existing bounded-gap policy. A resolved local
 * tangent contradiction rejects the whole proposal.
 */
export function certifyFlowingContoursCandidateAgainstField(
  proposal: Readonly<FlowingContoursCandidate>,
  field: Readonly<FlowingContoursField>,
  continuity: number,
  flowSmoothing: number,
  limitsSource: Readonly<FlowingContoursLimits> = FLOWING_CONTOURS_LIMITS,
): Readonly<FlowingContoursCandidate> | null {
  try {
    if (
      CANDIDATE_SOURCE_FIELDS.get(proposal) === undefined ||
      !Number.isFinite(continuity) ||
      continuity < 0 ||
      continuity > 1 ||
      !Number.isFinite(flowSmoothing) ||
      flowSmoothing < 0 ||
      flowSmoothing > 1
    ) {
      return null
    }
    const limits = snapshotLimits(limitsSource)
    if (limits === null || !hasValidField(field, limits)) return null
    const backward = certifyLocalTrace(
      field,
      proposal.backward,
      continuity,
      limits,
    )
    const forward = certifyLocalTrace(
      field,
      proposal.forward,
      continuity,
      limits,
    )
    if (backward === null || forward === null) return null
    const backwardSamples = reverseBackwardSamples(backward)
    const forwardSamples = snapshotForwardSamples(forward)
    const backwardSupport = reverseBackwardSupport(backward)
    const forwardSupport = shiftedForwardSupport(
      forward,
      backward.samples.length - 1,
    )
    if (
      backwardSamples === null ||
      forwardSamples === null ||
      backwardSupport === null ||
      forwardSupport === null
    ) {
      return null
    }
    const samples = Object.freeze([
      ...backwardSamples,
      ...forwardSamples.slice(1),
    ])
    const spanSupport = Object.freeze([
      ...backwardSupport,
      ...forwardSupport,
    ])
    // Closed broad proposals require an independently certified closing span;
    // fail closed rather than inheriting the proposal field's loop proof.
    if (samples.length !== proposal.samples.length || samples.length < 2) {
      return null
    }
    const length = polylineLength(samples)
    if (length === null || length <= 0) return null
    const unsupportedLength = spanSupport.reduce(
      (sum, span) =>
        sum + (span.kind === 'bounded-gap' ? span.length : 0),
      0,
    )
    const sampleCount = samples.length
    const segmentCount = Math.max(1, sampleCount - 1)
    const score = scoreFlowingContoursCandidate(
      {
        accumulatedEvidence:
          samples.reduce((sum, sample) => sum + sample.evidence, 0) /
          sampleCount,
        usefulLength:
          length / Math.max(1, Math.hypot(field.width, field.height)),
        directionalCoherence: directionalCoherence(samples),
        curvatureChange:
          measureFlowingContoursCurvatureChange(
            samples.map((sample) => sample.point),
          ) / segmentCount,
        unsupportedTravel:
          unsupportedLength /
          Math.max(1, Math.hypot(field.width, field.height)),
        ambiguity:
          samples.reduce((sum, sample) => sum + sample.ambiguity, 0) /
          sampleCount,
        representedOverlap: 0,
      },
      flowSmoothing,
    )
    const anchor = Object.freeze({
      id: proposal.anchor.id,
      fieldSampleIndex: proposal.anchor.fieldSampleIndex,
      sample: forward.samples[0]!,
    })
    const certified = Object.freeze({
      anchor,
      backward,
      forward,
      samples,
      spanSupport,
      length,
      score,
    })
    CANDIDATE_SOURCE_FIELDS.set(certified, field)
    return certified
  } catch {
    return null
  }
}

/**
 * Search one complete candidate from one anchor.
 *
 * The first half receives the deterministic odd step; backward search may use
 * any forward remainder, so actual FC07 invocations across both traces never
 * exceed the one global `search-step-count` policy.
 */
export interface FlowingContoursSearchResult {
  readonly candidate: Readonly<FlowingContoursCandidate> | null
  /** Actual FC09 directional growth invocations; loop synthesis adds none. */
  readonly directionalTraceCount: number
  /** Exact aggregate FC07 invocations consumed by those traces. */
  readonly searchStepCount: number
  /** True only when the supplied aggregate search-step allowance was spent. */
  readonly searchCapExhausted: boolean
}

export function searchFlowingContoursCandidateDetailed(
  field: Readonly<FlowingContoursField>,
  anchorSource: Readonly<FlowingContoursAnchor>,
  optionsSource: Readonly<FlowingContoursSearchOptions>,
  limitsSource: Readonly<FlowingContoursLimits> = FLOWING_CONTOURS_LIMITS,
): Readonly<FlowingContoursSearchResult> | null {
  let attempted = false
  let directionalTraceCount = 0
  let searchStepCount = 0
  let aggregateSearchStepLimit = 0
  const finish = (
    candidate: Readonly<FlowingContoursCandidate> | null,
  ): Readonly<FlowingContoursSearchResult> =>
    Object.freeze({
      candidate,
      directionalTraceCount,
      searchStepCount,
      searchCapExhausted:
        attempted && searchStepCount >= aggregateSearchStepLimit,
    })
  try {
    const limits = snapshotLimits(limitsSource)
    if (limits === null || !hasValidField(field, limits)) return null
    const minimumAnchorSelectionScore =
      optionsSource.minimumAnchorSelectionScore ??
      ANCHOR_MINIMUM_SELECTION_SCORE
    if (!isUnitInterval(minimumAnchorSelectionScore)) return null
    const anchor = snapshotAnchor(
      anchorSource,
      field,
      minimumAnchorSelectionScore,
    )
    if (
      anchor === null ||
      anchor.sample.point[0] < 0 ||
      anchor.sample.point[1] < 0 ||
      anchor.sample.point[0] > field.width - 1 ||
      anchor.sample.point[1] > field.height - 1 ||
      sampleFlowingContoursField(field, anchor.sample.point) === null
    ) {
      return null
    }
    const forwardDirection = unit(anchor.sample.tangent)
    if (forwardDirection === null) return null
    const options = resolveOptions(optionsSource, forwardDirection, limits)
    if (options === null) return null

    const globalStepLimit = limits['search-step-count']
    const globalRawPointLimit = limits['raw-trajectory-point-count']
    if (globalRawPointLimit < 1) return null
    aggregateSearchStepLimit = globalStepLimit
    attempted = true
    const forwardStepLimit = Math.ceil(globalStepLimit / 2)
    const forwardRawPointLimit = 1 + Math.ceil((globalRawPointLimit - 1) / 2)
    const forward = growFlowingContoursDirection(
      field,
      anchor.sample,
      forwardDirection,
      'forward',
      options.forward,
      withGrowthLimits(limits, forwardStepLimit, forwardRawPointLimit),
    )
    directionalTraceCount = 1
    searchStepCount = forward.searchStepCount
    if (
      !isValidTrace(
        forward,
        'forward',
        anchor.sample.point,
        forwardStepLimit,
      ) ||
      options.overlapSamplerInvalid()
    ) {
      return finish(null)
    }
    const forwardIsSupportedSelfLoop =
      isFlowingContoursSupportedSelfLoopTrace(forward) &&
      forward.endpointReason === 'represented-collision' &&
      supportedLoopClosure(field, forward.samples, options) !== null
    const backwardStepLimit = globalStepLimit - forward.searchStepCount
    const backwardRawPointLimit =
      globalRawPointLimit - (forward.samples.length - 1)
    if (backwardRawPointLimit < 1) return finish(null)
    const backwardDirection = frozenPoint(
      -forwardDirection[0],
      -forwardDirection[1],
    )
    const backward = forwardIsSupportedSelfLoop
      ? singletonBackwardLoopTrace(anchor.sample)
      : growFlowingContoursDirection(
          field,
          anchor.sample,
          backwardDirection,
          'backward',
          options.backward,
          withGrowthLimits(limits, backwardStepLimit, backwardRawPointLimit),
        )
    if (!forwardIsSupportedSelfLoop) directionalTraceCount += 1
    if (backward === null) return finish(null)
    searchStepCount += backward.searchStepCount
    if (
      !isValidTrace(
        backward,
        'backward',
        anchor.sample.point,
        backwardStepLimit,
      ) ||
      forward.searchStepCount + backward.searchStepCount > globalStepLimit ||
      options.overlapSamplerInvalid()
    ) {
      return finish(null)
    }

    const backwardSamples = reverseBackwardSamples(backward)
    const forwardSamples = snapshotForwardSamples(forward)
    const backwardSupport = reverseBackwardSupport(backward)
    const forwardSupport = shiftedForwardSupport(
      forward,
      backward.samples.length - 1,
    )
    if (
      backwardSamples === null ||
      forwardSamples === null ||
      backwardSupport === null ||
      forwardSupport === null
    ) {
      return finish(null)
    }
    const samples: Readonly<CorrectedFlowingRidgeSample>[] = [
      ...backwardSamples,
      ...forwardSamples.slice(1),
    ]
    const spanSupport: Readonly<FlowingContoursSpanSupportProvenance>[] = [
      ...backwardSupport,
      ...forwardSupport,
    ]

    const closure =
      samples.length < globalRawPointLimit
        ? supportedLoopClosure(field, samples, options)
        : null
    if (closure !== null && samples.length + 1 <= globalRawPointLimit) {
      const duplicate = snapshotSample(samples[0]!)
      if (duplicate === null) return finish(null)
      samples.push(duplicate)
      spanSupport.push(closure)
    }
    if (samples.length < 2 || samples.length > globalRawPointLimit) {
      return finish(null)
    }
    const frozenSamples = Object.freeze(samples)
    const frozenSupport = Object.freeze(spanSupport)
    const length = polylineLength(frozenSamples)
    const representedOverlap = sampleRepresentedOverlap(
      options.representedOverlapSampler,
      frozenSamples,
    )
    if (
      length === null ||
      length <= 0 ||
      representedOverlap === null
    ) {
      return finish(null)
    }
    if (options.overlapSamplerInvalid()) return finish(null)

    const sampleCount = frozenSamples.length
    const segmentCount = Math.max(1, sampleCount - 1)
    const evidence =
      frozenSamples.reduce((sum, sample) => sum + sample.evidence, 0) /
      sampleCount
    const ambiguity =
      frozenSamples.reduce((sum, sample) => sum + sample.ambiguity, 0) /
      sampleCount
    const unsupportedLength = frozenSupport.reduce(
      (sum, span) => sum + (span.kind === 'bounded-gap' ? span.length : 0),
      0,
    )
    const diagonal = Math.max(1, Math.hypot(field.width, field.height))
    const curvatureChange =
      measureFlowingContoursCurvatureChange(
        frozenSamples.map((sample) => sample.point),
      ) / segmentCount
    const score = scoreFlowingContoursCandidate(
      {
        accumulatedEvidence: evidence,
        usefulLength: length / diagonal,
        directionalCoherence: directionalCoherence(frozenSamples),
        curvatureChange,
        unsupportedTravel: unsupportedLength / diagonal,
        ambiguity,
        representedOverlap,
      },
      options.flowSmoothing,
    )
    const candidate: Readonly<FlowingContoursCandidate> = Object.freeze({
      anchor,
      backward,
      forward,
      samples: frozenSamples,
      spanSupport: frozenSupport,
      length,
      score,
    })
    CANDIDATE_SOURCE_FIELDS.set(candidate, field)
    return finish(candidate)
  } catch {
    return attempted ? finish(null) : null
  }
}

/** Backward-compatible candidate-only wrapper around the accounted search. */
export function searchFlowingContoursCandidate(
  field: Readonly<FlowingContoursField>,
  anchorSource: Readonly<FlowingContoursAnchor>,
  optionsSource: Readonly<FlowingContoursSearchOptions>,
  limitsSource: Readonly<FlowingContoursLimits> = FLOWING_CONTOURS_LIMITS,
): Readonly<FlowingContoursCandidate> | null {
  return searchFlowingContoursCandidateDetailed(
    field,
    anchorSource,
    optionsSource,
    limitsSource,
  )?.candidate ?? null
}
