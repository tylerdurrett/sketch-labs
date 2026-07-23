/**
 * Accepted-geometry occupancy for Flowing Contours.
 *
 * Suppression follows continuous accepted ridge geometry rather than raster
 * cells. A deliberately sub-ridge ownership radius removes repeat searches on
 * the same ridge while preserving a nearby parallel ridge. Tangent agreement
 * narrows that ownership still further; a crossing is represented only in a
 * small core around the shared point.
 */

import type { Point } from '../../types'
import { sampleFlowingContoursField } from './field'
import {
  FLOWING_CONTOURS_LIMITS,
  isWithinFlowingContoursLimit,
  type FlowingContoursLimits,
} from './limits'
import {
  FLOWING_CONTOURS_ENDPOINT_REASONS,
  type AcceptedFlowingTrajectory,
  type CorrectedFlowingRidgeSample,
  type FlowingContoursAnchor,
  type FlowingContoursEndpointReason,
  type FlowingContoursField,
} from './types'

const VECTOR_EPSILON = 1e-12
const VALUE_TOLERANCE = 1e-8
const OCCUPANCY_SAMPLE_SPACING = 0.25
const OWNERSHIP_RADIUS = 0.55
const CROSSING_CORE_RADIUS = 0.16
const TANGENT_ALIGNMENT_FLOOR = 0.8
const ANCHOR_SUPPRESSION_THRESHOLD = 0.7
const EVIDENCE_SUPPRESSION_THRESHOLD = 0.35
const SPATIAL_CELL_SIZE = OWNERSHIP_RADIUS

export interface FlowingContoursSuppressionOptions {
  readonly field: Readonly<FlowingContoursField>
  readonly limits?: Readonly<FlowingContoursLimits>
}

/**
 * Immutable public snapshot.
 *
 * `field` is intentionally retained by identity: occupancy from an equivalent
 * looking but different analysis field is not reusable.
 */
export interface FlowingContoursSuppressionState {
  readonly field: Readonly<FlowingContoursField>
  readonly sourceWidth: number
  readonly sourceHeight: number
  readonly width: number
  readonly height: number
  readonly occupancySampleCount: number
  readonly suppressedEvidenceSampleCount: number
}

export type FlowingContoursSuppressionCommitResult =
  | {
      readonly kind: 'committed'
      readonly state: Readonly<FlowingContoursSuppressionState>
      /** Newly represented evidence samples in this transaction. */
      readonly suppressedEvidenceSampleCount: number
    }
  | {
      readonly kind: 'rejected'
      readonly reason: 'invalid-input' | 'field-mismatch' | 'occupancy-limit'
    }

interface OccupancySample {
  readonly point: Readonly<Point>
  readonly tangent: Readonly<Point>
}

interface SuppressionData {
  readonly field: Readonly<FlowingContoursField>
  readonly occupancy: readonly Readonly<OccupancySample>[]
  readonly spatialIndex: ReadonlyMap<string, readonly number[]>
  readonly suppressedEvidence: ReadonlySet<number>
  readonly occupancyLimit: number
  readonly rawTrajectoryPointLimit: number
}

type SuppressionQuery = Readonly<Point> | Readonly<CorrectedFlowingRidgeSample>

const STATE_DATA = new WeakMap<
  Readonly<FlowingContoursSuppressionState>,
  Readonly<SuppressionData>
>()

const ENDPOINT_REASONS: ReadonlySet<FlowingContoursEndpointReason> = new Set(
  FLOWING_CONTOURS_ENDPOINT_REASONS,
)

function ownDataValue(
  source: object,
  key: PropertyKey,
): unknown | typeof MISSING {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(source, key)
    return descriptor !== undefined && 'value' in descriptor
      ? descriptor.value
      : MISSING
  } catch {
    return MISSING
  }
}

const MISSING = Symbol('missing')

function finiteUnit(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= 1
  )
}

function finitePositive(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

function sameNumber(first: number, second: number): boolean {
  return Math.abs(first - second) <= VALUE_TOLERANCE
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
    let normalizedX = x / length
    let normalizedY = y / length
    // Occupancy owns an undirected ridge, so canonicalize tangent sign.
    if (
      normalizedY < 0 ||
      (Math.abs(normalizedY) <= VECTOR_EPSILON && normalizedX < 0)
    ) {
      normalizedX = -normalizedX
      normalizedY = -normalizedY
    }
    return frozenPoint(normalizedX, normalizedY)
  } catch {
    return null
  }
}

function fieldShapeIsValid(field: Readonly<FlowingContoursField>): boolean {
  try {
    const dimensions = [
      field.sourceWidth,
      field.sourceHeight,
      field.width,
      field.height,
    ]
    if (
      dimensions.some((value) => !Number.isSafeInteger(value) || value <= 0) ||
      Math.max(field.width, field.height) >
        FLOWING_CONTOURS_LIMITS['analysis-dimension']
    ) {
      return false
    }
    const sampleCount = field.width * field.height
    const scalarChannels = [
      field.luminance,
      field.alpha,
      field.contourEvidence,
      field.tangentX,
      field.tangentY,
      field.tangentCoherence,
      field.ambiguity,
      field.ridgeScale,
    ]
    if (
      !Number.isSafeInteger(sampleCount) ||
      sampleCount > FLOWING_CONTOURS_LIMITS['analysis-sample-count'] ||
      scalarChannels.some(
        (channel) =>
          !Array.isArray(channel) ||
          channel.length !== sampleCount ||
          !Object.isFrozen(channel),
      ) ||
      !Array.isArray(field.positiveSupport) ||
      field.positiveSupport.length !== sampleCount ||
      !Object.isFrozen(field.positiveSupport) ||
      !Object.isFrozen(field)
    ) {
      return false
    }

    for (let index = 0; index < sampleCount; index += 1) {
      const alpha = field.alpha[index]
      const evidence = field.contourEvidence[index]
      const coherence = field.tangentCoherence[index]
      const ambiguity = field.ambiguity[index]
      const luminance = field.luminance[index]
      const scale = field.ridgeScale[index]
      const tangentX = field.tangentX[index]
      const tangentY = field.tangentY[index]
      const support = field.positiveSupport[index]
      const tangentLength = Math.hypot(tangentX!, tangentY!)
      if (
        !finiteUnit(alpha) ||
        !finiteUnit(evidence) ||
        !finiteUnit(coherence) ||
        !finiteUnit(ambiguity) ||
        !finiteUnit(luminance) ||
        typeof scale !== 'number' ||
        !Number.isFinite(scale) ||
        scale < 0 ||
        typeof tangentX !== 'number' ||
        !Number.isFinite(tangentX) ||
        typeof tangentY !== 'number' ||
        !Number.isFinite(tangentY) ||
        !Number.isFinite(tangentLength) ||
        (evidence! > 0 && Math.abs(tangentLength - 1) > VALUE_TOLERANCE) ||
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

function resolveLimits(source: Readonly<FlowingContoursLimits>): {
  readonly occupancyLimit: number
  readonly rawTrajectoryPointLimit: number
} | null {
  const occupancyLimit = ownDataValue(source, 'analysis-sample-count')
  const rawTrajectoryPointLimit = ownDataValue(
    source,
    'raw-trajectory-point-count',
  )
  return typeof occupancyLimit === 'number' &&
    isWithinFlowingContoursLimit(
      'analysis-sample-count',
      occupancyLimit,
      source,
    ) &&
    typeof rawTrajectoryPointLimit === 'number' &&
    isWithinFlowingContoursLimit(
      'raw-trajectory-point-count',
      rawTrajectoryPointLimit,
      source,
    )
    ? Object.freeze({ occupancyLimit, rawTrajectoryPointLimit })
    : null
}

function spatialKey(x: number, y: number): string {
  return `${x},${y}`
}

function sampleCell(point: Readonly<Point>): readonly [number, number] {
  return [
    Math.floor(point[0] / SPATIAL_CELL_SIZE),
    Math.floor(point[1] / SPATIAL_CELL_SIZE),
  ]
}

function buildSpatialIndex(
  occupancy: readonly Readonly<OccupancySample>[],
): ReadonlyMap<string, readonly number[]> {
  const mutable = new Map<string, number[]>()
  for (let index = 0; index < occupancy.length; index += 1) {
    const [x, y] = sampleCell(occupancy[index]!.point)
    const key = spatialKey(x, y)
    const bucket = mutable.get(key)
    if (bucket === undefined) mutable.set(key, [index])
    else bucket.push(index)
  }
  const frozen = new Map<string, readonly number[]>()
  for (const [key, indices] of mutable) {
    frozen.set(key, Object.freeze(indices))
  }
  return frozen
}

function createState(
  data: Readonly<SuppressionData>,
): Readonly<FlowingContoursSuppressionState> {
  const state: Readonly<FlowingContoursSuppressionState> = Object.freeze({
    field: data.field,
    sourceWidth: data.field.sourceWidth,
    sourceHeight: data.field.sourceHeight,
    width: data.field.width,
    height: data.field.height,
    occupancySampleCount: data.occupancy.length,
    suppressedEvidenceSampleCount: data.suppressedEvidence.size,
  })
  STATE_DATA.set(state, data)
  return state
}

function stateData(
  state: Readonly<FlowingContoursSuppressionState>,
): Readonly<SuppressionData> | null {
  try {
    const data = STATE_DATA.get(state)
    return data !== undefined &&
      Object.isFrozen(state) &&
      state.field === data.field &&
      state.sourceWidth === data.field.sourceWidth &&
      state.sourceHeight === data.field.sourceHeight &&
      state.width === data.field.width &&
      state.height === data.field.height &&
      state.occupancySampleCount === data.occupancy.length &&
      state.suppressedEvidenceSampleCount === data.suppressedEvidence.size
      ? data
      : null
  } catch {
    return null
  }
}

/** Create empty occupancy bound to exactly one immutable analysis field. */
export function createFlowingContoursSuppressionState(
  options: Readonly<FlowingContoursSuppressionOptions>,
): Readonly<FlowingContoursSuppressionState> | null {
  try {
    if (typeof options !== 'object' || options === null) return null
    const field = ownDataValue(options, 'field')
    const suppliedLimits = ownDataValue(options, 'limits')
    const limits =
      suppliedLimits === MISSING || suppliedLimits === undefined
        ? FLOWING_CONTOURS_LIMITS
        : suppliedLimits
    if (
      typeof field !== 'object' ||
      field === null ||
      !fieldShapeIsValid(field as Readonly<FlowingContoursField>) ||
      typeof limits !== 'object' ||
      limits === null
    ) {
      return null
    }
    const resolved = resolveLimits(limits as Readonly<FlowingContoursLimits>)
    if (resolved === null) return null
    const occupancy = Object.freeze([] as Readonly<OccupancySample>[])
    const data: Readonly<SuppressionData> = Object.freeze({
      field: field as Readonly<FlowingContoursField>,
      occupancy,
      spatialIndex: buildSpatialIndex(occupancy),
      suppressedEvidence: new Set<number>(),
      occupancyLimit: resolved.occupancyLimit,
      rawTrajectoryPointLimit: resolved.rawTrajectoryPointLimit,
    })
    return createState(data)
  } catch {
    return null
  }
}

function pointQuery(
  query: SuppressionQuery,
  explicitTangent?: Readonly<Point>,
): {
  readonly point: Readonly<Point>
  readonly tangent: Readonly<Point> | null
  readonly sample: Readonly<CorrectedFlowingRidgeSample> | null
} | null {
  try {
    if (Array.isArray(query)) {
      if (
        query.length !== 2 ||
        !Number.isFinite(query[0]) ||
        !Number.isFinite(query[1])
      ) {
        return null
      }
      const tangent =
        explicitTangent === undefined ? null : unit(explicitTangent)
      if (explicitTangent !== undefined && tangent === null) return null
      return Object.freeze({
        point: frozenPoint(query[0]!, query[1]!),
        tangent,
        sample: null,
      })
    }
    if (typeof query !== 'object' || query === null) return null
    const sample = query as Readonly<CorrectedFlowingRidgeSample>
    const point = sample.point
    const tangent = unit(explicitTangent ?? sample.tangent)
    if (
      !Array.isArray(point) ||
      point.length !== 2 ||
      !Number.isFinite(point[0]) ||
      !Number.isFinite(point[1]) ||
      tangent === null ||
      !finiteUnit(sample.evidence) ||
      !finiteUnit(sample.coherence) ||
      !finiteUnit(sample.ambiguity) ||
      !finitePositive(sample.scale) ||
      !finitePositive(sample.alpha) ||
      sample.alpha > 1
    ) {
      return null
    }
    return Object.freeze({
      point: frozenPoint(point[0], point[1]),
      tangent,
      sample,
    })
  } catch {
    return null
  }
}

function sampleMatchesField(
  field: Readonly<FlowingContoursField>,
  sample: Readonly<CorrectedFlowingRidgeSample>,
): boolean {
  const sampled = sampleFlowingContoursField(field, sample.point)
  if (sampled === null) return false
  const suppliedTangent = unit(sample.tangent)
  const fieldTangent = unit(sampled.tangent)
  return (
    suppliedTangent !== null &&
    fieldTangent !== null &&
    Math.abs(
      suppliedTangent[0] * fieldTangent[0] +
        suppliedTangent[1] * fieldTangent[1],
    ) >=
      1 - VALUE_TOLERANCE &&
    sameNumber(sample.evidence, sampled.evidence) &&
    sameNumber(sample.coherence, sampled.coherence) &&
    sameNumber(sample.ambiguity, sampled.ambiguity) &&
    sameNumber(sample.scale, sampled.scale) &&
    sameNumber(sample.alpha, sampled.alpha)
  )
}

function spatialOverlap(distance: number, radius: number): number {
  return distance >= radius ? 0 : Math.max(0, 1 - distance / radius)
}

function overlapAt(
  data: Readonly<SuppressionData>,
  point: Readonly<Point>,
  tangent: Readonly<Point> | null,
): number {
  const [cellX, cellY] = sampleCell(point)
  let maximum = 0
  for (let offsetY = -1; offsetY <= 1; offsetY += 1) {
    for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
      const indices = data.spatialIndex.get(
        spatialKey(cellX + offsetX, cellY + offsetY),
      )
      if (indices === undefined) continue
      for (const index of indices) {
        const occupied = data.occupancy[index]!
        const distance = Math.hypot(
          point[0] - occupied.point[0],
          point[1] - occupied.point[1],
        )
        let overlap = spatialOverlap(distance, OWNERSHIP_RADIUS)
        if (tangent !== null) {
          const alignment = Math.abs(
            tangent[0] * occupied.tangent[0] + tangent[1] * occupied.tangent[1],
          )
          if (alignment < TANGENT_ALIGNMENT_FLOOR) {
            overlap = spatialOverlap(distance, CROSSING_CORE_RADIUS)
          }
        }
        maximum = Math.max(maximum, overlap)
      }
    }
  }
  return Math.min(1, maximum)
}

/**
 * Query represented overlap in `[0, 1]`.
 *
 * A point-only query is suitable for FC09/FC10's current sampler seam. Passing
 * a corrected sample (or an explicit tangent with a point) enables the stricter
 * ridge-aware decision. Corrected samples must belong to the state's field.
 */
export function queryFlowingContoursSuppression(
  state: Readonly<FlowingContoursSuppressionState>,
  sampleOrPoint: SuppressionQuery,
  tangent?: Readonly<Point>,
): number | null {
  const data = stateData(state)
  const query = pointQuery(sampleOrPoint, tangent)
  if (
    data === null ||
    query === null ||
    query.point[0] < 0 ||
    query.point[1] < 0 ||
    query.point[0] > data.field.width - 1 ||
    query.point[1] > data.field.height - 1 ||
    (query.sample !== null && !sampleMatchesField(data.field, query.sample))
  ) {
    return null
  }
  return overlapAt(data, query.point, query.tangent)
}

function trajectoryShape(
  data: Readonly<SuppressionData>,
  trajectory: Readonly<AcceptedFlowingTrajectory>,
): 'valid' | 'invalid-input' | 'field-mismatch' {
  try {
    if (
      !Number.isSafeInteger(trajectory.id) ||
      trajectory.id < 0 ||
      !Number.isSafeInteger(trajectory.anchorId) ||
      trajectory.anchorId < 0 ||
      !Array.isArray(trajectory.samples) ||
      trajectory.samples.length < 2 ||
      trajectory.samples.length > data.rawTrajectoryPointLimit ||
      !Array.isArray(trajectory.spanSupport) ||
      !ENDPOINT_REASONS.has(trajectory.startEndpointReason) ||
      !ENDPOINT_REASONS.has(trajectory.endEndpointReason) ||
      !finitePositive(trajectory.length) ||
      typeof trajectory.maximumUnsupportedSpanLength !== 'number' ||
      !Number.isFinite(trajectory.maximumUnsupportedSpanLength) ||
      trajectory.maximumUnsupportedSpanLength < 0 ||
      typeof trajectory.totalUnsupportedSpanLength !== 'number' ||
      !Number.isFinite(trajectory.totalUnsupportedSpanLength) ||
      trajectory.totalUnsupportedSpanLength < 0 ||
      typeof trajectory.score !== 'object' ||
      trajectory.score === null
    ) {
      return 'invalid-input'
    }
    let measuredLength = 0
    for (let index = 0; index < trajectory.samples.length; index += 1) {
      const query = pointQuery(trajectory.samples[index]!)
      if (query === null || query.sample === null) return 'invalid-input'
      if (!sampleMatchesField(data.field, query.sample)) {
        return 'field-mismatch'
      }
      if (index > 0) {
        const previous = trajectory.samples[index - 1]!.point
        const segmentLength = Math.hypot(
          query.point[0] - previous[0],
          query.point[1] - previous[1],
        )
        if (
          !Number.isFinite(segmentLength) ||
          segmentLength <= VECTOR_EPSILON
        ) {
          return 'invalid-input'
        }
        measuredLength += segmentLength
      }
    }
    if (!sameNumber(measuredLength, trajectory.length)) {
      return 'invalid-input'
    }
    const scoreNames = [
      'accumulatedEvidence',
      'usefulLength',
      'directionalCoherence',
      'curvaturePenalty',
      'unsupportedTravelPenalty',
      'ambiguityPenalty',
      'representedOverlapPenalty',
      'total',
    ] as const
    for (const name of scoreNames) {
      const value = ownDataValue(trajectory.score, name)
      if (
        typeof value !== 'number' ||
        !Number.isFinite(value) ||
        (name !== 'total' && value < 0)
      ) {
        return 'invalid-input'
      }
    }
    let expectedStart = 0
    let maximumUnsupportedLength = 0
    let totalUnsupportedLength = 0
    for (const span of trajectory.spanSupport) {
      if (
        typeof span !== 'object' ||
        span === null ||
        (span.kind !== 'direct-evidence' && span.kind !== 'bounded-gap') ||
        !Number.isSafeInteger(span.startSampleIndex) ||
        !Number.isSafeInteger(span.endSampleIndex) ||
        span.startSampleIndex !== expectedStart ||
        span.endSampleIndex <= span.startSampleIndex ||
        span.endSampleIndex >= trajectory.samples.length ||
        !finitePositive(span.length) ||
        !finiteUnit(span.entryEvidence) ||
        !finiteUnit(span.exitEvidence) ||
        !finiteUnit(span.directionalAlignment)
      ) {
        return 'invalid-input'
      }
      let spanLength = 0
      for (
        let index = span.startSampleIndex;
        index < span.endSampleIndex;
        index += 1
      ) {
        const first = trajectory.samples[index]!.point
        const second = trajectory.samples[index + 1]!.point
        spanLength += Math.hypot(
          second[0] - first[0],
          second[1] - first[1],
        )
      }
      if (
        !sameNumber(spanLength, span.length) ||
        !sameNumber(
          span.entryEvidence,
          trajectory.samples[span.startSampleIndex]!.evidence,
        ) ||
        !sameNumber(
          span.exitEvidence,
          trajectory.samples[span.endSampleIndex]!.evidence,
        )
      ) {
        return 'invalid-input'
      }
      if (span.kind === 'bounded-gap') {
        maximumUnsupportedLength = Math.max(
          maximumUnsupportedLength,
          span.length,
        )
        totalUnsupportedLength += span.length
      }
      expectedStart = span.endSampleIndex
    }
    if (
      expectedStart !== trajectory.samples.length - 1 ||
      !sameNumber(
        maximumUnsupportedLength,
        trajectory.maximumUnsupportedSpanLength,
      ) ||
      !sameNumber(
        totalUnsupportedLength,
        trajectory.totalUnsupportedSpanLength,
      )
    ) {
      return 'invalid-input'
    }
    return 'valid'
  } catch {
    return 'invalid-input'
  }
}

function interpolateTangent(
  first: Readonly<Point>,
  second: Readonly<Point>,
  progress: number,
): Readonly<Point> | null {
  const start = unit(first)
  const rawEnd = unit(second)
  if (start === null || rawEnd === null) return null
  const sign = start[0] * rawEnd[0] + start[1] * rawEnd[1] < 0 ? -1 : 1
  return unit([
    start[0] * (1 - progress) + rawEnd[0] * sign * progress,
    start[1] * (1 - progress) + rawEnd[1] * sign * progress,
  ])
}

function canonicalNumber(value: number): number {
  const rounded = Number(value.toFixed(12))
  return Object.is(rounded, -0) ? 0 : rounded
}

function occupancyKey(sample: Readonly<OccupancySample>): string {
  return [
    canonicalNumber(sample.point[0]),
    canonicalNumber(sample.point[1]),
    canonicalNumber(sample.tangent[0]),
    canonicalNumber(sample.tangent[1]),
  ].join('|')
}

function trajectoryOccupancy(
  trajectory: Readonly<AcceptedFlowingTrajectory>,
  maximumCount: number,
): readonly Readonly<OccupancySample>[] | null {
  const samples: Readonly<OccupancySample>[] = []
  for (let index = 0; index < trajectory.samples.length - 1; index += 1) {
    const first = trajectory.samples[index]!
    const second = trajectory.samples[index + 1]!
    const segmentLength = Math.hypot(
      second.point[0] - first.point[0],
      second.point[1] - first.point[1],
    )
    const intervalCount = Math.max(
      1,
      Math.ceil(segmentLength / OCCUPANCY_SAMPLE_SPACING),
    )
    const startInterval = index === 0 ? 0 : 1
    if (samples.length + intervalCount + 1 - startInterval > maximumCount) {
      return null
    }
    for (
      let interval = startInterval;
      interval <= intervalCount;
      interval += 1
    ) {
      const progress = interval / intervalCount
      const tangent = interpolateTangent(
        first.tangent,
        second.tangent,
        progress,
      )
      if (tangent === null) return null
      samples.push(
        Object.freeze({
          point: frozenPoint(
            first.point[0] + (second.point[0] - first.point[0]) * progress,
            first.point[1] + (second.point[1] - first.point[1]) * progress,
          ),
          tangent,
        }),
      )
    }
  }
  return Object.freeze(samples)
}

function compareOccupancy(
  first: Readonly<OccupancySample>,
  second: Readonly<OccupancySample>,
): number {
  return (
    first.point[1] - second.point[1] ||
    first.point[0] - second.point[0] ||
    first.tangent[1] - second.tangent[1] ||
    first.tangent[0] - second.tangent[0]
  )
}

function mergeOccupancy(
  existing: readonly Readonly<OccupancySample>[],
  additions: readonly Readonly<OccupancySample>[],
): readonly Readonly<OccupancySample>[] {
  const union = new Map<string, Readonly<OccupancySample>>()
  for (const sample of existing) union.set(occupancyKey(sample), sample)
  for (const sample of additions) union.set(occupancyKey(sample), sample)
  return Object.freeze(Array.from(union.values()).sort(compareOccupancy))
}

function newlySuppressedEvidence(
  data: Readonly<SuppressionData>,
  additions: readonly Readonly<OccupancySample>[],
): ReadonlySet<number> {
  const candidates = new Set<number>()
  for (const sample of additions) {
    const minimumX = Math.max(0, Math.ceil(sample.point[0] - OWNERSHIP_RADIUS))
    const maximumX = Math.min(
      data.field.width - 1,
      Math.floor(sample.point[0] + OWNERSHIP_RADIUS),
    )
    const minimumY = Math.max(0, Math.ceil(sample.point[1] - OWNERSHIP_RADIUS))
    const maximumY = Math.min(
      data.field.height - 1,
      Math.floor(sample.point[1] + OWNERSHIP_RADIUS),
    )
    for (let y = minimumY; y <= maximumY; y += 1) {
      for (let x = minimumX; x <= maximumX; x += 1) {
        candidates.add(y * data.field.width + x)
      }
    }
  }
  const suppressed = new Set(data.suppressedEvidence)
  for (const index of candidates) {
    if (
      suppressed.has(index) ||
      !data.field.positiveSupport[index] ||
      data.field.contourEvidence[index]! <= 0
    ) {
      continue
    }
    const point = frozenPoint(
      index % data.field.width,
      Math.floor(index / data.field.width),
    )
    const tangent = unit([
      data.field.tangentX[index]!,
      data.field.tangentY[index]!,
    ])
    if (
      tangent !== null &&
      overlapAt(data, point, tangent) >= EVIDENCE_SUPPRESSION_THRESHOLD
    ) {
      suppressed.add(index)
    }
  }
  return suppressed
}

/**
 * Transactionally add one accepted raw trajectory.
 *
 * Every prospective sample, union, cap, and evidence decision is computed
 * before publishing a new state. A rejected commit leaves the old snapshot and
 * all hidden data untouched.
 */
export function commitAcceptedFlowingTrajectorySuppression(
  state: Readonly<FlowingContoursSuppressionState>,
  trajectory: Readonly<AcceptedFlowingTrajectory>,
): FlowingContoursSuppressionCommitResult {
  const data = stateData(state)
  if (data === null) {
    return Object.freeze({ kind: 'rejected', reason: 'field-mismatch' })
  }
  const validity = trajectoryShape(data, trajectory)
  if (validity !== 'valid') {
    return Object.freeze({ kind: 'rejected', reason: validity })
  }
  const additions = trajectoryOccupancy(trajectory, data.occupancyLimit)
  if (additions === null) {
    return Object.freeze({ kind: 'rejected', reason: 'occupancy-limit' })
  }
  const occupancy = mergeOccupancy(data.occupancy, additions)
  if (occupancy.length > data.occupancyLimit) {
    return Object.freeze({ kind: 'rejected', reason: 'occupancy-limit' })
  }
  const prospectiveData: Readonly<SuppressionData> = Object.freeze({
    ...data,
    occupancy,
    spatialIndex: buildSpatialIndex(occupancy),
  })
  const suppressedEvidence = newlySuppressedEvidence(prospectiveData, additions)
  if (suppressedEvidence.size > data.occupancyLimit) {
    return Object.freeze({ kind: 'rejected', reason: 'occupancy-limit' })
  }
  const nextData: Readonly<SuppressionData> = Object.freeze({
    ...prospectiveData,
    suppressedEvidence,
  })
  const nextState =
    occupancy === data.occupancy &&
    suppressedEvidence.size === data.suppressedEvidence.size
      ? state
      : createState(nextData)
  return Object.freeze({
    kind: 'committed',
    state: nextState,
    suppressedEvidenceSampleCount:
      suppressedEvidence.size - data.suppressedEvidence.size,
  })
}

/** Decide whether one exact-field anchor is already represented. */
export function isFlowingContoursAnchorSuppressed(
  state: Readonly<FlowingContoursSuppressionState>,
  anchor: Readonly<FlowingContoursAnchor>,
): boolean | null {
  try {
    const data = stateData(state)
    if (
      data === null ||
      !Number.isSafeInteger(anchor.id) ||
      anchor.id < 0 ||
      !Number.isSafeInteger(anchor.fieldSampleIndex) ||
      anchor.fieldSampleIndex < 0 ||
      anchor.fieldSampleIndex >= data.field.width * data.field.height
    ) {
      return null
    }
    const overlap = queryFlowingContoursSuppression(state, anchor.sample)
    return overlap === null ? null : overlap >= ANCHOR_SUPPRESSION_THRESHOLD
  } catch {
    return null
  }
}
