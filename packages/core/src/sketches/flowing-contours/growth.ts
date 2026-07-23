/**
 * Bounded one-direction Flowing Contours growth.
 *
 * Search states retain persistent predecessor nodes and incremental objective
 * totals. Arrays are materialized only for the selected terminal trace. Weak
 * ridge observations remain provisional until compatible corrected evidence
 * is reacquired; every other stop rolls back to the last supported node.
 */

import type { Point } from '../../types'
import {
  compareFlowingContoursObjectiveOrder,
  scoreFlowingContoursCandidate,
  type FlowingContoursObjectiveOrderKey,
} from './objective'
import {
  FLOWING_CONTOURS_LIMITS,
  isWithinFlowingContoursLimit,
  type FlowingContoursLimits,
} from './limits'
import {
  stepFlowingContoursRidge,
  type FlowingRidgeStepOptions,
} from './ridge'
import type {
  CorrectedFlowingRidgeSample,
  FlowingContoursDirectionalTrace,
  FlowingContoursEndpointReason,
  FlowingContoursField,
  FlowingContoursSpanSupportProvenance,
} from './types'

const VECTOR_EPSILON = 1e-12
const GAP_ALIGNMENT_FLOOR = 0.75
const MINIMUM_GROWTH_STEP_LENGTH = 0.125
const DEFAULT_RIDGE_STEP_LENGTH = 0.75
const DEFAULT_REPRESENTED_COLLISION_THRESHOLD = 0.7
const OVERLAP_TRAVERSAL_SPACING = 0.25
const MAXIMUM_OVERLAP_SAMPLES_PER_SEGMENT = 64
const DEFAULT_RIDGE_OPTIONS = Object.freeze({}) as FlowingRidgeStepOptions
const EMPTY_ALTERNATIVES =
  Object.freeze([]) as readonly Readonly<Point>[]

/**
 * A pure occupancy query returning represented coverage in `[0, 1]`.
 *
 * Growth calls it on the anchor and on a fixed, bounded set of samples along
 * each attempted segment. The maximum is collision policy; the bounded mean
 * contributes to beam ordering.
 */
export type FlowingContoursRepresentedOverlapSampler = (
  point: Readonly<Point>,
) => number

export interface FlowingContoursDirectionalGrowthOptions {
  /** Normalized authored control; changes weak travel allowance only. */
  readonly continuity: number
  /** Normalized authored control; changes objective curvature cost only. */
  readonly flowSmoothing: number
  /** FC07 policy, independent of Continuity and Flow smoothing. */
  readonly ridgeStepOptions?: Readonly<FlowingRidgeStepOptions>
  /**
   * Stable signed alternatives for the bounded beam. The primary requested
   * heading is first and alternatives must occupy the same signed half-plane.
   */
  readonly directionAlternatives?: readonly Readonly<Point>[]
  readonly representedOverlapSampler?: FlowingContoursRepresentedOverlapSampler
  readonly representedCollisionThreshold?: number
}

interface ResolvedOptions {
  readonly continuity: number
  readonly flowSmoothing: number
  readonly ridgeStepOptions: Readonly<FlowingRidgeStepOptions>
  readonly directions: readonly Readonly<Point>[]
  readonly representedOverlapSampler:
    | FlowingContoursRepresentedOverlapSampler
    | null
  readonly representedCollisionThreshold: number
}

interface PathNode {
  readonly previous: Readonly<PathNode> | null
  readonly sample: Readonly<CorrectedFlowingRidgeSample>
  readonly sampleIndex: number
}

interface SupportNode {
  readonly previous: Readonly<SupportNode> | null
  readonly span: Readonly<FlowingContoursSpanSupportProvenance>
  readonly count: number
}

interface IncrementalMetrics {
  readonly sampleCount: number
  readonly evidenceSum: number
  readonly ambiguitySum: number
  readonly segmentCount: number
  readonly coherenceSum: number
  readonly curvatureChangeSum: number
  readonly lastSegmentDirection: Readonly<Point> | null
  readonly lastSignedTurn: number | null
}

interface SearchState {
  readonly stableId: number
  readonly committedTail: Readonly<PathNode>
  readonly currentTail: Readonly<PathNode>
  readonly supportTail: Readonly<SupportNode> | null
  readonly committedMetrics: Readonly<IncrementalMetrics>
  readonly currentMetrics: Readonly<IncrementalMetrics>
  readonly travelDirection: Readonly<Point>
  readonly provisionalLength: number
  readonly provisionalMinimumAlignment: number
  readonly weakStepCount: number
  readonly committedLength: number
  readonly committedOverlapSum: number
  readonly committedOverlapCount: number
  readonly provisionalOverlapSum: number
  readonly provisionalOverlapCount: number
  readonly endpointReason: FlowingContoursEndpointReason | null
}

interface OverlapMeasurement {
  readonly maximum: number
  readonly sum: number
  readonly count: number
}

type RequiredGrowthLimit =
  | 'search-breadth'
  | 'search-step-count'
  | 'weak-span-step-count'
  | 'weak-span-distance'
  | 'raw-trajectory-point-count'

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

function aligned(
  tangent: Readonly<Point>,
  direction: Readonly<Point>,
): { readonly tangent: Readonly<Point>; readonly alignment: number } | null {
  const tangentUnit = unit(tangent)
  const directionUnit = unit(direction)
  if (tangentUnit === null || directionUnit === null) return null
  const sign =
    tangentUnit[0] * directionUnit[0] +
      tangentUnit[1] * directionUnit[1] <
    0
      ? -1
      : 1
  const signed = frozenPoint(tangentUnit[0] * sign, tangentUnit[1] * sign)
  return Object.freeze({
    tangent: signed,
    alignment: Math.max(
      -1,
      Math.min(
        1,
        signed[0] * directionUnit[0] + signed[1] * directionUnit[1],
      ),
    ),
  })
}

function snapshotSample(
  source: Readonly<CorrectedFlowingRidgeSample>,
  direction: Readonly<Point>,
): Readonly<CorrectedFlowingRidgeSample> | null {
  try {
    const point = frozenPoint(source.point[0], source.point[1])
    const tangent = aligned(source.tangent, direction)?.tangent
    if (
      tangent == null ||
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

function distance(
  first: Readonly<CorrectedFlowingRidgeSample>,
  second: Readonly<CorrectedFlowingRidgeSample>,
): number {
  return Math.hypot(
    second.point[0] - first.point[0],
    second.point[1] - first.point[1],
  )
}

function gapDirectionalAlignment(
  entry: Readonly<CorrectedFlowingRidgeSample>,
  sample: Readonly<CorrectedFlowingRidgeSample>,
): number {
  const displacement = unit([
    sample.point[0] - entry.point[0],
    sample.point[1] - entry.point[1],
  ])
  if (displacement === null) return -1
  return Math.min(
    entry.tangent[0] * sample.tangent[0] +
      entry.tangent[1] * sample.tangent[1],
    entry.tangent[0] * displacement[0] +
      entry.tangent[1] * displacement[1],
    sample.tangent[0] * displacement[0] +
      sample.tangent[1] * displacement[1],
  )
}

function limitValue(
  name: RequiredGrowthLimit,
  limits: Readonly<FlowingContoursLimits>,
): number | null {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(limits, name)
    if (
      descriptor === undefined ||
      !('value' in descriptor) ||
      !isWithinFlowingContoursLimit(name, descriptor.value, limits)
    ) {
      return null
    }
    return descriptor.value
  } catch {
    return null
  }
}

function explicitStepLength(
  ridgeOptions: Readonly<FlowingRidgeStepOptions>,
): number | null {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(
      ridgeOptions,
      'stepLength',
    )
    if (descriptor === undefined) return DEFAULT_RIDGE_STEP_LENGTH
    if (!('value' in descriptor)) return null
    const value = descriptor.value
    return typeof value === 'number' &&
      Number.isFinite(value) &&
      value >= MINIMUM_GROWTH_STEP_LENGTH
      ? value
      : null
  } catch {
    return null
  }
}

function directionKey(direction: Readonly<Point>): string {
  return `${direction[0]}|${direction[1]}`
}

function resolveOptions(
  requestedDirection: Readonly<Point>,
  options: Readonly<FlowingContoursDirectionalGrowthOptions>,
  limits: Readonly<FlowingContoursLimits>,
): ResolvedOptions | null {
  try {
    const primary = unit(requestedDirection)
    const breadth = limitValue('search-breadth', limits)
    if (
      primary === null ||
      breadth === null ||
      breadth < 1 ||
      !Number.isFinite(options.continuity) ||
      options.continuity < 0 ||
      options.continuity > 1 ||
      !Number.isFinite(options.flowSmoothing) ||
      options.flowSmoothing < 0 ||
      options.flowSmoothing > 1
    ) {
      return null
    }

    const suppliedAlternatives =
      options.directionAlternatives ?? EMPTY_ALTERNATIVES
    if (!Array.isArray(suppliedAlternatives)) return null
    const directions: Readonly<Point>[] = [primary]
    const seenDirections = new Set([directionKey(primary)])
    for (const alternative of suppliedAlternatives) {
      const candidate = unit(alternative)
      if (
        candidate === null ||
        candidate[0] * primary[0] + candidate[1] * primary[1] <=
          VECTOR_EPSILON
      ) {
        return null
      }
      const key = directionKey(candidate)
      if (!seenDirections.has(key)) {
        seenDirections.add(key)
        directions.push(candidate)
      }
    }
    if (directions.length > breadth) return null

    const ridgeSource = options.ridgeStepOptions ?? DEFAULT_RIDGE_OPTIONS
    if (explicitStepLength(ridgeSource) === null) return null
    const ridgeStepOptions =
      directions.length > 1
        ? Object.freeze({
            ...ridgeSource,
            predictorHeadingInfluence: 1,
          })
        : ridgeSource

    const sampler = options.representedOverlapSampler ?? null
    const threshold =
      options.representedCollisionThreshold ??
      DEFAULT_REPRESENTED_COLLISION_THRESHOLD
    if (
      (sampler !== null && typeof sampler !== 'function') ||
      !Number.isFinite(threshold) ||
      threshold < 0 ||
      threshold > 1
    ) {
      return null
    }

    return Object.freeze({
      continuity: options.continuity,
      flowSmoothing: options.flowSmoothing,
      ridgeStepOptions,
      directions: Object.freeze(directions),
      representedOverlapSampler: sampler,
      representedCollisionThreshold: threshold,
    })
  } catch {
    return null
  }
}

function sampleOverlap(
  sampler: FlowingContoursRepresentedOverlapSampler | null,
  point: Readonly<Point>,
): number | null {
  if (sampler === null) return 0
  try {
    const value = sampler(point)
    return Number.isFinite(value) && value >= 0 && value <= 1 ? value : null
  } catch {
    return null
  }
}

function overlapAlongSegment(
  sampler: FlowingContoursRepresentedOverlapSampler | null,
  start: Readonly<Point>,
  end: Readonly<Point>,
): Readonly<OverlapMeasurement> | null {
  if (sampler === null) return Object.freeze({ maximum: 0, sum: 0, count: 0 })
  const dx = end[0] - start[0]
  const dy = end[1] - start[1]
  const segmentLength = Math.hypot(dx, dy)
  if (!Number.isFinite(segmentLength) || segmentLength <= VECTOR_EPSILON) {
    return null
  }

  const parameters: number[] = []
  const intervalCount = Math.max(
    1,
    Math.ceil(segmentLength / OVERLAP_TRAVERSAL_SPACING),
  )
  for (let index = 1; index <= intervalCount; index += 1) {
    parameters.push(index / intervalCount)
  }
  if (Math.abs(dx) > VECTOR_EPSILON) {
    for (
      let x = Math.ceil(Math.min(start[0], end[0]));
      x <= Math.floor(Math.max(start[0], end[0]));
      x += 1
    ) {
      parameters.push((x - start[0]) / dx)
    }
  }
  if (Math.abs(dy) > VECTOR_EPSILON) {
    for (
      let y = Math.ceil(Math.min(start[1], end[1]));
      y <= Math.floor(Math.max(start[1], end[1]));
      y += 1
    ) {
      parameters.push((y - start[1]) / dy)
    }
  }
  if (parameters.length > MAXIMUM_OVERLAP_SAMPLES_PER_SEGMENT) return null

  parameters.sort((left, right) => left - right)
  let previous = Number.NEGATIVE_INFINITY
  let maximum = 0
  let sum = 0
  let count = 0
  for (const parameter of parameters) {
    if (
      !Number.isFinite(parameter) ||
      parameter <= 0 ||
      parameter > 1 ||
      Math.abs(parameter - previous) <= VECTOR_EPSILON
    ) {
      continue
    }
    previous = parameter
    const value = sampleOverlap(
      sampler,
      frozenPoint(start[0] + dx * parameter, start[1] + dy * parameter),
    )
    if (value === null) return null
    maximum = Math.max(maximum, value)
    sum += value
    count += 1
  }
  return Object.freeze({ maximum, sum, count })
}

function wrapSignedRadians(value: number): number {
  let wrapped = value
  while (wrapped <= -Math.PI) wrapped += 2 * Math.PI
  while (wrapped > Math.PI) wrapped -= 2 * Math.PI
  return wrapped
}

function signedTurn(
  first: Readonly<Point>,
  second: Readonly<Point>,
): number {
  return Math.atan2(
    first[0] * second[1] - first[1] * second[0],
    first[0] * second[0] + first[1] * second[1],
  )
}

function rootMetrics(
  sample: Readonly<CorrectedFlowingRidgeSample>,
): Readonly<IncrementalMetrics> {
  return Object.freeze({
    sampleCount: 1,
    evidenceSum: sample.evidence,
    ambiguitySum: sample.ambiguity,
    segmentCount: 0,
    coherenceSum: 0,
    curvatureChangeSum: 0,
    lastSegmentDirection: null,
    lastSignedTurn: null,
  })
}

function extendMetrics(
  metrics: Readonly<IncrementalMetrics>,
  previous: Readonly<CorrectedFlowingRidgeSample>,
  sample: Readonly<CorrectedFlowingRidgeSample>,
): Readonly<IncrementalMetrics> | null {
  const segmentDirection = unit([
    sample.point[0] - previous.point[0],
    sample.point[1] - previous.point[1],
  ])
  if (segmentDirection === null) return null
  const turn =
    metrics.lastSegmentDirection === null
      ? null
      : signedTurn(metrics.lastSegmentDirection, segmentDirection)
  const curvatureChange =
    turn === null || metrics.lastSignedTurn === null
      ? 0
      : Math.abs(wrapSignedRadians(turn - metrics.lastSignedTurn)) / Math.PI
  const tangentAlignment = Math.max(
    0,
    Math.min(
      1,
      previous.tangent[0] * sample.tangent[0] +
        previous.tangent[1] * sample.tangent[1],
    ),
  )
  return Object.freeze({
    sampleCount: metrics.sampleCount + 1,
    evidenceSum: metrics.evidenceSum + sample.evidence,
    ambiguitySum: metrics.ambiguitySum + sample.ambiguity,
    segmentCount: metrics.segmentCount + 1,
    coherenceSum: metrics.coherenceSum + tangentAlignment,
    curvatureChangeSum: metrics.curvatureChangeSum + curvatureChange,
    lastSegmentDirection: segmentDirection,
    lastSignedTurn: turn,
  })
}

/** Signed-turn curvature-change measurement shared with focused witnesses. */
export function measureFlowingContoursCurvatureChange(
  points: readonly Readonly<Point>[],
): number {
  try {
    let previousDirection: Readonly<Point> | null = null
    let previousTurn: number | null = null
    let total = 0
    for (let index = 1; index < points.length; index += 1) {
      const first = points[index - 1]!
      const second = points[index]!
      const direction = unit([second[0] - first[0], second[1] - first[1]])
      if (direction === null) return 1
      if (previousDirection !== null) {
        const turn = signedTurn(previousDirection, direction)
        if (previousTurn !== null) {
          total += Math.abs(wrapSignedRadians(turn - previousTurn)) / Math.PI
        }
        previousTurn = turn
      }
      previousDirection = direction
    }
    return Number.isFinite(total) ? total : 1
  } catch {
    return 1
  }
}

function appendPathNode(
  previous: Readonly<PathNode>,
  sample: Readonly<CorrectedFlowingRidgeSample>,
): Readonly<PathNode> {
  return Object.freeze({
    previous,
    sample,
    sampleIndex: previous.sampleIndex + 1,
  })
}

function appendDirectSupport(
  tail: Readonly<SupportNode> | null,
  samplesBeforeAppend: number,
  entry: Readonly<CorrectedFlowingRidgeSample>,
  exit: Readonly<CorrectedFlowingRidgeSample>,
  segmentLength: number,
  alignment: number,
): Readonly<SupportNode> {
  if (
    tail?.span.kind === 'direct-evidence' &&
    tail.span.endSampleIndex === samplesBeforeAppend - 1
  ) {
    return Object.freeze({
      previous: tail.previous,
      count: tail.count,
      span: Object.freeze({
        ...tail.span,
        endSampleIndex: samplesBeforeAppend,
        length: tail.span.length + segmentLength,
        exitEvidence: exit.evidence,
        directionalAlignment: Math.min(
          tail.span.directionalAlignment,
          alignment,
        ),
      }),
    })
  }
  return Object.freeze({
    previous: tail,
    count: (tail?.count ?? 0) + 1,
    span: Object.freeze({
      kind: 'direct-evidence',
      startSampleIndex: samplesBeforeAppend - 1,
      endSampleIndex: samplesBeforeAppend,
      length: segmentLength,
      entryEvidence: entry.evidence,
      exitEvidence: exit.evidence,
      directionalAlignment: alignment,
    }),
  })
}

function appendGapSupport(
  tail: Readonly<SupportNode> | null,
  startSampleIndex: number,
  endSampleIndex: number,
  length: number,
  entryEvidence: number,
  exitEvidence: number,
  directionalAlignment: number,
): Readonly<SupportNode> {
  return Object.freeze({
    previous: tail,
    count: (tail?.count ?? 0) + 1,
    span: Object.freeze({
      kind: 'bounded-gap',
      startSampleIndex,
      endSampleIndex,
      length,
      entryEvidence,
      exitEvidence,
      directionalAlignment,
    }),
  })
}

function prefixOrderKey(
  state: Readonly<SearchState>,
  field: Readonly<FlowingContoursField>,
  flowSmoothing: number,
): Readonly<FlowingContoursObjectiveOrderKey> {
  const metrics = state.currentMetrics
  const diagonal = Math.max(1, Math.hypot(field.width, field.height))
  const overlapSum =
    state.committedOverlapSum + state.provisionalOverlapSum
  const overlapCount =
    state.committedOverlapCount + state.provisionalOverlapCount
  return Object.freeze({
    score: scoreFlowingContoursCandidate(
      {
        accumulatedEvidence:
          metrics.evidenceSum / Math.max(1, metrics.sampleCount),
        usefulLength:
          (state.committedLength + state.provisionalLength) / diagonal,
        directionalCoherence:
          metrics.coherenceSum / Math.max(1, metrics.segmentCount),
        curvatureChange:
          metrics.curvatureChangeSum / Math.max(1, metrics.segmentCount),
        unsupportedTravel: state.provisionalLength / diagonal,
        ambiguity:
          metrics.ambiguitySum / Math.max(1, metrics.sampleCount),
        representedOverlap: overlapSum / Math.max(1, overlapCount),
      },
      flowSmoothing,
    ),
    stableId: state.stableId,
    sampleIndex: state.currentTail.sampleIndex,
    point: state.currentTail.sample.point,
  })
}

function orderStates(
  first: Readonly<SearchState>,
  second: Readonly<SearchState>,
  field: Readonly<FlowingContoursField>,
  flowSmoothing: number,
): number {
  return compareFlowingContoursObjectiveOrder(
    prefixOrderKey(first, field, flowSmoothing),
    prefixOrderKey(second, field, flowSmoothing),
  )
}

function stopped(
  state: Readonly<SearchState>,
  reason: FlowingContoursEndpointReason,
): SearchState {
  return {
    ...state,
    currentTail: state.committedTail,
    currentMetrics: state.committedMetrics,
    travelDirection: state.committedTail.sample.tangent,
    provisionalLength: 0,
    provisionalMinimumAlignment: 1,
    weakStepCount: 0,
    provisionalOverlapSum: 0,
    provisionalOverlapCount: 0,
    endpointReason: reason,
  }
}

function samePoint(
  first: Readonly<Point> | null,
  second: Readonly<Point> | null,
): boolean {
  if (first === null || second === null) return first === second
  return Object.is(first[0], second[0]) && Object.is(first[1], second[1])
}

function sameSample(
  first: Readonly<CorrectedFlowingRidgeSample>,
  second: Readonly<CorrectedFlowingRidgeSample>,
): boolean {
  return (
    samePoint(first.point, second.point) &&
    samePoint(first.tangent, second.tangent) &&
    Object.is(first.evidence, second.evidence) &&
    Object.is(first.coherence, second.coherence) &&
    Object.is(first.ambiguity, second.ambiguity) &&
    Object.is(first.scale, second.scale) &&
    Object.is(first.alpha, second.alpha)
  )
}

function sameMetrics(
  first: Readonly<IncrementalMetrics>,
  second: Readonly<IncrementalMetrics>,
): boolean {
  return (
    first.sampleCount === second.sampleCount &&
    first.segmentCount === second.segmentCount &&
    Object.is(first.evidenceSum, second.evidenceSum) &&
    Object.is(first.ambiguitySum, second.ambiguitySum) &&
    Object.is(first.coherenceSum, second.coherenceSum) &&
    Object.is(first.curvatureChangeSum, second.curvatureChangeSum) &&
    samePoint(first.lastSegmentDirection, second.lastSegmentDirection) &&
    Object.is(first.lastSignedTurn, second.lastSignedTurn)
  )
}

function sameSupportTail(
  first: Readonly<SupportNode> | null,
  second: Readonly<SupportNode> | null,
): boolean {
  if (first === null || second === null) return first === second
  const firstSpan = first.span
  const secondSpan = second.span
  return (
    first.previous === second.previous &&
    first.count === second.count &&
    firstSpan.kind === secondSpan.kind &&
    firstSpan.startSampleIndex === secondSpan.startSampleIndex &&
    firstSpan.endSampleIndex === secondSpan.endSampleIndex &&
    Object.is(firstSpan.length, secondSpan.length) &&
    Object.is(firstSpan.entryEvidence, secondSpan.entryEvidence) &&
    Object.is(firstSpan.exitEvidence, secondSpan.exitEvidence) &&
    Object.is(
      firstSpan.directionalAlignment,
      secondSpan.directionalAlignment,
    )
  )
}

function areEquivalentSiblingSuccessors(
  first: Readonly<SearchState>,
  second: Readonly<SearchState>,
): boolean {
  const firstCommitted = first.committedTail === first.currentTail
  const secondCommitted = second.committedTail === second.currentTail
  return (
    first.currentTail.previous === second.currentTail.previous &&
    firstCommitted === secondCommitted &&
    (firstCommitted || first.committedTail === second.committedTail) &&
    first.currentTail.sampleIndex === second.currentTail.sampleIndex &&
    sameSample(first.currentTail.sample, second.currentTail.sample) &&
    sameSupportTail(first.supportTail, second.supportTail) &&
    sameMetrics(first.committedMetrics, second.committedMetrics) &&
    sameMetrics(first.currentMetrics, second.currentMetrics) &&
    samePoint(first.travelDirection, second.travelDirection) &&
    Object.is(first.provisionalLength, second.provisionalLength) &&
    Object.is(
      first.provisionalMinimumAlignment,
      second.provisionalMinimumAlignment,
    ) &&
    first.weakStepCount === second.weakStepCount &&
    Object.is(first.committedLength, second.committedLength) &&
    Object.is(first.committedOverlapSum, second.committedOverlapSum) &&
    first.committedOverlapCount === second.committedOverlapCount &&
    Object.is(first.provisionalOverlapSum, second.provisionalOverlapSum) &&
    first.provisionalOverlapCount === second.provisionalOverlapCount &&
    first.endpointReason === second.endpointReason
  )
}

function dedupeStates(
  states: readonly Readonly<SearchState>[],
  field: Readonly<FlowingContoursField>,
  flowSmoothing: number,
): SearchState[] {
  const siblingGroups = new Map<
    Readonly<PathNode>,
    SearchState[]
  >()
  for (const state of states) {
    const predecessor = state.currentTail.previous
    if (predecessor === null) {
      // Successful successors always have a predecessor. Preserve an
      // unexpected root defensively rather than merging unrelated history.
      siblingGroups.set(state.currentTail, [state])
      continue
    }
    const siblings = siblingGroups.get(predecessor)
    if (siblings === undefined) {
      siblingGroups.set(predecessor, [state])
      continue
    }
    const equivalentIndex = siblings.findIndex((candidate) =>
      areEquivalentSiblingSuccessors(candidate, state),
    )
    if (equivalentIndex < 0) {
      siblings.push(state)
      continue
    }
    const equivalent = siblings[equivalentIndex]!
    if (orderStates(state, equivalent, field, flowSmoothing) < 0) {
      siblings[equivalentIndex] = state
    }
  }
  return [...siblingGroups.values()].flat()
}

function materializeSamples(
  tail: Readonly<PathNode>,
): readonly Readonly<CorrectedFlowingRidgeSample>[] {
  const samples = new Array<Readonly<CorrectedFlowingRidgeSample>>(
    tail.sampleIndex + 1,
  )
  let node: Readonly<PathNode> | null = tail
  while (node !== null) {
    samples[node.sampleIndex] = node.sample
    node = node.previous
  }
  return Object.freeze(samples)
}

function materializeSupport(
  tail: Readonly<SupportNode> | null,
): readonly Readonly<FlowingContoursSpanSupportProvenance>[] {
  if (tail === null) return Object.freeze([])
  const spans = new Array<
    Readonly<FlowingContoursSpanSupportProvenance>
  >(tail.count)
  let node: Readonly<SupportNode> | null = tail
  for (let index = tail.count - 1; index >= 0 && node !== null; index -= 1) {
    spans[index] = node.span
    node = node.previous
  }
  return Object.freeze(spans)
}

function freezeTrace(
  direction: 'forward' | 'backward',
  state: Readonly<SearchState> | null,
  searchStepCount: number,
  fallbackSamples: readonly Readonly<CorrectedFlowingRidgeSample>[],
): Readonly<FlowingContoursDirectionalTrace> {
  return Object.freeze({
    direction: direction === 'backward' ? 'backward' : 'forward',
    samples:
      state === null
        ? Object.freeze([...fallbackSamples])
        : materializeSamples(state.committedTail),
    spanSupport:
      state === null
        ? Object.freeze([])
        : materializeSupport(state.supportTail),
    endpointReason: state?.endpointReason ?? 'safety-limit',
    searchStepCount,
  })
}

/**
 * Grow one signed trace from `start`.
 *
 * `searchStepCount` is actual FC07 invocations across the beam, including
 * attempts later deduplicated or rolled back. The start sample appears once in
 * every valid trace.
 */
export function growFlowingContoursDirection(
  field: Readonly<FlowingContoursField>,
  start: Readonly<CorrectedFlowingRidgeSample>,
  requestedDirection: Readonly<Point>,
  direction: 'forward' | 'backward',
  options: Readonly<FlowingContoursDirectionalGrowthOptions>,
  limits: Readonly<FlowingContoursLimits> = FLOWING_CONTOURS_LIMITS,
): Readonly<FlowingContoursDirectionalTrace> {
  const initialDirection = unit(requestedDirection)
  const anchor =
    initialDirection === null ? null : snapshotSample(start, initialDirection)
  const fallbackSamples =
    anchor === null
      ? Object.freeze([])
      : Object.freeze([anchor])

  try {
    const resolved = resolveOptions(requestedDirection, options, limits)
    const searchStepLimit = limitValue('search-step-count', limits)
    const weakStepLimit = limitValue('weak-span-step-count', limits)
    const weakDistanceLimit = limitValue('weak-span-distance', limits)
    const rawPointLimit = limitValue(
      'raw-trajectory-point-count',
      limits,
    )
    if (
      (direction !== 'forward' && direction !== 'backward') ||
      anchor === null ||
      resolved === null ||
      searchStepLimit === null ||
      weakStepLimit === null ||
      weakDistanceLimit === null ||
      rawPointLimit === null ||
      rawPointLimit < 1
    ) {
      return freezeTrace(direction, null, 0, fallbackSamples)
    }

    const anchorOverlap = sampleOverlap(
      resolved.representedOverlapSampler,
      anchor.point,
    )
    if (anchorOverlap === null) {
      return freezeTrace(direction, null, 0, fallbackSamples)
    }
    const anchorNode: Readonly<PathNode> = Object.freeze({
      previous: null,
      sample: anchor,
      sampleIndex: 0,
    })
    const metrics = rootMetrics(anchor)
    const initialState = (
      travelDirection: Readonly<Point>,
      stableId: number,
      endpointReason: FlowingContoursEndpointReason | null,
    ): SearchState => ({
      stableId,
      committedTail: anchorNode,
      currentTail: anchorNode,
      supportTail: null,
      committedMetrics: metrics,
      currentMetrics: metrics,
      travelDirection,
      provisionalLength: 0,
      provisionalMinimumAlignment: 1,
      weakStepCount: 0,
      committedLength: 0,
      committedOverlapSum: anchorOverlap,
      committedOverlapCount: 1,
      provisionalOverlapSum: 0,
      provisionalOverlapCount: 0,
      endpointReason,
    })
    if (anchorOverlap >= resolved.representedCollisionThreshold) {
      return freezeTrace(
        direction,
        initialState(
          resolved.directions[0]!,
          0,
          'represented-collision',
        ),
        0,
        fallbackSamples,
      )
    }

    const allowedWeakSteps = Math.min(
      weakStepLimit,
      Math.floor(
        resolved.continuity *
          FLOWING_CONTOURS_LIMITS['weak-span-step-count'],
      ),
    )
    const allowedWeakDistance = Math.min(
      weakDistanceLimit,
      resolved.continuity *
        FLOWING_CONTOURS_LIMITS['weak-span-distance'],
    )
    const breadth = limitValue('search-breadth', limits)!
    let active = resolved.directions.map((travelDirection, stableId) =>
      initialState(travelDirection, stableId, null),
    )
    const terminal: SearchState[] = []
    let searchStepCount = 0

    while (active.length > 0) {
      const next: SearchState[] = []
      for (let activeIndex = 0; activeIndex < active.length; activeIndex += 1) {
        const state = active[activeIndex]!
        if (
          searchStepCount >= searchStepLimit ||
          state.currentTail.sampleIndex + 1 >= rawPointLimit
        ) {
          terminal.push(stopped(state, 'safety-limit'))
          if (searchStepCount >= searchStepLimit) {
            for (
              let remainder = activeIndex + 1;
              remainder < active.length;
              remainder += 1
            ) {
              terminal.push(stopped(active[remainder]!, 'safety-limit'))
            }
            break
          }
          continue
        }

        const step = stepFlowingContoursRidge(
          field,
          state.currentTail.sample,
          state.travelDirection,
          resolved.ridgeStepOptions,
          limits,
        )
        searchStepCount += 1
        if (step.kind !== 'corrected' && step.kind !== 'weak') {
          terminal.push(stopped(state, step.kind))
          continue
        }
        if (step.sample === null) {
          terminal.push(stopped(state, 'evidence-exhausted'))
          continue
        }
        const sample = snapshotSample(
          step.sample,
          state.travelDirection,
        )
        if (sample === null) {
          terminal.push(stopped(state, 'safety-limit'))
          continue
        }
        const previousSample = state.currentTail.sample
        const sampleAlignment = aligned(
          sample.tangent,
          state.travelDirection,
        )?.alignment
        const segmentLength = distance(previousSample, sample)
        const nextMetrics = extendMetrics(
          state.currentMetrics,
          previousSample,
          sample,
        )
        if (
          sampleAlignment === undefined ||
          !Number.isFinite(segmentLength) ||
          segmentLength <= VECTOR_EPSILON ||
          nextMetrics === null
        ) {
          terminal.push(stopped(state, 'safety-limit'))
          continue
        }
        const overlap = overlapAlongSegment(
          resolved.representedOverlapSampler,
          previousSample.point,
          sample.point,
        )
        if (overlap === null) {
          terminal.push(stopped(state, 'safety-limit'))
          continue
        }
        if (overlap.maximum >= resolved.representedCollisionThreshold) {
          terminal.push(stopped(state, 'represented-collision'))
          continue
        }
        const nextTail = appendPathNode(state.currentTail, sample)

        if (step.kind === 'weak') {
          const weakStepCount = state.weakStepCount + 1
          const provisionalLength =
            state.provisionalLength + segmentLength
          const gapAlignment = Math.min(
            sampleAlignment,
            gapDirectionalAlignment(state.committedTail.sample, sample),
          )
          if (
            gapAlignment < GAP_ALIGNMENT_FLOOR ||
            weakStepCount > allowedWeakSteps ||
            provisionalLength > allowedWeakDistance
          ) {
            terminal.push(stopped(state, 'evidence-exhausted'))
            continue
          }
          next.push({
            ...state,
            currentTail: nextTail,
            currentMetrics: nextMetrics,
            travelDirection: sample.tangent,
            provisionalLength,
            provisionalMinimumAlignment: Math.min(
              state.provisionalMinimumAlignment,
              gapAlignment,
            ),
            weakStepCount,
            provisionalOverlapSum:
              state.provisionalOverlapSum + overlap.sum,
            provisionalOverlapCount:
              state.provisionalOverlapCount + overlap.count,
          })
          continue
        }

        if (state.weakStepCount > 0) {
          const gapLength = state.provisionalLength + segmentLength
          const gapAlignment = Math.min(
            state.provisionalMinimumAlignment,
            sampleAlignment,
            gapDirectionalAlignment(state.committedTail.sample, sample),
          )
          if (
            gapAlignment < GAP_ALIGNMENT_FLOOR ||
            gapLength > allowedWeakDistance
          ) {
            terminal.push(stopped(state, 'evidence-exhausted'))
            continue
          }
          const committedOverlapSum =
            state.committedOverlapSum +
            state.provisionalOverlapSum +
            overlap.sum
          const committedOverlapCount =
            state.committedOverlapCount +
            state.provisionalOverlapCount +
            overlap.count
          next.push({
            ...state,
            committedTail: nextTail,
            currentTail: nextTail,
            supportTail: appendGapSupport(
              state.supportTail,
              state.committedTail.sampleIndex,
              nextTail.sampleIndex,
              gapLength,
              state.committedTail.sample.evidence,
              sample.evidence,
              gapAlignment,
            ),
            committedMetrics: nextMetrics,
            currentMetrics: nextMetrics,
            travelDirection: sample.tangent,
            provisionalLength: 0,
            provisionalMinimumAlignment: 1,
            weakStepCount: 0,
            committedLength: state.committedLength + gapLength,
            committedOverlapSum,
            committedOverlapCount,
            provisionalOverlapSum: 0,
            provisionalOverlapCount: 0,
          })
          continue
        }

        next.push({
          ...state,
          committedTail: nextTail,
          currentTail: nextTail,
          supportTail: appendDirectSupport(
            state.supportTail,
            nextTail.sampleIndex,
            previousSample,
            sample,
            segmentLength,
            sampleAlignment,
          ),
          committedMetrics: nextMetrics,
          currentMetrics: nextMetrics,
          travelDirection: sample.tangent,
          committedLength: state.committedLength + segmentLength,
          committedOverlapSum: state.committedOverlapSum + overlap.sum,
          committedOverlapCount:
            state.committedOverlapCount + overlap.count,
        })
      }

      if (searchStepCount >= searchStepLimit && next.length > 0) {
        terminal.push(
          ...next.map((state) => stopped(state, 'safety-limit')),
        )
        active = []
      } else {
        active = dedupeStates(
          next,
          field,
          resolved.flowSmoothing,
        )
          .sort((first, second) =>
            orderStates(
              first,
              second,
              field,
              resolved.flowSmoothing,
            ),
          )
          .slice(0, breadth)
      }
    }

    const best = terminal.sort((first, second) =>
      orderStates(first, second, field, resolved.flowSmoothing),
    )[0]
    return freezeTrace(
      direction,
      best ?? null,
      searchStepCount,
      fallbackSamples,
    )
  } catch {
    return freezeTrace(direction, null, 0, fallbackSamples)
  }
}
