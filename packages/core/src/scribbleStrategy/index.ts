/**
 * Public Scribble Strategy boundary.
 *
 * Authored controls enter here; the model derives all solver ratios and the
 * orchestrator executes one bounded pass. Physical output, tools, rendering,
 * scheduling, and session concerns deliberately remain outside this module.
 */

import { createRandom } from '../random'
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
  type ScribbleOrchestratorInput,
  type ScribbleOrchestratorOutcome,
} from './orchestrator'
import type { ScribbleControls, ScribbleModel } from './types'

export {
  defaultScribbleControls,
  scribbleControlSchema,
  type ScribbleControlName,
  type ScribbleControls,
} from './types'

/** Scribble's authored specialization of the shared strategy input. */
export type ScribbleStrategyInput = ShadingStrategyInput<ScribbleControls>

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
const HARD_MAX_ACCEPTED_SEGMENTS = 250_000
const HARD_MAX_POLYLINES = 4_000
const HARD_MAX_STAGNATIONS = 8_000
const HARD_MAX_RESTARTS = 4_000
const SEGMENTS_PER_DENSITY_WEIGHTED_SAMPLE = 2

function productionLimits(
  model: Readonly<ScribbleModel>,
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

function executeScribbleStrategy(
  input: ScribbleStrategyInput,
  orchestrate: ScribbleOrchestrator,
  injectedLimits?: Readonly<ScribbleExecutionLimits>,
): ScribbleResult {
  const model = createScribbleModel(input.source, input.frame, input.controls)
  const initialResidual = model.residualError()

  // No random draw or E1 call is necessary when the authored source has no
  // permission-weighted demand at the model's declared working resolution.
  if (initialResidual === 0) {
    return { polylines: [], termination: 'completed', residualError: 0 }
  }

  const outcome = orchestrate({
    model,
    rng: createRandom(input.seed),
    residualThreshold: model.scales.completionThreshold,
    limits: injectedLimits ?? productionLimits(model),
  })

  if (
    !Number.isFinite(outcome.residualError) ||
    outcome.residualError < 0 ||
    outcome.residualError > 1
  ) {
    throw new Error('Scribble orchestrator produced an invalid residual error')
  }

  // E1 already validates candidate segments. This final pass guards the public
  // boundary with B's same scale-derived spacing and never regenerates paths.
  assertValidOutcomeGeometry(
    input,
    outcome.polylines,
    model.scales.maskCheckSpacing,
  )

  return {
    polylines: outcome.polylines,
    termination:
      outcome.stopCause === 'threshold-reached'
        ? 'completed'
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
