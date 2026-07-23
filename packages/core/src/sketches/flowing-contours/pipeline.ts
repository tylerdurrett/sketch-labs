/**
 * Headless whole-curve composition for Flowing Contours.
 *
 * The pipeline walks a stable anchor inventory and accepts only complete
 * bidirectional trajectories. Suppression is committed only for an authentic
 * FC11 acceptance which also survives a provisional evidence-tube fit. The
 * final fit is still performed as one transaction, so no raw/fitted mismatch
 * or partial fitted batch can escape.
 *
 * This ordering is intentionally whole-curve-first: it never joins fragments,
 * bridges endpoints, or reconstructs paths from raster/grid connectivity.
 */

import type { Point } from '../../types'
import {
  admitFlowingContoursAnchors,
  buildFlowingContoursAnchorInventory,
} from './anchors'
import {
  createFlowingContoursAccounting,
  snapshotFlowingContoursDiagnostics,
  terminateFlowingContoursAtSafetyLimit,
  type FlowingContoursAccounting,
} from './accounting'
import {
  defaultFlowingContoursControls,
  normalizeFlowingContoursControls,
  type FlowingContoursControlInput,
  type FlowingContoursControls,
} from './controls'
import {
  fitFlowingContoursCurve,
  fitFlowingContoursCurves,
} from './curves'
import {
  FLOWING_CONTOURS_LIMITS,
  isWithinFlowingContoursLimit,
  type FlowingContoursLimits,
} from './limits'
import { searchFlowingContoursCandidateDetailed } from './search'
import { selectFlowingContoursCandidate } from './selection'
import {
  commitAcceptedFlowingTrajectorySuppression,
  createFlowingContoursSuppressionQuery,
  createFlowingContoursSuppressionState,
  isFlowingContoursAnchorSuppressed,
  queryFlowingContoursSuppression,
  queryFlowingContoursSuppressionAlongTangent,
  registerAcceptedFlowingTrajectorySuppression,
  type FlowingContoursSuppressionQuery,
  type FlowingContoursSuppressionState,
} from './suppression'
import {
  FLOWING_CONTOURS_ENDPOINT_REASONS,
  FLOWING_CONTOURS_LIMIT_NAMES,
  type AcceptedFlowingTrajectory,
  type FittedFlowingCurve,
  type FlowingContoursField,
  type FlowingContoursLimitName,
  type FlowingContoursPipelineResult,
} from './types'

const EMPTY_TRAJECTORIES =
  Object.freeze([]) as readonly Readonly<AcceptedFlowingTrajectory>[]
const EMPTY_CURVES =
  Object.freeze([]) as readonly Readonly<FittedFlowingCurve>[]

function result(
  acceptedTrajectories: readonly Readonly<AcceptedFlowingTrajectory>[],
  fittedCurves: readonly Readonly<FittedFlowingCurve>[],
  accounting: Readonly<FlowingContoursAccounting>,
): Readonly<FlowingContoursPipelineResult> {
  return Object.freeze({
    acceptedTrajectories: Object.freeze([...acceptedTrajectories]),
    fittedCurves: Object.freeze([...fittedCurves]),
    diagnostics: snapshotFlowingContoursDiagnostics(accounting),
  })
}

function invalidResult(): Readonly<FlowingContoursPipelineResult> {
  const accounting = createFlowingContoursAccounting()
  accounting.termination = 'invalid-input'
  return result(EMPTY_TRAJECTORIES, EMPTY_CURVES, accounting)
}

function ownDataNumber(
  source: object,
  name: PropertyKey,
): number | null {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(source, name)
    return descriptor !== undefined &&
      'value' in descriptor &&
      typeof descriptor.value === 'number'
      ? descriptor.value
      : null
  } catch {
    return null
  }
}

function snapshotLimits(
  source: Readonly<FlowingContoursLimits>,
): Readonly<FlowingContoursLimits> | null {
  try {
    if (
      source === null ||
      typeof source !== 'object' ||
      Array.isArray(source)
    ) {
      return null
    }
    const snapshot = {} as Record<FlowingContoursLimitName, number>
    for (const name of FLOWING_CONTOURS_LIMIT_NAMES) {
      const value = ownDataNumber(source, name)
      if (
        value === null ||
        !isWithinFlowingContoursLimit(name, value, source)
      ) {
        return null
      }
      snapshot[name] = value
    }
    return Object.freeze(snapshot)
  } catch {
    return null
  }
}

function withSearchStepLimit(
  limits: Readonly<FlowingContoursLimits>,
  searchStepCount: number,
): Readonly<FlowingContoursLimits> {
  return Object.freeze({
    ...limits,
    'search-step-count': searchStepCount,
  })
}

function curveLength(points: readonly Readonly<Point>[]): number | null {
  let length = 0
  for (let index = 1; index < points.length; index += 1) {
    const first = points[index - 1]!
    const second = points[index]!
    const segment = Math.hypot(
      second[0] - first[0],
      second[1] - first[1],
    )
    if (!Number.isFinite(segment)) return null
    length += segment
  }
  return Number.isFinite(length) ? length : null
}

function recomputeAcceptedAggregates(
  accounting: FlowingContoursAccounting,
  trajectories: readonly Readonly<AcceptedFlowingTrajectory>[],
  canonicalizeEndpointCounts = false,
): boolean {
  let pointCount = 0
  let maximumUnsupported = 0
  let totalUnsupported = 0
  const endpointReasonCounts = Object.fromEntries(
    FLOWING_CONTOURS_ENDPOINT_REASONS.map((reason) => [reason, 0]),
  ) as FlowingContoursAccounting['endpointReasonCounts']

  for (const trajectory of trajectories) {
    pointCount += trajectory.samples.length
    maximumUnsupported = Math.max(
      maximumUnsupported,
      trajectory.maximumUnsupportedSpanLength,
    )
    totalUnsupported += trajectory.totalUnsupportedSpanLength
    endpointReasonCounts[trajectory.startEndpointReason] += 1
    endpointReasonCounts[trajectory.endEndpointReason] += 1
  }
  if (
    !Number.isSafeInteger(pointCount) ||
    !Number.isFinite(maximumUnsupported) ||
    !Number.isFinite(totalUnsupported)
  ) {
    return false
  }

  accounting.acceptedCandidateCount = trajectories.length
  accounting.rejectedCandidateCount =
    accounting.candidateCount - trajectories.length
  accounting.rawTrajectoryCount = trajectories.length
  accounting.rawTrajectoryPointCount = pointCount
  accounting.acceptedMaximumUnsupportedSpanLength = maximumUnsupported
  accounting.acceptedTotalUnsupportedSpanLength = totalUnsupported
  // FC11 validates endpoint counts against all candidates while the loop is
  // active. Canonicalize to the public accepted-only contract only after the
  // final selection; a rolled-back post-fit rejection must not poison the
  // next selection transaction.
  if (canonicalizeEndpointCounts) {
    accounting.endpointReasonCounts = endpointReasonCounts
  }
  return (
    accounting.rejectedCandidateCount >= 0 &&
    Number.isSafeInteger(accounting.rejectedCandidateCount)
  )
}

function suppressionSampler(
  query: Readonly<FlowingContoursSuppressionQuery>,
): (point: Readonly<Point>, travelTangent: Readonly<Point>) => number {
  return (
    point: Readonly<Point>,
    travelTangent: Readonly<Point>,
  ): number => {
    const tangentAware = queryFlowingContoursSuppressionAlongTangent(
      query,
      point,
      travelTangent,
    )
    if (tangentAware !== null) return tangentAware
    // This conservative fallback is capped by FC12 below growth's hard
    // collision threshold, so missing direction cannot stop a crossing.
    return queryFlowingContoursSuppression(query, point) ?? Number.NaN
  }
}

function countEvidenceSamples(field: Readonly<FlowingContoursField>): number {
  let count = 0
  for (const value of field.contourEvidence) {
    if (value > 0) count += 1
  }
  return count
}

function countScalePlanes(field: Readonly<FlowingContoursField>): number {
  const scales = new Set<number>()
  for (let index = 0; index < field.ridgeScale.length; index += 1) {
    if (field.contourEvidence[index]! > 0) {
      scales.add(field.ridgeScale[index]!)
    }
  }
  return scales.size
}

function terminate(
  accounting: FlowingContoursAccounting,
  limit: FlowingContoursLimitName,
): void {
  terminateFlowingContoursAtSafetyLimit(accounting, limit)
}

function isInvalid(accounting: FlowingContoursAccounting): boolean {
  return accounting.termination === 'invalid-input'
}

function applyPriorSearchExhaustion(
  accounting: FlowingContoursAccounting,
  exhausted: boolean,
): void {
  if (!exhausted || accounting.termination === 'invalid-input') return
  // Search happened before FC11 selection and fitting. It is therefore the
  // first exhausted cap for this attempt even when a later transaction also
  // discovers an output cap.
  accounting.termination = 'limit-reached'
  accounting.limitedBy = 'search-step-count'
}

function sameFittedCurve(
  first: Readonly<FittedFlowingCurve>,
  second: Readonly<FittedFlowingCurve>,
): boolean {
  return (
    first.points.length === second.points.length &&
    first.points.every(
      (point, index) =>
        Object.is(point[0], second.points[index]![0]) &&
        Object.is(point[1], second.points[index]![1]),
    ) &&
    first.provenance.sourceTrajectoryId ===
      second.provenance.sourceTrajectoryId &&
    first.provenance.sourceSampleIndices.length ===
      second.provenance.sourceSampleIndices.length &&
    first.provenance.sourceSampleIndices.every(
      (sampleIndex, index) =>
        sampleIndex === second.provenance.sourceSampleIndices[index],
    ) &&
    Object.is(
      first.provenance.evidenceTubeRadius,
      second.provenance.evidenceTubeRadius,
    ) &&
    Object.is(
      first.provenance.maximumDeviation,
      second.provenance.maximumDeviation,
    )
  )
}

/**
 * Run the bounded Flowing Contours pipeline over one immutable FC05 field.
 *
 * Controls may be authored, partial, or already normalized. The optional
 * limits seam accepts only a complete lower-or-equal FC03 policy.
 */
export function runFlowingContoursPipeline(
  field: Readonly<FlowingContoursField>,
  controlInput: FlowingContoursControlInput | Readonly<FlowingContoursControls> | null =
    defaultFlowingContoursControls,
  limitsInput: Readonly<FlowingContoursLimits> = FLOWING_CONTOURS_LIMITS,
): Readonly<FlowingContoursPipelineResult> {
  try {
    const limits = snapshotLimits(limitsInput)
    if (limits === null) return invalidResult()
    const controls = normalizeFlowingContoursControls(controlInput)
    const accounting = createFlowingContoursAccounting()
    const initialState = createFlowingContoursSuppressionState({
      field,
      limits,
    })
    if (initialState === null) return invalidResult()

    accounting.analysisWidth = field.width
    accounting.analysisHeight = field.height
    accounting.analysisSampleCount = field.width * field.height
    accounting.contourEvidenceSampleCount = countEvidenceSamples(field)

    if (
      field.width > limits['analysis-dimension'] ||
      field.height > limits['analysis-dimension']
    ) {
      terminate(accounting, 'analysis-dimension')
      return result(EMPTY_TRAJECTORIES, EMPTY_CURVES, accounting)
    }
    if (
      accounting.analysisSampleCount > limits['analysis-sample-count']
    ) {
      terminate(accounting, 'analysis-sample-count')
      return result(EMPTY_TRAJECTORIES, EMPTY_CURVES, accounting)
    }
    if (countScalePlanes(field) > limits['scale-plane-count']) {
      terminate(accounting, 'scale-plane-count')
      return result(EMPTY_TRAJECTORIES, EMPTY_CURVES, accounting)
    }

    const inventory = buildFlowingContoursAnchorInventory(
      field,
      accounting,
      limits,
    )
    if (isInvalid(accounting)) return invalidResult()
    const admission = admitFlowingContoursAnchors(
      inventory,
      controls.curveDetail,
      accounting,
    )
    if (isInvalid(accounting)) return invalidResult()
    if (accounting.termination === 'limit-reached') {
      return result(EMPTY_TRAJECTORIES, EMPTY_CURVES, accounting)
    }
    if (
      admission.anchors.length > 0 &&
      limits['search-breadth'] < 1
    ) {
      terminate(accounting, 'search-breadth')
      return result(EMPTY_TRAJECTORIES, EMPTY_CURVES, accounting)
    }
    if (
      admission.anchors.length > 0 &&
      limits['search-step-count'] < 1
    ) {
      terminate(accounting, 'search-step-count')
      return result(EMPTY_TRAJECTORIES, EMPTY_CURVES, accounting)
    }
    if (
      admission.anchors.length > 0 &&
      limits['raw-trajectory-point-count'] < 2
    ) {
      terminate(accounting, 'raw-trajectory-point-count')
      return result(EMPTY_TRAJECTORIES, EMPTY_CURVES, accounting)
    }

    const accepted: Readonly<AcceptedFlowingTrajectory>[] = []
    const previewCurves: Readonly<FittedFlowingCurve>[] = []
    let fittedPointCount = 0
    let suppressionState: Readonly<FlowingContoursSuppressionState> =
      initialState
    let query = createFlowingContoursSuppressionQuery(
      suppressionState,
      field,
    )
    if (query === null) return invalidResult()

    for (const anchor of admission.anchors) {
      if (accounting.termination !== 'complete') break
      accounting.processedAnchorCount += 1

      const suppressed = isFlowingContoursAnchorSuppressed(query, anchor)
      if (suppressed === null) return invalidResult()
      if (suppressed) {
        accounting.suppressedAnchorCount += 1
        continue
      }
      if (accounting.candidateCount >= limits['candidate-count']) {
        terminate(accounting, 'candidate-count')
        break
      }
      if (accepted.length >= limits['primitive-count']) {
        terminate(accounting, 'primitive-count')
        break
      }
      const remainingSearchSteps =
        limits['search-step-count'] - accounting.searchStepCount
      if (remainingSearchSteps < 1) {
        terminate(accounting, 'search-step-count')
        break
      }

      const search = searchFlowingContoursCandidateDetailed(
        field,
        anchor,
        {
          continuity: controls.continuity,
          flowSmoothing: controls.flowSmoothing,
          representedOverlapSampler: suppressionSampler(query),
        },
        withSearchStepLimit(limits, remainingSearchSteps),
      )
      if (
        search === null ||
        !Number.isSafeInteger(search.directionalTraceCount) ||
        search.directionalTraceCount < 0 ||
        search.directionalTraceCount > 2 ||
        !Number.isSafeInteger(search.searchStepCount) ||
        search.searchStepCount < 0 ||
        search.searchStepCount > remainingSearchSteps ||
        search.searchCapExhausted !==
          (search.searchStepCount >= remainingSearchSteps)
      ) {
        return invalidResult()
      }
      accounting.directionalTraceCount += search.directionalTraceCount
      accounting.searchStepCount += search.searchStepCount
      const searchCapExhausted = search.searchCapExhausted
      const candidate = search.candidate
      // A valid ridge maximum need not yield a complete two-sided candidate,
      // but all work from that attempt is already retained above.
      if (candidate === null) {
        applyPriorSearchExhaustion(accounting, searchCapExhausted)
        continue
      }

      const selection = selectFlowingContoursCandidate(
        candidate,
        {
          analysisWidth: field.width,
          analysisHeight: field.height,
          minimumStrokeLength: controls.minimumStrokeLength,
        },
        accounting,
        limits,
      )
      if (selection.kind === 'rejected') {
        if (selection.reason === 'invalid-input') return invalidResult()
        applyPriorSearchExhaustion(accounting, searchCapExhausted)
        continue
      }

      const registration =
        registerAcceptedFlowingTrajectorySuppression(
          suppressionState,
          field,
          selection,
        )
      if (registration === null) return invalidResult()

      // Preview fitting before occupancy publication. A curve that contracts
      // below the authored minimum is an ordinary whole-candidate rejection;
      // it neither survives as raw output nor suppresses later anchors.
      const provisionalFit = fitFlowingContoursCurve(
        field,
        selection.trajectory,
        controls.flowSmoothing,
        {
          limits,
          currentFittedPointCount: fittedPointCount,
        },
      )
      if (provisionalFit.status === 'invalid-input') return invalidResult()
      if (provisionalFit.status === 'limit-reached') {
        if (!recomputeAcceptedAggregates(accounting, accepted)) {
          return invalidResult()
        }
        applyPriorSearchExhaustion(accounting, searchCapExhausted)
        terminate(accounting, provisionalFit.limitedBy)
        break
      }
      const fittedLength = curveLength(provisionalFit.curve.points)
      const minimumLength =
        controls.minimumStrokeLength * Math.hypot(field.width, field.height)
      if (fittedLength === null) return invalidResult()
      if (fittedLength < minimumLength) {
        if (!recomputeAcceptedAggregates(accounting, accepted)) {
          return invalidResult()
        }
        applyPriorSearchExhaustion(accounting, searchCapExhausted)
        continue
      }

      const committed = commitAcceptedFlowingTrajectorySuppression(
        suppressionState,
        registration,
      )
      if (committed.kind === 'rejected') {
        if (committed.reason === 'occupancy-limit') {
          if (!recomputeAcceptedAggregates(accounting, accepted)) {
            return invalidResult()
          }
          applyPriorSearchExhaustion(accounting, searchCapExhausted)
          terminate(accounting, 'analysis-sample-count')
          break
        }
        return invalidResult()
      }
      accepted.push(selection.trajectory)
      previewCurves.push(provisionalFit.curve)
      fittedPointCount += provisionalFit.fittedPointCount
      suppressionState = committed.state
      accounting.suppressedEvidenceSampleCount +=
        committed.suppressedEvidenceSampleCount
      query = createFlowingContoursSuppressionQuery(
        suppressionState,
        field,
      )
      if (query === null) return invalidResult()

      applyPriorSearchExhaustion(accounting, searchCapExhausted)
    }

    const fitted = fitFlowingContoursCurves(
      field,
      Object.freeze([...accepted]),
      controls.flowSmoothing,
      { limits },
    )
    if (fitted.status !== 'fitted') {
      // Preview fitting made the same accepted-order batch provably feasible.
      // A disagreement means hostile or inconsistent input, not a prefix.
      return invalidResult()
    }
    if (fitted.fittedPointCount !== fittedPointCount) return invalidResult()
    if (
      fitted.curves.length !== previewCurves.length ||
      fitted.curves.some(
        (curve, index) => !sameFittedCurve(curve, previewCurves[index]!),
      )
    ) {
      return invalidResult()
    }

    accounting.fittedCurveCount = fitted.curves.length
    accounting.fittedCurvePointCount = fitted.fittedPointCount
    accounting.primitiveCount = fitted.curves.length
    accounting.suppressedEvidenceSampleCount =
      suppressionState.suppressedEvidenceSampleCount
    if (!recomputeAcceptedAggregates(accounting, accepted, true)) {
      return invalidResult()
    }
    return result(accepted, fitted.curves, accounting)
  } catch {
    return invalidResult()
  }
}
