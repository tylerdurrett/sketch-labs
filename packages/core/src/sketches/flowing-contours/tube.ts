/**
 * Evidence-tube validation for Flowing Contours fitting.
 *
 * The corrected FC09/FC11 trajectory is immutable evidence, not a set of
 * disposable fit controls. A proposed polyline must carry monotonic raw-sample
 * correspondence. Each dense validation point is compared with only the
 * corresponding bounded raw subpath, which both prevents unsupported shortcuts
 * and avoids an unbounded global nearest-point search.
 *
 * The local radius is one quarter of the smaller adjacent FC05 analysis scale,
 * never less than 0.25 lattice pixels and never greater than 1.5. Direct spans
 * must also remain in the resolved FC05 evidence corridor. A bounded gap may be
 * weak only while its correspondence remains inside that exact recorded span;
 * positive alpha and the visible analysis extent remain mandatory everywhere.
 */

import type { Point } from '../../types'
import { sampleFlowingContoursField } from './field'
import { FLOWING_CONTOURS_LIMITS } from './limits'
import type {
  AcceptedFlowingTrajectory,
  CorrectedFlowingRidgeSample,
  FlowingContoursField,
  FlowingContoursFittingProvenance,
  FlowingContoursSpanSupportProvenance,
} from './types'

const VECTOR_EPSILON = 1e-12
const VALUE_TOLERANCE = 1e-8
const ENDPOINT_TOLERANCE = 1e-9
const TUBE_RADIUS_SCALE_FACTOR = 0.25
const MINIMUM_TUBE_RADIUS = 0.25
const VALIDATION_SAMPLE_SPACING = 0.25
const LOCAL_ARC_SEARCH_RADIUS = 2
const DIRECT_MINIMUM_EVIDENCE = 0.04
const DIRECT_MINIMUM_COHERENCE = 0.25
const DIRECT_MAXIMUM_AMBIGUITY = 0.7
const MINIMUM_DIRECTIONAL_ALIGNMENT = 0.5

/** A fit can never move farther than this many analysis-lattice pixels. */
export const FLOWING_CONTOURS_EVIDENCE_TUBE_HARD_MAX_RADIUS = 1.5

/**
 * Explicit ceiling across raw-corridor preparation or one validation call.
 *
 * The lower test seam is useful for proving that a hostile long segment is
 * rejected before dense sampling can become unbounded.
 */
export const FLOWING_CONTOURS_TUBE_MAX_VALIDATION_SAMPLES =
  4 * FLOWING_CONTOURS_LIMITS['raw-trajectory-point-count']

export interface FlowingContoursTubeValidationOptions {
  readonly maximumValidationSamples?: number
}

/** Opaque immutable evidence tube prepared from one accepted trajectory. */
export interface FlowingContoursEvidenceTube {
  readonly sourceTrajectoryId: number
  readonly rawSampleCount: number
  readonly evidenceTubeRadius: number
  readonly preparationSampleCount: number
}

/** One proposed fitted point and its authored raw-sample correspondence. */
export interface FlowingContoursTubePoint {
  readonly point: Readonly<Point>
  readonly sourceSampleIndex: number
}

export interface FlowingContoursTubePointValidation {
  readonly sourceSampleIndex: number
  readonly sourceSegmentIndex: number
  readonly supportKind: 'direct-evidence' | 'bounded-gap'
  readonly deviation: number
}

export interface FlowingContoursTubeSegment {
  readonly start: Readonly<FlowingContoursTubePoint>
  readonly end: Readonly<FlowingContoursTubePoint>
}

export interface FlowingContoursTubeSegmentValidation {
  readonly maximumDeviation: number
  readonly validationSampleCount: number
}

export interface FlowingContoursTubeCurve {
  readonly points: readonly Readonly<Point>[]
  readonly sourceSampleIndices: readonly number[]
}

export interface FlowingContoursTubeCurveValidation
  extends FlowingContoursFittingProvenance {
  readonly validationSampleCount: number
}

interface TubeData {
  readonly samples: readonly Readonly<CorrectedFlowingRidgeSample>[]
  readonly segmentSupport:
    readonly Readonly<FlowingContoursSpanSupportProvenance>[]
  readonly cumulativeLength: readonly number[]
  readonly segmentRadii: readonly number[]
}

interface LocatedArc {
  readonly segmentIndex: number
  readonly point: Readonly<Point>
  readonly tangent: Readonly<Point>
  readonly support: Readonly<FlowingContoursSpanSupportProvenance>
  readonly radius: number
  readonly deviation: number
}

interface MutableBudget {
  remaining: number
  consumed: number
}

const TUBE_DATA = new WeakMap<object, Readonly<TubeData>>()

function frozenPoint(x: number, y: number): Readonly<Point> {
  return Object.freeze([x, y] as Point)
}

function finitePoint(source: Readonly<Point>): Readonly<Point> | null {
  try {
    const x = source[0]
    const y = source[1]
    return Number.isFinite(x) && Number.isFinite(y)
      ? frozenPoint(x, y)
      : null
  } catch {
    return null
  }
}

function unit(x: number, y: number): Readonly<Point> | null {
  const length = Math.hypot(x, y)
  return Number.isFinite(length) && length > VECTOR_EPSILON
    ? frozenPoint(x / length, y / length)
    : null
}

function nearlyEqual(first: number, second: number): boolean {
  return (
    Number.isFinite(first) &&
    Number.isFinite(second) &&
    Math.abs(first - second) <=
      VALUE_TOLERANCE * Math.max(1, Math.abs(first), Math.abs(second))
  )
}

function samePoint(
  first: Readonly<Point>,
  second: Readonly<Point>,
  tolerance = VALUE_TOLERANCE,
): boolean {
  return (
    Number.isFinite(first[0]) &&
    Number.isFinite(first[1]) &&
    Number.isFinite(second[0]) &&
    Number.isFinite(second[1]) &&
    Math.hypot(first[0] - second[0], first[1] - second[1]) <= tolerance
  )
}

function resolveMaximumSamples(
  options: Readonly<FlowingContoursTubeValidationOptions>,
): number | null {
  try {
    const value =
      options.maximumValidationSamples ??
      FLOWING_CONTOURS_TUBE_MAX_VALIDATION_SAMPLES
    return Number.isSafeInteger(value) &&
      value >= 1 &&
      value <= FLOWING_CONTOURS_TUBE_MAX_VALIDATION_SAMPLES
      ? value
      : null
  } catch {
    return null
  }
}

function consume(budget: MutableBudget, count = 1): boolean {
  if (
    !Number.isSafeInteger(count) ||
    count < 0 ||
    count > budget.remaining
  ) {
    return false
  }
  budget.remaining -= count
  budget.consumed += count
  return true
}

function snapshotAndVerifySample(
  field: Readonly<FlowingContoursField>,
  source: Readonly<CorrectedFlowingRidgeSample>,
): Readonly<CorrectedFlowingRidgeSample> | null {
  try {
    const point = finitePoint(source.point)
    const tangent = unit(source.tangent[0], source.tangent[1])
    if (
      point === null ||
      tangent === null ||
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

    const sampled = sampleFlowingContoursField(field, point)
    if (
      sampled === null ||
      !nearlyEqual(sampled.evidence, source.evidence) ||
      !nearlyEqual(sampled.coherence, source.coherence) ||
      !nearlyEqual(sampled.ambiguity, source.ambiguity) ||
      !nearlyEqual(sampled.scale, source.scale) ||
      !nearlyEqual(sampled.alpha, source.alpha) ||
      Math.abs(
        sampled.tangent[0] * tangent[0] +
          sampled.tangent[1] * tangent[1],
      ) <
        1 - VALUE_TOLERANCE
    ) {
      return null
    }

    const tangentSign =
      sampled.tangent[0] * source.tangent[0] +
        sampled.tangent[1] * source.tangent[1] <
      0
        ? -1
        : 1
    return Object.freeze({
      point,
      tangent: frozenPoint(
        sampled.tangent[0] * tangentSign,
        sampled.tangent[1] * tangentSign,
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

function isResolvedEvidence(
  sample: Readonly<CorrectedFlowingRidgeSample>,
): boolean {
  return (
    sample.evidence >= DIRECT_MINIMUM_EVIDENCE &&
    sample.coherence >= DIRECT_MINIMUM_COHERENCE &&
    sample.ambiguity <= DIRECT_MAXIMUM_AMBIGUITY
  )
}

function localTubeRadius(
  first: Readonly<CorrectedFlowingRidgeSample>,
  second: Readonly<CorrectedFlowingRidgeSample>,
): number {
  return Math.min(
    FLOWING_CONTOURS_EVIDENCE_TUBE_HARD_MAX_RADIUS,
    Math.max(
      MINIMUM_TUBE_RADIUS,
      Math.min(first.scale, second.scale) * TUBE_RADIUS_SCALE_FACTOR,
    ),
  )
}

function maximumValue(values: readonly number[]): number | null {
  let maximum = -Infinity
  for (const value of values) {
    if (!Number.isFinite(value)) return null
    maximum = Math.max(maximum, value)
  }
  return Number.isFinite(maximum) ? maximum : null
}

function segmentDistance(
  point: Readonly<Point>,
  start: Readonly<Point>,
  end: Readonly<Point>,
): { readonly point: Readonly<Point>; readonly distance: number } | null {
  const dx = end[0] - start[0]
  const dy = end[1] - start[1]
  const lengthSquared = dx * dx + dy * dy
  if (!Number.isFinite(lengthSquared) || lengthSquared <= VECTOR_EPSILON) {
    return null
  }
  const projection = Math.max(
    0,
    Math.min(
      1,
      ((point[0] - start[0]) * dx + (point[1] - start[1]) * dy) /
        lengthSquared,
    ),
  )
  const nearest = frozenPoint(
    start[0] + dx * projection,
    start[1] + dy * projection,
  )
  const distance = Math.hypot(
    point[0] - nearest[0],
    point[1] - nearest[1],
  )
  return Number.isFinite(distance) ? { point: nearest, distance } : null
}

function snapshotSupport(
  trajectory: Readonly<AcceptedFlowingTrajectory>,
  samples: readonly Readonly<CorrectedFlowingRidgeSample>[],
): {
  readonly segmentSupport:
    readonly Readonly<FlowingContoursSpanSupportProvenance>[]
  readonly maximumGap: number
  readonly totalGap: number
} | null {
  try {
    if (samples.length < 2 || trajectory.spanSupport.length < 1) return null
    const segmentSupport = new Array<
      Readonly<FlowingContoursSpanSupportProvenance>
    >(samples.length - 1)
    let expectedStart = 0
    let maximumGap = 0
    let totalGap = 0

    for (const source of trajectory.spanSupport) {
      if (
        (source.kind !== 'direct-evidence' &&
          source.kind !== 'bounded-gap') ||
        !Number.isSafeInteger(source.startSampleIndex) ||
        !Number.isSafeInteger(source.endSampleIndex) ||
        source.startSampleIndex !== expectedStart ||
        source.endSampleIndex <= source.startSampleIndex ||
        source.endSampleIndex >= samples.length ||
        !Number.isFinite(source.length) ||
        source.length <= 0 ||
        !Number.isFinite(source.entryEvidence) ||
        source.entryEvidence < 0 ||
        source.entryEvidence > 1 ||
        !Number.isFinite(source.exitEvidence) ||
        source.exitEvidence < 0 ||
        source.exitEvidence > 1 ||
        !Number.isFinite(source.directionalAlignment) ||
        source.directionalAlignment < -1 ||
        source.directionalAlignment > 1 ||
        !nearlyEqual(
          source.entryEvidence,
          samples[source.startSampleIndex]!.evidence,
        ) ||
        !nearlyEqual(
          source.exitEvidence,
          samples[source.endSampleIndex]!.evidence,
        )
      ) {
        return null
      }

      let measuredLength = 0
      for (
        let index = source.startSampleIndex;
        index < source.endSampleIndex;
        index += 1
      ) {
        const first = samples[index]!
        const second = samples[index + 1]!
        const length = Math.hypot(
          second.point[0] - first.point[0],
          second.point[1] - first.point[1],
        )
        if (!Number.isFinite(length) || length <= VECTOR_EPSILON) return null
        measuredLength += length
      }
      if (!nearlyEqual(measuredLength, source.length)) return null

      const span = Object.freeze({
        kind: source.kind,
        startSampleIndex: source.startSampleIndex,
        endSampleIndex: source.endSampleIndex,
        length: source.length,
        entryEvidence: source.entryEvidence,
        exitEvidence: source.exitEvidence,
        directionalAlignment: source.directionalAlignment,
      })
      for (
        let index = source.startSampleIndex;
        index < source.endSampleIndex;
        index += 1
      ) {
        if (segmentSupport[index] !== undefined) return null
        segmentSupport[index] = span
      }
      if (source.kind === 'bounded-gap') {
        if (
          source.length >
          FLOWING_CONTOURS_LIMITS['weak-span-distance'] + VALUE_TOLERANCE
        ) {
          return null
        }
        maximumGap = Math.max(maximumGap, source.length)
        totalGap += source.length
      }
      expectedStart = source.endSampleIndex
    }

    if (
      expectedStart !== samples.length - 1 ||
      segmentSupport.some((support) => support === undefined) ||
      !nearlyEqual(maximumGap, trajectory.maximumUnsupportedSpanLength) ||
      !nearlyEqual(totalGap, trajectory.totalUnsupportedSpanLength)
    ) {
      return null
    }
    return {
      segmentSupport: Object.freeze(segmentSupport),
      maximumGap,
      totalGap,
    }
  } catch {
    return null
  }
}

function denseSampleCount(length: number): number | null {
  if (!Number.isFinite(length) || length < 0) return null
  const count = Math.max(1, Math.ceil(length / VALIDATION_SAMPLE_SPACING))
  return Number.isSafeInteger(count) ? count : null
}

function verifyRawCorridor(
  field: Readonly<FlowingContoursField>,
  samples: readonly Readonly<CorrectedFlowingRidgeSample>[],
  segmentSupport: readonly Readonly<FlowingContoursSpanSupportProvenance>[],
  budget: MutableBudget,
): boolean {
  for (let index = 0; index < samples.length - 1; index += 1) {
    const start = samples[index]!
    const end = samples[index + 1]!
    const length = Math.hypot(
      end.point[0] - start.point[0],
      end.point[1] - start.point[1],
    )
    const steps = denseSampleCount(length)
    if (steps === null || !consume(budget, steps + (index === 0 ? 1 : 0))) {
      return false
    }
    for (let step = index === 0 ? 0 : 1; step <= steps; step += 1) {
      const t = step / steps
      const sampled = sampleFlowingContoursField(field, [
        start.point[0] + (end.point[0] - start.point[0]) * t,
        start.point[1] + (end.point[1] - start.point[1]) * t,
      ])
      if (
        sampled === null ||
        (segmentSupport[index]!.kind === 'direct-evidence' &&
          !isResolvedEvidence(sampled))
      ) {
        return false
      }
    }
  }
  return true
}

function prepareTubeData(
  field: Readonly<FlowingContoursField>,
  trajectory: Readonly<AcceptedFlowingTrajectory>,
  budget: MutableBudget,
): Readonly<TubeData> | null {
  try {
    if (
      !Number.isSafeInteger(field.sourceWidth) ||
      field.sourceWidth <= 0 ||
      !Number.isSafeInteger(field.sourceHeight) ||
      field.sourceHeight <= 0 ||
      !Number.isSafeInteger(trajectory.id) ||
      trajectory.id < 0 ||
      trajectory.samples.length < 2 ||
      trajectory.samples.length >
        FLOWING_CONTOURS_LIMITS['raw-trajectory-point-count']
    ) {
      return null
    }

    const samples: Readonly<CorrectedFlowingRidgeSample>[] = []
    for (const source of trajectory.samples) {
      if (!consume(budget)) return null
      const sample = snapshotAndVerifySample(field, source)
      if (sample === null) return null
      samples.push(sample)
    }
    const frozenSamples = Object.freeze(samples)
    const support = snapshotSupport(trajectory, frozenSamples)
    if (support === null) return null

    const cumulativeLength = new Array<number>(samples.length)
    const segmentRadii = new Array<number>(samples.length - 1)
    cumulativeLength[0] = 0
    for (let index = 0; index < samples.length - 1; index += 1) {
      const first = samples[index]!
      const second = samples[index + 1]!
      const length = Math.hypot(
        second.point[0] - first.point[0],
        second.point[1] - first.point[1],
      )
      cumulativeLength[index + 1] = cumulativeLength[index]! + length
      segmentRadii[index] = localTubeRadius(first, second)
    }
    if (
      !Number.isFinite(cumulativeLength.at(-1)) ||
      !nearlyEqual(cumulativeLength.at(-1)!, trajectory.length) ||
      !verifyRawCorridor(
        field,
        frozenSamples,
        support.segmentSupport,
        budget,
      )
    ) {
      return null
    }

    return Object.freeze({
      samples: frozenSamples,
      segmentSupport: support.segmentSupport,
      cumulativeLength: Object.freeze(cumulativeLength),
      segmentRadii: Object.freeze(segmentRadii),
    })
  } catch {
    return null
  }
}

/**
 * Snapshot and validate one accepted corrected trajectory as an evidence tube.
 *
 * The input trajectory and all of its nested arrays/objects are only read.
 */
export function createFlowingContoursEvidenceTube(
  field: Readonly<FlowingContoursField>,
  trajectory: Readonly<AcceptedFlowingTrajectory>,
  options: Readonly<FlowingContoursTubeValidationOptions> = {},
): Readonly<FlowingContoursEvidenceTube> | null {
  const maximumSamples = resolveMaximumSamples(options)
  if (maximumSamples === null) return null
  const budget: MutableBudget = {
    remaining: maximumSamples,
    consumed: 0,
  }
  const data = prepareTubeData(field, trajectory, budget)
  if (data === null) return null
  const evidenceTubeRadius = maximumValue(data.segmentRadii)
  if (
    evidenceTubeRadius === null ||
    evidenceTubeRadius >
      FLOWING_CONTOURS_EVIDENCE_TUBE_HARD_MAX_RADIUS
  ) {
    return null
  }
  const tube = Object.freeze({
    sourceTrajectoryId: trajectory.id,
    rawSampleCount: data.samples.length,
    evidenceTubeRadius,
    preparationSampleCount: budget.consumed,
  })
  TUBE_DATA.set(tube, data)
  return tube
}

function tubeData(
  tube: Readonly<FlowingContoursEvidenceTube>,
): Readonly<TubeData> | null {
  try {
    const data = TUBE_DATA.get(tube)
    const maximumRadius =
      data === undefined ? null : maximumValue(data.segmentRadii)
    return data !== undefined &&
      maximumRadius !== null &&
      Object.isFrozen(tube) &&
      tube.sourceTrajectoryId >= 0 &&
      tube.rawSampleCount === data.samples.length &&
      nearlyEqual(tube.evidenceTubeRadius, maximumRadius)
      ? data
      : null
  } catch {
    return null
  }
}

function segmentAtArcLength(
  cumulativeLength: readonly number[],
  target: number,
  minimumSegment: number,
  maximumSegment: number,
): number {
  let low = minimumSegment
  let high = maximumSegment
  while (low < high) {
    const middle = Math.floor((low + high + 1) / 2)
    if (cumulativeLength[middle]! <= target) low = middle
    else high = middle - 1
  }
  return Math.min(maximumSegment, low)
}

function locateArc(
  data: Readonly<TubeData>,
  point: Readonly<Point>,
  startSampleIndex: number,
  endSampleIndex: number,
  progress: number,
): Readonly<LocatedArc> | null {
  const minimumSegment =
    endSampleIndex > startSampleIndex
      ? startSampleIndex
      : Math.max(0, Math.min(data.samples.length - 2, startSampleIndex - 1))
  const maximumSegment =
    endSampleIndex > startSampleIndex
      ? Math.min(data.samples.length - 2, endSampleIndex - 1)
      : minimumSegment
  const startLength = data.cumulativeLength[startSampleIndex]!
  const endLength = data.cumulativeLength[endSampleIndex]!
  const targetLength = startLength + (endLength - startLength) * progress
  const targetSegment = segmentAtArcLength(
    data.cumulativeLength,
    targetLength,
    minimumSegment,
    maximumSegment,
  )
  const searchStart = Math.max(
    minimumSegment,
    targetSegment - LOCAL_ARC_SEARCH_RADIUS,
  )
  const searchEnd = Math.min(
    maximumSegment,
    targetSegment + LOCAL_ARC_SEARCH_RADIUS,
  )

  let best:
    | {
        readonly segmentIndex: number
        readonly point: Readonly<Point>
        readonly deviation: number
      }
    | null = null
  for (let index = searchStart; index <= searchEnd; index += 1) {
    const nearest = segmentDistance(
      point,
      data.samples[index]!.point,
      data.samples[index + 1]!.point,
    )
    if (
      nearest !== null &&
      (best === null ||
        nearest.distance < best.deviation - VALUE_TOLERANCE ||
        (nearlyEqual(nearest.distance, best.deviation) &&
          index < best.segmentIndex))
    ) {
      best = {
        segmentIndex: index,
        point: nearest.point,
        deviation: nearest.distance,
      }
    }
  }
  if (best === null) return null

  const targetStart = data.samples[targetSegment]!
  const targetEnd = data.samples[targetSegment + 1]!
  const tangent =
    unit(
      targetEnd.point[0] - targetStart.point[0],
      targetEnd.point[1] - targetStart.point[1],
    ) ?? targetStart.tangent
  return Object.freeze({
    segmentIndex: targetSegment,
    point: best.point,
    tangent,
    support: data.segmentSupport[targetSegment]!,
    radius: data.segmentRadii[targetSegment]!,
    deviation: best.deviation,
  })
}

function validSourceIndex(index: number, data: Readonly<TubeData>): boolean {
  return (
    Number.isSafeInteger(index) &&
    index >= 0 &&
    index < data.samples.length
  )
}

function hasLocalNearestSampleCorrespondence(
  point: Readonly<Point>,
  sourceIndex: number,
  data: Readonly<TubeData>,
): boolean {
  const source = data.samples[sourceIndex]!.point
  const sourceDistance = Math.hypot(
    point[0] - source[0],
    point[1] - source[1],
  )
  const start = Math.max(0, sourceIndex - LOCAL_ARC_SEARCH_RADIUS)
  const end = Math.min(
    data.samples.length - 1,
    sourceIndex + LOCAL_ARC_SEARCH_RADIUS,
  )
  for (let index = start; index <= end; index += 1) {
    if (index === sourceIndex) continue
    const candidate = data.samples[index]!.point
    const candidateDistance = Math.hypot(
      point[0] - candidate[0],
      point[1] - candidate[1],
    )
    if (
      candidateDistance < sourceDistance - VALUE_TOLERANCE ||
      (nearlyEqual(candidateDistance, sourceDistance) && index < sourceIndex)
    ) {
      return false
    }
  }
  return true
}

/**
 * Validate one fitted point against its local corrected-raw neighborhood.
 */
export function validateFlowingContoursTubePoint(
  field: Readonly<FlowingContoursField>,
  tube: Readonly<FlowingContoursEvidenceTube>,
  proposal: Readonly<FlowingContoursTubePoint>,
): Readonly<FlowingContoursTubePointValidation> | null {
  try {
    const data = tubeData(tube)
    const point = finitePoint(proposal.point)
    if (
      data === null ||
      point === null ||
      !validSourceIndex(proposal.sourceSampleIndex, data) ||
      !hasLocalNearestSampleCorrespondence(
        point,
        proposal.sourceSampleIndex,
        data,
      ) ||
      (proposal.sourceSampleIndex === 0 &&
        !samePoint(point, data.samples[0]!.point, ENDPOINT_TOLERANCE)) ||
      (proposal.sourceSampleIndex === data.samples.length - 1 &&
        !samePoint(
          point,
          data.samples.at(-1)!.point,
          ENDPOINT_TOLERANCE,
        )) ||
      sampleFlowingContoursField(field, point) === null
    ) {
      return null
    }
    const sourceIndex = proposal.sourceSampleIndex
    const start = Math.max(0, sourceIndex - 1)
    const end = Math.min(data.samples.length - 1, sourceIndex + 1)
    const progress =
      end === start
        ? 0
        : (data.cumulativeLength[sourceIndex]! -
            data.cumulativeLength[start]!) /
          Math.max(
            VECTOR_EPSILON,
            data.cumulativeLength[end]! - data.cumulativeLength[start]!,
          )
    const located = locateArc(data, point, start, end, progress)
    const sampled = sampleFlowingContoursField(field, point)
    if (
      located === null ||
      sampled === null ||
      located.deviation > located.radius + VALUE_TOLERANCE ||
      (located.support.kind === 'direct-evidence' &&
        !isResolvedEvidence(sampled))
    ) {
      return null
    }
    return Object.freeze({
      sourceSampleIndex: sourceIndex,
      sourceSegmentIndex: located.segmentIndex,
      supportKind: located.support.kind,
      deviation: located.deviation,
    })
  } catch {
    return null
  }
}

function validateSegment(
  field: Readonly<FlowingContoursField>,
  data: Readonly<TubeData>,
  segment: Readonly<FlowingContoursTubeSegment>,
  budget: MutableBudget,
): Readonly<FlowingContoursTubeSegmentValidation> | null {
  const start = finitePoint(segment.start.point)
  const end = finitePoint(segment.end.point)
  const startIndex = segment.start.sourceSampleIndex
  const endIndex = segment.end.sourceSampleIndex
  if (
    start === null ||
    end === null ||
    !validSourceIndex(startIndex, data) ||
    !validSourceIndex(endIndex, data) ||
    startIndex > endIndex ||
    !hasLocalNearestSampleCorrespondence(start, startIndex, data) ||
    !hasLocalNearestSampleCorrespondence(end, endIndex, data) ||
    (startIndex === 0 &&
      !samePoint(start, data.samples[0]!.point, ENDPOINT_TOLERANCE)) ||
    (endIndex === data.samples.length - 1 &&
      !samePoint(end, data.samples.at(-1)!.point, ENDPOINT_TOLERANCE))
  ) {
    return null
  }
  const dx = end[0] - start[0]
  const dy = end[1] - start[1]
  const direction = unit(dx, dy)
  const length = Math.hypot(dx, dy)
  const steps = denseSampleCount(length)
  if (
    direction === null ||
    steps === null ||
    !consume(budget, steps + 1)
  ) {
    return null
  }

  let maximumDeviation = 0
  for (let step = 0; step <= steps; step += 1) {
    const progress = step / steps
    const point = frozenPoint(start[0] + dx * progress, start[1] + dy * progress)
    const sampled = sampleFlowingContoursField(field, point)
    const located = locateArc(data, point, startIndex, endIndex, progress)
    if (
      sampled === null ||
      located === null ||
      located.deviation > located.radius + VALUE_TOLERANCE ||
      Math.abs(
        direction[0] * located.tangent[0] +
          direction[1] * located.tangent[1],
      ) <
        MINIMUM_DIRECTIONAL_ALIGNMENT ||
      (located.support.kind === 'direct-evidence' &&
        !isResolvedEvidence(sampled))
    ) {
      return null
    }
    maximumDeviation = Math.max(maximumDeviation, located.deviation)
  }
  return Object.freeze({
    maximumDeviation,
    validationSampleCount: steps + 1,
  })
}

/**
 * Densely validate one proposed segment against its bounded source subpath.
 */
export function validateFlowingContoursTubeSegment(
  field: Readonly<FlowingContoursField>,
  tube: Readonly<FlowingContoursEvidenceTube>,
  segment: Readonly<FlowingContoursTubeSegment>,
  options: Readonly<FlowingContoursTubeValidationOptions> = {},
): Readonly<FlowingContoursTubeSegmentValidation> | null {
  try {
    const data = tubeData(tube)
    const maximumSamples = resolveMaximumSamples(options)
    if (data === null || maximumSamples === null) return null
    return validateSegment(field, data, segment, {
      remaining: maximumSamples,
      consumed: 0,
    })
  } catch {
    return null
  }
}

/**
 * Validate a complete fitted polyline and produce existing fitting provenance.
 *
 * Endpoints must remain exactly on the raw source endpoints. Correspondence is
 * monotonic, so no segment can reverse or jump outside its authored raw span.
 */
export function validateFlowingContoursTubeCurve(
  field: Readonly<FlowingContoursField>,
  tube: Readonly<FlowingContoursEvidenceTube>,
  curve: Readonly<FlowingContoursTubeCurve>,
  options: Readonly<FlowingContoursTubeValidationOptions> = {},
): Readonly<FlowingContoursTubeCurveValidation> | null {
  try {
    const data = tubeData(tube)
    const maximumSamples = resolveMaximumSamples(options)
    if (
      data === null ||
      maximumSamples === null ||
      !Array.isArray(curve.points) ||
      !Array.isArray(curve.sourceSampleIndices) ||
      curve.points.length < 2 ||
      curve.points.length !== curve.sourceSampleIndices.length ||
      curve.points.length >
        FLOWING_CONTOURS_LIMITS['fitted-curve-point-count'] ||
      curve.sourceSampleIndices[0] !== 0 ||
      curve.sourceSampleIndices.at(-1) !== data.samples.length - 1
    ) {
      return null
    }

    const points: Readonly<Point>[] = []
    const indices: number[] = []
    for (let index = 0; index < curve.points.length; index += 1) {
      const point = finitePoint(curve.points[index]!)
      const sourceIndex = curve.sourceSampleIndices[index]!
      if (
        point === null ||
        !validSourceIndex(sourceIndex, data) ||
        !hasLocalNearestSampleCorrespondence(point, sourceIndex, data) ||
        (index > 0 && sourceIndex < indices[index - 1]!)
      ) {
        return null
      }
      points.push(point)
      indices.push(sourceIndex)
    }
    if (
      !samePoint(points[0]!, data.samples[0]!.point, ENDPOINT_TOLERANCE) ||
      !samePoint(
        points.at(-1)!,
        data.samples.at(-1)!.point,
        ENDPOINT_TOLERANCE,
      )
    ) {
      return null
    }

    const budget: MutableBudget = {
      remaining: maximumSamples,
      consumed: 0,
    }
    let maximumDeviation = 0
    for (let index = 1; index < points.length; index += 1) {
      const validation = validateSegment(
        field,
        data,
        {
          start: {
            point: points[index - 1]!,
            sourceSampleIndex: indices[index - 1]!,
          },
          end: {
            point: points[index]!,
            sourceSampleIndex: indices[index]!,
          },
        },
        budget,
      )
      if (validation === null) return null
      maximumDeviation = Math.max(
        maximumDeviation,
        validation.maximumDeviation,
      )
    }

    return Object.freeze({
      sourceTrajectoryId: tube.sourceTrajectoryId,
      sourceSampleIndices: Object.freeze(indices),
      evidenceTubeRadius: tube.evidenceTubeRadius,
      maximumDeviation,
      validationSampleCount: budget.consumed,
    })
  } catch {
    return null
  }
}
