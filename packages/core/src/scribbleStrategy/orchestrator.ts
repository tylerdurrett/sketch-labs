import type { Point, Polyline, Random } from '../types'
import { chooseScribbleGrowthStep } from './growth'
import type { ScribbleModel } from './types'

const MIN_MEANINGFUL_RESIDUAL = 1e-12

/** Non-authored safety caps supplied by the integration executing one pass. */
export interface ScribbleExecutionLimits {
  /** Maximum deposited segments across every polyline. */
  readonly maxAcceptedSegments: number
  /** Maximum non-empty polylines retained in the outcome. */
  readonly maxPolylines: number
  /** Maximum failed local growth attempts, including rejected starts. */
  readonly maxStagnations: number
  /** Maximum weighted lifts after the initial starting-cell selection. */
  readonly maxRestarts: number
}

/** Immutable, serialization-friendly progress from one Scribble solver pass. */
export interface ScribbleProgress {
  /** Completed growth attempts, whether advanced or stagnant. */
  readonly completedWorkUnits: number
  /** Stable upper bound from the accepted-segment and stagnation budgets. */
  readonly totalWorkUnits: number
  /** True only when the solver has stopped. */
  readonly terminal: boolean
}

/** Optional observation hook for deterministic Scribble progress snapshots. */
export type ScribbleObserver = (progress: ScribbleProgress) => void

/** Policy-neutral input for one deterministic Scribble solver pass. */
export interface ScribbleOrchestratorInput {
  readonly model: ScribbleModel
  /** One caller-owned stream shared by restart selection and local growth. */
  readonly rng: Random
  /** A normalized residual error in `[0, 1]`. */
  readonly residualThreshold: number
  readonly limits: Readonly<ScribbleExecutionLimits>
  /** Optional authored cap, bounded by the accepted-segment safety limit. */
  readonly authoredAcceptedSegmentLimit?: number
  /** Receives isolated snapshots after completed growth attempts and at stop. */
  readonly observer?: ScribbleObserver
}

export type ScribbleOrchestratorStopCause =
  | 'threshold-reached'
  | 'authored-limit-reached'
  | 'budget-reached'

/** Raw solver state, before a public strategy assigns authored policy. */
export interface ScribbleOrchestratorOutcome {
  readonly polylines: Polyline[]
  readonly residualError: number
  readonly acceptedSegments: number
  readonly stopCause: ScribbleOrchestratorStopCause
}

interface RestartCell {
  readonly index: number
  readonly point: Readonly<Point>
  readonly weight: number
}

function assertNormalizedThreshold(residualThreshold: number): void {
  if (
    !Number.isFinite(residualThreshold) ||
    residualThreshold < 0 ||
    residualThreshold > 1
  ) {
    throw new RangeError('residualThreshold must be finite and within [0, 1]')
  }
}

function assertExecutionLimits(limits: ScribbleExecutionLimits): void {
  const entries = [
    ['maxAcceptedSegments', limits.maxAcceptedSegments],
    ['maxPolylines', limits.maxPolylines],
    ['maxStagnations', limits.maxStagnations],
    ['maxRestarts', limits.maxRestarts],
  ] as const

  for (const [name, value] of entries) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new RangeError(`${name} must be a non-negative safe integer`)
    }
  }
}

function assertAuthoredLimit(
  authoredLimit: number | undefined,
  safetyLimit: number,
): void {
  if (
    authoredLimit !== undefined &&
    (!Number.isSafeInteger(authoredLimit) ||
      authoredLimit < 0 ||
      authoredLimit > safetyLimit)
  ) {
    throw new RangeError(
      'authoredAcceptedSegmentLimit must be a non-negative safe integer within the safety limit',
    )
  }
}

/**
 * Pick a row-major lattice cell with probability proportional to its current
 * permission-weighted residual. Rejected starting cells may be excluded so a
 * locally impossible island cannot consume every restart.
 */
function chooseRestartCell(
  model: ScribbleModel,
  rng: Random,
  excluded: ReadonlySet<number>,
): RestartCell | undefined {
  let totalWeight = 0
  let fallbackIndex = -1
  let fallbackPoint: Readonly<Point> | undefined
  let fallbackWeight = 0

  model.visitResidualSamples((index, point, residual) => {
    if (excluded.has(index) || residual <= MIN_MEANINGFUL_RESIDUAL) {
      return
    }

    fallbackIndex = index
    fallbackPoint = point
    fallbackWeight = residual
    totalWeight += residual
  })

  if (fallbackPoint === undefined || totalWeight <= MIN_MEANINGFUL_RESIDUAL) {
    return undefined
  }

  let cursor = rng.value() * totalWeight
  let selected: RestartCell | undefined
  model.visitResidualSamples((index, point, residual) => {
    if (excluded.has(index) || residual <= MIN_MEANINGFUL_RESIDUAL) {
      return
    }

    cursor -= residual
    if (cursor < 0) {
      selected = { index, point, weight: residual }
      return false
    }
  })

  return (
    selected ?? {
      index: fallbackIndex,
      point: fallbackPoint,
      weight: fallbackWeight,
    }
  )
}

/**
 * Execute one deterministic residual-seeking Scribble pass.
 *
 * This layer owns only geometry growth, virtual deposits, lifting/restarting,
 * and hard execution caps. It deliberately knows nothing of authored fidelity,
 * public termination wording, Scene construction, or Seed creation.
 */
export function runScribbleOrchestrator({
  model,
  rng,
  residualThreshold,
  limits,
  authoredAcceptedSegmentLimit,
  observer,
}: ScribbleOrchestratorInput): ScribbleOrchestratorOutcome {
  assertNormalizedThreshold(residualThreshold)
  assertExecutionLimits(limits)
  assertAuthoredLimit(
    authoredAcceptedSegmentLimit,
    limits.maxAcceptedSegments,
  )

  const polylines: Polyline[] = []
  const rejectedStarts = new Set<number>()
  let residualError = model.residualError()
  let acceptedSegments = 0
  let stagnations = 0
  let restarts = 0
  const acceptedSegmentLimit =
    authoredAcceptedSegmentLimit ?? limits.maxAcceptedSegments
  const configuredWorkUnits = acceptedSegmentLimit + limits.maxStagnations

  const reportProgress = (terminal: boolean): void => {
    if (observer === undefined) return

    const completedWorkUnits = acceptedSegments + stagnations
    const progress = Object.freeze({
      completedWorkUnits,
      totalWorkUnits: completedWorkUnits === 0 ? 0 : configuredWorkUnits,
      terminal,
    })
    try {
      observer(progress)
    } catch {
      // Observation is diagnostic only: callback failures cannot change
      // deterministic geometry, termination, or residual state.
    }
  }

  const finish = (
    stopCause: ScribbleOrchestratorStopCause,
  ): ScribbleOrchestratorOutcome => {
    reportProgress(true)
    return { polylines, residualError, acceptedSegments, stopCause }
  }

  if (residualError <= residualThreshold) {
    return finish('threshold-reached')
  }

  if (
    acceptedSegmentLimit === 0 &&
    authoredAcceptedSegmentLimit !== undefined
  ) {
    return finish('authored-limit-reached')
  }

  if (limits.maxAcceptedSegments === 0 || limits.maxPolylines === 0) {
    return finish('budget-reached')
  }

  let restartCell = chooseRestartCell(model, rng, rejectedStarts)
  let current = restartCell?.point
  let heading: number | undefined
  let activePolyline: Polyline | undefined

  while (current !== undefined) {
    const step = chooseScribbleGrowthStep({
      model,
      rng,
      current,
      ...(heading === undefined ? {} : { heading }),
    })

    if (step.kind === 'advanced') {
      if (activePolyline === undefined) {
        activePolyline = [
          [current[0], current[1]],
          step.point,
        ]
        polylines.push(activePolyline)
      } else {
        activePolyline.push(step.point)
      }

      model.depositSegment(current, step.point)
      acceptedSegments++
      current = step.point
      heading = step.heading
      residualError = model.residualError()
      reportProgress(false)

      // Completion always wins when the same accepted segment reaches a cap.
      if (residualError <= residualThreshold) {
        return finish('threshold-reached')
      }
      if (
        authoredAcceptedSegmentLimit !== undefined &&
        acceptedSegments >= acceptedSegmentLimit
      ) {
        return finish('authored-limit-reached')
      }
      if (acceptedSegments >= limits.maxAcceptedSegments) {
        return finish('budget-reached')
      }

      continue
    }

    stagnations++
    reportProgress(false)
    if (activePolyline === undefined && restartCell !== undefined) {
      rejectedStarts.add(restartCell.index)
    }
    activePolyline = undefined
    heading = undefined

    if (
      stagnations >= limits.maxStagnations ||
      restarts >= limits.maxRestarts ||
      polylines.length >= limits.maxPolylines
    ) {
      break
    }

    restartCell = chooseRestartCell(model, rng, rejectedStarts)
    if (restartCell === undefined) break

    current = restartCell.point
    restarts++
  }

  return finish('budget-reached')
}
