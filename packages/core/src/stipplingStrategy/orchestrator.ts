import type { Random } from '../types'
import { placeInitialStipples } from './placement'
import {
  computeStipplingDistributionError,
  refineStipples,
  resolveStipplingRefinementAttempts,
} from './refinement'
import type { StippleMark, StipplingModel } from './types'

const MAXIMUM_ATTEMPT_LIMIT = 1_000_000

/** Independent non-authored safety ceilings for one Stippling pass. */
export interface StipplingExecutionLimits {
  /** Maximum accepted geometry retained from placement. */
  readonly maxStipples: number
  /** Maximum initial candidate darts, bounded by placement's hard cap. */
  readonly maxPlacementAttempts: number
  /** Maximum relocation attempts, bounded by refinement's hard cap. */
  readonly maxRefinementAttempts: number
}

/** Immutable, serialization-friendly progress from one Stippling pass. */
export interface StipplingProgress {
  /** Actual placement and refinement attempts consumed so far. */
  readonly completedWorkUnits: number
  /** Stable upper bound from both independent attempt ceilings. */
  readonly totalWorkUnits: number
  /** Progress through requested mark selection and authored refinement work. */
  readonly convergence: number
  /** True only after the orchestrator has stopped. */
  readonly terminal: boolean
}

/** Optional diagnostic observation hook; it cannot affect solver state. */
export type StipplingObserver = (progress: StipplingProgress) => void

/** Policy-neutral input for one deterministic Stippling solver pass. */
export interface StipplingOrchestratorInput {
  readonly model: Readonly<StipplingModel>
  /** One caller-owned stream shared by placement and refinement in order. */
  readonly rng: Random
  readonly limits: Readonly<StipplingExecutionLimits>
  readonly observer?: StipplingObserver
}

export type StipplingOrchestratorStopCause =
  | 'completed'
  | 'placement-ceiling-reached'
  | 'geometry-ceiling-reached'
  | 'refinement-ceiling-reached'

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
export function runStipplingOrchestrator({
  model,
  rng,
  limits,
  observer,
}: StipplingOrchestratorInput): Readonly<StipplingOrchestratorOutcome> {
  assertExecutionLimits(limits)

  const requestedTargetCount = model.scales.targetCount
  const placementTargetCount = Math.min(
    requestedTargetCount,
    limits.maxStipples,
  )
  const requestedRefinementAttempts =
    resolveStipplingRefinementAttempts(
      placementTargetCount,
      model.controls.distributionFidelity,
    )
  const configuredWorkUnits =
    limits.maxPlacementAttempts + limits.maxRefinementAttempts
  const logicalWorkUnits =
    requestedTargetCount + requestedRefinementAttempts

  const convergence = (
    markCount: number,
    refinementAttemptsUsed: number,
  ): number => {
    if (logicalWorkUnits === 0) return 1
    return Math.min(
      1,
      Math.max(
        0,
        (markCount + refinementAttemptsUsed) / logicalWorkUnits,
      ),
    )
  }

  const reportProgress = (
    markCount: number,
    placementAttemptsUsed: number,
    refinementAttemptsUsed: number,
    terminal: boolean,
  ): void => {
    if (observer === undefined) return

    const emptyDemand = requestedTargetCount === 0
    const snapshot = Object.freeze({
      completedWorkUnits: placementAttemptsUsed + refinementAttemptsUsed,
      totalWorkUnits: emptyDemand ? 0 : configuredWorkUnits,
      convergence: convergence(markCount, refinementAttemptsUsed),
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
  ): Readonly<StipplingOrchestratorOutcome> => {
    reportProgress(
      marks.length,
      placementAttemptsUsed,
      refinementAttemptsUsed,
      true,
    )
    return Object.freeze({
      marks,
      distributionError: computeStipplingDistributionError(model, marks),
      placementAttemptsUsed,
      refinementAttemptsUsed,
      termination:
        stopCause === 'completed' ? 'completed' : 'budget-exhausted',
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
  reportProgress(placement.marks.length, placement.attemptsUsed, 0, false)

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

  if (requestedRefinementAttempts === 0) {
    return finish('completed', placement.marks, placement.attemptsUsed, 0)
  }

  const refinementAttemptLimit = Math.min(
    requestedRefinementAttempts,
    limits.maxRefinementAttempts,
  )
  const refinement = refineStipples(model, rng, placement.marks, {
    maxAttempts: refinementAttemptLimit,
  })
  reportProgress(
    refinement.marks.length,
    placement.attemptsUsed,
    refinement.attemptsUsed,
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

  return finish(
    'completed',
    refinement.marks,
    placement.attemptsUsed,
    refinement.attemptsUsed,
  )
}
