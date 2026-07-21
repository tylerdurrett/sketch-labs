import { relocateStipplesToVoronoiCentroids } from './relocation'
import type { StippleMark, StipplingModel } from './types'
import { assignStipplingVoronoi } from './voronoi'

/** The authored control's maximum number of complete Lloyd passes. */
export const MAXIMUM_STIPPLING_RELAXATION_PASSES = 8

/** Independent ceiling injected around one positive authored relaxation run. */
export interface StipplingRelaxationLimits {
  /** Complete passes may start only while this many passes remain available. */
  readonly maxPasses: number
}

/** Immutable strategy-local progress after one complete retainable pass. */
export interface StipplingRelaxationProgress {
  readonly completedWorkUnits: number
  /** Stable maximum relaxation capacity, independent of authored effort. */
  readonly totalWorkUnits: number
  readonly iterationsCompleted: number
  readonly objective: number
}

/** Diagnostic-only observer isolated from deterministic solver behavior. */
export type StipplingRelaxationObserver = (
  progress: Readonly<StipplingRelaxationProgress>,
) => void

/** Policy-neutral input for one positive authored relaxation run. */
export interface StipplingRelaxationInput {
  readonly model: Readonly<StipplingModel>
  readonly marks: readonly Readonly<StippleMark>[]
  readonly distributionError: number
  readonly limits: Readonly<StipplingRelaxationLimits>
  readonly observer?: StipplingRelaxationObserver
}

export type StipplingRelaxationStopCause =
  | 'completed'
  | 'no-improvement'
  | 'pass-ceiling-reached'

/** Truthful last-valid state from a sequence of complete Lloyd passes. */
export interface StipplingRelaxationOutcome {
  readonly marks: readonly Readonly<StippleMark>[]
  readonly distributionError: number
  readonly requestedWorkUnits: number
  readonly completedWorkUnits: number
  readonly iterationsCompleted: number
  readonly relocationsAccepted: number
  readonly objective: number
  readonly termination: 'completed' | 'budget-exhausted'
  readonly stopCause: StipplingRelaxationStopCause
}

function assertAuthoredRelaxation(value: number): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new RangeError('Voronoi relaxation must be finite and in [0, 1]')
  }
}

function assertLimits(limits: Readonly<StipplingRelaxationLimits>): void {
  if (
    !Number.isSafeInteger(limits.maxPasses) ||
    limits.maxPasses < 1 ||
    limits.maxPasses > MAXIMUM_STIPPLING_RELAXATION_PASSES
  ) {
    throw new RangeError(
      `maxPasses must be a safe integer in [1, ${MAXIMUM_STIPPLING_RELAXATION_PASSES}]`,
    )
  }
}

function safeAdd(first: number, second: number): number {
  const result = first + second
  if (!Number.isSafeInteger(result)) {
    throw new RangeError('Stippling relaxation work exceeds safe accounting')
  }
  return result
}

function safeMultiply(first: number, second: number): number {
  const result = first * second
  if (!Number.isSafeInteger(result)) {
    throw new RangeError('Stippling relaxation work exceeds safe accounting')
  }
  return result
}

function assertPassCount(passes: number): void {
  if (
    !Number.isSafeInteger(passes) ||
    passes < 0 ||
    passes > MAXIMUM_STIPPLING_RELAXATION_PASSES
  ) {
    throw new RangeError(
      `passes must be a safe integer in [0, ${MAXIMUM_STIPPLING_RELAXATION_PASSES}]`,
    )
  }
}

/**
 * Map authored relaxation to an exact bounded count of complete Lloyd passes.
 *
 * Zero remains the integration layer's allocation-free branch. Every positive
 * value requests at least one pass, and increasing values can only extend the
 * deterministic pass prefix.
 */
export function resolveStipplingRelaxationPasses(value: number): number {
  assertAuthoredRelaxation(value)
  return value === 0
    ? 0
    : Math.ceil(value * MAXIMUM_STIPPLING_RELAXATION_PASSES)
}

/**
 * Count the stable work represented by a requested complete-pass prefix.
 *
 * Assignment charges one unit for every lattice sample considered and one for
 * every positive-demand nearest-site evaluation. Relocation charges one unit
 * for every ordered site candidate evaluated when assigned demand is positive;
 * its zero-demand early return evaluates none. These counts remain constant
 * while identity/count are preserved and let the integration layer compose
 * exact totals before starting Voronoi work.
 */
export function resolveStipplingRelaxationWorkUnits(
  model: Readonly<Pick<StipplingModel, 'lattice'>>,
  markCount: number,
  passes: number,
): number {
  if (!Number.isSafeInteger(markCount) || markCount < 0) {
    throw new RangeError('markCount must be a non-negative safe integer')
  }
  assertPassCount(passes)
  const { lattice } = model
  if (
    !Number.isSafeInteger(lattice.sampleCount) ||
    lattice.sampleCount < 0 ||
    lattice.sampleCount !== lattice.samples.length
  ) {
    throw new RangeError(
      'Relaxation lattice sample count must match its samples',
    )
  }
  const assignedSampleCount =
    markCount === 0
      ? 0
      : lattice.samples.reduce(
          (count, sample) => count + (sample.demand > 0 ? 1 : 0),
          0,
        )
  const relocationCandidateCount =
    assignedSampleCount === 0 ? 0 : markCount
  const workUnitsPerPass = safeAdd(
    safeAdd(lattice.sampleCount, assignedSampleCount),
    relocationCandidateCount,
  )
  return safeMultiply(workUnitsPerPass, passes)
}

/**
 * Run exact assignment followed by safe simultaneous relocation in complete
 * deterministic passes.
 *
 * This is intentionally a positive-only entry point. The integration layer
 * owns the zero-control bypass so zero incurs no Voronoi construction or work.
 * A ceiling is consulted only before starting a pass; every reported pass has
 * therefore completed assignment and retained-or-rolled-back relocation.
 */
export function runStipplingRelaxation({
  model,
  marks: initialMarks,
  distributionError: initialDistributionError,
  limits,
  observer,
}: StipplingRelaxationInput): Readonly<StipplingRelaxationOutcome> {
  const requestedPasses = resolveStipplingRelaxationPasses(
    model.controls.voronoiRelaxation,
  )
  if (requestedPasses === 0) {
    throw new RangeError(
      'runStipplingRelaxation requires positive Voronoi relaxation',
    )
  }
  if (!Number.isFinite(initialDistributionError)) {
    throw new RangeError('Initial distribution error must be finite')
  }
  assertLimits(limits)

  let marks = initialMarks
  let distributionError = initialDistributionError
  const workUnitsPerPass = resolveStipplingRelaxationWorkUnits(
    model,
    marks.length,
    1,
  )
  const requestedWorkUnits = resolveStipplingRelaxationWorkUnits(
    model,
    marks.length,
    requestedPasses,
  )
  let completedWorkUnits = 0
  const totalWorkUnits = resolveStipplingRelaxationWorkUnits(
    model,
    marks.length,
    MAXIMUM_STIPPLING_RELAXATION_PASSES,
  )
  let iterationsCompleted = 0
  let relocationsAccepted = 0
  let objective = 0

  const finish = (
    stopCause: StipplingRelaxationStopCause,
  ): Readonly<StipplingRelaxationOutcome> =>
    Object.freeze({
      marks,
      distributionError,
      requestedWorkUnits,
      completedWorkUnits,
      iterationsCompleted,
      relocationsAccepted,
      objective,
      termination:
        stopCause === 'pass-ceiling-reached'
          ? 'budget-exhausted'
          : 'completed',
      stopCause,
    })

  const scheduledPasses = Math.min(requestedPasses, limits.maxPasses)
  while (iterationsCompleted < scheduledPasses) {
    const assignment = assignStipplingVoronoi(model, marks)
    const completedPassWorkUnits = safeAdd(
      safeAdd(
        assignment.work.sampleCount,
        assignment.work.assignedSampleCount,
      ),
      assignment.totalWeight === 0 ? 0 : assignment.cells.length,
    )
    if (completedPassWorkUnits !== workUnitsPerPass) {
      throw new Error('Stippling relaxation pass work changed unexpectedly')
    }

    const relocation = relocateStipplesToVoronoiCentroids(
      model,
      marks,
      assignment,
      distributionError,
    )
    completedWorkUnits = safeAdd(completedWorkUnits, completedPassWorkUnits)
    iterationsCompleted++
    objective = relocation.normalizedObjective

    if (relocation.passAccepted) {
      marks = relocation.marks
      distributionError = relocation.distributionError
      relocationsAccepted = safeAdd(
        relocationsAccepted,
        relocation.acceptedRelocationCount,
      )
    }

    if (!Number.isFinite(objective)) {
      throw new Error('Stippling relaxation produced a non-finite objective')
    }

    if (observer !== undefined) {
      const progress: StipplingRelaxationProgress = Object.freeze({
        completedWorkUnits,
        totalWorkUnits,
        iterationsCompleted,
        objective,
      })
      try {
        observer(progress)
      } catch {
        // Observation is diagnostic only. Exceptions and attempted mutation
        // cannot alter geometry, accounting, or deterministic termination.
      }
    }

    if (!relocation.passAccepted) return finish('no-improvement')
  }

  return finish(
    scheduledPasses < requestedPasses
      ? 'pass-ceiling-reached'
      : 'completed',
  )
}
