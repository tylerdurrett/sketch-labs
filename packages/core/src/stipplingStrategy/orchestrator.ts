import type { ShadingObserver, ShadingProgress } from '../shadingStrategy'
import type { Random } from '../types'
import { placeInitialStipples } from './placement'
import {
  computeStipplingDistributionError,
  refineStipples,
  resolveStipplingRefinementAttempts,
} from './refinement'
import {
  MAXIMUM_STIPPLING_RELAXATION_PASSES,
  resolveStipplingRelaxationPasses,
  resolveStipplingRelaxationWorkUnits,
  runStipplingRelaxation,
} from './relaxation'
import type {
  StipplingRelaxationInput,
  StipplingRelaxationOutcome,
} from './relaxation'
import type { StippleMark, StipplingModel } from './types'

const MAXIMUM_ATTEMPT_LIMIT = 1_000_000
type StipplingRelaxationRunner = (
  input: StipplingRelaxationInput,
) => Readonly<StipplingRelaxationOutcome>
type StipplingRelaxationFactory = () => StipplingRelaxationRunner
const productionRelaxationFactory: StipplingRelaxationFactory = () =>
  runStipplingRelaxation

/** Independent non-authored safety ceilings for one Stippling pass. */
export interface StipplingExecutionLimits {
  /** Maximum accepted geometry retained from placement. */
  readonly maxStipples: number
  /** Maximum initial candidate darts, bounded by placement's hard cap. */
  readonly maxPlacementAttempts: number
  /** Maximum relocation attempts, bounded by refinement's hard cap. */
  readonly maxRefinementAttempts: number
  /** Maximum complete Voronoi-relaxation passes. */
  readonly maxRelaxationPasses: number
  /** Maximum exact assignment-and-relocation work across complete passes. */
  readonly maxRelaxationWorkUnits: number
}

/** Policy-neutral input for one deterministic Stippling solver pass. */
export interface StipplingOrchestratorInput {
  readonly model: Readonly<StipplingModel>
  /** One caller-owned stream shared by placement and refinement in order. */
  readonly rng: Random
  readonly limits: Readonly<StipplingExecutionLimits>
  readonly observer?: ShadingObserver
}

export type StipplingOrchestratorStopCause =
  | 'completed'
  | 'placement-ceiling-reached'
  | 'geometry-ceiling-reached'
  | 'refinement-ceiling-reached'
  | 'relaxation-ceiling-reached'

/** Truthful retained solver state before public geometry materialization. */
export interface StipplingOrchestratorOutcome {
  readonly marks: readonly Readonly<StippleMark>[]
  readonly distributionError: number
  readonly placementAttemptsUsed: number
  readonly refinementAttemptsUsed: number
  readonly termination: 'completed' | 'budget-exhausted'
  readonly stopCause: StipplingOrchestratorStopCause
}

function assertExecutionLimits(limits: StipplingExecutionLimits): void {
  if (!Number.isSafeInteger(limits.maxStipples) || limits.maxStipples < 0) {
    throw new RangeError('maxStipples must be a non-negative safe integer')
  }

  const attemptLimits = [
    ['maxPlacementAttempts', limits.maxPlacementAttempts],
    ['maxRefinementAttempts', limits.maxRefinementAttempts],
  ] as const
  for (const [name, value] of attemptLimits) {
    if (
      !Number.isSafeInteger(value) ||
      value < 0 ||
      value > MAXIMUM_ATTEMPT_LIMIT
    ) {
      throw new RangeError(
        `${name} must be a safe integer in [0, ${MAXIMUM_ATTEMPT_LIMIT}]`,
      )
    }
  }

  if (
    !Number.isSafeInteger(limits.maxRelaxationPasses) ||
    limits.maxRelaxationPasses < 0 ||
    limits.maxRelaxationPasses > MAXIMUM_STIPPLING_RELAXATION_PASSES
  ) {
    throw new RangeError(
      `maxRelaxationPasses must be a safe integer in [0, ${MAXIMUM_STIPPLING_RELAXATION_PASSES}]`,
    )
  }
  if (
    !Number.isSafeInteger(limits.maxRelaxationWorkUnits) ||
    limits.maxRelaxationWorkUnits < 0
  ) {
    throw new RangeError(
      'maxRelaxationWorkUnits must be a non-negative safe integer',
    )
  }
}

function safeAddWork(first: number, second: number): number {
  const result = first + second
  if (!Number.isSafeInteger(result)) {
    throw new RangeError('Stippling execution work exceeds safe accounting')
  }
  return result
}

function modelWithTargetCount(
  model: Readonly<StipplingModel>,
  targetCount: number,
): Readonly<StipplingModel> {
  if (targetCount === model.scales.targetCount) return model

  return Object.freeze({
    ...model,
    scales: Object.freeze({ ...model.scales, targetCount }),
  })
}

/**
 * Run bounded initial placement followed by bounded authored refinement.
 *
 * Placement sees only the density-derived target (capped for retained geometry)
 * and always consumes the caller's stream before refinement. Fidelity therefore
 * cannot alter placement or selected count. Every ceiling returns the exact
 * valid ordered prefix/current set with its distribution error recomputed from
 * that retained set.
 */
export function runStipplingOrchestrator(
  { model, rng, limits, observer }: StipplingOrchestratorInput,
  createRelaxation: StipplingRelaxationFactory = productionRelaxationFactory,
): Readonly<StipplingOrchestratorOutcome> {
  assertExecutionLimits(limits)

  const requestedTargetCount = model.scales.targetCount
  const placementTargetCount = Math.min(
    requestedTargetCount,
    limits.maxStipples,
  )
  const requestedRefinementAttempts = resolveStipplingRefinementAttempts(
    placementTargetCount,
    model.controls.distributionFidelity,
  )
  // Keep the compatibility default out of every relaxation helper. Besides
  // avoiding Voronoi preparation, this preserves the pre-relaxation progress
  // totals and the exact placement/refinement path at zero.
  const relaxationEnabled = model.controls.voronoiRelaxation > 0
  const requestedRelaxationPasses = relaxationEnabled
    ? resolveStipplingRelaxationPasses(model.controls.voronoiRelaxation)
    : 0
  const requestedRelaxationWorkUnits = relaxationEnabled
    ? resolveStipplingRelaxationWorkUnits(
        model,
        placementTargetCount,
        requestedRelaxationPasses,
      )
    : 0
  const configuredWorkUnits = safeAddWork(
    safeAddWork(limits.maxPlacementAttempts, limits.maxRefinementAttempts),
    requestedRelaxationWorkUnits,
  )
  const logicalWorkUnits = safeAddWork(
    safeAddWork(requestedTargetCount, requestedRefinementAttempts),
    requestedRelaxationWorkUnits,
  )

  const convergence = (
    markCount: number,
    refinementAttemptsUsed: number,
    relaxationWorkUnitsCompleted: number,
    completed: boolean,
  ): number => {
    if (completed) return 1
    if (logicalWorkUnits === 0) return 1
    return Math.min(
      1,
      Math.max(
        0,
        (markCount + refinementAttemptsUsed + relaxationWorkUnitsCompleted) /
          logicalWorkUnits,
      ),
    )
  }

  const reportProgress = (
    markCount: number,
    placementAttemptsUsed: number,
    refinementAttemptsUsed: number,
    relaxationWorkUnitsCompleted: number,
    terminal: boolean,
    completed = false,
  ): void => {
    if (observer === undefined) return

    const emptyDemand = requestedTargetCount === 0
    const snapshot: ShadingProgress = Object.freeze({
      completedWorkUnits: safeAddWork(
        safeAddWork(placementAttemptsUsed, refinementAttemptsUsed),
        relaxationWorkUnitsCompleted,
      ),
      totalWorkUnits: emptyDemand ? 0 : configuredWorkUnits,
      convergence: convergence(
        markCount,
        refinementAttemptsUsed,
        relaxationWorkUnitsCompleted,
        completed,
      ),
      terminal,
    })
    try {
      observer(snapshot)
    } catch {
      // Observation is diagnostic only. Exceptions and attempted mutation must
      // not change deterministic marks, work accounting, or termination.
    }
  }

  const finish = (
    stopCause: StipplingOrchestratorStopCause,
    marks: readonly Readonly<StippleMark>[],
    placementAttemptsUsed: number,
    refinementAttemptsUsed: number,
    relaxationWorkUnitsCompleted = 0,
  ): Readonly<StipplingOrchestratorOutcome> => {
    reportProgress(
      marks.length,
      placementAttemptsUsed,
      refinementAttemptsUsed,
      relaxationWorkUnitsCompleted,
      true,
      stopCause === 'completed',
    )
    return Object.freeze({
      marks,
      distributionError: computeStipplingDistributionError(model, marks),
      placementAttemptsUsed,
      refinementAttemptsUsed,
      termination: stopCause === 'completed' ? 'completed' : 'budget-exhausted',
      stopCause,
    })
  }

  if (requestedTargetCount === 0) {
    return finish('completed', Object.freeze([]), 0, 0)
  }

  const placement = placeInitialStipples(
    modelWithTargetCount(model, placementTargetCount),
    rng,
    { maxAttempts: limits.maxPlacementAttempts },
  )
  reportProgress(placement.marks.length, placement.attemptsUsed, 0, 0, false)

  // Placement failure wins if it occurs before the geometry ceiling is filled.
  if (!placement.requestedCountReached) {
    return finish(
      'placement-ceiling-reached',
      placement.marks,
      placement.attemptsUsed,
      0,
    )
  }

  // A filled geometry ceiling stops before any refinement work is consumed.
  if (placementTargetCount < requestedTargetCount) {
    return finish(
      'geometry-ceiling-reached',
      placement.marks,
      placement.attemptsUsed,
      0,
    )
  }

  let postRefinementMarks = placement.marks
  let refinementAttemptsUsed = 0
  if (requestedRefinementAttempts > 0) {
    const refinementAttemptLimit = Math.min(
      requestedRefinementAttempts,
      limits.maxRefinementAttempts,
    )
    const refinement = refineStipples(model, rng, placement.marks, {
      maxAttempts: refinementAttemptLimit,
    })
    postRefinementMarks = refinement.marks
    refinementAttemptsUsed = refinement.attemptsUsed
    reportProgress(
      refinement.marks.length,
      placement.attemptsUsed,
      refinement.attemptsUsed,
      0,
      false,
    )

    if (refinementAttemptLimit < requestedRefinementAttempts) {
      return finish(
        'refinement-ceiling-reached',
        refinement.marks,
        placement.attemptsUsed,
        refinement.attemptsUsed,
      )
    }
  }

  if (!relaxationEnabled) {
    return finish(
      'completed',
      postRefinementMarks,
      placement.attemptsUsed,
      refinementAttemptsUsed,
    )
  }

  const relaxationWorkUnitsPerPass =
    requestedRelaxationPasses === 0
      ? 0
      : requestedRelaxationWorkUnits / requestedRelaxationPasses
  const workLimitedPasses =
    relaxationWorkUnitsPerPass === 0
      ? requestedRelaxationPasses
      : Math.floor(limits.maxRelaxationWorkUnits / relaxationWorkUnitsPerPass)
  const scheduledRelaxationPasses = Math.min(
    requestedRelaxationPasses,
    limits.maxRelaxationPasses,
    workLimitedPasses,
  )

  // A pass is indivisible: if neither ceiling can admit one complete pass,
  // retain the exact post-refinement array without entering Voronoi code.
  if (scheduledRelaxationPasses === 0) {
    return finish(
      'relaxation-ceiling-reached',
      postRefinementMarks,
      placement.attemptsUsed,
      refinementAttemptsUsed,
    )
  }

  const relaxation = createRelaxation()({
    model,
    marks: postRefinementMarks,
    distributionError: computeStipplingDistributionError(
      model,
      postRefinementMarks,
    ),
    limits: { maxPasses: scheduledRelaxationPasses },
    ...(observer === undefined
      ? {}
      : {
          observer: (progress) =>
            reportProgress(
              postRefinementMarks.length,
              placement.attemptsUsed,
              refinementAttemptsUsed,
              progress.completedWorkUnits,
              false,
            ),
        }),
  })

  return finish(
    relaxation.termination === 'budget-exhausted'
      ? 'relaxation-ceiling-reached'
      : 'completed',
    relaxation.marks,
    placement.attemptsUsed,
    refinementAttemptsUsed,
    relaxation.completedWorkUnits,
  )
}
