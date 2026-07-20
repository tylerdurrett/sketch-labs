/**
 * Public Scribble Strategy boundary.
 *
 * Authored controls enter here; the model derives all solver ratios and the
 * orchestrator executes one bounded pass. Physical output, tools, rendering,
 * scheduling, and session concerns deliberately remain outside this module.
 */

import { createRandom } from '../random'
import type { ScribbleScaleField } from '../scribbleScaleField'
import type {
  ShadingResult,
  ShadingStrategyInput,
} from '../shadingStrategy'
import type { Point, Polyline } from '../types'
import { isMaskPermittedPolyline } from './mask'
import { createScribbleModel } from './model'
import {
  runScribbleOrchestrator,
  type ScribbleExecutionLimits,
  type ScribbleObserver,
  type ScribbleOrchestratorInput,
  type ScribbleOrchestratorOutcome,
  type ScribbleProgress,
} from './orchestrator'
import {
  smoothScaleFieldScribblePolylines,
  smoothScribblePolylines,
} from './smooth'
import type {
  ScribbleControls,
  ScribbleLattice,
} from './types'

export {
  defaultScribbleControls,
  scribbleControlSchema,
  type ScribbleControlName,
  type ScribbleControls,
} from './types'

export type { ScribbleObserver, ScribbleProgress } from './orchestrator'

/** Scribble's authored specialization of the shared strategy input. */
export interface ScribbleStrategyInput
  extends ShadingStrategyInput<ScribbleControls> {
  /** Optional spatial scale, independent of tone and authored controls. */
  readonly scaleField?: ScribbleScaleField
  /** Receives immutable solver progress without affecting deterministic output. */
  readonly observer?: ScribbleObserver
}

/** Scribble geometry, truthful termination, and remaining normalized error. */
export interface ScribbleResult extends ShadingResult {
  readonly residualError: number
}

type ScribbleOrchestrator = (
  input: ScribbleOrchestratorInput,
) => ScribbleOrchestratorOutcome

// The ordinary work budget follows the normalized model: finer lattices and
// lower per-pass coverage both require proportionally more deposited segments.
// Separate hard ceilings remain as emergency guards against extreme frames.
const HARD_MAX_ACCEPTED_SEGMENTS = 1_000_000
const HARD_MAX_POLYLINES = 16_000
const HARD_MAX_STAGNATIONS = 32_000
const HARD_MAX_RESTARTS = 16_000
const SEGMENTS_PER_DENSITY_WEIGHTED_SAMPLE = 2

/** @internal Direct-module seam for the production budget policy. */
export function resolveProductionScribbleExecutionLimits(
  model: Readonly<{
    controls: Pick<ScribbleControls, 'pathDensity'>
    lattice: Pick<ScribbleLattice, 'sampleCount'>
  }>,
): Readonly<ScribbleExecutionLimits> {
  const maxAcceptedSegments = Math.min(
    HARD_MAX_ACCEPTED_SEGMENTS,
    Math.ceil(
      model.lattice.sampleCount *
        model.controls.pathDensity *
        SEGMENTS_PER_DENSITY_WEIGHTED_SAMPLE,
    ),
  )
  // Rejected starts can add one failed attempt per lattice sample. Scale lift
  // allowances with ordinary work while retaining tighter emergency ceilings:
  // restart selection scans the lattice and must not become the dominant cap.
  const failureBudget = maxAcceptedSegments + model.lattice.sampleCount

  return Object.freeze({
    maxAcceptedSegments,
    maxPolylines: Math.min(HARD_MAX_POLYLINES, maxAcceptedSegments),
    maxStagnations: Math.min(HARD_MAX_STAGNATIONS, failureBudget),
    maxRestarts: Math.min(HARD_MAX_RESTARTS, failureBudget),
  })
}

function isFinitePoint(point: Readonly<Point>): boolean {
  return Number.isFinite(point[0]) && Number.isFinite(point[1])
}

function assertValidOutcomeGeometry(
  input: ScribbleStrategyInput,
  polylines: readonly Polyline[],
  maskCheckSpacing: number,
): void {
  for (const polyline of polylines) {
    if (
      polyline.length < 2 ||
      !polyline.every(isFinitePoint) ||
      !isMaskPermittedPolyline(
        input.source.shadingMask,
        input.frame,
        polyline,
        maskCheckSpacing,
      )
    ) {
      throw new Error('Scribble orchestrator produced invalid geometry')
    }
  }
}

function assertValidScaleFieldOutcomeGeometry(
  polylines: readonly Polyline[],
  isSegmentSafe: (
    start: Readonly<Point>,
    end: Readonly<Point>,
  ) => boolean,
): void {
  for (const polyline of polylines) {
    if (polyline.length < 2 || !polyline.every(isFinitePoint)) {
      throw new Error('Scribble orchestrator produced invalid geometry')
    }

    for (let index = 1; index < polyline.length; index++) {
      if (!isSegmentSafe(polyline[index - 1]!, polyline[index]!)) {
        throw new Error('Scribble orchestrator produced invalid geometry')
      }
    }
  }
}

function executeScribbleStrategy(
  input: ScribbleStrategyInput,
  orchestrate: ScribbleOrchestrator,
  injectedLimits?: Readonly<ScribbleExecutionLimits>,
): ScribbleResult {
  const model = createScribbleModel(
    input.source,
    input.frame,
    input.controls,
    input.scaleField,
  )
  const initialResidual = model.residualError()

  // No random draw or E1 call is necessary when the authored source has no
  // permission-weighted demand at the model's declared working resolution.
  if (initialResidual === 0) {
    if (input.observer !== undefined) {
      const progress: ScribbleProgress = Object.freeze({
        completedWorkUnits: 0,
        totalWorkUnits: 0,
        ...(input.controls.stopPoint === 100 ? { convergence: 1 } : {}),
        terminal: true,
      })
      try {
        input.observer(progress)
      } catch {
        // Observers are diagnostic only and cannot change strategy results.
      }
    }
    return { polylines: [], termination: 'completed', residualError: 0 }
  }

  const executionLimits =
    injectedLimits ?? resolveProductionScribbleExecutionLimits(model)
  const outcome = orchestrate({
    model,
    rng: createRandom(input.seed),
    residualThreshold: model.scales.completionThreshold,
    limits: executionLimits,
    ...(model.controls.stopPoint === 100
      ? {}
      : {
          authoredAcceptedSegmentLimit: Math.floor(
            (model.controls.stopPoint / 100) *
              executionLimits.maxAcceptedSegments,
          ),
        }),
    ...(input.observer === undefined ? {} : { observer: input.observer }),
  })

  if (
    !Number.isFinite(outcome.residualError) ||
    outcome.residualError < 0 ||
    outcome.residualError > 1
  ) {
    throw new Error('Scribble orchestrator produced an invalid residual error')
  }

  let polylines: Polyline[]
  if (input.scaleField === undefined) {
    polylines = smoothScribblePolylines(
      outcome.polylines,
      input.source.shadingMask,
      input.frame,
      model.scales.maskCheckSpacing,
    )

    // Preserve the established uniform-scale final validation path exactly.
    assertValidOutcomeGeometry(
      input,
      polylines,
      model.scales.maskCheckSpacing,
    )
  } else {
    polylines = smoothScaleFieldScribblePolylines(
      outcome.polylines,
      model.isSegmentSafe,
    )

    // Growth already uses this predicate. Reapply it after every accepted
    // curve-refinement pass and once more at the public strategy boundary.
    assertValidScaleFieldOutcomeGeometry(polylines, model.isSegmentSafe)
  }

  return {
    polylines,
    termination:
      outcome.stopCause === 'threshold-reached'
        ? 'completed'
        : outcome.stopCause === 'authored-limit-reached'
          ? 'stopped-early'
          : 'budget-exhausted',
    residualError: outcome.residualError,
  }
}

/** Execute the deterministic, residual-seeking Scribble Strategy. */
export function scribbleStrategy(input: ScribbleStrategyInput): ScribbleResult {
  return executeScribbleStrategy(input, runScribbleOrchestrator)
}

/**
 * Internal direct-test seam for deterministic safety-cap and call-boundary
 * coverage. Deliberately not re-exported from the package root.
 *
 * @internal
 */
export function runScribbleStrategyForTesting(
  input: ScribbleStrategyInput,
  limits: Readonly<ScribbleExecutionLimits>,
  orchestrate: ScribbleOrchestrator = runScribbleOrchestrator,
): ScribbleResult {
  return executeScribbleStrategy(input, orchestrate, limits)
}
