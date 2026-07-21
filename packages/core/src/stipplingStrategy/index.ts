/**
 * Public Stippling Strategy boundary.
 *
 * Strategy-local rationale: a Stipple is one fixed-length open two-point
 * micro-stroke so it remains ordinary plotter path geometry while reading as a
 * dot. Density owns abundance and spacing; distribution fidelity owns the
 * existing tone-allocation refinement; Voronoi relaxation independently owns
 * later spatial settling. The length stays frame-relative and independent of
 * paper, tool width, rendering, and every authored control. These are local
 * artistic choices, not system architecture decisions, so they live with the
 * strategy rather than in an ADR.
 */

import { createRandom } from '../random'
import type {
  ShadingObserver,
  ShadingResult,
  ShadingStrategyInput,
} from '../shadingStrategy'
import type { Point, Polyline } from '../types'
import { isMaskPermittedStipple } from './mask'
import { createStipplingModel } from './model'
import {
  runStipplingOrchestrator,
  type StipplingExecutionLimits,
  type StipplingOrchestratorInput,
  type StipplingOrchestratorOutcome,
} from './orchestrator'
import {
  computeStipplingDistributionError,
  resolveStipplingRefinementAttempts,
} from './refinement'
import {
  MAXIMUM_STIPPLING_RELAXATION_PASSES,
  resolveStipplingRelaxationPasses,
  resolveStipplingRelaxationWorkUnits,
} from './relaxation'
import type { StipplingRelaxationDiagnostics } from './relaxation'
import type { StippleMark, StipplingControls, StipplingModel } from './types'

export {
  defaultStipplingControls,
  stipplingControlSchema,
  type StipplingControlName,
  type StipplingControls,
} from './types'

/** Stippling's authored specialization of the shared strategy input. */
export interface StipplingStrategyInput extends ShadingStrategyInput<StipplingControls> {
  /** Receives immutable solver progress without affecting deterministic output. */
  readonly observer?: ShadingObserver
}

/** Stipple geometry, truthful termination, and typed distribution diagnostic. */
export interface StipplingResult extends ShadingResult {
  readonly termination: 'completed' | 'budget-exhausted'
  readonly distributionError: number
  /** Exact retained metrics, present only for positive authored relaxation. */
  readonly relaxation?: Readonly<StipplingRelaxationDiagnostics>
}

export type { StipplingRelaxationDiagnostics } from './relaxation'

type StipplingOrchestrator = (
  input: StipplingOrchestratorInput,
) => Readonly<StipplingOrchestratorOutcome>

/** Measured retained-geometry ceiling; 160k completes inside the dart guard. */
const HARD_MAX_STIPPLES = 160_000
const HARD_MAX_ATTEMPTS = 1_000_000
const MINIMUM_PLACEMENT_ATTEMPTS = 256
const PLACEMENT_ATTEMPTS_PER_TARGET = 80

/** @internal Direct-module seam for the production budget policy. */
export function resolveProductionStipplingExecutionLimits(
  model: Readonly<Pick<StipplingModel, 'controls' | 'lattice' | 'scales'>>,
): Readonly<StipplingExecutionLimits> {
  const maxStipples = Math.min(HARD_MAX_STIPPLES, model.scales.targetCount)
  const relaxationEnabled = model.controls.voronoiRelaxation > 0
  const relaxationPasses = relaxationEnabled
    ? resolveStipplingRelaxationPasses(model.controls.voronoiRelaxation)
    : 0
  const demandAdjustedPlacementAttempts =
    maxStipples === 0
      ? 0
      : model.lattice.averageDemand > 0
        ? Math.ceil(
            (maxStipples * PLACEMENT_ATTEMPTS_PER_TARGET) /
              model.lattice.averageDemand,
          )
        : HARD_MAX_ATTEMPTS

  return Object.freeze({
    maxStipples,
    maxPlacementAttempts:
      maxStipples === 0
        ? 0
        : Math.min(
            HARD_MAX_ATTEMPTS,
            Math.max(
              MINIMUM_PLACEMENT_ATTEMPTS,
              demandAdjustedPlacementAttempts,
            ),
          ),
    maxRefinementAttempts: resolveStipplingRefinementAttempts(
      maxStipples,
      model.controls.distributionFidelity,
    ),
    maxRelaxationPasses: MAXIMUM_STIPPLING_RELAXATION_PASSES,
    maxRelaxationWorkUnits: relaxationEnabled
      ? resolveStipplingRelaxationWorkUnits(
          model,
          maxStipples,
          relaxationPasses,
        )
      : 0,
  })
}

function materializeStipple(
  mark: Readonly<StippleMark>,
  length: number,
): Polyline {
  const halfDeltaX = (Math.cos(mark.orientation) * length) / 2
  const halfDeltaY = (Math.sin(mark.orientation) * length) / 2
  return [
    [mark.center[0] - halfDeltaX, mark.center[1] - halfDeltaY],
    [mark.center[0] + halfDeltaX, mark.center[1] + halfDeltaY],
  ]
}

function isFinitePoint(point: Readonly<Point>): boolean {
  return Number.isFinite(point[0]) && Number.isFinite(point[1])
}

function assertValidOutcomeGeometry(
  input: StipplingStrategyInput,
  polylines: readonly Polyline[],
  expectedLength: number,
  maskCheckSpacing: number,
): void {
  const lengthTolerance = 1e-10 * Math.max(1, expectedLength)

  for (const polyline of polylines) {
    if (
      polyline.length !== 2 ||
      !polyline.every(isFinitePoint) ||
      Math.abs(
        Math.hypot(
          polyline[1]![0] - polyline[0]![0],
          polyline[1]![1] - polyline[0]![1],
        ) - expectedLength,
      ) > lengthTolerance ||
      !isMaskPermittedStipple(
        input.source.shadingMask,
        input.frame,
        polyline[0]!,
        polyline[1]!,
        maskCheckSpacing,
      )
    ) {
      throw new Error('Stippling orchestrator produced invalid geometry')
    }
  }
}

function executeStipplingStrategy(
  input: StipplingStrategyInput,
  orchestrate: StipplingOrchestrator,
  injectedLimits?: Readonly<StipplingExecutionLimits>,
): StipplingResult {
  const model = createStipplingModel(input.source, input.frame, input.controls)
  const limits =
    injectedLimits ?? resolveProductionStipplingExecutionLimits(model)
  const outcome = orchestrate({
    model,
    rng: createRandom(input.seed),
    limits,
    ...(input.observer === undefined ? {} : { observer: input.observer }),
  })
  const polylines = outcome.marks.map((mark) =>
    materializeStipple(mark, model.scales.stippleLength),
  )

  assertValidOutcomeGeometry(
    input,
    polylines,
    model.scales.stippleLength,
    model.scales.maskCheckSpacing,
  )
  const distributionError = computeStipplingDistributionError(
    model,
    outcome.marks,
  )

  return {
    polylines,
    termination: outcome.termination,
    distributionError,
    ...(outcome.relaxation === undefined
      ? {}
      : { relaxation: Object.freeze({ ...outcome.relaxation }) }),
  }
}

/** Execute deterministic tone-weighted blue-noise Stippling. */
export function stipplingStrategy(
  input: StipplingStrategyInput,
): StipplingResult {
  return executeStipplingStrategy(input, runStipplingOrchestrator)
}

/**
 * Internal direct-test seam for deterministic safety ceilings and final-boundary
 * validation. Deliberately not re-exported from the package root.
 *
 * @internal
 */
export function runStipplingStrategyForTesting(
  input: StipplingStrategyInput,
  limits: Readonly<StipplingExecutionLimits>,
  orchestrate: StipplingOrchestrator = runStipplingOrchestrator,
): StipplingResult {
  return executeStipplingStrategy(input, orchestrate, limits)
}
