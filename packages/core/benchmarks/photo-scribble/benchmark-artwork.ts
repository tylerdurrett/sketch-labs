/**
 * Browser-safe, benchmark-only Photo Scribble execution seam.
 *
 * This module intentionally lives outside `src/` and is never exported by
 * `@harness/core`. It composes the same production source, strategy test seam,
 * smoothing, Scene builder, and diagnostics constructor so an injected limits
 * tuple can be compared exactly with the registered production generator.
 */

import type { SketchEnvironment } from '../../src/imageAssets'
import { createScene, type CoordinateSpace } from '../../src/scene'
import {
  createScribbleDiagnostics,
  type Params,
  type ScribbleArtwork,
  type Seed,
} from '../../src/sketch'
import {
  resolveProductionScribbleExecutionLimits,
  runPreparedScribbleStrategyForTesting,
} from '../../src/scribbleStrategy/index'
import { createScribbleModel } from '../../src/scribbleStrategy/model'
import type {
  ScribbleExecutionLimits,
  ScribbleExecutionObservation,
} from '../../src/scribbleStrategy/orchestrator'
import {
  defaultScribbleControls,
  type ScribbleControls,
} from '../../src/scribbleStrategy/types'
import {
  createPhotoScribbleSchema,
  createPhotoScribbleSource,
  PHOTO_SCRIBBLE_DEFAULT_IMAGE_ASSET_ID,
} from '../../src/sketches/photo-scribble/index'

const PREVIEW_STROKE = Object.freeze({ color: 'black', width: 1 })

function finiteNumber(params: Params, key: keyof ScribbleControls): number {
  const value = params[key]
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`Photo Scribble benchmark parameter ${key} is invalid`)
  }
  return value
}

/** Reconcile frozen pre-stop-point evidence with the current authored schema. */
export function reconcileLegacyPhotoScribbleParams<T extends Params>(
  params: T,
): T & Pick<ScribbleControls, 'stopPoint'> {
  const stopPoint = params.stopPoint
  if (stopPoint === undefined) {
    return { ...params, stopPoint: defaultScribbleControls.stopPoint }
  }
  if (typeof stopPoint !== 'number' || !Number.isFinite(stopPoint)) {
    throw new TypeError('Photo Scribble stopPoint is invalid')
  }
  return params as T & Pick<ScribbleControls, 'stopPoint'>
}

export function photoScribbleBenchmarkControls(
  params: Params,
): ScribbleControls {
  const reconciled = reconcileLegacyPhotoScribbleParams(params)
  return {
    pathDensity: finiteNumber(reconciled, 'pathDensity'),
    scribbleScale: finiteNumber(reconciled, 'scribbleScale'),
    momentum: finiteNumber(reconciled, 'momentum'),
    chaos: finiteNumber(reconciled, 'chaos'),
    toneFidelity: finiteNumber(reconciled, 'toneFidelity'),
    stopPoint: finiteNumber(reconciled, 'stopPoint'),
  }
}

export interface PhotoScribbleBenchmarkResolution {
  readonly source: ReturnType<typeof createPhotoScribbleSource>
  readonly controls: ScribbleControls
  readonly model: ReturnType<typeof createScribbleModel>
  readonly productionLimits: Readonly<ScribbleExecutionLimits>
}

/** Resolve the production source, normalized model, and actual production tuple. */
export function resolvePhotoScribbleBenchmark(
  params: Params,
  frame: CoordinateSpace,
  environment: SketchEnvironment,
): PhotoScribbleBenchmarkResolution {
  const reconciled = reconcileLegacyPhotoScribbleParams(params)
  const imageAsset = reconciled.imageAsset
  if (typeof imageAsset !== 'string' || imageAsset.length === 0) {
    throw new TypeError('Photo Scribble benchmark imageAsset is invalid')
  }
  const schema = createPhotoScribbleSchema(
    PHOTO_SCRIBBLE_DEFAULT_IMAGE_ASSET_ID,
  )
  const controls = photoScribbleBenchmarkControls(reconciled)
  const source = createPhotoScribbleSource(
    reconciled,
    frame,
    schema,
    environment,
  )
  const model = createScribbleModel(source, frame, controls)
  return {
    source,
    controls,
    model,
    productionLimits: resolveProductionScribbleExecutionLimits(model),
  }
}

export interface PhotoScribbleBenchmarkHooks {
  readonly executionObserver?: (
    observation: Readonly<ScribbleExecutionObservation>,
  ) => void
}

/** Execute the complete Photo Scribble composition with a benchmark tuple. */
export function generatePhotoScribbleBenchmarkArtwork(
  params: Params,
  seed: Seed,
  frame: CoordinateSpace,
  environment: SketchEnvironment,
  limits: Readonly<ScribbleExecutionLimits>,
  observer?: Parameters<typeof runPreparedScribbleStrategyForTesting>[0]['observer'],
  hooks: PhotoScribbleBenchmarkHooks = {},
): ScribbleArtwork {
  const resolution = resolvePhotoScribbleBenchmark(
    params,
    frame,
    environment,
  )
  return generatePhotoScribbleBenchmarkArtworkFromResolution(
    resolution,
    seed,
    frame,
    limits,
    observer,
    hooks,
  )
}

/** Execute from one already-prepared source/model resolution without redoing it. */
export function generatePhotoScribbleBenchmarkArtworkFromResolution(
  resolution: PhotoScribbleBenchmarkResolution,
  seed: Seed,
  frame: CoordinateSpace,
  limits: Readonly<ScribbleExecutionLimits>,
  observer?: Parameters<typeof runPreparedScribbleStrategyForTesting>[0]['observer'],
  hooks: PhotoScribbleBenchmarkHooks = {},
): ScribbleArtwork {
  const { source, controls, model } = resolution
  const result = runPreparedScribbleStrategyForTesting(
    {
      source,
      frame,
      controls,
      seed,
      ...(observer === undefined ? {} : { observer }),
    },
    model,
    limits,
    hooks.executionObserver === undefined
      ? {}
      : { executionObserver: hooks.executionObserver },
  )
  const builder = createScene(frame)
  for (const polyline of result.polylines) {
    builder.addPath(polyline, {
      closed: false,
      stroke: PREVIEW_STROKE,
      hiddenLineRole: 'source',
    })
  }
  return {
    scene: builder.build(),
    diagnostics: createScribbleDiagnostics(result),
  }
}
