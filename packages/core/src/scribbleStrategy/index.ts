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
  type ScribbleExecutionObservation,
  type ScribbleExecutionLimits,
  type ScribbleObserver,
  type ScribbleOrchestratorInput,
  type ScribbleOrchestratorOutcome,
  type ScribbleProgress,
} from './orchestrator'
import { smoothScribblePolylines } from './smooth'
import type { ScribbleControls, ScribbleModel } from './types'

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
  /** Receives immutable solver progress without affecting deterministic output. */
  readonly observer?: ScribbleObserver
}

/** Scribble geometry, truthful termination, and remaining normalized error. */
export interface ScribbleResult extends ShadingResult {
  readonly residualError: number
}

export type ScribbleOrchestrator = (
  input: ScribbleOrchestratorInput,
) => ScribbleOrchestratorOutcome

/** Direct-module hooks used only by deterministic tests and benchmarks. */
export interface ScribbleStrategyTestHooks {
  readonly orchestrate?: ScribbleOrchestrator
  readonly executionObserver?: (
    observation: Readonly<ScribbleExecutionObservation>,
  ) => void
}

// The ordinary work budget follows the normalized model: finer lattices and
// lower per-pass coverage both require proportionally more deposited segments.
// Separate hard ceilings remain as emergency guards against extreme frames.
const HARD_MAX_ACCEPTED_SEGMENTS = 250_000
const HARD_MAX_POLYLINES = 4_000
const HARD_MAX_STAGNATIONS = 8_000
const HARD_MAX_RESTARTS = 4_000
const SEGMENTS_PER_DENSITY_WEIGHTED_SAMPLE = 2
const FULL_WORK_BUDGET_SCALE = 0.5

export function resolveProductionScribbleExecutionLimits(
  model: Readonly<Pick<ScribbleModel, 'controls' | 'lattice'>>,
): Readonly<ScribbleExecutionLimits> {
  // Very fine scales multiply lattice and output-point counts quadratically.
  // Until generation moves off the synchronous Studio path, taper the
  // deterministic safety cap below the former 0.5 floor so 0.1 remains useful
  // for exploration and returns honest partial geometry instead of freezing.
  const scaleAdjustedHardLimit = Math.floor(
    HARD_MAX_ACCEPTED_SEGMENTS *
      Math.min(1, model.controls.scribbleScale / FULL_WORK_BUDGET_SCALE),
  )
  const maxAcceptedSegments = Math.min(
    scaleAdjustedHardLimit,
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
  executionObserver?: ScribbleStrategyTestHooks['executionObserver'],
): ScribbleResult {
  const model = createScribbleModel(input.source, input.frame, input.controls)
  const initialResidual = model.residualError()

  const reportExecution = (
    observation: Readonly<ScribbleExecutionObservation>,
  ): void => {
    if (executionObserver === undefined) return
    try {
      executionObserver(observation)
    } catch {
      // Internal diagnostics cannot change strategy geometry or termination.
    }
  }

  // No random draw or E1 call is necessary when the authored source has no
  // permission-weighted demand at the model's declared working resolution.
  if (initialResidual === 0) {
    if (input.observer !== undefined) {
      const progress: ScribbleProgress = Object.freeze({
        completedWorkUnits: 0,
        totalWorkUnits: 0,
        terminal: true,
      })
      try {
        input.observer(progress)
      } catch {
        // Observers are diagnostic only and cannot change strategy results.
      }
    }
    reportExecution(
      Object.freeze({
        stopCause: 'threshold-reached',
        bindingGuard: null,
        counters: Object.freeze({
          acceptedSegments: 0,
          emittedPolylines: 0,
          stagnations: 0,
          restarts: 0,
        }),
      }),
    )
    return { polylines: [], termination: 'completed', residualError: 0 }
  }

  const outcome = orchestrate({
    model,
    rng: createRandom(input.seed),
    residualThreshold: model.scales.completionThreshold,
    limits:
      injectedLimits ?? resolveProductionScribbleExecutionLimits(model),
    ...(input.observer === undefined ? {} : { observer: input.observer }),
  })

  if (
    !Number.isFinite(outcome.residualError) ||
    outcome.residualError < 0 ||
    outcome.residualError > 1
  ) {
    throw new Error('Scribble orchestrator produced an invalid residual error')
  }

  reportExecution(
    Object.freeze({
      stopCause: outcome.stopCause,
      bindingGuard: outcome.bindingGuard,
      counters: outcome.counters,
    }),
  )

  const polylines = smoothScribblePolylines(
    outcome.polylines,
    input.source.shadingMask,
    input.frame,
    model.scales.maskCheckSpacing,
  )

  // E1 already validates candidate segments. This final pass guards the public
  // boundary after mask-safe curve refinement with B's scale-derived spacing.
  assertValidOutcomeGeometry(
    input,
    polylines,
    model.scales.maskCheckSpacing,
  )

  return {
    polylines,
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
  hooks: Readonly<ScribbleStrategyTestHooks> = {},
): ScribbleResult {
  return executeScribbleStrategy(
    input,
    hooks.orchestrate ?? runScribbleOrchestrator,
    limits,
    hooks.executionObserver,
  )
}
