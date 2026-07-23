/**
 * Mutable-in-pipeline accounting with immutable public snapshots.
 *
 * The working type is derived from the FC01 diagnostics contract so this
 * module cannot silently invent or omit a public diagnostic field.
 */

import {
  FLOWING_CONTOURS_ENDPOINT_REASONS,
  type FlowingContoursDiagnostics,
  type FlowingContoursEndpointReason,
  type FlowingContoursEndpointReasonCounts,
  type FlowingContoursLimitName,
} from './types'

type Mutable<T> = {
  -readonly [Key in keyof T]: T[Key]
}

export type FlowingContoursAccounting = Mutable<
  Omit<FlowingContoursDiagnostics, 'endpointReasonCounts'>
> & {
  endpointReasonCounts: Record<FlowingContoursEndpointReason, number>
}

function initialEndpointReasonCounts(): Record<
  FlowingContoursEndpointReason,
  number
> {
  return Object.fromEntries(
    FLOWING_CONTOURS_ENDPOINT_REASONS.map((reason) => [reason, 0]),
  ) as Record<FlowingContoursEndpointReason, number>
}

/** Create a complete zeroed working inventory for one pipeline invocation. */
export function createFlowingContoursAccounting(): FlowingContoursAccounting {
  return {
    termination: 'complete',
    limitedBy: null,
    analysisWidth: 0,
    analysisHeight: 0,
    analysisSampleCount: 0,
    contourEvidenceSampleCount: 0,
    correctedRidgeSampleCount: 0,
    eligibleAnchorCount: 0,
    processedAnchorCount: 0,
    directionalTraceCount: 0,
    searchStepCount: 0,
    candidateCount: 0,
    acceptedCandidateCount: 0,
    rejectedCandidateCount: 0,
    suppressedAnchorCount: 0,
    suppressedEvidenceSampleCount: 0,
    endpointReasonCounts: initialEndpointReasonCounts(),
    rawTrajectoryCount: 0,
    rawTrajectoryPointCount: 0,
    acceptedMaximumUnsupportedSpanLength: 0,
    acceptedTotalUnsupportedSpanLength: 0,
    fittedCurveCount: 0,
    fittedCurvePointCount: 0,
    primitiveCount: 0,
  }
}

/**
 * Increment one endpoint reason exactly.
 *
 * Invalid or overflowing increments are rejected without mutating accounting,
 * preserving monotonic integer counters.
 */
export function incrementFlowingContoursEndpointCount(
  accounting: FlowingContoursAccounting,
  reason: FlowingContoursEndpointReason,
  increment = 1,
): boolean {
  const current = accounting.endpointReasonCounts[reason]
  if (
    !Number.isSafeInteger(current) ||
    current < 0 ||
    !Number.isSafeInteger(increment) ||
    increment < 0 ||
    !Number.isSafeInteger(current + increment)
  ) {
    return false
  }
  accounting.endpointReasonCounts[reason] = current + increment
  return true
}

/**
 * Aggregate one accepted, explicitly supported weak span.
 *
 * Both the largest individual span and total unsupported travel are retained.
 * Malformed or overflowing lengths leave both aggregates unchanged.
 */
export function recordFlowingContoursUnsupportedSpan(
  accounting: FlowingContoursAccounting,
  length: number,
): boolean {
  const total = accounting.acceptedTotalUnsupportedSpanLength
  const maximum = accounting.acceptedMaximumUnsupportedSpanLength
  const nextTotal = total + length
  if (
    !Number.isFinite(length) ||
    length < 0 ||
    !Number.isFinite(total) ||
    total < 0 ||
    !Number.isFinite(maximum) ||
    maximum < 0 ||
    !Number.isFinite(nextTotal)
  ) {
    return false
  }

  accounting.acceptedMaximumUnsupportedSpanLength = Math.max(maximum, length)
  accounting.acceptedTotalUnsupportedSpanLength = nextTotal
  return true
}

/**
 * Mark a bounded-work termination and optionally account for exact directional
 * endpoints that stopped at that cap.
 *
 * The first limiting cap is stable. Repeated calls for that same cap may add
 * further real safety endpoints; an unrelated later cap cannot overwrite it.
 */
export function terminateFlowingContoursAtSafetyLimit(
  accounting: FlowingContoursAccounting,
  limitedBy: FlowingContoursLimitName,
  safetyEndpointCount = 0,
): boolean {
  if (
    !Number.isSafeInteger(safetyEndpointCount) ||
    safetyEndpointCount < 0 ||
    accounting.termination === 'invalid-input' ||
    (accounting.termination === 'limit-reached' &&
      accounting.limitedBy !== limitedBy)
  ) {
    return false
  }

  const current = accounting.endpointReasonCounts['safety-limit']
  if (
    !Number.isSafeInteger(current) ||
    current < 0 ||
    !Number.isSafeInteger(current + safetyEndpointCount)
  ) {
    return false
  }

  accounting.termination = 'limit-reached'
  accounting.limitedBy = limitedBy
  accounting.endpointReasonCounts['safety-limit'] =
    current + safetyEndpointCount
  return true
}

/**
 * Return a detached, deeply immutable public diagnostic snapshot.
 *
 * Later pipeline accounting cannot retroactively change a previously returned
 * result, including its nested endpoint inventory.
 */
export function snapshotFlowingContoursDiagnostics(
  accounting: Readonly<FlowingContoursAccounting>,
): Readonly<FlowingContoursDiagnostics> {
  const endpointReasonCounts: FlowingContoursEndpointReasonCounts =
    Object.freeze({ ...accounting.endpointReasonCounts })
  return Object.freeze({
    ...accounting,
    endpointReasonCounts,
  })
}
