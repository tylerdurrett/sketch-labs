/**
 * Tone Calibration's Sketch contract.
 *
 * The analytic target in `source.ts` is fixed reference data. Normal Fill output
 * contains only black open polylines produced by the selected reusable Shading
 * Strategy: the circle boundary, background, and grayscale ramps never become
 * authored guide geometry. Seed and the active strategy controls affect marks,
 * while the target and its frame-relative layout remain independent of both.
 */

import { createScene } from '../../scene'
import type { CoordinateSpace, Scene, Stroke } from '../../scene'
import {
  scribbleStrategy,
  type ScribbleResult,
} from '../../scribbleStrategy/index'
import type { ShadingObserver, ShadingResult } from '../../shadingStrategy'
import {
  scribbleControlSchema,
  type ScribbleControls,
} from '../../scribbleStrategy/types'
import {
  stipplingControlSchema,
  stipplingStrategy,
  type StipplingControls,
  type StipplingResult,
} from '../../stipplingStrategy/index'
import {
  createShadingDiagnostics,
  type ParamSchema,
  type Params,
  type Seed,
  type ShadingArtwork,
  type StatelessSketch,
} from '../../sketch'
import { choiceParam, numberParam } from '../sketch-util'
import { toneCalibrationOutlineSource } from './outline'
import { createToneCalibrationSource } from './source'

export * from './outline'
export * from './source'

const STRATEGY_OPTIONS = Object.freeze([
  Object.freeze({ value: 'scribble', label: 'Scribble' }),
  Object.freeze({ value: 'stippling', label: 'Stippling' }),
] as const)
const SCRIBBLE_ONLY = Object.freeze({
  key: 'strategy',
  equals: 'scribble',
})
const STIPPLING_ONLY = Object.freeze({
  key: 'strategy',
  equals: 'stippling',
})

/** Strategy first, followed by the selected strategy's unchanged controls. */
export const toneCalibrationSchema = Object.freeze({
  strategy: Object.freeze({
    kind: 'choice',
    options: STRATEGY_OPTIONS,
    default: 'scribble',
  }),
  pathDensity: Object.freeze({
    ...scribbleControlSchema.pathDensity,
    activeWhen: SCRIBBLE_ONLY,
  }),
  scribbleScale: Object.freeze({
    ...scribbleControlSchema.scribbleScale,
    activeWhen: SCRIBBLE_ONLY,
  }),
  momentum: Object.freeze({
    ...scribbleControlSchema.momentum,
    activeWhen: SCRIBBLE_ONLY,
  }),
  chaos: Object.freeze({
    ...scribbleControlSchema.chaos,
    activeWhen: SCRIBBLE_ONLY,
  }),
  toneFidelity: Object.freeze({
    ...scribbleControlSchema.toneFidelity,
    activeWhen: SCRIBBLE_ONLY,
  }),
  stopPoint: Object.freeze({
    ...scribbleControlSchema.stopPoint,
    activeWhen: SCRIBBLE_ONLY,
  }),
  stippleDensity: Object.freeze({
    ...stipplingControlSchema.stippleDensity,
    activeWhen: STIPPLING_ONLY,
  }),
  distributionFidelity: Object.freeze({
    ...stipplingControlSchema.distributionFidelity,
    activeWhen: STIPPLING_ONLY,
  }),
  voronoiRelaxation: Object.freeze({
    ...stipplingControlSchema.voronoiRelaxation,
    activeWhen: STIPPLING_ONLY,
  }),
} satisfies ParamSchema)

const SCRIBBLE_PREVIEW_STROKE = Object.freeze({ color: 'black', width: 1 })
const STIPPLE_PREVIEW_WIDTH_TO_FRAME = 0.002

function stipplePreviewStroke(frame: CoordinateSpace): Readonly<Stroke> {
  return Object.freeze({
    color: 'black',
    width:
      Math.sqrt(frame.width * frame.height) * STIPPLE_PREVIEW_WIDTH_TO_FRAME,
    lineCap: 'round',
  })
}

function scribbleControls(params: Params): ScribbleControls {
  return {
    pathDensity: numberParam(params, toneCalibrationSchema, 'pathDensity'),
    scribbleScale: numberParam(params, toneCalibrationSchema, 'scribbleScale'),
    momentum: numberParam(params, toneCalibrationSchema, 'momentum'),
    chaos: numberParam(params, toneCalibrationSchema, 'chaos'),
    toneFidelity: numberParam(params, toneCalibrationSchema, 'toneFidelity'),
    stopPoint: numberParam(params, toneCalibrationSchema, 'stopPoint'),
  }
}

function stipplingControls(params: Params): StipplingControls {
  return {
    stippleDensity: numberParam(
      params,
      toneCalibrationSchema,
      'stippleDensity',
    ),
    distributionFidelity: numberParam(
      params,
      toneCalibrationSchema,
      'distributionFidelity',
    ),
    voronoiRelaxation: numberParam(
      params,
      toneCalibrationSchema,
      'voronoiRelaxation',
    ),
  }
}

/** Headless generated geometry, kept separate from preview styling for reuse. */
export function generateToneCalibrationScribble(
  params: Params,
  seed: Seed,
  frame: CoordinateSpace,
  observer?: ShadingObserver,
): ScribbleResult {
  return scribbleStrategy({
    source: createToneCalibrationSource(frame),
    frame,
    controls: scribbleControls(params),
    seed,
    ...(observer === undefined ? {} : { observer }),
  })
}

function generateToneCalibrationStippling(
  params: Params,
  seed: Seed,
  frame: CoordinateSpace,
  observer?: ShadingObserver,
): StipplingResult {
  return stipplingStrategy({
    source: createToneCalibrationSource(frame),
    frame,
    controls: stipplingControls(params),
    seed,
    ...(observer === undefined ? {} : { observer }),
  })
}

function sceneFromShadingResult(
  frame: CoordinateSpace,
  result: Readonly<ShadingResult>,
  stroke: Readonly<Stroke>,
): Scene {
  const builder = createScene(frame)

  for (const polyline of result.polylines) {
    builder.addPath(polyline, {
      closed: false,
      stroke,
      hiddenLineRole: 'source',
    })
  }

  return builder.build()
}

/** Prepare Tone Calibration's selected complete Shading artwork and fidelity. */
export function generateToneCalibrationShadingArtwork(
  params: Params,
  seed: Seed,
  frame: CoordinateSpace,
  observer?: ShadingObserver,
): ShadingArtwork {
  const strategy = choiceParam(
    params,
    toneCalibrationSchema,
    'strategy',
  )

  if (strategy === 'scribble') {
    const result = generateToneCalibrationScribble(
      params,
      seed,
      frame,
      observer,
    )
    return {
      scene: sceneFromShadingResult(frame, result, SCRIBBLE_PREVIEW_STROKE),
      diagnostics: createShadingDiagnostics(result, {
        kind: 'scribble',
        residualError: result.residualError,
      }),
    }
  }

  const result = generateToneCalibrationStippling(
    params,
    seed,
    frame,
    observer,
  )
  return {
    scene: sceneFromShadingResult(frame, result, stipplePreviewStroke(frame)),
    diagnostics: createShadingDiagnostics(result, {
      kind: 'stippling',
      distributionError: result.distributionError,
      ...(result.relaxation === undefined
        ? {}
        : { relaxation: Object.freeze({ ...result.relaxation }) }),
    }),
  }
}

/** A fixed analytic target rendered solely as selected Shading polylines. */
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
  generateShadingArtwork: generateToneCalibrationShadingArtwork,
  generate(
    params: Params,
    seed: Seed,
    _t: number,
    frame: CoordinateSpace,
  ): Scene {
    return generateToneCalibrationShadingArtwork(params, seed, frame).scene
  },
}
