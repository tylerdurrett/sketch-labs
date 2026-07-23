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
const DEFAULT_MINIMUM_EVIDENCE = 0.04
const DEFAULT_MINIMUM_COHERENCE = 0.25
const DEFAULT_MAXIMUM_AMBIGUITY = 0.7

export interface FlowingContoursSearchOptions
  extends FlowingContoursDirectionalGrowthOptions {}

interface ResolvedSearchOptions {
  readonly forward: Readonly<FlowingContoursDirectionalGrowthOptions>
  readonly backward: Readonly<FlowingContoursDirectionalGrowthOptions>
  readonly flowSmoothing: number
  readonly representedOverlapSampler:
    | FlowingContoursRepresentedOverlapSampler
    | null
  readonly minimumEvidence: number
  readonly minimumCoherence: number
  readonly maximumAmbiguity: number
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
    if (
      tangent === null ||
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
      tangent: frozenPoint(
        tangent[0] * tangentSign,
        tangent[1] * tangentSign,
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

function snapshotAnchor(
  source: Readonly<FlowingContoursAnchor>,
  fieldSampleCount: number,
): Readonly<FlowingContoursAnchor> | null {
  try {
    const sample = snapshotSample(source.sample)
    if (
      sample === null ||
      !Number.isSafeInteger(source.id) ||
      source.id < 0 ||
      !Number.isSafeInteger(source.fieldSampleIndex) ||
      source.fieldSampleIndex < 0 ||
      source.fieldSampleIndex >= fieldSampleCount
    ) {
      return null
    }
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
    if (!Array.isArray(suppliedAlternatives)) return null
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
    if (forwardAlternatives.length + 1 > breadth) return null

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
    const minimumEvidence = optionalUnitInterval(
      ridgeSource,
      'minimumEvidence',
    )
    const minimumCoherence = optionalUnitInterval(
      ridgeSource,
      'minimumCoherence',
    )
    const maximumAmbiguity = optionalUnitInterval(
      ridgeSource,
      'maximumAmbiguity',
    )
    const ambiguityMargin = optionalUnitInterval(
      ridgeSource,
      'ambiguityMargin',
    )
    const minimumTangentAlignment = optionalUnitInterval(
      ridgeSource,
      'minimumTangentAlignment',
    )
    const predictorHeadingInfluence = optionalUnitInterval(
      ridgeSource,
      'predictorHeadingInfluence',
    )
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
      predictorHeadingInfluence === null
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
    })

    const sampler = source.representedOverlapSampler ?? null
    const collisionThreshold =
      source.representedCollisionThreshold ?? 0.7
    if (
      (sampler !== null && typeof sampler !== 'function') ||
      !isUnitInterval(collisionThreshold)
    ) {
      return null
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

function withStepLimit(
  limits: Readonly<FlowingContoursLimits>,
  searchStepCount: number,
): Readonly<FlowingContoursLimits> {
  return Object.freeze({
    ...limits,
    'search-step-count': searchStepCount,
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
        (evidence > VECTOR_EPSILON &&
          Math.abs(tangentLength - 1) > 1e-8) ||
        !isUnitInterval(coherence) ||
        !isUnitInterval(ambiguity) ||
        typeof scale !== 'number' ||
        !Number.isFinite(scale) ||
        scale < 0 ||
        typeof support !== 'boolean' ||
        support !== (alpha > 0)
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
    Math.min(
      1,
      firstUnit[0] * secondUnit[0] + firstUnit[1] * secondUnit[1],
    ),
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
    if (
      sampled === null ||
      sampled.alpha <= 0 ||
      sampled.evidence < options.minimumEvidence ||
      sampled.coherence < options.minimumCoherence ||
      sampled.ambiguity > options.maximumAmbiguity
    ) {
      return null
    }
    const sampledAlignment = Math.abs(
      alignment(sampled.tangent, closureDirection),
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
      alignment(last.tangent, closureDirection),
      alignment(first.tangent, closureDirection),
    ),
  })
}

function sampleRepresentedOverlap(
  sampler: FlowingContoursRepresentedOverlapSampler | null,
  samples: readonly Readonly<CorrectedFlowingRidgeSample>[],
): number | null {
  if (sampler === null) return 0
  try {
    let sum = 0
    let count = 0
    const initial = sampler(samples[0]!.point)
    if (!isUnitInterval(initial)) return null
    sum += initial
    count += 1
    for (let index = 1; index < samples.length; index += 1) {
      const start = samples[index - 1]!.point
      const end = samples[index]!.point
      const dx = end[0] - start[0]
      const dy = end[1] - start[1]
      const length = Math.hypot(dx, dy)
      if (!Number.isFinite(length) || length <= VECTOR_EPSILON) return null
      const intervalCount = Math.max(
        1,
        Math.ceil(length / OVERLAP_SAMPLE_SPACING),
      )
      if (intervalCount > MAXIMUM_OVERLAP_SAMPLES_PER_SEGMENT) return null
      for (let sampleIndex = 1; sampleIndex <= intervalCount; sampleIndex += 1) {
        const parameter = sampleIndex / intervalCount
        const value = sampler(
          frozenPoint(
            start[0] + dx * parameter,
            start[1] + dy * parameter,
          ),
        )
        if (!isUnitInterval(value)) return null
        sum += value
        count += 1
      }
    }
    const mean = sum / count
    return Number.isFinite(mean) ? mean : null
  } catch {
    return null
  }
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

/**
 * Search one complete candidate from one anchor.
 *
 * The first half receives the deterministic odd step; backward search may use
 * any forward remainder, so actual FC07 invocations across both traces never
 * exceed the one global `search-step-count` policy.
 */
export function searchFlowingContoursCandidate(
  field: Readonly<FlowingContoursField>,
  anchorSource: Readonly<FlowingContoursAnchor>,
  optionsSource: Readonly<FlowingContoursSearchOptions>,
  limitsSource: Readonly<FlowingContoursLimits> = FLOWING_CONTOURS_LIMITS,
): Readonly<FlowingContoursCandidate> | null {
  try {
    const limits = snapshotLimits(limitsSource)
    if (limits === null || !hasValidField(field, limits)) return null
    const anchor = snapshotAnchor(anchorSource, field.width * field.height)
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
    const forwardStepLimit = Math.ceil(globalStepLimit / 2)
    const forward = growFlowingContoursDirection(
      field,
      anchor.sample,
      forwardDirection,
      'forward',
      options.forward,
      withStepLimit(limits, forwardStepLimit),
    )
    if (
      !isValidTrace(
        forward,
        'forward',
        anchor.sample.point,
        forwardStepLimit,
      )
    ) {
      return null
    }
    const backwardStepLimit = globalStepLimit - forward.searchStepCount
    const backwardDirection = frozenPoint(
      -forwardDirection[0],
      -forwardDirection[1],
    )
    const backward = growFlowingContoursDirection(
      field,
      anchor.sample,
      backwardDirection,
      'backward',
      options.backward,
      withStepLimit(limits, backwardStepLimit),
    )
    if (
      !isValidTrace(
        backward,
        'backward',
        anchor.sample.point,
        backwardStepLimit,
      ) ||
      forward.searchStepCount + backward.searchStepCount > globalStepLimit
    ) {
      return null
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
      return null
    }
    const samples: Readonly<CorrectedFlowingRidgeSample>[] = [
      ...backwardSamples,
      ...forwardSamples.slice(1),
    ]
    const spanSupport: Readonly<FlowingContoursSpanSupportProvenance>[] = [
      ...backwardSupport,
      ...forwardSupport,
    ]

    const closure = supportedLoopClosure(field, samples, options)
    if (closure !== null) {
      const duplicate = snapshotSample(samples[0]!)
      if (duplicate === null) return null
      samples.push(duplicate)
      spanSupport.push(closure)
    }
    const frozenSamples = Object.freeze(samples)
    const frozenSupport = Object.freeze(spanSupport)
    const length = polylineLength(frozenSamples)
    const representedOverlap = sampleRepresentedOverlap(
      options.representedOverlapSampler,
      frozenSamples,
    )
    if (length === null || representedOverlap === null) return null

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
    return Object.freeze({
      anchor,
      backward,
      forward,
      samples: frozenSamples,
      spanSupport: frozenSupport,
      length,
      score,
    })
  } catch {
    return null
  }
}
