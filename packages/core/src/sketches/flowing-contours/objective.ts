/**
 * Deterministic whole-candidate objective for Flowing Contours.
 *
 * Search supplies seven composition-relative measurements normalized to
 * `[0, 1]`. Rewards fail closed to zero; penalties fail closed to their maximum.
 * Finite out-of-range values clamp before weighting, so neither malformed
 * inputs nor long adversarial trajectories can produce a non-finite score.
 *
 * Flow smoothing changes only the curvature-change weight. In particular it
 * cannot quietly make weak travel, ambiguity, overlap, evidence, or length
 * cheaper. This keeps smoothing focused on long, flowing gestures instead of
 * rewarding short paths merely because they contain fewer turns.
 */

import type { Point } from '../../types'
import type {
  FlowingContoursCandidate,
  FlowingContoursCandidateScore,
} from './types'

const ACCUMULATED_EVIDENCE_WEIGHT = 4
const USEFUL_LENGTH_WEIGHT = 5
const DIRECTIONAL_COHERENCE_WEIGHT = 2
const MINIMUM_CURVATURE_WEIGHT = 0.5
const SMOOTHING_CURVATURE_WEIGHT = 2.5
const UNSUPPORTED_TRAVEL_WEIGHT = 4.5
const AMBIGUITY_WEIGHT = 3
const REPRESENTED_OVERLAP_WEIGHT = 5

/**
 * Bounded whole-curve measurements, before objective weighting.
 *
 * `curvatureChange` measures changes in turning rather than absolute turning:
 * a broad continuous arc can therefore remain preferable to an angular path.
 * `usefulLength` is the candidate length normalized against the search stage's
 * documented useful-length scale, not page or tool dimensions.
 */
export interface FlowingContoursObjectiveInput {
  readonly accumulatedEvidence: number
  readonly usefulLength: number
  readonly directionalCoherence: number
  readonly curvatureChange: number
  readonly unsupportedTravel: number
  readonly ambiguity: number
  readonly representedOverlap: number
}

/**
 * Full deterministic tie-break inventory for a scored search result.
 *
 * `stableId` and `sampleIndex` are persistent search-local ordinals. `point`
 * is compared in row-major order (y, then x) only after the exact score tuple
 * and both ordinals tie.
 */
export interface FlowingContoursObjectiveOrderKey {
  readonly score: Readonly<FlowingContoursCandidateScore>
  readonly stableId: number
  readonly sampleIndex: number
  readonly point: Readonly<Point>
}

function clampReward(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return 0
  }
  return value >= 1 ? 1 : value
}

function clampPenalty(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 1
  if (value <= 0) return 0
  return value >= 1 ? 1 : value
}

function clampSmoothing(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 1
  if (value <= 0) return 0
  return value >= 1 ? 1 : value
}

function finiteTotal(value: number): number {
  if (!Number.isFinite(value)) return -Number.MAX_VALUE
  return Object.is(value, -0) ? 0 : value
}

/**
 * Score one complete bidirectional candidate.
 *
 * Positive fields are weighted rewards and `*Penalty` fields are positive
 * weighted costs. `total` is rewards minus costs. The returned record is
 * frozen so later acceptance cannot accidentally rewrite search history.
 */
export function scoreFlowingContoursCandidate(
  input: Readonly<Partial<FlowingContoursObjectiveInput>> | null,
  flowSmoothing: unknown,
): Readonly<FlowingContoursCandidateScore> {
  const source = input ?? {}
  const smoothing = clampSmoothing(flowSmoothing)
  const accumulatedEvidence =
    ACCUMULATED_EVIDENCE_WEIGHT * clampReward(source.accumulatedEvidence)
  const usefulLength = USEFUL_LENGTH_WEIGHT * clampReward(source.usefulLength)
  const directionalCoherence =
    DIRECTIONAL_COHERENCE_WEIGHT * clampReward(source.directionalCoherence)
  const curvaturePenalty =
    (MINIMUM_CURVATURE_WEIGHT + SMOOTHING_CURVATURE_WEIGHT * smoothing) *
    clampPenalty(source.curvatureChange)
  const unsupportedTravelPenalty =
    UNSUPPORTED_TRAVEL_WEIGHT * clampPenalty(source.unsupportedTravel)
  const ambiguityPenalty = AMBIGUITY_WEIGHT * clampPenalty(source.ambiguity)
  const representedOverlapPenalty =
    REPRESENTED_OVERLAP_WEIGHT * clampPenalty(source.representedOverlap)
  const total = finiteTotal(
    accumulatedEvidence +
      usefulLength +
      directionalCoherence -
      curvaturePenalty -
      unsupportedTravelPenalty -
      ambiguityPenalty -
      representedOverlapPenalty,
  )

  return Object.freeze({
    accumulatedEvidence,
    usefulLength,
    directionalCoherence,
    curvaturePenalty,
    unsupportedTravelPenalty,
    ambiguityPenalty,
    representedOverlapPenalty,
    total,
  })
}

function compareFiniteDescending(first: unknown, second: unknown): number {
  const firstFinite = typeof first === 'number' && Number.isFinite(first)
  const secondFinite = typeof second === 'number' && Number.isFinite(second)
  if (firstFinite !== secondFinite) return firstFinite ? -1 : 1
  if (!firstFinite || !secondFinite || first === second) return 0
  return first > second ? -1 : 1
}

function compareFiniteAscending(first: unknown, second: unknown): number {
  const firstFinite = typeof first === 'number' && Number.isFinite(first)
  const secondFinite = typeof second === 'number' && Number.isFinite(second)
  if (firstFinite !== secondFinite) return firstFinite ? -1 : 1
  if (!firstFinite || !secondFinite || first === second) return 0
  return first < second ? -1 : 1
}

/**
 * Prefer the better exact objective tuple.
 *
 * No epsilon comparison is used: approximate equality can violate transitivity
 * and make bounded beam ordering depend on insertion order. Total is primary;
 * each explicit contribution then resolves arithmetic ties before identity.
 */
export function compareFlowingContoursCandidateScores(
  first: Readonly<FlowingContoursCandidateScore>,
  second: Readonly<FlowingContoursCandidateScore>,
): number {
  return (
    compareFiniteDescending(first.total, second.total) ||
    compareFiniteDescending(
      first.accumulatedEvidence,
      second.accumulatedEvidence,
    ) ||
    compareFiniteDescending(first.usefulLength, second.usefulLength) ||
    compareFiniteDescending(
      first.directionalCoherence,
      second.directionalCoherence,
    ) ||
    compareFiniteAscending(first.curvaturePenalty, second.curvaturePenalty) ||
    compareFiniteAscending(
      first.unsupportedTravelPenalty,
      second.unsupportedTravelPenalty,
    ) ||
    compareFiniteAscending(first.ambiguityPenalty, second.ambiguityPenalty) ||
    compareFiniteAscending(
      first.representedOverlapPenalty,
      second.representedOverlapPenalty,
    )
  )
}

/** Prefer a complete objective key using explicit stable tie-break fields. */
export function compareFlowingContoursObjectiveOrder(
  first: Readonly<FlowingContoursObjectiveOrderKey>,
  second: Readonly<FlowingContoursObjectiveOrderKey>,
): number {
  return (
    compareFlowingContoursCandidateScores(first.score, second.score) ||
    compareFiniteAscending(first.stableId, second.stableId) ||
    compareFiniteAscending(first.sampleIndex, second.sampleIndex) ||
    compareFiniteAscending(first.point[1], second.point[1]) ||
    compareFiniteAscending(first.point[0], second.point[0])
  )
}

/** Candidate convenience wrapper using its anchor's persistent identity. */
export function compareFlowingContoursCandidates(
  first: Pick<FlowingContoursCandidate, 'anchor' | 'score'>,
  second: Pick<FlowingContoursCandidate, 'anchor' | 'score'>,
): number {
  return compareFlowingContoursObjectiveOrder(
    {
      score: first.score,
      stableId: first.anchor.id,
      sampleIndex: first.anchor.fieldSampleIndex,
      point: first.anchor.sample.point,
    },
    {
      score: second.score,
      stableId: second.anchor.id,
      sampleIndex: second.anchor.fieldSampleIndex,
      point: second.anchor.sample.point,
    },
  )
}
