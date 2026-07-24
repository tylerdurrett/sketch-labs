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
 * weak only while its correspondence remains inside that exact recorded span
 * and its recomputed directional alignment is at least 0.75. Positive alpha
 * and the visible analysis extent remain mandatory everywhere.
 */

import type { Point } from '../../types'
import {
  sampleFlowingContoursEvidenceInto,
  sampleFlowingContoursField,
  type FlowingContoursEvidenceSampleScratch,
} from './field'
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
const DIRECT_MINIMUM_EVIDENCE = 0.04
const DIRECT_MINIMUM_COHERENCE = 0.25
const DIRECT_MAXIMUM_AMBIGUITY = 0.7
const ARC_COORDINATE_TOLERANCE = 1e-8
const NEAREST_SAMPLE_CELL_SIZE = MINIMUM_TUBE_RADIUS

/** A fit can never move farther than this many analysis-lattice pixels. */
export const FLOWING_CONTOURS_EVIDENCE_TUBE_HARD_MAX_RADIUS = 1.5

/** Hard directional proof floor for every retained bounded-gap span. */
export const FLOWING_CONTOURS_BOUNDED_GAP_ALIGNMENT_FLOOR = 0.75

/** Signed raw-segment progress floor relative to one proposed fit segment. */
export const FLOWING_CONTOURS_TUBE_DIRECTIONAL_ALIGNMENT_FLOOR = 0.5

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
  readonly validationSampleCount: number
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
  readonly field: Readonly<FlowingContoursField>
  readonly samples: readonly Readonly<CorrectedFlowingRidgeSample>[]
  readonly segmentSupport:
    readonly Readonly<FlowingContoursSpanSupportProvenance>[]
  readonly cumulativeLength: readonly number[]
  readonly segmentRadii: readonly number[]
  readonly nearestSamples: Readonly<NearestSampleIndex>
}

interface NearestSampleIndex {
  readonly width: number
  readonly height: number
  readonly cellSize: number
  readonly buckets: ReadonlyMap<number, readonly number[]>
}

interface LocatedArc {
  readonly segmentIndex: number
  readonly segmentProgress: number
  readonly arcCoordinate: number
  readonly tangent: Readonly<Point>
  readonly support: Readonly<FlowingContoursSpanSupportProvenance>
  readonly radius: number
  readonly deviation: number
}

interface MutableBudget {
  remaining: number
  consumed: number
}

interface SegmentEvaluation {
  readonly progress: number
  readonly located: Readonly<LocatedArc>
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

function sameExactPoint(
  first: Readonly<Point>,
  second: Readonly<Point>,
): boolean {
  return (
    Object.is(first[0], second[0]) &&
    Object.is(first[1], second[1])
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
  sample: Readonly<FlowingContoursEvidenceSampleScratch>,
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
): {
  readonly progress: number
  readonly distance: number
} | null {
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
  return Number.isFinite(distance) ? { progress: projection, distance } : null
}

function isImmutableField(field: Readonly<FlowingContoursField>): boolean {
  try {
    return (
      Object.isFrozen(field) &&
      Object.isFrozen(field.luminance) &&
      Object.isFrozen(field.alpha) &&
      Object.isFrozen(field.positiveSupport) &&
      Object.isFrozen(field.contourEvidence) &&
      Object.isFrozen(field.tangentX) &&
      Object.isFrozen(field.tangentY) &&
      Object.isFrozen(field.tangentCoherence) &&
      Object.isFrozen(field.ambiguity) &&
      Object.isFrozen(field.ridgeScale)
    )
  } catch {
    return false
  }
}

function recomputeGapAlignment(
  samples: readonly Readonly<CorrectedFlowingRidgeSample>[],
  startIndex: number,
  endIndex: number,
): number | null {
  const entry = samples[startIndex]!
  let minimum = 1
  for (let index = startIndex + 1; index <= endIndex; index += 1) {
    const sample = samples[index]!
    const displacement = unit(
      sample.point[0] - entry.point[0],
      sample.point[1] - entry.point[1],
    )
    if (displacement === null) return null
    minimum = Math.min(
      minimum,
      entry.tangent[0] * sample.tangent[0] +
        entry.tangent[1] * sample.tangent[1],
      entry.tangent[0] * displacement[0] +
        entry.tangent[1] * displacement[1],
      sample.tangent[0] * displacement[0] +
        sample.tangent[1] * displacement[1],
    )
  }
  return Number.isFinite(minimum) ? minimum : null
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
        (source.kind === 'direct-evidence'
          ? source.directionalAlignment < -1
          : source.directionalAlignment < 0) ||
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

      if (source.kind === 'bounded-gap') {
        const entry = samples[source.startSampleIndex]!
        const exit = samples[source.endSampleIndex]!
        const measuredAlignment = recomputeGapAlignment(
          samples,
          source.startSampleIndex,
          source.endSampleIndex,
        )
        if (
          !isResolvedEvidence(entry) ||
          !isResolvedEvidence(exit) ||
          measuredAlignment === null ||
          measuredAlignment <
            FLOWING_CONTOURS_BOUNDED_GAP_ALIGNMENT_FLOOR ||
          source.directionalAlignment <
            FLOWING_CONTOURS_BOUNDED_GAP_ALIGNMENT_FLOOR
        ) {
          return null
        }
      }

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

function verifyRawCorridor(
  field: Readonly<FlowingContoursField>,
  samples: readonly Readonly<CorrectedFlowingRidgeSample>[],
  segmentSupport: readonly Readonly<FlowingContoursSpanSupportProvenance>[],
  budget: MutableBudget,
): boolean {
  const sampled: FlowingContoursEvidenceSampleScratch = {
    evidence: 0,
    coherence: 0,
    ambiguity: 0,
  }
  for (let index = 0; index < samples.length - 1; index += 1) {
    const start = samples[index]!
    const end = samples[index + 1]!
    const parameters = latticeTraversalParameters(
      start.point,
      end.point,
      budget,
    )
    if (parameters === null) return false
    for (const progress of parameters) {
      if (!consume(budget)) return false
      const hasSample = sampleFlowingContoursEvidenceInto(
        field,
        [
          start.point[0] +
            (end.point[0] - start.point[0]) * progress,
          start.point[1] +
            (end.point[1] - start.point[1]) * progress,
        ],
        sampled,
      )
      if (
        !hasSample ||
        (segmentSupport[index]!.kind === 'direct-evidence' &&
          !isResolvedEvidence(sampled))
      ) {
        return false
      }
    }
    for (
      let parameterIndex = 0;
      parameterIndex + 2 < parameters.length;
      parameterIndex += 2
    ) {
      if (
        !proveScalarPermissionInterval(
          field,
          start.point,
          end.point,
          parameters[parameterIndex]!,
          parameters[parameterIndex + 2]!,
          segmentSupport[index]!.kind === 'direct-evidence',
          budget,
        )
      ) {
        return false
      }
    }
  }
  return true
}

function buildNearestSampleIndex(
  field: Readonly<FlowingContoursField>,
  samples: readonly Readonly<CorrectedFlowingRidgeSample>[],
  budget: MutableBudget,
): Readonly<NearestSampleIndex> | null {
  const width = Math.floor((field.width - 1) / NEAREST_SAMPLE_CELL_SIZE) + 1
  const height = Math.floor((field.height - 1) / NEAREST_SAMPLE_CELL_SIZE) + 1
  if (
    !Number.isSafeInteger(width) ||
    width < 1 ||
    !Number.isSafeInteger(height) ||
    height < 1 ||
    !consume(budget, samples.length)
  ) {
    return null
  }
  const mutable = new Map<number, number[]>()
  for (let index = 0; index < samples.length; index += 1) {
    const point = samples[index]!.point
    const x = Math.max(
      0,
      Math.min(width - 1, Math.floor(point[0] / NEAREST_SAMPLE_CELL_SIZE)),
    )
    const y = Math.max(
      0,
      Math.min(height - 1, Math.floor(point[1] / NEAREST_SAMPLE_CELL_SIZE)),
    )
    const cell = y * width + x
    const bucket = mutable.get(cell)
    if (bucket === undefined) mutable.set(cell, [index])
    else bucket.push(index)
  }
  const buckets = new Map<number, readonly number[]>()
  for (const [cell, indices] of mutable) {
    buckets.set(cell, Object.freeze(indices))
  }
  return Object.freeze({
    width,
    height,
    cellSize: NEAREST_SAMPLE_CELL_SIZE,
    buckets,
  })
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
      !isImmutableField(field) ||
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
    const nearestSamples = buildNearestSampleIndex(
      field,
      frozenSamples,
      budget,
    )
    if (nearestSamples === null) return null

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
      field,
      samples: frozenSamples,
      segmentSupport: support.segmentSupport,
      cumulativeLength: Object.freeze(cumulativeLength),
      segmentRadii: Object.freeze(segmentRadii),
      nearestSamples,
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
  field: Readonly<FlowingContoursField>,
  tube: Readonly<FlowingContoursEvidenceTube>,
): Readonly<TubeData> | null {
  try {
    const data = TUBE_DATA.get(tube)
    const maximumRadius =
      data === undefined ? null : maximumValue(data.segmentRadii)
    return data !== undefined &&
      maximumRadius !== null &&
      field === data.field &&
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

function locateArc(
  data: Readonly<TubeData>,
  point: Readonly<Point>,
  startSampleIndex: number,
  endSampleIndex: number,
  budget: MutableBudget,
): Readonly<LocatedArc> | null {
  const minimumSegment =
    endSampleIndex > startSampleIndex
      ? startSampleIndex
      : Math.max(0, Math.min(data.samples.length - 2, startSampleIndex - 1))
  const maximumSegment =
    endSampleIndex > startSampleIndex
      ? Math.min(data.samples.length - 2, endSampleIndex - 1)
      : minimumSegment
  const segmentCount = maximumSegment - minimumSegment + 1
  if (!consume(budget, segmentCount)) return null

  let best:
    | {
        readonly segmentIndex: number
        readonly progress: number
        readonly deviation: number
      }
    | null = null
  for (let index = minimumSegment; index <= maximumSegment; index += 1) {
    const nearest = segmentDistance(
      point,
      data.samples[index]!.point,
      data.samples[index + 1]!.point,
    )
    if (
      nearest !== null &&
      (best === null ||
        nearest.distance < best.deviation ||
        (nearest.distance === best.deviation &&
          (index < best.segmentIndex ||
            (index === best.segmentIndex &&
              nearest.progress < best.progress))))
    ) {
      best = {
        segmentIndex: index,
        progress: nearest.progress,
        deviation: nearest.distance,
      }
    }
  }
  if (best === null) return null

  const targetStart = data.samples[best.segmentIndex]!
  const targetEnd = data.samples[best.segmentIndex + 1]!
  const tangent =
    unit(
      targetEnd.point[0] - targetStart.point[0],
      targetEnd.point[1] - targetStart.point[1],
    ) ?? targetStart.tangent
  return Object.freeze({
    segmentIndex: best.segmentIndex,
    segmentProgress: best.progress,
    arcCoordinate:
      data.cumulativeLength[best.segmentIndex]! +
      (data.cumulativeLength[best.segmentIndex + 1]! -
        data.cumulativeLength[best.segmentIndex]!) *
        best.progress,
    tangent,
    support: data.segmentSupport[best.segmentIndex]!,
    radius: data.segmentRadii[best.segmentIndex]!,
    deviation: best.deviation,
  })
}

function minimumTubeRadius(
  data: Readonly<TubeData>,
  startSampleIndex: number,
  endSampleIndex: number,
  budget: MutableBudget,
): number | null {
  const minimumSegment =
    endSampleIndex > startSampleIndex
      ? startSampleIndex
      : Math.max(0, Math.min(data.samples.length - 2, startSampleIndex - 1))
  const maximumSegment =
    endSampleIndex > startSampleIndex
      ? Math.min(data.samples.length - 2, endSampleIndex - 1)
      : minimumSegment
  if (!consume(budget, maximumSegment - minimumSegment + 1)) return null
  let minimum = Infinity
  for (let index = minimumSegment; index <= maximumSegment; index += 1) {
    minimum = Math.min(minimum, data.segmentRadii[index]!)
  }
  return Number.isFinite(minimum) ? minimum : null
}

function validSourceIndex(index: number, data: Readonly<TubeData>): boolean {
  return (
    Number.isSafeInteger(index) &&
    index >= 0 &&
    index < data.samples.length
  )
}

function nearestSourceSampleIndex(
  point: Readonly<Point>,
  data: Readonly<TubeData>,
  budget: MutableBudget,
): number | null {
  if (
    point[0] < 0 ||
    point[1] < 0 ||
    point[0] > data.field.width - 1 ||
    point[1] > data.field.height - 1
  ) {
    return null
  }
  const spatial = data.nearestSamples
  const centerX = Math.max(
    0,
    Math.min(
      spatial.width - 1,
      Math.floor(point[0] / spatial.cellSize),
    ),
  )
  const centerY = Math.max(
    0,
    Math.min(
      spatial.height - 1,
      Math.floor(point[1] / spatial.cellSize),
    ),
  )
  let nearestIndex = -1
  let nearestDistance = Infinity
  const maximumRing = Math.max(spatial.width, spatial.height)
  for (let ring = 0; ring < maximumRing; ring += 1) {
    const minimumX = Math.max(0, centerX - ring)
    const maximumX = Math.min(spatial.width - 1, centerX + ring)
    const minimumY = Math.max(0, centerY - ring)
    const maximumY = Math.min(spatial.height - 1, centerY + ring)
    for (let y = minimumY; y <= maximumY; y += 1) {
      for (let x = minimumX; x <= maximumX; x += 1) {
        if (
          ring > 0 &&
          x !== minimumX &&
          x !== maximumX &&
          y !== minimumY &&
          y !== maximumY
        ) {
          continue
        }
        if (!consume(budget)) return null
        const bucket = spatial.buckets.get(y * spatial.width + x)
        if (bucket === undefined) continue
        if (!consume(budget, bucket.length)) return null
        for (const index of bucket) {
          const candidate = data.samples[index]!.point
          const distance = Math.hypot(
            point[0] - candidate[0],
            point[1] - candidate[1],
          )
          if (
            distance < nearestDistance ||
            (distance === nearestDistance && index < nearestIndex)
          ) {
            nearestIndex = index
            nearestDistance = distance
          }
        }
      }
    }

    const outsideDistances = [
      minimumX > 0
        ? point[0] - minimumX * spatial.cellSize
        : Infinity,
      maximumX < spatial.width - 1
        ? (maximumX + 1) * spatial.cellSize - point[0]
        : Infinity,
      minimumY > 0
        ? point[1] - minimumY * spatial.cellSize
        : Infinity,
      maximumY < spatial.height - 1
        ? (maximumY + 1) * spatial.cellSize - point[1]
        : Infinity,
    ]
    const outsideLowerBound = Math.min(...outsideDistances)
    if (
      nearestIndex >= 0 &&
      outsideLowerBound > nearestDistance
    ) {
      return nearestIndex
    }
    if (!Number.isFinite(outsideLowerBound)) break
  }
  return nearestIndex >= 0 ? nearestIndex : null
}

function matchesNearestSourceSample(
  point: Readonly<Point>,
  sourceIndex: number,
  data: Readonly<TubeData>,
  budget: MutableBudget,
): boolean {
  const nearestIndex = nearestSourceSampleIndex(point, data, budget)
  if (nearestIndex === sourceIndex) return true
  const lastIndex = data.samples.length - 1
  return (
    (sourceIndex === 0 || sourceIndex === lastIndex) &&
    (nearestIndex === 0 || nearestIndex === lastIndex) &&
    sameExactPoint(
      data.samples[0]!.point,
      data.samples[lastIndex]!.point,
    ) &&
    samePoint(
      point,
      data.samples[sourceIndex]!.point,
      ENDPOINT_TOLERANCE,
    )
  )
}

function proveSignedRawProgress(
  data: Readonly<TubeData>,
  startSampleIndex: number,
  endSampleIndex: number,
  direction: Readonly<Point>,
  budget: MutableBudget,
): boolean {
  const segmentCount = endSampleIndex - startSampleIndex
  if (segmentCount < 0 || !consume(budget, segmentCount)) return false
  for (
    let index = startSampleIndex;
    index < endSampleIndex;
    index += 1
  ) {
    const start = data.samples[index]!.point
    const end = data.samples[index + 1]!.point
    const rawDirection = unit(end[0] - start[0], end[1] - start[1])
    if (
      rawDirection === null ||
      rawDirection[0] * direction[0] +
        rawDirection[1] * direction[1] <
        FLOWING_CONTOURS_TUBE_DIRECTIONAL_ALIGNMENT_FLOOR
    ) {
      return false
    }
  }
  return true
}

function latticeTraversalParameters(
  start: Readonly<Point>,
  end: Readonly<Point>,
  budget: MutableBudget,
): readonly number[] | null {
  const parameters = [0, 1]
  for (let axis = 0; axis < 2; axis += 1) {
    const first = axis === 0 ? start[0] : start[1]
    const second = axis === 0 ? end[0] : end[1]
    const delta = second - first
    if (Math.abs(delta) <= VECTOR_EPSILON) continue
    const lower = Math.min(first, second)
    const upper = Math.max(first, second)
    const firstBoundary = Math.floor(lower) + 1
    const lastBoundary = Math.ceil(upper) - 1
    const crossingCount = Math.max(0, lastBoundary - firstBoundary + 1)
    if (
      !Number.isSafeInteger(crossingCount) ||
      !consume(budget, crossingCount)
    ) {
      return null
    }
    for (
      let boundary = firstBoundary;
      boundary <= lastBoundary;
      boundary += 1
    ) {
      const progress = (boundary - first) / delta
      if (progress > 0 && progress < 1 && Number.isFinite(progress)) {
        parameters.push(progress)
      }
    }
  }
  parameters.sort((first, second) => first - second)
  const crossings = parameters.filter(
    (value, index) =>
      index === 0 ||
      Math.abs(value - parameters[index - 1]!) > VALUE_TOLERANCE,
  )
  const complete: number[] = []
  for (let index = 0; index < crossings.length; index += 1) {
    const value = crossings[index]!
    complete.push(value)
    const next = crossings[index + 1]
    if (next !== undefined) complete.push((value + next) / 2)
  }
  if (!consume(budget, complete.length)) return null
  return Object.freeze(complete)
}

function bilinearScalar(
  values: readonly number[],
  width: number,
  height: number,
  point: Readonly<Point>,
): number | null {
  const x = point[0]
  const y = point[1]
  if (
    x < 0 ||
    y < 0 ||
    x > width - 1 ||
    y > height - 1
  ) {
    return null
  }
  const left = Math.floor(x)
  const top = Math.floor(y)
  const right = Math.min(width - 1, left + 1)
  const bottom = Math.min(height - 1, top + 1)
  const horizontal = x - left
  const vertical = y - top
  const topValue =
    values[top * width + left]! * (1 - horizontal) +
    values[top * width + right]! * horizontal
  const bottomValue =
    values[bottom * width + left]! * (1 - horizontal) +
    values[bottom * width + right]! * horizontal
  const value = topValue * (1 - vertical) + bottomValue * vertical
  return Number.isFinite(value) ? value : null
}

function bilinearSupport(
  values: readonly boolean[],
  width: number,
  height: number,
  point: Readonly<Point>,
): number | null {
  const numeric = (index: number): number => (values[index] ? 1 : 0)
  const x = point[0]
  const y = point[1]
  if (x < 0 || y < 0 || x > width - 1 || y > height - 1) return null
  const left = Math.floor(x)
  const top = Math.floor(y)
  const right = Math.min(width - 1, left + 1)
  const bottom = Math.min(height - 1, top + 1)
  const horizontal = x - left
  const vertical = y - top
  const topValue =
    numeric(top * width + left) * (1 - horizontal) +
    numeric(top * width + right) * horizontal
  const bottomValue =
    numeric(bottom * width + left) * (1 - horizontal) +
    numeric(bottom * width + right) * horizontal
  const value = topValue * (1 - vertical) + bottomValue * vertical
  return Number.isFinite(value) ? value : null
}

function quadraticMinimum(
  start: number,
  middle: number,
  end: number,
): number | null {
  if (
    !Number.isFinite(start) ||
    !Number.isFinite(middle) ||
    !Number.isFinite(end)
  ) {
    return null
  }
  const quadratic = 2 * (end + start - 2 * middle)
  const linear = end - start - quadratic
  let minimum = Math.min(start, end)
  if (quadratic > VECTOR_EPSILON) {
    const critical = -linear / (2 * quadratic)
    if (critical > 0 && critical < 1) {
      minimum = Math.min(
        minimum,
        start + linear * critical + quadratic * critical * critical,
      )
    }
  }
  return Number.isFinite(minimum) ? minimum : null
}

function proveScalarPermissionInterval(
  field: Readonly<FlowingContoursField>,
  segmentStart: Readonly<Point>,
  segmentEnd: Readonly<Point>,
  startProgress: number,
  endProgress: number,
  directEvidence: boolean,
  budget: MutableBudget,
): boolean {
  if (!consume(budget)) return false
  const middleProgress = (startProgress + endProgress) / 2
  const pointAt = (progress: number): Readonly<Point> =>
    frozenPoint(
      segmentStart[0] +
        (segmentEnd[0] - segmentStart[0]) * progress,
      segmentStart[1] +
        (segmentEnd[1] - segmentStart[1]) * progress,
    )
  const progressValues = [
    startProgress,
    middleProgress,
    endProgress,
  ] as const
  const alphaValues: number[] = []
  const supportValues: number[] = []
  const evidenceValues: number[] = []
  for (const progress of progressValues) {
    const point = pointAt(progress)
    const alpha = bilinearScalar(
      field.alpha,
      field.width,
      field.height,
      point,
    )
    const support = bilinearSupport(
      field.positiveSupport,
      field.width,
      field.height,
      point,
    )
    const evidence = directEvidence
      ? bilinearScalar(
          field.contourEvidence,
          field.width,
          field.height,
          point,
        )
      : 1
    if (alpha === null || support === null || evidence === null) return false
    alphaValues.push(alpha)
    supportValues.push(support)
    evidenceValues.push(evidence)
  }
  const alphaMinimum = quadraticMinimum(
    alphaValues[0]!,
    alphaValues[1]!,
    alphaValues[2]!,
  )
  const supportMinimum = quadraticMinimum(
    supportValues[0]!,
    supportValues[1]!,
    supportValues[2]!,
  )
  const evidenceMinimum = quadraticMinimum(
    evidenceValues[0]!,
    evidenceValues[1]!,
    evidenceValues[2]!,
  )
  return (
    alphaMinimum !== null &&
    alphaMinimum > 0 &&
    supportMinimum !== null &&
    supportMinimum > 0 &&
    evidenceMinimum !== null &&
    (!directEvidence ||
      evidenceMinimum >= DIRECT_MINIMUM_EVIDENCE - VALUE_TOLERANCE)
  )
}

function proveScalarPermissionRange(
  field: Readonly<FlowingContoursField>,
  segmentStart: Readonly<Point>,
  segmentEnd: Readonly<Point>,
  startProgress: number,
  endProgress: number,
  directEvidence: boolean,
  budget: MutableBudget,
): boolean {
  const rangeStart = frozenPoint(
    segmentStart[0] +
      (segmentEnd[0] - segmentStart[0]) * startProgress,
    segmentStart[1] +
      (segmentEnd[1] - segmentStart[1]) * startProgress,
  )
  const rangeEnd = frozenPoint(
    segmentStart[0] +
      (segmentEnd[0] - segmentStart[0]) * endProgress,
    segmentStart[1] +
      (segmentEnd[1] - segmentStart[1]) * endProgress,
  )
  const parameters = latticeTraversalParameters(rangeStart, rangeEnd, budget)
  if (parameters === null) return false
  for (let index = 0; index + 2 < parameters.length; index += 2) {
    if (
      !proveScalarPermissionInterval(
        field,
        rangeStart,
        rangeEnd,
        parameters[index]!,
        parameters[index + 2]!,
        directEvidence,
        budget,
      )
    ) {
      return false
    }
  }
  return true
}

function proveCapsuleInterval(
  startProgress: number,
  endProgress: number,
  start: Readonly<SegmentEvaluation>,
  end: Readonly<SegmentEvaluation>,
  segmentLength: number,
  minimumRadius: number,
  evaluate: (progress: number) => Readonly<SegmentEvaluation> | null,
  provePermission: (
    startProgress: number,
    endProgress: number,
    support: Readonly<FlowingContoursSpanSupportProvenance>,
  ) => boolean,
  cumulativeLength: readonly number[],
  depth = 0,
): boolean {
  if (
    start.located.arcCoordinate >
      end.located.arcCoordinate + ARC_COORDINATE_TOLERANCE ||
    depth >= 64
  ) {
    return false
  }
  const middleProgress = (startProgress + endProgress) / 2
  if (
    middleProgress === startProgress ||
    middleProgress === endProgress
  ) {
    return false
  }
  const middle = evaluate(middleProgress)
  if (
    middle === null ||
    middle.located.arcCoordinate + ARC_COORDINATE_TOLERANCE <
      start.located.arcCoordinate ||
    end.located.arcCoordinate + ARC_COORDINATE_TOLERANCE <
      middle.located.arcCoordinate
  ) {
    return false
  }
  const intervalLength = segmentLength * (endProgress - startProgress)
  const support = middle.located.support
  const supportStart = cumulativeLength[support.startSampleIndex]!
  const supportEnd = cumulativeLength[support.endSampleIndex]!
  const remainsInsideOneAuthoredSpan =
    start.located.arcCoordinate >=
      supportStart - ARC_COORDINATE_TOLERANCE &&
    end.located.arcCoordinate <= supportEnd + ARC_COORDINATE_TOLERANCE
  const doesNotSkipRawArc =
    end.located.arcCoordinate - start.located.arcCoordinate <=
    intervalLength + 2 * minimumRadius + ARC_COORDINATE_TOLERANCE
  if (
    remainsInsideOneAuthoredSpan &&
    doesNotSkipRawArc &&
    middle.located.deviation + intervalLength / 2 <=
    minimumRadius + VALUE_TOLERANCE
  ) {
    return provePermission(startProgress, endProgress, support)
  }
  return (
    proveCapsuleInterval(
      startProgress,
      middleProgress,
      start,
      middle,
      segmentLength,
      minimumRadius,
      evaluate,
      provePermission,
      cumulativeLength,
      depth + 1,
    ) &&
    proveCapsuleInterval(
      middleProgress,
      endProgress,
      middle,
      end,
      segmentLength,
      minimumRadius,
      evaluate,
      provePermission,
      cumulativeLength,
      depth + 1,
    )
  )
}

/**
 * Validate one fitted point against its local corrected-raw neighborhood.
 */
export function validateFlowingContoursTubePoint(
  field: Readonly<FlowingContoursField>,
  tube: Readonly<FlowingContoursEvidenceTube>,
  proposal: Readonly<FlowingContoursTubePoint>,
  options: Readonly<FlowingContoursTubeValidationOptions> = {},
): Readonly<FlowingContoursTubePointValidation> | null {
  try {
    const data = tubeData(field, tube)
    const maximumSamples = resolveMaximumSamples(options)
    const point = finitePoint(proposal.point)
    if (
      data === null ||
      maximumSamples === null ||
      point === null ||
      !validSourceIndex(proposal.sourceSampleIndex, data) ||
      (proposal.sourceSampleIndex === 0 &&
        !samePoint(point, data.samples[0]!.point, ENDPOINT_TOLERANCE)) ||
      (proposal.sourceSampleIndex === data.samples.length - 1 &&
        !samePoint(
          point,
          data.samples.at(-1)!.point,
          ENDPOINT_TOLERANCE,
        ))
    ) {
      return null
    }
    const sampled: FlowingContoursEvidenceSampleScratch = {
      evidence: 0,
      coherence: 0,
      ambiguity: 0,
    }
    if (!sampleFlowingContoursEvidenceInto(field, point, sampled)) {
      return null
    }
    const budget: MutableBudget = {
      remaining: maximumSamples,
      consumed: 0,
    }
    if (
      !matchesNearestSourceSample(
        point,
        proposal.sourceSampleIndex,
        data,
        budget,
      )
    ) {
      return null
    }
    const sourceIndex = proposal.sourceSampleIndex
    const start = Math.max(0, sourceIndex - 1)
    const end = Math.min(data.samples.length - 1, sourceIndex + 1)
    const located = locateArc(data, point, start, end, budget)
    const hasResolvedSample = sampleFlowingContoursEvidenceInto(
      field,
      point,
      sampled,
    )
    if (
      located === null ||
      !hasResolvedSample ||
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
      validationSampleCount: budget.consumed,
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
  endpointsCertified = false,
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
    (!endpointsCertified &&
      !matchesNearestSourceSample(start, startIndex, data, budget)) ||
    (!endpointsCertified &&
      !matchesNearestSourceSample(end, endIndex, data, budget)) ||
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
  const minimumRadius = minimumTubeRadius(
    data,
    startIndex,
    endIndex,
    budget,
  )
  if (direction === null || !Number.isFinite(length) || minimumRadius === null) {
    return null
  }
  if (
    !proveSignedRawProgress(
      data,
      startIndex,
      endIndex,
      direction,
      budget,
    )
  ) {
    return null
  }

  let maximumDeviation = 0
  const cache = new Map<number, Readonly<SegmentEvaluation>>()
  const sampled: FlowingContoursEvidenceSampleScratch = {
    evidence: 0,
    coherence: 0,
    ambiguity: 0,
  }
  const evaluate = (
    progress: number,
  ): Readonly<SegmentEvaluation> | null => {
    const cached = cache.get(progress)
    if (cached !== undefined) return cached
    if (!consume(budget)) return null
    const point = frozenPoint(start[0] + dx * progress, start[1] + dy * progress)
    const hasSample = sampleFlowingContoursEvidenceInto(field, point, sampled)
    const located = locateArc(data, point, startIndex, endIndex, budget)
    if (
      !hasSample ||
      located === null ||
      located.deviation > located.radius + VALUE_TOLERANCE ||
      direction[0] * located.tangent[0] +
          direction[1] * located.tangent[1] <
        FLOWING_CONTOURS_TUBE_DIRECTIONAL_ALIGNMENT_FLOOR ||
      (located.support.kind === 'direct-evidence' &&
        !isResolvedEvidence(sampled))
    ) {
      return null
    }
    maximumDeviation = Math.max(maximumDeviation, located.deviation)
    const result = Object.freeze({ progress, located })
    cache.set(progress, result)
    return result
  }

  const parameters = latticeTraversalParameters(start, end, budget)
  if (parameters === null) return null
  let previous: Readonly<SegmentEvaluation> | null = null
  for (const progress of parameters) {
    const evaluation = evaluate(progress)
    if (
      evaluation === null ||
      (previous !== null &&
        evaluation.located.arcCoordinate + ARC_COORDINATE_TOLERANCE <
          previous.located.arcCoordinate)
    ) {
      return null
    }
    previous = evaluation
  }
  for (let index = 0; index + 2 < parameters.length; index += 2) {
    const startProgress = parameters[index]!
    const middleProgress = parameters[index + 1]!
    const endProgress = parameters[index + 2]!
    const middle = cache.get(middleProgress)
    if (
      middle === undefined ||
      !proveScalarPermissionInterval(
        field,
        start,
        end,
        startProgress,
        endProgress,
        middle.located.support.kind === 'direct-evidence',
        budget,
      )
    ) {
      return null
    }
  }

  const first = evaluate(0)
  const last = evaluate(1)
  const provePermission = (
    startProgress: number,
    endProgress: number,
    support: Readonly<FlowingContoursSpanSupportProvenance>,
  ): boolean =>
    proveScalarPermissionRange(
      field,
      start,
      end,
      startProgress,
      endProgress,
      support.kind === 'direct-evidence',
      budget,
    )
  if (
    first === null ||
    last === null ||
    !proveCapsuleInterval(
      0,
      1,
      first,
      last,
      length,
      minimumRadius,
      evaluate,
      provePermission,
      data.cumulativeLength,
    )
  ) {
    return null
  }
  return Object.freeze({
    maximumDeviation,
    validationSampleCount: budget.consumed,
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
    const data = tubeData(field, tube)
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
    const data = tubeData(field, tube)
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
    const budget: MutableBudget = {
      remaining: maximumSamples,
      consumed: 0,
    }
    for (let index = 0; index < curve.points.length; index += 1) {
      const point = finitePoint(curve.points[index]!)
      const sourceIndex = curve.sourceSampleIndices[index]!
      if (
        point === null ||
        !validSourceIndex(sourceIndex, data) ||
        !matchesNearestSourceSample(point, sourceIndex, data, budget) ||
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
        true,
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
