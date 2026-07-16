import type { Point, Random } from '../types'
import { isMaskPermittedSegment } from './mask'
import type { ScribbleModel } from './types'

const HEADING_COUNT = 17
const MIN_FAN_HALF_ANGLE = Math.PI / 5
const MAX_FAN_HALF_ANGLE = Math.PI
const LOOK_AHEAD_WEIGHT = 0.45
const MIN_CONTINUITY_WEIGHT = 0.08
const MIN_SCORE = 1e-12

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

  for (let index = 0; index < HEADING_COUNT; index++) {
    const candidateAngle = candidateHeading(
      index,
      heading,
      model.controls.chaos,
      rng,
    )
    const point: Point = [
      current[0] + Math.cos(candidateAngle) * model.scales.segmentLength,
      current[1] + Math.sin(candidateAngle) * model.scales.segmentLength,
    ]
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
