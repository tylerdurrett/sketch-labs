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
  isFlowingContoursAcceptedSelectionFromField,
  type FlowingContoursSelectionResult,
} from './selection'
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
const CROSSING_OVERLAP_CEILING = 0.45
const POINT_ONLY_OVERLAP_CEILING = 0.65
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

/** Opaque exact-field query capability for one immutable state snapshot. */
export interface FlowingContoursSuppressionQuery {
  readonly field: Readonly<FlowingContoursField>
  readonly occupancySampleCount: number
}

/** Opaque proof that FC11 accepted one trajectory for this exact field. */
export interface RegisteredFlowingTrajectorySuppression {
  readonly field: Readonly<FlowingContoursField>
  readonly trajectoryId: number
  readonly rawSampleCount: number
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

const STATE_DATA = new WeakMap<
  Readonly<FlowingContoursSuppressionState>,
  Readonly<SuppressionData>
>()

const QUERY_DATA = new WeakMap<
  Readonly<FlowingContoursSuppressionQuery>,
  Readonly<SuppressionData>
>()

const REGISTRATION_DATA = new WeakMap<
  Readonly<RegisteredFlowingTrajectorySuppression>,
  {
    readonly field: Readonly<FlowingContoursField>
    readonly trajectory: Readonly<AcceptedFlowingTrajectory>
  }
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

function snapshotPoint(source: unknown): Readonly<Point> | null {
  try {
    if (!Array.isArray(source)) return null
    const length = ownDataValue(source, 'length')
    const x = ownDataValue(source, 0)
    const y = ownDataValue(source, 1)
    return length === 2 &&
      typeof x === 'number' &&
      Number.isFinite(x) &&
      typeof y === 'number' &&
      Number.isFinite(y)
      ? frozenPoint(x, y)
      : null
  } catch {
    return null
  }
}

function snapshotSample(
  source: unknown,
): Readonly<CorrectedFlowingRidgeSample> | null {
  try {
    if (typeof source !== 'object' || source === null) return null
    const point = snapshotPoint(ownDataValue(source, 'point'))
    const tangent = snapshotPoint(ownDataValue(source, 'tangent'))
    const evidence = ownDataValue(source, 'evidence')
    const coherence = ownDataValue(source, 'coherence')
    const ambiguity = ownDataValue(source, 'ambiguity')
    const scale = ownDataValue(source, 'scale')
    const alpha = ownDataValue(source, 'alpha')
    if (
      point === null ||
      tangent === null ||
      unit(tangent) === null ||
      !finiteUnit(evidence) ||
      !finiteUnit(coherence) ||
      !finiteUnit(ambiguity) ||
      !finitePositive(scale) ||
      !finitePositive(alpha) ||
      alpha > 1
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
  } catch {
    return null
  }
}

function snapshotScore(
  source: unknown,
): AcceptedFlowingTrajectory['score'] | null {
  try {
    if (typeof source !== 'object' || source === null) return null
    const names = [
      'accumulatedEvidence',
      'usefulLength',
      'directionalCoherence',
      'curvaturePenalty',
      'unsupportedTravelPenalty',
      'ambiguityPenalty',
      'representedOverlapPenalty',
      'total',
    ] as const
    const values = Object.fromEntries(
      names.map((name) => [name, ownDataValue(source, name)]),
    ) as Record<(typeof names)[number], unknown>
    for (const name of names) {
      const value = values[name]
      if (
        typeof value !== 'number' ||
        !Number.isFinite(value) ||
        (name !== 'total' && value < 0)
      ) {
        return null
      }
    }
    return Object.freeze({
      accumulatedEvidence: values.accumulatedEvidence as number,
      usefulLength: values.usefulLength as number,
      directionalCoherence: values.directionalCoherence as number,
      curvaturePenalty: values.curvaturePenalty as number,
      unsupportedTravelPenalty: values.unsupportedTravelPenalty as number,
      ambiguityPenalty: values.ambiguityPenalty as number,
      representedOverlapPenalty: values.representedOverlapPenalty as number,
      total: values.total as number,
    })
  } catch {
    return null
  }
}

function snapshotSpans(
  source: unknown,
): AcceptedFlowingTrajectory['spanSupport'] | null {
  try {
    if (!Array.isArray(source)) return null
    const length = ownDataValue(source, 'length')
    if (
      !Number.isSafeInteger(length) ||
      (length as number) < 1 ||
      (length as number) > FLOWING_CONTOURS_LIMITS['raw-trajectory-point-count']
    ) {
      return null
    }
    const spans = []
    for (let index = 0; index < (length as number); index += 1) {
      const candidate = ownDataValue(source, index)
      if (typeof candidate !== 'object' || candidate === null) return null
      const kind = ownDataValue(candidate, 'kind')
      const startSampleIndex = ownDataValue(candidate, 'startSampleIndex')
      const endSampleIndex = ownDataValue(candidate, 'endSampleIndex')
      const spanLength = ownDataValue(candidate, 'length')
      const entryEvidence = ownDataValue(candidate, 'entryEvidence')
      const exitEvidence = ownDataValue(candidate, 'exitEvidence')
      const directionalAlignment = ownDataValue(
        candidate,
        'directionalAlignment',
      )
      if (
        (kind !== 'direct-evidence' && kind !== 'bounded-gap') ||
        !Number.isSafeInteger(startSampleIndex) ||
        !Number.isSafeInteger(endSampleIndex) ||
        !finitePositive(spanLength) ||
        !finiteUnit(entryEvidence) ||
        !finiteUnit(exitEvidence) ||
        !finiteUnit(directionalAlignment)
      ) {
        return null
      }
      spans.push(
        Object.freeze({
          kind,
          startSampleIndex: startSampleIndex as number,
          endSampleIndex: endSampleIndex as number,
          length: spanLength,
          entryEvidence,
          exitEvidence,
          directionalAlignment,
        }),
      )
    }
    return Object.freeze(spans)
  } catch {
    return null
  }
}

function snapshotTrajectory(
  source: unknown,
): Readonly<AcceptedFlowingTrajectory> | null {
  try {
    if (typeof source !== 'object' || source === null) return null
    const id = ownDataValue(source, 'id')
    const anchorId = ownDataValue(source, 'anchorId')
    const sampleSource = ownDataValue(source, 'samples')
    const spanSupport = snapshotSpans(ownDataValue(source, 'spanSupport'))
    const startEndpointReason = ownDataValue(source, 'startEndpointReason')
    const endEndpointReason = ownDataValue(source, 'endEndpointReason')
    const length = ownDataValue(source, 'length')
    const maximumUnsupportedSpanLength = ownDataValue(
      source,
      'maximumUnsupportedSpanLength',
    )
    const totalUnsupportedSpanLength = ownDataValue(
      source,
      'totalUnsupportedSpanLength',
    )
    const score = snapshotScore(ownDataValue(source, 'score'))
    if (
      !Number.isSafeInteger(id) ||
      (id as number) < 0 ||
      !Number.isSafeInteger(anchorId) ||
      (anchorId as number) < 0 ||
      !Array.isArray(sampleSource) ||
      spanSupport === null ||
      !ENDPOINT_REASONS.has(
        startEndpointReason as FlowingContoursEndpointReason,
      ) ||
      !ENDPOINT_REASONS.has(
        endEndpointReason as FlowingContoursEndpointReason,
      ) ||
      !finitePositive(length) ||
      typeof maximumUnsupportedSpanLength !== 'number' ||
      !Number.isFinite(maximumUnsupportedSpanLength) ||
      maximumUnsupportedSpanLength < 0 ||
      typeof totalUnsupportedSpanLength !== 'number' ||
      !Number.isFinite(totalUnsupportedSpanLength) ||
      totalUnsupportedSpanLength < 0 ||
      score === null
    ) {
      return null
    }
    const sampleCount = ownDataValue(sampleSource, 'length')
    if (
      !Number.isSafeInteger(sampleCount) ||
      (sampleCount as number) < 2 ||
      (sampleCount as number) >
        FLOWING_CONTOURS_LIMITS['raw-trajectory-point-count']
    ) {
      return null
    }
    const samples: Readonly<CorrectedFlowingRidgeSample>[] = []
    for (let index = 0; index < (sampleCount as number); index += 1) {
      const sample = snapshotSample(ownDataValue(sampleSource, index))
      if (sample === null) return null
      samples.push(sample)
    }
    return Object.freeze({
      id: id as number,
      anchorId: anchorId as number,
      samples: Object.freeze(samples),
      spanSupport,
      startEndpointReason: startEndpointReason as FlowingContoursEndpointReason,
      endEndpointReason: endEndpointReason as FlowingContoursEndpointReason,
      length,
      maximumUnsupportedSpanLength,
      totalUnsupportedSpanLength,
      score,
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
            overlap = Math.min(
              CROSSING_OVERLAP_CEILING,
              spatialOverlap(distance, CROSSING_CORE_RADIUS),
            )
          }
        }
        maximum = Math.max(maximum, overlap)
      }
    }
  }
  return Math.min(1, maximum)
}

/**
 * Bind queries to exactly one immutable state and analysis-field identity.
 *
 * FC14 should rebuild this inexpensive capability after each successful commit
 * and close over it when wiring suppression into search.
 */
export function createFlowingContoursSuppressionQuery(
  state: Readonly<FlowingContoursSuppressionState>,
  field: Readonly<FlowingContoursField>,
): Readonly<FlowingContoursSuppressionQuery> | null {
  const data = stateData(state)
  if (data === null || field !== data.field) return null
  const query: Readonly<FlowingContoursSuppressionQuery> = Object.freeze({
    field,
    occupancySampleCount: data.occupancy.length,
  })
  QUERY_DATA.set(query, data)
  return query
}

function queryData(
  query: Readonly<FlowingContoursSuppressionQuery>,
): Readonly<SuppressionData> | null {
  try {
    const data = QUERY_DATA.get(query)
    return data !== undefined &&
      Object.isFrozen(query) &&
      query.field === data.field &&
      query.occupancySampleCount === data.occupancy.length
      ? data
      : null
  } catch {
    return null
  }
}

function inField(
  data: Readonly<SuppressionData>,
  point: Readonly<Point>,
): boolean {
  return (
    point[0] >= 0 &&
    point[1] >= 0 &&
    point[0] <= data.field.width - 1 &&
    point[1] <= data.field.height - 1
  )
}

/**
 * Conservative point-only overlap for FC09/FC10's existing callback seam.
 *
 * Lacking a travel tangent, this query can contribute overlap penalty but is
 * deliberately capped below the hard collision threshold. That prevents an
 * unknown perpendicular crossing from terminating a later long gesture.
 */
export function queryFlowingContoursSuppression(
  query: Readonly<FlowingContoursSuppressionQuery>,
  sourcePoint: Readonly<Point>,
): number | null {
  const data = queryData(query)
  const point = snapshotPoint(sourcePoint)
  if (data === null || point === null || !inField(data, point)) {
    return null
  }
  return Math.min(POINT_ONLY_OVERLAP_CEILING, overlapAt(data, point, null))
}

/**
 * Tangent-aware collision query for growth.
 *
 * FC14 should prefer this whenever the current predictor/corrector tangent is
 * available. Same-ridge travel reaches hard collision; a perpendicular
 * crossing remains a bounded soft overlap and may continue through it.
 */
export function queryFlowingContoursSuppressionAlongTangent(
  query: Readonly<FlowingContoursSuppressionQuery>,
  sourcePoint: Readonly<Point>,
  sourceTangent: Readonly<Point>,
): number | null {
  const data = queryData(query)
  const point = snapshotPoint(sourcePoint)
  const tangentPoint = snapshotPoint(sourceTangent)
  const tangent = tangentPoint === null ? null : unit(tangentPoint)
  if (
    data === null ||
    point === null ||
    tangent === null ||
    !inField(data, point)
  ) {
    return null
  }
  return overlapAt(data, point, tangent)
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
      const sample = trajectory.samples[index]!
      if (!sampleMatchesField(data.field, sample)) {
        return 'field-mismatch'
      }
      if (index > 0) {
        const previous = trajectory.samples[index - 1]!.point
        const segmentLength = Math.hypot(
          sample.point[0] - previous[0],
          sample.point[1] - previous[1],
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
        spanLength += Math.hypot(second[0] - first[0], second[1] - first[1])
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
      !sameNumber(totalUnsupportedLength, trajectory.totalUnsupportedSpanLength)
    ) {
      return 'invalid-input'
    }
    return 'valid'
  } catch {
    return 'invalid-input'
  }
}

/**
 * Register FC11's accepted result as a field-bound commit capability.
 *
 * FC14 calls this immediately after selection returns `kind: 'accepted'`.
 * The entire external result is snapshotted through guarded own-data reads and
 * fully validated before the opaque capability is published.
 */
export function registerAcceptedFlowingTrajectorySuppression(
  state: Readonly<FlowingContoursSuppressionState>,
  field: Readonly<FlowingContoursField>,
  selection: Readonly<FlowingContoursSelectionResult>,
): Readonly<RegisteredFlowingTrajectorySuppression> | null {
  try {
    const data = stateData(state)
    if (
      data === null ||
      field !== data.field ||
      typeof selection !== 'object' ||
      selection === null ||
      !isFlowingContoursAcceptedSelectionFromField(selection, field)
    ) {
      return null
    }
    const kind = ownDataValue(selection, 'kind')
    const sourceTrajectory = ownDataValue(selection, 'trajectory')
    const safetyTruncated = ownDataValue(selection, 'safetyTruncated')
    if (kind !== 'accepted' || typeof safetyTruncated !== 'boolean') {
      return null
    }
    const trajectory = snapshotTrajectory(sourceTrajectory)
    if (
      trajectory === null ||
      trajectoryShape(data, trajectory) !== 'valid' ||
      safetyTruncated !==
        (trajectory.startEndpointReason === 'safety-limit' ||
          trajectory.endEndpointReason === 'safety-limit')
    ) {
      return null
    }
    const registration: Readonly<RegisteredFlowingTrajectorySuppression> =
      Object.freeze({
        field,
        trajectoryId: trajectory.id,
        rawSampleCount: trajectory.samples.length,
      })
    REGISTRATION_DATA.set(registration, Object.freeze({ field, trajectory }))
    return registration
  } catch {
    return null
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
  registration: Readonly<RegisteredFlowingTrajectorySuppression>,
): FlowingContoursSuppressionCommitResult {
  const data = stateData(state)
  if (data === null) {
    return Object.freeze({ kind: 'rejected', reason: 'field-mismatch' })
  }
  const registered = REGISTRATION_DATA.get(registration)
  if (
    registered === undefined ||
    !Object.isFrozen(registration) ||
    registration.field !== registered.field ||
    registration.trajectoryId !== registered.trajectory.id ||
    registration.rawSampleCount !== registered.trajectory.samples.length
  ) {
    return Object.freeze({ kind: 'rejected', reason: 'invalid-input' })
  }
  if (registered.field !== data.field) {
    return Object.freeze({ kind: 'rejected', reason: 'field-mismatch' })
  }
  const trajectory = registered.trajectory
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

function fieldsShareAnalysisSupport(
  first: Readonly<FlowingContoursField>,
  second: Readonly<FlowingContoursField>,
): boolean {
  if (
    first.sourceWidth !== second.sourceWidth ||
    first.sourceHeight !== second.sourceHeight ||
    first.width !== second.width ||
    first.height !== second.height ||
    first.alpha.length !== second.alpha.length ||
    first.positiveSupport.length !== second.positiveSupport.length
  ) {
    return false
  }
  for (let index = 0; index < first.alpha.length; index += 1) {
    if (
      !Object.is(first.alpha[index], second.alpha[index]) ||
      first.positiveSupport[index] !== second.positiveSupport[index]
    ) {
      return false
    }
  }
  return true
}

/**
 * Project one authenticated accepted trajectory into a sibling hypothesis.
 *
 * This capability shares only continuous geometric occupancy. It never
 * rebrands samples, selection, fitting, or evidence-tube provenance as coming
 * from the target field. Exact source extent and alpha/support identity are
 * required before the immutable target occupancy transaction is attempted.
 */
export function projectAcceptedFlowingTrajectorySuppression(
  state: Readonly<FlowingContoursSuppressionState>,
  registration: Readonly<RegisteredFlowingTrajectorySuppression>,
): FlowingContoursSuppressionCommitResult {
  const data = stateData(state)
  if (data === null) {
    return Object.freeze({ kind: 'rejected', reason: 'field-mismatch' })
  }
  const registered = REGISTRATION_DATA.get(registration)
  if (
    registered === undefined ||
    !Object.isFrozen(registration) ||
    registration.field !== registered.field ||
    registration.trajectoryId !== registered.trajectory.id ||
    registration.rawSampleCount !== registered.trajectory.samples.length
  ) {
    return Object.freeze({ kind: 'rejected', reason: 'invalid-input' })
  }
  if (!fieldsShareAnalysisSupport(registered.field, data.field)) {
    return Object.freeze({ kind: 'rejected', reason: 'field-mismatch' })
  }
  if (registered.field === data.field) {
    return commitAcceptedFlowingTrajectorySuppression(state, registration)
  }

  const additions = trajectoryOccupancy(
    registered.trajectory,
    data.occupancyLimit,
  )
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
  query: Readonly<FlowingContoursSuppressionQuery>,
  anchor: Readonly<FlowingContoursAnchor>,
): boolean | null {
  try {
    const data = queryData(query)
    if (typeof anchor !== 'object' || anchor === null) return null
    const id = ownDataValue(anchor, 'id')
    const fieldSampleIndex = ownDataValue(anchor, 'fieldSampleIndex')
    const sample = snapshotSample(ownDataValue(anchor, 'sample'))
    if (
      data === null ||
      !Number.isSafeInteger(id) ||
      (id as number) < 0 ||
      !Number.isSafeInteger(fieldSampleIndex) ||
      (fieldSampleIndex as number) < 0 ||
      (fieldSampleIndex as number) >= data.field.width * data.field.height ||
      sample === null ||
      !sampleMatchesField(data.field, sample)
    ) {
      return null
    }
    const tangent = unit(sample.tangent)
    return tangent === null
      ? null
      : overlapAt(data, sample.point, tangent) >= ANCHOR_SUPPRESSION_THRESHOLD
  } catch {
    return null
  }
}
