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
  flowingContoursAnchorAdmissionFloor,
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
import type { RankedFlowingContoursAnchor } from './anchors'
import {
  fitFlowingContoursCurve,
  fitFlowingContoursCurves,
} from './curves'
import { flowingContoursFieldEnsembleScalePlaneCount } from './field'
import {
  FLOWING_CONTOURS_LIMITS,
  isWithinFlowingContoursLimit,
  type FlowingContoursLimits,
} from './limits'
import { compareFlowingContoursCandidates } from './objective'
import {
  certifyFlowingContoursCandidateAgainstField,
  flowingContoursCandidateSourceField,
  measureFlowingContoursCandidateRepresentedOverlap,
  searchFlowingContoursCandidateDetailed,
} from './search'
import {
  flowingContoursAcceptedTrajectorySourceField,
  selectFlowingContoursCandidate,
} from './selection'
import {
  commitAcceptedFlowingTrajectorySuppression,
  createFlowingContoursSuppressionQuery,
  createFlowingContoursSuppressionState,
  isFlowingContoursAnchorSuppressed,
  queryFlowingContoursSuppression,
  queryFlowingContoursSuppressionAlongTangent,
  registerAcceptedFlowingTrajectorySuppression,
  projectAcceptedFlowingTrajectorySuppression,
  type FlowingContoursSuppressionQuery,
  type FlowingContoursSuppressionState,
} from './suppression'
import {
  FLOWING_CONTOURS_ENDPOINT_REASONS,
  FLOWING_CONTOURS_LIMIT_NAMES,
  type AcceptedFlowingTrajectory,
  type FittedFlowingCurve,
  type FlowingContoursCandidate,
  type FlowingContoursField,
  type FlowingContoursFieldEnsemble,
  type FlowingContoursFieldHypothesisKind,
  type FlowingContoursLimitName,
  type FlowingContoursPipelineResult,
} from './types'

export { flowingContoursAcceptedTrajectorySourceField } from './selection'

const EMPTY_TRAJECTORIES =
  Object.freeze([]) as readonly Readonly<AcceptedFlowingTrajectory>[]
const EMPTY_CURVES =
  Object.freeze([]) as readonly Readonly<FittedFlowingCurve>[]
const BROAD_FORM_MINIMUM_ANALYSIS_LENGTH = 16
/**
 * At σ4+ the nine-sample normal stencil is spaced by 0.75px. Guide search may
 * follow its sole aligned adjacent maximum; local search keeps 0.49px.
 */
const GUIDE_MAXIMUM_OWNERSHIP_RADIUS = 0.75
const ACCEPTED_TRAJECTORY_HYPOTHESES = new WeakMap<
  Readonly<AcceptedFlowingTrajectory>,
  FlowingContoursFieldHypothesisKind
>()

export function flowingContoursAcceptedTrajectorySourceHypothesis(
  trajectory: Readonly<AcceptedFlowingTrajectory>,
): FlowingContoursFieldHypothesisKind | null {
  try {
    return ACCEPTED_TRAJECTORY_HYPOTHESES.get(trajectory) ?? null
  } catch {
    return null
  }
}

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

interface EnsembleAnchor {
  readonly hypothesisIndex: number
  readonly hypothesisKind: FlowingContoursFieldHypothesisKind
  readonly anchor: Readonly<RankedFlowingContoursAnchor>
}

interface PooledEnsembleCandidate {
  readonly hypothesisIndex: number
  readonly hypothesisKind: FlowingContoursFieldHypothesisKind
  readonly anchor: Readonly<RankedFlowingContoursAnchor>
  readonly candidate: Readonly<FlowingContoursCandidate>
}

const HYPOTHESIS_AUDITION_PRIORITY: Readonly<
  Record<FlowingContoursFieldHypothesisKind, number>
> = Object.freeze({
  'local-detail': 3,
  'mid-form': 2,
  'broad-form': 1,
})

function snapshotEnsembleFields(
  ensemble: Readonly<FlowingContoursFieldEnsemble>,
): readonly Readonly<FlowingContoursField>[] | null {
  try {
    if (
      ensemble === null ||
      typeof ensemble !== 'object' ||
      !Array.isArray(ensemble.hypotheses) ||
      ensemble.hypotheses.length !== 3 ||
      ensemble.hypotheses[0]?.kind !== 'broad-form' ||
      ensemble.hypotheses[1]?.kind !== 'mid-form' ||
      ensemble.hypotheses[2]?.kind !== 'local-detail'
    ) {
      return null
    }
    const fields = ensemble.hypotheses.map(({ field }) => field)
    const first = fields[0]!
    if (
      fields.some(
        (field) =>
          field.sourceWidth !== first.sourceWidth ||
          field.sourceHeight !== first.sourceHeight ||
          field.width !== first.width ||
          field.height !== first.height ||
          field.alpha.length !== first.alpha.length ||
          field.positiveSupport.length !== first.positiveSupport.length ||
          field.alpha.some(
            (alpha: number, index: number) =>
              !Object.is(alpha, first.alpha[index]) ||
              field.positiveSupport[index] !== first.positiveSupport[index],
          ),
      )
    ) {
      return null
    }
    return Object.freeze(fields)
  } catch {
    return null
  }
}

function countEnsembleEvidenceSamples(
  fields: readonly Readonly<FlowingContoursField>[],
): number {
  let count = 0
  for (let index = 0; index < fields[0]!.contourEvidence.length; index += 1) {
    if (fields.some((field) => field.contourEvidence[index]! > 0)) count += 1
  }
  return count
}

function countEnsembleScalePlanes(
  fields: readonly Readonly<FlowingContoursField>[],
): number {
  const scales = new Set<number>()
  for (const field of fields) {
    for (let index = 0; index < field.ridgeScale.length; index += 1) {
      if (field.contourEvidence[index]! > 0) {
        scales.add(field.ridgeScale[index]!)
      }
    }
  }
  return scales.size
}

function effectiveMinimumStrokeLength(
  kind: FlowingContoursFieldHypothesisKind,
  controls: Readonly<FlowingContoursControls>,
  field: Readonly<FlowingContoursField>,
): number {
  if (kind !== 'broad-form') return controls.minimumStrokeLength
  return Math.max(
    controls.minimumStrokeLength,
    Math.min(
      1,
      BROAD_FORM_MINIMUM_ANALYSIS_LENGTH /
        Math.hypot(field.width, field.height),
    ),
  )
}

function ensembleAnchorQueue(
  ensemble: Readonly<FlowingContoursFieldEnsemble>,
  fields: readonly Readonly<FlowingContoursField>[],
  curveDetail: number,
  accounting: FlowingContoursAccounting,
  limits: Readonly<FlowingContoursLimits>,
): readonly Readonly<EnsembleAnchor>[] | null {
  const queues: Readonly<EnsembleAnchor>[] = []
  let correctedRidgeSampleCount = 0
  let totalInventoryCount = 0
  for (
    let hypothesisIndex = 0;
    hypothesisIndex < fields.length;
    hypothesisIndex += 1
  ) {
    const memberAccounting = createFlowingContoursAccounting()
    const inventory = buildFlowingContoursAnchorInventory(
      fields[hypothesisIndex]!,
      memberAccounting,
      limits,
      curveDetail,
    )
    if (memberAccounting.termination !== 'complete') {
      accounting.termination = memberAccounting.termination
      accounting.limitedBy = memberAccounting.limitedBy
      return null
    }
    const admission = admitFlowingContoursAnchors(
      inventory,
      curveDetail,
      memberAccounting,
    )
    if (memberAccounting.termination !== 'complete') {
      accounting.termination = memberAccounting.termination
      accounting.limitedBy = memberAccounting.limitedBy
      return null
    }
    correctedRidgeSampleCount += inventory.correctedRidgeSampleCount
    totalInventoryCount += inventory.anchors.length
    for (const anchor of admission.anchors) {
      queues.push(
        Object.freeze({
          hypothesisIndex,
          hypothesisKind: ensemble.hypotheses[hypothesisIndex]!.kind,
          anchor,
        }),
      )
    }
  }
  if (
    !Number.isSafeInteger(correctedRidgeSampleCount) ||
    !isWithinFlowingContoursLimit('anchor-count', totalInventoryCount, limits)
  ) {
    terminateFlowingContoursAtSafetyLimit(accounting, 'anchor-count')
    return null
  }
  queues.sort(
    (first, second) =>
      first.anchor.rank - second.anchor.rank ||
      HYPOTHESIS_AUDITION_PRIORITY[second.hypothesisKind] -
        HYPOTHESIS_AUDITION_PRIORITY[first.hypothesisKind],
  )
  const result = queues.map((entry, id) =>
    Object.freeze({
      hypothesisIndex: entry.hypothesisIndex,
      hypothesisKind: entry.hypothesisKind,
      anchor: Object.freeze({ ...entry.anchor, id, rank: id }),
    }),
  )
  accounting.correctedRidgeSampleCount = correctedRidgeSampleCount
  accounting.eligibleAnchorCount = result.length
  return Object.freeze(result)
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
      controls.curveDetail,
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
          minimumAnchorSelectionScore:
            flowingContoursAnchorAdmissionFloor(controls.curveDetail),
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
      if (provisionalFit.status === 'invalid-input') {
        // Search and selection can yield an authentic whole candidate that
        // cannot produce an evidence-tube-valid fitted curve. Reject it before
        // occupancy publication so later independent anchors remain eligible.
        if (!recomputeAcceptedAggregates(accounting, accepted)) {
          return invalidResult()
        }
        applyPriorSearchExhaustion(accounting, searchCapExhausted)
        continue
      }
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

/**
 * Run one bounded whole-candidate pipeline across the stable field ensemble.
 *
 * Each queue item searches, selects, and fits against exactly one hypothesis.
 * Only an authenticated accepted trajectory is projected into every member's
 * geometric occupancy, preventing duplicate flooding without rebinding its
 * evidence provenance. Accounting and all FC03 caps are global.
 */
export function runFlowingContoursFieldEnsemblePipeline(
  ensemble: Readonly<FlowingContoursFieldEnsemble>,
  controlInput: FlowingContoursControlInput | Readonly<FlowingContoursControls> | null =
    defaultFlowingContoursControls,
  limitsInput: Readonly<FlowingContoursLimits> = FLOWING_CONTOURS_LIMITS,
): Readonly<FlowingContoursPipelineResult> {
  try {
    const limits = snapshotLimits(limitsInput)
    const fields = snapshotEnsembleFields(ensemble)
    if (limits === null || fields === null) return invalidResult()
    const controls = normalizeFlowingContoursControls(controlInput)
    const accounting = createFlowingContoursAccounting()
    const firstField = fields[0]!
    const states = fields.map((field) =>
      createFlowingContoursSuppressionState({ field, limits }),
    )
    if (states.some((state) => state === null)) return invalidResult()

    accounting.analysisWidth = firstField.width
    accounting.analysisHeight = firstField.height
    accounting.analysisSampleCount = firstField.width * firstField.height
    accounting.contourEvidenceSampleCount =
      countEnsembleEvidenceSamples(fields)
    if (
      firstField.width > limits['analysis-dimension'] ||
      firstField.height > limits['analysis-dimension']
    ) {
      terminate(accounting, 'analysis-dimension')
      return result(EMPTY_TRAJECTORIES, EMPTY_CURVES, accounting)
    }
    if (accounting.analysisSampleCount > limits['analysis-sample-count']) {
      terminate(accounting, 'analysis-sample-count')
      return result(EMPTY_TRAJECTORIES, EMPTY_CURVES, accounting)
    }
    const scalePlaneCount =
      flowingContoursFieldEnsembleScalePlaneCount(ensemble) ??
      countEnsembleScalePlanes(fields)
    if (scalePlaneCount > limits['scale-plane-count']) {
      terminate(accounting, 'scale-plane-count')
      return result(EMPTY_TRAJECTORIES, EMPTY_CURVES, accounting)
    }

    const queue = ensembleAnchorQueue(
      ensemble,
      fields,
      controls.curveDetail,
      accounting,
      limits,
    )
    if (queue === null) {
      return accounting.termination === 'invalid-input'
        ? invalidResult()
        : result(EMPTY_TRAJECTORIES, EMPTY_CURVES, accounting)
    }
    if (queue.length > 0 && limits['search-breadth'] < 1) {
      terminate(accounting, 'search-breadth')
      return result(EMPTY_TRAJECTORIES, EMPTY_CURVES, accounting)
    }
    if (queue.length > 0 && limits['search-step-count'] < 1) {
      terminate(accounting, 'search-step-count')
      return result(EMPTY_TRAJECTORIES, EMPTY_CURVES, accounting)
    }
    if (queue.length > 0 && limits['raw-trajectory-point-count'] < 2) {
      terminate(accounting, 'raw-trajectory-point-count')
      return result(EMPTY_TRAJECTORIES, EMPTY_CURVES, accounting)
    }
    if (queue.length > 0 && limits['accepted-curve-count'] < 1) {
      terminate(accounting, 'accepted-curve-count')
      return result(EMPTY_TRAJECTORIES, EMPTY_CURVES, accounting)
    }
    if (queue.length > 0 && limits['fitted-curve-point-count'] < 2) {
      terminate(accounting, 'fitted-curve-point-count')
      return result(EMPTY_TRAJECTORIES, EMPTY_CURVES, accounting)
    }
    if (queue.length > 0 && limits['primitive-count'] < 1) {
      terminate(accounting, 'primitive-count')
      return result(EMPTY_TRAJECTORIES, EMPTY_CURVES, accounting)
    }

    const accepted: Readonly<AcceptedFlowingTrajectory>[] = []
    const previewCurves: Readonly<FittedFlowingCurve>[] = []
    const candidatePool: PooledEnsembleCandidate[] = []
    let deferredPoolLimit: FlowingContoursLimitName | null = null
    let fittedPointCount = 0
    let suppressionStates = states as Array<
      Readonly<FlowingContoursSuppressionState>
    >
    let queries = fields.map((field, index) =>
      createFlowingContoursSuppressionQuery(
        suppressionStates[index]!,
        field,
      ),
    )
    if (queries.some((query) => query === null)) return invalidResult()
    const localField = ensemble.hypotheses.find(
      ({ kind }) => kind === 'local-detail',
    )!.field

    for (let queueIndex = 0; queueIndex < queue.length; queueIndex += 1) {
      const entry = queue[queueIndex]!
      accounting.processedAnchorCount += 1
      const field = fields[entry.hypothesisIndex]!
      if (candidatePool.length >= limits['candidate-count']) {
        deferredPoolLimit = 'candidate-count'
        break
      }
      const remainingSearchSteps =
        limits['search-step-count'] - accounting.searchStepCount
      if (remainingSearchSteps < 1) {
        deferredPoolLimit = 'search-step-count'
        break
      }

      const search = searchFlowingContoursCandidateDetailed(
        field,
        entry.anchor,
        {
          continuity: controls.continuity,
          flowSmoothing: controls.flowSmoothing,
          minimumAnchorSelectionScore:
            flowingContoursAnchorAdmissionFloor(controls.curveDetail),
          ...(entry.hypothesisKind === 'local-detail'
            ? {}
            : {
                ridgeStepOptions: {
                  maximumOwnershipRadius:
                    GUIDE_MAXIMUM_OWNERSHIP_RADIUS,
                },
              }),
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
      const recertified =
        search.candidate === null
          ? null
          : entry.hypothesisKind !== 'local-detail'
            ? certifyFlowingContoursCandidateAgainstField(
                search.candidate,
                localField,
                0,
                controls.flowSmoothing,
                withSearchStepLimit(limits, remainingSearchSteps),
              )
            : search.candidate
      const candidate =
        recertified !== null &&
        entry.hypothesisKind !== 'local-detail' &&
        recertified.spanSupport.some(
          ({ kind }) => kind !== 'direct-evidence',
        )
          ? null
          : recertified
      if (candidate !== null) {
        candidatePool.push(
          Object.freeze({
            hypothesisIndex: entry.hypothesisIndex,
            hypothesisKind: entry.hypothesisKind,
            anchor: Object.freeze({
              ...entry.anchor,
              sample: candidate.anchor.sample,
            }),
            candidate,
          }),
        )
      }
      if (search.searchCapExhausted) {
        deferredPoolLimit = 'search-step-count'
        break
      }
    }

    candidatePool.sort((first, second) =>
      compareFlowingContoursCandidates(
        first.candidate,
        second.candidate,
      ),
    )

    for (const pooled of candidatePool) {
      if (accounting.termination !== 'complete') break
      if (accepted.length >= limits['primitive-count']) {
        terminate(accounting, 'primitive-count')
        break
      }
      const field = flowingContoursCandidateSourceField(pooled.candidate)
      if (field === null) return invalidResult()
      const sourceFieldIndex = fields.indexOf(field)
      if (sourceFieldIndex < 0) return invalidResult()
      const query = queries[sourceFieldIndex]!
      const suppressed = isFlowingContoursAnchorSuppressed(
        query!,
        pooled.anchor,
      )
      if (suppressed === null) return invalidResult()
      const overlap = measureFlowingContoursCandidateRepresentedOverlap(
        pooled.candidate,
        suppressionSampler(query!),
      )
      if (overlap === null) return invalidResult()
      const minimumStrokeLength = effectiveMinimumStrokeLength(
        pooled.hypothesisKind,
        controls,
        field,
      )
      const selection = selectFlowingContoursCandidate(
        pooled.candidate,
        {
          analysisWidth: field.width,
          analysisHeight: field.height,
          minimumStrokeLength,
          representedOverlap: overlap.mean,
          representedCollisionFraction:
            overlap.representedCollisionFraction,
          representedAnchorSuppressed: suppressed,
        },
        accounting,
        limits,
      )
      if (selection.kind === 'rejected') {
        if (selection.reason === 'invalid-input') return invalidResult()
        if (
          selection.reason === 'represented-overlap' &&
          suppressed
        ) {
          accounting.suppressedAnchorCount += 1
        }
        continue
      }
      if (
        flowingContoursAcceptedTrajectorySourceField(selection.trajectory) !==
        field
      ) {
        return invalidResult()
      }
      const registration = registerAcceptedFlowingTrajectorySuppression(
        suppressionStates[sourceFieldIndex]!,
        field,
        selection,
      )
      if (registration === null) return invalidResult()

      const provisionalFit = fitFlowingContoursCurve(
        field,
        selection.trajectory,
        controls.flowSmoothing,
        {
          limits,
          currentFittedPointCount: fittedPointCount,
        },
      )
      if (provisionalFit.status === 'invalid-input') {
        if (!recomputeAcceptedAggregates(accounting, accepted)) {
          return invalidResult()
        }
        continue
      }
      if (provisionalFit.status === 'limit-reached') {
        if (!recomputeAcceptedAggregates(accounting, accepted)) {
          return invalidResult()
        }
        terminate(accounting, provisionalFit.limitedBy)
        break
      }
      const fittedLength = curveLength(provisionalFit.curve.points)
      const minimumLength =
        minimumStrokeLength * Math.hypot(field.width, field.height)
      if (fittedLength === null) return invalidResult()
      if (fittedLength < minimumLength) {
        if (!recomputeAcceptedAggregates(accounting, accepted)) {
          return invalidResult()
        }
        continue
      }

      const projected = suppressionStates.map((state) =>
        projectAcceptedFlowingTrajectorySuppression(state, registration),
      )
      const rejectedProjection = projected.find(
        (commit) => commit.kind === 'rejected',
      )
      if (rejectedProjection?.kind === 'rejected') {
        if (rejectedProjection.reason === 'occupancy-limit') {
          if (!recomputeAcceptedAggregates(accounting, accepted)) {
            return invalidResult()
          }
          terminate(accounting, 'analysis-sample-count')
          break
        }
        return invalidResult()
      }
      suppressionStates = projected.map(
        (commit) =>
          (commit as Extract<
            typeof commit,
            { readonly kind: 'committed' }
          >).state,
      )
      accepted.push(selection.trajectory)
      ACCEPTED_TRAJECTORY_HYPOTHESES.set(
        selection.trajectory,
        pooled.hypothesisKind,
      )
      previewCurves.push(provisionalFit.curve)
      fittedPointCount += provisionalFit.fittedPointCount
      accounting.suppressedEvidenceSampleCount = Math.max(
        ...suppressionStates.map(
          (state) => state.suppressedEvidenceSampleCount,
        ),
      )
      queries = fields.map((memberField, index) =>
        createFlowingContoursSuppressionQuery(
          suppressionStates[index]!,
          memberField,
        ),
      )
      if (queries.some((memberQuery) => memberQuery === null)) {
        return invalidResult()
      }
    }

    if (
      deferredPoolLimit !== null &&
      accounting.termination !== 'invalid-input'
    ) {
      accounting.termination = 'limit-reached'
      accounting.limitedBy = deferredPoolLimit
    }

    if (
      accepted.length !== previewCurves.length ||
      accepted.some(
        (trajectory, index) =>
          flowingContoursAcceptedTrajectorySourceField(trajectory) === null ||
          previewCurves[index]!.provenance.sourceTrajectoryId !== trajectory.id,
      )
    ) {
      return invalidResult()
    }
    accounting.fittedCurveCount = previewCurves.length
    accounting.fittedCurvePointCount = fittedPointCount
    accounting.primitiveCount = previewCurves.length
    if (!recomputeAcceptedAggregates(accounting, accepted, true)) {
      return invalidResult()
    }
    return result(accepted, previewCurves, accounting)
  } catch {
    return invalidResult()
  }
}
