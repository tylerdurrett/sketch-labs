/**
 * Tone Calibration's Sketch contract.
 *
 * The analytic target in `source.ts` is the entire authored subject. Normal Fill
 * output deliberately stays empty until a reusable Shading Strategy turns that
 * target into vector marks; there is no guide geometry or background to render.
 * With no controls, Seed, or timeline, both the target and empty Scene depend
 * only on the supplied Composition Frame.
 */

import { createScene } from '../../scene'
import type { CoordinateSpace, Scene } from '../../scene'
import type { ParamSchema, Params, Seed, StatelessSketch } from '../../sketch'
import { createToneCalibrationSource } from './source'

export * from './source'

/** Tone Calibration intentionally exposes no authored controls. */
export const toneCalibrationSchema = {} satisfies ParamSchema

/** A fixed analytic tone target awaiting reusable generated shading marks. */
export const toneCalibration: StatelessSketch = {
  id: 'tone-calibration',
  name: 'Tone Calibration',
  schema: toneCalibrationSchema,
  generateToneSource(_params: Params, frame: CoordinateSpace) {
    return createToneCalibrationSource(frame)
  },
  generate(
    _params: Params,
    _seed: Seed,
    _t: number,
    frame: CoordinateSpace,
  ): Scene {
    return createScene(frame).build()
  },
}
