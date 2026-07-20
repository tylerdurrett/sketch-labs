import type { Point, Random } from '../types'
import { isMaskPermittedSegment } from './mask'
import type { ScribbleModel } from './types'

const HEADING_COUNT = 17
const MIN_FAN_HALF_ANGLE = Math.PI / 5
const MAX_FAN_HALF_ANGLE = Math.PI
const LOOK_AHEAD_WEIGHT = 0.45
const MIN_CONTINUITY_WEIGHT = 0.08
const MIN_SCORE = 1e-12
const MAX_SCALE_REFINEMENTS = 16

export interface ScribbleGrowthInput {
  readonly model: ScribbleModel
  /** The shared run RNG. This function never creates or forks its own stream. */
  readonly rng: Random
  readonly current: Readonly<Point>
  /** Omit for the first segment of a newly lifted polyline. */
  readonly heading?: number
}

export interface ScribbleGrowthAdvance {
  readonly kind: 'advanced'
  readonly point: Point
  /** Radians in `[-PI, PI)`, ready to feed into the next growth step. */
  readonly heading: number
}

export interface ScribbleGrowthStagnation {
  readonly kind: 'stagnated'
  readonly reason: 'no-viable-candidate'
}

export type ScribbleGrowthStep =
  | ScribbleGrowthAdvance
  | ScribbleGrowthStagnation

interface ScoredCandidate {
  readonly point: Point
  readonly heading: number
  readonly score: number
}

function pointAtLength(
  start: Readonly<Point>,
  angle: number,
  length: number,
): Point {
  return [
    start[0] + Math.cos(angle) * length,
    start[1] + Math.sin(angle) * length,
  ]
}

function maximumInFrameRayLength(
  model: ScribbleModel,
  start: Readonly<Point>,
  angle: number,
): number | undefined {
  const { width, height } = model.lattice.frame
  if (
    start[0] < 0 ||
    start[0] > width ||
    start[1] < 0 ||
    start[1] > height
  ) {
    return undefined
  }

  const directionX = Math.cos(angle)
  const directionY = Math.sin(angle)
  let maximumLength = Number.POSITIVE_INFINITY

  if (directionX > 0) {
    maximumLength = Math.min(maximumLength, (width - start[0]) / directionX)
  } else if (directionX < 0) {
    maximumLength = Math.min(maximumLength, -start[0] / directionX)
  }
  if (directionY > 0) {
    maximumLength = Math.min(maximumLength, (height - start[1]) / directionY)
  } else if (directionY < 0) {
    maximumLength = Math.min(maximumLength, -start[1] / directionY)
  }

  if (!Number.isFinite(maximumLength) || maximumLength <= 0) return undefined

  // Stay a few ulps inside the inclusive frame so reconstructing the endpoint
  // with sin/cos cannot round it just beyond the boundary.
  return maximumLength * (1 - Number.EPSILON * 8)
}

/**
 * Resolve one field-aware ray without consuming the run's random stream.
 *
 * Every shortened segment is reprofiled because its changed sampling grid can
 * reveal a still finer station. Refinement is monotone; pathological fields
 * that keep revealing smaller values reach the authored fine fallback after a
 * fixed bound. The shared model predicate makes the final scale, frame, and
 * mask decision at that profile's minimum spacing.
 */
function scaleFieldEndpoint(
  model: ScribbleModel,
  start: Readonly<Point>,
  angle: number,
  proposedLength?: number,
): Point | undefined {
  const maximumLength = maximumInFrameRayLength(model, start, angle)
  if (maximumLength === undefined) return undefined

  const rayLength = Math.min(
    proposedLength ?? model.localScalesAt(start).segmentLength,
    maximumLength,
  )
  let permittedLength = rayLength

  for (let refinement = 0; refinement < MAX_SCALE_REFINEMENTS; refinement++) {
    const endpoint = pointAtLength(start, angle, permittedLength)
    const bounds = model.profileSegmentBounds(start, endpoint)
    if (bounds === undefined) break

    const shortenedLength = Math.min(
      permittedLength,
      bounds.minimumSegmentLength,
    )
    if (shortenedLength < permittedLength) {
      permittedLength = shortenedLength
      continue
    }

    return model.isSegmentSafe(start, endpoint, bounds) ? endpoint : undefined
  }

  const fineEndpoint = pointAtLength(
    start,
    angle,
    Math.min(model.scales.segmentLength, maximumLength),
  )
  return model.isSegmentSafe(start, fineEndpoint) ? fineEndpoint : undefined
}

function normalizeAngle(angle: number): number {
  const turn = Math.PI * 2
  return ((angle + Math.PI) % turn + turn) % turn - Math.PI
}

function angularDistance(a: number, b: number): number {
  return Math.abs(normalizeAngle(a - b))
}

function candidateHeading(
  index: number,
  heading: number | undefined,
  chaos: number,
  rng: Random,
): number {
  const hasHeading = heading !== undefined && Number.isFinite(heading)
  const halfAngle = hasHeading
    ? MIN_FAN_HALF_ANGLE +
      chaos * (MAX_FAN_HALF_ANGLE - MIN_FAN_HALF_ANGLE)
    : Math.PI
  const center = hasHeading ? heading : 0
  const increment =
    (halfAngle * 2) / (hasHeading ? HEADING_COUNT - 1 : HEADING_COUNT)
  const base = center - halfAngle + increment * index

  // Jitter remains inside half a fan interval. Drawing it for every candidate,
  // even at zero Chaos, keeps the shared RNG stream structurally stable.
  const jitter = rng.range(-increment / 2, increment / 2) * chaos
  return normalizeAngle(base + jitter)
}

function scoreCandidate(
  model: ScribbleModel,
  current: Readonly<Point>,
  point: Point,
  candidateAngle: number,
  previousAngle: number | undefined,
): number {
  const { source, scales, lattice, controls } = model

  if (model.scaleField !== undefined) {
    const lookAhead = scaleFieldEndpoint(model, point, candidateAngle)
    // residualAt already contains the model's linear permission weighting.
    // Multiplying permission here again would incorrectly steer by permission².
    const endpointDemand = model.residualAt(point)
    const futureDemand =
      lookAhead === undefined ? 0 : model.residualAt(lookAhead)
    const demand = endpointDemand + LOOK_AHEAD_WEIGHT * futureDemand
    if (demand <= MIN_SCORE) return 0

    if (previousAngle === undefined || !Number.isFinite(previousAngle)) {
      return demand
    }

    const turn = angularDistance(candidateAngle, previousAngle)
    const alignment = (Math.cos(turn) + 1) / 2
    const continuity = alignment * alignment
    const continuityWeight =
      1 -
      controls.momentum +
      controls.momentum *
        (MIN_CONTINUITY_WEIGHT + (1 - MIN_CONTINUITY_WEIGHT) * continuity)
    return demand * continuityWeight
  }

  if (
    !isMaskPermittedSegment(
      source.shadingMask,
      lattice.frame,
      current,
      point,
      scales.maskCheckSpacing,
    )
  ) {
    return 0
  }

  const directionX = Math.cos(candidateAngle)
  const directionY = Math.sin(candidateAngle)
  const lookAhead: Point = [
    point[0] + directionX * scales.segmentLength,
    point[1] + directionY * scales.segmentLength,
  ]
  const lookAheadPermitted = isMaskPermittedSegment(
    source.shadingMask,
    lattice.frame,
    point,
    lookAhead,
    scales.maskCheckSpacing,
  )
  // residualAt already contains the model's linear permission weighting.
  // Multiplying permission here again would incorrectly steer by permission².
  const endpointDemand = model.residualAt(point)
  const futureDemand = lookAheadPermitted
    ? model.residualAt(lookAhead)
    : 0
  const demand = endpointDemand + LOOK_AHEAD_WEIGHT * futureDemand
  if (demand <= MIN_SCORE) return 0

  if (previousAngle === undefined || !Number.isFinite(previousAngle)) {
    return demand
  }

  const turn = angularDistance(candidateAngle, previousAngle)
  const alignment = (Math.cos(turn) + 1) / 2
  const continuity = alignment * alignment
  const continuityWeight =
    1 -
    controls.momentum +
    controls.momentum *
      (MIN_CONTINUITY_WEIGHT + (1 - MIN_CONTINUITY_WEIGHT) * continuity)
  return demand * continuityWeight
}

function weightedChoice(
  candidates: readonly ScoredCandidate[],
  chaos: number,
  rng: Random,
): ScoredCandidate {
  // Low Chaos concentrates probability near the strongest candidate. High
  // Chaos flattens the distribution, widening selection without inventing a
  // second source of randomness or altering the residual model.
  const exponent = 4 - chaos * 3.25
  const weights = candidates.map(({ score }) => score ** exponent)
  const total = weights.reduce((sum, weight) => sum + weight, 0)
  let cursor = rng.value() * total

  for (let index = 0; index < candidates.length; index++) {
    cursor -= weights[index]!
    if (cursor < 0) return candidates[index]!
  }

  return candidates[candidates.length - 1]!
}

/**
 * Choose one deterministic, mask-safe residual-seeking Scribble segment.
 *
 * Growth only chooses geometry. The run orchestrator owns coverage deposits,
 * lifting, restart policy, convergence, and safety budgets. Keeping those
 * concerns outside this function makes local exhaustion explicit and lets one
 * shared seeded stream compose the complete run repeatably.
 */
export function chooseScribbleGrowthStep({
  model,
  rng,
  current,
  heading,
}: ScribbleGrowthInput): ScribbleGrowthStep {
  const candidates: ScoredCandidate[] = []
  const currentSegmentLength =
    model.scaleField === undefined
      ? undefined
      : model.localScalesAt(current).segmentLength

  for (let index = 0; index < HEADING_COUNT; index++) {
    const candidateAngle = candidateHeading(
      index,
      heading,
      model.controls.chaos,
      rng,
    )
    let point: Point
    if (model.scaleField === undefined) {
      point = [
        current[0] + Math.cos(candidateAngle) * model.scales.segmentLength,
        current[1] + Math.sin(candidateAngle) * model.scales.segmentLength,
      ]
    } else {
      const scaleAwarePoint = scaleFieldEndpoint(
        model,
        current,
        candidateAngle,
        currentSegmentLength,
      )
      if (scaleAwarePoint === undefined) continue
      point = scaleAwarePoint
    }
    const score = scoreCandidate(
      model,
      current,
      point,
      candidateAngle,
      heading,
    )

    if (Number.isFinite(score) && score > MIN_SCORE) {
      candidates.push({ point, heading: candidateAngle, score })
    }
  }

  if (candidates.length === 0) {
    return { kind: 'stagnated', reason: 'no-viable-candidate' }
  }

  const selected = weightedChoice(candidates, model.controls.chaos, rng)
  return {
    kind: 'advanced',
    point: selected.point,
    heading: selected.heading,
  }
}
