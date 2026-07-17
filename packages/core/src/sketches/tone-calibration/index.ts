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
  type ScribbleResult,
} from '../../scribbleStrategy/index'
import {
  scribbleControlSchema,
  type ScribbleControls,
} from '../../scribbleStrategy/types'
import type { Params, Seed, StatelessSketch } from '../../sketch'
import { numberParam } from '../sketch-util'
import { createToneCalibrationSource } from './source'

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
): ScribbleResult {
  return scribbleStrategy({
    source: createToneCalibrationSource(frame),
    frame,
    controls: scribbleControls(params),
    seed,
  })
}

/** A fixed analytic target rendered solely as generated Scribble polylines. */
export const toneCalibration: StatelessSketch = {
  id: 'tone-calibration',
  name: 'Tone Calibration',
  schema: toneCalibrationSchema,
  generateToneSource(_params: Params, frame: CoordinateSpace) {
    return createToneCalibrationSource(frame)
  },
  generate(
    params: Params,
    seed: Seed,
    _t: number,
    frame: CoordinateSpace,
  ): Scene {
    const result = generateToneCalibrationScribble(params, seed, frame)
    const builder = createScene(frame)

    for (const polyline of result.polylines) {
      builder.addPath(polyline, {
        closed: false,
        stroke: PREVIEW_STROKE,
        hiddenLineRole: 'source',
      })
    }

    return builder.build()
  },
}
