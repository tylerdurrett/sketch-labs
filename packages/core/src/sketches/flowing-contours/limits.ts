/**
 * Deterministic safety policy for Flowing Contours.
 *
 * These are hard ceilings rather than authored-detail defaults. The bounded
 * analysis lattice is the primary memory limit; later caps make the maximum
 * multiscale, predictor-corrector, search, fitting, and output work explicit.
 */

import {
  FLOWING_CONTOURS_LIMIT_NAMES,
  type FlowingContoursLimitName,
} from './types'

const ANALYSIS_MAX_DIMENSION = 256
const MAX_ANALYSIS_SAMPLE_COUNT =
  ANALYSIS_MAX_DIMENSION * ANALYSIS_MAX_DIMENSION
const MAX_SCALE_PLANE_COUNT = 5

/** At most one stable anchor and candidate may originate at each sample. */
const MAX_ANCHOR_COUNT = MAX_ANALYSIS_SAMPLE_COUNT
const MAX_CANDIDATE_COUNT = MAX_ANCHOR_COUNT

/**
 * A corrected ridge step examines a small odd normal stencil while retaining
 * only a narrow deterministic beam. Aggregate directional growth is bounded
 * independently so noisy inputs cannot multiply every local allowance.
 */
const MAX_NORMAL_SEARCH_SAMPLE_COUNT = 9
const MAX_SEARCH_BREADTH = 4
const MAX_SEARCH_STEP_COUNT = 8 * MAX_ANALYSIS_SAMPLE_COUNT

/**
 * Weak travel is capped in both discrete work and continuous analysis-space
 * distance. Authored Continuity may choose only a smaller allowance.
 */
const MAX_WEAK_SPAN_STEP_COUNT = 12
const MAX_WEAK_SPAN_DISTANCE = 16

/**
 * Output inventories are bounded separately from candidate work. Point caps
 * allow long gestures while preventing accepted or fitted geometry from
 * growing in proportion to every search hypothesis.
 */
const MAX_ACCEPTED_CURVE_COUNT = MAX_ANALYSIS_SAMPLE_COUNT / 32
const MAX_RAW_TRAJECTORY_POINT_COUNT = 8 * MAX_ANALYSIS_SAMPLE_COUNT
const MAX_FITTED_CURVE_POINT_COUNT = MAX_RAW_TRAJECTORY_POINT_COUNT
const MAX_PRIMITIVE_COUNT = MAX_ACCEPTED_CURVE_COUNT

export type FlowingContoursLimits = Readonly<
  Record<FlowingContoursLimitName, number>
>

export const FLOWING_CONTOURS_LIMITS: FlowingContoursLimits = Object.freeze({
  'analysis-dimension': ANALYSIS_MAX_DIMENSION,
  'analysis-sample-count': MAX_ANALYSIS_SAMPLE_COUNT,
  'scale-plane-count': MAX_SCALE_PLANE_COUNT,
  'anchor-count': MAX_ANCHOR_COUNT,
  'normal-search-sample-count': MAX_NORMAL_SEARCH_SAMPLE_COUNT,
  'search-breadth': MAX_SEARCH_BREADTH,
  'search-step-count': MAX_SEARCH_STEP_COUNT,
  'candidate-count': MAX_CANDIDATE_COUNT,
  'weak-span-step-count': MAX_WEAK_SPAN_STEP_COUNT,
  'weak-span-distance': MAX_WEAK_SPAN_DISTANCE,
  'accepted-curve-count': MAX_ACCEPTED_CURVE_COUNT,
  'raw-trajectory-point-count': MAX_RAW_TRAJECTORY_POINT_COUNT,
  'fitted-curve-point-count': MAX_FITTED_CURVE_POINT_COUNT,
  'primitive-count': MAX_PRIMITIVE_COUNT,
})

const LIMIT_NAME_SET: ReadonlySet<string> = new Set(
  FLOWING_CONTOURS_LIMIT_NAMES,
)

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isValidLimitValue(
  name: FlowingContoursLimitName,
  value: unknown,
): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= 0 &&
    (name === 'weak-span-distance' || Number.isSafeInteger(value)) &&
    value <= FLOWING_CONTOURS_LIMITS[name]
  )
}

function boundedLimit(
  name: FlowingContoursLimitName,
  limits: Readonly<FlowingContoursLimits>,
): number | null {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(limits, name)
    if (descriptor === undefined || !('value' in descriptor)) return null
    return isValidLimitValue(name, descriptor.value)
      ? descriptor.value
      : null
  } catch {
    // Proxy descriptor traps and other hostile policies fail closed.
    return null
  }
}

/**
 * True when a complete inventory fits its named production-bounded cap.
 *
 * A malformed policy fails closed. Even callers holding an unchecked object
 * cannot use this seam to raise a production ceiling.
 */
export function isWithinFlowingContoursLimit(
  name: FlowingContoursLimitName,
  value: number,
  limits: Readonly<FlowingContoursLimits> = FLOWING_CONTOURS_LIMITS,
): boolean {
  const limit = boundedLimit(name, limits)
  return (
    limit !== null &&
    Number.isFinite(value) &&
    value >= 0 &&
    (name === 'weak-span-distance' || Number.isSafeInteger(value)) &&
    value <= limit
  )
}

/**
 * Check a prospective monotonic budget increment without performing it.
 *
 * Unsafe, negative, fractional discrete, or overflowing accounting is rejected
 * instead of being rounded or allowed to escape a production bound.
 */
export function canConsumeFlowingContoursLimit(
  name: FlowingContoursLimitName,
  current: number,
  increment = 1,
  limits: Readonly<FlowingContoursLimits> = FLOWING_CONTOURS_LIMITS,
): boolean {
  if (
    !Number.isFinite(current) ||
    current < 0 ||
    !Number.isFinite(increment) ||
    increment < 0
  ) {
    return false
  }
  if (
    name !== 'weak-span-distance' &&
    (!Number.isSafeInteger(current) || !Number.isSafeInteger(increment))
  ) {
    return false
  }
  const next = current + increment
  return Number.isFinite(next) && isWithinFlowingContoursLimit(name, next, limits)
}

/**
 * Exact cap-forcing seam for focused tests.
 *
 * Overrides may only lower production limits. Unknown keys, getters that
 * throw, non-finite values, fractional discrete counts, and raised ceilings
 * return `null`, allowing callers to fail closed without an unbounded fallback.
 */
export function createFlowingContoursTestLimits(
  overrides: unknown,
): FlowingContoursLimits | null {
  if (!isRecord(overrides)) return null

  try {
    const limits: Record<FlowingContoursLimitName, number> = {
      ...FLOWING_CONTOURS_LIMITS,
    }
    for (const key of Reflect.ownKeys(overrides)) {
      if (typeof key !== 'string' || !LIMIT_NAME_SET.has(key)) return null
      const name = key as FlowingContoursLimitName
      const descriptor = Object.getOwnPropertyDescriptor(overrides, name)
      // Reject accessors so validation and construction cannot observe
      // different values from a stateful getter.
      if (descriptor === undefined || !('value' in descriptor)) return null
      if (!isValidLimitValue(name, descriptor.value)) return null
      limits[name] = descriptor.value
    }

    return Object.freeze(limits)
  } catch {
    return null
  }
}
