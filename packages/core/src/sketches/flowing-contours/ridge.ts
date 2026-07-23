/**
 * One bounded predictor-corrector step along a Flowing Contours ridge.
 *
 * The step stays continuous: it predicts along the sign-aligned tangent, then
 * corrects only across that direction with a small odd normal stencil. It does
 * not continue gaps or choose between search hypotheses; those policies belong
 * to directional growth.
 */

import type { Point } from '../../types'
import { sampleFlowingContoursField } from './field'
import {
  FLOWING_CONTOURS_LIMITS,
  isWithinFlowingContoursLimit,
  type FlowingContoursLimits,
} from './limits'
import type { CorrectedFlowingRidgeSample, FlowingContoursField } from './types'

const VECTOR_EPSILON = 1e-12
const EVIDENCE_EPSILON = 1e-12
const ORIENTATION_COHERENCE_EPSILON = 1e-9
const SCALE_EPSILON = 1e-9
const HARD_MAXIMUM_STEP_LENGTH = 4
const HARD_MAXIMUM_NORMAL_RADIUS = 3
const NORMAL_RADIUS_SCALE_FACTOR = 0.75
const MINIMUM_NORMAL_RADIUS = 0.5
const MAXIMUM_ADJACENT_SCALE_RATIO = 2 + 1e-6
/** Correction ownership is always narrower than half an analysis pixel. */
const HARD_MAXIMUM_OWNERSHIP_RADIUS = 0.49
const SUPPORT_TRAVERSAL_SPACING = 0.25
const MAXIMUM_SUPPORT_TRAVERSAL_SAMPLE_COUNT = 64

const DEFAULT_OPTIONS = Object.freeze({
  stepLength: 0.75,
  minimumEvidence: 0.04,
  minimumCoherence: 0.25,
  maximumAmbiguity: 0.7,
  maximumTurnRadians: Math.PI / 3,
  ambiguityMargin: 0.04,
  minimumTangentAlignment: 0,
})

/**
 * Finite local policy knobs consumed later by directional growth.
 *
 * Values may only tighten or select behavior inside the private hard bounds.
 * Invalid values fail closed with `safety-limit`.
 */
export interface FlowingRidgeStepOptions {
  readonly stepLength?: number
  readonly minimumEvidence?: number
  readonly minimumCoherence?: number
  readonly maximumAmbiguity?: number
  readonly maximumTurnRadians?: number
  readonly ambiguityMargin?: number
  readonly minimumTangentAlignment?: number
}

interface ResolvedFlowingRidgeStepOptions {
  readonly stepLength: number
  readonly minimumEvidence: number
  readonly minimumCoherence: number
  readonly maximumAmbiguity: number
  readonly maximumTurnRadians: number
  readonly ambiguityMargin: number
  readonly minimumTangentAlignment: number
}

interface RidgeStepBase {
  readonly predictedPoint: Readonly<Point>
  readonly normalSampleCount: number
}

export interface CorrectedFlowingRidgeStep extends RidgeStepBase {
  readonly kind: 'corrected'
  readonly sample: Readonly<CorrectedFlowingRidgeSample>
}

/**
 * A supported predicted point that did not yield an admissible ridge maximum.
 *
 * FC09 may inspect `sample` while managing a provisional weak span. This
 * module never promotes that span or searches beyond this one prediction.
 */
export interface WeakFlowingRidgeStep extends RidgeStepBase {
  readonly kind: 'weak'
  readonly sample: Readonly<CorrectedFlowingRidgeSample> | null
}

export type StoppedFlowingRidgeStep = RidgeStepBase &
  Readonly<{
    kind:
      | 'source-boundary'
      | 'alpha-boundary'
      | 'ambiguity'
      | 'curvature'
      | 'safety-limit'
  }>

export type FlowingRidgeStepResult =
  | CorrectedFlowingRidgeStep
  | WeakFlowingRidgeStep
  | StoppedFlowingRidgeStep

interface StencilSample {
  readonly index: number
  readonly offset: number
  readonly sample: Readonly<CorrectedFlowingRidgeSample>
}

function frozenPoint(x: number, y: number): Readonly<Point> {
  return Object.freeze([x, y] as Point)
}

const ZERO_POINT = frozenPoint(0, 0)

function finiteUnitVector(vector: Readonly<Point>): Readonly<Point> | null {
  const x = vector[0]
  const y = vector[1]
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null
  const length = Math.hypot(x, y)
  if (!Number.isFinite(length) || length <= VECTOR_EPSILON) return null
  return frozenPoint(x / length, y / length)
}

function signAlignedUnitVector(
  tangent: Readonly<Point>,
  direction: Readonly<Point>,
): Readonly<Point> | null {
  const unit = finiteUnitVector(tangent)
  if (unit === null) return null
  const sign = unit[0] * direction[0] + unit[1] * direction[1] < 0 ? -1 : 1
  return frozenPoint(unit[0] * sign, unit[1] * sign)
}

function isUnitInterval(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= 1
}

function resolveOptions(
  options: Readonly<FlowingRidgeStepOptions>,
): ResolvedFlowingRidgeStepOptions | null {
  try {
    const resolved = { ...DEFAULT_OPTIONS, ...options }
    if (
      !Number.isFinite(resolved.stepLength) ||
      resolved.stepLength <= 0 ||
      resolved.stepLength > HARD_MAXIMUM_STEP_LENGTH ||
      !isUnitInterval(resolved.minimumEvidence) ||
      !isUnitInterval(resolved.minimumCoherence) ||
      !isUnitInterval(resolved.maximumAmbiguity) ||
      !Number.isFinite(resolved.maximumTurnRadians) ||
      resolved.maximumTurnRadians <= 0 ||
      resolved.maximumTurnRadians > Math.PI / 2 ||
      !isUnitInterval(resolved.ambiguityMargin) ||
      !isUnitInterval(resolved.minimumTangentAlignment)
    ) {
      return null
    }
    return Object.freeze(resolved)
  } catch {
    return null
  }
}

function hasFieldShape(field: Readonly<FlowingContoursField>): boolean {
  try {
    const sampleCount = field.width * field.height
    return (
      Number.isSafeInteger(field.width) &&
      field.width > 0 &&
      Number.isSafeInteger(field.height) &&
      field.height > 0 &&
      Number.isSafeInteger(sampleCount) &&
      field.luminance.length === sampleCount &&
      field.alpha.length === sampleCount &&
      field.positiveSupport.length === sampleCount &&
      field.contourEvidence.length === sampleCount &&
      field.tangentX.length === sampleCount &&
      field.tangentY.length === sampleCount &&
      field.tangentCoherence.length === sampleCount &&
      field.ambiguity.length === sampleCount &&
      field.ridgeScale.length === sampleCount
    )
  } catch {
    return false
  }
}

function isInsideField(
  field: Readonly<FlowingContoursField>,
  point: Readonly<Point>,
): boolean {
  return (
    Number.isFinite(point[0]) &&
    Number.isFinite(point[1]) &&
    point[0] >= 0 &&
    point[1] >= 0 &&
    point[0] <= field.width - 1 &&
    point[1] <= field.height - 1
  )
}

/**
 * Check every bounded subpixel interval and lattice-line intersection.
 *
 * Uniform quarter-pixel probes catch positive-width holes; exact vertical and
 * horizontal lattice crossings catch a one-sample transparent column or row
 * even when the uniform partition would otherwise step over its zero.
 */
function hasPositiveSupportAlongSegment(
  field: Readonly<FlowingContoursField>,
  start: Readonly<Point>,
  end: Readonly<Point>,
): boolean {
  const dx = end[0] - start[0]
  const dy = end[1] - start[1]
  const distance = Math.hypot(dx, dy)
  if (!Number.isFinite(distance)) return false

  const parameters = [0, 1]
  const intervalCount = Math.max(
    1,
    Math.ceil(distance / SUPPORT_TRAVERSAL_SPACING),
  )
  for (let index = 1; index < intervalCount; index += 1) {
    parameters.push(index / intervalCount)
  }
  if (Math.abs(dx) > VECTOR_EPSILON) {
    const minimumX = Math.min(start[0], end[0])
    const maximumX = Math.max(start[0], end[0])
    for (let x = Math.ceil(minimumX); x <= Math.floor(maximumX); x += 1) {
      parameters.push((x - start[0]) / dx)
    }
  }
  if (Math.abs(dy) > VECTOR_EPSILON) {
    const minimumY = Math.min(start[1], end[1])
    const maximumY = Math.max(start[1], end[1])
    for (let y = Math.ceil(minimumY); y <= Math.floor(maximumY); y += 1) {
      parameters.push((y - start[1]) / dy)
    }
  }
  if (parameters.length > MAXIMUM_SUPPORT_TRAVERSAL_SAMPLE_COUNT) return false

  parameters.sort((left, right) => left - right)
  let previous = Number.NEGATIVE_INFINITY
  for (const parameter of parameters) {
    if (
      !Number.isFinite(parameter) ||
      parameter < 0 ||
      parameter > 1 ||
      Math.abs(parameter - previous) <= VECTOR_EPSILON
    ) {
      continue
    }
    previous = parameter
    const point = frozenPoint(
      start[0] + dx * parameter,
      start[1] + dy * parameter,
    )
    if (sampleFlowingContoursField(field, point) === null) return false
  }
  return true
}

function boundedOddNormalSampleCount(
  limits: Readonly<FlowingContoursLimits>,
): number | null {
  try {
    const count = limits['normal-search-sample-count']
    if (
      !isWithinFlowingContoursLimit(
        'normal-search-sample-count',
        count,
        limits,
      ) ||
      count < 1
    ) {
      return null
    }
    const bounded = Math.min(
      count,
      FLOWING_CONTOURS_LIMITS['normal-search-sample-count'],
    )
    return bounded % 2 === 0 ? bounded - 1 : bounded
  } catch {
    return null
  }
}

function isFiniteCurrentSample(
  sample: Readonly<CorrectedFlowingRidgeSample>,
  point: Readonly<Point>,
): boolean {
  return (
    Number.isFinite(point[0]) &&
    Number.isFinite(point[1]) &&
    Number.isFinite(sample.evidence) &&
    sample.evidence >= 0 &&
    sample.evidence <= 1 &&
    Number.isFinite(sample.coherence) &&
    sample.coherence >= 0 &&
    sample.coherence <= 1 &&
    Number.isFinite(sample.ambiguity) &&
    sample.ambiguity >= 0 &&
    sample.ambiguity <= 1 &&
    Number.isFinite(sample.scale) &&
    sample.scale > 0 &&
    Number.isFinite(sample.alpha) &&
    sample.alpha > 0 &&
    sample.alpha <= 1
  )
}

function hasResolvedOrientation(
  sample: Readonly<CorrectedFlowingRidgeSample>,
): boolean {
  return (
    Number.isFinite(sample.coherence) &&
    sample.coherence > ORIENTATION_COHERENCE_EPSILON &&
    finiteUnitVector(sample.tangent) !== null
  )
}

function adjacentScale(current: number, next: number): boolean {
  if (
    !Number.isFinite(current) ||
    current <= SCALE_EPSILON ||
    !Number.isFinite(next) ||
    next <= SCALE_EPSILON
  ) {
    return false
  }
  return (
    Math.max(current, next) / Math.min(current, next) <=
    MAXIMUM_ADJACENT_SCALE_RATIO
  )
}

function compatibleSample(
  sample: Readonly<CorrectedFlowingRidgeSample>,
  predictedDirection: Readonly<Point>,
  currentScale: number,
  options: Readonly<ResolvedFlowingRidgeStepOptions>,
): Readonly<Point> | null {
  if (
    sample.alpha <= 0 ||
    !hasResolvedOrientation(sample) ||
    sample.evidence + EVIDENCE_EPSILON < options.minimumEvidence ||
    sample.coherence < options.minimumCoherence ||
    sample.ambiguity > options.maximumAmbiguity ||
    !adjacentScale(currentScale, sample.scale)
  ) {
    return null
  }
  const tangent = signAlignedUnitVector(sample.tangent, predictedDirection)
  if (tangent === null) return null
  const alignment =
    tangent[0] * predictedDirection[0] + tangent[1] * predictedDirection[1]
  return alignment >= options.minimumTangentAlignment ? tangent : null
}

function alignedWeakSample(
  sample: Readonly<CorrectedFlowingRidgeSample> | null,
  direction: Readonly<Point>,
): Readonly<CorrectedFlowingRidgeSample> | null {
  if (sample === null) return null
  const tangent = signAlignedUnitVector(sample.tangent, direction)
  if (tangent === null) return null
  return Object.freeze({
    ...sample,
    point: frozenPoint(sample.point[0], sample.point[1]),
    tangent,
  })
}

function stop(
  kind: StoppedFlowingRidgeStep['kind'],
  predictedPoint: Readonly<Point>,
  normalSampleCount: number,
): StoppedFlowingRidgeStep {
  return Object.freeze({ kind, predictedPoint, normalSampleCount })
}

function weak(
  predictedPoint: Readonly<Point>,
  normalSampleCount: number,
  sample: Readonly<CorrectedFlowingRidgeSample> | null,
): WeakFlowingRidgeStep {
  return Object.freeze({
    kind: 'weak',
    predictedPoint,
    normalSampleCount,
    sample,
  })
}

function localMaxima(
  samples: readonly (StencilSample | null)[],
): readonly StencilSample[] {
  const maxima: StencilSample[] = []
  for (let index = 0; index < samples.length; index += 1) {
    const candidate = samples[index]
    if (candidate == null) continue
    const left = index > 0 ? samples[index - 1] : null
    const right = index + 1 < samples.length ? samples[index + 1] : null
    if (
      (left == null ||
        candidate.sample.evidence + EVIDENCE_EPSILON >= left.sample.evidence) &&
      (right == null ||
        candidate.sample.evidence + EVIDENCE_EPSILON >= right.sample.evidence)
    ) {
      maxima.push(candidate)
    }
  }
  return maxima
}

function parabolicPeakOffset(
  samples: readonly (StencilSample | null)[],
  peak: StencilSample,
  spacing: number,
): number {
  if (peak.index <= 0 || peak.index + 1 >= samples.length) {
    return peak.offset
  }
  const left = samples[peak.index - 1]
  const right = samples[peak.index + 1]
  if (left == null || right == null) return peak.offset
  const leftEvidence = left.sample.evidence
  const centerEvidence = peak.sample.evidence
  const rightEvidence = right.sample.evidence
  const denominator = leftEvidence - 2 * centerEvidence + rightEvidence
  if (!Number.isFinite(denominator) || denominator >= -EVIDENCE_EPSILON) {
    return peak.offset
  }
  const fractional = (0.5 * (leftEvidence - rightEvidence)) / denominator
  return peak.offset + Math.max(-0.5, Math.min(0.5, fractional)) * spacing
}

/**
 * Advance once along an undirected contour tangent.
 *
 * `requestedDirection` is signed (normally the previous accepted tangent).
 * The returned corrected tangent is sign-aligned to it, so callers can pass
 * that tangent into the next invocation without reconstructing grid direction.
 */
export function stepFlowingContoursRidge(
  field: Readonly<FlowingContoursField>,
  current: Readonly<CorrectedFlowingRidgeSample>,
  requestedDirection: Readonly<Point>,
  options: Readonly<FlowingRidgeStepOptions> = DEFAULT_OPTIONS,
  limits: Readonly<FlowingContoursLimits> = FLOWING_CONTOURS_LIMITS,
): FlowingRidgeStepResult {
  let fallbackPoint = ZERO_POINT
  try {
    const currentPoint = frozenPoint(current.point[0], current.point[1])
    if (Number.isFinite(currentPoint[0]) && Number.isFinite(currentPoint[1])) {
      fallbackPoint = currentPoint
    }
    const resolved = resolveOptions(options)
    const direction = finiteUnitVector(requestedDirection)
    const sampleCount = boundedOddNormalSampleCount(limits)
    if (
      resolved === null ||
      direction === null ||
      sampleCount === null ||
      !hasFieldShape(field) ||
      !isFiniteCurrentSample(current, currentPoint)
    ) {
      return stop('safety-limit', fallbackPoint, 0)
    }
    if (!isInsideField(field, currentPoint)) {
      return stop('source-boundary', fallbackPoint, 0)
    }
    const sampledCurrent = sampleFlowingContoursField(field, currentPoint)
    if (sampledCurrent === null) {
      return stop('alpha-boundary', fallbackPoint, 0)
    }
    if (
      !hasResolvedOrientation(current) ||
      !hasResolvedOrientation(sampledCurrent)
    ) {
      return stop('ambiguity', fallbackPoint, 0)
    }

    const currentTangent = signAlignedUnitVector(current.tangent, direction)
    if (
      currentTangent === null ||
      current.coherence < resolved.minimumCoherence ||
      current.ambiguity > resolved.maximumAmbiguity
    ) {
      return stop('ambiguity', fallbackPoint, 0)
    }
    const currentAlignment =
      currentTangent[0] * direction[0] + currentTangent[1] * direction[1]
    if (
      Math.acos(Math.max(-1, Math.min(1, currentAlignment))) >
      resolved.maximumTurnRadians
    ) {
      return stop('curvature', fallbackPoint, 0)
    }

    const predictedPoint = frozenPoint(
      currentPoint[0] + currentTangent[0] * resolved.stepLength,
      currentPoint[1] + currentTangent[1] * resolved.stepLength,
    )
    if (!isInsideField(field, predictedPoint)) {
      return stop('source-boundary', predictedPoint, 0)
    }
    const predictedSample = sampleFlowingContoursField(field, predictedPoint)
    if (predictedSample === null) {
      return stop('alpha-boundary', predictedPoint, 0)
    }
    if (!hasPositiveSupportAlongSegment(field, currentPoint, predictedPoint)) {
      return stop('alpha-boundary', predictedPoint, 0)
    }
    if (!hasResolvedOrientation(predictedSample)) {
      return stop('ambiguity', predictedPoint, 0)
    }

    const normal = frozenPoint(-currentTangent[1], currentTangent[0])
    const searchRadius = Math.min(
      HARD_MAXIMUM_NORMAL_RADIUS,
      Math.max(
        MINIMUM_NORMAL_RADIUS,
        current.scale * NORMAL_RADIUS_SCALE_FACTOR,
      ),
    )
    const spacing = sampleCount > 1 ? (2 * searchRadius) / (sampleCount - 1) : 0
    const stencil: Array<StencilSample | null> = []
    for (let index = 0; index < sampleCount; index += 1) {
      const offset = sampleCount === 1 ? 0 : -searchRadius + index * spacing
      const point = frozenPoint(
        predictedPoint[0] + normal[0] * offset,
        predictedPoint[1] + normal[1] * offset,
      )
      const sample = sampleFlowingContoursField(field, point)
      if (sample === null) {
        stencil.push(null)
        continue
      }
      if (
        sample.evidence + EVIDENCE_EPSILON < resolved.minimumEvidence ||
        !adjacentScale(current.scale, sample.scale)
      ) {
        stencil.push(null)
        continue
      }
      stencil.push(Object.freeze({ index, offset, sample }))
    }

    const maxima = localMaxima(stencil)
    if (maxima.length === 0) {
      return weak(
        predictedPoint,
        sampleCount,
        alignedWeakSample(predictedSample, currentTangent),
      )
    }
    const orderedByEvidence = [...maxima].sort(
      (left, right) =>
        right.sample.evidence - left.sample.evidence ||
        Math.abs(left.offset) - Math.abs(right.offset) ||
        left.index - right.index,
    )
    const strongest = orderedByEvidence[0]!
    const ambiguityFloor = strongest.sample.evidence - resolved.ambiguityMargin
    const comparable = maxima.filter(
      (candidate) =>
        candidate.sample.evidence + EVIDENCE_EPSILON >= ambiguityFloor,
    )
    if (comparable.length > 1) {
      return stop('ambiguity', predictedPoint, sampleCount)
    }

    // Ridge ownership follows the closest compatible local maximum. A more
    // distant stronger maximum is a neighboring ridge, not permission to hop.
    const closest = [...maxima].sort(
      (left, right) =>
        Math.abs(left.offset) - Math.abs(right.offset) ||
        right.sample.evidence - left.sample.evidence ||
        left.index - right.index,
    )[0]!
    if (closest !== strongest) {
      return stop('ambiguity', predictedPoint, sampleCount)
    }
    // The outer stencil is detection space, not automatic ownership space.
    // A sole strong maximum out there is exactly how a fading ridge can hop
    // to a close parallel ridge; leave it to FC09 as weak travel instead.
    if (Math.abs(strongest.offset) > HARD_MAXIMUM_OWNERSHIP_RADIUS) {
      return weak(
        predictedPoint,
        sampleCount,
        alignedWeakSample(predictedSample, currentTangent),
      )
    }

    const correctedOffset = parabolicPeakOffset(stencil, strongest, spacing)
    if (Math.abs(correctedOffset) > HARD_MAXIMUM_OWNERSHIP_RADIUS) {
      return weak(
        predictedPoint,
        sampleCount,
        alignedWeakSample(predictedSample, currentTangent),
      )
    }
    const correctedPoint = frozenPoint(
      predictedPoint[0] + normal[0] * correctedOffset,
      predictedPoint[1] + normal[1] * correctedOffset,
    )
    if (
      !hasPositiveSupportAlongSegment(field, predictedPoint, correctedPoint)
    ) {
      return stop('alpha-boundary', predictedPoint, sampleCount)
    }
    const corrected = sampleFlowingContoursField(field, correctedPoint)
    if (corrected === null) {
      return stop('alpha-boundary', predictedPoint, sampleCount)
    }
    if (!hasResolvedOrientation(corrected)) {
      return stop('ambiguity', predictedPoint, sampleCount)
    }
    const correctedTangent = compatibleSample(
      corrected,
      currentTangent,
      current.scale,
      resolved,
    )
    if (correctedTangent === null) {
      return weak(
        predictedPoint,
        sampleCount,
        alignedWeakSample(predictedSample, currentTangent),
      )
    }
    const turnCosine =
      currentTangent[0] * correctedTangent[0] +
      currentTangent[1] * correctedTangent[1]
    const turn = Math.acos(Math.max(-1, Math.min(1, turnCosine)))
    if (turn > resolved.maximumTurnRadians) {
      return stop('curvature', predictedPoint, sampleCount)
    }

    return Object.freeze({
      kind: 'corrected',
      predictedPoint,
      normalSampleCount: sampleCount,
      sample: Object.freeze({
        point: correctedPoint,
        tangent: correctedTangent,
        evidence: corrected.evidence,
        coherence: corrected.coherence,
        ambiguity: corrected.ambiguity,
        scale: corrected.scale,
        alpha: corrected.alpha,
      }),
    })
  } catch {
    return stop('safety-limit', fallbackPoint, 0)
  }
}
