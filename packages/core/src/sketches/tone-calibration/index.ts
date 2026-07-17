/**
 * Tone Calibration's Sketch contract.
 *
 * The analytic target in `source.ts` is fixed reference data. Normal Fill output
 * contains only black open polylines produced by the reusable Scribble Strategy:
 * the circle boundary, background, and grayscale ramps never become authored
 * guide geometry. Seed and the five strategy controls affect routes, while the
 * target and its frame-relative layout remain independent of both.
 */

import { createScene } from '../../scene'
import type { CoordinateSpace, Scene } from '../../scene'
import {
  scribbleStrategy,
  type ScribbleObserver,
  type ScribbleResult,
} from '../../scribbleStrategy/index'
import {
  scribbleControlSchema,
  type ScribbleControls,
} from '../../scribbleStrategy/types'
import {
  createScribbleDiagnostics,
  type Params,
  type ScribbleArtwork,
  type Seed,
  type StatelessSketch,
} from '../../sketch'
import { numberParam } from '../sketch-util'
import { toneCalibrationOutlineSource } from './outline'
import { createToneCalibrationSource } from './source'

export * from './outline'
export * from './source'

/** Exactly the five shared Scribble controls; the fixed source has no controls. */
export const toneCalibrationSchema = scribbleControlSchema

const PREVIEW_STROKE = Object.freeze({ color: 'black', width: 1 })

function scribbleControls(params: Params): ScribbleControls {
  return {
    pathDensity: numberParam(params, toneCalibrationSchema, 'pathDensity'),
    scribbleScale: numberParam(params, toneCalibrationSchema, 'scribbleScale'),
    momentum: numberParam(params, toneCalibrationSchema, 'momentum'),
    chaos: numberParam(params, toneCalibrationSchema, 'chaos'),
    toneFidelity: numberParam(params, toneCalibrationSchema, 'toneFidelity'),
  }
}

/** Headless generated geometry, kept separate from preview styling for reuse. */
export function generateToneCalibrationScribble(
  params: Params,
  seed: Seed,
  frame: CoordinateSpace,
  observer?: ScribbleObserver,
): ScribbleResult {
  return scribbleStrategy({
    source: createToneCalibrationSource(frame),
    frame,
    controls: scribbleControls(params),
    seed,
    ...(observer === undefined ? {} : { observer }),
  })
}

function sceneFromScribble(
  frame: CoordinateSpace,
  result: Readonly<ScribbleResult>,
): Scene {
  const builder = createScene(frame)

  for (const polyline of result.polylines) {
    builder.addPath(polyline, {
      closed: false,
      stroke: PREVIEW_STROKE,
      hiddenLineRole: 'source',
    })
  }

  return builder.build()
}

/** Prepare Tone Calibration's complete Scene and compact Scribble diagnostics. */
export function generateToneCalibrationScribbleArtwork(
  params: Params,
  seed: Seed,
  frame: CoordinateSpace,
  observer?: ScribbleObserver,
): ScribbleArtwork {
  const result = generateToneCalibrationScribble(params, seed, frame, observer)
  return {
    scene: sceneFromScribble(frame, result),
    diagnostics: createScribbleDiagnostics(result),
  }
}

/** A fixed analytic target rendered solely as generated Scribble polylines. */
export const toneCalibration: StatelessSketch = {
  id: 'tone-calibration',
  name: 'Tone Calibration',
  schema: toneCalibrationSchema,
  generateToneSource(_params: Params, frame: CoordinateSpace) {
    return createToneCalibrationSource(frame)
  },
  deriveOutlineSource(completedScene, target) {
    return toneCalibrationOutlineSource(completedScene, target)
  },
  generateScribbleArtwork: generateToneCalibrationScribbleArtwork,
  generate(
    params: Params,
    seed: Seed,
    _t: number,
    frame: CoordinateSpace,
  ): Scene {
    return generateToneCalibrationScribbleArtwork(params, seed, frame).scene
  },
}
