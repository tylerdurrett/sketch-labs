import type { Scene } from '../../scene'
import {
  FLOWING_CONTOURS_ENDPOINT_REASONS,
  type AcceptedFlowingTrajectory,
  type FlowingContoursDiagnostics,
  type FlowingContoursEndpointReasonCounts,
} from '../../sketches/flowing-contours/types'
import type { Point } from '../../types'

/**
 * Reference-evidence vocabulary for Flowing Contours.
 *
 * Geometry is resampled by arc length before turns or coverage are measured.
 * Consequently adding/removing collinear source vertices cannot improve a
 * result. Defaults are fractions of the Scene diagonal, so translation,
 * rotation, and uniform scale preserve every dimensionless metric.
 *
 * Deletion can make shares look better. A reference gate must pair any share
 * with at least one non-share inventory (`totalAcceptedTrajectoryLength`,
 * `longGeometryLength`, `occupiedCoverageBinCount`, or named-region coverage).
 */

export const FLOWING_CONTOURS_REFERENCE_DEFAULTS = Object.freeze({
  sampleSpacingDiagonalFraction: 1 / 400,
  shortPathDiagonalFraction: 0.015,
  longPathDiagonalFraction: 0.08,
  coverageColumns: 4,
  coverageRows: 4,
  turn25Degrees: 25,
  turn45Degrees: 45,
  orthogonalDegrees: 90,
  orthogonalToleranceDegrees: 15,
})

const MAX_PATHS = 4096
const MAX_POINTS = 1_000_000
const MAX_RESAMPLED_POINTS = 2_000_000
const MAX_COVERAGE_AXIS_BINS = 64
const MAX_REGIONS = 64
const VECTOR_EPSILON = 1e-12
const PROVENANCE_TOLERANCE = 1e-12
const TANGENT_UNIT_TOLERANCE = 1e-8
const GAP_ALIGNMENT_FLOOR = 0.75
const LOOP_ALIGNMENT_FLOOR = 0.75
const CYCLIC_DESCRIPTOR_QUANTUM = 1e-12
// Coordinate comparisons use max(1, Scene diagonal) × 1e-10. Aggregate
// comparisons use the same 1e-10 relative rule. A point within tolerance of
// an interior half-open boundary is assigned to the bin/region on its
// right/bottom, preventing double occupancy from last-bit noise.
const RELATIVE_TOLERANCE = 1e-10

export interface FlowingContoursReferenceRegion {
  readonly name: string
  /**
   * Normalized Scene coordinates. Bounds are [left, right) × [top, bottom);
   * points within tolerance of an interior right/bottom edge are outside.
   */
  readonly left: number
  readonly top: number
  readonly right: number
  readonly bottom: number
}

export interface FlowingContoursReferenceMetricOptions {
  /** Scene units; omitted means diagonal / 400. */
  readonly sampleSpacing?: number
  /** Scene units; paths strictly below this value are short. */
  readonly shortPathLength?: number
  /** Scene units; paths at or above this value are long. */
  readonly longPathLength?: number
  readonly coverageColumns?: number
  readonly coverageRows?: number
  readonly regions?: readonly Readonly<FlowingContoursReferenceRegion>[]
}

export type FlowingContoursReferenceDiagnostics = Pick<
  FlowingContoursDiagnostics,
  | 'primitiveCount'
  | 'rawTrajectoryCount'
  | 'rawTrajectoryPointCount'
  | 'acceptedMaximumUnsupportedSpanLength'
  | 'acceptedTotalUnsupportedSpanLength'
  | 'endpointReasonCounts'
>

export interface FlowingContoursReferenceMetricInput {
  readonly scene: Readonly<Scene>
  readonly acceptedTrajectories: readonly Readonly<AcceptedFlowingTrajectory>[]
  readonly diagnostics: Readonly<FlowingContoursReferenceDiagnostics>
  readonly options?: Readonly<FlowingContoursReferenceMetricOptions>
}

export interface FlowingContoursReferenceRegionCoverage {
  readonly name: string
  readonly occupied: boolean
  readonly sampledPointCount: number
}

export interface FlowingContoursReferenceMetrics {
  readonly pathCount: number
  readonly shortPathCount: number
  readonly shortPathShare: number
  readonly medianPathLength: number
  readonly upperQuartilePathLength: number
  readonly longestPathLength: number
  readonly totalPathLength: number
  readonly longPathCount: number
  readonly longGeometryLength: number
  readonly longGeometryShare: number
  /** Two for every open Scene path and zero for every closed Scene path. */
  readonly visibleEndpointCount: number
  /** Sum of the accepted endpoint-reason inventory. */
  readonly endpointCount: number
  readonly endpointReasonCounts: FlowingContoursEndpointReasonCounts
  readonly maximumUnsupportedSpanLength: number
  readonly totalUnsupportedSpanLength: number
  /**
   * Sum of validated raw accepted-trajectory geometry in analysis units.
   * This deliberately does not use `score.usefulLength`: that objective term
   * is weighted and clamps once a trajectory reaches one analysis diagonal.
   */
  readonly totalAcceptedTrajectoryLength: number
  readonly sampledPathCount: number
  readonly sampledPointCount: number
  /** Sum of squared signed turns, quantized to 1e-12 radians before squaring. */
  readonly turnEnergy: number
  readonly turnCount: number
  readonly maximumTurnDegrees: number
  readonly turnsOver25DegreesCount: number
  readonly turnsOver25DegreesShare: number
  readonly turnsOver45DegreesCount: number
  readonly turnsOver45DegreesShare: number
  /** Turns within 15 degrees of a right angle, irrespective of orientation. */
  readonly orthogonalTurnCount: number
  /**
   * Adjacent meaningful near-orthogonal turns with opposite signs. Zero-turn
   * resampling points are skipped and closed paths include the last-to-first
   * pair; repeated positive/negative pairs are the rotation-invariant
   * signature of a staircase.
   */
  readonly staircasePairCount: number
  readonly orthogonalStaircaseSignature: number
  readonly coverageColumns: number
  readonly coverageRows: number
  /** Row-major `"row,column"` keys occupied by sampled long geometry. */
  readonly occupiedCoverageBins: readonly string[]
  readonly occupiedCoverageBinCount: number
  readonly occupiedCoverageBinShare: number
  readonly regions: readonly Readonly<FlowingContoursReferenceRegionCoverage>[]
  readonly sampleSpacing: number
  readonly shortPathLength: number
  readonly longPathLength: number
  readonly numericTolerance: number
}

interface CanonicalPath {
  readonly points: readonly Readonly<Point>[]
  readonly closed: boolean
  readonly length: number
}

interface ReferenceAcceptedSample {
  readonly point: Readonly<Point>
  readonly tangent: Readonly<Point>
  readonly evidence: number
  readonly coherence: number
  readonly ambiguity: number
  readonly scale: number
  readonly alpha: number
}

function fail(message: string): never {
  throw new TypeError(`Invalid Flowing Contours reference input: ${message}`)
}

function finite(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(name)
  return value
}

function positive(value: unknown, name: string): number {
  const result = finite(value, name)
  if (result <= 0) fail(name)
  return result
}

function nonNegative(value: unknown, name: string): number {
  const result = finite(value, name)
  if (result < 0) fail(name)
  return result
}

function safeCount(value: unknown, name: string): number {
  const result = finite(value, name)
  if (!Number.isSafeInteger(result) || result < 0) fail(name)
  return result
}

function boundedInteger(
  value: unknown,
  name: string,
  minimum: number,
  maximum: number,
): number {
  const result = safeCount(value, name)
  if (result < minimum || result > maximum) fail(name)
  return result
}

function near(first: number, second: number): boolean {
  if (!Number.isFinite(first) || !Number.isFinite(second)) return false
  return (
    Math.abs(first - second) <=
    RELATIVE_TOLERANCE * Math.max(1, Math.abs(first), Math.abs(second))
  )
}

function provenanceNear(first: number, second: number): boolean {
  return (
    Number.isFinite(first) &&
    Number.isFinite(second) &&
    Math.abs(first - second) <=
      PROVENANCE_TOLERANCE * Math.max(1, Math.abs(second))
  )
}

function samePoint(
  first: Readonly<Point>,
  second: Readonly<Point>,
  tolerance: number,
): boolean {
  return (
    Math.abs(first[0] - second[0]) <= tolerance &&
    Math.abs(first[1] - second[1]) <= tolerance
  )
}

function snapshotPoint(value: unknown, name: string): Readonly<Point> {
  if (!Array.isArray(value) || value.length !== 2) fail(name)
  return Object.freeze([
    finite(value[0], `${name}[0]`),
    finite(value[1], `${name}[1]`),
  ]) as Readonly<Point>
}

function percentile(values: readonly number[], probability: number): number {
  if (values.length === 0) return 0
  const sorted = values.slice().sort((first, second) => first - second)
  // R-7 / NumPy-linear: index=(n-1)p, linearly interpolate adjacent ranks.
  const index = (sorted.length - 1) * probability
  const lower = Math.floor(index)
  const amount = index - lower
  return (
    sorted[lower]! +
    (sorted[Math.min(lower + 1, sorted.length - 1)]! - sorted[lower]!) * amount
  )
}

type CyclicDescriptor = readonly [edgeLength: number, signedTurn: number]

function quantizeDescriptor(value: number): number {
  return Math.round(value / CYCLIC_DESCRIPTOR_QUANTUM)
}

function compareCyclicDescriptor(
  first: CyclicDescriptor,
  second: CyclicDescriptor,
): number {
  return first[0] - second[0] || first[1] - second[1]
}

/**
 * Booth's linear-time minimum-rotation algorithm over intrinsic descriptors.
 *
 * Normalized edge length and signed turn are invariant under translation and
 * rotation. Selecting only a cyclic rotation preserves orientation/topology.
 * Quantization absorbs last-bit transform noise; if every rotation ties (for
 * example a regular polygon), every start has the same resampling phase.
 */
function canonicalClosedPoints(
  points: readonly Readonly<Point>[],
  length: number,
): readonly Readonly<Point>[] {
  const descriptors: CyclicDescriptor[] = points.map((point, index) => {
    const previous = points[(index - 1 + points.length) % points.length]!
    const next = points[(index + 1) % points.length]!
    const incomingX = point[0] - previous[0]
    const incomingY = point[1] - previous[1]
    const outgoingX = next[0] - point[0]
    const outgoingY = next[1] - point[1]
    const edgeLength = Math.hypot(outgoingX, outgoingY) / length
    const signedTurn = Math.atan2(
      incomingX * outgoingY - incomingY * outgoingX,
      incomingX * outgoingX + incomingY * outgoingY,
    )
    return Object.freeze([
      quantizeDescriptor(edgeLength),
      quantizeDescriptor(signedTurn),
    ])
  })
  let first = 0
  let second = 1
  let offset = 0
  while (
    first < points.length &&
    second < points.length &&
    offset < points.length
  ) {
    const comparison = compareCyclicDescriptor(
      descriptors[(first + offset) % points.length]!,
      descriptors[(second + offset) % points.length]!,
    )
    if (comparison === 0) {
      offset += 1
      continue
    }
    if (comparison > 0) {
      first += offset + 1
      if (first === second) first += 1
    } else {
      second += offset + 1
      if (first === second) second += 1
    }
    offset = 0
  }
  const start = Math.min(first, second)
  return Object.freeze([...points.slice(start), ...points.slice(0, start)])
}

/**
 * Remove representation-only vertices before closed resampling.
 *
 * A vertex collapses only when its quantized signed turn is zero and the two
 * incident vectors point in the same direction. Opposed vectors therefore
 * retain a genuine 180° cusp. Corner-to-corner geometry and perimeter are
 * unchanged for collinear densification, while authored vertex density can no
 * longer move the canonical start or arc-length phase.
 */
function collapseClosedCollinearPoints(
  points: readonly Readonly<Point>[],
): readonly Readonly<Point>[] {
  return Object.freeze(
    points.filter((point, index) => {
      const previous = points[(index - 1 + points.length) % points.length]!
      const next = points[(index + 1) % points.length]!
      const incomingX = point[0] - previous[0]
      const incomingY = point[1] - previous[1]
      const outgoingX = next[0] - point[0]
      const outgoingY = next[1] - point[1]
      const cross = incomingX * outgoingY - incomingY * outgoingX
      const dot = incomingX * outgoingX + incomingY * outgoingY
      const signedTurn = Math.atan2(cross, dot)
      return dot <= 0 || quantizeDescriptor(signedTurn) !== 0
    }),
  )
}

function canonicalPath(
  pointsValue: unknown,
  closedValue: unknown,
  tolerance: number,
  pathIndex: number,
): CanonicalPath {
  if (!Array.isArray(pointsValue)) fail(`path ${pathIndex} points`)
  const closed = closedValue === true
  if (
    closedValue !== undefined &&
    closedValue !== false &&
    closedValue !== true
  ) {
    fail(`path ${pathIndex} closed`)
  }
  let points = pointsValue.map((point, pointIndex) =>
    snapshotPoint(point, `path ${pathIndex} point ${pointIndex}`),
  )
  if (
    closed &&
    points.length > 1 &&
    samePoint(points[0]!, points.at(-1)!, tolerance)
  ) {
    // A repeated closing endpoint is representation, not an extra segment.
    points.pop()
  }
  if (closed) {
    points = points.filter(
      (point, index) =>
        index === 0 || !samePoint(point, points[index - 1]!, tolerance),
    )
    if (points.length > 1 && samePoint(points[0]!, points.at(-1)!, tolerance)) {
      points.pop()
    }
    points = [...collapseClosedCollinearPoints(points)]
  }
  if (points.length < (closed ? 3 : 2)) fail(`path ${pathIndex} arity`)

  let length = 0
  const segmentCount = closed ? points.length : points.length - 1
  for (let index = 0; index < segmentCount; index += 1) {
    const first = points[index]!
    const second = points[(index + 1) % points.length]!
    length += Math.hypot(second[0] - first[0], second[1] - first[1])
  }
  if (!Number.isFinite(length) || length <= tolerance) {
    fail(`path ${pathIndex} length`)
  }
  const canonicalPoints = closed
    ? canonicalClosedPoints(Object.freeze(points), length)
    : Object.freeze(points)
  return Object.freeze({
    points: canonicalPoints,
    closed,
    length,
  })
}

function resample(
  path: CanonicalPath,
  spacing: number,
  tolerance: number,
  budget: { count: number },
): readonly Readonly<Point>[] {
  const intervalCount = Math.floor((path.length - tolerance) / spacing)
  const expectedPointCount = intervalCount + 1 + (path.closed ? 0 : 1)
  if (
    !Number.isSafeInteger(intervalCount) ||
    intervalCount < 0 ||
    !Number.isSafeInteger(expectedPointCount) ||
    budget.count + expectedPointCount > MAX_RESAMPLED_POINTS
  ) {
    fail('resampled point cap')
  }
  const points: Readonly<Point>[] = []
  const segmentCount = path.closed ? path.points.length : path.points.length - 1
  let segmentIndex = 0
  let segmentStartDistance = 0
  for (let index = 0; index <= intervalCount; index += 1) {
    const targetDistance = index * spacing
    let first = path.points[segmentIndex]!
    let second = path.points[(segmentIndex + 1) % path.points.length]!
    let segmentLength = Math.hypot(second[0] - first[0], second[1] - first[1])
    while (
      segmentIndex < segmentCount - 1 &&
      (segmentLength === 0 ||
        targetDistance > segmentStartDistance + segmentLength)
    ) {
      segmentStartDistance += segmentLength
      segmentIndex += 1
      first = path.points[segmentIndex]!
      second = path.points[(segmentIndex + 1) % path.points.length]!
      segmentLength = Math.hypot(second[0] - first[0], second[1] - first[1])
    }
    const amount =
      segmentLength === 0
        ? 0
        : Math.min(
            1,
            Math.max(
              0,
              (targetDistance - segmentStartDistance) / segmentLength,
            ),
          )
    points.push(
      Object.freeze([
        first[0] + (second[0] - first[0]) * amount,
        first[1] + (second[1] - first[1]) * amount,
      ]) as Readonly<Point>,
    )
  }
  if (!path.closed) points.push(path.points.at(-1)!)
  budget.count += points.length
  return Object.freeze(points)
}

function signedTurns(
  points: readonly Readonly<Point>[],
  closed: boolean,
  tolerance: number,
): readonly number[] {
  if (points.length < 3) return Object.freeze([])
  const turns: number[] = []
  const start = closed ? 0 : 1
  const end = closed ? points.length : points.length - 1
  for (let index = start; index < end; index += 1) {
    const previous = points[(index - 1 + points.length) % points.length]!
    const current = points[index]!
    const next = points[(index + 1) % points.length]!
    const incomingX = current[0] - previous[0]
    const incomingY = current[1] - previous[1]
    const outgoingX = next[0] - current[0]
    const outgoingY = next[1] - current[1]
    const incomingLength = Math.hypot(incomingX, incomingY)
    const outgoingLength = Math.hypot(outgoingX, outgoingY)
    if (incomingLength <= tolerance || outgoingLength <= tolerance) continue
    const cross = incomingX * outgoingY - incomingY * outgoingX
    const dot = incomingX * outgoingX + incomingY * outgoingY
    const angle = Math.atan2(cross, dot)
    turns.push(
      Math.abs(angle) <= RELATIVE_TOLERANCE
        ? 0
        : Math.abs(Math.abs(angle) - Math.PI) <= CYCLIC_DESCRIPTOR_QUANTUM
          ? Math.sign(angle || 1) * Math.PI
          : quantizeDescriptor(angle) * CYCLIC_DESCRIPTOR_QUANTUM,
    )
  }
  return Object.freeze(turns)
}

function binIndex(coordinate: number, extent: number, count: number): number {
  // Half-open bins. The outer right/bottom edge belongs to the final bin.
  if (coordinate >= extent) return count - 1
  if (coordinate <= 0) return 0
  const position = (coordinate / extent) * count
  const nearestEdge = Math.round(position)
  const snapped =
    Math.abs(position - nearestEdge) <=
    RELATIVE_TOLERANCE * Math.max(1, Math.abs(position))
      ? nearestEdge
      : position
  return Math.min(count - 1, Math.floor(snapped))
}

function snapshotRegions(
  regionsValue: unknown,
): readonly Readonly<FlowingContoursReferenceRegion>[] {
  if (regionsValue === undefined) return Object.freeze([])
  if (!Array.isArray(regionsValue) || regionsValue.length > MAX_REGIONS) {
    fail('regions')
  }
  const names = new Set<string>()
  return Object.freeze(
    regionsValue.map((value, index) => {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        fail(`region ${index}`)
      }
      const region = value as Readonly<Record<string, unknown>>
      if (
        typeof region.name !== 'string' ||
        region.name.length === 0 ||
        names.has(region.name)
      ) {
        fail(`region ${index} name`)
      }
      names.add(region.name)
      const left = finite(region.left, `region ${index} left`)
      const top = finite(region.top, `region ${index} top`)
      const right = finite(region.right, `region ${index} right`)
      const bottom = finite(region.bottom, `region ${index} bottom`)
      if (
        left < 0 ||
        top < 0 ||
        right > 1 ||
        bottom > 1 ||
        left >= right ||
        top >= bottom
      ) {
        fail(`region ${index} bounds`)
      }
      return Object.freeze({ name: region.name, left, top, right, bottom })
    }),
  )
}

function pointInRegion(
  point: Readonly<Point>,
  region: Readonly<FlowingContoursReferenceRegion>,
  width: number,
  height: number,
  tolerance: number,
): boolean {
  const x = point[0] / width
  const y = point[1] / height
  const right =
    region.right === 1 ? x <= 1 + tolerance : x < region.right - tolerance
  const bottom =
    region.bottom === 1 ? y <= 1 + tolerance : y < region.bottom - tolerance
  return (
    x >= region.left - tolerance &&
    y >= region.top - tolerance &&
    right &&
    bottom
  )
}

function unitInterval(value: unknown, name: string): number {
  const result = finite(value, name)
  if (result < 0 || result > 1) fail(name)
  return result
}

function snapshotAcceptedSample(
  value: unknown,
  name: string,
): Readonly<ReferenceAcceptedSample> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail(name)
  }
  const sample = value as Readonly<Record<string, unknown>>
  const point = snapshotPoint(sample.point, `${name} point`)
  const tangent = snapshotPoint(sample.tangent, `${name} tangent`)
  const tangentLength = Math.hypot(tangent[0], tangent[1])
  if (
    !Number.isFinite(tangentLength) ||
    Math.abs(tangentLength - 1) > TANGENT_UNIT_TOLERANCE
  ) {
    fail(`${name} tangent unit`)
  }
  const coherence = unitInterval(sample.coherence, `${name} coherence`)
  const ambiguity = unitInterval(sample.ambiguity, `${name} ambiguity`)
  const scale = positive(sample.scale, `${name} scale`)
  const alpha = unitInterval(sample.alpha, `${name} alpha`)
  if (alpha <= 0) fail(`${name} alpha`)
  return Object.freeze({
    point,
    tangent,
    evidence: unitInterval(sample.evidence, `${name} evidence`),
    coherence,
    ambiguity,
    scale,
    alpha,
  })
}

function clampedDot(first: Readonly<Point>, second: Readonly<Point>): number {
  return Math.max(-1, Math.min(1, first[0] * second[0] + first[1] * second[1]))
}

function directSpanAlignment(
  samples: readonly Readonly<ReferenceAcceptedSample>[],
  start: number,
  end: number,
): number {
  let minimum = 1
  for (let index = start + 1; index <= end; index += 1) {
    minimum = Math.min(
      minimum,
      clampedDot(samples[index - 1]!.tangent, samples[index]!.tangent),
    )
  }
  return minimum
}

function gapSpanAlignment(
  samples: readonly Readonly<ReferenceAcceptedSample>[],
  start: number,
  end: number,
): number | null {
  const entry = samples[start]!
  let minimum = 1
  for (let index = start + 1; index <= end; index += 1) {
    const previous = samples[index - 1]!
    const sample = samples[index]!
    const displacementX = sample.point[0] - entry.point[0]
    const displacementY = sample.point[1] - entry.point[1]
    const displacementLength = Math.hypot(displacementX, displacementY)
    if (
      !Number.isFinite(displacementLength) ||
      displacementLength <= VECTOR_EPSILON
    ) {
      return null
    }
    const displacement = Object.freeze([
      displacementX / displacementLength,
      displacementY / displacementLength,
    ]) as Readonly<Point>
    minimum = Math.min(
      minimum,
      clampedDot(previous.tangent, sample.tangent),
      clampedDot(entry.tangent, sample.tangent),
      clampedDot(entry.tangent, displacement),
      clampedDot(sample.tangent, displacement),
    )
  }
  return minimum
}

/**
 * Backward-search spans retain their original growth alignment when assembled
 * into start-to-end trajectory order. Reversing both order and tangents
 * reconstructs that original direction without trusting the supplied scalar.
 */
function reversedGapSpanAlignment(
  samples: readonly Readonly<ReferenceAcceptedSample>[],
  start: number,
  end: number,
): number | null {
  const reversed = Object.freeze(
    samples
      .slice(start, end + 1)
      .reverse()
      .map((sample) =>
        Object.freeze({
          point: sample.point,
          tangent: Object.freeze([
            -sample.tangent[0],
            -sample.tangent[1],
          ]) as Readonly<Point>,
          evidence: sample.evidence,
          coherence: sample.coherence,
          ambiguity: sample.ambiguity,
          scale: sample.scale,
          alpha: sample.alpha,
        }),
      ),
  )
  return gapSpanAlignment(reversed, 0, reversed.length - 1)
}

function snapshotAcceptedEvidence(
  trajectoriesValue: unknown,
  diagnostics: Readonly<FlowingContoursReferenceDiagnostics>,
): Readonly<{
  endpointCount: number
  endpointReasonCounts: FlowingContoursEndpointReasonCounts
  maximumUnsupportedSpanLength: number
  totalUnsupportedSpanLength: number
  totalAcceptedTrajectoryLength: number
}> {
  if (
    !Array.isArray(trajectoriesValue) ||
    trajectoriesValue.length > MAX_PATHS
  ) {
    fail('accepted trajectories')
  }
  let rawPointCount = 0
  let maximumUnsupportedSpanLength = 0
  let totalUnsupportedSpanLength = 0
  let totalAcceptedTrajectoryLength = 0
  const endpointReasonCounts = Object.fromEntries(
    FLOWING_CONTOURS_ENDPOINT_REASONS.map((reason) => [reason, 0]),
  ) as Record<(typeof FLOWING_CONTOURS_ENDPOINT_REASONS)[number], number>

  for (let index = 0; index < trajectoriesValue.length; index += 1) {
    const trajectory = trajectoriesValue[
      index
    ] as Readonly<AcceptedFlowingTrajectory> | null
    if (trajectory === null || typeof trajectory !== 'object') {
      fail(`trajectory ${index}`)
    }
    if (!Array.isArray(trajectory.samples) || trajectory.samples.length < 2) {
      fail(`trajectory ${index} samples`)
    }
    rawPointCount += trajectory.samples.length
    if (rawPointCount > MAX_POINTS) fail('trajectory point cap')
    const samples: Readonly<ReferenceAcceptedSample>[] = []
    for (
      let sampleIndex = 0;
      sampleIndex < trajectory.samples.length;
      sampleIndex += 1
    ) {
      samples.push(
        snapshotAcceptedSample(
          trajectory.samples[sampleIndex],
          `trajectory ${index} sample ${sampleIndex}`,
        ),
      )
    }
    let measuredTrajectoryLength = 0
    for (let sampleIndex = 1; sampleIndex < samples.length; sampleIndex += 1) {
      const first = samples[sampleIndex - 1]!.point
      const second = samples[sampleIndex]!.point
      const segmentLength = Math.hypot(
        second[0] - first[0],
        second[1] - first[1],
      )
      if (!Number.isFinite(segmentLength) || segmentLength <= VECTOR_EPSILON) {
        fail(`trajectory ${index} degenerate sample segment`)
      }
      measuredTrajectoryLength += segmentLength
    }
    const suppliedTrajectoryLength = positive(
      trajectory.length,
      `trajectory ${index} length`,
    )
    if (
      !Number.isFinite(measuredTrajectoryLength) ||
      !provenanceNear(suppliedTrajectoryLength, measuredTrajectoryLength)
    ) {
      fail(`trajectory ${index} length mismatch`)
    }

    if (
      !Array.isArray(trajectory.spanSupport) ||
      trajectory.spanSupport.length < 1 ||
      trajectory.spanSupport.length > samples.length - 1
    ) {
      fail(`trajectory ${index} span provenance`)
    }
    let expectedStart = 0
    let measuredMaximumUnsupported = 0
    let measuredTotalUnsupported = 0
    for (
      let spanIndex = 0;
      spanIndex < trajectory.spanSupport.length;
      spanIndex += 1
    ) {
      const span = trajectory.spanSupport[spanIndex]
      if (span === null || typeof span !== 'object') {
        fail(`trajectory ${index} span ${spanIndex}`)
      }
      if (span.kind !== 'direct-evidence' && span.kind !== 'bounded-gap') {
        fail(`trajectory ${index} span ${spanIndex} kind`)
      }
      if (
        !Number.isSafeInteger(span.startSampleIndex) ||
        !Number.isSafeInteger(span.endSampleIndex) ||
        span.startSampleIndex !== expectedStart ||
        span.endSampleIndex <= span.startSampleIndex ||
        span.endSampleIndex >= samples.length
      ) {
        fail(`trajectory ${index} span ${spanIndex} indices`)
      }
      let measuredSpanLength = 0
      for (
        let sampleIndex = span.startSampleIndex + 1;
        sampleIndex <= span.endSampleIndex;
        sampleIndex += 1
      ) {
        const first = samples[sampleIndex - 1]!.point
        const second = samples[sampleIndex]!.point
        measuredSpanLength += Math.hypot(
          second[0] - first[0],
          second[1] - first[1],
        )
      }
      if (
        !Number.isFinite(measuredSpanLength) ||
        !provenanceNear(
          nonNegative(
            span.length,
            `trajectory ${index} span ${spanIndex} length`,
          ),
          measuredSpanLength,
        )
      ) {
        fail(`trajectory ${index} span ${spanIndex} length mismatch`)
      }
      const entryEvidence = unitInterval(
        span.entryEvidence,
        `trajectory ${index} span ${spanIndex} entry evidence`,
      )
      const exitEvidence = unitInterval(
        span.exitEvidence,
        `trajectory ${index} span ${spanIndex} exit evidence`,
      )
      const directionalAlignment = finite(
        span.directionalAlignment,
        `trajectory ${index} span ${spanIndex} directional alignment`,
      )
      if (directionalAlignment < -1 || directionalAlignment > 1) {
        fail(`trajectory ${index} span ${spanIndex} directional alignment`)
      }
      if (
        !Object.is(entryEvidence, samples[span.startSampleIndex]!.evidence) ||
        !Object.is(exitEvidence, samples[span.endSampleIndex]!.evidence)
      ) {
        fail(`trajectory ${index} span ${spanIndex} evidence mismatch`)
      }
      const expectedAlignment =
        span.kind === 'bounded-gap'
          ? gapSpanAlignment(
              samples,
              span.startSampleIndex,
              span.endSampleIndex,
            )
          : directSpanAlignment(
              samples,
              span.startSampleIndex,
              span.endSampleIndex,
            )
      const reversedGapAlignment =
        span.kind === 'bounded-gap'
          ? reversedGapSpanAlignment(
              samples,
              span.startSampleIndex,
              span.endSampleIndex,
            )
          : null
      const closingDirectSpan =
        span.kind === 'direct-evidence' &&
        spanIndex === trajectory.spanSupport.length - 1 &&
        span.endSampleIndex === samples.length - 1 &&
        Object.is(
          samples[span.endSampleIndex]!.point[0],
          samples[0]!.point[0],
        ) &&
        Object.is(samples[span.endSampleIndex]!.point[1], samples[0]!.point[1])
      let alignmentMatches =
        provenanceNear(directionalAlignment, expectedAlignment ?? Number.NaN) ||
        provenanceNear(directionalAlignment, reversedGapAlignment ?? Number.NaN)
      if (closingDirectSpan && expectedAlignment !== null) {
        const entry = samples[span.startSampleIndex]!
        const exit = samples[span.endSampleIndex]!
        const chordX = exit.point[0] - entry.point[0]
        const chordY = exit.point[1] - entry.point[1]
        const chordLength = Math.hypot(chordX, chordY)
        if (!Number.isFinite(chordLength) || chordLength <= VECTOR_EPSILON) {
          fail(`trajectory ${index} span ${spanIndex} degenerate closure`)
        }
        const chord = Object.freeze([
          chordX / chordLength,
          chordY / chordLength,
        ]) as Readonly<Point>
        const alignmentCeiling = Math.min(
          expectedAlignment,
          clampedDot(entry.tangent, chord),
          clampedDot(exit.tangent, chord),
        )
        // Search may retain an even lower sampled field alignment along the
        // closing chord. Production therefore validates a ceiling and floor,
        // rather than reconstructing an unavailable field sample here.
        alignmentMatches =
          directionalAlignment <= alignmentCeiling + PROVENANCE_TOLERANCE &&
          directionalAlignment >= LOOP_ALIGNMENT_FLOOR
      }
      if (expectedAlignment === null || !alignmentMatches) {
        fail(`trajectory ${index} span ${spanIndex} alignment mismatch`)
      }
      if (span.kind === 'bounded-gap') {
        if (
          span.endSampleIndex - span.startSampleIndex < 2 ||
          entryEvidence <= 0 ||
          exitEvidence <= 0 ||
          directionalAlignment < GAP_ALIGNMENT_FLOOR
        ) {
          fail(`trajectory ${index} span ${spanIndex} invalid gap`)
        }
        measuredMaximumUnsupported = Math.max(
          measuredMaximumUnsupported,
          measuredSpanLength,
        )
        measuredTotalUnsupported += measuredSpanLength
      } else if (
        samples
          .slice(span.startSampleIndex, span.endSampleIndex + 1)
          .some((sample) => sample.evidence <= 0)
      ) {
        fail(`trajectory ${index} span ${spanIndex} direct evidence`)
      }
      expectedStart = span.endSampleIndex
    }
    if (expectedStart !== samples.length - 1) {
      fail(`trajectory ${index} span coverage`)
    }

    const maximum = nonNegative(
      trajectory.maximumUnsupportedSpanLength,
      `trajectory ${index} maximum unsupported span`,
    )
    const total = nonNegative(
      trajectory.totalUnsupportedSpanLength,
      `trajectory ${index} total unsupported span`,
    )
    if (
      maximum > total ||
      (maximum === 0) !== (total === 0) ||
      !provenanceNear(maximum, measuredMaximumUnsupported) ||
      !provenanceNear(total, measuredTotalUnsupported)
    ) {
      fail(`trajectory ${index} unsupported provenance mismatch`)
    }
    maximumUnsupportedSpanLength = Math.max(
      maximumUnsupportedSpanLength,
      maximum,
    )
    totalUnsupportedSpanLength += total
    totalAcceptedTrajectoryLength += suppliedTrajectoryLength
    if (
      !FLOWING_CONTOURS_ENDPOINT_REASONS.includes(
        trajectory.startEndpointReason,
      )
    ) {
      fail(`trajectory ${index} start endpoint`)
    }
    if (
      !FLOWING_CONTOURS_ENDPOINT_REASONS.includes(trajectory.endEndpointReason)
    ) {
      fail(`trajectory ${index} end endpoint`)
    }
    endpointReasonCounts[trajectory.startEndpointReason] += 1
    endpointReasonCounts[trajectory.endEndpointReason] += 1
  }
  if (
    !Number.isSafeInteger(rawPointCount) ||
    !Number.isFinite(maximumUnsupportedSpanLength) ||
    !Number.isFinite(totalUnsupportedSpanLength) ||
    !Number.isFinite(totalAcceptedTrajectoryLength)
  ) {
    fail('accepted aggregate')
  }

  const diagnosticReasons = diagnostics.endpointReasonCounts
  if (diagnosticReasons === null || typeof diagnosticReasons !== 'object') {
    fail('diagnostic endpoint reasons')
  }
  for (const reason of FLOWING_CONTOURS_ENDPOINT_REASONS) {
    const count = safeCount(diagnosticReasons[reason], `diagnostic ${reason}`)
    if (count !== endpointReasonCounts[reason]) {
      fail(`diagnostic ${reason} mismatch`)
    }
  }
  if (
    safeCount(diagnostics.rawTrajectoryCount, 'diagnostic trajectory count') !==
      trajectoriesValue.length ||
    safeCount(
      diagnostics.rawTrajectoryPointCount,
      'diagnostic raw point count',
    ) !== rawPointCount ||
    !near(
      nonNegative(
        diagnostics.acceptedMaximumUnsupportedSpanLength,
        'diagnostic maximum unsupported span',
      ),
      maximumUnsupportedSpanLength,
    ) ||
    !near(
      nonNegative(
        diagnostics.acceptedTotalUnsupportedSpanLength,
        'diagnostic total unsupported span',
      ),
      totalUnsupportedSpanLength,
    )
  ) {
    fail('diagnostic accepted aggregate mismatch')
  }

  return Object.freeze({
    endpointCount: trajectoriesValue.length * 2,
    endpointReasonCounts: Object.freeze({ ...endpointReasonCounts }),
    maximumUnsupportedSpanLength,
    totalUnsupportedSpanLength,
    totalAcceptedTrajectoryLength,
  })
}

/**
 * Measure one final Scene and its retained accepted evidence.
 *
 * Length is the sum of Euclidean segments; a closed path adds exactly one
 * last-to-first segment. A repeated closed endpoint is removed first. Empty
 * valid inventories yield zeros (shares included). Percentiles use linear R-7
 * interpolation. Turn thresholds are strict (`>25°`, `>45°`) after the stated
 * numeric tolerance. Malformed, inconsistent, or over-cap inputs throw, so a
 * broken fixture cannot silently pass a visual-quality gate.
 */
export function measureFlowingContoursReference(
  input: Readonly<FlowingContoursReferenceMetricInput>,
): Readonly<FlowingContoursReferenceMetrics> {
  try {
    if (input === null || typeof input !== 'object' || Array.isArray(input)) {
      fail('root')
    }
    const scene = input.scene
    if (scene === null || typeof scene !== 'object') fail('scene')
    const width = positive(scene.space?.width, 'scene width')
    const height = positive(scene.space?.height, 'scene height')
    if (!Array.isArray(scene.primitives)) fail('scene primitives')
    if (scene.primitives.length > MAX_PATHS) fail('path cap')
    for (let index = 0; index < scene.primitives.length; index += 1) {
      if (!Object.prototype.hasOwnProperty.call(scene.primitives, index)) {
        fail('sparse primitives')
      }
    }
    const diagonal = positive(Math.hypot(width, height), 'scene diagonal')
    const coordinateTolerance = Math.max(1, diagonal) * RELATIVE_TOLERANCE
    const options = input.options
    if (
      options !== undefined &&
      (options === null ||
        typeof options !== 'object' ||
        Array.isArray(options))
    ) {
      fail('options')
    }
    const sampleSpacing = positive(
      options?.sampleSpacing ??
        diagonal *
          FLOWING_CONTOURS_REFERENCE_DEFAULTS.sampleSpacingDiagonalFraction,
      'sample spacing',
    )
    const shortPathLength = positive(
      options?.shortPathLength ??
        diagonal *
          FLOWING_CONTOURS_REFERENCE_DEFAULTS.shortPathDiagonalFraction,
      'short path length',
    )
    const longPathLength = positive(
      options?.longPathLength ??
        diagonal * FLOWING_CONTOURS_REFERENCE_DEFAULTS.longPathDiagonalFraction,
      'long path length',
    )
    if (shortPathLength >= longPathLength) fail('length thresholds')
    const coverageColumns = boundedInteger(
      options?.coverageColumns ??
        FLOWING_CONTOURS_REFERENCE_DEFAULTS.coverageColumns,
      'coverage columns',
      1,
      MAX_COVERAGE_AXIS_BINS,
    )
    const coverageRows = boundedInteger(
      options?.coverageRows ?? FLOWING_CONTOURS_REFERENCE_DEFAULTS.coverageRows,
      'coverage rows',
      1,
      MAX_COVERAGE_AXIS_BINS,
    )
    const regions = snapshotRegions(options?.regions)

    let pointCount = 0
    const paths = scene.primitives.map((primitive, index) => {
      if (primitive === null || typeof primitive !== 'object') {
        fail(`primitive ${index}`)
      }
      if (!primitive.stroke && !primitive.fill) fail(`primitive ${index} style`)
      if (!Array.isArray(primitive.points)) fail(`primitive ${index} points`)
      pointCount += primitive.points.length
      if (pointCount > MAX_POINTS) fail('scene point cap')
      const path = canonicalPath(
        primitive.points,
        primitive.closed,
        coordinateTolerance,
        index,
      )
      if (
        path.points.some(
          ([x, y]) =>
            x < -coordinateTolerance ||
            x > width + coordinateTolerance ||
            y < -coordinateTolerance ||
            y > height + coordinateTolerance,
        )
      ) {
        fail(`path ${index} outside Scene`)
      }
      return path
    })
    const diagnosticPrimitiveCount = safeCount(
      input.diagnostics?.primitiveCount,
      'diagnostic primitive count',
    )
    if (diagnosticPrimitiveCount !== paths.length) {
      fail('diagnostic primitive count mismatch')
    }
    if (paths.length !== input.acceptedTrajectories?.length) {
      fail('Scene/trajectory count mismatch')
    }
    const evidence = snapshotAcceptedEvidence(
      input.acceptedTrajectories,
      input.diagnostics,
    )

    const lengths = paths.map((path) => path.length)
    const totalPathLength = lengths.reduce((total, length) => total + length, 0)
    if (!Number.isFinite(totalPathLength)) fail('total path length')
    const shortPathCount = lengths.filter(
      (length) => length < shortPathLength,
    ).length
    const longPathIndices = paths.flatMap((path, index) =>
      path.length >= longPathLength ? [index] : [],
    )
    const longGeometryLength = longPathIndices.reduce(
      (total, index) => total + paths[index]!.length,
      0,
    )
    if (!Number.isFinite(longGeometryLength)) fail('long geometry length')
    const sampleBudget = { count: 0 }
    const sampled = paths.map((path) =>
      resample(path, sampleSpacing, coordinateTolerance, sampleBudget),
    )
    const turnsByPath = sampled.map((points, index) =>
      signedTurns(points, paths[index]!.closed, coordinateTolerance),
    )
    const turns = turnsByPath.flat()
    const absoluteTurnDegrees = turns.map(
      (turn) => (Math.abs(turn) * 180) / Math.PI,
    )
    const thresholdToleranceDegrees =
      (coordinateTolerance / Math.max(sampleSpacing, coordinateTolerance)) *
      (180 / Math.PI)
    const turnsOver25DegreesCount = absoluteTurnDegrees.filter(
      (turn) =>
        turn >
        FLOWING_CONTOURS_REFERENCE_DEFAULTS.turn25Degrees +
          thresholdToleranceDegrees,
    ).length
    const turnsOver45DegreesCount = absoluteTurnDegrees.filter(
      (turn) =>
        turn >
        FLOWING_CONTOURS_REFERENCE_DEFAULTS.turn45Degrees +
          thresholdToleranceDegrees,
    ).length
    const orthogonalTurnCount = absoluteTurnDegrees.filter(
      (turn) =>
        Math.abs(
          turn - FLOWING_CONTOURS_REFERENCE_DEFAULTS.orthogonalDegrees,
        ) <=
        FLOWING_CONTOURS_REFERENCE_DEFAULTS.orthogonalToleranceDegrees +
          thresholdToleranceDegrees,
    ).length
    let staircasePairCount = 0
    let possibleStaircasePairs = 0
    for (let pathIndex = 0; pathIndex < turnsByPath.length; pathIndex += 1) {
      const pathTurns = turnsByPath[pathIndex]!
      const meaningfulTurns = pathTurns.filter(
        (turn) =>
          (Math.abs(turn) * 180) / Math.PI >
          FLOWING_CONTOURS_REFERENCE_DEFAULTS.turn25Degrees +
            thresholdToleranceDegrees,
      )
      const pairCount =
        meaningfulTurns.length < 2
          ? 0
          : paths[pathIndex]!.closed
            ? meaningfulTurns.length
            : meaningfulTurns.length - 1
      possibleStaircasePairs += pairCount
      for (let index = 0; index < pairCount; index += 1) {
        const previous = meaningfulTurns[index]!
        const current = meaningfulTurns[(index + 1) % meaningfulTurns.length]!
        const previousDegrees = (Math.abs(previous) * 180) / Math.PI
        const currentDegrees = (Math.abs(current) * 180) / Math.PI
        if (
          Math.sign(previous) !== Math.sign(current) &&
          Math.abs(previousDegrees - 90) <=
            FLOWING_CONTOURS_REFERENCE_DEFAULTS.orthogonalToleranceDegrees +
              thresholdToleranceDegrees &&
          Math.abs(currentDegrees - 90) <=
            FLOWING_CONTOURS_REFERENCE_DEFAULTS.orthogonalToleranceDegrees +
              thresholdToleranceDegrees
        ) {
          staircasePairCount += 1
        }
      }
    }
    const occupiedBins = new Set<string>()
    const regionCounts = new Array<number>(regions.length).fill(0)
    for (const pathIndex of longPathIndices) {
      for (const point of sampled[pathIndex]!) {
        const column = binIndex(point[0], width, coverageColumns)
        const row = binIndex(point[1], height, coverageRows)
        occupiedBins.add(`${row},${column}`)
        for (
          let regionIndex = 0;
          regionIndex < regions.length;
          regionIndex += 1
        ) {
          if (
            pointInRegion(
              point,
              regions[regionIndex]!,
              width,
              height,
              RELATIVE_TOLERANCE,
            )
          ) {
            regionCounts[regionIndex] += 1
          }
        }
      }
    }
    const occupiedCoverageBins = Object.freeze(
      [...occupiedBins].sort((first, second) => {
        const [firstRow, firstColumn] = first.split(',').map(Number)
        const [secondRow, secondColumn] = second.split(',').map(Number)
        return firstRow! - secondRow! || firstColumn! - secondColumn!
      }),
    )
    const frozenRegions = Object.freeze(
      regions.map((region, index) =>
        Object.freeze({
          name: region.name,
          occupied: regionCounts[index]! > 0,
          sampledPointCount: regionCounts[index]!,
        }),
      ),
    )
    const endpointReasonCounts = Object.freeze({
      ...evidence.endpointReasonCounts,
    })
    const turnCount = turns.length
    const pathCount = paths.length
    const coverageBinCount = coverageColumns * coverageRows

    return Object.freeze({
      pathCount,
      shortPathCount,
      shortPathShare: pathCount === 0 ? 0 : shortPathCount / pathCount,
      medianPathLength: percentile(lengths, 0.5),
      upperQuartilePathLength: percentile(lengths, 0.75),
      longestPathLength: lengths.length === 0 ? 0 : Math.max(...lengths),
      totalPathLength,
      longPathCount: longPathIndices.length,
      longGeometryLength,
      longGeometryShare:
        totalPathLength === 0 ? 0 : longGeometryLength / totalPathLength,
      visibleEndpointCount: paths.reduce(
        (total, path) => total + (path.closed ? 0 : 2),
        0,
      ),
      endpointCount: evidence.endpointCount,
      endpointReasonCounts,
      maximumUnsupportedSpanLength: evidence.maximumUnsupportedSpanLength,
      totalUnsupportedSpanLength: evidence.totalUnsupportedSpanLength,
      totalAcceptedTrajectoryLength: evidence.totalAcceptedTrajectoryLength,
      sampledPathCount: sampled.length,
      sampledPointCount: sampleBudget.count,
      turnEnergy: turns.reduce((total, turn) => total + turn * turn, 0),
      turnCount,
      maximumTurnDegrees:
        absoluteTurnDegrees.length === 0
          ? 0
          : absoluteTurnDegrees.reduce(
              (maximum, turn) => Math.max(maximum, turn),
              0,
            ),
      turnsOver25DegreesCount,
      turnsOver25DegreesShare:
        turnCount === 0 ? 0 : turnsOver25DegreesCount / turnCount,
      turnsOver45DegreesCount,
      turnsOver45DegreesShare:
        turnCount === 0 ? 0 : turnsOver45DegreesCount / turnCount,
      orthogonalTurnCount,
      staircasePairCount,
      orthogonalStaircaseSignature:
        possibleStaircasePairs === 0
          ? 0
          : staircasePairCount / possibleStaircasePairs,
      coverageColumns,
      coverageRows,
      occupiedCoverageBins,
      occupiedCoverageBinCount: occupiedCoverageBins.length,
      occupiedCoverageBinShare: occupiedCoverageBins.length / coverageBinCount,
      regions: frozenRegions,
      sampleSpacing,
      shortPathLength,
      longPathLength,
      numericTolerance: coordinateTolerance,
    })
  } catch (error) {
    if (
      error instanceof TypeError &&
      error.message.startsWith('Invalid Flowing Contours reference input:')
    ) {
      throw error
    }
    fail('hostile accessor')
  }
}
